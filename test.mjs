/**
 * dsh-compaction-rescue 的离线测试。
 *
 * 用假 ctx / 假 llm 驱动真实的 apply()，逐条验证：
 *   1. 只接管 purpose === 'compaction'，其余请求原样放行
 *   2. 监听器**同步**返回异步可迭代对象（写成 async 会让 for await 崩溃）
 *   3. 产出只含 block-start / text-delta / finish（block-end 会让 BlockAssembler 抛错）
 *   4. finish.reason.kind === 'stop'，绝不产出 max-tokens/error
 *   5. 子请求省略 purpose（重入守卫）
 *   6. 改道失败能回退到就地瘦身
 *   7. 子请求全失败时确定性兜底，仍产出合法流
 *   8. global + prepend 注册选项正确
 *   9. 改道时 maxTokens 被收缩到子请求预算
 *  10. abort 信号能中断救援
 *  11. 并发同会话压缩时跳过改道
 */
import { apply, Config, configDefaults } from './index.js';

let failures = 0;
const check = (label, condition, extra = '') => {
	if (condition) { console.log('  OK  ' + label); return; }
	failures += 1;
	console.error('  FAIL ' + label + (extra ? ' — ' + extra : ''));
};

const textBlock = (text) => [{ type: 'text', text }];
const userMsg = (text) => ({ role: 'user', content: textBlock(text) });
const toolCallMsg = (args) => ({ role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'write', arguments: args }] });
const reasoningMsg = (text) => ({ role: 'assistant', content: [{ type: 'reasoning', text }, { type: 'text', text: 'ok' }] });

/** 构造一个假插件上下文，记录注册选项并暴露被拦截的监听器。 */
function mount(config = {}) {
	const registered = [];
	const infos = [];
	const warns = [];
	const ctx = {
		logger: {
			info: (message) => infos.push(message),
			warn: (message) => warns.push(message)
		},
		on(event, listener, options) {
			registered.push({ event, listener, options });
		},
		llm: undefined
	};
	apply(ctx, config);
	return { ctx, registered, infos, warns };
}

/**
 * 假 LLM：记录每次调用，按策略产出流。
 */
function makeLlm({ failAll = false, failAbove = Infinity, failReroute = false, echo = 'SUMMARY-OK', delay = 0 } = {}) {
	const calls = [];
	const llm = {
		calls,
		stream(options) {
			const size = (options.messages ?? []).reduce(
				(n, m) => n + (m.content ?? []).reduce((k, b) => k + Array.from(b.text ?? b.arguments ?? '').length, 0),
				0
			);
			calls.push({ provider: options.provider, model: options.model, purpose: options.purpose, size, maxTokens: options.maxTokens });
			return (async function* () {
				if (delay > 0) await new Promise((r) => setTimeout(r, delay));
				if (failAll) throw new Error('simulated transport failure');
				if (options.purpose === 'compaction-rescue-reroute' && failReroute) throw new Error('reroute rejected');
				if (size > failAbove) { yield { type: 'finish', reason: { kind: 'max-tokens' } }; return; }
				yield { type: 'text-delta', index: 0, text: echo };
				yield { type: 'finish', reason: { kind: 'stop' } };
			})();
		}
	};
	return llm;
}

/** 严格模拟 BlockAssembler.push：block-end 必须抛错。 */
async function assembleStrict(stream) {
	let text = '';
	let finish = null;
	for await (const chunk of stream) {
		switch (chunk.type) {
			case 'block-start': break;
			case 'text-delta': text += chunk.text; break;
			case 'block-end': throw new Error('BlockAssembler has no block-end branch');
			case 'finish': finish = chunk.reason; break;
			default: throw new Error('unexpected chunk type: ' + chunk.type);
		}
	}
	return { text, finish };
}

async function run(label, fn) {
	console.log('\n=== ' + label + ' ===');
	try { await fn(); } catch (error) { failures += 1; console.error('  FAIL THREW: ' + error.message); }
}

await run('1. 注册选项：global + prepend', async () => {
	const { registered } = mount();
	check('注册了 llm/stream', registered.length === 1 && registered[0].event === 'llm/stream');
	check('global: true（穿透 isolate）', registered[0].options?.global === true);
	check('prepend: true（优先决定）', registered[0].options?.prepend === true);
});

await run('2. 非压缩请求原样放行', async () => {
	const { registered, ctx } = mount();
	ctx.llm = makeLlm();
	let passedThrough = false;
	const result = registered[0].listener({ purpose: 'chat', messages: [userMsg('hi')] }, () => { passedThrough = true; return 'PASSTHROUGH'; });
	check('调用了 next()', passedThrough === true);
	check('原样返回 next 的结果', result === 'PASSTHROUGH');
	check('未发起子请求', ctx.llm.calls.length === 0);
});

await run('3. 监听器同步返回异步可迭代对象', async () => {
	const { registered, ctx } = mount();
	ctx.llm = makeLlm();
	const returned = registered[0].listener({ purpose: 'compaction', messages: [userMsg('x'.repeat(1000))] }, () => 'NEXT');
	check('返回值不是 Promise', typeof returned?.then !== 'function');
	check('有 Symbol.asyncIterator', typeof returned?.[Symbol.asyncIterator] === 'function');
});

await run('4. 压缩请求被接管，产出合法 chunk 流', async () => {
	const { registered, ctx } = mount();
	ctx.llm = makeLlm({ echo: 'MY-SUMMARY' });
	const stream = registered[0].listener({ purpose: 'compaction', messages: [userMsg('hello'), { role: 'user', content: textBlock('INSTRUCTION') }] }, () => 'NEXT');
	const { text, finish } = await assembleStrict(stream);
	check('assembler 未抛错', true);
	check('finish = stop', finish?.kind === 'stop', JSON.stringify(finish));
	check('有摘要文本', typeof text === 'string' && text.length > 0);
});

await run('5. 首选改道：provider/model 被替换', async () => {
	const { registered, ctx } = mount({ rerouteProvider: 'happyapi', rerouteModel: 'virtual/opus' });
	ctx.llm = makeLlm();
	const stream = registered[0].listener(
		{ purpose: 'compaction', provider: 'f', model: 'SCNet-Max', messages: [userMsg('x'.repeat(300_000))] },
		() => 'NEXT'
	);
	await assembleStrict(stream);
	const reroute = ctx.llm.calls.find((c) => c.purpose === 'compaction-rescue-reroute');
	check('发起了改道请求', reroute !== undefined);
	check('改道到配置的路由', reroute?.provider === 'happyapi' && reroute?.model === 'virtual/opus', JSON.stringify(reroute));
});

await run('6. 改道时 maxTokens 保持原样（红队 D1 裁决：maxTokens 是输出上限，不应收缩）', async () => {
	const { registered, ctx } = mount();
	ctx.llm = makeLlm();
	const stream = registered[0].listener(
		{ purpose: 'compaction', provider: 'f', model: 'SCNet-Max', maxTokens: 65536, messages: [userMsg('y'.repeat(300_000))] },
		() => 'NEXT'
	);
	await assembleStrict(stream);
	const reroute = ctx.llm.calls.find((c) => c.purpose === 'compaction-rescue-reroute');
	check('改道请求沿用原 maxTokens（超窗是输入问题，收缩输出上限会在子请求里重造 bug）', reroute?.maxTokens === 65536, 'maxTokens=' + reroute?.maxTokens);
});

await run('7. 改道失败 → 回退就地瘦身', async () => {
	const { registered, ctx, infos } = mount();
	ctx.llm = makeLlm({ failReroute: true, echo: 'SLIM-SUMMARY' });
	const messages = [toolCallMsg('p'.repeat(80_000)), reasoningMsg('r'.repeat(60_000)), { role: 'user', content: textBlock('INSTRUCTION') }];
	const stream = registered[0].listener({ purpose: 'compaction', messages }, () => 'NEXT');
	const { text, finish } = await assembleStrict(stream);
	check('最终 finish = stop', finish?.kind === 'stop');
	check('有产出', text.length > 0);
	check('日志记录了回退', infos.some((m) => m.includes('reroute failed')));
});

await run('8. 子请求省略 purpose（重入守卫）', async () => {
	const { registered, ctx } = mount({ rerouteProvider: undefined, rerouteModel: undefined });
	ctx.llm = makeLlm();
	const stream = registered[0].listener({ purpose: 'compaction', messages: [userMsg('a'.repeat(200_000)), { role: 'user', content: textBlock('INSTRUCTION') }] }, () => 'NEXT');
	await assembleStrict(stream);
	check('有子请求', ctx.llm.calls.length > 0);
	check('全部子请求无 purpose', ctx.llm.calls.every((c) => c.purpose === undefined));
});

await run('9. 子请求全失败 → 确定性兜底，仍合法', async () => {
	const { registered, ctx } = mount({ rerouteProvider: undefined, rerouteModel: undefined });
	ctx.llm = makeLlm({ failAll: true });
	const messages = [userMsg('important: D:\\Web\\style sentinel'), { role: 'user', content: textBlock('INSTRUCTION') }];
	const stream = registered[0].listener({ purpose: 'compaction', messages }, () => 'NEXT');
	const { text, finish } = await assembleStrict(stream);
	check('未抛错', true);
	check('finish = stop', finish?.kind === 'stop');
	check('兜底保留锚点原文', text.includes('D:\\Web\\style'), text.slice(0, 100));
});

await run('10. 子请求超窗 → 降级而非抛 MAX_TOKENS', async () => {
	const { registered, ctx } = mount({ rerouteProvider: undefined, rerouteModel: undefined });
	ctx.llm = makeLlm({ failAbove: 10_000 });
	const messages = Array.from({ length: 20 }, (_, i) => userMsg('m' + i + ':' + 'z'.repeat(50_000)));
	messages.push({ role: 'user', content: textBlock('INSTRUCTION') });
	const stream = registered[0].listener({ purpose: 'compaction', messages }, () => 'NEXT');
	const { text, finish } = await assembleStrict(stream);
	check('未把 MAX_TOKENS 抛给引擎', true);
	check('finish = stop', finish?.kind === 'stop');
	check('有内容', text.length > 0);
});

await run('11. abort 信号必须传播（红队裁决：不能吞掉取消）', async () => {
	const { registered, ctx } = mount({ rerouteProvider: undefined, rerouteModel: undefined });
	ctx.llm = makeLlm({ delay: 5 });
	const controller = new AbortController();
	controller.abort();
	const messages = [userMsg('q'.repeat(200_000)), { role: 'user', content: textBlock('INSTRUCTION') }];
	const stream = registered[0].listener({ purpose: 'compaction', messages, signal: controller.signal }, () => 'NEXT');
	let threw = false;
	try {
		await assembleStrict(stream);
	} catch (error) {
		threw = true;
	}
	// 已 abort 的请求必须以异常终止（否则被取消的压缩会被提交成 checkpoint）
	check('abort 后抛出而非静默完成', threw === true);
});

await run('12. 并发同会话时跳过改道（P1 修复验证）', async () => {
	const { registered, ctx } = mount();
	ctx.llm = makeLlm({ delay: 20 });
	const mkReq = () => ({ purpose: 'compaction', sessionId: 's-1', provider: 'f', model: 'SCNet-Max', messages: [userMsg('w'.repeat(200_000)), { role: 'user', content: textBlock('INSTRUCTION') }] });
	// 同时开两个
	const a = assembleStrict(registered[0].listener(mkReq(), () => 'NEXT'));
	const b = assembleStrict(registered[0].listener(mkReq(), () => 'NEXT'));
	await Promise.all([a, b]);
	const reroutes = ctx.llm.calls.filter((c) => c.purpose === 'compaction-rescue-reroute');
	check('并发时最多一次改道', reroutes.length <= 1, 'reroutes=' + reroutes.length);
});

await run('13. 畸形请求安全放行', async () => {
	const { registered, ctx } = mount();
	ctx.llm = makeLlm();
	let calls = 0;
	const next = () => { calls += 1; return 'NEXT'; };
	registered[0].listener({ purpose: 'compaction', messages: [] }, next);
	registered[0].listener({ purpose: 'compaction' }, next);
	registered[0].listener({ purpose: 'compaction', messages: 'not-an-array' }, next);
	check('三种畸形输入都放行', calls === 3, 'calls=' + calls);
});

await run('14. Config 默认值合理', async () => {
	check('Config 实现 StandardSchemaV1', typeof Config?.['~standard']?.validate === 'function');
	check('有 rerouteProvider', typeof configDefaults.rerouteProvider === 'string');
	check('subcallMaxChars 为正', configDefaults.subcallMaxChars > 0);
	check('maxSubcalls 为正', configDefaults.maxSubcalls > 0);
	check('charsPerToken 合理', configDefaults.charsPerToken > 0.5 && configDefaults.charsPerToken < 5);
	const resolved = Config['~standard'].validate({});
	check('空配置校验通过且填入默认值', resolved.issues === undefined && resolved.value.rerouteModel === configDefaults.rerouteModel);
	const unknown = Config['~standard'].validate({ nope: 1 });
	check('未知键被忽略而非报错', unknown.issues === undefined && unknown.value.rerouteModel === configDefaults.rerouteModel);
	const badType = Config['~standard'].validate({ subcallMaxChars: 'lots' });
	check('类型不符回落默认值', badType.issues === undefined && badType.value.subcallMaxChars === configDefaults.subcallMaxChars);
	const overridden = Config['~standard'].validate({ rerouteModel: 'X' });
	check('覆盖值生效', overridden.value.rerouteModel === 'X');
});

console.log('\n' + (failures === 0 ? 'ALL PLUGIN TESTS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);

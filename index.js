/**
 * dsh-compaction-rescue
 *
 * 根治 DSH 压缩死锁：在 `llm/stream` 层改写**压缩请求本身**，让它在路由窗口内装下。
 *
 * ## 问题
 * `compaction-basic` 的摘要请求 = 重放的 span + `maxTokens` 预留，一起占用同一个
 * context window。当 span 超过窗口容量时，provider 只给出约 1 个输出 token 并
 * 立即返回 `finish_reason=length`，`finishError()` 把它映射成 `MAX_TOKENS` 并
 * fail-closed；重试复用同一个 span，因此永远失败。
 *
 * 实测死区判据（A3 源码推导 + A6 数据验证 14/14 成功、6/6 失败）：
 *     summaryPromptTokens + maxTokens > contextWindow
 *
 * ## 解法（三级，优先级从高到低）
 * 1. **改道**：把压缩请求整体路由到窗口更大的模型，内容零损失。成本最低。
 * 2. **瘦身**：原地裁剪对"摘要"无价值的部分——占体积最大的是 tool-call 的 JSON
 *    参数与 reasoning 思维链（实测合计 62.4%），再省掉 `tools`/`toolHistory`。
 * 3. **分块**：仍超预算则把消息切块，逐块摘要后归并。
 *
 * 全程**不改写任何会话日志**：拦截后由官方 `commitCompactionBody` /
 * `compactSurfaceRegion` 原样落盘，turn 边界、`shadowedSeqs` 匹配、compaction
 * 锁与 token-meter 计价全部走官方正确路径。
 *
 * @module @local/compaction-rescue
 */

export const name = 'compaction-rescue';
export const inject = ['llm'];

/**
 * 可调参数的默认值。
 *
 * ⚠️ 这个对象**不是** cordis 的 `Config`。cordis 要求插件导出的 `Config`
 * 实现 StandardSchemaV1（`{ '~standard': { validate } }`）：
 *
 *     // cordis src/fiber.ts:50-62
 *     export function resolveConfig(runtime, config) {
 *       if (!runtime.Config) return config
 *       const result = runtime.Config['~standard'].validate(config)   // ← 普通对象在这里抛
 *       ...
 *     }
 *
 * 导出普通对象会让 `runtime.Config['~standard']` 为 `undefined`，
 * `_resolveConfig()` 抛 `TypeError: Cannot read properties of undefined
 * (reading 'validate')`，被 `_reload()` 的 catch 吞成 `logger.error`，
 * **插件从此永不激活**（实测于 0.2.1-rc.2；0.2.0-rc.2 的 cordis 4.0.4 同码，
 * 所以旧版本其实也从未加载成功过）。
 *
 * 因此默认值单独导出为 `configDefaults`，供文档、测试与运行时合并使用。
 */
export const configDefaults = {
	rerouteProvider: 'happyapi',
	rerouteModel: 'virtual/opus',
	/**
	 * 是否降级 tool-call 参数（裁成占位符）。
	 * 默认 **false**：`COMPACTION_INSTRUCTION` 要求保留 "exact file paths, commands,
	 * error strings"（compaction-basic L273），而这些事实只存在于 tool-call 参数与
	 * tool/result 里。裁掉会让摘要退化成空壳，且 surface replace 不可逆。
	 * 只有在"不裁就必然超窗"时才建议开启。
	 */
	downgradeToolCalls: false,
	/** 降级时每个参数保留的字符数。 */
	maxArgChars: 200,
	/** 是否剥离 reasoning。reasoning 是思维过程，不含 path/command，剥离无事实损失。 */
	stripReasoning: true,
	/** 单次子请求的字符预算（约 charsPerToken 折算成 token）。 */
	subcallMaxChars: 120_000,
	/** 单次子请求的输出上限（token）。 */
	subcallMaxTokens: 8192,
	maxSplitDepth: 3,
	maxSubcalls: 24,
	minSummaryChars: 200,
	charsPerToken: 1.4
};

/**
 * 零依赖的 StandardSchemaV1 校验器。
 *
 * 为什么不用 `@deepseek-ai/schemastery`：本插件以 `file:` 链接方式安装
 * （profile 的 `node_modules` 里只有一个 junction 指向 `D:\dsh\dsh plugin\compaction-rescue`），
 * 所以 `import z from '@deepseek-ai/schemastery'` 在该目录下**无法解析**
 * （实测 `ERR_MODULE_NOT_FOUND`）。加依赖就要在插件目录里再跑一次 npm，
 * 与"零依赖 bundle"的定位冲突。
 *
 * 退回 `export const Config` 也不行：正常加载的插件若没有 `Config`，cordis 会
 * 直接跳过校验（`if (!runtime.Config) return config`），config 原样进 `apply()`，
 * 由本插件自己的 `resolveConfig()` 补默认值 —— 这正是我们想要的行为。
 *
 * 但保留一个校验器有两个好处：① `plugin_manager` 的 Config 面板能显示默认值；
 * ② cordis 会把 `validate()` 返回的 `value` 直接交给 `apply()`，等于免费补默认值。
 *
 * ⚠️ **容错优先于严格**：未知键与类型不符一律**丢弃并回落默认值**，绝不返回
 * `issues`。原因就是本文档开头那个教训 —— 返回 `issues` 会让 cordis 抛
 * `ValidationError`，fiber 进入 FAILED，插件**静默不激活**。对一个"救火"插件，
 * 配置里多一个拼错的键不应该让它整个失效。
 *
 * 注：`Config.listConfigs` 只把携带 `Symbol.for('schemastery')` 的 schema 投影成
 * JSON Schema（`dsh-app-boot` 的 `isNativeConfigSchema`），所以本 schema 在那里的
 * 状态是 `unsupported` —— 不影响加载，只是不可视化编辑。
 */
function createConfigSchema(defaults) {
	const kinds = new Map(Object.entries(defaults).map(([key, value]) => [key, typeof value]));
	return {
		'~standard': {
			version: 1,
			vendor: 'compaction-rescue',
			validate(value) {
				const merged = { ...defaults };
				try {
					if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
						return { value: merged };
					}
					for (const [key, raw] of Object.entries(value)) {
						// 未知键：忽略（不阻断加载）
						if (!kinds.has(key) || raw === undefined) continue;
						const kind = kinds.get(key);
						if (kind === 'number' && (typeof raw !== 'number' || Number.isFinite(raw) === false)) continue;
						if (kind === 'boolean' && typeof raw !== 'boolean') continue;
						if (kind === 'string' && typeof raw !== 'string') continue;
						merged[key] = raw;
					}
				} catch {
					// 任何意外都退化为纯默认值
				}
				return { value: merged };
			}
		}
	};
}

/** cordis 读取的插件配置 schema（必须实现 StandardSchemaV1）。 */
export const Config = createConfigSchema(configDefaults);

/**
 * 摘要指令。与官方 `COMPACTION_INSTRUCTION` 的意图一致，但更明确要求保留可操作
 * 事实——因为瘦身会丢掉 tool-call 参数的完整 JSON，摘要必须靠正文记住"做过什么"。
 */
const INSTRUCTION =
	'Summarize the conversation above into a durable checkpoint. Preserve: the user\'s intent, decisions made, ' +
	'file paths, commands, identifiers, error messages, unresolved problems, and concrete next steps. ' +
	'Drop pleasantries, redundant narration, and superseded plans. Output only the summary.';

const MARKER = '…[truncated to fit the compaction request]';

/** 改道请求的 purpose 标记：用于区分并让递归守卫放行。 */
const REROUTE_PURPOSE = 'compaction-rescue-reroute';

// ---------------------------------------------------------------- 度量

/** 单个内容块折算成字符成本（reasoning 与 tool-call 参数同样占 token）。 */
function blockChars(block) {
	switch (block.type) {
		case 'text':
		case 'reasoning':
			return codePoints(block.text ?? '');
		case 'tool-call': {
			const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? '');
			return (block.name ?? '').length + args.length;
		}
		default:
			return 1_000; // 图片等按固定成本估算
	}
}

function codePoints(text) {
	return Array.from(text).length;
}

function contentChars(blocks) {
	let total = 0;
	for (const block of blocks) total += blockChars(block);
	return total;
}

function messagesChars(messages) {
	let total = 0;
	for (const message of messages) total += contentChars(message.content ?? []);
	return total;
}

// ---------------------------------------------------------------- 瘦身

/** 把过长的 tool-call 参数降级为占位符（保留工具名，摘要仍知道"做过什么"）。 */
function downgradeToolCalls(messages, maxArgChars) {
	return messages.map((message) => {
		const content = message.content;
		if (!Array.isArray(content)) return message;
		let touched = false;
		const next = content.map((block) => {
			if (block.type !== 'tool-call') return block;
			const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? '');
			if (args.length <= maxArgChars) return block;
			const replacement = args.slice(0, maxArgChars) + MARKER;
			if (replacement.length >= args.length) return block; // 净收益检查
			touched = true;
			return { ...block, arguments: replacement };
		});
		return touched ? { ...message, content: next } : message;
	});
}

/** 移除 reasoning 块——它们描述"怎么想"，不参与"发生过什么"。 */
function stripReasoning(messages) {
	return messages.map((message) => {
		const content = message.content;
		if (!Array.isArray(content)) return message;
		const next = content.filter((block) => block.type !== 'reasoning');
		if (next.length === content.length) return message;
		return { ...message, content: next.length > 0 ? next : [{ type: 'text', text: '(reasoning omitted)' }] };
	});
}

/**
 * 瘦身。按配置选择手段，返回新数组与已采用的手段名。
 *
 * 默认只剥 reasoning——它不含 file path / command / error string，剥离零事实损失。
 * tool-call 参数降级默认关闭：那些 JSON 是 "exact file paths, commands" 的唯一来源，
 * 裁掉会让摘要空转且不可逆。
 *
 * @param messages - 原始重放消息。
 * @param config - 已解析配置。
 */
function slimMessages(messages, config) {
	const applied = [];
	let out = messages;
	if (config.downgradeToolCalls === true) {
		const before = messagesChars(out);
		out = downgradeToolCalls(out, config.maxArgChars);
		if (messagesChars(out) !== before) applied.push('tool-call-downgrade');
	}
	if (config.stripReasoning === true) {
		const before = messagesChars(out);
		out = stripReasoning(out);
		if (messagesChars(out) !== before) applied.push('reasoning-strip');
	}
	return { messages: out, applied };
}

// ---------------------------------------------------------------- 分块

/** 把任何单条超大消息切开，保证每块可独立摘要。 */
function splitOversizedMessages(messages, budget) {
	const out = [];
	for (const message of messages) {
		const size = contentChars(message.content ?? []);
		if (size <= budget || !Array.isArray(message.content)) {
			out.push(message);
			continue;
		}
		let current = [];
		let currentChars = 0;
		for (const block of message.content) {
			const size = blockChars(block);
			if (size > budget && block.type === 'text') {
				if (current.length > 0) {
					out.push({ ...message, content: current });
					current = [];
					currentChars = 0;
				}
				const points = Array.from(block.text ?? '');
				for (let index = 0; index < points.length; index += budget) {
					out.push({ ...message, content: [{ ...block, text: points.slice(index, index + budget).join('') }] });
				}
				continue;
			}
			if (current.length > 0 && currentChars + size > budget) {
				out.push({ ...message, content: current });
				current = [];
				currentChars = 0;
			}
			current.push(block);
			currentChars += size;
		}
		if (current.length > 0) out.push({ ...message, content: current });
	}
	return out;
}

/** 按累计成本把消息切成若干块。 */
function splitMessages(messages, budget) {
	const chunks = [];
	let current = [];
	let currentChars = 0;
	for (const message of messages) {
		const size = contentChars(message.content ?? []);
		if (current.length > 0 && currentChars + size > budget) {
			chunks.push(current);
			current = [];
			currentChars = 0;
		}
		current.push(message);
		currentChars += size;
	}
	if (current.length > 0) chunks.push(current);
	return chunks.length > 0 ? chunks : [[]];
}

// ---------------------------------------------------------------- 摘要

/** 零模型兜底：抽取每条消息的开头，保证永远有产物且保留锚点原文。 */
function deterministicDigest(messages) {
	const lines = [];
	for (const message of messages) {
		let text = '';
		for (const block of message.content ?? []) if (block.type === 'text') text += block.text;
		if (text.length === 0) continue;
		const points = Array.from(text);
		lines.push(`- [${message.role ?? 'unknown'}] ${points.slice(0, 240).join('')}${points.length > 240 ? '…' : ''}`);
	}
	return lines.length > 0 ? lines.join('\n') : '(no textual content)';
}

/**
 * 收集一个流的文本产物，把终止性失败转成异常供上层降级。
 * @param stream - `llm.stream()` 返回的 chunk 流。
 */
async function collectText(stream) {
	let text = '';
	for await (const chunk of stream) {
		if (chunk.type === 'text-delta') text += chunk.text;
		else if (chunk.type === 'finish') {
			const kind = chunk.reason?.kind;
			if (kind === 'error' || kind === 'aborted') {
				const failure = chunk.reason.failure;
				throw Object.assign(new Error(failure?.message ?? 'subcall failed'), { code: failure?.code });
			}
			if (kind === 'max-tokens') throw Object.assign(new Error('subcall truncated'), { code: 'MAX_TOKENS' });
		}
	}
	return text;
}

/**
 * 摘要一段消息；超预算时二分递归。
 *
 * 子请求**省略** `purpose`/`sessionId`/`tools`/`toolHistory`：
 * 省略 `purpose` 是重入守卫的第一道（监听器只认 `purpose === 'compaction'`），
 * 同时把 options 对象登记进 `ownRequests` 作为第二道（对象身份最可靠）。
 * 每次子请求前检查 `signal.aborted`，遵守取消语义。
 */
async function summarizeBlock(messages, llm, base, state, config, depth = 0) {
	if (base.signal?.aborted === true) throw Object.assign(new Error('compaction rescue aborted'), { code: 'ABORTED' });
	const size = messagesChars(messages);
	if (size <= config.subcallMaxChars || depth >= config.maxSplitDepth || messages.length <= 1) {
		if (state.calls >= config.maxSubcalls) return deterministicDigest(messages);
		state.calls += 1;
		const options = {
			provider: base.provider,
			model: base.model
		};
		if (base.signal !== undefined) options.signal = base.signal;
		options.messages = [...messages, { role: 'user', content: [{ type: 'text', text: INSTRUCTION }] }];
		options.maxTokens = base.subcallMaxTokens;
		if (base.ownRequests !== undefined) base.ownRequests.add(options);
		return collectText(llm.stream(options));
	}
	const middle = Math.ceil(messages.length / 2);
	const [left, right] = await Promise.all([
		summarizeBlock(messages.slice(0, middle), llm, base, state, config, depth + 1),
		summarizeBlock(messages.slice(middle), llm, base, state, config, depth + 1)
	]);
	return `${left}\n\n${right}`;
}

/** 归并多块摘要；超长则递归归并。 */
async function mergeDigests(digests, config, depth = 0) {
	const joined = digests.join('\n\n');
	if (joined.length <= config.subcallMaxChars || depth >= config.maxSplitDepth || digests.length <= 1) {
		return joined.length <= config.subcallMaxChars ? joined : joined.slice(0, config.subcallMaxChars);
	}
	const middle = Math.ceil(digests.length / 2);
	const [left, right] = await Promise.all([
		mergeDigests(digests.slice(0, middle), config, depth + 1),
		mergeDigests(digests.slice(middle), config, depth + 1)
	]);
	return mergeDigests([left, right], config, depth + 1);
}

/**
 * 生成救援摘要。绝不抛出：任何失败都退化为确定性抽取。
 * @param options - 原始压缩请求。
 * @param llm - LLM 服务（用于发子请求）。
 * @param config - 已解析配置。
 * @param ownRequests - 本插件子请求的对象身份集合（重入守卫）。
 * @returns 摘要文本与诊断信息。
 */
async function buildSummary(options, llm, config, ownRequests) {
	const state = { calls: 0, degraded: false, degradedReason: undefined };
	const base = {
		provider: options.provider,
		model: options.model,
		signal: options.signal,
		subcallMaxTokens: config.subcallMaxTokens,
		ownRequests
	};
	// 末尾那条是 COMPACTION_INSTRUCTION，摘要输入里去掉
	const raw = (options.messages ?? []).slice(0, -1);
	const { messages, applied } = slimMessages(raw, config);

	let summary = '';
	try {
		const splittable = splitOversizedMessages(messages, config.subcallMaxChars);
		if (messagesChars(splittable) <= config.subcallMaxChars) {
			summary = await summarizeBlock(splittable, llm, base, state, config, 0);
		} else {
			const digests = [];
			for (const chunk of splitMessages(splittable, config.subcallMaxChars)) {
				if (options.signal?.aborted === true) {
					throw Object.assign(new Error('compaction rescue aborted'), { code: 'ABORTED' });
				}
				digests.push(await summarizeBlock(chunk, llm, base, state, config, 0));
			}
			summary = await mergeDigests(digests, config, 0);
		}
	} catch (error) {
		// 取消必须传播，不能被兜底吞掉——否则被取消的压缩会被提交成 checkpoint
		if (options.signal?.aborted === true || error?.code === 'ABORTED') throw error;
		summary = deterministicDigest(messages);
		state.degraded = true;
		state.degradedReason = String(error?.message ?? error);
	}

	// 退化门：过短的摘要补上锚点原文，避免"空检查点"
	if (codePoints(summary) < config.minSummaryChars) {
		summary = `${summary}\n\n${deterministicDigest(messages)}`.trim();
		if (codePoints(summary) < config.minSummaryChars) {
			summary += `\n\n[checkpoint produced by compaction-rescue from ${raw.length} message(s)]`;
		}
	}
	return { summary, applied, degraded: state.degraded, degradedReason: state.degradedReason, calls: state.calls };
}

// ---------------------------------------------------------------- chunk 协议

/**
 * `compaction-basic` 在摘要返回后有一道硬闸门（L601）：
 *
 *     framedSummaryTokenCount >= prepared.shadowedRouteTokenCount  →  throw
 *
 * 它把摘要**重新包上 preamble 与 summary 标签**后再定价一次，要求严格小于被遮蔽
 * 内容的路由定价。实测 14 次真实成功样本：摘要只占被遮蔽内容的 3.6%~40.9%，
 * 余量充足；但如果摘要因为分词异常而退化成接近原文长度，这道闸门就会抛错。
 *
 * @param summaryChars - 摘要的字符数（含 framing）。
 * @param charsPerToken - 字符→token 折算。
 * @returns 估算的 framed token 数。
 */
export function estimateFramedTokens(summaryChars, charsPerToken = configDefaults.charsPerToken) {
	return Math.ceil(summaryChars / charsPerToken);
}

/**
 * 预检：产物是否可能通过 `compaction-basic` 的"摘要必须更小"闸门。
 * 阈值取 90%——给 framing 与 token 估算误差留安全余量。
 *
 * @param summaryChars - 摘要字符数。
 * @param shadowedTokens - 被遮蔽 span 的路由 token 定价。
 * @param safetyRatio - 允许占用的比例上限。
 * @returns true 表示预计能过闸门。
 */
export function wouldPassSizeGate(summaryChars, shadowedTokens, safetyRatio = 0.9) {
	if (!Number.isFinite(shadowedTokens) || shadowedTokens <= 0) return true;
	return estimateFramedTokens(summaryChars) < shadowedTokens * safetyRatio;
}

/**
 * 把摘要包装成 `BlockAssembler` 接受的 chunk 流。
 * 只用 `block-start` / `text-delta` / `finish`——`block-end` 在
 * `BlockAssembler.push` 里没有分支，会触发 assertNever。
 * @param summary - 摘要文本。
 */
async function* toChunkStream(summary) {
	yield { type: 'block-start', index: 0, blockType: 'text' };
	yield { type: 'text-delta', index: 0, text: summary };
	yield { type: 'finish', reason: { kind: 'stop' } };
}

// ---------------------------------------------------------------- 插件入口

/** 解析并补全配置。 */
function resolveConfig(config = {}) {
	const merged = { ...configDefaults, ...(config ?? {}) };
	return {
		...merged,
		maxArgChars: merged.maxArgChars ?? 200,
		subcallMaxTokens: merged.subcallMaxTokens ?? 8192
	};
}

/**
 * 挂载 `llm/stream` 监听器。
 *
 * 关于 `global` / `prepend`：两者都是**防御性**写法。`isolate` 是服务解析作用域而
 * 非 listener filter；`compaction` 组的 isolate 是 `{compaction, toolResultPruner}`，
 * 不含 `llm`，所以当前 harness 下 filter 恰好恒真，`global` 更像保险。
 * `prepend` 让本插件先于其他监听器决定是否接管。
 *
 * @param ctx - 插件上下文。
 * @param config - 用户配置。
 */
export function apply(ctx, config) {
	let resolved;
	try {
		resolved = resolveConfig(config);
	} catch (error) {
		ctx.logger?.warn?.(`compaction-rescue: invalid config, plugin disabled: ${String(error?.message ?? error)}`);
		return;
	}

	/**
	 * 本插件自己发出的子请求对象身份集合。
	 * `llm/stream` 的 waterfall 收到的是**调用方传入的对象本身**，因此用对象身份
	 * 做重入守卫最可靠——任何 `{...options}` 展开都不会污染它，字段标记则可能被
	 * 下游 `structuredClone` 拍平。
	 */
	const ownRequests = new WeakSet();

	/** 各会话正在救援中的计数。用于诊断与限流，不作为"跳过救援"的依据。 */
	const active = new Map();

	ctx.on(
		'llm/stream',
		(options, next) => {
			// 重入守卫：自己发出的子请求立即放行
			if (options !== null && typeof options === 'object' && ownRequests.has(options)) return next();
			// 只接管压缩请求
			if (options?.purpose !== 'compaction') return next();
			if (Array.isArray(options.messages) === false || options.messages.length === 0) return next();

			const sessionKey = String(options.sessionId ?? 'anonymous');
			const running = active.get(sessionKey) ?? 0;

			/**
			 * 注意：监听器必须**同步**返回异步可迭代对象。
			 * 写成 `async (options, next)` 会让 `stream()` 返回 Promise，
			 * 调用方的 `for await` 会因 "not async iterable" 崩溃。
			 * 计数必须在同步段递增，否则两个并发请求可能都读到旧值（TOCTOU）。
			 */
			active.set(sessionKey, running + 1);

			/** 发起一个受管子请求：登记对象身份，避免被自己拦截。 */
			const childStream = async (childOptions) => {
				ownRequests.add(childOptions);
				return ctx.llm.stream(childOptions);
			};

			return (async function* rescue() {
				try {
					// 一级：改道到更大窗口的路由（内容零损失）。
					// 并发时不再重复改道（避免成倍放大请求），直接走瘦身。
					if (running === 0 && resolved.rerouteProvider && resolved.rerouteModel) {
						const rerouted = {
							...options,
							provider: resolved.rerouteProvider,
							model: resolved.rerouteModel,
							purpose: REROUTE_PURPOSE
							// 注意：**不**改 maxTokens。它是输出上限，超窗是输入问题；
							// 收缩它只会在子摘要需要长输出时提前 finish_reason=length。
						};
						try {
							for await (const chunk of childStream(rerouted)) yield chunk;
							ctx.logger?.info?.(
								`compaction-rescue: rerouted compaction to ${resolved.rerouteProvider}/${resolved.rerouteModel}`
							);
							return;
						} catch (error) {
							// 取消必须传播，不能被降级吞掉——否则被取消的压缩会被提交
							if (options.signal?.aborted === true) throw error;
							ctx.logger?.info?.(
								`compaction-rescue: reroute failed (${String(error?.message ?? error)}); falling back to in-place slimming`
							);
						}
					}

					// 二级/三级：瘦身 + 分块
					const result = await buildSummary(options, ctx.llm, resolved, ownRequests);
					ctx.logger?.info?.(
						`compaction-rescue: summarized in place ` +
							`(slimmed: ${result.applied.join(',') || 'none'}; subcalls: ${result.calls}` +
							`${result.degraded ? `; degraded: ${result.degradedReason}` : ''})`
					);
					yield* toChunkStream(result.summary);
				} finally {
					const remaining = (active.get(sessionKey) ?? 1) - 1;
					if (remaining <= 0) active.delete(sessionKey);
					else active.set(sessionKey, remaining);
				}
			})();
		},
		{ global: true, prepend: true }
	);

	ctx.logger?.info?.('compaction-rescue: armed on llm/stream');
}

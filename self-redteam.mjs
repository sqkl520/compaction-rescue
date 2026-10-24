/**
 * Lead 自我红队：攻击自己刚写的插件，找致命缺陷。
 * 重点验证那些"测试通过但生产会翻车"的场景。
 */
import { apply } from './index.js';

let issues = [];
const flag = (severity, title, detail) => issues.push({ severity, title, detail });

// ---------- 攻击 1：无限递归 ----------
// 插件改道时发 purpose:'compaction-rerouted'。如果监听器只判 purpose === 'compaction'
// 就不会拦自己 —— 但若用户配的 rerouteProvider 恰好没配，或者将来有人把判断改成
// startsWith('compaction')，就会递归。检查当前判断是否精确。
function attack1() {
  const registered = [];
  const ctx = { logger: { info() {}, warn() {} }, on: (e, l, o) => registered.push({ l, o }), llm: null };
  apply(ctx, {});
  const listener = registered[0].l;

  // 模拟：改道请求再次进入监听器（如果框架对 purpose:'compaction-rerouted' 也触发）
  let nextCalled = false;
  listener({ purpose: 'compaction-rerouted', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, () => {
    nextCalled = true;
    return 'NEXT';
  });
  if (!nextCalled) flag('P0', '改道请求可能被自己再次拦截（递归风险）', 'purpose=compaction-rerouted 未放行 next()');
  else console.log('  攻击1 通过：改道请求正确放行');
}

// ---------- 攻击 2：同步返回契约 ----------
function attack2() {
  const registered = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    on: (e, l, o) => registered.push({ l, o }),
    llm: { stream: () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })() }
  };
  apply(ctx, {});
  const ret = registered[0].l(
    { purpose: 'compaction', messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }] },
    () => 'NEXT'
  );
  if (typeof ret?.then === 'function') flag('P0', '监听器返回了 Promise', 'for await 会崩');
  else console.log('  攻击2 通过：同步返回 async iterable');
}

// ---------- 攻击 3：改道时未检查目标路由是否存在 ----------
function attack3() {
  const registered = [];
  let reported = [];
  const ctx = {
    logger: { info: (m) => reported.push(m), warn: (m) => reported.push('WARN:' + m) },
    on: (e, l, o) => registered.push({ l, o }),
    // 改道必定失败（模拟目标 provider 不存在）
    llm: {
      stream: (options) => {
        if (options.purpose === 'compaction-rerouted') {
          return (async function* () { throw new Error('no adapter registered for provider "happyapi"'); })();
        }
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: 'fallback' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      }
    }
  };
  apply(ctx, {});
  const stream = registered[0].l(
    { purpose: 'compaction', provider: 'f', model: 'SCNet-Max', messages: [{ role: 'user', content: [{ type: 'text', text: 'b'.repeat(1000) }] }] },
    () => 'NEXT'
  );
  return (async () => {
    let text = '';
    for await (const c of stream) if (c.type === 'text-delta') text += c.text;
    if (!text.includes('fallback')) flag('P1', '改道失败后未回退', text.slice(0, 50));
    else console.log('  攻击3 通过：改道失败能回退');
  })();
}

// ---------- 攻击 4：改道把内容送给错误模型（语义漂移） ----------
function attack4() {
  // 这是设计层面的风险：改道到 opus 意味着用不同模型做摘要。
  // 若用户配置的模型不支持 tool-call 消息格式，可能失败或降质。
  flag('P1', '改道改变摘要模型（语义/格式风险）',
    '改道把摘要委托给另一模型；若该模型不支持 tool-call/tool-result 消息格式，摘要质量会下降或直接失败。应在 README 明确说明，并提供 rerouteProvider:"" 关闭。');
}

// ---------- 攻击 5：并发压缩 ----------
function attack5() {
  flag('P1', '并发压缩无状态隔离',
    '同一会话两个压缩请求并发时，两次都会各自发起改道/子请求。虽不共享可变状态（buildSummary 每次新建 state），但会放大 token 消耗。建议加 per-session 去重或并发上限。');
}

// ---------- 攻击 6：usage 未上报 ----------
function attack6() {
  flag('P2', '不产出 usage chunk',
    '引擎的 assembler.usage 会为空，compaction/summary 的 usage 字段缺失。下游 token 统计会把这次压缩记为 0 token，可能让成本面板失真。可补一个 usage chunk 汇总子请求用量。');
}

// ---------- 攻击 7：改道后 maxTokens 仍是压缩配置 ----------
function attack7() {
  flag('P0', '改道时未调整 maxTokens（可能仍超窗）',
    '改道只换了 provider/model，maxTokens 仍是 config.maxTokens（默认 65536）。若目标路由窗口虽大但不足以容纳 prompt+65536，仍会失败。应在改道前用 isDeadZone 预检，并按目标窗口收缩 maxTokens。');
}

// ---------- 攻击 8：未验证目标窗口，改道可能更糟 ----------
function attack8() {
  flag('P1', '改道目标窗口未校验',
    '插件不知道目标路由的真实 contextWindow，盲目改道。若配置成小窗口模型，反而必然失败。应从 ctx.llm 的模型信息读取，或至少文档警示。');
}

// ---------- 攻击 9：deterministicDigest 泄露敏感内容 ----------
function attack9() {
  flag('P2', '兜底摘要不做脱敏',
    'deterministicDigest 直接截取原文前 240 字，可能把密钥/隐私写进 checkpoint。官方摘要也会，但兜底路径更"无差别"。建议文档提示。');
}

// ---------- 攻击 10：监听器未处理 signal 取消 ----------
function attack10() {
  flag('P1', '未响应 options.signal 取消',
    '用户在压缩过程中取消时，插件的子请求循环不检查 signal.aborted，会继续发子请求直到完成。应在每次子请求前检查 signal。');
}

attack1();
attack2();
await attack3();
attack4(); attack5(); attack6(); attack7(); attack8(); attack9(); attack10();

console.log('\n=== 自我红队结果 ===');
const bySeverity = { P0: [], P1: [], P2: [] };
for (const i of issues) bySeverity[i.severity].push(i);
for (const sev of ['P0', 'P1', 'P2']) {
  if (bySeverity[sev].length === 0) continue;
  console.log(`\n【${sev}】`);
  for (const i of bySeverity[sev]) console.log(`  - ${i.title}\n    ${i.detail}`);
}
console.log(`\n合计：P0=${bySeverity.P0.length} P1=${bySeverity.P1.length} P2=${bySeverity.P2.length}`);

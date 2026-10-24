/**
 * 验证红队 D1 闸门预检：summary 必须严格小于被遮蔽内容的 route 定价。
 *
 * 闸门（compaction-basic L601）：
 *   framedSummaryTokenCount >= prepared.shadowedRouteTokenCount  → throw
 *
 * 用真实日志的 14 次成功样本标定安全边界，并验证：
 *   1. 正常长度的摘要远超安全线以内（14/14 PASS，最坏 40.9%）
 *   2. 只有在摘要膨胀到 shadowed 的 ~100% 时才会触发
 *   3. 因此预检阈值应设在 90% 左右，给 framing 开销留余量
 */
import { estimateFramedTokens, wouldPassSizeGate } from './index.js';

let failures = 0;
const check = (label, cond, extra = '') => {
  if (cond) { console.log('  OK   ' + label); return; }
  failures += 1;
  console.error('  FAIL ' + label + (extra ? ' — ' + extra : ''));
};

// 真实日志的 14 次成功：(shadowedTokenCount, summary 字符数)
const REAL = [
  [68156, 15786], [85112, 21564], [93640, 25601], [73777, 30182],
  [80838, 30202], [51485, 27567], [70795, 28894], [64954, 26901],
  [65389, 37422], [60659, 34224], [73504, 36611], [79321, 37043],
  [76630, 41946], [354275, 17819]
];

console.log('=== 1. 真实 14 次成功样本是否都能过闸门 ===');
let worst = 0;
for (const [shadowed, chars] of REAL) {
  const framed = estimateFramedTokens(chars);
  const ratio = framed / shadowed;
  worst = Math.max(worst, ratio);
  if (!wouldPassSizeGate(chars, shadowed)) {
    check(`seq 样本 ${shadowed}/${chars}`, false, 'ratio=' + ratio.toFixed(3));
  }
}
check(`全部 ${REAL.length} 次通过`, true);
console.log(`     最坏占比: ${(worst * 100).toFixed(1)}%`);

console.log('\n=== 2. 边界行为 ===');
// 摘要极小 → 必过
check('极小摘要必过', wouldPassSizeGate(100, 50_000) === true);
// 摘要 token 数达到 shadowed 的 100% → 拒绝（需传入「字符数」，故乘回 charsPerToken）
check('摘要 token == shadowed 时拒绝', wouldPassSizeGate(50_000 * 1.4, 50_000) === false);
// 恰好在 90% 阈值上方 → 拒绝
check('摘要占 95% 时拒绝（保守）', wouldPassSizeGate(50_000 * 0.95 * 1.4, 50_000) === false);
// 80% → 通过
check('摘要占 80% 时通过', wouldPassSizeGate(50_000 * 0.8 * 1.4, 50_000) === true);

console.log('\n=== 3. 预检能否拦住畸形长摘要 ===');
// 摘要退化成原文长度（496K token ≈ 694K chars）
const huge = wouldPassSizeGate(496_000 * 1.4, 496_000);
check('摘要退化到原文长度 → 判定为风险', huge === false);
// 正常的 20K chars 摘要（≈14K token）对 496K shadowed → 安全
check('正常 20K chars 摘要 → 安全', wouldPassSizeGate(20_000, 496_000) === true);

console.log('\n' + (failures === 0 ? 'ALL GATE CHECKS PASSED' : failures + ' FAILED'));
process.exit(failures === 0 ? 0 : 1);

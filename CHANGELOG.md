# Changelog

版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [1.0.0] — 2026-10-25

首个稳定版。在 `llm/stream` 层改写压缩请求，使摘要不再因「历史 + 输出预留 > 窗口」而必然失败。

### 新增

- **三级救援**：改道（零损失）→ 剥 reasoning → 分块摘要。
- `wouldPassSizeGate()`：用真实样本标定的「摘要必须更小」闸门预检。
- `estimateFramedTokens()`：framed 摘要定价估算。
- `configDefaults` 导出，11 个可调键全部有默认值。
- 14 个用例 / 37 个断言 + 7 个闸门断言。

### 设计取舍

- **零日志写入**：落盘全部交回官方 `commitCompactionBody` / `compactSurfaceRegion`，避免自写 `surfaceOp` 事件破坏 turn 边界。
- **`downgradeToolCalls` 默认关闭**：tool-call 参数是 `exact file paths / commands` 的唯一来源，裁掉会让摘要退化成空壳，且 surface 替换不可逆。
- **不收缩 `maxTokens`**：它是输出上限，超窗是输入问题；收缩只会在子摘要需要长输出时提前 `finish_reason=length`。

### 已验证的边界

- 治不了 `402 Insufficient Balance`（请求未被受理）。
- 治不了已毒化的会话（存在未配对的 `compaction/start`，compaction 永久 busy）。
- 治不了「surface 本身超窗」——本插件缩的是请求，不是历史。
- 压缩进行时若有 `turn/*` 事件写入，会导致会话无法加载；分块会拉长该窗口。

### 前身

`compaction-max-tokens-recovery` 已在真实会话中被证伪：230 次裁剪、0 次救援，且因在 turn 外写 `tool/result` 替换而使两个会话无法加载。本版本换了 seam 与位置，不修失败的压缩，而是在请求发出前让它装得下。

<div align="center">

# compaction-rescue

> *「你的会话没坏，是压缩请求自己撑爆了窗口。」*
> *"Your session isn't broken — the compaction request outgrew the window."*

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Dependencies: 0](https://img.shields.io/badge/Dependencies-0-c2410c)](./index.js)
[![Tests: 44 passing](https://img.shields.io/badge/Tests-44%20passing-brightgreen)](./test.mjs)
[![Seam: llm/stream](https://img.shields.io/badge/Seam-llm%2Fstream-blueviolet)](#挡在请求发出之前的那一层)

<br>

**把压缩请求瘦到窗口装得下，而不是等它失败之后再去修日志。**

<br>

DSH 的 `/compact` 报「Compaction could not produce a useful summary」，你会以为历史坏了，或者上下文太长了。

看日志发现不是。摘要请求本身 = 重放的全部历史 + 65536 输出预留，两者共用同一个 context window。当历史涨到 49 万 token、而路由窗口只有 26 万时，这次请求在**发出去的那一刻就已经注定失败**——provider 只回一个 token，引擎把它记成 `MAX_TOKENS`，然后重试**同一个区间**。这就是它永远失败的全部原因。

这个插件存在的全部理由：在请求发出之前把它改小，让第一次就成功。

```
plugin_manager action=install_bundle target="D:\dsh\dsh plugin\compaction-rescue"
```

跨运行环境通用——Windows / macOS / Linux 上跑 DSH 都能用。

[看证据](#这些数字你可以自己复算) · [安装](#装完要重启一次) · [机制](#挡在请求发出之前的那一层) · [边界](#它做不到的事比它能做的更值得先知道)

<br>

</div>

---

## 这些数字你可以自己复算

不要求你信任形容词。仓库里两个测试脚本跑完是这样：

```
$ node test.mjs
=== 1. 注册选项：global + prepend ===
  OK  注册了 llm/stream
  OK  global: true（穿透 isolate）
  OK  prepend: true（优先决定）
...
=== 14. Config 默认值合理 ===
  OK  charsPerToken 合理

ALL PLUGIN TESTS PASSED      ← 14 个用例 / 37 个断言
```

```
$ node test-gate.mjs
=== 1. 真实 14 次成功样本是否都能过闸门 ===
  OK   全部 14 次通过
     最坏占比: 40.9%
=== 2. 边界行为 ===
  OK   极小摘要必过
  OK   摘要 token == shadowed 时拒绝
  OK   摘要占 95% 时拒绝（保守）
  OK   摘要占 80% 时通过
=== 3. 预检能否拦住畸形长摘要 ===
  OK   摘要退化到原文长度 → 判定为风险
  OK   正常 20K chars 摘要 → 安全

ALL GATE CHECKS PASSED       ← 7 个断言
```

`test-gate.mjs` 里那 14 组数字不是编的，是从真实会话日志的 14 次成功压缩里读出来的：

| 会话 seq | 被遮蔽 token | 摘要 token | 占比 |
|---|---:|---:|---:|
| 910 | 68,156 | 11,276 | 16.5% |
| 2094 | 93,640 | 18,287 | 19.5% |
| 3937 | 65,389 | 26,730 | **40.9%** |
| 7480 | 354,275 | 12,728 | **3.6%** |

**要让它失败，摘要得膨胀到被遮蔽内容的 100%**——那意味着 49 万 token 的区间要产出 49 万 token 的摘要。引擎那道「摘要必须更小」的闸门真实存在，但余量很足。

---

## 装完要重启一次

**方式一：交给 plugin_manager**

```
plugin_manager action=install_bundle target="D:\dsh\dsh plugin\compaction-rescue"
```

**方式二：手工两步，缺一步都不生效**

```bash
cd "<你的 DSH profile 目录>"
npm install --no-audit --no-fund --save "file:D:\dsh\dsh plugin\compaction-rescue"
```

| 步骤 | 做什么 | 漏掉会怎样 |
|---|---|---|
| 1 | `npm install` 建链接 | 模块解析不到 |
| 2 | 把 `@local/compaction-rescue` 加进 `package.json` 的 `dsh.profile.bundles` | **配置合成了但插件不跑**——`cordis.patch.yml` 不参与构建 |

装完自检：`--dump-config` 的输出里应出现 `# == @local/compaction-rescue`。少这行就是第 2 步没做。

**必须重启一次进程。** 换已安装包的 JS 需要新的 module generation。重启不终止对话——会话按 id 恢复，历史完整。

重启后进会话，日志里会有这一行，看到它才算真的挂上：

```
compaction-rescue: armed on llm/stream
```

---

## 挡在请求发出之前的那一层

`llm/stream` 是一个 waterfall。挂在上面的监听器**只要不调用 `next()`，就否决了后面所有处理**——包括内置的 provider 调用。

```
compaction-basic
      │  带 purpose="compaction" 的请求
      ▼
  llm/stream  ──► 本插件：这条路我接管
      │
      ├─ 一级：改道到窗口更大的路由，内容一个字节不动
      ├─ 二级：剥掉 reasoning（不含路径/命令，剥了不丢事实）
      └─ 三级：还是太大就切块，逐块摘要再归并
      │
      ▼
  产出 { block-start, text-delta..., finish: { kind: "stop" } }
      │
      ▼
  引擎照常落盘：commitCompactionBody / compactSurfaceRegion
```

**关键点：插件一行日志事件都不写。**

落盘仍走官方路径，所以 turn 边界、`shadowedSeqs` 的精确匹配、compaction 锁、token-meter 的计价层全部由官方保证。这不是偷懒——自写 `surfaceOp` 事件只要在 turn 外落地一次 `tool/result` 替换，重载时整个会话就会报 `tool/result is outside an open turn` 打不开。那个坑是真的，踩过。

内容占比决定了手段的顺序（某 799,687 token 会话的实测拆解）：

| 内容 | tokens | 占比 | 本插件 |
|---|---:|---:|---|
| assistant 的 tool-call 参数 | 273,880 | **34.3%** | 默认**不裁**，见局限 |
| assistant reasoning 回放 | 223,960 | **28.1%** | 剥掉 |
| tool/result 正文 | 205,932 | 25.8% | 不裁，这是事实来源 |
| user/message | 65,973 | 8.3% | 不裁 |
| system + tools schema | 16,144 | 2.0% | 子请求里省掉 |

这组数字解释了一件事：**只裁 tool/result 的路线，数学上限是 25.8%**。49 万 token 裁完还剩 59 万，离 26 万还差 33 万。那些裁历史的插件不是不够激进，是方向封顶了。

---

## 它做不到的事，比它能做的更值得先知道

- **治不了 `402 Insufficient Balance`**。请求根本没被受理，没有错误可以恢复。这是账户问题，插件插不上手。
- **不改你的 `contextWindow` 配置**。插件不猜你的真实窗口。配得离谱，改道可能碰巧绕开，但根因还在。
- **治不了已经毒化的会话**。日志里若有未配对的 `compaction/start`，compaction 会永久 busy，谁也救不了。
- **治不了「surface 本身超窗」**。它能把摘要请求缩小，但如果历史真的塞不进窗口，下一轮对话照样会被截断。这需要先压一次。
- **默认不裁 tool-call 参数**。`COMPACTION_INSTRUCTION` 明确要求保留 exact file paths / commands / error strings，而这些只存在于参数 JSON 里。裁了摘要会退化成空壳，而 surface 替换**不可逆**——`/compact` 没有 undo。只有确认「不裁就必然失败」时才建议开 `downgradeToolCalls`。
- **压缩期间别发消息**。`compaction/start` 在摘要开始前就写进日志了，open-compaction 窗口内出现任何 `turn/*` 事件会让日志校验失败。分块会把这个窗口拉长，最多 `maxSubcalls` 次往返。

这是一个 7 分的插件，不是 10 分的修复。它治的是「请求构造」，不是「上下文管理」。

---

## 参数

11 个键，都有默认值，通常不用动：

| 键 | 默认 | 作用 |
|---|---|---|
| `rerouteProvider` / `rerouteModel` | `happyapi` / `virtual/opus` | 一级改道目标；设空串关闭改道 |
| `stripReasoning` | `true` | 剥 reasoning |
| `downgradeToolCalls` | **`false`** | 裁 tool-call 参数。**有事实损失，默认关** |
| `maxArgChars` | `200` | 裁剪时保留的字符数 |
| `subcallMaxChars` | `120000` | 单次子请求字符预算 |
| `subcallMaxTokens` | `8192` | 子请求输出上限 |
| `maxSplitDepth` | `3` | 二分深度 |
| `maxSubcalls` | `24` | 子请求总数上限（成本封顶） |
| `minSummaryChars` | `200` | 退化门：低于此补锚点 |
| `charsPerToken` | `1.4` | 字符→token 折算（用真实成功摘要标定，不是 4） |

---

## 仓库结构

```
compaction-rescue/
├── index.js              # 596 行，7 个导出，零 import
├── test.mjs              # 14 个用例 / 37 个断言
├── test-gate.mjs         # 7 个断言，用 14 次真实样本标定闸门
├── self-redteam.mjs      # 攻击自己的代码，输出已知残余风险
├── cordis.patch.yml      # bundle 注册行
├── package.json
├── locale/{en,zh}.json
└── icon.svg
```

零依赖，可复算：

```
$ grep -c '^import ' index.js     # → 0
$ grep -c 'require(' index.js     # → 0
```

---

## 为什么不是「裁掉历史」

这个插件的第一版走了另一条路：挂在 `compaction/summary-error` 上，在压缩失败后裁掉 tool/result，指望引擎用更小的 prompt 重试。

**它一次都没成功过。** 实测 230 次裁剪、0 次救援，因为：

1. `recover()` 返回 `true` 只是用**同一份输入**重新 prepare **同一个区间**再试一次，注入不了任何新内容
2. 它只能碰 tool/result（25.8%），而超限主因是 tool-call 参数加 reasoning（62.4%）
3. 每个节点都有保留地板，518 个节点 × 456 字符 = 168,720 token 的固定开销，占预算 86%，阈值降到 1 也没用

更糟的是它写在 turn 外的 `tool/result` 替换，把两个会话写成了打不开的状态。

所以第二版换了个位置：不去修失败的压缩，而是在请求发出前就让它装得下。这一个改动让「重试同一区间」的死循环从根上消失——第一次就不会失败。

代码里还留着 `wouldPassSizeGate()` 这个预检函数，是给引擎那道「摘要必须更小」的闸门用的。那道闸门真实存在，一度让我们以为方案整个不成立，直到拿 14 次真实成功样本算了一遍——最坏只用掉 40.9% 的配额。

---

## 反馈与贡献

**算 bug**：`node test.mjs` 或 `node test-gate.mjs` 从绿变红；日志里出现 `compaction-rescue` 却没产出摘要；会话变得更糟。

**算提案**：新的瘦身手段、更准的窗口探测、对 `402` 之外错误码的识别。

提 issue 前请先跑：

```
node test.mjs && node test-gate.mjs && node self-redteam.mjs
```

把输出贴进来，比描述有用。

## License

MIT — 随便用，随便改，随便造。

---

<div align="center">

**compaction-rescue** 把压缩请求瘦到窗口装得下。<br>
*你的会话没坏，是压缩请求自己撑爆了窗口。*

</div>

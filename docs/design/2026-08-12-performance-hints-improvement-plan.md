# osstack 性能改进方案 — 基于 Jeff Dean & Sanjay Ghemawat《Performance Hints》

- 日期：2026-08-12
- 状态：**已执行并收口**（见 §6 执行结果；P2 数据门控中）
- 事实源：[abseil.io/fast/hints.html](https://abseil.io/fast/hints.html)（Dean & Ghemawat）；中文案例库 [eyeu.net/learn/ai-performance](https://www.eyeu.net/learn/ai-performance)
- 测量环境：Mac mini (darwin 25.6.0), Node v26.5.0, @osstack/cli 0.16.1（Homebrew 全局安装）

## 0. 适用性判断

osstack 是 Node/TS 的 CLI + daemon + loop 运行时，不是 C++ 热路径系统。《Performance Hints》的 11 章里：

| 章节 | 对 osstack | 说明 |
|---|---|---|
| Estimation（估算） | ✅ 直接适用 | 性能预算文化，先算后写 |
| Measurement（测量） | ✅ 直接适用 | 仓库目前 **0 个基准测试**（只有 60+ smoke，全部验证正确性不验证性能） |
| API 设计 / Bulk API | ✅ 直接适用 | daemon Unix socket 协议、SQLite 访问 |
| 避免无用工作 | ✅ **最大收益来源** | CLI 启动税（见 §1） |
| 代码体积 | ✅ 变体适用 | C++ 的 i-cache 问题在 Node 里对应「模块加载时间」——机制不同，处方相同 |
| 减少分配/内存表示 | ⚠️ 弱适用 | V8 GC 下收益有限，仅热循环关注 |
| 并行与同步 | ⚠️ 弱适用 | daemon 单进程事件循环，无锁竞争问题 |
| Protobuf / C++ / SIMD | ❌ 不适用 | — |

## 1. 实测证据（2026-08-12）

**每次 osstack 命令调用，无论多简单，都要付 ~320ms 的模块加载税：**

```
osstack --version 全程:      240–510 ms（3 次采样）
其中 import bin.js:           324 ms
其中 import @osstack/agents:  232 ms   ← 72% 的加载成本
```

因果链（已逐层确认）：

```
bin.ts:  import { defaultAdapters } from "@osstack/agents"      (静态)
  → agents/index.ts: import { ClaudeCodeAdapter } ...           (静态, 11 个 adapter 全量)
    → adapters/claude-code.ts:14:
      import { query } from "@anthropic-ai/claude-agent-sdk"    (静态)
        → 拉起 @grpc、@opentelemetry、protobufjs、hono、MCP SDK 整棵依赖树
```

结构性事实：

- `packages/cli/src/bin.ts`：**12,292 行**，61 个静态 import，仅 7 处动态 import。26 个命令模块全部急切加载——`osstack --version` 也要加载 neat、probe、autonomy、upgrade、hub 的全部代码。
- `dist/bin.js` 打包后 1.1 MB 单文件；`@osstack` 全局安装 754 MB。
- Hints 原文的对应条目：*"Avoid logging on hot code paths"* 的变体——osstack 的「热路径」就是**进程启动**。daemon、loop、agent 每天调用 CLI 数百次：300ms × 500 次/天 ≈ 每天 2.5 分钟纯加载浪费，且每次交互都感知得到。

**好消息**：core 状态层抽查（probe-metrics.ts、knowledge-hygiene-recurrence.ts）显示批量读取 + 内存分组的模式已经是对的，SQLite 层没有明显 N+1。

## 2. 方案（按 ROI 排序）

### P0 — 消灭启动税（Hints: Avoid Unnecessary Work + Code Size）

**目标：`osstack --version` / `status` / `board` 冷启动 < 120ms（当前 ~350ms）**

1. **`@anthropic-ai/claude-agent-sdk` 改为延迟加载**（预计 −230ms，改动最小）
   - `adapters/claude-code.ts` 顶层的 `import { query }` 移入 `run()` 内部的 `await import(...)`，或 adapter 构造改为工厂函数。
   - 类型引用用 `import type`（零运行时成本）保留。
   - 对应 Hints 案例：*Defer expensive computation*——「很多请求根本用不到子分片，把计算推迟到首个真实消费者出现」。这里的「子分片」就是 Claude SDK。

2. **bin.ts 命令表懒分发**（预计再 −50~80ms，且一劳永逸）
   - `argv[0] → await import("./xxx-command.js")` 的路由表，替代 61 个顶层静态 import。
   - **与进行中的 CLI 拆分线合流**：`codex/agent-cli-module`、`session-cli-module`、`skills-cli-module`、`steward-cli-module`、`assurance-cli-module`、`product-entry-cli-module` 这些分支已经在做模块抽取——这正是懒分发的前置条件。建议把「抽出的模块必须由 bin.ts 动态 import」写进这批 PR 的验收标准，否则拆完还是急切加载，白拆。
   - 对应 Hints：*Deep modules*（窄接口后藏大功能）+ *Fast paths for common cases*。

3. **`--version` / `--help` 零依赖快路径**
   - 在任何 import 之前先匹配这两个参数，直接打印退出。版本号构建期注入。
   - 对应 Hints 案例：*One-byte varint fast path*——最常见的情况留在最短路径上。

### P1 — 建立测量地基（Hints: Measurement）

**目标：性能回归和正确性回归一样会挡 PR**

4. **新增 `pnpm bench:cli`**，纳入现有 smoke 家族：
   - 断言 `osstack --version` 冷启动 < 150ms、`import bin.js` < 100ms（阈值随 P0 落地收紧）。
   - 实现：`node --input-type=module -e "performance.now() 包裹 import"`，无需引入基准框架。
   - 这是防止启动税**回涨**的闸门——今天修掉 232ms，下个 PR 一个顶层 import 又能加回来。
5. **daemon RPC 延迟直方图**：`osstack stats` 已有 per-agent 指标，补每类 socket 请求的 p50/p95。有了这个才知道 P2 值不值得做。

### P2 — Bulk API 审计（Hints: Bulk APIs）

6. **Unix socket 协议巡检**：找出 CLI 单次用户命令触发多次 daemon 往返的序列（如 board 渲染、session list + status 组合），合并为一个 bulk 端点。对应案例：*Bulk LookupMany*——「把许多单项查找合成一次调用」。**先测（P1.5）后改**，只动 p95 榜首。
7. **SQLite 写路径 transaction 化**：审计 better-sqlite3 多行写入是否包在 `db.transaction()` 里；prepared statement 是否缓存复用。抽查未见问题，但值得一次系统过账。

### P3 — 估算文化（Hints: Estimation）

8. **AGENTS.md 增加性能预算段**（约 10 行）：
   - CLI 冷启动 < 150ms；daemon 本地 RPC < 10ms；loop tick 开销 < 1% 会话时长。
   - 新增顶层依赖需回答：「import 成本多少 ms？哪些命令真正需要它？」
   - 这是把 Dean/Ghemawat 的 back-of-envelope 习惯固化为 maker/checker 流程里 checker 的一条检查项。
9. **统计采样审计**：loop/daemon 里每事件更新、但无人读取的派生指标，按 Hints *Drop expensive alarm statistics* 处理——「删除比优化更诚实，可观测性也要有预算」。

## 3. 不做什么

- 不追求 Rust/native 重写、不引入 snapshot 启动（bun single-binary 线已另行推进，本方案与之正交且互补——懒加载同样缩小 single-binary 的启动工作集）。
- 不对 V8 层内存布局做微优化（InlinedVector/位向量类技巧在 JS 无对应收益）。
- 不动 core 状态层的读路径（抽查显示已是批量模式）。

## 4. 验收标准

| 项 | 当前 | 目标 |
|---|---|---|
| `osstack --version` 冷启动 | ~350ms | < 60ms（快路径后基本只剩 node 启动） |
| `osstack status` 冷启动 | ~260ms | < 120ms |
| `import bin.js` | 324ms | < 100ms |
| 性能回归闸门 | 无 | `bench:cli` 进 CI，超阈值挡 PR |
| daemon RPC 可观测性 | 无延迟数据 | stats 输出 p50/p95 |

## 5. 建议执行序

1. PR-A：claude-agent-sdk 延迟加载（单文件改动，独立可回滚）→ 立即验证 −230ms
2. PR-B：`bench:cli` 闸门（锁住 PR-A 的成果）
3. PR-C..N：随 CLI 拆分线逐模块转懒分发（每个命令模块一个小 PR，符合现有 maker/checker 节奏）
4. PR-X：--version/--help 快路径
5. 之后按 stats 数据决定 P2 是否立项

---

## 6. 执行结果（2026-08-13 收口）

计划全部可执行项已落地，六个 PR 三班 release train，生产运行于 0.17.2。

| 验收项 | 计划目标 | 实测终值 | 载体 |
|---|---|---|---|
| `osstack --version` | < 60ms | **~20ms** | #201 cli-entry 快路径 |
| `osstack status` / `--help` | < 120ms | **~75ms** | #199 懒 SDK/OTel + #206 懒分发 |
| 主 chunk 冷 import | < 100ms | **~72ms**（1.1MB→500KB） | #206 |
| 性能闸门 | bench:cli 进 CI | 本地 150/500ms + CI 250/900ms 双档 | #201「CLI startup budget」步骤 |
| RPC p50/p95 | stats 输出 | 每方法 512 槽滑窗，method 数封顶 64 | #203 |

附带成果：#204 修复 `osstack upgrade` 用调用者 env 写控制面角色文件的缺陷（2026-08-12 生产事故根因，已裸 env 实弹回归验证）；#207 根修两个环境 flaky 测试（doctor 磁盘注入、guarded fixture .gitignore）。

### P2 状态：数据门控中

bulk API 立项条件 = 生产 RPC p95 表积累足量流量（daemon 2026-08-13 重启后从零开始，需数日 daily/loop 流量）。届时按 `osstack stats` rpc 段 p95 降序榜首立项。

P2b（SQLite 事务过账）已完成审计：core 状态层事务纪律整体良好；仅 `probe-store.ts upsertItems`（多行 upsert 循环无事务）与 `lessons.ts` 计数更新循环两处冷路径候选，规模小、无实测痛点，按「先测后改」原则记录不动码。

### 剩余 eager 成本

`@osstack/core`（冷 ~40-70ms，zod + state/policy 面）是最后大头，符号编织于 bin.ts 全文，归属命令模块抽取线（codex/*-cli-module）继续处理；bin.ts 顶部已留注释约束新增顶层 import。

### 方法论沉淀（供后续懒化工作复用）

验证 bundle 懒化**不能**用文本 grep（esbuild 多行 import 逃逸单行匹配），**不能**在同进程串测多包（先测包污染后测包的模块缓存）。可靠方法：构建后每包独立进程执行「import 主 chunk → 计时 import 目标包」，<1ms 即判 eager；或 loader-hook 记录全量加载清单。本计划执行中文本 grep 两次误判通过、串测探针两次误判回流，均由该方法纠正（含 supervisor→loop/governance/agents/github 的 ~177ms 隐蔽回流链）。

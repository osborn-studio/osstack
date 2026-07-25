# osstack Loop 工程架构落地方案

> **版本**: v0.1 (Draft for Review)
> **日期**: 2026-06-18
> **作者**: Osborn + DeepSeek V4 Pro
> **状态**: 待 CEO 审核
> **上游依据**:
> - [docs/V2_REFACTOR_PLAN.md](V2_REFACTOR_PLAN.md) — 已有 V2 架构骨架、20 个 CEO 决策、S0-S6 交付计划
> - [legacy-python/runtime/bin/osb-loop](../legacy-python/runtime/bin/osb-loop) — V1 循环实现（context → diff → review → verify → summary）
> - `/Users/merry/wiki/Clippings/` 下 4 篇 Loop Engineering 文献
> - `/Users/merry/wiki/articles/loop-engineering-comprehensive-guide-v2.md` — LE 综合手册
> - `/Users/merry/wiki/articles/loop-engineering-implementation-guide.md` — LE 落地指南

---

## 0. 一行定义

**osstack 的 daemon hot loop 从「被动等待 Unix socket 请求的任务分发器」升级为「自主发现工作、分配任务、验证结果、持久化状态、决定下一步的 Loop 工程系统」。**

---

## 1. 核心洞察：osstack V2 已经是半成品 LE

不是从零开始。以下现有资产直接对位 LE 的 4 层架构：

| LE 层级 | LE 职责 | osstack V2 现有资产 | 完备度 |
|---------|--------|-------------------|--------|
| **Prompt 层** | 「怎么问」 | agent adapters 各自处理 prompt 模板；`partneros-agents` 的 ROLE.md 内核 | 散落但有 |
| **Context 层** | 「让 AI 看到什么」 | `skill-registry` (manifest + watcher)、`state/` (SQLite)、`kg/gbrain` | 骨架在，待充实 |
| **Harness 层** | 「AI 在什么环境里工作」 | `policy/engine`、`privacy/redactor`、`hermes-adapter` (FSM + 13 事件)、`orchestrator/router` | **接近完备** |
| **Loop 层** | 「AI 做完一步后怎么办」 | ❌ **缺失** | **本次改造的全部内容** |

已存在的 LE 兼容设计但未活化：
- V2_REFACTOR_PLAN §2.4 的 **7 插件槽位**中，`Workspace` 槽位明确写了 `git worktree`，`Reviewer` / `Verifier` 槽位有定义
- §5.2 的生命周期已描述 **Discover → ... → Retrospect 的 feedback loop**
- `partneros-engine` 已示范 **6 个 agent 的 maker/checker 串行模式** + memory feedback loop

**本次改造 = 激活 Loop 层，把 7 个槽位中空着的填上，把生命周期机从文档搬进 daemon 的 while 循环。**

---

## 2. 架构总览（4 层 + 2 个新增能力）

```
┌──────────────────────────────────────────────────────────────────┐
│                      Loop 层（本次新增）                           │
│                                                                   │
│  ┌─────────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ scheduler   │  │ discover │  │ iterator │  │ state-file   │  │
│  │ cron 心跳    │  │ 扫描工作  │  │ 停止条件  │  │ STATE.md     │  │
│  │ /goal 条件  │  │ →Task[]  │  │ 评估      │  │ 持久化       │  │
│  └─────────────┘  └──────────┘  └──────────┘  └──────────────┘  │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │                    daemon hot loop                           │ │
│  │  while (true) {                                              │ │
│  │    tasks = discoverer.scan()                                 │ │
│  │    for task of tasks:                                        │ │
│  │      plan = planner.plan(task)   ← 复用 policy/engine        │ │
│  │      run = executor.execute(plan) ← 复用 agents/adapters     │ │
│  │      verdict = verifier.verify(run) ← 新增                   │ │
│  │      iterator.evaluate(verdict) ? continue : break            │ │
│  │    stateWriter.flush()                                       │ │
│  │    scheduler.wait()                                          │ │
│  │  }                                                           │ │
│  └──────────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────┤
│                    Harness 层（已有，基本不改）                     │
│  policy/engine  |  orchestrator/router  |  agents/adapters        │
│  privacy/redactor  |  hermes-adapter (13事件+FSM)  |  plugins/    │
├──────────────────────────────────────────────────────────────────┤
│                    Context 层（已有，S6/S7 充实）                   │
│  skill-registry (manifest+watcher+ingester)  |  state/ (SQLite)   │
│  kg/gbrain  |  config/                                            │
├──────────────────────────────────────────────────────────────────┤
│                    Prompt 层（分散在各 adapter 中）                 │
│  claude-code adapter prompt  |  codex-cli adapter prompt         │
│  ds-review prompt  |  ds-verify prompt  |  partneros ROLE.md      │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. 五阶段循环：daemon hot loop 的核心

来自 LE 文献的 Discover → Plan → Execute → Verify → Iterate 五阶段，映射到 osstack：

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Discover（发现）                                   新 增     │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ 扫描源：                                                   │ │
│  │  • git diff --stat（本地未提交改动）                        │ │
│  │  • gh issue list（GitHub Issues）                          │ │
│  │  • CI 日志解析（失败 job）                                  │ │
│  │  • osstack tasks/ 目录下的 YAML 任务队列                    │ │
│  │ 输出：Task[]（id, capability, prompt, priority, context）   │ │
│  └───────────────────────────────────────────────────────────┘ │
│                              ↓                                   │
│  2. Plan（计划）                                扩展现有       │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ 复用 policy/engine + orchestrator/router：                  │ │
│  │  • 按 task.capability → 匹配 agent                         │ │
│  │  • 按历史成功率 + 成本 + 最近失败打分                        │ │
│  │  • 输出：ExecutionPlan（agent_id, worktree_path,            │ │
│  │          max_iterations, stop_condition）                   │ │
│  └───────────────────────────────────────────────────────────┘ │
│                              ↓                                   │
│  3. Execute（执行）                              已有，不改    │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ 复用 agents/adapters/*.ts：                                 │ │
│  │  • claude-code:  SDK 直接调用                               │ │
│  │  • codex-cli:    spawn headless                             │ │
│  │  • 新增 ds-review / ds-verify adapter                       │ │
│  │  • 每个 agent 在独立 worktree 中执行（新增隔离）             │ │
│  │ 输出：AgentRun（run_id, outcome, tokens, duration, diff）   │ │
│  └───────────────────────────────────────────────────────────┘ │
│                              ↓                                   │
│  4. Verify（验证）                                 新 增       │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ 验证链（可配置）：                                          │ │
│  │  • ds-review adapter: 代码审查                              │ │
│  │  • ds-verify adapter: 架构/规格对齐                         │ │
│  │  • 自动化检查: vitest / tsc --noEmit / eslint               │ │
│  │  • 用户自定义 hooks（.agent/hooks/verify.sh）               │ │
│  │ 输出：Verdict { pass: bool, issues: Issue[], score: number }│ │
│  └───────────────────────────────────────────────────────────┘ │
│                              ↓                                   │
│                          ┌───┴───┐                               │
│                          │ pass?  │                              │
│                          └───┬───┘                               │
│                      ┌───────┴───────┐                           │
│                      │ YES           │ NO                        │
│                      ↓               ↓                           │
│  5. Iterate（迭代）                       新 增                  │
│  ┌──────────────────┐  ┌────────────────────────────────────┐  │
│  │ 更新 STATE.md     │  │ 迭代次数 < max_iterations?         │  │
│  │ 写入 SQLite       │  │  YES → 带回失败信息 → Step 2       │  │
│  │ 决定下一步         │  │  NO → 标记为需要人工介入           │  │
│  │ → scheduler.wait()│  │  触发 Hermes 通知                  │  │
│  └──────────────────┘  └────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. LE 六大要素在 osstack 中的落点

| LE 要素 | 在 osstack 中的实现 | 新增/复用 | 关键文件 |
|---------|-------------------|----------|---------|
| **Automations** | `packages/loop/src/scheduler.ts` — cron 表达式解析 + `/goal` 条件触发 | **新增** | `scheduler.ts` |
| **Worktrees** | `packages/agents/src/worktree.ts` — git worktree 生命周期管理 | **新增** | `worktree.ts` |
| **Skills** | `packages/skill-registry/` — 已有 manifest + watcher，补 ingester | 扩展现有 | `skill-registry/src/ingester/` |
| **Connectors** | `packages/plugins/src/` — 用 MCP 协议对接 GitHub/Slack/Linear | 扩展现有 | `plugins/src/connectors/` |
| **Sub-agents** | `packages/agents/src/adapters/` — 已有 claude-code + codex，新增 ds-review + ds-verify | 扩展现有 | `adapters/ds-review.ts`, `adapters/ds-verify.ts` |
| **State** | SQLite（已有）+ `STATE.md` 文件态（新增） | 扩展 | `core/state/` + `loop/src/state-file.ts` |

---

## 5. 模块设计：新增与修改清单

### 5.1 新增包：`packages/loop/`

```
packages/loop/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts              ← 导出 LoopEngine
    ├── scheduler.ts          ← cron 心跳 + /goal 条件
    ├── discover.ts           ← 扫描 git/issue/CI → Task[]
    ├── planner.ts            ← Task → ExecutionPlan（调 policy/engine）
    ├── executor.ts           ← ExecutionPlan → AgentRun（调 agents/adapters）
    ├── verifier.ts           ← AgentRun → Verdict（调 review/verify adapters）
    ├── iterator.ts           ← Verdict → 继续/停止 决策
    ├── state-file.ts         ← 读/写 LOOP-STATE.json + STATE.md
    ├── loop-engine.ts        ← 装配上述模块为完整 LoopEngine
    ├── types.ts              ← 所有 Zod schema + TS 类型
    ├── scheduler.test.ts
    ├── discover.test.ts
    ├── iterator.test.ts
    ├── state-file.test.ts
    └── loop-engine.test.ts   ← 集成测试：模拟一轮完整循环
```

### 5.2 新增文件（在现有包中）

| 包 | 文件 | 说明 |
|----|------|------|
| `packages/agents/` | `src/worktree.ts` | `createWorktree()` / `mergeWorktree()` / `cleanupWorktree()` |
| `packages/agents/` | `src/worktree.test.ts` | 工作树生命周期测试 |
| `packages/agents/` | `src/adapters/ds-review.ts` | DeepSeek review adapter（从 V1 bash 迁移） |
| `packages/agents/` | `src/adapters/ds-review.test.ts` | review adapter 测试 |
| `packages/agents/` | `src/adapters/ds-verify.ts` | DeepSeek verify adapter（从 V1 bash 迁移） |
| `packages/agents/` | `src/adapters/ds-verify.test.ts` | verify adapter 测试 |

### 5.3 修改现有文件

| 包 | 文件 | 变更内容 |
|----|------|---------|
| `packages/agents/` | `src/base.ts` | `AgentAdapter` 接口加 `prepareWorktree?()` / `cleanupWorktree?()` |
| `packages/agents/` | `src/registry.ts` | 注册 ds-review + ds-verify adapter |
| `packages/core/` | `src/capability.ts` | 加 `review.code` / `verify.alignment` capability |
| `packages/core/` | `src/orchestrator/router.ts` | router 接受 `review.code` / `verify.alignment` 路由 |
| `packages/core/` | `src/policy/engine.ts` | policy 加 `max_iterations` 字段 |
| `packages/cli/` | `src/daemon.ts` | 主循环从「等 socket」改为「hot loop 调用 LoopEngine」 |
| `packages/cli/` | `src/bin.ts` | 加 `osstack loop start/stop/status` 命令 |
| `packages/cli/` | `src/commands/` | 新增 `loop.ts` 命令模块 |

---

## 6. 核心接口定义（TypeScript）

### 6.1 Loop 层类型

```typescript
// packages/loop/src/types.ts

import { z } from "zod";

// ── Discover ──

export const DiscoverSourceSchema = z.enum([
  "git_diff",
  "gh_issue",
  "ci_log",
  "task_queue",
  "manual",
]);

export const TaskSchema = z.object({
  task_id: z.string(),
  capability: z.string(),          // e.g. "code.fix" / "review.code"
  prompt: z.string(),
  priority: z.number().min(0).max(100),
  source: DiscoverSourceSchema,
  context: z.record(z.unknown()).optional(),
});
export type Task = z.infer<typeof TaskSchema>;

// ── Plan ──

export const StopConditionSchema = z.object({
  type: z.enum(["tests_pass", "lint_clean", "typecheck_clean",
                  "review_approved", "max_iterations", "custom"]),
  params: z.record(z.string()).optional(),
});

export const ExecutionPlanSchema = z.object({
  plan_id: z.string(),
  task: TaskSchema,
  agent_id: z.string(),
  worktree_path: z.string(),
  max_iterations: z.number().min(1).max(10).default(3),
  stop_condition: StopConditionSchema,
});
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

// ── Verify ──

export const IssueSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  file: z.string().optional(),
  line: z.number().optional(),
  message: z.string(),
  rule: z.string().optional(),
});

export const VerdictSchema = z.object({
  pass: z.boolean(),
  score: z.number().min(0).max(1),
  issues: z.array(IssueSchema),
  reviewer_agent_id: z.string(),
  summary: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

// ── Iterate ──

export const IterationOutcomeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("continue"), reason: z.string() }),
  z.object({ action: z.literal("stop"), reason: z.string() }),
  z.object({ action: z.literal("escalate"), reason: z.string(), escalate_to: z.enum(["human", "hermes"]) }),
]);
export type IterationOutcome = z.infer<typeof IterationOutcomeSchema>;

// ── State File ──

export const LoopStateSchema = z.object({
  loop_id: z.string(),
  started_at: z.string(),
  updated_at: z.string(),
  completed_tasks: z.array(z.object({
    task_id: z.string(),
    outcome: z.enum(["success", "failed", "escalated"]),
    iterations: z.number(),
    agent_id: z.string(),
    duration_ms: z.number(),
  })),
  in_progress: z.array(TaskSchema).optional(),
  pending: z.array(TaskSchema).optional(),
  key_metrics: z.object({
    total_cycles: z.number(),
    avg_duration_ms: z.number(),
    success_rate: z.number(),
    tokens_consumed: z.number(),
  }).optional(),
  decisions: z.array(z.string()).optional(),
});
export type LoopState = z.infer<typeof LoopStateSchema>;
```

### 6.2 LoopEngine 主接口

```typescript
// packages/loop/src/loop-engine.ts

export interface LoopEngineConfig {
  /** cron 表达式，控制循环频率。不设则只跑一轮 */
  schedule?: string;
  /** /goal 条件：满足则停止 */
  goal?: StopCondition;
  /** 发现源列表 */
  discoverSources: DiscoverSource[];
  /** 验证链 */
  verifiers: VerifierConfig[];
  /** 最大全局迭代次数 */
  maxGlobalIterations: number;
  /** 状态文件路径 */
  stateFilePath: string;
}

export interface LoopEngine {
  /** 启动循环（阻塞当前进程，直到 stop 或 goal 达成） */
  start(config: LoopEngineConfig): Promise<void>;
  /** 停止循环（优雅：完成当前 iteration 后停） */
  stop(): Promise<void>;
  /** 当前循环状态快照 */
  status(): LoopState;
  /** 事件流（供 Hermes observe 等） */
  events(): AsyncIterable<LoopEvent>;
}
```

### 6.3 AgentAdapter 接口扩展

```typescript
// packages/agents/src/base.ts（在现有基础上加）

export interface AgentAdapter {
  // ... 现有字段保持不变 ...

  /** 为本次执行创建隔离工作树。可选：不实现则共享工作目录 */
  prepareWorktree?(task: AgentTask): Promise<{ worktreePath: string; branch: string }>;

  /** 执行完成后合并工作树结果。可选 */
  cleanupWorktree?(worktreePath: string, branch: string): Promise<void>;
}
```

---

## 7. 调度器设计（scheduler.ts）

```typescript
// packages/loop/src/scheduler.ts

/**
 * Scheduler 支持三种触发模式：
 *
 * 1. cron 模式：按 cron 表达式定时触发
 *    /loop "Run triage" --schedule "0 6 * * *"
 *
 * 2. goal 模式：持续循环直到目标达成
 *    /goal "All tests in test/auth pass and lint is clean"
 *
 * 3. manual 模式：单次触发后等待
 *    osstack task submit "..." → 触发一轮，然后回到等待
 */

export interface SchedulerConfig {
  mode: "cron" | "goal" | "manual";
  cronExpr?: string;           // cron 模式
  goalCondition?: StopCondition; // goal 模式
  minIntervalMs: number;        // 最小循环间隔（防 token 烧太快），默认 60000
  maxRuntimeMs?: number;        // 最长运行时间（防无限跑），默认 3 天
}

export class Scheduler {
  /** 等待下一次触发。返回 false 表示应该停止 */
  async wait(): Promise<boolean>;

  /** 立即触发一次（跳过等待） */
  async triggerNow(): Promise<void>;
}
```

**防烧钱措施**（对齐 LE 文献警告）：
- 默认最小循环间隔 60s
- 默认最大运行时间 72h
- triage 阶段用便宜模型（Haiku 4.5 / DeepSeek-V3），发现 actionable 任务才 spawn 子 agent
- 每次循环后写 token 消耗计数器，超预算自动降级

---

## 8. Worktrees 生命周期

```typescript
// packages/agents/src/worktree.ts

/**
 * 每个子 agent 获得一个独立的 git worktree：
 *
 *   主 repo:     /Users/merry/Documents/AI Lab/osstack
 *   Agent A:     /tmp/osstack-worktrees/agent-a-<run_id>
 *   Agent B:     /tmp/osstack-worktrees/agent-b-<run_id>
 *
 * 流程：
 *   1. git worktree add /tmp/osstack-worktrees/agent-a-<run_id> -b osstack/loop/<run_id>
 *   2. Agent 在 worktree 内执行（独立 checkout，不互相覆盖）
 *   3. 执行完成 → git add + git commit（在 worktree 内）
 *   4. 主 repo git merge（处理冲突）
 *   5. git worktree remove + git branch -D
 */

export interface WorktreeManager {
  /** 为 agent 创建隔离工作树 */
  create(agentId: string, runId: string): Promise<{ path: string; branch: string }>;

  /** 合并工作树改动回主分支 */
  merge(path: string, branch: string): Promise<{ success: boolean; conflicts: string[] }>;

  /** 清理工作树（无论成功失败都要调） */
  cleanup(path: string, branch: string): Promise<void>;

  /** 列出所有 orphaned worktrees（daemon 崩溃后清理用） */
  listOrphans(): Promise<string[]>;
}
```

---

## 9. STATE.md 协议

对齐 LE 文献的核心洞察：**「模型会遗忘，但仓库不会。」** 每个循环迭代从全新上下文窗口开始，但基于 STATE.md 中的持久化内容。

```markdown
<!-- STATE.md（由 osstack daemon 自动写入） -->

# Loop State — 2026-06-18 10:35:00

## 正在进行
- [ ] 修复 #124：API 返回 500
  - 尝试 1：修改 auth 中间件 — 失败（TypeError: undefined）
  - 尝试 2：检查数据库连接 — 进行中
  - Agent: claude-code | Worktree: /tmp/osstack-wt/claude-code-run_abc123

## 已完成
- [x] 修复 #123：登录页 CSS 问题 ✅
  - Agent: claude-code | 迭代 1 次 | 耗时 2.3s
- [x] 更新依赖 ✅
  - Agent: codex-cli | 迭代 1 次 | 耗时 1.8s

## 待处理
- [ ] 添加 auth 模块单元测试（优先级 P1）
- [ ] 重构用户服务（优先级 P2）

## 关键指标
- 本轮循环数：3
- 平均耗时：2.1s
- 成功率：67%
- Token 消耗：45.2k

## 决策记录
- 为什么跳过 #126？→ 被标记为 wontfix
- 为什么选 claude-code 而不是 codex？→ #124 涉及复杂调试，claude-code 在 debug 任务上历史成功率 87%
```

osstack 写入路径：
```
daemon hot loop
  → state-file.ts: flush(LoopState)
    → 写入 STATE.md（Markdown，人类可读）
    → 写入 LOOP-STATE.json（结构化，程序可读，与 STATE.md 同内容）
    → 写入 SQLite runs 表（结构化查询 + 指标）
```

---

## 10. 与 V1 `osb-loop` 的继承关系

| V1 osb-loop | V2 Loop 工程 |
|------------|-------------|
| bash 脚本，手动跑一次 | TypeScript daemon hot loop，永续运转 |
| `osb-context → git diff → ds-review → ds-verify → summary` | `Discover → Plan → Execute → Verify → Iterate` |
| 只产出报告文件 | 产出：STATE.md + 代码改动（真实 merge）+ SQLite 历史 |
| 不支持调度 | cron 心跳 + /goal 条件自动触发 |
| 不支持多 agent 协作 | 每个 task 独立 worktree + maker/checker 分离 |
| `osbstack loop` 命令调用 | `osstack loop start` 启动 daemon 循环模式 |

**向后兼容承诺**：`osstack loop` CLI 命令保留；V1 的 `osb-loop` 入口继续可用，并转发到 `osstack loop start --once --source git_diff`。

---

## 11. 风险与注意事项（来自 LE 文献的警告）

| 风险 | 来源文献 | osstack 应对措施 |
|------|---------|----------------|
| **Token 消耗失控** | Cobus Greyling / 卜寒兮 | minIntervalMs=60s、maxRuntimeMs=72h、triage 用便宜模型 |
| **理解债**：跑太快，你不看代码了 | Cobus Greyling | STATE.md 每次循环写人类可读摘要；`osstack loop status` 随时可查 |
| **认知投降**：什么都听循环的 | Cobus Greyling | escalation 机制：连续失败 3 次 → 标记为需要人工介入 → Hermes 通知 |
| **多 agent 文件冲突** | 徐小夕 / Addy Osmani | Worktree 隔离（每个 agent 独立 checkout） |
| **子 agent 上下文漂移** | Anthropic 实践经验 | 每轮从 STATE.md + SKILL.md 重新加载上下文，不依赖上一轮的对话历史 |
| **调试难度大** | 卜寒兮 | 事件流全程可 replay（`osstack task observe`），每步记录到 SQLite |
| **底模能力不足** | 卜寒兮 / Addy Osmani | triage 用便宜模型，实际执行用 claude-code SDK（Opus 级别） |
| **daemon 崩溃丢任务** | V2 F1 已有 | launchctl KeepAlive + stale socket cleanup + checkpoint 续跑 |

---

## 12. 分阶段交付计划

在现有 V2 S0-S6 已完成 + S7.1 PartnerOS 已交付的基础上，插入 Loop 改造：

| Sprint | 时长 | 目标 | 关键产出 |
|--------|------|------|---------|
| **L0** | 1 天 | 本方案 CEO 审核通过 | `docs/LOOP_ENGINEERING_DESIGN.md` v1.0 |
| **L1** | 2-3 天 | Loop 层骨架 + 类型定义 | `packages/loop/` 脚手架 + `types.ts` + zod schema + 单测 |
| **L2** | 3-4 天 | Scheduler + Discover + Worktrees | scheduler.ts、discover.ts、worktree.ts + 单测 + 集成测试 |
| **L3** | 2-3 天 | Planner + Executor（复用现有） | planner.ts 调 policy/engine + executor.ts 调 agents/adapters |
| **L4** | 3-4 天 | Verifier + Iterator + State-file | ds-review/ds-verify adapter、verifier.ts、iterator.ts、state-file.ts |
| **L5** | 2-3 天 | Daemon 改造 + CLI 命令 | daemon.ts hot loop 重写、`osstack loop start/stop/status` |
| **L6** | 2-3 天 | 端到端集成 + 真实场景验证 | 在 osstack 自身仓库跑一轮 loop：git diff → review → verify → iterate |

**总计**：14-20 天 human time

---

## 13. 验收标准（L6 完成时）

1. [x] `osstack loop start --schedule "0 6 * * *"` 启动 daemon，按 cron 表达式自动触发循环
2. [x] `osstack loop start --goal "pnpm test 全绿"` 持续循环直到 vitest 全部通过
3. [x] 每次循环自动：`git diff` 扫描 → `policy/engine` 选 agent → 独立 worktree 执行 → `ds-review` 审查 → 决定继续/停止
4. [x] 循环过程中 `osstack loop status` 实时展示 STATE.md 内容
5. [x] 连续 3 次同类任务失败后自动 escalation → Hermes 通知
6. [x] `kill -9` daemon 后，重启能从 checkpoint 续跑（复用现有 step-level checkpoint）
7. [x] 孤儿 worktree 自动清理（daemon 启动时和每次循环后）
8. [x] `osstack stats` 增加 per-loop 指标（成功/失败/耗时/token 消耗）
9. [x] V1 的 `osb-loop` 作为 shim 继续可用（转发到 `osstack loop start --once`）
10. [x] 整个 `packages/loop/` 测试覆盖率 ≥ 80%

当前实现备注：

- `osstack loop run/start --agent <id>` 已接入真实 `AgentAdapter.invoke()` 路径；LoopEngine 会把 `repo_path` 注入任务 context，统计 adapter 事件数，并把 terminal `done/error` 映射为 loop 执行结果。
- `--auto-agent` 已接入自动 maker 选择：LoopEngine 在未显式指定 `--agent` / `--execute` 时，可用 `routeCapability` 找候选 adapter，再复用 `policy/engine`（daemon 下使用 SQLite history，本地 fallback 到 loop state history）按 capability/cost/历史表现择优；`loop.plan.done` 会记录 `routing_reason` 和 policy 摘要。
- `ds-review` / `ds-verify` 已作为 adapter 注册：新增 capability `review.code` / `verify.alignment`，router 可按 dotted capability 后缀匹配；命令路径可用 `OSSTACK_DS_REVIEW_BIN` / `OSSTACK_DS_VERIFY_BIN` 覆盖。
- `--reviewer <id>` / `--checker <id>` 已接入 Verify 阶段，可在 maker/executor 完成后自动运行 adapter verifier；local CLI、daemon RPC 和 built CLI smoke 均覆盖 `ds-review` post-execution review。
- `scripts/smoke-loop.mjs` 已用 built CLI 覆盖 `--reviewer ds-review`：在临时 git workspace 中由 execute 阶段制造 diff，经 adapter stdin 传给 fake `ds-review`，并断言 `reviews/ds-review/latest.md` 包含新增行。
- 未注册的非本地 agent 会失败并进入验证/迭代流程，不会被当成 `local-noop` 成功。
- `--worktree` 已支持每个 task 在独立 git worktree 内执行；成功任务会提交并 `--ff-only` 合并回主工作区，失败/升级任务会清理临时 worktree。
- 如果成功任务已提交但主工作区无法 fast-forward 合并，Loop 会清理临时 worktree 但保留 `osstack/loop/...` 分支，避免丢失可人工处理的成果。
- daemon 启动恢复 session 时会清理已持久化 worktree loop 的孤儿 worktree；启用 `--worktree` 的循环会在每个 cycle 前后清理当前 loop 前缀下的残留 worktree，并发 loop 之间通过 `osstack/loop/<loop_id>/...` 分支前缀隔离。
- `legacy-python/runtime/bin/osb-loop` 已改为兼容 shim：自动复用或临时启动 daemon，调用 `loop start --once --source git_diff`，轮询 session 完成，并用 `LOOP-STATE.json` 中的 completed task outcome 决定退出码。
- `pnpm demo:loop:daemon` 已提供可人工验收的 daemon 级演示：脚本启动隔离 `osstack serve`，入队一个真实失败测试修复任务，通过 `loop start --once` 跑完，断言 `loop status --daemon` / `osstack stats`，并留下 workspace 与 daemon home 供检查。
- `osstack loop doctor` 已提供开跑前诊断：检查 workspace、`tasks/*.json`、`LOOP-STATE.json`、git/worktree 可用性，并在 `--daemon` 下验证 RPC socket；`--json` 输出可直接进入脚本化测试。
- `scripts/smoke-loop.mjs` 现在用 built CLI 覆盖本地 run、`loop doctor`、worktree merge、DeepSeek review adapter、daemon `start --once`、daemon goal stop、daemon cron schedule、进程级 `SIGKILL` 后 daemon 重启恢复、`osstack stats` loop 指标和 legacy `osb-loop` shim。
- `pnpm coverage:loop` 现在强制 `packages/loop` 的 lines/functions/branches/statements 全部 ≥ 80%；当前覆盖率为 statements/lines 94.63%、functions 95.29%、branches 81.79%。
- 第 6 条已补进程级 `kill -9` smoke：在真实 daemon 进程中持久化 running session，`SIGKILL` 后重启同一 `OSSTACK_HOME`，确认原 session 继续处理新入队 task。

### 2026-07 Loop Engineering 升级（Increment A–E，见 `docs/2026-07-04-loop-engineering-upgrade-spec.md`）

以上骨架之上补齐了 loop 质量五要素，均为 opt-in / 向后兼容，不改动既有 CLI 行为：

- **A. EvaluationSpec（验收工具）**：task queue 文件新增 `evaluation` 字段（`packages/loop/src/evaluation-spec.ts`，7 种 mode：command/contract/property/e2e/artifact/semantic_review/governance）。`--verify CMD` 降级为 implicit command spec，artifact 校验降级为 implicit artifact spec；verifier 产出 per-spec 结果并写入 `Verdict.evaluations` / `LOOP-STATE.json` / `STATE.md`。`semantic_review` spec 需要 `--reviewer`/`--checker` adapter；required spec 失败即使 adapter 进程 exit 0 也拦截 verdict。
- **B. Feedback-Carrying Iteration**：失败 verdict 派生 `IterationFeedback`（`packages/loop/src/feedback.ts`），下一轮通过 `AgentTask.context.iteration_feedback` 注入 adapter，本地 `--execute` 命令经 `$OSSTACK_ITERATION_FEEDBACK_FILE` 读取；连续两轮 issue fingerprint + changed files 相同触发 no-progress escalation；`loop.iterate.done` 带 `failed_evaluation_ids`，feedback 逐轮写入 `STATE.md`。
- **C. Discovery Governance**：`DiscoveryPolicy`（`packages/loop/src/discovery-policy.ts`）把 discovered task 分为 `auto_execute` / `needs_approval` / `suggest_only` / `blocked`。`--discovery-policy default|<file.json>`：`task_queue` 保持 auto，`git_diff` 默认 suggest_only，`github_branch` 默认 needs_approval；deferred task 写入 state/report 但不执行，`STATE.md` 分 Needs Approval / Suggested / Blocked 段。未配 policy 时行为不变。
- **D. Budget And Stop Controls**：`LoopBudget`（`packages/loop/src/budget.ts`）支持 max_cycles/max_task_iterations/max_runtime_ms/max_tokens/max_estimated_cost_usd/no_progress_limit。超预算发 `loop.budget.exceeded` 事件并以 **退出码 2**（非 CLI crash 1）停止；`budget_status` 持久化进 `LOOP-STATE.json`，daemon session 记录 stop reason 并把 limits+usage 暴露到 `loop list` / `osstack stats` per-loop；`STATE.md` 增 Budget 段。CLI flag：`--max-runtime-ms` / `--max-tokens` / `--max-cost-usd` / `--no-progress-limit`。
- **E. SOP Flywheel（lesson drafts）**：经历失败后成功的 task 生成 `loop-lessons/drafts/<task_id>.md`（`packages/loop/src/lesson-draft.ts`），含 task prompt / failed evaluations / verifier caught what / final fix / reusable rule / suggested evaluation / suggested skill；默认不改正式 SKILL.md。审核流：`osstack loop lessons list|show|promote|discard`，`promote --to-skill PATH` 是唯一写入 skill 文件的路径。`--no-lesson-drafts` / `--lessons-dir` 可控。
- **DeepSeek adapter 判定协定**：TS adapter 把 evaluation specs 经 `OSSTACK_EVALUATION_SPECS_FILE` 传给外部二进制，二进制打一行 `OSSTACK_EVALUATIONS: {...}` 回传 per-spec 判定（`lib/evaluation_specs.py`）；`legacy-python/deepseek/bin/ds-review`、`ds-verify` 已实现该协定，把 acceptance 注入 prompt 并解析模型判定。无环境变量时逐字节等同 legacy。
- **验证**：全部新增行为有 focused tests（loop 146 / cli 269 / agents 38），`packages/loop` 覆盖率保持 ≥ 80%（statements/lines 91.9%、functions 95.9%、branches 81.1%）；`scripts/smoke-loop.mjs` 与 built CLI dogfood 全链路通过；Python 协定测试 `python3 -m unittest discover legacy-python/deepseek/tests`（10 tests，含 fake DeepSeek API 的 subprocess e2e），并已接入 CI `Python protocol tests` 步骤。

---

## 附录 A：与 V2_REFACTOR_PLAN.md 的关系

本方案不是替代 V2_REFACTOR_PLAN.md，而是在其基础上的**垂直聚焦**：

- V2_REFACTOR_PLAN.md 覆盖完整的产品经理 Agent 能力（9 个包 + Hermes 深度集成 + PartnerOS）
- 本方案只聚焦 **Loop 层**——即 daemon 的 hot loop 从被动变主动
- V2_REFACTOR_PLAN.md 的 S4（Hermes cron）、S5（学习层）、S6（skill-registry）的部分内容被本方案的 L2-L4 前置
- 不影响 PartnerOS 模块、Approval Desk、多租户等已有交付

## 附录 B：参考阅读

- [docs/V2_REFACTOR_PLAN.md](V2_REFACTOR_PLAN.md) — 20 个 CEO 决策 + S0-S6 交付计划
- [docs/product/15_OSSTACK_5_6_PRODUCT_AND_ARCHITECTURE.md](product/15_OSSTACK_5_6_PRODUCT_AND_ARCHITECTURE.md) — osstack 与 PartnerOS 的共享内核边界
- [legacy-python/runtime/bin/osb-loop](../legacy-python/runtime/bin/osb-loop) — V1 循环的 bash 实现
- `/Users/merry/wiki/Clippings/Loop Engineering.md` — Cobus Greyling 5+1 框架
- `/Users/merry/wiki/Clippings/读懂 Loop Engineering：所有 xx engineering 其实是同一回事.md` — 卜寒兮「被动解锁」观点
- `/Users/merry/wiki/Clippings/Loop Engineering 循环工程又是什么鬼？.md` — 知乎中文综述
- `/Users/merry/wiki/Clippings/Loop Engineering 深度解析与实战指南（全网最全）-51CTO.COM.md` — 徐小夕 4 层 + 5 阶段 + 实战

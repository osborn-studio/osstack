# osstack 5.6 产品战略与技术架构

状态：Proposed  
日期：2026-07-11  
目标读者：产品负责人、架构师、Claude Code / Codex 等开发 Agent  
对应 PartnerOS 文档：`partneros-mvp-spec/20_OSSTACK_BASED_PRODUCT_AND_ARCHITECTURE.md`

## 1. 执行摘要

osstack 应定位为：

> AI 时代、公司内部使用的本地优先研发操作系统。一个负责人可以持续管理多个代码仓库和 Agent 团队，从目标进入、执行、验证、交付、复盘到知识沉淀形成闭环。

下一阶段不应继续横向增加彼此孤立的 CLI 命令。重点是把已经存在的 Loop Engineering、Agent Router、Supervisor、Evidence、Knowledge Cloud、Kanban 和 Release 能力组合成三个稳定的产品工作流：

1. `daily`：每天自动扫描 7-8 个项目，报告状态、风险、成熟度和下一步建议。
2. `start`：接受一个目标，形成可审阅的执行合同，调度 Agent 完成代码交付并生成证据。
3. `improve`：从失败、验证和人工反馈中形成低风险改进提案，经过 gate 后执行并沉淀知识。

osstack 也是 PartnerOS 的共享控制内核和内部 dogfood 环境，但二者不是同一个用户界面的两个名称。osstack 服务研发团队；PartnerOS 服务客户业务团队。可共享运行时、证据、审批和知识协议，不共享领域模型和产品入口。

## 2. 本次代码审计基线

审计基于远端 `origin/main`：

- commit：`2bf310e`，2026-07-11 获取。
- 最新发布 package：`@osstack/cli@0.9.0`、`@osstack/loop@0.9.0`、`@osstack/agents@0.9.0`。
- monorepo：16 个公开/内部 package，另有根项目与 cloud functions。
- 最新主线已经包含 Merge Orchestration Loop S1：typed cards、PR DAG、ingest、board、check、timeline、runbook、routing memory 和 retro。
- `@osstack/supervisor` 已实现 repo registry、L0-L6 成熟度、failure asset、improvement proposal、gate 和 evaluator epoch。
- Loop 已实现 EvaluationSpec、feedback-carrying iteration、budget、governance、lesson draft、proof 和 self-improvement hook。

当前代码很强的地方是底层能力已经多且有测试；当前产品问题是能力组合不足，用户仍需知道大量命令和内部概念才能完成日常工作。

### 2.1 已存在、应直接复用的能力

| 用户需求 | 已有代码基础 | 判断 |
|---|---|---|
| 多 repo 管理 | `@osstack/supervisor` repo registry / portfolio | 继续完善，不新建第二套 registry |
| 自动执行 | `@osstack/loop` + daemon + adapters | 作为唯一执行内核 |
| 代码交付 | `deliver`、worktree、verify、proof、PR | 收敛成黄金路径 |
| Repo 成熟度 | L0-L6 ladder | 升级为可解释、可行动的 maturity contract |
| 多 PR 编排 | `stack ingest/board/check/timeline/runbook/retro` | 纳入 portfolio 日报和交付流程 |
| Agent 路由 | capability / role / cost / history | 增加 policy profile 和理由输出 |
| 经验沉淀 | lesson、feedback asset、Knowledge Cloud | 合并为统一资产生命周期 |
| 安全与审计 | governance、proof pack、contracts、compliance mapping | 作为所有写操作的 gate |

### 2.2 需要诚实修复的产品事实

- README 仍显示 `0.8.1`，package 和 tag 已为 `0.9.0`。发布事实存在多源不一致。
- CLI 表面积过大，`doctor`、`deliver`、`loop`、`supervise`、`improve`、`stack` 等能力缺少一个任务导向的上层入口。
- Supervisor 是成熟度诊断器，但还不是每天自动运行的 portfolio manager。
- Knowledge、lesson、feedback asset、memory fact 的关系对用户不清晰。
- Cockpit 可以保留，但当前不应成为主要投资方向。Claude Code、Codex 和 Hermes 才是近期工作首页。
- `@osstack/supervisor` 仍为 private；其边界和稳定性等级需要明确，否则 PartnerOS 无法安全复用。

## 3. 产品战略

### 3.1 产品层级

```text
osstack Internal Product
  |
  +-- Portfolio Manager      多 repo 状态、成熟度、优先级、日报
  +-- Delivery Manager       目标 -> 计划 -> Agent -> 验证 -> PR/交付
  +-- Improvement Manager    失败 -> 资产 -> 提案 -> gate -> 改进
  +-- Knowledge Manager      经验审核、提升、同步、检索、过期治理
  |
  +-- OSStack Control Kernel
      +-- run / task / event contracts
      +-- policy and agent adapters
      +-- loop and verification
      +-- approval and risk gates
      +-- evidence and audit
      +-- knowledge asset protocol
```

对内产品可以快速演进；Control Kernel 必须采用更严格的兼容性、版本和 conformance 要求，因为 PartnerOS 将依赖它。

### 3.2 北极星体验

用户每天打开 Claude Code 或 Codex，只需要表达意图：

```text
“给我看今天所有项目”
        |
        v
portfolio scan -> daily brief -> 3 个建议动作
        |
        v
“先修 A，再把 B 的计划写清楚”
        |
        v
execution contract -> worktree -> agents -> verify -> proof -> approval
        |
        v
PR / delivery + lessons + maturity update
```

osstack 不要求用户进入一个新的大型 GUI 才能工作。Agent surface 通过稳定的 JSON/Markdown 协议调用 osstack，CLI 是可验证的底层接口，Cockpit 是观察面而不是主交互面。

### 3.3 近期目标用户

1. 第一阶段：产品负责人本人，一个人管理 7-8 个 AI 项目。
2. 第二阶段：公司内部研发同事，在统一策略和证据要求下使用不同 Agent。
3. 第三阶段：PartnerOS 团队作为第一个内部平台客户，验证共享内核的可复用性。

### 3.4 北极星指标

- Portfolio coverage：注册并有有效 verify contract 的重要 repo 比例。
- Verified delivery rate：有确定性验证和 proof 的完成任务比例。
- Human attention per delivery：每个成功交付需要的人类主动操作次数。
- Mean time to actionable brief：从 `daily` 开始到给出可执行建议的时间。
- Improvement closure rate：提案被验证完成并形成资产的比例。
- Repeat failure rate：同一 failure family 在 30 天内重复发生的比例。
- Knowledge reuse rate：执行中实际引用并帮助通过验证的知识资产比例。

## 4. 目标用户工作流

### 4.1 Daily Portfolio Control

建议产品入口：

```bash
osstack daily --portfolio default --json
osstack daily --portfolio default --apply-safe --yes
```

输出必须回答：

- 哪些 repo 正常、阻塞、漂移或长期无进展？
- 自上次 brief 以来发生了什么？
- 哪些 PR、测试、依赖或发布需要处理？
- 每个建议的价值、风险、证据和预计成本是什么？
- 今天最值得用户亲自决策的最多三件事是什么？

默认只读。`--apply-safe --yes` 只能执行 policy 明确允许的低风险动作。

### 4.2 Goal-to-Delivery

建议入口：

```bash
osstack start "目标描述" --repo <id> --json
osstack control <run-id> status|approve|revise|stop
```

`start` 在写代码前创建 Execution Contract：目标、非目标、验收标准、验证命令、预算、允许路径、禁止路径、审批点和 Agent policy。现有 `deliver` 与 `loop run` 作为底层执行器保留，避免再建一套 loop。

### 4.3 Idea Intake

新 idea 不应直接触发任意代码修改。流程应为：

```text
idea -> repo/portfolio fit -> clarification -> design artifact
     -> risk and cost -> owner approval -> execution contract -> delivery
```

建议入口 `osstack idea` 最终可以是 `start --mode discovery` 的别名，避免永久维护两个引擎。

### 4.4 Recursive Improvement

现有 `supervise` 和 `improve` 形成以下闭环：

```text
run trace -> failure taxonomy -> feedback asset -> proposal
          -> deterministic gates -> human decision -> execution -> eval
          -> lesson/knowledge promotion -> policy/maturity update
```

原则：评估器不能在一个 epoch 内偷偷变化；中高风险提案不能自动应用；低风险也必须有确定性 gate、可回滚 diff 和完整 proof。

## 5. 技术架构

### 5.1 推荐边界：共享内核，而不是共享整个产品

```text
┌──────────────────────────────────────────────────────────┐
│ Agent Surfaces: Claude Code / Codex / Hermes / CI        │
└───────────────────────┬──────────────────────────────────┘
                        │ Agent Command Protocol
┌───────────────────────v──────────────────────────────────┐
│ osstack Application Services                             │
│ portfolio | delivery | improvement | knowledge | release │
└───────────────────────┬──────────────────────────────────┘
                        │ stable use-case ports
┌───────────────────────v──────────────────────────────────┐
│ OSStack Control Kernel                                   │
│ task/run/event | loop | policy | gates | evidence        │
│ approval | knowledge assets | tenant/workspace context   │
└──────────┬──────────────┬──────────────┬──────────────────┘
           │              │              │
     Agent adapters   Git/worktree   Local DB / cloud sync
```

禁止 PartnerOS 直接 import `@osstack/cli` 或依赖 CLI 输出文本。共享能力只能通过稳定 package API、JSON Schema 或 daemon RPC 使用。

### 5.2 包边界调整

建议先审计再决定是否拆包，目标边界如下：

| 边界 | 责任 | 稳定性 |
|---|---|---|
| `@osstack/contracts` | Task、Run、Event、Evidence、Approval、PolicyDecision、KnowledgeAsset schemas | public/stable |
| `@osstack/core` | 本地持久化、policy primitives、kanban、telemetry | public/stable subset |
| `@osstack/loop` | 运行状态机、verify、budget、feedback | public/stable ports |
| `@osstack/agents` | Agent adapter contract 与官方 adapters | adapter API stable |
| `@osstack/supervisor` | portfolio、maturity、proposal、evaluator epoch | internal until conformance complete |
| `@osstack/cli` | 参数解析、展示、用户交互 | product-private |

不要为了架构图立即拆出大量新 package。先建立 import boundary tests 和公开 export 清单；只有循环依赖或发布边界真实存在时再拆。

### 5.3 Canonical State

必须明确每类状态的唯一事实源：

- SQLite：run、task、event、repo registry、proposal、approval 的机器事实源。
- Git-tracked Markdown/YAML：Execution Contract、`docs/LOOP.md`、policy profile、人工可读决策。
- Proof pack：一次交付不可变的证据快照，不作为可变运行状态。
- Knowledge Cloud：已审核知识资产的分发层，不替代本地运行数据库。
- Markdown report/cockpit：投影，可重新生成，不可反向成为事实源。

所有写操作需要 operation id 和幂等语义，避免 daemon 重试产生重复任务、重复审批或重复资产。

### 5.4 Agent Command Protocol

为 Claude Code、Codex 和 PartnerOS 暴露统一 envelope：

```json
{
  "protocol_version": "1.0",
  "command": "portfolio.daily",
  "actor": { "type": "human|agent", "id": "..." },
  "scope": { "portfolio_id": "...", "repo_id": "..." },
  "input": {},
  "policy_profile": "internal-default",
  "idempotency_key": "..."
}
```

响应至少包含 `status`、`result`、`evidence_refs`、`required_approvals`、`next_actions` 和 `error`。Markdown 只用于人读摘要，JSON 是集成合同。

### 5.5 Policy Profiles

每个 repo 必须声明：

```yaml
mode: observe | propose | execute
auto_apply: false
allowed_auto_changes: [docs, tests, lint]
requires_approval: [source, ci, dependencies, release]
forbidden: [secrets, production_config, destructive_git, database_migration]
budgets:
  max_runtime_minutes: 30
  max_iterations: 5
  max_cost_usd: 10
```

内部也不应默认完全自主。先通过真实 dogfood 数据逐步放宽 policy，而不是用产品承诺代替风险控制。

### 5.6 Knowledge Asset Lifecycle

统一目前分散的 lesson、feedback asset、memory fact 和 knowledge pack：

```text
raw observation
  -> candidate asset
  -> provenance + scope + expiry + confidence
  -> human/automatic validation
  -> promoted team/project knowledge
  -> usage trace and outcome feedback
  -> refresh, supersede, or retire
```

底层类型可以不同，但必须有一个统一索引和 provenance graph。任何知识注入都要能回答“来自哪里、何时验证、对本次决策产生了什么影响”。

## 6. osstack 与 PartnerOS 的关系

采用“平台 + 垂直产品”，不是“两个重复产品”，也不是“一个二进制换品牌”。

| 层 | osstack | PartnerOS |
|---|---|---|
| 用户 | 内部研发负责人和工程师 | 2-10 人高信任专业服务团队 |
| 核心对象 | repo、task、run、PR、release、eval | tenant、client、matter、intent、artifact、approval |
| 首页 | Claude Code / Codex / CLI | Telegram/企业 IM + Approval Desk |
| 自动化对象 | 代码和研发流程 | 客户服务和运营流程 |
| 共享 | loop、agent contract、gate、evidence、audit、knowledge protocol | 同左 |
| 不共享 | CLI 命令、repo maturity UX | 客户领域模型、行业模板、业务权限 |

osstack 先 dogfood 新内核能力；能力只有满足版本、测试、文档、迁移和安全要求后，才进入 PartnerOS 的 allowlist。

## 7. 分阶段路线图

### R0：Truth and Boundary，1 周

- 修复 README/package/release 的版本事实不一致。
- 生成 package dependency graph、public export inventory 和 CLI command inventory。
- 定义 `@osstack/contracts` 的稳定等级和兼容政策。
- 建立 PartnerOS consumption conformance test，不迁移业务代码。
- 输出 ADR：共享内核 + 两个产品面的决定。

验收：仓库、npm、GitHub Release、README 的版本状态可由一个命令生成并验证；PartnerOS 不再以复制代码作为长期方向。

### R1：Agent-Native Golden Paths，2-3 周

- 实现 `daily`、`start`、`control` 三个应用服务和 JSON 协议。
- 复用现有 deliver/loop/supervisor/stack，不复制执行逻辑。
- 为 3 个 dogfood repo 配置 policy profile 和 Execution Contract。
- 每日 brief 具备 delta、风险、证据和最多三项 owner decisions。

验收：负责人可以连续两周只通过 Claude Code/Codex 管理 3 个 repo，并获得可验证交付。

### R2：Portfolio Autopilot，3-4 周

- 扩展到 7-8 个 repo。
- 增加 scheduler、stale detection、blocked escalation 和 attention budget。
- 将 stack orchestration 纳入 portfolio 状态。
- 打通 improvement proposal 到受控执行。

验收：日报可靠，低风险自动任务不重复、不越权；每项执行有 proof 和回滚路径。

### R3：Knowledge Flywheel，2-3 周

- 统一资产索引和 provenance graph。
- 增加资产审核、过期、冲突和使用效果反馈。
- 只将验证过的内部能力加入 PartnerOS allowlist。

验收：能证明至少三个重复问题因已有资产而更快解决，且旧知识可被识别和淘汰。

### R4：Team Operating Model，后续

- 身份、角色、审批委托、团队 policy、审计导出。
- 团队级 portfolio 与责任人机制。
- 不优先建设大型 Web cockpit，除非 agent-native dogfood 表明缺少可视化是主要阻塞。

## 8. 明确非目标

- 不建设新的编码模型。
- 不复制 Claude Code 或 Codex 的聊天和编辑体验。
- 不让 LLM judge 代替确定性测试和审批。
- 不在第一阶段自动修改所有重要 repo。
- 不把所有内部 package 直接承诺为 PartnerOS public API。
- 不优先做华丽 cockpit、复杂计费或外部 marketplace。
- 不把“命令很多”当作产品成熟度。

## 9. 测试与发布要求

### 9.1 测试金字塔

- Contract：schemas、protocol version、backward compatibility、invalid fixtures。
- Unit：policy、state transition、budget、maturity、knowledge lifecycle。
- Integration：CLI/application service -> daemon -> DB -> proof。
- Adapter conformance：Claude、Codex、DeepSeek、shell 的 cancel/error/usage/event 行为。
- Portfolio fixtures：单 repo、monorepo、stacked PR、dirty worktree、offline、partial outage。
- Dogfood eval：真实 3 repo 连续两周的成功率、人工干预和重复失败。

### 9.2 PartnerOS 发布门

一个 osstack 能力进入 PartnerOS allowlist 前必须满足：

- 非 private 的稳定合同，或固定版本的内部 artifact。
- 变更日志和迁移说明。
- conformance fixture 和失败路径测试。
- tenant/context 不串线的证明。
- 可关闭、可降级、可回滚。
- 不要求 PartnerOS 解析 CLI 人类文本。

## 10. 关键架构决定

### D1：一个共享控制内核，两个产品面

决定：接受。osstack 和 PartnerOS 不合并为一个 UX，也不维护两套 loop。

理由：用户、领域对象和风险模型不同；执行、验证、证据和知识协议高度重合。

### D2：Agent-native first

决定：接受。近期 Claude Code、Codex、Hermes 是主要操作面，Cockpit 是投影和例外处理面。

### D3：Local-first，不等于 local-only

决定：接受。执行、密钥和 repo 数据默认本地；团队知识、审计和协作可通过明确 opt-in 同步到内部云。

### D4：Dogfood promotion

决定：接受。新能力先在 osstack 内部运行，达到真实数据门槛后进入 PartnerOS allowlist。

## 11. Claude 5.6 下一步任务

把本文件作为产品与架构 source of truth，先执行 review pass，不直接开始大改：

1. 拉取最新 `origin/main`，确认基线不晚于 `2bf310e`。
2. 逐条核对本文件引用的现有能力，标记 `implemented / partial / absent / stale-doc`，附文件和测试证据。
3. 对共享内核方案做 dependency/import audit，找出 PartnerOS 可安全依赖的最小 API。
4. 提出最多 3 个需要 owner 决策的问题；其余采用本文默认决定。
5. 形成 R0 和 R1 的详细 implementation plan，按可独立合并的增量拆分，每个增量包含测试、迁移、文档和回滚。
6. 不触碰当前工作区中与本任务无关的未提交 WIP。
7. 在 owner 批准 implementation plan 前，不做跨 package 重构。

第一轮推荐交付物：

- `docs/decisions/ADR-XXX-shared-control-kernel.md`
- `docs/specs/AGENT_COMMAND_PROTOCOL_V1.md`
- `docs/specs/POLICY_PROFILE_V1.md`
- `docs/superpowers/plans/YYYY-MM-DD-osstack-r0-r1.md`
- conformance fixture 设计，不必在同一 PR 完成全部实现。

## 12. 完成定义

这轮重新设计完成，不是指文档写完，而是满足：

- 一个人能通过 Agent 首页管理 7-8 个 repo。
- 新目标能转成有预算、gate 和验收标准的 Execution Contract。
- Agent 能完成低风险代码交付并提交可验证证据。
- 系统能清楚区分观察、建议和执行权限。
- 同类失败能形成资产并降低重复发生率。
- PartnerOS 复用稳定内核，不复制 osstack 实现，也不暴露内部研发复杂度给客户。


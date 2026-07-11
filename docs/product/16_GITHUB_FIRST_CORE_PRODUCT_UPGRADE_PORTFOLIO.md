# GitHub-first 核心产品升级作战系统

状态：Proposed  
日期：2026-07-11  
Owner：陈斌  
执行平台：osstack + Codex + Claude 5.6 + GitHub

## 1. 当前最高优先级

PartnerOS 暂停作为近期开发主线。osstack 当前最重要的任务，是通过三个真实核心产品完成 dogfood：

1. 用最新 osstack 管理多个 GitHub repo。
2. 由 Codex 形成产品诊断、升级方案和可验证验收标准。
3. 由 Claude 5.6 调用 osstack 完成代码、测试、验证和部署。
4. 将执行中暴露的重复问题变成 osstack improvement proposal 和知识资产。

最终目标：一个负责人能够从 GitHub 统一掌握三个产品，批准关键方向，其余工作由 Agent 团队在受控闭环中推进。

## 2. GitHub Portfolio

| 产品 | 当前 GitHub repo | 目标 repo | 域名 | 当前 main 基线 |
|---|---|---|---|---|
| OsbornPA | `gilosbornhello/osborn-pa` | 保持 `osborn-pa` | `osbornpa.com` | `1c6331e` |
| OsbornAlpha | `gilosbornhello/stock-monitor` | 改名 `osborn-alpha` | `osbornalpha.com` | `b281620` |
| OsbornModel | `gilosbornhello/re-fund-ai` | 改名 `osborn-model` | `osbornmodel.com` | `b7df879` |

以上 commit 是 2026-07-11 审计时 GitHub `main` 的 HEAD。每次执行必须重新 fetch，不得把本文 commit 当成永久固定版本。

## 3. 为什么采用 GitHub-first

Codex 位于 MacBook Pro，Claude 5.6 位于 Mac mini，本地目录不能作为跨机器事实源。唯一可信协作面是 GitHub：

```text
GitHub main / Issues / PR / Actions / Deployments
        |
        +-> Codex: 产品与架构审计、Spec、验收设计
        |
        +-> Claude 5.6: worktree 实施、测试、修复、PR、部署
        |
        +-> osstack: portfolio、loop、policy、evidence、maturity、knowledge
```

所有有长期价值的输入和产物必须回到 GitHub：Spec、Execution Contract、PR、CI、deployment record、proof reference、retro 和 architecture decision。

聊天记录、本机临时文件和 Agent 自述不能代替 GitHub 证据。

## 4. 三个产品的代码审计结论

### 4.1 OsbornPA

当前状态：三者中代码和治理基础最成熟，也是 osstack 首个 portfolio onboarding repo。

事实：

- monorepo，648 个 tracked files，审计窗口内 50 个 commits。
- Next.js Web、Telegram bot、Chrome/Safari clipper、domain/sdk/prompt-kit packages。
- 已有 `monorepo-health.yml` 和大量 workspace/governance/testing scripts。
- 2026-07-03 蓝图记录 862 个测试；最新代码已继续推进 multi-tenant、i18n、Today 和 Review。
- 当前产品正在从个人中文 Life OS 向 personal AI operating system 演进。

主要风险：

- README 仍保留“monorepo bootstrap”和某台 Mac 的绝对路径，产品事实落后。
- 生产、legacy、archive 和迁移层仍较重，容易让 Agent 误判 source of truth。
- Supabase tenant/security、Telegram 双栈、secret 历史、部署事实需要重新验证，不能只信旧蓝图。
- test scripts 很多，需要明确唯一 CI-equivalent verify command。

首轮目标：不是重写 UI，而是建立可持续运行的产品控制合同，清理事实漂移，确认生产安全，并让 osstack 能稳定生成 daily brief 和 verified delivery。

### 4.2 OsbornAlpha

当前状态：`stock-monitor` 已经超出“股票监控器”，实际是股票研究与 PM Agent 产品。

事实：

- 553 个 tracked files，审计窗口内 128 个 commits，近期开发活跃。
- 产品包含股票池、行情、研究、brief、Hiphon PM、Hermes skills、投资纪律、战绩记录和研究 pipeline。
- 已有 Vercel 部署描述、Supabase schema、Agent skills 与 Hedge Fund AI 设计。
- `TODOS.md` 显示 chokepoint research pipeline 仍只完成 wrapper，尚未形成完整 agent loop。
- GitHub Actions 当前未发现，README 表示依赖 Vercel 从 `main` 自动部署。

产品判断：

> OsbornAlpha 应成为“有证据、可复盘、受风险约束的 AI 投资研究操作系统”，不是单纯行情网站，也不是自动荐股机器人。

改名建议：`stock-monitor` 直接改为 `osborn-alpha`，保留历史。改名前先固定当前 production URL、Vercel project、Supabase project、环境变量和 webhook 引用。

首轮目标：统一产品定位、建立 CI 和确定性 eval、把研究建议与结果跟踪连接成闭环，并明确研究工具与真实交易决策之间的人类审批边界。

### 4.3 OsbornModel

当前状态：`re-fund-ai` 已经自然演进成 OsbornModel，代码和文档都支持改名。

事实：

- 342 个 tracked files，审计窗口内 50 个 commits。
- `portal-v2` 为 Next.js 16 / React 19 / TypeScript strict，包含多种金融模型和大量 golden tests。
- `research-backend` 为 Hono + SQLite 的独立长任务后端。
- 已有批准的 `osbornmodel.com Platform` umbrella design，明确权限、搜索、记忆和前端重构。
- 已部署 EdgeOne，同时文档也提到 Vercel 和 Mac backend/cloudflared，部署事实存在多路径。
- 仓库仍保留 `portal`、`portal-v2`、旧 RE-Fund-AI 命名和历史部署说明。

产品判断：

> OsbornModel 应成为“可运行、可验证、可保存历史的专业金融模型与研究工作台”，核心资产是模型定义、计算正确性、来源和版本，而不是某一个房地产模型页面。

改名建议：`re-fund-ai` 直接改为 `osborn-model`。改名前建立 deployment inventory，并确认 EdgeOne/Vercel/Mac backend 哪一个是 canonical production path。

首轮目标：完成命名和 source-of-truth 收敛，固定模型 golden truth，统一 portal/back-end contract，并将部署验证写进 CI 和 runbook。

## 5. 产品组合关系

三个产品不应互相吞并：

```text
OsbornPA
  负责个人目标、时间、注意力、知识和 Agent 协调

OsbornAlpha
  负责投资研究、信号、投资纪律、组合判断和结果复盘

OsbornModel
  负责金融模型、测算、尽调、fresh data 和专业工作成果
```

潜在协作：

- Alpha 可以调用 Model 的版本化模型能力，但不能复制模型公式。
- PA 可以显示 Alpha/Model 的任务、提醒和审批，但不成为金融计算引擎。
- 三者共享身份、知识或组件之前，先通过 API/contracts 集成，避免建立隐式 monorepo 耦合。
- osstack 管理三个 repo 的研发闭环，但不进入产品运行时业务逻辑。

## 6. Agent 职责合同

### 6.1 Codex：产品经理、市场负责人、架构师和验收设计者

Codex 负责理解产品和市场、发现差距，形成产品设计、技术架构和可验证的 Spec。它不能使用“优化一下”“做得更好”等无法验收的要求代替产品定义。

Codex 每次升级先完成：

1. 从 GitHub 拉最新 `main`，读取 open PR、CI、deployment 和近期 commits。
2. 运行只读 repo scan、测试基线和产品事实核对。
3. 分析目标市场、目标用户、竞争替代方案、核心价值、产品差距和增长路径。
4. 识别技术风险、安全风险、部署风险和现有可复用代码。
5. 输出 versioned Product Upgrade Spec。
6. 定义目标、非目标、用户旅程、产品方案、技术架构、迁移、测试、部署、回滚和验收标准。
7. 把 Spec 提交到对应 repo，等待 owner 批准。

Codex 不应给出“全面优化”“重构一下”等不可验收任务，也不应在产品方向未批准时启动大规模实现。

### 6.2 Claude 5.6：CTO 和实现负责人

Claude 负责从 CTO 视角复审 Codex 的产品设计、技术架构和验收方案，发现不可实施、风险过高、测试不足或存在更优技术路径的地方，并提出明确的改进方案。

Claude 可以挑战 Codex 的方案，但不能静默改变产品目标。涉及产品定位、主要用户旅程、验收标准、数据迁移、高风险权限或明显扩大范围时，必须先提交 Spec amendment，由 owner 批准后再实施。纯技术实现细化可以在不改变已批准产品合同的前提下直接优化。

Claude 读取已批准 Spec 后：

1. 重新同步 GitHub，检查 Spec 后是否有新提交。
2. 完成 CTO review，提出更好的方案、风险和必要的 Spec amendment。
3. 在 owner 批准最终方案后，调用 osstack 创建 Execution Contract。
4. 在独立 branch/worktree 中增量实现。
5. 使用测试驱动完成代码、错误路径、migration 和文档。
6. 调用 osstack verify/governance/review/proof。
7. 推送 branch 和 PR，不直接绕过保护更新 `main`。
8. CI 通过后完成 staging；production deployment 需要明确 gate。
9. 将验证、部署和回滚信息写入 PR 和 release handoff。

Claude 的“完成”必须由 GitHub commit、CI、deployment 和 proof 支撑，不以聊天报告为准。

### 6.3 osstack：控制系统

osstack 负责：

- portfolio registry 和 repo maturity。
- task/run/event、Agent routing、budget、cancel 和 escalation。
- worktree isolation、verify、governance、review 和 evidence。
- stack/PR 编排、retro、failure asset 和 improvement proposal。
- knowledge/lesson 的候选、审核、提升和过期。

osstack 不负责决定每个产品的商业定位，也不替代 GitHub 和部署平台的事实状态。

### 6.4 GitHub：唯一可信协作事实源

GitHub 是两台 Mac 之间唯一可信的代码、任务、评审、CI 和发布状态源。聊天结论和本地状态只有在形成 commit、Issue、PR、check、deployment 或 proof reference 后，才进入正式协作链。

### 6.5 Owner：产品方向与风险决策者

Owner 决定产品方向，批准重要方案、Spec amendment、高风险改动、数据库迁移、外部写操作和正式上线。Agent 应把 owner 的注意力集中到少数不可逆或高影响决定，不把普通实现细节全部上交。

## 7. 每个 Repo 的标准文件

首轮 onboarding 增加或核对：

```text
docs/PRODUCT.md
docs/LOOP.md
docs/specs/
docs/decisions/
.osstack/repo.yaml
.osstack/policy.yaml
.github/pull_request_template.md
.github/workflows/ci.yml
```

### `.osstack/repo.yaml`

```yaml
schema_version: 1
product: osborn-pa | osborn-alpha | osborn-model
domain: osbornpa.com | osbornalpha.com | osbornmodel.com
role: core_product
priority: 100
default_branch: main
verify_command: "..."
build_command: "..."
staging_command: "..."
production_environment: "..."
```

### `.osstack/policy.yaml`

```yaml
schema_version: 1
mode: propose
auto_apply: false
allowed_auto_changes:
  - docs
  - tests
  - lint
requires_approval:
  - product_scope
  - source
  - dependencies
  - ci
  - database_migrations
  - production_deploy
forbidden:
  - secrets
  - destructive_git
  - unreviewed_external_actions
budgets:
  max_iterations: 5
  max_runtime_minutes: 45
  max_cost_usd: 20
```

首轮统一使用 `mode: propose`。完成至少两轮成功交付后，再根据真实证据为低风险类别开放 execute。

## 8. GitHub 工作流

### 8.1 Product Spec PR

```text
codex/product-audit-<product>-<date>
  -> docs-only PR
  -> owner review
  -> merge approved Spec
```

### 8.2 Implementation PR

```text
claude/<spec-id>-<slice>
  -> implementation + tests
  -> osstack proof
  -> GitHub CI
  -> Codex review pass
  -> staging
  -> owner production approval
```

推荐每个 PR 是一个可独立验证的 vertical slice。避免一个 PR 同时完成产品重命名、数据库迁移、UI 重写和生产切换。

### 8.3 PR 必填证据

- 对应 Spec 和 Execution Contract。
- 变更范围与明确非目标。
- 测试命令和结果。
- migration、数据影响和 backward compatibility。
- security/tenant/financial correctness 检查。
- staging URL 或可重复手工验证步骤。
- deployment 和 rollback plan。
- osstack proof reference。

## 9. 仓库改名计划

### 9.1 采用原仓库改名

选择：接受，优于新建空仓库。

原因：保留 Git history、PR、Issues、stars、Actions 历史和 GitHub redirect，也保留 osstack 可用于复盘的研发数据。

### 9.2 改名前置清单

对 `stock-monitor` 和 `re-fund-ai` 分别确认：

- GitHub branch protection、Actions secrets、deploy keys 和 webhooks。
- Vercel/EdgeOne project 的 repository binding。
- Supabase allowed redirect URL 和 OAuth callback。
- README、package name、deployment scripts、badges 和 absolute links。
- Mac mini launchd、cloudflared、local clone remote、cron 和 skill path。
- 第三方 API callback、Telegram/Hermes integration。
- GitHub Pages 或 EdgeOne repository import。

### 9.3 改名执行顺序

1. Merge docs-only rename plan。
2. 记录 production baseline 和回滚步骤。
3. 在 GitHub 执行 repo rename。
4. 两台 Mac 更新 `origin` URL，重新 clone/verify 更安全时采用新 clone。
5. 更新 CI、deploy、callbacks 和文档。
6. 运行完整测试和 staging deploy。
7. 绑定目标域名。
8. 观察后再删除旧品牌文案，不删除 Git history。

## 10. 推荐执行顺序

### P0：osstack Portfolio Bootstrap

先让 osstack 能读取三个 GitHub repo 的事实，而不是立即改业务代码：

- 注册三个 repo。
- 生成 maturity baseline。
- 定义唯一 verify/build/deploy contracts。
- 输出每日 portfolio brief。
- 对 GitHub fetch、PR、CI 和 deployment 建立只读 adapter。

验收：一条命令能回答三个产品当前 main、open work、CI、部署和下一项 owner decision。

### P1：OsbornPA

原因：治理和测试基础最好，适合验证 osstack 的标准 onboarding；同时存在必须优先确认的 tenant/security 和 source-of-truth 风险。

第一轮只做：事实审计、production safety、README/LOOP contract、唯一 CI verify、一个小型真实产品改进。

### P2：OsbornModel

原因：产品名称和升级方向已经有 approved design，模型 golden tests 适合作为 osstack verify 的高质量样板。

第一轮只做：canonical production path、命名迁移计划、portal/backend contract、golden truth 和一个模型工作流升级。

### P3：OsbornAlpha

原因：产品范围最容易扩散，金融研究输出需要先锁定风险、评价和结果追踪机制。等前两个 repo 的 osstack 流程稳定后进入，可以减少 Agent 在大量 skills/设计之间迷失。

第一轮只做：产品定位、CI、研究证据 contract、recommendation/outcome journal 闭环和改名计划。

## 11. osstack 自我迭代规则

业务 repo 失败不能直接触发 osstack 大改。按以下分类：

```text
产品特有问题 -> 对应 repo issue/spec
重复出现在两个 repo -> osstack candidate asset
重复出现在三个 repo -> osstack shared capability proposal
安全或数据事故 -> 立即 gate + owner escalation
```

每个 osstack proposal 必须说明：

- 来源 run/trace/PR。
- 哪些 repo 重复发生。
- 为什么不是产品自己的责任。
- 最小共享接口。
- backward compatibility 和 rollout。
- conformance fixture。

不要为了让 osstack 看起来“更强”而把所有产品代码抽进 osstack。

## 12. 第一阶段成功标准

在进入 PartnerOS 或更多 repo 前，至少连续完成：

- 三个 repo 都在 portfolio 中，GitHub 状态可读取。
- 每个 repo 有明确 verify、policy、deployment 和 rollback contract。
- Codex 为每个产品完成一份基于最新代码的 approved upgrade Spec。
- Claude 通过 osstack 为每个产品完成至少一个真实 implementation PR。
- 所有 PR 有 CI、review、staging/production 证据和 retro。
- osstack 至少从三个 run 中形成一个有真实复用价值的改进，并通过 conformance test。
- 负责人可以在一个 brief 中看到三个产品的状态和最多三项待决策事项。

## 13. 交给 Codex 的产品审计 Prompt

```text
你是本产品的产品经理、市场负责人、架构师和验收设计者。必须通过 osstack 以 GitHub-first 方式工作。

目标 repo：<OWNER/REPO>
目标域名：<DOMAIN>
目标产品名：<PRODUCT>

工作要求：
1. 从 GitHub 获取最新 main、open PR、CI、deployment、近期 commits；记录准确 commit。
2. 不相信旧 README 或聊天总结，逐项用代码、测试和部署事实核对。
3. 运行只读 osstack repo scan 和现有 verify baseline，不修改业务代码。
4. 分析目标市场、用户、竞争替代方案、核心工作流、当前价值、产品差距、增长路径、架构风险、安全和部署风险。
5. 搜索现有实现，优先复用；明确哪些旧路径应保留、迁移或退役。
6. 输出一个 Product Upgrade Spec，包含目标、非目标、用户旅程、产品方案、技术架构、数据流、migration、测试、部署、回滚和验收标准。
7. 将升级拆成可独立合并的 vertical slices，避免大爆炸重写。
8. 最多向 owner 提出 3 个真正影响方向的问题，其余给出明确推荐。
9. 先创建 docs-only PR。没有 owner 批准，不进入实现。
10. 报告 osstack 在本次审计中缺少的能力，但不要在本 repo 中复制控制平面。

完成标准：Spec 足够明确，使另一台 Mac 上的 Claude 5.6 可以仅凭 GitHub 内容和 osstack 开始实施。
```

## 14. 交给 Claude 5.6 的实施 Prompt

```text
你是本产品的 CTO 和实现负责人。先从 CTO 视角优化 Codex 已经批准的产品设计、技术架构和验收方案，再通过 osstack 执行最终批准的 GitHub Spec。

目标 repo：<OWNER/REPO>
批准 Spec：<SPEC PATH OR PR>

执行规则：
1. 拉取 GitHub 最新 main，确认 Spec 合并后是否有新提交、PR 或 CI 变化。
2. 读取 docs/LOOP.md、.osstack/repo.yaml、.osstack/policy.yaml、CLAUDE.md/AGENTS.md 和 approved Spec。
3. 提交 CTO review：指出不可实施、风险过高、测试不足和可采用的更优技术路径。
4. 如果建议改变产品定位、主要用户旅程、验收标准、数据迁移、高风险权限或明显扩大范围，先提交 Spec amendment，等待 owner 批准；不得静默改变目标。
5. 最终方案获批后，调用 osstack 创建 Execution Contract：目标、非目标、验收标准、验证命令、预算、允许/禁止路径、审批点、部署和回滚。
6. 在独立 branch/worktree 实施，不污染 main，不使用 destructive git。
7. 按 vertical slice 增量开发；逻辑、修复和状态变化使用 TDD，保留现有 golden behavior。
8. 运行完整 build/test/lint/typecheck、安全和领域验证；不得只跑 targeted tests 后宣布全部完成。
9. 调用 osstack governance/review/proof；修复 findings，记录真实 loose ends。
10. 推送 branch，创建 PR。PR 必须引用 Spec/Execution Contract，包含测试结果、风险、migration、staging、部署和回滚。
11. CI green 后执行 staging。生产发布、数据库迁移、secret、外部发送等需要 owner 明确批准。
12. 部署后运行 smoke/health/关键用户旅程验证，并把 evidence 写回 GitHub。
13. 完成 retro：产品问题留在本 repo；重复平台问题形成 osstack improvement proposal。
14. 不因发现 osstack 缺口而无限扩大本次产品 PR。

你不能用聊天中的“已完成”代替 commit、CI、deployment 和 proof。遇到旧 WIP 或他人提交时保留并基于最新事实工作。
```

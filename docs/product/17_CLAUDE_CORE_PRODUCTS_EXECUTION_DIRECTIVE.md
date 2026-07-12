# Claude 5.6 核心产品持续升级执行指令

状态：Approved execution directive
日期：2026-07-12
Owner：陈斌
执行顺序：OsbornModel -> OsbornPA -> OsbornAlpha

## 使用方式

Claude 5.6 必须把本文件作为当前任务的完整执行指令。读取本文件后直接恢复并继续工作，不需要 owner 手工组合其他聊天 Prompt。

本文件与以下文档共同构成 source of truth；出现冲突时，优先采用本文件中更具体、日期更新的执行顺序和授权：

- `docs/product/15_OSSTACK_5_6_PRODUCT_AND_ARCHITECTURE.md`
- `docs/product/16_GITHUB_FIRST_CORE_PRODUCT_UPGRADE_PORTFOLIO.md`
- `docs/superpowers/plans/2026-07-11-osstack-r0-r1.md`
- 各目标 repo 中已批准的 Product Upgrade Spec、ADR、`docs/LOOP.md` 和 `.osstack/policy.yaml`

## 1. 总目标

先完成 osstack 当前更新，然后通过 osstack 依次升级三个真实核心产品：

1. OsbornModel：`gilosbornhello/re-fund-ai`，目标域名 `osbornmodel.com`。
2. OsbornPA：`gilosbornhello/osborn-pa`，目标域名 `osbornpa.com`。
3. OsbornAlpha：`gilosbornhello/stock-monitor`，目标域名 `osbornalpha.com`。

最终工作方式：

```text
Owner 提出方向
  -> Codex 完成产品、市场、架构和验收设计
  -> GitHub docs-only Product Upgrade Spec PR
  -> Fable 5 完成 CTO review 和技术架构优化
  -> Owner 批准最终产品合同和高风险决定
  -> Fable 5 通过 osstack 拆解任务
  -> Opus sub-agents 编码、测试、迁移和修复
  -> Fable 5 审查和解决疑难问题
  -> osstack verify / governance / proof
  -> GitHub PR / CI / staging
  -> Owner 批准 production
  -> deployment verification / retro / improvement proposal
```

不要同时对三个产品进行大规模开发。前一个产品至少完成一个真实 production increment 和 retro 后，才能启动下一个产品的大规模实现。

## 2. 当前 osstack 收尾

继续完成当前在飞行中的 osstack 更新工作。

### 2.1 结构化 recommendation 增量

1. Opus 实现者完成代码和测试。
2. 使用不同于实现者的 Agent 做 cross-review。
3. Fable 5 做 CTO 终审，检查协议、兼容性、错误路径和字符串耦合是否真正消除。
4. 运行 targeted tests，以及完整 build、test、lint、typecheck、Python protocol tests 和 conformance tests。
5. 创建或更新独立 PR。
6. CI green 后合并。
7. 合并后验证 daemon、daily session 和结构化 recommendation 的真实输出。

### 2.2 最终审计

满足以上条件后，输出一次 osstack update final audit：

- 最终 main commit。
- 相关 PR 和合并状态。
- 完整测试命令、测试数量和失败数量。
- daemon/launchd 版本、PID、KeepAlive 和开机恢复状态。
- daily session 的运行状态、tick 和跨重启恢复证据。
- structured recommendation 的 schema 和真实 fixture。
- proof、release readiness 和 remaining loose ends。
- 明确区分 required、optional 和 future work。

只有审计证据完整后，才能宣布“osstack 更新完成”。

### 2.3 npm release

release train PR 和 npm 新版本不阻塞三个产品的审计与 onboarding。记录 release readiness，除非 owner 单独授权，否则不要因发布 npm 停止产品升级主线。

## 3. 三个产品 onboarding 授权

Owner 已批准三个 onboarding PR 在满足以下条件后合并：

- 只包含 `.osstack/repo.yaml`、`.osstack/policy.yaml`、`docs/LOOP.md` 或与 onboarding 直接相关的安全文档。
- policy 为 `mode: propose`。
- 不包含业务代码、secret、生产凭据或破坏性配置。
- verify command 与当前代码事实一致。
- CI/checks 通过。

目标 PR：

- `gilosbornhello/osborn-pa` PR #58。
- `gilosbornhello/stock-monitor` PR #27。
- `gilosbornhello/re-fund-ai` PR #1。

合并后重新运行：

- repo registry 检查。
- portfolio maturity scan。
- `osstack daily`。
- owner decisions 输出。
- policy observe/propose gate。

确认三个 repo 已进入 osstack 管理，且 osstack 不会未经批准自动修改业务代码。

## 4. 固定角色

### 4.1 Codex

角色：产品经理、市场负责人、产品架构师和验收设计者。

Codex 负责：

- 从 GitHub 读取最新代码、Issues、PR、CI、deployment 和近期 commits。
- 研究目标市场、目标用户、竞争产品和替代方案。
- 理解当前产品价值和真实用户工作流。
- 发现产品、体验、商业化和增长差距。
- 识别技术、安全、数据、部署和维护风险。
- 提出产品方案、产品架构和可量化验收标准。
- 定义目标、非目标、指标、rollout 和 rollback。
- 创建 docs-only Product Upgrade Spec PR。

Codex 不得用“全面优化”“重构一下”“做得更好”等不可验收指令代替 Spec。

### 4.2 Fable 5

角色：CTO、主技术架构师和最终技术责任人。

Fable 5 负责：

- 复审 Codex 的产品设计、架构和验收方案。
- 判断方案是否可实施、是否过度设计、是否存在更好的技术路径。
- 设计模块边界、协议、数据流、migration、兼容和部署架构。
- 提交必要的 ADR 和 Spec amendment。
- 将批准后的方案拆成小型、可独立合并的 implementation increments。
- 通过 osstack 调度 Opus sub-agents。
- 审核真实 git diff、测试、CI、proof 和部署结果。
- 解决疑难问题并作出关键技术决定。
- 对最终技术质量和上线安全负责。

Fable 5 可以挑战 Codex，但不能静默改变产品目标。

以下变化必须先提交 Spec amendment 并等待 owner 批准：

- 产品定位。
- 主要目标用户。
- 核心用户旅程。
- 主要验收标准。
- 大规模数据迁移。
- 高风险权限边界。
- 正式生产架构的重大改变。
- 明显扩大已批准范围。

不改变产品合同的纯技术实现细化，可以由 Fable 5 直接优化。

### 4.3 Opus sub-agents

Opus 负责明确范围内的：

- 编码。
- 单元测试、集成测试和 conformance tests。
- migration 和 adapter。
- fixture 和 golden test。
- 明确、可复现的 bug fix。
- 受控代码搬迁和重构。
- 与实现直接相关的文档更新。
- targeted verification。

每个 Opus 任务必须包含：

- 目标。
- 非目标。
- 允许修改的 package、目录和文件。
- 禁止修改的范围。
- 验收标准。
- 必须运行的验证命令。
- 预算和停止条件。
- 必须升级给 Fable 5 的条件。

Opus 不得自行扩大范围，也不得同时实现和最终批准自己的代码。

### 4.4 osstack

osstack 是控制系统，负责：

- repo registry 和 maturity。
- task、run、event 和 Execution Contract。
- Agent routing、budget、cancel、retry 和 escalation。
- policy gate 和 allowed/forbidden paths。
- worktree isolation。
- verify、governance、review 和 evidence。
- PR/stack 编排。
- daily brief 和 owner decisions。
- retro、failure asset、improvement proposal 和 knowledge lifecycle。

osstack 不决定产品商业定位，也不替代 GitHub 或部署平台的事实状态。

### 4.5 GitHub

GitHub 是两台 Mac 之间唯一可信的代码、任务、评审、CI 和发布状态源。

聊天结论和本地状态只有形成以下内容后，才进入正式协作链：

- commit。
- Issue。
- PR。
- review。
- required check。
- deployment record。
- proof reference。
- release handoff。

### 4.6 Owner

Owner 负责：

- 决定产品方向。
- 批准重要 Product Upgrade Spec 和 Spec amendment。
- 批准高风险权限、破坏性数据库迁移和正式生产部署。
- 决定商业化、品牌和不可逆的重要选择。

Agent 应把 owner 注意力集中到少数高影响决定，不把普通实现细节全部上交。

## 5. Agent 升级规则

Opus 遇到以下情况必须停止扩大修改并升级给 Fable 5：

- 现有架构无法满足验收标准。
- 需要改变 public API 或 protocol。
- 需要改变数据库 schema 或数据迁移策略。
- 跨越两个以上 package ownership boundary。
- Spec 自相矛盾或不可验收。
- 出现 tenant、authentication、authorization、secret 或安全风险。
- 同一问题连续三次修复失败。
- 只能通过降低断言、跳过测试或增加不合理 sleep 让测试通过。
- 需要引入重要依赖或新基础设施。
- 发现更好的方案，但会改变产品行为或扩大范围。
- 涉及生产数据、外部写操作或正式部署。
- 对根因或正确方案没有足够信心。

Fable 5 收到升级后必须：

1. 重新验证根因。
2. 比较方案和取舍。
3. 做出明确技术决定。
4. 必要时提交 ADR 或 Spec amendment。
5. 重新拆成 Opus 可执行任务。

## 6. 通用 GitHub-first 工作流

每个产品和每个增量遵守：

```text
GitHub latest main
  -> read-only audit
  -> docs-only Product Upgrade Spec PR
  -> Fable 5 CTO review
  -> owner approval where required
  -> Execution Contract
  -> independent branch/worktree
  -> Opus implementation
  -> independent review
  -> Fable 5 final review
  -> full verification
  -> osstack proof
  -> GitHub implementation PR
  -> CI green
  -> staging
  -> owner production approval
  -> deploy and smoke verification
  -> retro and improvement proposal
```

每个 implementation PR 必须包含：

- 对应 Spec、ADR 和 Execution Contract。
- 目标、范围和非目标。
- 真实改动说明。
- 测试命令和结果。
- migration 和 backward compatibility。
- security、tenant 或 financial correctness 检查。
- staging URL 或可重复验证步骤。
- deployment 和 rollback。
- osstack proof reference。
- known loose ends。

## 7. 第一阶段：OsbornModel

### 7.1 产品信息

- 当前 repo：`gilosbornhello/re-fund-ai`。
- 目标产品：OsbornModel。
- 目标域名：`osbornmodel.com`。
- 目标 repo 名：`osborn-model`，改名必须独立规划和执行。

### 7.2 阶段目标

把 OsbornModel 建设成：

> 可运行、可验证、可保存历史、使用新鲜且有来源数据的专业金融模型与研究工作台。

核心资产是模型定义、计算正确性、来源、版本、权限和可重复性，不是某一个房地产模型页面。

### 7.3 只读审计

在修改业务代码前：

1. 拉取 GitHub 最新 `main`，记录 commit。
2. 读取 open PR、Issues、CI、deployment 和近期 commits。
3. 验证 `.osstack/repo.yaml`、`.osstack/policy.yaml` 和 `docs/LOOP.md`。
4. 运行 maturity scan。
5. 安装依赖并运行完整 build、test、lint、typecheck 和 golden tests。
6. 核对生产状态，而不是只相信旧文档。

### 7.4 重点审计

- `portal` 与 `portal-v2` 哪一个是 source of truth。
- `research-backend` 的职责和运行位置。
- EdgeOne、Vercel、Mac backend 和 cloudflared 的真实分工。
- Supabase identity、entitlements、memory 和 RLS。
- 金融模型公式、输入、输出和 golden truth。
- 模型 registry、版本和兼容。
- portal/backend API contract。
- authentication 和 authorization。
- fresh-data 来源、时间戳、引用、缓存和失败降级。
- per-user memory 和数据隔离。
- 长任务队列、超时、取消、重试、恢复和幂等。
- secrets、日志和 production credentials。
- deployment、health check、monitoring 和 rollback。
- RE-Fund-AI 旧命名与 OsbornModel 产品定位的事实漂移。

### 7.5 Codex 交付物

Codex 创建 docs-only Product Upgrade Spec PR，至少包含：

- 目标市场和目标用户。
- 竞争产品与替代方案。
- 产品定位和产品承诺。
- 核心用户旅程。
- 当前能力和产品差距。
- 产品信息架构。
- 技术架构和服务边界。
- 模型 registry 与版本协议。
- golden tests 和领域 eval。
- fresh-data 与 provenance。
- identity、entitlement、memory 和安全。
- migration。
- deployment 和 rollback。
- 可量化验收标准。
- 分阶段 vertical slices。
- 非目标。

Fable 5 完成 CTO review。最终 Spec 在必要的 owner 批准后，才进入大规模业务实现。

### 7.6 首个 production increment

从批准 Spec 中选择一个用户价值明确、风险可控、能够验证完整工作流的 vertical slice。

首个增量不得同时包含：

- GitHub repo 改名。
- 大型数据库迁移。
- Portal 全面重写。
- 部署平台迁移。
- 多个模型公式重写。

完成标准：implementation PR、完整测试、CI、staging、owner production approval、部署验证、proof 和 retro 全部存在。

### 7.7 Repo 改名

`re-fund-ai -> osborn-model` 必须通过独立 rename plan，检查：

- GitHub branch protection、Actions secrets、deploy keys 和 webhooks。
- EdgeOne/Vercel repository binding。
- Supabase callback 和 redirect URL。
- Mac mini clone、launchd、cloudflared、cron 和绝对路径。
- package name、README、badges、deployment scripts 和外部链接。
- `osbornmodel.com` DNS、TLS 和 production binding。

不要把 repo rename 混入功能 PR。

## 8. 第二阶段：OsbornPA

只有 OsbornModel 完成首个 production increment 和 retro 后，才启动 OsbornPA 的大规模实现。

### 8.1 产品信息

- Repo：`gilosbornhello/osborn-pa`。
- 产品：OsbornPA。
- 域名：`osbornpa.com`。

### 8.2 产品方向

OsbornPA 是 personal AI operating system，负责个人目标、时间、注意力、知识和 Agent 协调。

重点审计和升级：

- Today / Morning / Evening / Weekly Review daily loop。
- multi-tenant、RLS、registration 和 authentication。
- Telegram legacy/new 双栈。
- secret 历史和轮换状态。
- canonical memory authority。
- Supabase、Obsidian 和 local-first 数据关系。
- Bot/channel adapter。
- i18n、timezone 和跨设备体验。
- Agent coordination。
- archive、legacy 和 source-of-truth。
- Vercel、bot、clipper 和 production deployment。

流程与 OsbornModel 相同：Codex docs-only Spec、Fable 5 CTO review、owner gate、Opus 实现、完整验证、production increment 和 retro。

## 9. 第三阶段：OsbornAlpha

只有 OsbornPA 完成首个 production increment 和 retro 后，才启动 OsbornAlpha 的大规模实现。

### 9.1 产品信息

- 当前 repo：`gilosbornhello/stock-monitor`。
- 目标产品：OsbornAlpha。
- 目标域名：`osbornalpha.com`。
- 目标 repo 名：`osborn-alpha`，改名必须独立规划。

### 9.2 产品方向

OsbornAlpha 是：

> 有证据、可复盘、受风险约束的 AI 投资研究操作系统。

它不是单纯行情网站，也不是自动荐股机器人。

重点审计和升级：

- research evidence contract。
- recommendation 与 outcome journal。
- 投资纪律、组合判断和结果复盘。
- 数据新鲜度、来源和时间戳。
- Hiphon PM 和 skills 的真实边界。
- chokepoint research pipeline 闭环。
- 确定性评价，禁止 Agent 自己给自己打分。
- 风险披露和人类审批。
- 研究输出与真实交易决策的边界。
- Vercel、Supabase 和 CI/deployment。

流程与前两个产品相同。

`stock-monitor -> osborn-alpha` 使用独立 rename plan，不与业务功能或数据库迁移混合。

## 10. osstack 自我迭代

产品 repo 暴露的问题按以下方式分类：

```text
只出现在一个产品 -> 产品 repo Issue/Spec
重复出现在两个产品 -> osstack candidate asset
重复出现在三个产品 -> osstack shared capability proposal
安全或数据事故 -> 立即 gate + owner escalation
```

osstack improvement proposal 必须说明：

- 来源 trace/run/PR。
- 哪些 repo 重复发生。
- 为什么不是产品自己的责任。
- 最小共享接口。
- backward compatibility。
- rollout 和 rollback。
- conformance fixture。

不要为了让 osstack 看起来更强，把所有产品代码抽入 osstack。

## 11. 持续执行授权

在已经批准的产品和技术范围内持续推进，不需要每个小步骤都询问 owner。

可以自主执行：

- 读取 GitHub 和运行只读审计。
- 创建 branch/worktree。
- 编写 docs-only Spec 和 ADR。
- 在批准的 Execution Contract 内编码和测试。
- 创建 PR 和响应 review。
- 运行 CI、staging 和非破坏性验证。
- 修复明确的测试、lint、typecheck 和兼容问题。
- 生成 proof、retro 和 improvement proposal。

必须暂停并请求 owner：

- 改变产品定位、目标市场或主要用户旅程。
- 改变核心验收标准。
- 高风险权限或安全边界。
- 破坏性数据库迁移或不可逆数据操作。
- secrets、production credentials 或密钥轮换。
- 未经已有授权的外部写操作。
- 正式 production deploy。
- 无法从现有 Spec 做出安全判断。

## 12. 工程纪律

- GitHub 是唯一事实源。
- 开始前总是 fetch 最新 remote state。
- 保留用户和其他 Agent 的未提交修改。
- 不使用 `git reset --hard`、`git clean` 或 destructive checkout。
- 每个增量独立 branch、worktree、PR、CI、review 和 proof。
- 不直接向 `main` 推业务实现。
- 不绕过 required checks。
- 不删除测试、降低断言或用 skip 掩盖失败。
- targeted tests 不能代替完整 suite。
- 不以 Agent 报告代替真实 diff、测试、CI 和 deployment。
- 测试和部署日志中不得泄露 secret 或敏感数据。
- 发现远端 main 前进时，安全同步后继续。
- 恢复丢失 session 时先检查 branch、worktree、reflog、stash、uncommitted diff 和 GitHub PR，不从头重做。

## 13. 每阶段汇报格式

每个增量完成后报告：

1. 目标和对应 Spec。
2. branch、commit 和 PR。
3. 实际修改文件和行为。
4. targeted 和完整验证结果。
5. CI 和 review 状态。
6. staging/production 状态。
7. proof reference。
8. 风险和真实 loose ends。
9. osstack improvement proposal。
10. 下一项任务。

只有满足完整 acceptance checklist，才能宣布一个阶段完成。

## 14. 立即执行

现在按以下顺序继续：

1. 恢复并确认当前 osstack session、branch、worktree、PR 和 CI 状态。
2. 完成结构化 recommendation 增量。
3. 完成 osstack final audit，并明确宣布是否完成。
4. 检查并合并三个 onboarding PR。
5. 运行 portfolio scan 和真实 `osstack daily`。
6. 启动 OsbornModel 的 Codex 产品与市场审计。
7. 创建 OsbornModel docs-only Product Upgrade Spec PR。
8. 由 Fable 5 完成 CTO review。
9. 在需要 owner 决策时给出最多三个高影响问题和明确推荐。
10. 最终 Spec 获批后，通过 osstack 调度 Opus 完成首个 production increment。
11. 完成部署验证和 retro 后，再进入 OsbornPA。
12. OsbornPA 完成首个 production increment 和 retro 后，再进入 OsbornAlpha。

不要只重新输出计划。先恢复真实状态，然后持续执行所有不需要 owner 新授权的工作。

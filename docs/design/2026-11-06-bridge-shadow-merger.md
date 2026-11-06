# App E 影子合并者：设计与实现附录

日期：2026-11-06。基线：`main` `cafadc19`（含 #376 4-A 迁移 51；阶段 3 已合并：App A 发布，App B 发 `osstack/verify`）。
上位文档：[ADR-006](../decisions/ADR-006-bridge-s0-decisions.md) 决定 2、决定 3、决定 5，探针 P-1–P-12，风险 4；[ADR-005](../decisions/ADR-005-bridge-identity-registry.md) 检查生产者表；[双循环接通设计 v3](2026-11-01-osstack-grok-bridge.md)（下称“设计”）§A、§8.1–§8.2；[实施方案](../plans/2026-11-02-osstack-grok-bridge-implementation.md)（下称“方案”）第一部分 §4、阶段 3；[阶段 4 影子对账器附录](2026-11-05-bridge-shadow-reconciler.md)（下称“4 附录”）。

ADR-006 的“Consequences”新增任务“App E shadow merger（设计与实现）”，排在阶段 3 之后。本文是这项任务的实现附录，结构与 4 附录相同，开工前做独立审计（§9）。

## 1. 范围

ADR-006 决定 2：自动化只能合并 Mission PR，只能在严格门槛下合并，而且要先经过影子期。本附录**只做影子期**：

| 做 | 不做 |
|---|---|
| 每个周期从账本出发，在实时 PR 上逐条评估决定 2 的门槛（§3） | 铸造 App E 令牌、读取 App E 私钥 |
| 把“会做的合并”（含会传给 merge API 的 `sha`）或拒绝原因落到只追加表（§4） | 调用任何 merge、review、comment、check、push、`PUT`/`POST`/`PATCH`/`DELETE` |
| PR 合并或关闭后，记录真实结果并与影子决定对照（§4.3） | 改变任何 Mission、链、预留、意图的状态 |
| 负向测试（§6） | 决定是否启用真实合并（需要单独的设计章节与后续 ADR，ADR-006 决定 2 “Shadow first”） |

在影子期里，Mission PR 仍按今天普通 PR 的方式合并（ADR-006 决定 2 最后一句）。影子合并者的输出只是证据，不影响任何人或 bot 的合并。

## 2. PR 拆分

每个 PR 目标 `main`，一个 PR 一件事，按序合并。

| PR | 内容 | 依赖 |
|---|---|---|
| M-0 | 本附录（含审计结果） | — |
| M-A | 迁移 52（§4.1）、`engineering-merger-shadow-store.ts`、纯函数 `evaluateMergeGates()`（§3.3）及单元/属性测试，覆盖 §6 全部负向用例的纯函数层 | 4-A（已合并） |
| M-B | 合并读取器 `contained-mission-merger-reader.ts`（§5.1）、`merger.json` 登记表（§5.2）、合成原始页测试 | M-A、**4-C（PR #377，未合并）** |
| M-C | 影子合并者服务 `contained-mission-merger-shadow.ts`、开关 `OSSTACK_MERGER=shadow`、账本联接视图（§5.3）、结果对照与 `osstack mission merger report --json`（§4.3）、负向集成测试 | M-A、M-B、**4-D**（复用只读 Mission 视图与隔离测试装配） |
| M-D | 沙箱场景脚本与录制语料（§5.4） | M-C；需 §8 决定 5 |

依赖说明：

- **4-C（#377）**：M-B 复用其 `ghGraphqlTransport`、`assertQueryOnly`、分页与上限、`identitySchema`/`sameProducer`、“正文在规范化后丢弃”的两层结构。#377 合并前 M-B 不开工；如果 #377 在评审中改了这些导出，M-B 跟着改，不复制一份。
- **4-D**：4 附录 §5.3 规定对账器只拿只读 Mission 视图（`listPrOpened()`、`publication()`）。M-C 在同一个视图上加一个只读方法 `deliveryEvidence(missionId)`（§5.3），并复用 4-D 的负向集成测试装配（令牌源、store 写方法、runner、`mutation` 计数）。4-D 未合并时 M-C 不开工，避免出现两个视图。
- 4-B（TLA）与本任务无关。

## 3. 门槛

### 3.1 记号与原则

- **账本**：`engineering_contained_missions` 行（`candidate_head`、`spec_digest`、`state`）与 `engineering_contained_events` 的 `delivery_evidence` 事件（`contained-mission-runner.ts` L455–466：`mission_id`、`spec_digest`、`repository`、`branch`、`base`、`base_head`、`start_commit`、`head`、`pr`、`evidence_digest`）。权威来源只有账本；PR 正文、标记、check 摘要都是展示副本（`contained-mission-marker.ts` L1–4、`contained-mission-bridge.ts` L187）。
- **登记表** `merger.json`（§5.2）：所有身份按数字 id 匹配，不看 login（ADR-005）。
- **实时**：每条门槛都读自本周期对 GitHub 的读取（ADR-006 决定 2 “Each gate is read from the live PR at evaluation time”），不使用上个周期、4-D 链表或 bot 的结论。
- **结果三类**：`would_merge`（全部门槛成立）、`refused`（至少一条门槛不成立）、`unevaluated`（读不完整、GitHub 尚未算出可合并性、两次读取之间有变化；不是拒绝，也不是放行）。对照时 `unevaluated` 不算作“影子拒绝”（§4.3）。
- **失败码**：`<门槛号>.<码>`，例如 `G2.head_mismatch`。一次评估收集**全部**失败码（不短路），排序后写入记录，便于对照时看出“差几条”。读取类问题只有 `unevaluated` 的码（§3.4）。

### 3.2 门槛表

| # | 门槛（ADR-006 原文出处） | 检查 | 数据来源（字段） | 必须的生产者 | 与实时 head/base 的绑定 | 失败码 |
|---|---|---|---|---|---|---|
| G0 | Mission PR 身份：账本联接，不用标记 | 从账本出发：`state='pr_opened'` 的 Mission，其 `delivery_evidence.repository` 等于登记表 `repository`，`pr.number = N`。恰好一个 Mission 对应（仓库，N） | 账本 | — | — | 不进入评估（非 Mission PR 永远不会被枚举）；同一（仓库，N）有两个 Mission：`G0.join_ambiguous` |
| G1 | 发布证据（决定 2 第 1 条） | `publication().kind === 'opened'`；`null`、`evidence_missing`、`opened_before_cancel` 拒绝。按 `contained-mission-runner.ts` L50–51 的 `canonical()` 重算 `delivery_evidence` 去掉 `evidence_digest` 后的 sha256，必须等于记录的 `evidence_digest`，也等于 `pr_opened` 事件里的 `evidence_digest` | 账本（`contained-mission-host.ts` L91–121） | — | 历史证据，不绑定实时状态 | `G1.not_opened:<kind>`、`G1.evidence_digest_mismatch` |
| G2a | 绑定：仓库、PR、分支、base ref（决定 2 第 2 条） | 实时 PR 的 `number = evidence.pr.number`；`baseRepository.nameWithOwner = headRepository.nameWithOwner = evidence.repository`（大小写不敏感），`isCrossRepository = false`；`headRefName = evidence.branch`，且匹配 `^osstack/mission/…$`（`contained-mission-host.ts` L35）；`baseRefName = evidence.base = 登记表 base_ref`（今天为 `main`）：发布允许任意非空 `publication.base`（`contained-mission-runner.ts` L74–76），而 G4–G6 只读登记目标分支的规则，所以目标分支不是登记分支的 Mission 一律拒绝 | GraphQL `pullRequest{number baseRepository{nameWithOwner} headRepository{nameWithOwner} isCrossRepository headRefName baseRefName}` | — | `baseRefName` 改过即失败（retarget 攻击） | `G2.pr_mismatch`、`G2.repository_mismatch`、`G2.cross_repository`、`G2.branch_mismatch`、`G2.base_ref_mismatch`、`G2.base_not_registered` |
| G2b | 作者 = App A | `author` 为 `Bot`，`databaseId` 等于登记表 `publisher.actor_id`（App A 的 bot 用户 id，不是 App id 5620012，§5.2） | GraphQL `author{__typename ... on Bot{databaseId}}` | App A（bot 用户 id） | — | `G2.author_not_publisher` |
| G2c | head 五方相等 | 实时 `headRefOid` 同时等于：`publication.pushed_commit`、Mission 行 `candidate_head`、`evidence.head`、标记 `head`、G3 所选 check 的 `head_sha` | GraphQL `headRefOid`；账本；PR `body` 解析出的标记 | — | 本门槛就是 head 绑定 | `G2.head_mismatch:<哪一方>` |
| G2d | 标记与账本一致 | `parseMissionMarkers(body)` 恰好一个合法标记；`id = mission_id`，`spec_digest`、`start` 等于账本 `spec_digest`、`start_commit`；正文第一行的 Mission id 与标记 `id` 一致（设计 A.1、A.4） | GraphQL `body`（解析后立即丢弃，不入库） | — | 标记 `head` 并入 G2c | `G2.marker_missing`、`G2.marker_mismatch:<字段>`、`G2.first_line_mismatch` |
| G3 | Mission 证据检查（决定 2 第 3 条） | 在实时 head 上列出名为 `osstack/verify` 的全部 check run，只保留 `app.id = 5620053`（App B）、`external_id = <mission_id>:<head>`、`head_sha = head` 的；取 `id` 最小的一条（阶段 3 规则，`contained-mission-bridge.ts` L191–206）；它必须 `status=completed`、`conclusion=success` | REST `GET repos/{r}/commits/{head}/check-suites?app_id=5620053&per_page=100`（App B 在一个 head 上的 suite），再对每个 suite `GET repos/{r}/check-suites/{id}/check-runs?check_name=osstack%2Fverify&filter=all&per_page=100`：`id app.id external_id head_sha status conclusion`。不用 `commits/{head}/check-runs`：GitHub 文档说明该端点只覆盖该引用最近的 1 000 个 check suite，翻完页也不能证明最小 id 就是真实最小（阶段 3 `contained-mission-bridge.ts` L191–206 的查找有同样的限制，另行跟进）。suite 数或任一页超过上限 → `U.read_incomplete:G3` | App B，按 `app.id` | URL 里的 head 即实时 head；`external_id` 再绑定 Mission 与 head | `G3.missing`、`G3.not_success:<conclusion>`、`G3.wrong_producer_only`（同名 check 只来自其他 App） |
| G4 | 必需检查（决定 2 第 4 条） | ① **必需集合**：读登记目标分支 `base_ref` 上生效的规则与旧式分支保护，得到（context，integration id）集合，必须**等于**登记表 `required_checks`（ADR-005 生产者表：5 个名称，均为 15368）；多、少、integration id 不同或某条规则不带 integration id 都失败。每一条必需检查都必须来自登记的 `main_quality_ruleset_id`（G6e 已证明它没有 bypass）；来自其他 ruleset 或旧式保护的必需检查，即使集合相等，也可能被某个 bypass 名单绕过，一律失败（`.github/rulesets/main-quality.json` L24–38 把五个检查放在无 bypass 的 ruleset 里，这里要求它保持如此）。② **每一条**：实时 head 上该名称、该 `app.id` 的 check run 中 `id` 最大的一条（最近一次运行）为 `completed`+`success`；`skipped`/`neutral` 不算（比 GitHub 严，§8 决定 2）。③ 旧式保护里只有 `contexts`（commit status，没有 App 绑定）的必需项一律失败 | REST `GET repos/{r}/rules/branches/<base_ref>`（`type=required_status_checks` 的 `required_status_checks[].{context,integration_id}`、`ruleset_id`）；REST `GET repos/{r}/branches/<base_ref>/protection`（`required_status_checks.checks[].{context,app_id}`、`contexts`，需 admin，主机凭证；返回 404 或 “Branch not protected” 表示没有旧式保护，按空集合处理，与 `delivery.ts` L573–577 相同；其他非零退出——含 403——是 `U.read_failed`）；与 G3 相同按 suite 枚举：`commits/{head}/check-suites?app_id=<登记的生产者>`，再按 suite 列 check run | 登记的生产者（今天 GitHub Actions 15368；S6 后加 App C 的 `grok/verify-osstack`） | URL 里的 head | `G4.required_set_drift`、`G4.checks_bypassable`、`G4.unbound_status_context`、`G4.missing:<context>`、`G4.not_success:<context>:<conclusion>`、`G4.wrong_producer:<context>` |
| G4b | 工作流文件未被 PR 改动（本附录新增，ADR 未列） | PR 改动的文件中没有 `.github/workflows/`、`.github/actions/` 前缀（与 `packages/autonomy/src/risk.ts` L72 同一前缀）。理由：生产者 15368 是“任何 GitHub Actions 工作流”，`pull_request` 事件运行的是 PR head 上的工作流文件，PR 自己可以改出一个以 `check` 为名、结论 `success` 的 check run；`app.id` 绑定挡不住这种伪造 | GraphQL `files(first:100){pageInfo nodes{path}}`（分页，≤30 页） | — | `files` 是实时 head 相对 base 的差异 | `G4.workflow_paths_changed` |
| G5 | base（决定 2 第 5 条） | `evidence.base_head` 非空，且**等于实时 base 分支的 tip**。tip 取自 `pullRequest.baseRef.target.oid`，并与 `repository.ref(qualifiedName:"refs/heads/<base>").target.oid` 交叉核对；`baseRefOid` 不作依据（它是 PR 记录的 base 提交，不保证随 base 分支移动而更新） | GraphQL `baseRef{target{oid}}`、`repository.ref(...)` | — | 本门槛就是 base 绑定 | `G5.base_head_missing`、`G5.base_moved`、`G5.base_tip_inconsistent` |
| G6a | 计入的批准（决定 2 第 6 条、P-5、风险 4） | 存在一条 review：作者 `__typename='User'` 且 `databaseId` ∈ 登记表 `counted_approvers`（今天只有 269190136 `gilosbornhello`）；`state='APPROVED'`；`commit.oid = 实时 head`；`authorCanPushToRepository = true`；并且它是该作者**最近一条**状态型 review（之后没有该作者的 `CHANGES_REQUESTED` 或 `DISMISSED`）。作者是 `Bot`（任何 App，含 App D 与测试评审 App）的批准不计入；登记表拒绝 `app_id` 非空的 `counted_approvers` 条目 | GraphQL `reviews{databaseId state submittedAt commit{oid} authorCanPushToRepository author{__typename ... on User{databaseId} ... on Bot{databaseId}}}`（分页） | `gilosbornhello`（User 269190136） | `commit.oid = head` | `G6.no_counted_approval`、`G6.approval_by_app`（只有 Bot 批准）、`G6.approval_stale_head`、`G6.approval_superseded` |
| G6b | 批准在最后一次推送之后 | GitHub 不提供普通推送的时间或推送者（4 附录 §4.2 第 3 条），所以不从时间线推断，而是证明“发布后没有推送”：① 分支 `rules/branches/<branch>` 的规则恰好来自登记的两个 Mission ruleset（`mission-writers`：creation/update 只允许 App A；`mission-history`：non_fast_forward、deletion，无 bypass），判定方式与 `delivery.ts` L251–262 `missionRulesOnly` 相同，且四种类型都在。`rules/branches` 不返回 `bypass_actors`，`missionRulesOnly` 也不看 bypass，所以另读每个登记 ruleset 的完整配置（`GET repos/{r}/rulesets/{id}`，主机 admin 凭证）：`enforcement='active'`；`conditions` 覆盖 `refs/heads/osstack/mission/**`；`mission-writers` 的规则恰为 creation、update，`bypass_actors` 恰为一条 `{actor_type:'Integration', actor_id:5620012}`；`mission-history` 的 `bypass_actors` 为空数组。响应里没有 `bypass_actors` 字段（权限不足时 GitHub 会省略）按无法证明处理，不当作空列表；② 时间线上没有 `HEAD_REF_FORCE_PUSHED_EVENT`；③ G2c 成立（head 仍是 App A 发布时推送的提交）。三者成立时，App A 的发布推送就是最后一次推送；PR 在推送之后才创建，所以 head 上的任何 review 都在最后一次推送之后。任一条不成立则无法证明 | REST `GET repos/{r}/rules/branches/<branch>`、`GET repos/{r}/rulesets/{id}`；GraphQL `timelineItems(itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT])` | — | ③ 即 head 绑定 | `G6.last_push_unprovable:rulesets`、`G6.last_push_unprovable:bypass`、`G6.force_push_observed` |
| G6c | 没有未解决的会话 | `reviewThreads` 全部 `isResolved = true`（含 outdated 线程；GitHub 的 `required_review_thread_resolution` 也计入 outdated） | GraphQL `reviewThreads{id isResolved}`（分页） | 任何人 | — | `G6.unresolved_threads` |
| G6d | 没有仍有效的“要求修改” | 对**每个**作者（User 或 Bot，不限登记），按 `submittedAt` 取其最近一条 `APPROVED`/`CHANGES_REQUESTED`/`DISMISSED`，结果为 `CHANGES_REQUESTED` 即失败（`COMMENTED`、`PENDING` 不改变状态） | 同 G6a | 任何人 | 不限 head：旧 head 上的要求修改，只要没被 dismiss 或被同一作者之后的批准取代，仍算有效 | `G6.changes_requested` |
| G6e | 平台规则仍在 | `rules/branches/<base_ref>` 中有来自登记 ruleset `main_quality_ruleset_id` 的 `pull_request` 规则，且 `required_approving_review_count ≥ 1`、`require_last_push_approval`、`required_review_thread_resolution`、`dismiss_stale_reviews_on_push` 均为真；再读该 ruleset 完整配置，`enforcement='active'`、`bypass_actors` 字段存在且为空数组（字段缺失按失败处理）。作用与局限见本表后的说明 | REST `GET repos/{r}/rules/branches/<base_ref>`、`GET repos/{r}/rulesets/{id}` | — | — | `G6.platform_rules_missing`、`G6.platform_rules_bypass` |
| G8 | App E 在合并名单上（ADR-006 决定 5 `main-update`） | 读登记的 `main_update_ruleset_id` 完整配置：`enforcement='active'`，`conditions` 覆盖 `base_ref`，规则含 `update`，`bypass_actors` 含 `{actor_type:'Integration', actor_id:5620091, bypass_mode:'pull_request'}`（`.github/rulesets/main-update.json` L12–15）；App A（5620012）不在名单上。不铸造 App E 令牌：这是用主机 admin 凭证读配置，证明“按规则 App E 可以合并”，不证明 App E 的令牌当下可用 | REST `GET repos/{r}/rulesets/{id}` | — | — | `G8.merger_not_allowed`、`G8.publisher_allowed`、`G8.ruleset_unverifiable` |
| G7 | PR 开放且可合并；head 前置条件（决定 2 第 7 条） | `state='OPEN'`、`isDraft=false`、`mergeable='MERGEABLE'`、`mergeStateStatus='CLEAN'`、`reviewDecision='APPROVED'`（后三项是 GitHub 的交叉核对，不替代 G4–G6）。记录中写下会传给 merge API 的请求：`{ sha: <实时 head>, merge_method: 'squash' }`（与 `delivery.ts` 的 `--squash --match-head-commit` 一致） | GraphQL `state isDraft mergeable mergeStateStatus reviewDecision` | — | `sha` 即实时 head | `G7.not_open`、`G7.draft`、`G7.conflicting`、`G7.merge_state:<值>`、`G7.review_decision:<值>`；`mergeable='UNKNOWN'` → `unevaluated`（`U.mergeability_unknown`） |

说明：

- **G0 是枚举方式，不是一条检查**。影子合并者只从账本枚举 PR，所以没有 Mission 的 PR 永远不会被评估，复制了标记的 PR 也一样（它的号不在账本里）。纯函数层仍然对“快照的 PR 号与证据不符”给出 `G2.pr_mismatch`/`G2.repository_mismatch`，供 §6 的负向测试直接调用。
- **G5 的严格程度**：`base_head` 是 PR 打开后用 `git ls-remote` 读到的 base tip（`contained-mission-ports.ts` L209–212），不是候选验证所基于的 `start_commit`。所以 G5 的实际含义是“发布以来 `main` 没有动过”。`main` 每合并一个别的 PR，这个 Mission PR 就永远过不了 G5，需要新的 Mission 产生新证据（ADR-006 原文）。记录同时写 `start_is_base = (start_commit = base_head)`，是否把它也作为门槛见 §8 决定 1。
- **G6e 管不到什么**：合并时 GitHub 会重查必需检查、批准数、会话解决、最后推送批准，但 `main-quality` 的 `strict_required_status_checks_policy` 为 `false`（`.github/rulesets/main-quality.json` L27），GitHub **不**要求 base 与 `base_head` 相等（G5）；批准数规则也**不**要求批准者是 `gilosbornhello`（G6a），自动化账号的批准同样满足它。所以评估与合并之间 base 移动、或所有者批准被 dismiss 而换成自动化批准，平台都不会挡。G6e 只是“平台重查的那部分仍然存在”的证据，不关闭这两个窗口；它们作为残余风险留给后续 ADR（§8 决定 7）。
- **G4 不复用 `delivery.ts` 的 `assertUniqueCurrentRequiredChecks`**（L720–729）：那里只按名称匹配，不绑定 App id。
- **G6a 与风险 4**：登记表的 `counted_approvers` 只有 `gilosbornhello`。自动化账号（`gilberthello` 等）的批准在 GitHub 上也计入，但不满足 G6a；它们的 `CHANGES_REQUESTED` 仍由 G6d 计入。

### 3.3 纯函数

`packages/core/src/bridge/merge-gates.ts`（新，无 I/O）：

```ts
export function evaluateMergeGates(input: {
  evidence: MissionMergeEvidence;   // 账本：mission 行 + delivery_evidence + publication + pr_opened 摘要
  snapshot: MergeSnapshot;          // §5.1 的规范化结果，不含正文
  second: MergeSecondRead;          // §3.4 的二次读取
  registry: MergerRegistry;         // §5.2
}): MergeVerdict;
// MergeVerdict = { verdict: 'would_merge', request: { sha, merge_method: 'squash' }, gates }
//              | { verdict: 'refused', codes: string[], gates }
//              | { verdict: 'unevaluated', codes: string[] }
```

`gates` 是每条门槛观察到的值（id、oid、状态、计数、check run id、review id），不含正文、login、URL，用于对照与复查。

### 3.4 读取顺序与 TOCTOU

一个周期内对一个 PR 的读取按以下顺序，第 2–4 步都以第 1 步读到的 head `H` 为 URL 参数：

1. GraphQL 主读取（§5.1）：PR 字段、reviews、reviewThreads、timeline、files、`baseRef.target.oid`、`body`；得到 `H`、`B`。
2. REST：`H` 上的 check runs（G3、G4）。
3. REST：`rules/branches/<base_ref>`、`branches/<base_ref>/protection`、`rules/branches/<branch>`、登记 ruleset 的 `rulesets/{id}`。
4. **二次读取**（只在第 1–3 步的结果会得到 `would_merge` 时做）：把第 1–3 步**完整重做一遍**（GraphQL 主读取含 `body`、REST check runs、规则与 ruleset 配置），规范化成第二个 `MergeSnapshot`，要求它与第一个逐字段相等（只排除读取时间）。只重读部分字段不够：标记被改、`baseRefName` 被 retarget 到同一提交的另一分支、作者或 draft 状态变化都会漏掉。任何字段不同 → `unevaluated`（`U.snapshot_moved:<字段>`）。代价是每个 `would_merge` 多一倍请求，计入同一请求上限。
5. 落库（§4）。

- 第 1 步与第 2 步之间 head 若变化：第 2 步读的是旧 head 的 check，第 4 步的 `headRefOid` 会不同，本周期作废。
- 第 4 步与第 5 步之间仍有窗口。影子记录只是证据，下个周期会看到变化；真实合并时 `sha` 前置条件挡住 head 变化，check、批准数、线程的变化由平台在合并时重查，但 base 移动与批准者身份平台不查（§3.2 G6e 说明）。ADR-006 “Residual race” 已说明重读不是原子保证；本附录不声称关闭它。
- 对照（§4.3）需要知道影子是在“同一状态”下判断的：每条记录写 `gates.second_read = true` 与两次读取的时间。

失败或不完整的读取一律 `unevaluated`：`U.read_failed:<码>`（传输错误、`errors` 字段、JSON 不合 schema）、`U.read_incomplete:<连接>`（超过页数或请求上限，沿用 4-C 的 `DEFAULT_READ_LIMITS`，另给 `files` 30 页）、`U.mergeability_unknown`、`U.snapshot_moved:<项>`。

## 4. 影子记录

### 4.1 存储选择：迁移 52 新表，不复用迁移 51

不复用 `engineering_shadow_decisions`（迁移 51），理由：

1. 它的主键是 `chain_id`，触发器要求所属链 `mode='shadow'`。合并评估不依附于修订链：4-D 在第一次 head 或 base 变化后就停止影子链（4 附录 §4.2 第 3 条），而合并者在链停止后仍要观察 PR 直到合并或关闭，以便记录真实结果。依附链会让合并者依赖 `OSSTACK_BRIDGE=shadow` 是否开启。
2. `action` 是 `CHECK(action IN ('would_reserve','would_mark_ready','would_stop'))`。SQLite 改 CHECK 要重建表，而迁移 51 的表带触发器且刚上线，为一个新动作重建它的风险大于新建一张表。
3. 去重方式不同：链决定按（链，head，动作）只记一次；合并决定要保留同一（PR，head）上判断的**变化序列**（§4.1 去重），对照需要知道合并前最后一次观察的结论。

也不写 `engineering_revision_chain_events`、`engineering_contained_events`：前者属于链，后者是 Mission 账本，影子合并者不写 Mission 账本（与 4 附录 §1 相同）。

新文件 `packages/core/src/state/engineering-merger-shadow-ddl.ts`；`migrations.ts` 追加 `{ id: 52, name: "engineering_merger_shadow", sql: ENGINEERING_MERGER_SHADOW_DDL }`。升级测试里写死的版本号按 `git grep` 从 51 改为 52。只新增表。

```sql
-- 每个 PR 一行的观察栅栏（§4.1 并发）。不是只追加表：两个计数器只增不减，禁止删除
CREATE TABLE engineering_merger_shadow_watermarks (
  repository TEXT NOT NULL, pr_number INTEGER NOT NULL CHECK(pr_number>0),
  issued_seq INTEGER NOT NULL CHECK(issued_seq>=0),    -- 已发出的最大观察号（读取开始前分配）
  accepted_seq INTEGER NOT NULL CHECK(accepted_seq>=0), -- 已接受的最大观察号（落库时推进）
  updated_at INTEGER NOT NULL,                          -- 本机时间，只用于报告
  PRIMARY KEY(repository,pr_number),
  CHECK(accepted_seq<=issued_seq)
);
CREATE TRIGGER engineering_merger_watermark_monotonic BEFORE UPDATE ON engineering_merger_shadow_watermarks
WHEN NEW.repository IS NOT OLD.repository OR NEW.pr_number IS NOT OLD.pr_number
  OR NEW.issued_seq < OLD.issued_seq OR NEW.accepted_seq < OLD.accepted_seq
BEGIN SELECT RAISE(ABORT,'merger_watermark_regressed'); END;
-- 落库的观察号必须大于已接受的观察号：晚到的旧观察被拒，无论它的结论会不会被去重
CREATE TRIGGER engineering_merger_watermark_stale BEFORE UPDATE OF accepted_seq ON engineering_merger_shadow_watermarks
WHEN NEW.accepted_seq <= OLD.accepted_seq
BEGIN SELECT RAISE(ABORT,'merger_stale_observation'); END;
CREATE TRIGGER engineering_merger_watermark_no_delete BEFORE DELETE ON engineering_merger_shadow_watermarks
BEGIN SELECT RAISE(ABORT,'merger_shadow_immutable'); END;
-- 新行只能是第一次取号的形状 (1,0)。注意：`INSERT OR REPLACE` 的隐式删除不触发 DELETE 触发器（recursive_triggers 关闭时），
-- 这条触发器也挡不住用 (1,0) 覆盖已有行，所以“禁止 REPLACE”是写入者约束，见 §4.1
CREATE TRIGGER engineering_merger_watermark_insert BEFORE INSERT ON engineering_merger_shadow_watermarks
WHEN NEW.issued_seq IS NOT 1 OR NEW.accepted_seq IS NOT 0
BEGIN SELECT RAISE(ABORT,'merger_watermark_insert'); END;

CREATE TABLE engineering_merger_shadow_decisions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  repository TEXT NOT NULL, pr_number INTEGER NOT NULL CHECK(pr_number>0),
  mission_id TEXT NOT NULL REFERENCES engineering_contained_missions(mission_id),
  observation_seq INTEGER NOT NULL CHECK(observation_seq>0), -- 栅栏号；排序依据
  head_sha TEXT NOT NULL CHECK(length(head_sha) IN (40,64)),
  base_sha TEXT,                 -- 实时 base tip；读不到时为 NULL（只可能出现在 unevaluated）
  verdict TEXT NOT NULL CHECK(verdict IN ('would_merge','refused','unevaluated')),
  codes_json TEXT NOT NULL CHECK(json_valid(codes_json) AND length(codes_json)<=4096),
  codes_digest TEXT NOT NULL CHECK(length(codes_digest)=64), -- sha256(codes_json)；would_merge 时为 sha256('[]')
  gates_json TEXT NOT NULL CHECK(json_valid(gates_json) AND length(gates_json)<=16384),
  merge_request_json TEXT,       -- would_merge：{"sha":…,"merge_method":"squash"}
  evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64),
  observed_at INTEGER NOT NULL, created_at INTEGER NOT NULL, -- 本机时间，只用于报告，不用于排序
  CHECK(json_type(codes_json) IS 'array'),
  CHECK((verdict='would_merge') = (merge_request_json IS NOT NULL)),
  -- 每个可能为 NULL 的操作数都用 IS / IS NOT NULL / COALESCE 包住：SQLite 把结果为 NULL 的 CHECK 当作通过
  CHECK(verdict<>'would_merge' OR COALESCE(json_array_length(codes_json)=0
    AND base_sha IS NOT NULL AND length(base_sha) IN (40,64)
    AND json_valid(merge_request_json)
    AND json_extract(merge_request_json,'$.sha') IS head_sha
    AND json_extract(merge_request_json,'$.merge_method') IS 'squash', 0)),
  CHECK(verdict='would_merge' OR COALESCE(json_array_length(codes_json)>0, 0)),
  CHECK(verdict='unevaluated' OR base_sha IS NOT NULL),
  CHECK(base_sha IS NULL OR length(base_sha) IN (40,64))
);
CREATE UNIQUE INDEX engineering_merger_decisions_obs ON engineering_merger_shadow_decisions(repository,pr_number,observation_seq);
-- 决定只能由刚推进栅栏的那次观察写入（同一事务中先推进 accepted_seq，再插入）
CREATE TRIGGER engineering_merger_decision_fenced BEFORE INSERT ON engineering_merger_shadow_decisions
WHEN NEW.observation_seq IS NOT (SELECT accepted_seq FROM engineering_merger_shadow_watermarks
                                 WHERE repository=NEW.repository AND pr_number=NEW.pr_number)
BEGIN SELECT RAISE(ABORT,'merger_unfenced_decision'); END;
-- 合并是终点：PR 已有 merged 片段后不再接受决定（“合并前的决定”= observation_seq 小于 merged 片段的观察号）
CREATE TRIGGER engineering_merger_decision_after_merge BEFORE INSERT ON engineering_merger_shadow_decisions
WHEN EXISTS (SELECT 1 FROM engineering_merger_shadow_outcomes
             WHERE repository=NEW.repository AND pr_number=NEW.pr_number AND outcome='merged')
BEGIN SELECT RAISE(ABORT,'merger_pr_merged'); END;
-- 去重：与同一 PR 的上一条记录 head、verdict、codes_digest 都相同时，静默丢弃（栅栏已推进，不受影响）。
-- 条件里重复栅栏检查：SQLite 同类触发器的执行顺序不由文档保证，未持栅栏号的重复行必须落到上面的 ABORT，
-- 而不是被这里的 IGNORE 吞掉
CREATE TRIGGER engineering_merger_decision_dedupe BEFORE INSERT ON engineering_merger_shadow_decisions
WHEN NEW.observation_seq IS (SELECT accepted_seq FROM engineering_merger_shadow_watermarks
                             WHERE repository=NEW.repository AND pr_number=NEW.pr_number)
 AND NOT EXISTS (SELECT 1 FROM engineering_merger_shadow_outcomes
                 WHERE repository=NEW.repository AND pr_number=NEW.pr_number AND outcome='merged')
 AND EXISTS (SELECT 1 FROM engineering_merger_shadow_decisions d
  WHERE d.seq=(SELECT MAX(seq) FROM engineering_merger_shadow_decisions
               WHERE repository=NEW.repository AND pr_number=NEW.pr_number)
    AND d.head_sha=NEW.head_sha AND d.verdict=NEW.verdict AND d.codes_digest=NEW.codes_digest)
BEGIN SELECT RAISE(IGNORE); END;
-- 只追加：BEFORE UPDATE / BEFORE DELETE 触发器 RAISE(ABORT,'merger_shadow_immutable')

-- 每个周期一行：证明“这段时间影子在看”，对照用来判断合并前是否有过近期观察
CREATE TABLE engineering_merger_shadow_cycles (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL,
  prs_json TEXT NOT NULL CHECK(json_valid(prs_json) AND length(prs_json)<=4096) -- 本周期评估过的 [repository, pr, observation_seq, head, verdict] 列表
);
-- 只追加，同上

CREATE TABLE engineering_merger_shadow_outcomes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  repository TEXT NOT NULL, pr_number INTEGER NOT NULL CHECK(pr_number>0),
  mission_id TEXT NOT NULL REFERENCES engineering_contained_missions(mission_id),
  observation_seq INTEGER NOT NULL CHECK(observation_seq>0), -- 与决定共用同一个栅栏
  outcome TEXT NOT NULL CHECK(outcome IN ('merged','closed_unmerged','reopened','observation_expired')),
  head_at_close TEXT NOT NULL CHECK(length(head_at_close) IN (40,64)), -- 合并/关闭时 PR 的 headRefOid
  merged_at TEXT, merge_commit TEXT,
  merged_by_actor_id INTEGER, merged_by_type TEXT CHECK(merged_by_type IS NULL OR merged_by_type IN ('User','Bot')),
  owner_approved_head INTEGER CHECK(owner_approved_head IS NULL OR owner_approved_head IN (0,1)),  -- NULL：本仓库的批准不作为检查证据（§5.2 inspection_evidence=false）
  facts_json TEXT NOT NULL CHECK(json_valid(facts_json) AND length(facts_json)<=8192),
  observed_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  CHECK((outcome='merged') IS (merged_at IS NOT NULL AND merge_commit IS NOT NULL AND length(merge_commit) IN (40,64)
    AND merged_by_actor_id IS NOT NULL AND merged_by_type IS NOT NULL)),
  CHECK(outcome='merged' OR (merged_at IS NULL AND merge_commit IS NULL AND merged_by_actor_id IS NULL AND merged_by_type IS NULL))
);
-- 片段转换：（无）→ closed_unmerged|merged；closed_unmerged → reopened|merged|observation_expired；
-- reopened → closed_unmerged|merged；merged、observation_expired 是终点
-- closed_unmerged → merged 是“两次每小时轮询之间被重开并合并”：观察到的 MERGED 由 GitHub 的 mergedAt 证明，
-- 写入时 facts_json 记 reopen_unobserved=true，不重建中间的 reopened 片段
CREATE TRIGGER engineering_merger_outcome_transition BEFORE INSERT ON engineering_merger_shadow_outcomes
WHEN NOT (
  COALESCE((SELECT outcome FROM engineering_merger_shadow_outcomes
            WHERE repository=NEW.repository AND pr_number=NEW.pr_number ORDER BY seq DESC LIMIT 1), '')
  || '>' || NEW.outcome IN ('>closed_unmerged','>merged','closed_unmerged>reopened','closed_unmerged>merged',
    'closed_unmerged>observation_expired','reopened>closed_unmerged','reopened>merged'))
BEGIN SELECT RAISE(ABORT,'merger_outcome_transition'); END;
-- 结果片段也要过栅栏：晚到的旧 CLOSED 观察不能覆盖较新的 reopened
CREATE TRIGGER engineering_merger_outcome_fenced BEFORE INSERT ON engineering_merger_shadow_outcomes
WHEN NEW.observation_seq IS NOT (SELECT accepted_seq FROM engineering_merger_shadow_watermarks
                                 WHERE repository=NEW.repository AND pr_number=NEW.pr_number)
BEGIN SELECT RAISE(ABORT,'merger_unfenced_outcome'); END;
CREATE UNIQUE INDEX engineering_merger_outcomes_obs ON engineering_merger_shadow_outcomes(repository,pr_number,observation_seq);
-- 只追加，同上
```

- **去重**：同一 PR 在 5 分钟一轮的扫描里会被评估很多次。去重触发器只丢弃与该 PR **上一条**记录（含 head）完全相同的结论，所以表里是该 PR 结论的变化序列：`refused(A) → would_merge → refused(A)` 三条都在；head 来回变化（A→B→A）时三条也都在，最后一条总是最新观察。
- **并发与过期观察（观察栅栏）**：写入事务（`BEGIN IMMEDIATE`）只串行化写，不串行化之前的 GitHub 读取；进程内锁也管不到另一个进程。所以栅栏放在数据库里，按 PR 一行（`engineering_merger_shadow_watermarks`），只用数据库发出的整数，不用本机时间：
  1. 读取开始前，一个短事务：`INSERT INTO … VALUES(…,1,0,…) ON CONFLICT DO UPDATE SET issued_seq = issued_seq + 1 … RETURNING issued_seq`，**提交成功后**才把 `n` 交给调用方（`RETURNING` 不是提交；回滚的取号会被重新发出）。取号后崩溃只留下一个空号，后面的号照常可用。
  2. 读 GitHub、评估（§3.4）。读到 `MERGED`/`CLOSED`/重开时，本次观察的产物是结果片段而不是决定。
  3. 落库事务：先 `UPDATE … SET accepted_seq = n`——`n ≤ accepted_seq` 时触发器报 `merger_stale_observation`；再插入决定行或结果片段（都带 `observation_seq = n`，触发器要求它等于 `accepted_seq`）；决定行可能被去重静默丢弃，但栅栏已经推进。**`RAISE(ABORT)` 只撤销出错的那条语句，不回滚事务**：写入者在任一语句出错时必须显式 `ROLLBACK`，否则已推进的栅栏会随后续 `COMMIT` 留下。
  
  数据库保证的是：已接受的观察号只增不减；每一行决定或片段带的是当前已接受的最大号；同一观察号最多一行决定、一行片段（唯一索引）；PR 合并后不再接受决定。数据库**不**保证“这个号是在本事务里刚推进的”：一次被去重的观察之后，持同一号的另一条不同决定仍能写入。这一条与“不使用 `REPLACE`”一样，是写入者约束：`MergerShadowWriter` 是唯一写入路径，四条 SQL 语句固定；它的测试扫描写入者源码，出现 `REPLACE`、`OR REPLACE` 或其他 `ON CONFLICT DO UPDATE` 即失败（`INSERT OR REPLACE` 在 `recursive_triggers` 关闭时不触发 DELETE 触发器，可以把栅栏重置为 (1,0)，同样能绕过另几张表的只追加触发器）。
  
  于是 `refused@1`、`refused@3`（被去重）之后，晚到的 `would_merge@2` 在第 3 步被拒。时钟回拨或多机时钟偏差不影响顺序；`observed_at` 只用于报告与 `mergedAt` 的对照。决定按 `observation_seq` 排序，对照（§4.3）里“合并前”也按观察号判断，不比较本机时间与 GitHub 时间。服务内仍按 PR 加锁，减少无谓的被拒。结论没变时不写决定行，但周期表 `engineering_merger_shadow_cycles` 记下“这一轮看过这个 PR、结论是什么”，对照用它确认合并前的最后一次观察离合并有多近。
- **校验在写入前**：去重触发器是 `BEFORE INSERT … RAISE(IGNORE)`，比 CHECK 先执行，所以一条与上一条相同但本身不合法的行会被静默丢弃而不是报错。没有写入任何东西，但写入者仍要先在代码里按同一组约束校验行（`MergerShadowWriter` 的 zod schema），不依赖 CHECK 报错。
- **不入库**：正文、login、URL、文件路径（G4b 只记布尔与计数）、令牌。`gates_json` 用 4-C 同样的白名单 schema 校验后写入。
- **写入者**：`MergerShadowWriter { beginObservation(repository, pr) → n, recordDecision(n, row), recordOutcome(n, row), recordCycle(row) }`，只有这四个方法；不暴露 Mission store、链 store。
- **周期表的体积**：每 5 分钟一行，`prs_json` 每轮最多 10 个 PR，一年约 10 万行、几十 MB 以内；超过保留期的清理不在本附录范围（只追加表的清理需要单独的迁移与决定）。

### 4.2 记录内容（`gates_json`）

每条门槛一个键，值只含 id、oid、状态、布尔、计数，例如：
`{"G2c":{"live":"…","pushed":"…","candidate":"…","marker":"…","check":"…"},"G3":{"check_run_id":123,"conclusion":"success","duplicates":0,"foreign_same_name":1},"G4":{"required":[["check",15368,456,"success"],…]},"G5":{"base_head":"…","live_tip":"…","start_is_base":false},"G6a":{"review_id":789,"commit":"…"},"G6b":{"rulesets":[…],"force_push_events":0},"G7":{"mergeable":"MERGEABLE","merge_state":"CLEAN"},"second_read":true,"read_ms":[t1,t4]}`。

### 4.3 与真实合并对照（给后续 ADR 的实现提案）

ADR-006 要求在启用真实合并前，把影子决定与实际发生的合并对照，并记录每次是否有人检查过。对照方式是**提案**，由后续 ADR 决定是否采纳、怎样抽样：

- **何时记录结果**：结果表是片段序列，转换由触发器限定。周期中读到 PR `state` 为 `MERGED`，读一次 `mergedAt`、`mergeCommit{oid}`、`mergedBy{__typename ... on User{databaseId} ... on Bot{databaseId}}`、`headRefOid` 与 reviews，写一条 `merged`（转换触发器使它成为终点，只能写一次），之后不再读该 PR。读到 `CLOSED`（未合并）写一条 `closed_unmerged`，但**不停止**观察：已关闭的 PR 每小时读一次 `state`（一个字段），重新打开时写 `reopened` 并恢复 5 分钟评估；两次轮询之间被重开**并**合并时，下一次轮询读到 `MERGED`，直接写 `merged`（`facts_json.reopen_unobserved = true`），这期间没有影子评估，报告归入 `merged_unobserved`；关闭超过 30 天后写 `observation_expired` 并停止观察；报告把它单列为 `closed_expired`，明确“之后是否重开未知”。合并后 GitHub 不允许重开，所以 `merged` 与 `observation_expired` 是仅有的两个终点。
- **是否有人检查**：GitHub 无法直接说明。提案以“`gilosbornhello`（登记表 `counted_approvers`）在 `head_at_close` 上有一条 `APPROVED`，且 `submittedAt < mergedAt`”作为**有人阅读过**的证据（风险 4：所有者承诺读过 PR 才批准），写 `owner_approved_head`。这条证据只在登记表 `inspection_evidence = true` 的仓库成立：沙箱的场景脚本会用同一账号自动批准（§5.4），那些批准不是人读过，所以沙箱的 `merger.json` 设 `inspection_evidence = false`，`owner_approved_head` 写 `NULL`。合并者按数字 id 分类：`merged_by` 等于 `gilosbornhello`（269190136）、等于 App E 的 bot 用户 id（登记表 `merger.actor_id`；GitHub 返回的是 bot 用户 id，不是 App id 5620091）、或其他自动化账号，记在 `facts_json`。不能从 GitHub 读出的“人工抽查”（ADR-006 决定 1 的 spot-check）由所有者事后补录：提案为 `osstack mission merger attest --pr <n> --inspected yes|no`（交互终端、write scope），写入单独的只追加表；这一项不在 M-C 范围内，等后续 ADR 决定。
- **分类**（`osstack mission merger report --json`，read scope，只读）：

| 分类 | 定义 | 含义 |
|---|---|---|
| `merged_other_head` | 合并时的 head 不是发布的 head | 有人推送过；G2c 必然拒绝 |
| `merged_unobserved` | 已合并，`merged` 片段之前的三个周期（按周期表的 `seq`，即三个扫描间隔）里没有这个 PR，或 `reopen_unobserved = true` | 影子当时没在看（服务停了、排队），不计入一致率 |
| `agree_merge` | 已合并，合并前**最后一条**决定（`observation_seq` 小于 `merged` 片段观察号的决定中最大的一条；合并后的决定被 `merger_pr_merged` 拒绝，所以“合并前”不依赖本机时钟）是 `head_at_close` 上的 `would_merge` | 影子在合并前最后一次观察时会合并同一个 head |
| `merged_while_refused` | 已合并，合并前最后一条决定是 `refused`（无论之前是否有过 `would_merge`；“曾经可合并”另列为 `ever_would_merge=true`） | 真实合并时门槛不成立；列出码。是门槛过严还是真实合并有风险，逐条人工判断 |
| `merged_unevaluated` | 已合并，合并前最后一条决定是 `unevaluated`，或 `head_at_close` 上没有决定 | 影子没看清，不计入一致率 |
| `closed_expired` | 关闭后观察到期（`observation_expired`） | 结局未知，不计入一致率 |
| `closed_unobserved` | 关闭前 15 分钟内周期表里没有这个 PR，或关闭前没有任何决定 | 影子没在看，不计入一致率 |
| `would_merge_closed` | 未合并就关闭，关闭前最后一条决定是 `would_merge` | 影子会合并一个被人放弃的 PR，重点审查 |
| `closed_unevaluated` | 未合并就关闭，关闭前最后一条决定是 `unevaluated` | 影子没看清，不计入一致率 |
| `agree_no_merge` | 未合并就关闭，关闭前最后一条决定是 `refused` | 一致（另列 `ever_would_merge`） |

  分类互斥，按表中顺序取第一个匹配。每类附：`ever_would_merge`、合并者类别、`owner_approved_head`、`would_merge` 与 `mergedAt` 的时间差（仅作参考：本机时钟对 GitHub 时间戳，分辨率为扫描间隔 5 分钟，不参与分类）。
- **报告不做判断**：不给出“可以启用”的结论；是否启用、需要多少条 `agree_merge`、人工抽样比例，都是后续 ADR 的内容。

## 5. 读取与运行

### 5.1 读取器（M-B）

`packages/cli/src/contained-mission-merger-reader.ts`（新，懒加载）。两层结构与 4 附录 §5.1 相同：

```
传输（gh api，主机凭证，可注入）──▶ 原始页 ──normalizeMergeSnapshot()──▶ MergeSnapshot（无正文）──▶ evaluateMergeGates()
```

- **GraphQL**：复用 4-C 的 `ghGraphqlTransport` 与 `assertQueryOnly`。新查询 `MERGER_PULL_REQUEST_QUERY` 读 §3.2 列出的字段；`reviews`、`reviewThreads`（只要 `id isResolved`，不读评论正文）、`timelineItems(itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT, BASE_REF_CHANGED_EVENT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT])`、`files` 四个连接按 4-C 的方式分页并计入上限。
- **`body` 的处理**：`normalizeMergeSnapshot()` 内调用 `parseMissionMarkers()` 与第一行匹配，只把 `{ marker?: MissionMarker, first_line_id?: string, candidates, malformed }` 留在快照里，正文随即丢弃。`files` 只留 `{ count, workflow_paths_changed: boolean }`。
- **REST**：新传输 `ghRestGetTransport(path)`，参数全部编进 URL，argv 固定为 `['api', '--method', 'GET', path, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28']`。原因：`gh api` 一旦带 `-f`/`-F` 就默认改为 `POST`。`path` 必须匹配白名单（`repos/<repo>/commits/<sha>/check-runs?…`、`repos/<repo>/rules/branches/<ref>`、`repos/<repo>/branches/<ref>/protection`、`repos/<repo>/rulesets/<登记的 id>`、`repos/<repo>/commits/<sha>/check-suites?…`、`repos/<repo>/check-suites/<id>/check-runs?…`），`<repo>` 必须等于登记表 `repository`；其他路径、方法或 argv 里出现 `-f`/`-F`/`--input`/`-X` 一律抛 `MERGER_READ_DENIED`。
- **凭证**：一律主机 `gh` 凭证（与 4-C 相同）。App 令牌读不了分支保护（阶段 3 的发现，4 附录 §5.1），而 G4 需要读 `branches/<base_ref>/protection`、G6b/G6e 需要读 ruleset 的 `bypass_actors`（都需 admin）。主机账号本身有合并权限，所以“只读”由传输的白名单与 `assertQueryOnly` 保证，不由凭证保证；§6 的负向测试针对这一点。

### 5.2 登记表 `merger.json`

`$OSSTACK_HOME/bridge/merger.json`（主机私有，不入仓库；缺失即影子合并者关闭；存在但无效即服务启动失败）。复用 4-C `contained-mission-bridge-registry.ts` 的 `identitySchema`、`sameProducer` 与读取写法：

```json
{ "version": 1, "repository": "osborn-studio/osstack-bridge-sandbox",
  "publisher": { "actor_id": "<App A 的 bot 用户 id>", "app_id": 5620012 },
  "evidence_app_id": 5620053,
  "merger": { "actor_id": "<App E 的 bot 用户 id>", "app_id": 5620091 },
  "base_ref": "main",
  "inspection_evidence": false,
  "counted_approvers": [{ "actor_id": 269190136, "app_id": null }],
  "required_checks": [{ "context": "check", "app_id": 15368 }, { "context": "graph-macos-fixtures (22)", "app_id": 15368 },
    { "context": "graph-macos-fixtures (24)", "app_id": 15368 }, { "context": "graph-runtime-matrix (20.6.0)", "app_id": 15368 },
    { "context": "graph-runtime-matrix (22.23.1)", "app_id": 15368 }],
  "main_quality_ruleset_id": 26575831,
  "main_update_ruleset_id": 26577634,
  "mission_ruleset_ids": [26577637, 26577639] }
```

- `.strict()`：不接受 `private_key_path`、`installation_id` 或任何 App E 凭证字段（隔离的配置层，§5.3）。`merger` 只用于对照时识别“合并者是不是 App E”（`mergedBy` 返回 bot 用户 id，所以按 `actor_id` 比较）。`base_ref` 是唯一允许的目标分支（G2a）。`inspection_evidence` 说明本仓库的 `counted_approvers` 批准能否当作“有人检查过”的证据（§4.3）；沙箱为 `false`。
- `publisher.actor_id`、`merger.actor_id` 是 App A、App E 的 **bot 用户 id**（PR `author` 是 `osstack-publisher[bot]` 用户，`Bot.databaseId` 不是 App id），由所有者用 `gh api users/osstack-publisher%5Bbot%5D --jq .id`（App E 同理）读一次后填写（§8 决定 6）。
- `counted_approvers` 的条目 `app_id` 必须为 `null`（P-5：App 批准不计入）；与 `publisher` 重叠时拒绝。
- 与 4-D 的 `producers.json` 分开：两者开关独立（§5.3），字段不同。两份都存在时，启动时核对 `repository` 相同、`producers.json` 的 `publisher` 包含同一 `actor_id`，不一致即启动失败，避免两份名单分叉。

### 5.3 影子合并者（M-C）

- **开关**：`OSSTACK_MERGER=shadow` 且 `merger.json` 存在时启用；未设或 `0` 关闭；`1`、`live` 或其他值：服务启动失败，报 `MERGER_LIVE_NOT_IMPLEMENTED`（与 4-D `OSSTACK_BRIDGE=1` 的处理一致）。与 `OSSTACK_BRIDGE` 互不依赖。
- **隔离**：`contained-mission-merger-shadow.ts` 由 `contained-mission-rpc.ts` 中一个**单独的工厂**构造。现有 Mission 服务工厂会调用 `loadBridgeConfig`（`contained-mission-rpc.ts` L145–146）；合并者的工厂不经过它，只从同一个数据库句柄构造只读视图。合并者只接收：只读 Mission 视图（4-D 的 `listPrOpened()`、`publication()`，加本附录的 `deliveryEvidence(missionId)`：返回与 `pr_opened` 的 `evidence_digest` 对应的那条 `delivery_evidence` 的完整 payload，查找方式与 `publication()` 相同）、`MergerShadowWriter`、§5.1 的两个传输、时钟。它不调用 `loadBridgeConfig`，不读 `apps.json`、`rulesets.json`，不 import `contained-mission-github-app.ts`、`contained-mission-bridge.ts`（M-C 加一个静态测试：解析该模块的 import 图，出现这两个模块即失败），拿不到 `ContainedMissionHost`、runner、ports、`createBridgeKit` 或任何令牌源。**App E 令牌在影子模式下不存在**：仓库里没有为 App E 铸造令牌的代码，`merger.json` 也装不下私钥路径。
- **枚举**：每 5 分钟一轮，独立定时器，不在 Mission tick 上 `await`（性能预算：loop tick 开销 < 1%）。从 `listPrOpened()` 取 `publication.kind='opened'` 且仓库等于登记表 `repository`、最新结果片段不是终点（`merged`、`observation_expired`）的 Mission，最新片段为 `closed_unmerged` 的每小时只读一次 `state`，其余按（创建时间，mission_id）游标续扫，每轮最多 10 个 PR，同一 PR 两次评估至少间隔 5 分钟。
- **周期**：§3.4 的读取 → `evaluateMergeGates()` → `recordDecision`；PR 已合并或关闭 → `recordOutcome`。
- **失败**：读取或解析错误记 `unevaluated`（`U.read_failed:<码>`，按去重规则只记第一次），服务日志脱敏。`redactBridge` 目前只定义在 `contained-mission-bridge.ts` L47，而该模块是合并者禁止 import 的；M-B 把它移到无依赖的新模块 `contained-mission-redact.ts`，`contained-mission-bridge.ts` 从那里再导出，行为不变。不重试到本轮之外。

### 5.4 沙箱语料（M-D）

- 沙箱 `merger.json` 的 `inspection_evidence` 为 `false`：脚本用 `gilosbornhello` 的自动批准不是人读过，不进入“有人检查过”的统计（§4.3）。
- 场景脚本 `scripts/merger-shadow-scenarios.mjs` 只针对沙箱 `osborn-studio/osstack-bridge-sandbox`：用阶段 3 的发布路径开 Mission PR，然后按场景用测试评审 App 提交 review、用主机 `gh`（`gilosbornhello`）批准或解决线程（§8 决定 5）、推进 base、推 `PROBE_FAIL` 让检查失败；每一步之后跑一次影子周期并录制 `MergeSnapshot`（4-C 的白名单与假名化规则）。脚本的写操作只在场景脚本里，影子合并者本身仍只读。
- 场景覆盖 §6 第 2 行的每个负向用例，以及一个全部门槛成立的对照组（期望 `would_merge`）。没有对照组成功，负向结果不算数（与 P-11 同理）。

## 6. 测试计划

| PR | 测试 | 通过标准 |
|---|---|---|
| M-A | DDL：三张表只追加（UPDATE/DELETE 被拒）；去重触发器：与上一条相同的结论被丢弃，`refused(A)→would_merge→refused(A)` 三条都保留；`closed_unmerged→reopened→merged` 序列可写入；`would_merge` 必须带 `merge_request_json.sha = head_sha`、`codes_json='[]'`、`base_sha` 非空；`refused`/`unevaluated` 必须有非空数组码（`'{}'`、`'[]'` 被拒）；`would_merge` 的 `base_sha` 长度与 `merge_method='squash'`；同一 PR 上一条相同的结论被丢弃，head A→B→A 的三条都保留；观察栅栏：`refused@1`、`refused@3`（被去重）后 `would_merge@2` 被拒（`merger_stale_observation`），本机时间倒退（`observed_at` 100 之后 99）而观察号递增时照常接受，未推进栅栏的插入被拒（`merger_unfenced_decision`），计数器回退被拒；`would_merge` 的 `base_sha` 为 `NULL` 被拒；结果片段：`closed_unmerged→merged` 可写入，`closed_unmerged→closed_unmerged`、`merged→reopened`、`observation_expired→reopened` 被拒；非 `merged` 片段带合并字段被拒；结果片段过栅栏：`closed_unmerged`、晚到的旧 `closed_unmerged` 在较新的 `reopened` 之后被拒；`merged` 之后的决定被拒（`merger_pr_merged`）；未持栅栏号、与上一条相同的决定报 `merger_unfenced_decision` 而不是被静默丢弃（与触发器创建顺序无关：调换创建顺序再跑一遍）；栅栏新行不是 (1,0) 被拒；写入者：任一语句出错后事务被显式回滚、取号在提交后才返回、源码中没有 `REPLACE` 与多余的 `ON CONFLICT DO UPDATE` | 全部通过 |
| M-A | **ADR-006 要求的负向用例**（纯函数，每条单独一个用例，期望 `refused` 且含对应码）：① 非 Mission PR：快照 PR 号或仓库与证据不符 → `G2.*_mismatch`；② 复制的标记：另一 PR 的正文带本 Mission 的合法标记，但 PR 号、分支、作者不符 → `G2.*`；本 PR 标记被改（`spec_digest`/`start`/`id` 任一）→ `G2.marker_mismatch`；③ head 不符：实时 head ≠ `pushed_commit`、≠ `candidate_head`、≠ 标记 `head`、≠ check `head_sha`，各一例 → `G2.head_mismatch:<方>`；④ base 移动 → `G5.base_moved`；`base_head=null` → `G5.base_head_missing`；⑤ 批准早于最后一次推送：Mission ruleset 缺一条 → `G6.last_push_unprovable:rulesets`；时间线有强推 → `G6.force_push_observed`；批准在旧 head 上 → `G6.approval_stale_head`；⑥ App 的批准：只有 Bot（测试评审 App、App D）`APPROVED` → `G6.approval_by_app`；⑦ 错误生产者的检查：`osstack/verify` 只来自 App C 或 15368 → `G3.wrong_producer_only`；必需检查 `check` 来自非 15368 → `G4.wrong_producer:check`；必需集合多一条或少一条 → `G4.required_set_drift`；PR 改了 `.github/workflows/` → `G4.workflow_paths_changed` | 每条都只因被测门槛失败（其余门槛在夹具中成立）；另有一个全部成立的对照用例得到 `would_merge` |
| M-A | 其余门槛各一例：目标分支不是登记 `base_ref` → `G2.base_not_registered`；必需检查集合正确但来自另一个 ruleset → `G4.checks_bypassable`；`main-update` 里没有 App E 或含 App A → `G8.*`；G3 的 suite 数超上限 → `U.read_incomplete:G3`；ruleset 配置里 `bypass_actors` 缺失或多一个 actor → `G6.last_push_unprovable:bypass` / `G6.platform_rules_bypass`；旧式保护返回 404 时按空集合处理（只有 ruleset 的仓库能得到 `would_merge`），返回 403 → `U.read_failed`；`G1.not_opened:*`（三种 kind）、`G1.evidence_digest_mismatch`、`G0.join_ambiguous`、`G3.not_success`、`G3` 重复时取最小 id（最小 id 失败、较大 id 成功 → 拒绝）、`G6.changes_requested`（旧 head 上未 dismiss 的要求修改仍有效；同一作者之后的批准取代它）、`G6.unresolved_threads`（outdated 线程计入）、`G6.approval_superseded`、`G6.platform_rules_missing`、`G7.*`、`skipped`/`neutral` 必需检查被拒；`unevaluated` 的四种码 | 全部通过 |
| M-A | 属性（fast-check，复用 4-A 的依赖）：随机生成证据与快照，断言 `would_merge` ⇒ 每条门槛的谓词独立成立（用一份逐条写的参考实现对比）；任意一个字段扰动（head、base、review 作者、check app id、external_id）都不会得到 `would_merge` | `pnpm test` 1 000 次，`OSSTACK_PROPERTY_RUNS=10000` 时 10 000 次 |
| M-A | 变异检查（手工，记入 PR 描述）：去掉 G2c 的任一方、去掉 G3 的 `app.id` 或 `external_id` 比较、G6a 接受 Bot、G6b 不查 ruleset、G5 改用 `baseRefOid`、去重触发器改回按（PR，head）、去掉观察栅栏触发器、把栅栏改回按 `observed_at`、G4 接受来自其他 ruleset 的必需检查、去掉 G8 | 每个变异都有测试失败 |
| M-B | 读取器：分页与上限、`errors` 放弃、`body` 不进入快照（快照 JSON 中搜不到正文中的任意 token）、`files` 只留布尔；`redactBridge` 移动后 `contained-mission-bridge.test.ts` 不变通过；REST 传输：argv 恒含 `--method GET` 且不含 `-f`/`-F`/`--input`/`-X`，白名单外路径、他仓库路径被拒；`merger.json`：缺失、无效、带 `private_key_path`、`counted_approvers` 带 `app_id`、与 `producers.json` 不一致 | 全部通过 |
| M-C | **隔离负向集成测试**（复用 4-D 的装配）：在真实服务装配里跑影子周期，对 `createInstallationTokenSource`、`createBridgeKit`、`loadBridgeConfig`、Mission store 每个写方法、链 store 每个写方法、runner/派发、GraphQL 中任何 `mutation`、REST 中任何非 `GET` 打桩计数，断言全部为 0；`fs` 打开的文件里没有 `apps.json`、`rulesets.json` 或任何 `.pem`；Mission 账本与链表在运行前后逐行相同；import 图静态测试 | 全部通过 |
| M-C | 并发与 TOCTOU：在第 1 与第 4 步之间注入 head 变化、base 变化、新 review、线程重新打开、check 重跑失败，各一例 → `unevaluated`（`U.snapshot_moved:*`），不产生 `would_merge`；同一 PR 两个周期（含两个进程）并发：较早取号的周期在较晚取号的周期落库后才落库 → 被 `merger_stale_observation` 拒绝，最新记录仍是较晚的结论，较晚结论被去重时也一样 | 全部通过 |
| M-C | 开关矩阵（未设、`0`、`shadow`、`1`、`live`、缺 `merger.json`、无效 `merger.json`）；对照分类（§4.3）每类一个夹具，含 `would_merge` 之后又 `refused` 再合并（应为 `merged_while_refused`、`ever_would_merge=true`）、关闭后重开再合并、合并前 15 分钟无周期（`merged_unobserved`）、App E 按 bot 用户 id 识别；`report --json` 只读（同样打桩计数） | 全部通过 |
| M-D | 沙箱场景回放：每个负向场景得到对应码；对照组得到 `would_merge`，之后由主机 `gh` 合并，outcome 为 `agree_merge` 且 `owner_approved_head` 为 `NULL`（沙箱不作检查证据） | 全部通过 |

每个代码 PR 开出前照方案 §7：`pnpm build`、`pnpm typecheck`、受影响包的测试、CLI 启动预算（读取器与合并者都懒加载，不进 `cli-entry.ts`）、Codex 只读审查。

## 7. 与上位文档的偏差

| 偏差 | 理由 |
|---|---|
| 新建迁移 52 两张表，不复用迁移 51 的 `engineering_shadow_decisions` | §4.1：不依附修订链、`action` CHECK 需重建、去重键不同 |
| 增加 ADR 未列的 G4b（PR 未改工作流文件） | 15368 代表任何 GitHub Actions 工作流，PR 自己的工作流可以伪造同名必需检查（§3.2） |
| 增加 G6e（平台规则仍在） | ADR-006 “Residual race” 依赖 GitHub 在合并时重查；规则不在时影子 `would_merge` 没有依据 |
| G6b 用“Mission ruleset 生效 + 无强推 + head 未变”证明“批准在最后一次推送之后” | GitHub 不提供普通推送的时间与推送者（4 附录 §4.2 第 3 条） |
| G5 用 `baseRef.target.oid`，不用 `baseRefOid` | 后者不保证随 base 分支移动更新 |
| 必需检查只认 `success` | ADR 原文为“succeeds”；GitHub 把 `skipped`/`neutral` 也算通过，这里更严（§8 决定 2） |
| 结果分 `would_merge`/`refused`/`unevaluated` 三类 | 读不完整不能算拒绝，否则对照会把“没看清”算成“影子不合并” |
| 增加 G8（App E 在 `main-update` 名单上，App A 不在） | 否则 `would_merge` 可能是 App E 根本不被允许的合并（ADR-006 决定 5） |
| 必需检查必须来自无 bypass 的 `main-quality` | 集合相等不说明检查不可绕过 |
| G3 按 check suite 枚举 | `commits/{head}/check-runs` 只覆盖最近 1 000 个 suite |
| `redactBridge` 移到独立模块 | 合并者不能 import `contained-mission-bridge.ts` |
| 目标分支限定为登记的 `base_ref` | 发布允许任意 base，而门槛只读登记分支的规则（G2a） |
| 二次读取完整重做一遍 | 部分重读会漏掉标记、`baseRefName`、作者、draft 的变化（§3.4） |
| 记录结论变化序列与周期表，不按“第一次”去重 | 对照需要合并前最后一次观察的结论（§4.1、§4.3） |
| `merger.json` 与 `producers.json` 分开 | 开关独立；启动时核对两份的仓库与发布者一致 |

## 8. 需要用户做的决定

1. **G5 是否额外要求 `start_commit = base_head`**：目前 G5 只要求“发布以来 `main` 没动”。候选是在 `start_commit` 上验证的；若 `main` 在 Mission 开始与发布之间前进过，`start_commit ≠ base_head`，App B 的证据没有覆盖合并后的代码（只有必需 CI 覆盖）。影子期先只记录 `start_is_base`，不作为门槛；启用真实合并前定。
2. **必需检查是否只认 `success`**（§7）。默认是；改为与 GitHub 一致（接受 `skipped`/`neutral`）需要你确认。
3. **主仓库是否开影子合并者**：主仓库目前还没有 `main-quality` 与两个 Mission ruleset（ADR-006 决定 5），G6b、G6e 在主仓库上必然失败，所有决定都会是 `refused`。建议只在沙箱开，等 S1 套到主仓库后再开主仓库；需要宿主机 `merger.json`，名单由你确认。
4. **真实合并在哪里执行**（后续 ADR，不是现在）：ADR-006 “Unchanged” 规定 osstack 的 CLI、守护进程与循环永不合并。影子合并者在守护进程里只读运行不违反这条；真实合并要么放在独立进程（单独持有 App E 私钥），要么由后续 ADR 修改这条规定。
5. **M-D 沙箱场景是否允许用 `gilosbornhello` 的主机 `gh` 自动批准与解决线程**：P-5、P-6 表明只有用户账号的批准计入、只有用户账号能解决线程。只在沙箱，脚本化；这些批准不算“有人检查过”（§5.4）。不同意则对照组由你手动批准，M-D 改为半自动。
6. **App A、App E 的 bot 用户 id**：`merger.json` 需要它们（§5.2）。由你读一次并确认（或授权会话读取）。
7. **残余风险如何处理**（后续 ADR）：评估与合并之间，base 移动与“所有者批准被换成自动化批准”平台都不重查（§3.2 G6e 说明）。可选：接受为风险；或在真实合并前再做一次完整评估并缩短窗口（仍非原子）；或把 `strict_required_status_checks_policy` 改为 `true`（只要求分支最新，仍不等于 `base_head`）。影子期不受影响。
8. **“有人检查过”的定义**（§4.3 提案）：是否接受“`gilosbornhello` 在合并的 head 上批准过”作为证据，以及是否需要 `attest` 命令补录抽查。这是后续 ADR 的内容，影子期先按提案记录。

## 9. 审计记录

**第 1 轮（Codex CLI gpt-6-astra，medium，只读，基于初稿）：** 4 个 P1、4 个 P2、1 个 P3。逐条对照代码与文档核对后全部接受：

| 发现 | 核对 | 处理 |
|---|---|---|
| P1 G6b/G6e 用 `rules/branches` 验证不了 bypass：该端点不返回 `bypass_actors`，`missionRulesOnly` 只看 ruleset id 与规则类型，改了 bypass 名单的 ruleset id 不变 | 属实（`delivery.ts` L251–262） | G6b、G6e 另读 `rulesets/{id}` 的完整配置：`enforcement`、`conditions`、规则、`bypass_actors`（`mission-writers` 只允许 App A，另两个为空）；字段缺失按无法证明，不当作空列表；白名单加入该路径 |
| P1 二次读取漏掉标记与 `baseRefName`：改标记或 retarget 到同一提交的另一分支都能通过 | 属实；4 附录 §5.1 的二次读取含 `baseRefName` | §3.4 第 4 步改为完整重做第 1–3 步并要求规范化快照逐字段相等 |
| P1 目标分支不要求是 `main`，但规则只从 `main` 读 | 属实（`contained-mission-runner.ts` L74–76 只要求 `base` 非空） | 登记表加 `base_ref`；G2a 要求 `evidence.base = baseRefName = base_ref`（`G2.base_not_registered`）；G4/G6e 读 `base_ref` 的规则 |
| P1 G6e 不能在合并时保证 G5 与 G6a：`strict_required_status_checks_policy=false`，批准数规则也不限批准者 | 属实（`main-quality.json` L27、L17） | §3.2 加“G6e 管不到什么”；§3.4 改写残余窗口；§8 决定 7 列出选项，留给后续 ADR |
| P2 只用 ruleset 的仓库读旧式保护会 404，按读取失败处理就永远到不了 `would_merge` | 属实（`delivery.ts` L573–577 把 404/“not protected”当作无旧式保护） | G4：404/“Branch not protected”按空集合，403 等其他错误仍是 `U.read_failed`；§6 加用例 |
| P2 按“第一次”去重会丢掉 `would_merge` 之后的撤回，对照会高估一致 | 属实 | 改为只丢弃与上一条相同的结论（触发器 `RAISE(IGNORE)`），保留变化序列；加周期表；`agree_merge` 改为“合并前最后一条决定”，另列 `ever_would_merge`；分类互斥、按序匹配；加 `merged_unobserved` |
| P2 关闭即写不可变结果并停止观察，重开再合并会被永远记成 `closed_unmerged` | 属实 | 结果表改为片段（`closed_unmerged`/`reopened`/`merged`），只有 `merged` 唯一且是终点；关闭后每小时读一次 `state`，30 天后停止 |
| P2 沙箱脚本用所有者账号自动批准，又把该账号的批准当作“有人检查过” | 属实 | 登记表加 `inspection_evidence`，沙箱为 `false`，`owner_approved_head` 写 `NULL`；§5.4、§6、§8 决定 5 同步 |
| P3 `mergedBy` 返回 bot 用户 id，登记表只有 App E 的 App id，无法识别 App E | 属实 | 登记表 `merger` 改为 `{actor_id, app_id}`，按 `actor_id` 比较；§8 决定 6 加 App E |
| 附注：现有服务工厂会调用 `loadBridgeConfig`（`contained-mission-rpc.ts` L145–146），影子装配必须真的绕开它 | 属实 | §5.3：合并者由单独工厂构造，不经过该路径；§6 的隔离测试断言合并者路径不调用它 |

**第 2 轮（Codex CLI gpt-6-astra，medium，只读，基于第 1 轮修订稿）：** 第 1 轮 10 项（含附注）中 7 项判为已解决（其中 G6e 的局限判为“已作为延后风险记录”），3 项部分解决；新增 1 个 P1、7 个 P2、2 个 P3（与部分解决项有重叠）。审计在内存 SQLite 中执行了修订稿的 DDL 作为反例。逐条核对后全部接受；修订后的 DDL 也在内存 SQLite 中重跑了下表涉及的序列：

| 发现 | 核对 | 处理 |
|---|---|---|
| P1 G6e 只证明 `main-quality` 无 bypass，必需检查若挪到另一个允许 App E bypass 的 ruleset，G4 集合仍相等 | 属实（G4 只比集合；`main-quality.json` L24–38 现在把检查放在无 bypass 的 ruleset 里） | G4：每条必需检查必须来自登记的 `main_quality_ruleset_id`，否则 `G4.checks_bypassable` |
| P2 没有验证 App E 在 `main-update` 名单上 | 属实（`main-update.json` L12–15；ADR-006 决定 5） | 新增 G8：读 `main_update_ruleset_id` 完整配置，App E 以 `pull_request` 模式在名单上、App A 不在；不铸造令牌 |
| P2 `commits/{head}/check-runs` 只覆盖最近 1 000 个 suite，最小 id 无法证明 | 属实（GitHub 文档；阶段 3 查找同样受限） | G3 改为先按 App B 列 suite、再按 suite 列 check run；超上限 `unevaluated`；阶段 3 代码的同一限制记为跟进项，不在本附录范围 |
| P2 并发周期：早读的 `would_merge` 晚写入，盖过更新的 `refused` | 属实 | 服务内按 PR 加锁；触发器拒绝 `observed_at` 倒退（`merger_stale_observation`）；对照按 `observed_at` 排序 |
| P2 按（PR，head）去重，head A→B→A 时第二次 A 被丢弃，最新观察丢失 | 属实（审计给出了内存复现） | 去重改为对比该 PR 的上一条记录（含 head）；复跑确认 A、W、A、U、A 序列保留，重复项丢弃 |
| 部分 / P2 枚举条件“尚无 outcome 行”让关闭后的重开轮询失效；30 天截止被当成 `closed_unmerged` | 属实（§5.3 与 §4.3 自相矛盾） | 枚举改为“最新片段不是终点”；新增 `observation_expired` 片段与 `closed_expired` 分类 |
| P2 `unevaluated` 或未观察后关闭被算成 `agree_no_merge` | 属实 | 新增 `closed_unobserved`、`closed_unevaluated`；`agree_no_merge` 只在关闭前最后一条是 `refused` 时成立 |
| P2 DDL 不保证：`refused` 的码可为 `'{}'`；`would_merge` 的 `base_sha` 可为空串、`merge_method` 任意；结果片段可任意排列 | 属实（复跑确认原 DDL 接受这些行） | 加 `json_type='array'`、数组长度、`base_sha` 长度、`merge_method='squash'` 的 CHECK；结果片段转换触发器（`merger_outcome_transition`）；复跑确认被拒 |
| 部分 / P3 合并者禁止 import `contained-mission-bridge.ts`，却要用其中的 `redactBridge` | 属实（`contained-mission-bridge.ts` L47 是唯一定义） | M-B 把 `redactBridge` 移到 `contained-mission-redact.ts`，原模块再导出 |
| P3 测试计划仍写“outcome 每 PR 一行”“去掉 `would_merge` 唯一索引” | 属实 | §6 改为片段转换、去重序列、过期观察的用例与新变异 |

**第 3 轮（Codex CLI gpt-6-astra，medium，只读，由协调会话对已提交的 `ba30b1a3` 运行）：** 第 2 轮 10 项中 7 项已解决、3 项部分解决（过期观察、关闭后的片段、DDL 校验）；新增 3 个 P2，无 P1。审计在内存 SQLite 中复现了每一条。逐条核对后全部接受，修订后的 DDL 在内存 SQLite（3.53.1）中重跑了下列序列：

| 发现 | 核对 | 处理 |
|---|---|---|
| P2 去重让过期观察检查失效：`refused@10`、`refused@30`（被去重，没留下 30）后，晚到的 `would_merge@20` 被接受 | 属实；检查只看已存的决定行 | 新增 `engineering_merger_shadow_watermarks`：每 PR 一行，`issued_seq`（读取前分配）与 `accepted_seq`（落库时推进），与决定的去重无关；落库事务先推进 `accepted_seq`，`n ≤ accepted_seq` 报 `merger_stale_observation` 并回滚；决定行加 `observation_seq`，触发器要求它等于刚推进的 `accepted_seq`（`merger_unfenced_decision`）。复跑：`refused@1`、`refused@3`（去重）后 `would_merge@2` 被拒，栅栏停在 3 |
| P2 转换触发器禁止 `closed_unmerged → merged`，而每小时轮询可能漏掉“重开后合并” | 属实 | 选更简单的一种：允许观察到的 `closed_unmerged → merged`（合并由 GitHub 的 `mergedAt` 证明），`facts_json.reopen_unobserved = true`，报告归入 `merged_unobserved`；不从时间线重建中间片段 |
| P2 用本机时间排序，时钟回拨或多机偏差会拒绝真实的较晚观察 | 属实；审计用 100 之后 99 复现 | 并发与排序只用数据库发出的观察号；`observed_at` 只用于报告与 `mergedAt` 对照。复跑：本机时间倒退、观察号递增时照常接受 |
| 部分：`would_merge` 带 `base_sha = NULL` 能写入（结果为 NULL 的 CHECK 被当作通过） | 属实 | 加 `base_sha IS NOT NULL`，并把 `would_merge` 与 `refused` 的组合条件包进 `COALESCE(…, 0)`；逐条检查其余 CHECK 的 NULL 情况：`json_type` 比较改用 `IS`；`merged_by_type`、`owner_approved_head` 写明 `IS NULL OR`；结果表的合并条件改用 `IS`，并要求非 `merged` 片段的合并字段全为 `NULL`；`refused` 必须有 `base_sha`；`codes_digest`、`evidence_digest`、`head_at_close`、`merge_commit` 加长度检查。复跑：`would_merge` 的 `base_sha` 为 `NULL`、空串，`merge_method` 不对，缺 `merge_request_json`，都被拒；对照组接受 |
| 测试发现（本会话）：去重触发器先于 CHECK 执行，相同但不合法的行被静默丢弃 | 属实（复跑中出现） | 无数据写入，不改 DDL；§4.1 写明写入者在代码里先校验 |
| 部分：§4.3 仍写“部分唯一索引保证 `merged` 只写一次”，该索引在第 2 轮已换成转换触发器 | 本会话核对时发现 | 改为由转换触发器保证 |

**第 4 轮（Codex CLI gpt-6-astra，medium，只读，只审第 3 轮修订相对 `ba30b1a3` 的差异）：** 第 3 轮 4 项中 3 项已解决，1 项部分解决；新增 1 个 P2、2 个 P3，无 P1。审计在内存 SQLite 3.53.1 中执行了 DDL。逐条核对后全部接受，修订后的 DDL 在内存 SQLite 中重跑了每个反例：

| 发现 | 核对 | 处理 |
|---|---|---|
| 部分 / P2 排序已不用本机时间，但 §4.3 分类仍用 `observed_at < mergedAt` 过滤“合并前”；本机时钟快时会漏掉合并前最后一条 `refused`，误判 `agree_merge` | 属实 | “合并前”改为观察号小于 `merged` 片段的观察号；新触发器 `engineering_merger_decision_after_merge` 拒绝合并后的决定（`merger_pr_merged`）；`merged_unobserved` 按周期表 `seq` 判断；时间差只作参考 |
| P2 结果片段不过栅栏：A 读到 CLOSED 后停顿，B 记 `reopened`，A 晚到的 `closed_unmerged` 被接受 | 属实 | 结果表加 `observation_seq`、触发器 `engineering_merger_outcome_fenced` 与唯一索引 `engineering_merger_outcomes_obs`；`recordOutcome` 带观察号。复跑：晚到的 `closed_unmerged` 报 `merger_stale_observation` |
| P3 栅栏触发器与去重触发器的执行顺序决定结果：未持栅栏号的重复行被 `RAISE(IGNORE)` 静默吞掉；被去重的观察号可再写一条不同决定 | 属实（审计调换创建顺序复现） | 去重触发器的条件里重复栅栏检查，不依赖执行顺序；复跑：未持号的重复行报 `merger_unfenced_decision`。“号是本事务刚推进的”数据库不保证，§4.1 收窄说法，列为写入者约束并加测试 |
| P3 `INSERT OR REPLACE` 绕过栅栏的单调与禁删（`recursive_triggers` 关闭时隐式删除不触发 DELETE 触发器） | 属实；另几张只追加表同理 | 加栅栏新行形状触发器 (1,0)；§4.1 写明数据库挡不住 `REPLACE`，写入者只用四条固定语句，测试扫描源码拒绝 `REPLACE` |
| 附注：`RAISE(ABORT)` 只撤销出错语句、不回滚事务；`RETURNING` 不是提交 | 属实（复跑：ABORT 后事务仍打开） | §4.1 协议写明：出错显式 `ROLLBACK`；取号提交后才返回 |

协调会话要求在第 4 轮后停止审计。第 4 轮的修订没有再经过独立审计；M-A 的 PR 前 Codex 只读审查应覆盖本节最终的 DDL。

**相对 `ba30b1a3` 的 schema 变化（M-A 需要同步，第 3、4 轮合计）：**
- 新表 `engineering_merger_shadow_watermarks`（`repository`、`pr_number`、`issued_seq`、`accepted_seq`、`updated_at`，主键（`repository`，`pr_number`））及触发器 `engineering_merger_watermark_monotonic`、`_stale`、`_no_delete`、`_insert`。
- `engineering_merger_shadow_decisions`：新列 `observation_seq`；新唯一索引 `engineering_merger_decisions_obs`；新触发器 `engineering_merger_decision_fenced`、`engineering_merger_decision_after_merge`；去重触发器 `engineering_merger_decision_dedupe` 的条件加栅栏与“未合并”检查；删除 `engineering_merger_decision_stale`；CHECK 收紧（`base_sha IS NOT NULL`、`COALESCE`、`json_type … IS`、`refused` 需 `base_sha`、digest 长度）。
- `engineering_merger_shadow_outcomes`：新列 `observation_seq`；新唯一索引 `engineering_merger_outcomes_obs`；新触发器 `engineering_merger_outcome_fenced`；转换触发器允许 `closed_unmerged>merged`；CHECK 收紧（`head_at_close`、`merge_commit` 长度，非 `merged` 片段合并字段全为 `NULL`）。
- `MergerShadowWriter`：新增 `beginObservation`；`recordDecision`、`recordOutcome` 多一个观察号参数。
- 其他表名、列名不变。

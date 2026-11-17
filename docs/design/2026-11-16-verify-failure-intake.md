# U4b：验证失败的受控接入

日期：2026-11-16。基线：本地 `origin/main`，完整提交 `4f74acefa985fac715eba72378222252e3be7c1b`；写作开始时 HEAD 与该基线一致。本文的 `file:line` 均指这个提交，不代表远端的实时状态。

上位合同：[同 PR 受控修订](2026-11-06-bridge-same-pr-revision.md)、[W13 主机 git 存活门](2026-11-06-w13-host-git-survival.md)、[恢复与顺序](2026-11-07-bridge-phase5-resume-and-ordering.md)、[ADR-007](../decisions/ADR-007-bridge-github-ci-first.md)。执行时还需读取 [bridge 图](../plans/bridge-graph/graph.md)与[进度](../plans/bridge-graph/progress.md)。历史状态不能代替当前代码和新的验收证据。

## 1. 范围与推荐

目标：即使 GitHub Actions 全绿，Watcher 对当前 PR head 的 `verify-*` 验证失败也能被 osstack 读到；可信结果先登记诊断，经独立复现与授权后，最多派发一个修复子 Mission，快进到同一 PR，再验证原失败项。审批、合并、关单各自保留独立证据。

**推荐 B，以专用验证 App 的 check run 为载体；同时将可移植检查按 A 迁入 Actions。** B 覆盖云电脑独有的真实失败，是 U4b 完整闭环的路线。A 成本较低，应优先承接确定性检查，但 A 单独上线不算云端验证接入完成。两路均不得用“发一个红灯”替代真实执行。不得让 Watcher 冒充 Actions App 15368。

| 做 | 不做 |
|---|---|
| 当前已登记 Mission PR、已登记验证技能、可信生产者的结构化结果 | 扫聊天、扫 PR 评论、自动把 review 正文当修复指令 |
| 结果认证、诊断一次、独立复现、修复一次、原项复验、完整审计 | 结果本身授予执行、推送、审批或合并权 |
| 沙箱先验收，生产另行批准 | 本文实施代码、启用自动巡检、改 App 权限或生产开关 |

完成定义：§8 的真实正向链与全部负向用例都有完整、绑定源版本的证据；未知停止、未确认推送、未完成审批不得算完成。执行上限：每节点最多三次修正；失败只退回产生该失败的节点，保留失败记录，三次后转负责人。每个节点一个 PR，目标均为 `main`，人类决定合并。本次仅产出设计。

## 2. 现状核对

以下是代码事实；后文的 `verify_*` 原因码和结果状态是设计提案，尚未实现。

| 事实 | 基线证据（file:line） | 含义 |
|---|---|---|
| 扫描入口限于已开 PR、`verification_mode='github_actions'` 的根 Mission | `packages/cli/src/contained-mission-github-ci.ts:163` | 不是任意仓库、任意 PR 的通用接入器 |
| 当前 CI policy 固定 Actions App 15368，登记仓库 ID、workflow ID/path/blob、job/matrix/runner 与失败步骤 | `packages/cli/src/contained-mission-ci-policy.ts:8`、`:10`、`:36` | 同名红灯不是合格失败；osstack 的 `bridge-offline-node-tests` 已登记 |
| head/base 上的 workflow blob 都须匹配；失败 hint 与实际 job 对齐 | `packages/cli/src/contained-mission-github-ci.ts:56`、`:74`、`:97`、`:114` | PR 修改验证 workflow 不能自行扩大权限 |
| 最新 attempt 由 Actions run_number/run_attempt 解析，不由 ID 大小或时间猜测；仅指定步骤失败可修复，其他失败归基础设施 | `packages/cli/src/contained-mission-local-failure-reader-transport.ts:61`、`:125`、`:151` | 新 B check 不能塞进 Actions transport；不能把依赖失败当代码失败 |
| `readCiFailureHints` 验 suite/run 的 App 与 head，要求完整分页、解析 latest、前后读 PR；只产唤醒元数据 | `packages/cli/src/contained-mission-local-failure-reader.ts:139`、`:170`、`:197`、`:219`；`packages/core/src/bridge/local-failure.ts:32` | hint 不携带命令，不是复现回执或授权 |
| 合格 CI 失败可记事件并授权一个子 Mission；已有派发事件阻止再次派发 | `packages/cli/src/contained-mission-github-ci.ts:268` | “只有 Actions 真失败进入当前 CI 修复入口”成立；另有正式 review 修订链，不能概括为全系统只有这一种触发 |
| Watcher 聊天失败未形成正式 review；当前验收明确承认这一缺口 | `.cursor/skills/verify-osstack/features/contained-mission-bridge.md:7`；`docs/reports/bridge-phase5-verification/acceptance-v2.md:43` | 仓库证据支持产品缺口；本次未读取云端聊天或验证实际云 token |
| V2 本地失败 grant 只是离线合同，V1 仍只允许 review；显式 opt-in、profile pin、每 head 一次诊断 | `packages/core/src/bridge/revision-local-failure-grant.ts:9`、`:19` | 现有授权不能自动升级 |
| 本地回执要求绑定、完整 checks、证据摘要与停止证明；eligibility 只做纯判定 | `packages/core/src/bridge/local-failure.ts:43`、`:69`、`:113` | 外部 JSON 即使通过 schema 也不是主机可信回执 |
| intake DDL 自称未注册；store 没有 launch、验签、派发、回执消费及共享预算接线 | `packages/core/src/state/engineering-local-failure-intake-ddl.ts:1`；`packages/core/src/state/engineering-local-failure-intake-store.ts:32` | 不能只注册 DDL 就挂 runner；迁移文件没有引用该 DDL |
| profile 准备可用，运行门明确始终抛 `CONTAINED_PROFILE_RUNTIME_UNSUPPORTED` | `packages/cli/src/contained-mission-profile-execution.ts:13`、`:17` | 全程输出上限、可信命名空间前检必须先补齐；不能绕过这个门 |

### 2.1 A：把相同验证搬到 Actions

这里的“相同”指同一 check ID、固定断言和输入，不是让模型重新解读技能文字。用仓库维护的固定 harness 执行，保存真实退出码、输入版本与证据。一个 job 对应受控策略条目；安装、启动或环境失败不能伪装成该测试步骤的失败。

| 技能检查 | runner 可行性与边界 | 依据 |
|---|---|---|
| bridge 离线 Node 合同、固定 seed 的 properties、TLC、mutants | 可确定性运行。Node 合同已有 CI；其余分独立资源预算，记录 seed、模型与源 hash。mutant 的超时或导入失败不能算断言 kill | `.cursor/skills/verify-osstack/features/contained-mission-bridge.md:11`、`:53` |
| init/doctor、kanban 创建/移动/事件、health/socket/DB 归属、CLI 输出断言 | 可在隔离 Linux runner 运行；固定 Node、独立 home/socket/port、scratch workspace，结束时保留证据并清理。`ss` 等 OS 条件要固定；macOS 专属行为需要独立 runner | `.cursor/skills/verify-osstack/scripts/verify-osstack.sh:33`、`:90`；[init/doctor](../../.cursor/skills/verify-osstack/features/init-doctor.md)、[kanban](../../.cursor/skills/verify-osstack/features/kanban.md) |
| deliver 的 shell fixture、report/proof 校验 | 可运行；只证明本地 shell/loop 管道。技能中预期失败的用例必须断言预期 exit/outcome，不能把它登记为产品故障 | `.cursor/skills/verify-osstack/features/deliver.md:27`、`:30`、`:35`、`:46` |
| cockpit DOM/API、固定文本、headless 截图采集 | 固定 Chromium、字体、viewport、等待条件后可运行；截图成功不等于视觉验收通过。主观布局判断须转人工或明确 oracle | `.cursor/skills/verify-osstack/SKILL.md:20`；[cockpit](../../.cursor/skills/verify-osstack/features/cockpit.md) |
| 云端已安装候选的 provenance、云 token 注入、登录态、真实云电脑窗口/交互、Watcher 实际执行路径 | 不能由另一个普通 runner 证明。需在原云电脑采集、绑定候选和可信 harness；环境缺失记 blocked，不得记可修复失败 | `.cursor/skills/verify-osstack/features/contained-mission-bridge.md:7` 及其 real 5-G preflight；云端身份注入当前仍是证据缺口 |
| 真实 Codex/Docker、GitHub App/规则写入、付费 5-G | 有专用环境时技术上可执行，但不是普通无凭证 PR job；现有技能要求单次操作授权和受信任外置 harness，不能默认搬迁。Linux runner 也不能替代 macOS launchd | `.cursor/skills/verify-osstack/SKILL.md:14`；[bridge 技能配方](../../.cursor/skills/verify-osstack/features/contained-mission-bridge.md) |

A 的变更要同步登记 workflow 新 blob（head 与 base 都需满足 policy）、job 名、runner、matrix、failureStep；先合入并钉住可信 workflow，再处理后续 PR。新 job 未登记时只能观察。保持 `pull_request` 无秘密执行；不得用 `pull_request_target` 携秘密运行 PR 代码。A 的真实失败之后可复用当前 CI 入口、授权、同 PR 发布与原 job 复验，不需要新增外部结果解析器。缺点是无法覆盖云端独有证据；不能声称 A 已补齐全部 Watcher 闭环。

### 2.2 B：结构化结果的三种 GitHub 载体

平台能力按 GitHub 官方 REST 文档核对：[check run](https://docs.github.com/en/rest/checks/runs)、[commit status](https://docs.github.com/en/rest/commits/statuses)、[review](https://docs.github.com/en/rest/pulls/reviews)。下表的可信度是本设计据 API 身份字段作出的判断；仍需沙箱用实际云身份探针验证。

| 载体 | 谁能写、身份与伪造边界 | head/base 绑定 | 当前 osstack 能否直接用 |
|---|---|---|---|
| **check run（推荐）** | GitHub App，以 `checks:write` 写；REST 回应有 `app.id`。使用专用 installation token，限定仓库。其他 writer 能复制 name/正文，不能在正常 API 下冒充该 App；App 密钥泄漏仍可伪造，故必须主机复现 | `head_sha` 必填；没有足够的 PR/base 约束，须按本合同补齐并独立读 PR | hint reader 能读 App 数字 ID，但生产 transport 是 Actions 专用，无法解析 Watcher attempt；不取结果正文。必须新增独立 reader 与 attempt 规则，不能仅放宽 15368 |
| commit status | App installation/user token 或具相应 status 写权限的用户 token 可写；可复制 `context`。原始列表能读 `creator.id/type`，不能据 context 或 creator 自称证明 App ID | API 路径绑定 commit；PR/base 要另绑 | 当前 hint reader 不读 statuses；也不能从其结果得到权威 App ID。若退选此方案，只能按固定 numeric 用户 ID 登记，新增原始列表读取，不接受 combined state 作身份依据 |
| 固定格式的正式 review | 有相应 PR 写权限的用户/App 可提交；固定格式可被复制。普通用户 review 绑定 `user.id`。App 场景不能把 bot login 当 App 证明 | 显式 `commit_id=head`，禁止依赖默认最新 head；base 另绑 | review reader 能取 numeric actor；对 Bot 的 App ID 是从 registry 推导，并非该 GraphQL 记录提供的直接证明（`packages/cli/src/contained-mission-bridge-reader.ts:345`）。新合同需取原始 review 单独解析；snapshot 丢正文（`:396`），`COMMENTED` 不触发修订。不得造 `CHANGES_REQUESTED` 借用 review 派发 |

check run 有结构化 output 与明确 App 归属，优于 status 的短 description/外链，也避免将诊断混入评审票。它不是不可变档案：允许更新，平台也可能清理旧记录。接收时必须保存原始响应 hash、规范化合同 hash、证据副本及读取时间；对象不可读或发生未声明变更时停止，不靠旧缓存继续执行。三个载体都不能靠正文的 `producer` 字段自证身份。

## 3. 结果合同与可信判定

### 3.1 `VerificationResultV1`（新增合同）

check 名固定为 `osstack/verify-intake/<skill_id>`。`external_id=result_id`；`output.text` 只能放一个有界、严格 JSON 对象，`output.summary` 是转义后的展示文本。未知版本、额外字段、重复 JSON key、超长或控制字符直接拒绝。建议 payload 上限 16 KiB、summary 4 KiB、证据最多 32 条；不支持截断后继续解析。

| 字段 | 规则 |
|---|---|
| `schema_version`, `result_id`, `attempt` | 固定版本 1；UUID；由可信发布服务分配每个 repo/PR/head/skill 的单调序号，不能用 check ID 最大值或时间猜最新。重试写入使用同 result_id，身份相同但字节冲突拒绝 |
| `repository`, `repository_id`, `pr`, `branch` | canonical owner/repo、numeric repo ID、正整数 PR、目标分支；以 GitHub 原始对象和登记 Mission 交叉校验，禁止 fork 与任意 PR 自动建 Mission |
| `head_sha`, `base_sha`, `base_ref` | 完整小写 SHA；GitHub 当前范围仅接受 40 位，不能短 SHA；base_ref 固定授权目标。远端 PR 前后读、诊断前、派发前和推送前都比较 head/base。内部合同支持 64 位不表示本接入已支持 |
| `skill_id`, `skill_version`, `skill_blob`, `skill_manifest_digest` | 登记技能 ID；版本用于展示，blob 与递归依赖 manifest SHA256 用于判定。关联可信 harness/profile；候选 PR 修改技能不能更新主机安装的受信任版本 |
| `profile_id`, `profile_digest`, `trusted_source` | pin 已安装 profile 与源仓库/完整提交/artifact digest；由主机 policy 选择并比较，不能从 payload 加载命令 |
| `invocation_id`, `started_at`, `finished_at`, `generated_at` | 本次执行唯一 ID，UTC 时间；顺序一致。初始建议接收时距生成不超过 24h、未来偏差不超过 5min；以主机时间判断，GitHub 时间仅交叉校验，不作为唯一新鲜度证明 |
| `outcome`, `failure_code`, `checks` | outcome 为 `passed/failed/blocked/cancelled`；每项固定 check ID、枚举失败码、exit（可空）、result digest。只有 policy 登记的代码断言失败可诊断；缺凭证、超时、环境失败均 blocked。不能把任意非零 exit 当修复授权 |
| `evidence_refs`, `evidence_digest`, `runtime_provenance` | 每条含 GitHub 对象或许可制存储的 artifact ID、SHA256、大小、类型与保留期；包含脱敏 stdout/exit、截图/DOM（按检查需要）、运行环境和候选源 manifest。外链不是证据本身；主机需完整下载与验 hash，禁止任意 URL/重定向、命令、本机路径与秘密 |
| `dedup_key` | 规范化 hash(repo ID, PR, head, base, skill manifest, profile digest)，主机重算；另存 GitHub object ID/result ID 唯一键。不是调用方可自由选择的 nonce |
| `supersedes_result_id`, `withdraws_result_id`, `withdraw_reason_code` | 可空；引用同仓库、同 PR、同生产者的旧结果。撤回是同 App 新写的结构化对象（outcome=cancelled），不是删除或评论；保留原失败。通过也是新 attempt，不改写旧失败 |
| `producer`, `summary` | producer 仅供核对/展示，权限身份取自 API；summary 为有界脱敏参考材料，按 §5.1 隔离 |

传输结论须与 payload 相符：failed 对应 completed/failure，passed 对应 completed/success，blocked/cancelled 对应非 success 的终态。撤回对象用 completed/cancelled。每次新验证产生新对象；初始 queued/in_progress 对象仅能完成一次。终态的静默编辑、同 attempt 的多对象冲突、序号缺口或重排无法核对时，记 `verify_attempt_ambiguous`，不自动选择。发布端须保留序号账本；读端用完整有界分页与稳定快照交叉读取。未能完成读取就等待，不消费额度。

撤回在诊断前取消登记；已启动则请求停止，证明停止后结束；已推送只能记撤回并阻止自动继续，不回滚远端、不释放已花额度。每次派发、授权及远端释放前重新读当前结果与撤回记录；读取失败即停。已释放后到达的撤回按事实对账，不能声称没有推送。

### 3.2 生产者登记

推荐新增专用“Watcher 验证结果 App”。本文不编造尚未核验的 numeric App ID。负责人确认后，在主机私有配置登记精确 `repository_id + app_id + installation_id + skill/profile digest`，探针读回实际云端写入的 `app.id` 与安装仓库范围。**未填写且核验这些值时，B 入口关闭。** 不复用发布 App A、证据 App B、合并 App E，也不把验证 App 加入 reviewer 票池。最小权限：验证发布端 checks write、metadata read，取源按需要单独授予 contents read；无 contents write、无审批/合并能力。PR checkout、浏览器页面及模型执行器拿不到发布 token；可信外置发布服务只接收已完成的验证数据。

现有 `ProducerIdentity={actor_id,app_id}` 与 `ProducerRegistry={publisher,reviewers}` 在 `packages/core/src/bridge/revision-chain.ts:26`；加载器 `packages/cli/src/contained-mission-bridge-registry.ts:8` 使用 strict schema，禁止 publisher/reviewer 重合。故不能把新 JSON 键直接塞入 V1。新增独立、版本化 `VerificationProducerPolicyV1`：`producers` 是 App 或 User 的可辨联合，App 要求 app_id/installation_id，User 要求 actor_id 且 app_id=null；绑定仓库、载体、技能/profile、允许失败码、TTL、证据存储及自动登记开关。复用 numeric 身份比较思想，保留 registry V1 行为；默认只允许 App/check-run。运行时从验证 App 已认证的安装上下文核验 installation，不能相信 payload 自报 installation。

如负责人坚持 User/status 或 User/review，必须登记一个具体 numeric 用户 ID，验证 `type=User`，再单独批准权限和额外 reader；不能登记“任何 collaborator”或 login 通配符。登录名、头像、标签、check 名、正文签名串都不是身份。即便生产者可信，也仅允许登记诊断，不证明代码故障，更不授予推送权。

check run 的 `app.id` 不能证明具体使用了哪一枚 token，也不直接提供 writer 的 installation ID。安装范围须由该 App 的认证安装查询与仓库列表独立核验；若读端无此能力，保持 `verify_producer_untrusted`，不能用 payload 补证。仅 installation token 的要求由发布服务与凭证管理落实，读端不声称从 check run 证明了 token 类型。沙箱必须分别记录“平台可观察的 App 身份”和“发布服务的凭证隔离证据”。

### 3.3 拒绝与重放规则

| 情况 | 停点/原因码（均为新增） | 额度与后续 |
|---|---|---|
| schema/结论不符、技能未登记、证据丢失或 hash 错 | `rejected / verify_contract_invalid`、`verify_skill_unregistered`、`verify_evidence_invalid` | 不诊断、不派发 |
| repo/PR 不在登记根链、App/User 不符 | `rejected / verify_scope_unregistered`、`verify_producer_untrusted` | 留审计摘要，不能自动创建授权 |
| 旧 head、base 变化、过期 | `rejected / verify_stale_head`、`verify_base_changed`、`verify_result_expired` | 不移植到新 head/base；新绑定需新结果与授权 |
| 重复 object/result 或同语义 dedup | `duplicate / verify_duplicate` | 幂等返回原登记；不增加诊断与修复次数；换 grant/result ID 不能买重试 |
| 读取不完整、身份/attempt 无法证明、同时变更 | `waiting_source / verify_read_incomplete`、`verify_attempt_ambiguous` | 保持关门；仅重读事实，不重跑已完成诊断 |
| 主机不能复现或云端检查无受信任 profile | `diagnostic_closed / verify_not_reproduced`、`awaiting_decision / verify_profile_unavailable` | 无修复；人工确认也不能把失败断言改成成功回执 |

外部 dedup 防传输重放；主机诊断仍受现有 `unique(chain_id,head_sha,profile_digest)` 与每链一个活动诊断约束（`packages/core/src/state/engineering-local-failure-intake-ddl.ts:60`）。新 grant、技能别名、重发和撤回不能释放该唯一性。首发修复上限另固定为根链一次，跨 A/B 共用原子额度；两个渠道报告同一问题只关联多个来源，不开两个子 Mission。

## 4. 从可信失败到一次修复

以下结果状态是新增编排层，不冒称现有 Mission FSM 状态。诊断 journal 继续使用现有四态；Mission/chain 终态通过适配器记录，不把 `stopped` 改名为“已修复”。

```text
GitHub 结果 → 认证/当前绑定 → registered → reserved → running
  → stopped + 主机可信回执 → repair_reserved → 子 Mission
  → awaiting_decision(候选发布) → revalidating → 同 PR 快进
  → reverify_pending → ready_for_human → merge_observed → closed
```

| 步骤 | 复用与新增 | 失败停点、原因 |
|---|---|---|
| 0. 接收与合并互锁 | 新 reader 不依赖 Actions 失败；定向扫描已登记 PR。新增结果账本和 pending/failed/withdrawn 门。Actions 全绿不能越过此门 | 不可信结果按 §3 拒绝；无结果/读取失败时等待验证。不要先合并再收失败 |
| 1. 登记诊断 | 可信当前结果 → `registered`，只记诊断请求。无签名 V2 grant 则等待负责人；登记不等于允许运行 | `awaiting_decision / verify_grant_missing`；关闭/撤回则 `diagnostic_closed / verify_withdrawn` |
| 2. 诊断 admission | 新增接线：验 V2 签名、scope/session、有效期、profile/源 pin、head/base/tree/根链。同一事务先验 §5.2 的主机链路与深度；一个 immediate 事务扣共享预算、查 review/CI/local 排他、创建 reserve；提交后才 launch。复用 intake `activeExclusions/containerDebit` | `awaiting_decision / verify_grant_invalid`、`verify_budget_exhausted`、`verify_chain_busy`。保留旧在途排他，不能抢占 |
| 3. 受控复现 | 先补 profile runtime blockers，再在无网络/无秘密、只读根、固定镜像、资源与全程输出上限的环境运行可信 harness。候选按 §5.1 只有数据角色。复用 `reserved→running→stopped`，先留启动账再执行 | 不能证明停止 → intake `stop_unknown / verify_stop_unproven`，保留整笔 cap、claim 和排他；超时只在停止证明后记 stopped/timeout；不允许重启后重新 launch |
| 4. 固化复现回执 | 新增独立 typed host receipt 表/适配器，绑定 invocation、profile、evidence、stop proof，记录 canonical receipt digest。逐字段调用 eligibility，并要求失败 check ID/码与外部报告的登记映射一致；不能从外部 payload 或 opaque receipt_json 获得主机权限 | stopped/passed 或只有无关检查失败 → `diagnostic_closed / verify_not_reproduced`；基础设施 → `awaiting_decision / verify_infrastructure_error`；绑定不符 → `verify_receipt_binding_invalid`；均无子 Mission |
| 5. 预留一个修复 | 新 local-failure dispatch 适配器：事务内重验授权/当前结果、消费 host receipt 一次、扣 rounds/预算、排除现有 review/CI reservation、派发一个子 Mission。不能造 review ID 或虚构 Actions job | `awaiting_decision / verify_repair_limit`、`verify_source_revoked`、`verify_chain_busy`；事务回滚，不半派发；已消费后崩溃只恢复同 child |
| 6. 执行与候选 | 复用 contained runner、隔离工作区、protected-set、原 spec 与明确文件白名单；新增符合 §5.1 类型边界的结构化 failure_code/check_id 输入。失败原因来自可信枚举。首发一个子 Mission，禁止自动创建第二轮 | 越界/修改断言或验证配置 → `awaiting_decision / verify_protected_path`；执行/候选验证失败 → `verify_repair_failed`；停止不明进入 Mission `stop_unknown` |
| 7. 发布授权与 W13 | 复用候选 head/tree/spec 绑定的一次发布许可、主机 owner fence、W13 意图先行/放行事务/停止证明。新增 verification 发布类型和 source 撤回 fence；不得把它伪装成 `ci_repair`。建议默认人工确认具体候选；签名授权不隐含无限推送权 | 等待许可保持 `awaiting_decision / publication_pending`；过期/撤权 → `verify_publish_authority_invalid`；未释放且已证明停止可结算未写；已释放结果未知 → `awaiting_decision / verify_push_uncertain`，只读对账，禁止盲重推 |
| 8. 同 PR 快进与回读 | 复用 App A、单父提交/旧 head 租约、同目标分支、不可强推规则、PR 与远端 ref 双回读。head/base/分支不变才发布。W13 stopped 独立提交后再确认意图 | 租约过期 → `awaiting_decision / verify_stale_head`；base 变化 → `verify_base_changed`；回读不足 → `verify_push_uncertain`。不新开 PR、不自动 rebase、不回滚已确认提交 |
| 9. 原项复验 | 新 head 必须重新取得原 skill/profile/check 的完整结果（新对象，关联原 intake），原失败项成功且检查集合不缩水；同时检查 Actions 最新 attempt 全通过。A 用原 job，B 同时要 host profile 成功及 Watcher 原云环境复验成功 | `reverify_pending / verify_recheck_missing`；再次失败 → `awaiting_decision / verify_recheck_failed`，零第二次自动修复；换技能版本则 `verify_recheck_binding_changed` |
| 10. 审批、合并、关单 | 复用独立当前 head 的计入人工审批、未解决线程与所有 merge gates。新增验证门输入；Watcher 的验证通过不代替人工票。独立 Merger 或人类按既有规则合并；osstack 读回事实与提交绑定再关闭 intake | 未审批 → `ready_for_human / verify_approval_required`；合并事实不足 → `awaiting_decision / verify_merge_unverified`；关闭未合并 → `closed_unmerged`，不记 repaired/merged |

已有发布的具体依据：`packages/cli/src/contained-mission-github-ci-approval.ts:24` 只批准已验证且停止义务为零的具体候选，`:46` 每次重验绑定与时效；`packages/cli/src/contained-mission-runner.ts:715` 构造候选许可并在 `:719` 加远端变更栅栏；`packages/cli/src/contained-mission-github-ci-publish.ts:48` 走 fenced runner，`:63` 检查旧 head/base、`:73` 租约推送、`:78` 检查 W13 stopped 与回读。生产路径白名单见 `packages/cli/src/contained-mission-ci-policy.ts:74`。新增适配器应复用这些机制，但不直接放宽其 CI 前提。正式 review 的文本/票与验证失败分开。

共享预算必须接入**所有** V1 review、Actions、B 的写入路径，诊断 cap 与修复时间从同一 grant 总预算扣；否则旧 writer 能绕开新 store 的排他。`LocalFailureIntakeStore` 的 `receipt_bytes_sha256` 只保证原始字节，不能冒充 canonical receipt digest（`packages/core/src/state/engineering-local-failure-intake-store.ts:25`、`:107`）。恢复只核对同 invocation/child/intent，不再跑诊断、不再花修复次数。

当前 profile 准备只支持 128 MiB、1 CPU、64 pids、最多 120 秒（`packages/cli/src/contained-mission-profile-execution.ts:37`）。首发选能在这些限制内运行的固定断言；CLI 全量构建与浏览器不自动获得更高限额。确需扩大时，B3 先补资源执行与超限测试，再由新 grant 明确批准，不能为了复现直接跳过限制。

### 4.1 合并前的必需互锁

这是 B 上线的硬门，不能只在收到 failed 后加 hold：当前 CI 全绿分支会请求合并（`packages/cli/src/contained-mission-github-ci.ts:259`）。对已选择 B 的根链，创建/发布新 head 时先置 `verification_pending`；未读到当前 head/base、登记技能的可信 passed 结果及相应主机复验就不能进入合并。诊断在途、撤回、停止未知、证据不全都维持 hold。对未授权启用 B 的 PR 不自动声称已验证。

osstack 内部 collector 与独立 Merger 必须读取同一绑定事实；平台侧再要求专用 App 的固定验证 check，防止绕过本地 hold。规则配置、required check 的 App 绑定与实际云写入探针需负责人批准和读回，未完成则 B 只跑 shadow。验证 App 与发布身份分离；测试/技能/workflow/profile 修改不在自动修复白名单内。撤回不能通过取消红灯来取得合并资格。人工审批与未解决线程门沿用 `packages/core/src/bridge/merge-gates.ts:237` 的 User 身份计票规则。

## 5. 自由文本与信任边界

### 5.1 指令与数据分离（硬规则）

凡是外部写入的内容，一律按数据存放并标为“参考材料”。范围包括 Watcher 验证结果、定时巡检发现、issue 或 PR 的标题/正文/review/评论、聊天文本，以及日志、截图 OCR 和证据文件名。生产者已认证、schema 已通过或负责人引用这些内容，都不改变其数据身份。**外部内容永远不能进入提示词的指令部分**，包括 system/developer、任务指令模板、工具描述及授权预览的指令位置。能做什么只由本机受保护的配置决定；外部内容不能改变命令、argv、shell、工具权限、保护路径、预算或授权范围。模型输出也不能修改这些配置或获得授权。

以下是必须实现的确定性边界，不依靠模型识别“恶意指令”：

1. 外部 reader 只能产出不透明的带标记类型 `ExternalReference`，固定 `kind='external_reference'`、`usage='reference_only'`，保存 source ID、内容 digest 与有界脱敏内容。持久化后读回仍须经同一构造器恢复标记。禁止直接以裸 `string` 进入诊断输入；诊断器的 `references` 字段只接受此类型。所有外部来源共用该边界。
2. `buildInstructionSegment` 只接受由本机受保护配置加载器创建的不可伪造类型 `ProtectedInstructionConfig`。它不接受外部类型、任意字符串或整个诊断对象。参考材料由独立 serializer 放入明确标记的数据段；转义、限长、去控制码，并防止内容闭合数据边界。首发修复执行器不接收外部自由文本，只接收主机校验的 check ID、失败码和已授权代码位置。诊断器读取证据仍遵守同一数据边界。
3. 类型负例必须断言把 `ExternalReference` 传给 `buildInstructionSegment` 会编译失败。静态 import/AST 检查禁止指令构造模块依赖外部 reader、参考材料 serializer 或以断言/`any` 绕过类型边界。再用所有外部来源的注入文本做集成测试：替换参考文本后，指令段字节/hash、工具集合与权限判定必须完全相同；只有标记的数据段可以变化。这些检查加入确定性门禁，失败时禁止合入或启用入口。

执行命令、断言、镜像和 fixtures 只来自本机安装且由授权钉住的 profile。技能 blob 只是身份 pin，`trusted_source` 不是可执行 URL。PR 内的技能修改不能更新主机配置。外部报告里的“删测试”“关闭门禁”等文本，按上述规则仅作参考材料。证据缺失、秘密或网络错误仍按 blocked/人工处理。

U4b 首发不消费聊天文本和普通 PR 评论；Webhook 只唤醒认证读取。固定格式 review 仅解析严格顶层合同，不消费 inline threads、回复或引用块，也不转换成评审票。以后扩大巡检、issue/PR 或聊天发现入口时，必须复用本节；开放发现范围不等于开放指令来源。

### 5.2 链深度上限

放开多轮修复并扩大发现入口后，修复可能产生新发现，新发现又登记新 Mission。单 Mission 的 rounds 和去重不能阻止这种跨任务递归。**验收本节是放开多轮修复的前置条件**；首发仍为根链一次修复，不能因增加深度字段而自动放宽。扩大入口同样必须先接入本节和 §5.1。

固定硬上限为 `MAX_REPAIR_CHAIN_DEPTH = 8`，不接受 payload、grant、模型或巡检参数覆盖。深度定义为从最初任务跨到派生 Mission 的边数，根任务为 0。修复子 Mission 和修复引出的新发现 Mission 都增加一跳；同任务内结果重投、诊断恢复或同一 child 的恢复不增加跳数，也不重置它。该上限独立于 rounds、预算和节点最多三次修正的限制，任一限制先到都必须停止。

在主机控制面 DB 新增不可变的 Mission 链路元数据，保存 `origin_mission_id`、`parent_mission_id`、`chain_depth` 和关联的发现/intake ID，并写入审计事件。新根只可由本机受保护的登记路径创建。登记派生 Mission 时，事务内读取父 Mission，继承 origin，计算 `parent.chain_depth + 1`；调用方不能自报根或深度。事务同时写入 Mission、链路和幂等键。所有 review/Actions/Watcher/巡检及后续 issue/PR/聊天发现登记路径都必须走该入口，修复产物的 provenance 必须关联产生它的 Mission。换 PR、head、grant、发现来源或 result ID 都不能伪装成新根。

当计算出的深度达到 8 时，仍登记该发现及其 Mission，但停在新增编排状态 `awaiting_decision`，原因码为 `verify_chain_depth_limit`。它是第八跳的登记停点，不启动诊断、不扣执行预算、不派发修复、不发布，也不能再自动派生下一跳。诊断 admission 和派发事务都复核深度，防止并发或恢复绕过登记停点。该状态由适配器投影，不冒称现有 Mission FSM 已支持。若父任务已在停点，则仅关联到原等待记录，不创建深度 9。缺失或矛盾的历史链路不得补 0，停在 `awaiting_decision / verify_chain_lineage_unknown`，待负责人核对。

达到停点的同一事务写入持久通知 outbox，按 Mission/原因码幂等。本机通知 worker 通过受保护配置中已登记的负责人通道发送通知；通知含 origin/parent/当前 Mission ID、深度 8/8、发现摘要的参考材料标记、原因码和审计证据位置。重启后重试同一通知，不重启修复。投递失败保留待投递状态，并在本地待处理列表显示，不因通知失败解除停点。负责人可关闭发现或转人工处理；普通继续、换 grant 或重试不能重置深度。确需新根时，须由受保护登记路径记录独立人工决定及旧 origin 关联，自动入口无此权限。

## 6. 新增与复用清单

| 复用 | 必须新增/接通 |
|---|---|
| V2 grant/签名、LocalFailureBinding、eligibility、dedup helper | GitHub 外部结果合同、独立生产者 policy、check-run reader、稳定 attempt/撤回账本 |
| intake 四态、owner fence、排他/预算接口 | 正式 additive migration、所有 writer 共享预算与排他、typed host receipt、诊断 admission/恢复 |
| 已安装 profile 校验与镜像准备 | runtime 全程输出 cap、可信 namespace 前检与启动支持，之后才解除拒绝门 |
| contained runner、白名单、W13、同 PR 发布机制 | local-failure 单次派发、一次回执消费、独立发布类型/来源撤回 fence、原验证复验关联 |
| 受保护配置、诊断输入与提示词构造边界 | §5.1 标记参考材料类型、独立数据段、类型负例及静态/集成检查 |
| Mission 登记与审计事件 | §5.2 不可变链路、固定深度门、所有登记入口接线、持久通知 outbox |
| CI 最新读取、人工审批、独立合并事实读取 | B pending 必需门与 Merger 接口、平台 App 绑定规则、关单投影与审计 |

迁移号按合并顺序分配；不得在设计里抢占。旧 `ci_hint_json` 形状没有承诺外部结果，不将新合同硬塞进去：新增带 source_kind/object ID/digest 的来源记录，以 intake_id 关联；旧 CI hint 原样兼容。receipt 的 typed 表另有不可变绑定与一次消费约束。

## 7. 每节点一个 PR 的实施图

实施前先把以下节点加入 bridge graph/checks/progress；本次不修改这些文件。每 PR 自含检查和报告，依赖表示使用输出，不能开以另一 feature branch 为 base 的堆叠 PR。

```text
U4b-0(本文) → A1
           → B1 → B2 → B6
           → B3 → B4 → B5 → B6 → B7 → B8 → B9
                              ↑
                             B2
U4b-0 → C1 → C2 → B9
B6 ─────────→ C2 → 后续多轮修复/扩大发现入口（另行批准）
```

| 节点/产物 | 依赖 | 验收用例与门 |
|---|---|---|
| U4b-0：设计与负责人决策记录 | 无 | 本文完整性、链接审计、governance；没有发布或配置变更 |
| A1：可移植固定 harness/job 与 policy pin | 0、选择 A 范围 | 当前真实 assertion 红灯可登记；安装失败不可修复；新 head 绿灯复验；PR 改 workflow/blob 被拒绝。不声称覆盖云环境 |
| B1：严格结果 schema、生产者 policy、fixture | 0、身份方案 | 拒绝伪造 ID/未知 key/旧 head/过期/结论冲突；相同输入稳定 dedup；按 §5.1 统一输出 ExternalReference，payload 无命令入口。身份探针与合同单测分别报告 |
| B2：有界 check-run reader 与来源账本（shadow） | B1 | 完整分页、前后 PR 与结果变更检测、撤回、重复、序号冲突；按 §5.1 存储/读回保留参考材料标记；指令构造类型负例和静态检查通过；零 launch/推送。status/review 不默认实现 |
| B3：profile 运行支持 | 0 | 全程 stdout/stderr 上限、镜像别名/符号链接隔离、无网络无秘密、timeout/取消/崩溃停止证明；未完成保持 `RUNTIME_UNSUPPORTED` |
| B4：注册 intake 迁移和所有 writer 的共享预算/排他 | B3 | review/Actions/local 竞态仅一个获准；cap 扣费与 reserve 原子；重启保留 stop_unknown；V1 不获得 V2 能力；旧库升级无自动 launch |
| B5：诊断 admission 与 typed host 回执 | B4、B2 | 可信结果复现失败才 eligible；passed/超时/基础设施不派发；host receipt 不能由客户端替换；崩溃不重复 launch；opaque digest 不能消费；§5.1 全来源注入集成测试中指令段 hash、工具集合和权限不变 |
| B6：单次 local-failure 派发与发布适配 | B5、B2 | 一次消费、跨渠道最多一个 child；保护路径拒绝；候选待批准；W13 放行前撤回零推送，放行后未知只对账；同 PR 租约过期不重推 |
| B7：原项复验与合并互锁 | B6 | Actions 全绿/B 未完成仍 hold；新 head 的同技能/profile 全项通过才 ready；换版本/删检查不能通过；当前 User 票才计入；Merger 和平台规则探针单列审批 |
| B8：可信 Watcher 发布端与云身份探针 | B7、负责人批准身份/最小权限 | 真实云端写入 App ID 与安装范围读回；PR 代码无 token；失败/通过/撤回均可读；生产仍 shadow，不能仅证明本机凭证可写 |
| C1：跨 Mission 链路迁移与统一登记入口 | 0 | §5.2 根深度 0、父子逐跳继承、原子登记与幂等恢复；所有入口同测；换来源/PR/grant 不归零；历史链路缺失保持等待 |
| C2：深度门与负责人通知 | C1、B6 | §5.2 第八跳 awaiting_decision/verify_chain_depth_limit，零诊断/派发/发布，无深度 9；并发、崩溃及通知失败保持停点，outbox 重试不重复通知效果；全 writer 接线证据齐全后才可申请多轮修复及入口扩展 |
| B9：沙箱端到端报告与生产准入建议 | B8、C2 | §8 全场景；完整账本/远端读回、零多余修复、审批合并关单一致；失败也留报告。不自动开启生产 |

C1/C2 可与 B 路并行设计，但后续放开多轮修复和扩大发现入口的节点必须依赖 C2，并复验 §5.1；本次不批准这些扩展。A1 与 B1/B3 不互相依赖。若 B3/B4 超过一个可审查 PR 的范围，开工前再按输出拆节点，边界和验收保持独立。所有实现节点先跑确定性门（受影响类型检查/测试、inventory、changeset coverage、biome、CLI import/startup、文档链接、fixture 泄漏与 open branch test-merge），再报告、模型审查、CI；不得用模型判确定性检查。单节点失败最多三次修正，不通过重复运行刷绿。

## 8. 沙箱验收与证据

本节是后续执行方案，**没有执行授权**。只用已登记沙箱 `osborn-studio/osstack-bridge-sandbox`（ID `1446327922`），隔离 scratch home/DB/workspace、固定可信 harness 与已审查候选、明确一轮修复/写入/费用上限。不得触碰默认或 serving home。参考[现有沙箱驱动](../../scripts/smoke-bridge-revision-sandbox.mjs)及[驱动说明](../reports/2026-11-07-bridge-revision-sandbox-driver.md)，增加该场景而不是复用历史 pass 冒充新验收。

### 8.1 一条真实正向链

1. 选一个固定的、无凭证可复现的产品断言，例如 kanban 移动后 API 列归属断言。在沙箱候选植入只影响该断言的源缺陷；既有 Actions 全部实际通过。不能拿合成 JSON 的 failed 当“真实失败”。保存原 head H、base B、tree、源 manifest。
2. Watcher 在真实云验证环境运行固定技能，实际断言失败。独立可信发布端写 B check run，保存 App/installation 探针、原始对象、合同和证据 hash。证明只读聊天没有被消费。
3. osstack 从 GitHub 读取、登记一次；在签名 V2 opt-in 与预算内，对同 H/B 运行主机可信 profile，得到可复现失败与停止证明。链里有且只有一条有效 intake。注入重复投递，证明计数不变。
4. 只派发一个真实修复子 Mission；保留执行器调用、补丁、保护路径检查、候选 C 与本地验证证据。负责人确认 C 后才签发/消费一次发布许可。通过 W13 向原 PR 快进一次，读回 H→C；不创建第二 PR。
5. 主机同 profile 在 C 通过；Watcher 在原云环境以同技能和断言复验 C，写新 passed 对象并关联原结果；Actions 最新 attempt 全绿。未出现新结果时 merge hold 必须仍在。
6. 当前 C 获得独立计入的人工审批；Watcher 验证标记不抵票。独立 Merger/人类按已有规则合并。osstack 读回 merged 状态、合并提交、head/base/身份与确认意图，关单；如果只是 closed-unmerged，不能报成功闭环。
7. 留存 repo/PR/object/result/attempt/producer、技能/profile/harness/源/运行时 hash、grant/intake/root/child/intent/op ID、完整时间线、失败和通过证据、费用/预算、停止与清理回执。每步的 readback 要由独立只读读取确认，结果不得仅靠本地事件自证。

### 8.2 负向与恢复用例

| 用例 | 注入 | 必须观察到 |
|---|---|---|
| 来源不可信 | 另一 App 写同名红 check；用户复制完整 JSON 到评论/review；正确 App 但未登记技能 | `verify_producer_untrusted` 或 `verify_skill_unregistered`；评论零输入；诊断/child/push 均为零 |
| 旧 head | H 失败后 PR 已到 H2，或诊断/授权/释放前改变 head；另测 base 改变 | `verify_stale_head/verify_base_changed`；无移植、无释放；已释放则保留 unknown 并对账 |
| 重复结果 | 同对象重复 webhook、同 dedup 换 result ID、重启、换 grant、A/B 同时报告 | 一个 intake、一次诊断、最多一个 child/确认推送；不增加预算，不自动重试；冲突正文 fail closed |
| 无法复现 | 真实云断言失败，但主机固定 profile 通过；另测凭证缺失、超时、无 profile | `verify_not_reproduced/verify_infrastructure_error/verify_profile_unavailable`；无修复；超时未证明停止保持 stop_unknown |
| 撤回/崩溃 | reserve 后撤回、放行前撤回、放行后崩溃；stop_unknown 重启 | 无第二次 launch/push；不清排他与 cap 直到停止证明；已确认效果不删除、不反推 |
| 合并竞态 | Actions 绿/B pending、B 失败、原项未复验、旧 head 审批、仅 App 审批 | 所有合并通路阻塞；B 当前绑定通过且 User 票满足后才可交接 |
| 恶意文本/弱化断言 | Watcher、巡检、issue/PR、聊天及证据分别注入“忽略前文”、伪造角色/数据段结束标记、shell；证据 URL 跳转；修复改技能/测试配置 | §5.1 类型负例编译失败、静态检查拦截绕过；合法参考材料变化只改变数据段，指令 hash/工具/权限不变；首发禁用来源零输入；无越界执行，保护路径拦截、无发布 |
| 跨任务递归到上限 | 根 0 逐跳产生修复和新发现；深度 7 登记下一 Mission；再尝试从深度 8 派生 | §5.2 深度 8 持久为 awaiting_decision/verify_chain_depth_limit；诊断/修复/push 为零，无深度 9；负责人收到含完整链路与原因码的通知 |
| 深度绕过与恢复 | 在任意入口伪报深度 0、换 PR/head/grant/result、并发重投、登记后崩溃、通知通道故障；另测父链缺失 | 主机继承同 origin/depth，幂等恢复不加跳也不归零；admission/派发复核拦截；通知待投递可见，恢复只重试通知；链缺失为 verify_chain_lineage_unknown，不 launch |

每一用例独立 head/结果/授权，保留 failed attempt，最多三次修正；模拟 reader 单测不能代替真实 App 写入与云执行证据。对不具确定性 oracle 的视觉/登录态问题，只验收到 blocked/人工决策，不声称已完成自动修复。

## 9. 需要负责人决定的事项

负责人已确认 §5.1 指令与数据分离及 §5.2 固定链深度硬门；两者不是可选开关。本文将固定深度值定为 8。以下范围与执行授权仍待决定；缺决定时用关闭或人工等待的默认值。

| 决定 | 推荐 | 不选的后果 |
|---|---|---|
| A 还是 B，以及首发范围 | B/check-run 作为 U4b 目标，A 承接确定性检查；首发只一个技能/profile/失败码 | 只 A 则云端独有失败仍无法闭环；只 B 则重复承担可移植检查的可信发布与复现成本 |
| Watcher 用哪个身份写 | 专用验证 App，负责人给出并探针核验 numeric App/installation ID 和仓库范围 | 用现有 App 会混合权限；User/status 或 review 需额外身份规则/reader，且 App 归属证明更弱；身份缺失保持关闭 |
| 谁运行可信发布服务、保存证据及序号 | 云端外置受控服务，token 不进 PR/模型，证据至少覆盖完整审批/审计期；建议 30 天并在关单前复制 | 仅聊天附件/短期 URL 无法稳定读取；没有序号持久化不能证明最新 attempt，须人工处理 |
| 定时巡检能否自动登记 | 首发仅显式请求/登记 PR 的 shadow；验收后可按仓库开“只登记”巡检，仍需 V2 grant 才诊断 | 不开巡检需人工触发读取；扩大发现入口须先验收 §5.1、C1/C2，再另批范围/配额，不能由发现正文授权 |
| 是否自动诊断/修复/发布，何时放开多轮 | 分开授权；首发每 head/profile 一次诊断、根链一次修复，默认人工批准候选后推送；多轮须先通过 C1/C2，再单独批准 rounds/预算 | 未过 §5.2 硬门不得放开多轮；可信结果不能隐含授权，也不能覆盖深度 8 停点 |
| 深度停点由谁接收与处理 | 指定负责人及受保护通知通道，验收持久 outbox、失败可见与人工处置流程 | 未登记通道或投递失败仍停在 awaiting_decision；不能用自动新根或重置深度恢复 |
| 云端失败能否在主机复现、哪些算可修复 | 仅登记有固定独立 profile 的失败码；先一个可复现 CLI/API 断言 | 视觉、登录态或云专属依赖无 profile 时转人工，不能把“可信 Watcher”当作复现证明 |
| 合并互锁与审批策略 | B pending 与专用 App check 均纳入必需门；保留当前 head 的计入人工票，逐项批准并读回配置 | 不加门会在失败到达前因 Actions 全绿而合并；放宽人工票改变治理，超出 U4b |
| TTL、次数、沙箱执行与生产放行 | 接收 TTL 24h/未来偏差 5min；每节点三次修正；单次真实沙箱先批准，生产另开准入节点 | 更短 TTL 会提高 blocked 比例；更长增加陈旧风险；未授权真实执行不消耗费用、不写 GitHub、不宣布上线 |

### 9.1 负责人决定记录（2026-11-16）

负责人答复：八项均按上表的推荐执行。

| 决定 | 结论 |
|---|---|
| 路线与首发范围 | B（专用验证 App 的 check run）为 U4b 目标，A 承接可移植的确定性检查。首发只做一个技能、一个 profile、一个失败码 |
| Watcher 写结果的身份 | 新建专用验证 App。App 与安装的数字 ID、仓库范围由负责人提供，并用探针读回核对 |
| 发布服务与证据 | 云端外置受控服务；令牌不进 PR、不进模型。证据保存 30 天，并在关单前复制 |
| 定时巡检 | 首发只做影子观察：只对显式登记的 PR 读取，不自动登记 |
| 授权边界与多轮 | 诊断、修复、发布分开授权。首发每个 head 与 profile 诊断一次，每条根链修复一次，候选默认由人批准后推送。多轮修复须先通过 C1、C2，再单独批准 |
| 深度停点 | 由负责人接收；停在 `awaiting_decision`，不自动新建根链，不重置深度。通知通道与“待决定事项”的通知通道一致 |
| 可复现与可修复的范围 | 只登记有固定独立 profile 的失败码；首发先一个可复现的 CLI 或 API 断言。视觉、登录态、云专属依赖的失败转人工 |
| 合并互锁、TTL 与放行 | B 未完成与专用 App 的 check 都纳入必需门，保留当前 head 上计入的人工票。接收 TTL 24 小时，未来时间偏差 5 分钟。每节点最多三次修正。先批准单次沙箱真实运行，生产另开准入节点 |

仍需负责人动手或另行确定的两件事，不属于上面的决定本身：

- 在 GitHub 上创建并安装专用验证 App，给出数字 ID。这是仓库设置变更。B1 的身份探针与 B8 依赖它。
- 通知通道的具体载体（Grok Bot 聊天、桌面通知，或两者）。C2 的通知与“待决定事项”的推送都依赖它。

## 10. 本次文档门禁

本次补充稿门禁：`pnpm test:deterministic-rules` 通过；在 `packages/governance` 执行 `pnpm vitest run` 通过（51 个文件、429 个测试）。设计不声称已通过任何后续实现、真实云验证或沙箱端到端验收。

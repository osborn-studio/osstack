# 联合设计修订 3：复审后的精确接线与门槛

2026-10-27。本文件对修订 2 作明确补充；下列都是未来实施规格，不是已经实现的行为。CO01–CO10 原文保存在 evidence/sonnet-audit-2026-10-27/closeout-raw.md。原始历史合同不改写；JADR15 是本次新设计决定，实施必须单独评审。机器合同、工作包、阶段图和验收案例随本文件同步更新。

## 1. 恢复裁决的后态（CO01、CO03，JADR15）

`prior_phase` 与 `prior_resolution` 是两个独立可信读取：后者为 none/abandoned_unknown。reserved 且存在 resolution 是一致性错误，仅允许 preserve_unknown，不得通过取消倒推“未执行”。legacy_unknown 缺少可验证 invocation，本版只支持 preserve_unknown；不能补造绑定、profile 或停止证明。attention_action/broker_lease 可显式 null binding_generation/support_profile_digest；effect 必须使用实际非 null 值。subject.home_id 必须等于 target_home_id；broker_lease 仅允许 target=broker 且 prior_phase=broker_unknown，其他 subject 仅允许 target=home。

| 裁决 | hold 后态 | 资源与预算后态 | wait / applied 后态 | 普通升级守卫 |
|---|---|---|---|---|
| preserve_unknown | 原 hold 保留且 unresolved | 不释放任何未知预留 | 不清除；不写 applied | 阻断 |
| proven_not_started，仅新 reserved、无 resolution | 原行保留；写受信 cancelled_before_dispatch 证明，使该 hold resolved | 确认未执行部分预留释放；其他动作不受影响 | 取消原 action，不是满足依赖或 applied | 所有其他 hold 也 resolved 才可通过 |
| proven_stopped，仅 dispatch_committed 或 broker_unknown | JADR15 新增独立处置账本将精确 hold 标为 resolved_stopped，原 phase/receipt/resolution/hold 不删除、不改写 | 可释放已证明静默的并发/域占用；费用、token 的 unknown 预留继续保留到可信结算，不因停止归零 | 不写 applied；旧依赖仍未满足，须独立授权重规划 | 仅兼容恢复构建核验该处置、持久保留未结算预算、所有相关域静默且其他 hold 已解决时通过 |
| applied_observed，仅 dispatch_committed | 验证已有精确 completed-turn/message.applied 或 Graph action completion，记录 resolved_applied | 按原账本可信结算，未知财务仍保留；不能重复结算 | 只引用已存在事实；缺原 completed-turn 时拒绝，恢复 API 不合成成功 | 仅原 applied 谓词和其他 hold 全部满足时通过 |

JADR15 明确扩展原 ADR-16 的“尚无受支持解除通道”：只有 J12 实现、独立故障验证及相应恢复构建资格后才支持 resolved_stopped；当前产品仍无此通道。hold 的 resolved 是恢复账本的投影，不删除历史表。upgrade-operation fence/journal 另由同一受信恢复操作完成：检查不存在安装/维护任务、目标构建与 owner 一致、所有 hold 处置可验证，CAS 写恢复完成记录再解除 fence；不能因 daemon.resume 或单条 hold resolved 自动解除。任何不一致保持 recovery_required。

proven_stopped 证明包含原 action/invocation、source instance/generation、cancel request、workspace 和 containment domain 的最终静默及旧写者封禁。broker 证明另含 broker_id、lease_id、schema、owner_generation，必须与目标 broker 当前受信记录相等；home owner 的证明不能替代 broker owner。JSON 验证器只检查本地形状，可信引用加载与状态 CAS 属 J12/J17 产品验收。JA51/52 必须分别核对四列及混合 hold 情形。

## 2. 恢复打开模式和逐迁移资格（CO02）

J12 必须修改真实 `packages/core/src/state/db.ts` 的打开路径及 `packages/cli/src/engineering-upgrade-guard.ts`，不能等 J24。普通读写打开在 `runMigrations` 之前读取 hold/恢复状态；有未解决 hold 时拒绝全部 pending migrations。只读检查不得触发迁移。检查与迁移在持有独占维护 fence 的写事务内重新核对，避免预检后状态改变。

新增内部 `openRecoveryDb(plan)`：先建立不自动迁移的受信连接，验证 schema/lineage/owner/operator，再在 FULL 原子事务中只执行 `plan` 指定的一个白名单恢复账本步骤。`recovery_target_version` 是该构建明确支持的目标，不使用全局 CURRENT 自动追到最新；不得临时改全局常量。普通守卫对 schema<47、hold 表尚不存在的 canonical 旧库必须依据受信 schema/lineage 检查兼容分支，不能盲查不存在的表；恢复模式末尾版本断言比较显式 recovery_target_version，不能仍要求普通 CURRENT。旧 schema 到目标之间若存在其他 pending 业务迁移，拒绝，不跨越它们。账本 DDL、版本和谱系提交原子化，普通路径无法直接应用该恢复步骤绕过 guard。它允许 hold 存在，但不处置 hold。

J11 冻结的是迁移规格格式与候选模板；具体数字和 DDL 必须在每个 PR 基于最新 main、轮到 state-owner 队列后冻结。每次迁移均有 `Jxx.schema_spec → Jxx.recovery → Jxx.scoped`，实际证据键为 `(source_schema,target_schema,ddl_digest,fixture_digest,schema_spec_digest,candidate_sha,recovery_build_digest)`。J12.bootstrap_preflight 专门测账本步骤，J08/J10/J13/J17/J21/J22 各测自己的目标 fixture。重排/重编号/组合候选改变即失效并重跑。恢复测试在隔离 fixture 上执行，所以不依赖业务迁移已进入服务库；不以 J12 旧证书一劳永逸地资格未来 N+2。

## 3. Graph 试验许可的唯一消费位置（CO04）

固定源码 `GraphRunStore.create` 当前在事务内部 randomUUID；新 trial 路径必须显式扩展该 seam，不能声称已有实现。root_effect_id 在本协议中就是 trial `graph_run_id`：宿主签发前按 `trial-` + SHA256(UTF8(`osstack.joint.trial-root.v1\n`)+canonical({scope,idempotency_key,permit_id})) 派生，固定 scope 和原请求。它是受信内部值，不新增 worker 可指定的任意 run ID，也不改变普通 Graph 的 randomUUID 路径。

J08 实现 `GraphRunStore.createAndConsumeTrial`：同一 FULL 写事务内校验 host owner、原 scope/idempotency、冻结程序/输入/Binding 和许可当前状态，原子写 graph_requests、graph_runs 与唯一 permit consumption。重复相同请求返回原 run；不同输入冲突；提交前失败没有 root，提交后崩溃许可已消费。签发前冻结 idempotency_key；Graph 连接必须设置并读回 synchronous=FULL，不可沿用当前 openDb 的 NORMAL。无法提供该持久性则拒绝试验自动执行。消费表列名使用 consumption_state/consumption_revision，避免冒充 Attention phase。创建 root 的事务是许可消费点，不是 Attention phase CAS；真正每个外部调用仍走现有 `graph_actions`/broker 的原子 admission。trial 的消费后重启在本版只保留查询、停止、对账，不重新启动新 root 或重新 invoke 未确定动作；因此可能牺牲一次许可，不牺牲安全。

内部调用**只使用既有** `graph_actions(effect_key,graph_run_id,epoch,node_id,effect_slot,logical_attempt)` 与 reservation_tokens，不另建第二槽位账本。permit consumption 只记录 root 准入；累计预算从原 actions/可信结算投影，新增 cost 等维度也必须在同一账本和事务中扩展。许可是 Graph policy 的收窄：每个可比维度 effective_limit=min(policy,permit)，未声明许可维度仍由 policy 决定，绝不能扩大政策。未知在途动作按原 reservation 保留，重复 receipt 不重复扣减。

max_actions/max_adapter_invocations/max_wall_ms 必需并要求 profile 相应可强制；max_tokens/max_cost_microusd 可缺省。出现硬 cap 时必须有对应 enforceable 测量和可证明预留/截断方式，否则拒绝；缺省且 observed_only/unavailable 时如实显示“未提供硬上限”，不把 unknown 当零。任何继承 policy 硬约束仍须满足，不能借缺字段绕过。停止/查询/结算走独立授权和预留维护额度，不受试验许可过期、消费或业务预算耗尽阻断。

J08 路径清单新增 graph-runs.ts、graph-actions.ts、graph-rpc.ts、graph-action-broker.ts；context 原子 authorize 只负责最终权限/材料检查，不承担 root 持久事务。

## 4. 摘要、Profile 与原始文本解析（CO05）

digest-catalog.json 是全部域的唯一登记表；不得把旧五个示例当完整枚举，也没有当前字段使用 artifact-manifest 示例域。`required_artifacts_digest` 在 recipe/proposal 中总是整个 ArtifactRequirements 摘要；Binding.role_materials 与 context_receipt 改为 `role_required_artifacts_digest`，输入严格为 `{schema_version:1,role,requirements_digest}`，使用独立 domain。各角色知道同一全局完成义务，但身份不同，生产职责由 producer_role 指定；交换 role 会改变摘要。仅 method_text_sha256 控制各角色文本差异，不能把 builder 行动指令塞给 reviewer。

J01 必须交付严格原始 JSON 文本解析器：在普通 JSON.parse 丢失重复键/-0 之前检查词法；再验证版本化 schema；再 canonical。key 集合、负零、超安全整数、浮点、Unicode 拒绝规则保持不变。转义黄金向量补双引号、反斜杠、\b\f\n\r\t、NUL 和其他控制字符。文档 JS serializer 只接受已解析值，不能证明原始文本解析器。

SupportProfile 明确版本 2，预先包含 start_identity、query_by_start_identity、containment_domain。operator_attested_trial 可以 unqualified/null 并如实降级；需要 E01 自动 start 的 measured_qualified 支持格必须具备 idempotent_effect_derived_run、精确查询及被测 containment domain，缺任何一个不得激活。J23 只填写测量事实，不临时改形状。J01 outputs 明列 Recipe/Proposal/Profile/10种 body schema、解析器与摘要；后续缺字段即返回合同修订，不静默兼容。

## 5. 内容寻址配置的持久性与清理（CO06）

v2 配置总原始 UTF-8 字节上限 **65536**，每 role 模板最多 **12288**，三角色合计最多36864；其余意图、binding_inputs、JSON 转义和引用共用剩余28672。组装后再验总字节；超限拒绝或在冻结前生成新提案，禁止截断 mandatory 内容。实际 adapter prompt 内单角色方法材料仍≤16384B，配置预算与 prompt 预算分别验证。

J04 的 registration 是 host-owned 原子文件，位置为隔离 home 的 `method-context/registrations/<trusted-request-hash>.json`，引用 `method-context/objects/<raw-sha256>.json`。0600、临时文件→fsync→rename→目录 fsync；宿主以 scope/原请求查找，不信 worker 提供路径。无需先建 DB 表；J08 在原 graph request/run 可信身份中引用 registration key。身份回放需原 config 字节、固定合同与 profile 均可读且摘要吻合。

registration 与 object 属 run 的必要恢复资源：unknown/非终态/未结算义务/保留期内任一引用存在则禁止清理。J31 只能在终态、无 hold/未结算义务、无其他引用且达到保留期后 GC；清理前重新核对引用，失败不影响原应用事实。query/stop/reconcile 使用独立 read/stop/operator 权限，不进入执行 authorize，不因 permit 过期或材料失效堵死恢复；未来重新执行仍须新许可和最新全部检查。

## 6. 原 gate、case 与发布的真实消费边（CO07、CO08）

早期 `.scoped` 是组件范围验收。每个 Firstmate 原 gate 另建 `legacy:<id>`，requires 原 gate 的 producer 加原 requires 的所有 `legacy:` wrapper；不能用准备组件冒充完整原 gate。例如 R05.qualifier_protocol 独立映射 J10.protocol；V03.host_measurement 的 full wrapper 要求该协议；E02 full wrapper 要求 resolver/invalidation/profile/proof。这不再把全量 R05/J10资格回塞到 J23基础测量造成环。

实际发布通过 release_bindings 消费原 S2_opt_in/S2_default_enable；JADR12 同时派生 local:C03/C04/E02 三条仅去除 broker 前置的本地路径，原 legacy wrapper 保持全量。J27.full_original_completion 显式合取全部原wrapper和32个legacy_full门槛。

原114 case 每条有 gates 消费边，Jxx.legacy_full 必须消费其所有原场景；组件 scoped 通过从来不意味着 legacy_full 通过。J27.scoped 的 local opt-in 直接引用适用原场景，不依赖口头“还要重跑”。12项明确延期到 remote、不可信OS隔离、四recipe、竞赛、merge监控、lessons、autoresearch、形式模型扩展；每项保留原因，启用对应能力前必须补其原 case，不能借延期把本地共享安全断言去掉。full original completion 必须全部原 case 和原 full gate 通过。

未来 gate evaluator 必须读取精确候选/支持格证据，不能因为 JSON 有 case ID 就通过。文档校验器检查双向消费边、所有 legacy producer 的原 requires 闭包以及环，但不执行产品 gate。

J27.scoped = local opt-in，需要 E1∈{continue,safety_only} 和明确支持格安全证据，不等待 J32价值结论。J27.default_enable 另外要求 E1=continue、J32=continue。J32 必须输出 continue/inconclusive/stop，不能以“已做实验”通过。J27.release_channel 提前准备，所有实际产物发布必须经过；J03.diagnostics 必须早于 live E0，避免发布准备反向依赖最终发布。

E1预登记判据：continue=12项均可完成采集且技术可行、无严重安全失败、预登记保护指标无退化；它只允许继续评估或窄 opt-in，不是收益证明。safety_only=安全与可用路径通过但可行性/保护指标样本仍不足，需显式标注限制；安全失败或核心路径不可用=stop。保护指标阈值、缺失数据处理和测量窗口在 J25.protocol 冻结，未冻结不能运行 E1；不允许看完结果再选阈值。J32 价值决定按事前功效/区间/成本条件，任何 unknown/inconclusive 都不能默认启用。

merge_after 仅指两个 PR 都推进时的共享路径顺序，不是功能依赖。E0=stop 导致方法 J04 取消时，Firstmate J14 仍可基于实际 main 接线并复核共享路径；cannot infer canceled J04 is implemented。depends_on 与运行 gate 仍是真正前置。

## 7. oracle 生命周期与人员独立性（CO09）

unassigned→assigned→frozen→executed；更改 oracle 的语义、候选或支持格需显式新版本和重新检查。assigned 有作者/实现人员/保管人身份；frozen 增加 pinned_digest、frozen_at_ms 和 candidate_created_at_ms，冻结必须早于候选创建及结果揭示；executed 另有可信结果记录。当前全部 unassigned；字段为空是事实，不是固定合法终态。

J23.harness 的实现人员也必须登记进对应 implementation_principals。作者、独立复核人不得与对应候选实现者为同一主体；别名/同一Agent会话不可当两个人，host identity registry 判定。关键安全 oracle 再需一名独立复核人；custodian 不能同时为本批 recipe/实现作者。统计作者集中度并在评审中披露，未采用任意百分比上限以免伪造多人规避。未来 gate 只有 frozen 或 executed 且所有身份/时间/摘要检查通过才能进入候选执行；不要求所有oracle一定早于项目第一行代码。文档验证器接受完整合法冻结元数据，且拒绝未冻结执行。

## 8. 当前验证边界（CO10）

validation.md 记录最终实测数；原 closeout 输入保留当时旧统计，不反写输入。实施计划补 J03→J08 和 J11→J12→J08，明确第一次方法试验也等待恢复子路径。报告记录所有 REVISE 原文及后续处理；模型结论不替代真实 Provider、迁移崩溃、故障注入、独立 oracle 和同候选验收。

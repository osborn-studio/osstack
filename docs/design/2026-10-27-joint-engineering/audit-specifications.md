# 联合设计审计修订：必须实现的边界与推进门槛

这是联合设计修订 3 的规范增量；复审的精确边界见 [closeout-specifications.md](closeout-specifications.md)，下文已同步主要冲突，2026-10-27。对应 Sonnet 5.5 原始审计及逐条处置见 [claude-audit.md](claude-audit.md)。下列接口、表和门槛均待实现；本文件不授予执行权限，不代表已具备产品验收证据。与旧规划冲突处按本文件的明确增量处理，原输入快照保持不变。

## 1. 恢复裁决不是重新派发许可

J11 必须交付 recovery request、receipt、proof envelope 三套完整 schema，以及下表的产品 verifier。request 必须携带 `request_id`、`if_revision`、目标 effect/home/broker；身份从宿主认证上下文获取。receipt 记录 verifier 实际读取的原 phase、revision、owner/binding generation、schema/DDL/fixture/build/candidate/profile、授权与证明摘要。客户端写入的 role、phase、proof kind 或 operator 名称不能当作事实。

| 当前可信 phase | 可接受的裁决 | 必要证明与后果 |
|---|---|---|
| 新协议 reserved | preserve_unknown | 保持义务；不释放预算，也不授予派发 |
| 新协议 reserved | proven_not_started | 当前 dispatcher 事务内确认从未 committed，存在 stop_intent，完成 cancelled_before_dispatch CAS；同 action 永不重发 |
| dispatch_committed / legacy_unknown | preserve_unknown | 保留未知和资源；不能凭“没有观察到调用”声称未开始 |
| dispatch_committed / broker_unknown | proven_stopped | 当前目标 invocation 的独立终止/containment 证明；记录停止事实，不声称产品成功，不重发原 effect |
| dispatch_committed | applied_observed | 原 action/message 与 completed turn 或执行器精确完成 receipt；不能用操作者备注、终端文本或普通 exit 0 替代 |
| 任意 phase | 其他不匹配组合 | 拒绝且不改变原 phase、预算或资源 |

preserve_unknown 可以没有终止证明，但不能没有目标对象与当前 authority 校验。新协议 reserved 的正常首次派发仍只走继承 ADR-05/11 的 dispatcher 条件；operator recovery 不提供替代路径。已终结处置不能恢复为 reserved。相同 principal/request/input 返回原结果，不同输入复用 request 返回冲突。

broker proof 须额外绑定 broker identity、schema、owner generation 和 lease ID；home owner 接管不构成 broker 释放证明。所有 proof 从可信存储按引用加载并重算摘要，不能仅通过 JSON 形状获得信任。

## 2. 为带 hold 的旧库建立可写的恢复入口

选择单一方案：**受控恢复构建的纯增量恢复账本迁移**。不采用无事务的 JSON 旁路裁决日志。

这是对 Firstmate ADR-16“普通升级遇 hold 必须阻断”的明确、极窄增量：普通升级与业务迁移仍被阻断；一个专用 recovery-bootstrap 操作在独占 owner fence、当前 operator 授权、FULL 事务与精确来源 schema 匹配时，可执行 J11 冻结并逐语句白名单检查的账本 DDL。它仅增加 operator recovery 表、索引及相应版本/谱系声明，不改删原 action、message、phase、hold 或预算行，不启动任何 Worker。

J11 先冻结：实际来源/目标 schema、账本 DDL 与 fixture 摘要、迁移谱系的预期表集、旧写者拒绝规则。J12 实现并测这个特定迁移与恢复 verifier。schema bump 和账本创建在同一事务；中途崩溃仅允许旧版本无账本或新版本完整账本。owner 不可独占、库谱系不符或 schema 超出支持集时拒绝。未知在途 Worker 可以保留，但旧控制面写者必须被 fence；不能把锁到期当作进程停止。

这不豁免后续 C03/J13 或 broker 业务迁移。每个业务迁移仍需同一目标 schema/DDL/fixture 的恢复构建证据。每个迁移 PR 自己的 Jxx.recovery 对实际目标 fixture 验证恢复能力，再允许其迁移；fixture 创建不触及服务 home。operator 裁决与其影响的原 hold/lease CAS 必须在同一受信事务提交。旧二进制不能读写新库；回退仅停止新派发并保留兼容恢复构建。

J11/J12 的放行案例必须覆盖：旧库有真实 committed unknown hold、DDL 前/中/提交后退出、只增账本而 hold 字节不变、错误迁移号/DDL、旧 owner/旧 binary、重复 request、错误 proof、故意添加 UPDATE/DELETE phases 的坏迁移。不能仅用依赖图无环宣布恢复可用。

## 3. 首次试验的身份、消费和预算

`candidate_method_digest` 精确定义为 `MethodProposal` 的摘要；保留字段名只是本版兼容，不能填 recipe/source digest。permit 另外绑定完整 MethodBinding 摘要，其传递闭包包含 source、recipe、context、contract、角色材料和 profile。permit ID 是预先分配的普通 ID，不是 permit 摘要：先分配 ID → 生成 trial Binding → 生成 permit；不形成摘要循环。

Binding 显式标 `mode=trial|qualified`。trial 必须有 permit ID，qualified 禁止携带试验许可。TrialSupportProfile 由 J01 定义结构、J08 的可信操作者经宿主登记并签收，标 `operator_attested`，包括确切 repo/home、默认 tenant、adapter/provider/model/runtime、隔离等级、停止/查询能力及预算可强制维度。它不是 J23 的 qualified profile。J23 可先测既有 adapter 基础能力，新增 J14 服务接线后必须对组合候选重测，不能直接继承资格。

试验 repo 与 OSSTACK_HOME 的 realpath 必须落在配置的 scratch 根内，解析 symlink 后仍不能是 default/reserved home 或已登记 serving repository。宿主签发者须具备该 scope 的 trial 操作权限；planner/worker 的自报 issuer 一律不能签发。许可中的字符串和 schema 正例不是授权凭据。

`max_root_runs=1` 指一个 root effect/run；`max_adapter_invocations` 另外计实现、评审和修复，`max_actions/max_wall_ms` 及可选 `max_tokens/max_cost_microusd` 是同一 run 的累计上限。模板预估的最低槽位超过许可时在 start 前拒绝。模型 token/费用不可观测或不可强制时，不得接受相应硬预算请求；支持 profile 明列 `enforceable|observed_only|unavailable`。unknown 费用不是零；未知执行继续占用整笔未结算预留。预留最终查询/清理额度，预算耗尽不妨碍停止与对账。

消费采用宿主受信 SQLite 账本 `trial_permit_consumptions(permit_id PRIMARY KEY, root_effect_id UNIQUE, binding_digest, request_id, input_digest, owner_generation, consumption_state, consumption_revision)`，不是方法包自己的 outbox。许可消费与 GraphRunStore 创建 root 在同一 owner-fenced FULL 事务提交；每个内部 action 的首次启动仍由原 Graph broker admission 控制，不能借用 Attention CAS。消费前失败不启动；消费后到 observed 之间崩溃保持 consumed/unknown，不把 permit 复原。相同 root 的恢复只允许查询/停止/对账，不能自动重发；重新试验必须先处置原义务并签发新许可。

内部调用复用 graph_actions 按冻结模板的 `(graph_run_id,epoch,node_id,effect_slot,logical_attempt)` 持久预留和消费，不另建槽位账本，重复 receipt 不重复结算。不能把“一个 root”误测成“整个流程只有一次 raw adapter 调用”。并发反例断言一个 root 被准入，内部调用次数遵守已授权槽位。

实际接线归 J04/J08：在 `graph-contract-host` 的 adapter 创建配置和 `graph-execution-context` 的 `authorize` 同步边界传入绑定、permit lookup、撤销/取消与当前材料检查；现有只收到 optional selected 条目的 `validateContextSync` 不足以检查 mandatory method。最后检查与 raw invoke 之间不得插入新的异步准入；外部效果的不可原子窗口仍按 committed/unknown 处理，不能承诺端到端 exactly-once。

## 4. 新摘要的精确字节规则

旧 `FrozenDeliveryContractV2`、Graph 程序摘要及旧 context 配置摘要保持原算法。`context_config_digest` 精确等于宿主读到的配置文件原始 UTF-8 字节 SHA-256，并与 envelope.contextDigest 相等；不是重新排序 JSON 后的 hash。换行或空格变化也使旧绑定失效。

新对象使用 `joint-canonical-v1`，不是泛指旧 helper，也不宣称实现完整 RFC 8785：

1. 输入先用严格原始 JSON 文本解析器检查词法，再通过版本化 schema；拒绝重复 JSON 键、非法 Unicode/lone surrogate、负零、浮点、超安全整数及 schema 未知字段。
2. 协议对象键限定 ASCII，按 Unicode/ASCII 码点升序；字符串不做 Unicode 归一化，JSON 必需控制字符、双引号和反斜杠转义，其余有效 Unicode 直接 UTF-8；紧凑 JSON，无额外空白。
3. 缺字段与 null 不互换。数组保持顺序；仅 schema 明列的集合字段按其注册稳定键排序。重复主键一律拒绝；本版 `role_materials` 按 role 排序，其他数组均按显式顺序参与摘要。旧合同的去重行为不变。
4. `SHA256(UTF8(domain + "\n" + canonical_json(body)))`；全部字段与域以 digest-catalog.json 为唯一登记，域不能互换。
5. Binding body 为 schema 中除 `binding_digest` 外的全部字段，含 mode、permit ID（若有）、source、recipe、authorization、task 与 role_materials；不得只拼接四个 digest。可信 host 重算并与引用及可信存储记录比较。

[fixtures/digest-vectors.json](fixtures/digest-vectors.json) 固定字节与 hash；包括键序、非 BMP 字符、null/absent、数组顺序、重复键/集合、负零与跨域负例。本轮只验证规格向量，不宣称产品 TS 实现已通过。J01 必须让独立 TS 实现与这些固定向量互验。

## 5. 产物相位与角色材料

intent 是任务意图证据，不要求尚不存在的最终 candidate；reproduction 绑定修改前 baseline candidate、scenario/environment/check-registry；candidate_checks 与 independent_review 绑定最终 candidate，并引用不可变 baseline artifact；cleanup 引用该 run 的资源账本与原应用回执。host 在准入后可把先前生成的不可变意图/复现正文封装进当前 run 的 envelope，但不得改写原生成时间、候选或证明内容。

最终验收比较 baseline→candidate 的同一场景、授权仓库、检查定义与环境；明确允许 baseline head 与修复 head 不同。最终 checks/review 必须属于同一最终候选。生成、重算、引用和语义检查都有独立消费者；仅下载后算 hash 不证明 reproduction 的来源、内容或语义。reproduction 只接受受信注册 driver 的 `(scenario_id,action_id,action_receipt)`；worker 任意日志不等价。`host_authenticated` 必须由 host 从 host_record_ref 及当前 profile 推导，客户端自报值无效。

方法材料按 role 分为 builder/reviewer/verifier；Binding 固定每个 role 的材料摘要及 required-artifact contract 摘要，receipt 记录实际 role。reviewer 只获得审查任务、合同、候选、证据和 reviewer 材料；不得注入 builder 专用行动指令或只给 builder 自述。角色来自冻结节点到受信 host 的映射，不从 prompt/worker 声明推导。角色映射无法从现有 host seam 取得时 O02 未解决，停止该接线，不改冻结 Graph v4 程序规避。

## 6. 驱动、价值验证与可判定实验

J03 分成 JP-03a `session-answer-receipt` 和 JP-03b `bug-fix-fixture`，各有 doctor/drive/observe、资源归属与 cleanup。J06 三张地图分别指向已有的等待/取消/复现场景动作。J09 复用 JP-03b 的同一 driver，在初始候选留红证据，在修复候选留绿证据；不能另写一个自证 smoke shell 代替原表面。

J25 分三阶段：protocol+baseline → E0 可行性决定 → E1 方法增量结果。E0 可用现有 pinned pack 作为显式实验干预，必须检查实际 selected/omitted receipt；缺失仍计入实验失败/无效记录。它不产生方法资格，也不替代 J04 mandatory 通道。E0 只判断可驱动、可观察、是否值得进入窄实现，允许 continue/shrink/stop，不作 ROI 结论。J05/J07/J08 的产品接线受 E0 决定约束；纯协议工作可先行。E1 必须在 J09 后运行，J10 资格和 J16 联合旅程须有 E1 决定 `continue|safety_only`；样本不确定时只允许明确 `safety_only` opt-in，不宣称收益。stop 阻止对应推进，保留历史 planned 记录，不伪造已取消的运行时任务。

E1 的 12 项只做 bug-fix 的可行性诊断，跨文件/假设/环境故障是 bug-fix 子类。开发夹具与 holdout 不重叠；holdout 保管人为独立 evaluation custodian，recipe 作者不可见；在候选锁定与首次实验前封存任务/判定器摘要，任何解封后调参必须新批次。两臂使用相同隐藏验收摘要、预算、工具可用性和成功定义；不同 recipe 内部检查不能改变外部成功判据。无适用方法的任务按 intent-to-treat 保留，fallback 明示。

n=12 的一次净翻转不支持 5pp 收益结论；E1 不触发默认启用。E2 在运行前登记最小效应 δ、最大允许退化 ε、任务级配对区间算法、样本量/预算及停止规则。只有相应区间通过阈值才可支持价值决定；p95 小样本、零成功导致单位成功成本无定义、费用 unknown、区间跨门槛都输出 inconclusive。默认启用门槛不接受 safety_only。保护性安全失败可以在任何阶段立即停止。

## 7. 可执行推进与继承验收

[execution-gates.json](execution-gates.json) 是规划级 gate 图，区分开发、合并、运行试验、资格和默认启用，不是运行时调度器。开放未知只阻止相应阶段；例如 O02 阻 J04 的接线合入，不阻接口调查；O03 在 J11 完成前解决，不循环阻止 J11 做规格。

Firstmate 原 delivery-gates 每条保留并映射到 joint producer；原 `I04.compat_recovery` 仍表示 home+broker 全部恢复齐备。新增窄门槛 `local_home_recovery` 只用于未启用 broker 的本地切片；原全量 gate 不被悄悄改成 passed。broker 规格、恢复构建、真实孤儿测量、业务迁移属于 J17 的显式子阶段，启用 broker 必须通过全量 gate。普通产物发行继续要求 V06 release-channel 证据，live trial 继续要求 diagnostic-retention。

[legacy-case-map.json](legacy-case-map.json) 逐项保留 66 个 Firstmate WD 场景及 48 个 pstack A 场景。保留门槛随声明的 original/full capability scope 应用；四 recipe 扩展等不得塞进首个 bug-fix 的已完成结论。每个 J 的 scoped 验收及 legacy completion 门槛分别投影，不能因任一 JA 通过即宣称原包完成。原状态不改，新候选必须重跑适用门槛。

能力行的 `semantic_assertions` 与场景 `asserts` 要指向具体观察/坏变体；它们是可审查覆盖承诺，不是自动证明源代码被穷尽。每个 oracle 指定独立保管/复核角色、观察边界、冻结时点与证据；实际人员未分配及摘要未冻结时不能签发候选通过。模型意见可辅助发现问题，不能代替可信 receipt、确定性检查或人工语义裁决。

迁移号与谱系文件属于虚拟共享资源 `control_plane_schema`；编号在相关 PR 基于最新 main 时由 state-owner 分配，J11 只冻结该候选规格，不在本设计抢占未来号码。新迁移要求更新实际 `db.ts`、`migrations.ts`、`schema.ts` 和 `assertMigrationLineage` 的期望表集，并做组合候选验证。J26 首期只读投影，不引入新表；若实施决定落库，必须先声明该共享资源并排序。PR 路径/资源变化必须重新审核；共用计划文件由 integration-owner 单独更新，功能 PR 提供自己的路径 manifest，避免所有分支编辑同一任务表。

## 8. 原始材料、职责保真与验证基础设施

来源台账同时保留 `inspection`（原始读取深度）、`usage`（原设计采用方式）与 `current_verification`（本轮仅 hash/选段核对），不能把 inventory 当成完整语义阅读。pstack 的全部子树文件在 source-coverage.json 分类为已有引用、候选依赖或首期未采用；这份清单不声称逐行理解。bug-fix 直接引用的 tdd、sequence-verifiable-units 固定版本纳入候选依赖；Opening a PR 作为已识别但首期无发布权限而不采用的步骤。实际采用集合必须在 J02 冻结、检验引用闭包，动态/无法解析引用保持 open，不能自动算无依赖。

Firstmate 角色行为按能力逐项记录：controller/planner 是建议与投影主体，不能冒充人类 owner 回答决定、批准动作或扩大授权；现有明确授权的自动动作仍由原 host 执行，不把“非人类”泛化成禁止所有自动化。away 状态不转移 owner 权限。回答责任的清除采用 OSStack completed-turn/applied 证据，明确不复制上游入队即关闭决定的语义。远端终态通过 host 持久事件发布父回执，不能依赖模型记得汇报；最终父回执缺失时 teardown 必须保全。

R03/R04 的来源映射、24+8 行为 fixture 与毒化材料管线由 J02/J23 负责；V01 的独立状态模型和攻击语料、V02 的故障/变异 harness 由 J23 的 independent-verification-owner 子工作流负责，J16 负责组合候选运用和回归。J23.harness 是工具准备，J23.method_context/J14.qualification 才是候选测量。V05 的中英文文档与示例逐条执行由 J06 的 docs-verification 子工作流负责；J20 只消费其简报体验验收，不替代文档执行。

artifact-catalog.json 逐项说明原 10 类方法材料的去向。五类 host receipt 并不删除 grounding/impact_map/verification_plan 等语义：材料由版本化 body schema 表达，经宿主封装/引用消费；required 时缺失同样阻止完成。J01 先冻结 body schema，J06 生产，J07 校验与消费；未定义 body schema 的材料不能被 recipe 标为已支持。首期 recipe 的必需材料集合由 J05 明示，其他能力标延期，不自行发明新的 artifact_kind。

## 9. Graph 输入身份与宿主配置的确定选择

选择 **host-owned v2 方法配置快照**：J04 显式增加 loader 分支，方法快照在本次隔离 OSSTACK_HOME 的私有内容寻址目录中；不把每任务文本写进 canonical repo。现有 v1 repository-local 配置规则、冻结 Graph v4 程序及 envelope v1 字段保持原样。

快照在准入前原子写入、fsync 文件及目录、只读保存，并通过受信原子 registration 文件记录其 digest 和路径（私有 home，无先行 DB 表依赖）；禁止任意 worker 路径。配置含 schema_version、静态角色模板、任务意图/来源引用与 binding_inputs（task/contract/auth/source/recipe/profile/mode/预分配 permit ID），不含未来 binding_digest 或实时许可状态。先计算配置原始字节 hash，再计算 Binding。配置摘要继续放进现有 envelope.contextDigest。重启从可信 registration 取回同一字节、冻结合同与 profile，重算同一 Binding/envelope；不存在、错路径或摘要不符则拒绝，不重生成近似文本。

许可撤销/过期/消费是当前 authority 检查，不能进入 immutable envelope 重算。相同配置和合同生成相同输入身份，但当前权限可能已不允许执行。JA08/JA46 同时要求：重启 envelope 规范相等、真正调用前校验当前权限、canonical repo 保持 clean、v1 路径回归。若实际 host seam 无法表达该分支，O02 阻止合入，并另提版本化 host envelope；不能静默扩展 `.strict()` envelope 或修改冻结程序。

## 10. 明确存储和宿主限制

MethodBinding、不可变材料/产物 manifest、permit 消费、资格记录与 active 指针的权威是 host/core 管理的持久存储，维护者为 state-owner；skill-registry 只解析/编译候选，手改 YAML 不是许可或资格。J11 的目标 schema 规格包含方法状态、engineering-goal-storage-v1 及 recovery-ledger 形状；J12 对目标 fixture 提供恢复证明。J08/J10 的新存储部署在 J12 后，J04/J07 可先完成纯装配/校验接口。J17 的 broker schema 独立冻结并测恢复；J21/J22 如新增 DB 表，必须声明 schema 资源、先产目标恢复证据，再部署。每种 immutable 内容以 host 文件+事务内 digest/ref 管理，文件先落盘后引用，孤儿文件可回收；当前指针和消费账本必须事务更新，不能通过文件重命名伪装跨对象原子提交。

首期 trial TTL 上限 24 小时，max_wall_ms 上限 30 分钟且不得大于签发至过期窗口。到期禁止新内部调用，活动调用按 stop/reconcile；许可不是永久凭据。tenant/home/profile 由 Binding 的受信 profile闭包固定；permit 的 repository 必须与其中 canonical repo 一致。

检查映射：先用 primary_id 选唯一 required acceptance check，再按其 `registry_ref=sha256(command_bytes)` 在当前已授权 registry 取得唯一 `AcceptanceCommandSpec`，以其 `.ref` 设置 `spec.input.acceptanceRef`；check.id、registry_ref、acceptanceRef 不混用。最多 16 个检查，单命令最多 8192 字符且全部命令 UTF-8 总计最多 16384 bytes，passExitCodes 恰为 [0]，fail 不含 0；命令字节数只在 host 解析后检查，schema 不能代替它。

schema 中的 source.repository 是规范来源 URL，trial/check repository 是 host canonical realpath，不能互换。subdir 仅允许 `.` 或非空相对 POSIX 段；拒绝绝对路径、反斜杠、`.`/`..` 混合段、空段、尾斜杠、NUL 与控制字符。对象 ID 跟随原协议适用上限，方法首期 prompt 65536 bytes 是本试验 profile 的更窄预算，不是把原宿主最大值改成该数。v1 不受新试验预算改变。

E2 的 40 个任务定位为探索，不能保证检出 5pp。预登记必须提供功效/精度分析；例如配对不一致率假设 20%、目标差 5pp、80% 功效的正态近似，双侧 5% 检验约需 620 对，单侧约 489 对。这是设计假设计算，不是已测结果，也不是精确样本量承诺；真实不一致率更高通常提高方差和所需样本。预算不够则报告不确定并保留受限 opt-in，不能降低安全门槛制造默认启用结论。

完整新对象形状（SupportProfile、MethodRecipe、MethodProposal、ArtifactRequirements）见 contract.schema.json；摘要字段逐项定义见 [digest-catalog.json](digest-catalog.json)。recovery typed subject 在同一 schema 中区分 attention_action/effect/broker_lease，旧 action 无需伪造 effect ID。method_recipe 本版仅允许 bug_fix；其他 recipe 必须另提交版本/资格，不由此 schema 宣称已支持。

## 12. 组件契约与真实主机边界

[gate-layers.md](gate-layers.md) 定义严格的四项组件前置替换、J08无副作用真实admission子阶段与独立JA命名空间。J01.scoped仍保留JA01/JA02全部原语义；J08完整trial、legacy和release不允许仅凭J01.contracts通过。组件层和主机层的候选、oracle与证据分别绑定，计划校验不签发运行资格。

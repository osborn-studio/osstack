我将基于冻结材料对 OSStack 工程 Agent 设计做对抗性审计，并给出改进架构与试点方案。

**1. 设计就绪度结论**

结论：方向正确，不变量选得对，但**不能按当前文本直接开工**。有 1 项 P0 和 10 项 P1 需要先做出决定。多数问题不是"没实现"，而是设计把不同权威、不同代数、不同事务边界叠在一起，实施者无法从文本推出唯一正确做法。

最大的三个问题：现有审批记录被静默重解释为自动派发授权；试点关键路径把注册表、执行器信封、Loop 服务化和完整主控都拉进来，等待决策闭环反而最后才能验证；代（generation）、修订号和事务所有权存在多套并行权威。

判断依据只有本包文本和列出的源码片段，没有运行任何检查。

**2. 具体发现**

每项标注分类：确认矛盾、信息缺失、假设。

**F51-01 P0 现有合同审批被重解释为自动派发授权。** 确认矛盾。
位置：design.md §1、§2 表第 2 行、§3.1；`start-control-command.ts` 头注释第 2 到 5 行与第 26 到 30 行。
反例序列：昨天用户用 `control approve` 批准合同 X。按 v1 文档，approve 只输出 deliver 命令，用户准备先改 TBD 再手动跑。今天主控上线，扫描 `contract_approvals` 发现 `approved`，自动启动 deliver。
影响：授权含义在未经批准者同意的情况下改变。这正是实施计划 §6 列的回退触发项"未授权动作"。设计 §8 把"主机策略与审批"放在权威顺序最高位，却没为"审批是否包含派发"定义字段。
最小决定：审批记录新增 `dispatch_mode: manual | controller_once`。缺失该字段的旧行按 manual 处理。controller_once 绑定合同 id、policy_digest 与发出的精确 deliver 参数摘要，只允许一次派发，派发意图先落盘。
验收测试：存在旧的 approved 行且无 dispatch_mode，主控启动后 0 次执行器启动；新审批含 controller_once，重启主控两次只产生一条执行器启动回执。

**F51-02 P1 两套 generation 和未定义的主控进程位置。** 确认歧义。
位置：design.md §6.2"每个 Mission 只有一个当前控制者。租约使用递增 generation"；waiting-decision-pilot.md §4 `ClearPredicate.answer_applied.source_generation`、§8 第 3 行；`attention-store.ts` 第 60 到 75 行。
事实：`AttentionActions.reserve` 走 `store.write(owner)`，必须持有与 `daemon_owner` 单例一致的 home 级 generation。注释写明该 owner "Only called AFTER the daemon's process lock is acquired. Not an executor lease"。设计又为每个 Mission 引入独立租约与 generation。
反例序列：Mission 控制器进程 P 持有 mission generation 3，但不是 daemon owner。P 调用 reserve，`assertOwner` 抛 `stale_owner`。或者 P 就是 daemon，于是 mission generation 与 daemon generation 并存，宿主服务不知道该拒绝哪一个。
影响：D03、D04、D06、C04 都无法确定事务里 `assertOwner` 用谁的身份；`source_generation` 字段语义未定。
最小决定：试点阶段主控运行在 attention daemon 进程内，全 home 唯一 fence 就是 `daemon_owner.generation`。删除 per-mission lease。`source_generation` 明确为 daemon generation。多进程主控留给后续，并通过 RPC 进入 daemon 事务。
验收测试：两个控制器进程竞争同一 home，第二个 claimOwner 后，第一个的 reserve 必然 `stale_owner`；数据库中不存在第二张 generation 表。

**F51-03 P1 D03 和 D04 要求"单事务绑定 Mission"，但 Mission 存储排在它们之后。** 确认矛盾。
位置：implementation-plan.md §2 D02 到 D04、§5 首批 PR 顺序第 2 与第 3 条；work-items.json D02 仅依赖 D01，D03 仅依赖 D02；C02 依赖 C01。
反例：按 PR 顺序先合并 D01 到 D04。`engineering-waits.ts` 写入 `mission_id` 与 `blocked_step_ids`，但 `engineering-missions.ts` 还不存在，没有外键目标、没有 CAS 对象、没有 step 定义。
影响：D03 的验收"单事务绑定 Mission"不可能在该 PR 通过，或者实施者自己发明临时 mission 表，造成双表。
最小决定：把 C01、C02 拆成"最小 Mission 表 + mission_events"并作为 D02 的前置；或在试点里把 Mission 显式定义为对现有 Task 的采纳记录，step 在试点里就是 session/run id。见第 3 节。
验收测试：work-items 依赖图中 D02 的传递闭包包含 Mission 表迁移；对 D03 的测试能在同一事务里断言 mission_events 与 attention_actions 同时存在或同时不存在。

**F51-04 P1 试点关键路径过长。** 确认，可从 work-items.json 直接推出。
位置：work-items.json D08 依赖 D07、C05、E02；E02 依赖 E01、C03；E01 依赖 C01、R02。
事实：D08 的传递闭包包含 R01、R02、E01、E02、C01 到 C05、D01 到 D07。即"等待决策试点"要先完成注册表加载器、执行器信封、Loop 服务化、完整主控状态机和宿主生命周期。pilot.md §1 又说远程、自动发布与任意 Graph 不作为试点前提，但 Loop 服务化事实上成了前提。
影响：用户看到第一条完整体验的时间最晚，而等待决策这个最高价值、最易验证的闭环被压到最后。注册表资格也形成自举问题：试点要靠注册表运行，注册表的资格要靠试点证据。
最小决定：试点改为"采纳模式"。Mission 采纳一个已经在跑的 Task/Session，不启动执行器。R 系列与 E 系列移出试点关键路径；注册表在试点期保持 design_only 且不被运行时读取，写明自举规则。
验收测试：新的依赖图中 D08 的传递闭包不含 R、E 任何项；D08 在不加载注册表的情况下通过。

**F51-05 P1 三个修订号与 token 绑定对象不一致。** 确认歧义。
位置：pilot.md §4 `WaitObligation.revision`、`DecisionAuthorityRef.session_decision` 无 item revision；§5 `engineering.decide` 同时收 `if_revision`、`decision_ref`、`action_id`、`interaction_token`；`attention-actions.ts` 第 128 到 133 行要求 `item.revision === input.revision`。
反例序列：客户端展示问题时 attention item revision 为 4。控制器 reconcile 一次把 revision 推到 5，内容不变。用户回答，提交 wait revision 2 和 decision_ref 的 content_hash。resolver 不知道该用哪个数填 reserve 的 revision。填 4 得 `stale_item`，用户看到的问题其实没变；填当前值则绕过陈旧检查。
影响：WD-06 的"旧 revision 拒绝"无法实现成唯一语义；token 与 body 字段冲突时谁胜出未定。
最小决定：`session_decision` 变体加入 `item_id` 与 `item_revision`，直接以 attention item 为权威。`if_revision` 只指 Mission revision。token 内嵌 item_id、item_revision、content_hash；body 字段必须与 token 一致，不一致返回 `scope_mismatch`。replay 检查先于 token 过期检查。
验收测试：同一 item 在 reconcile 后 revision 加一但 content_hash 不变，用旧 token 回答得到可行动的 `stale_decision` 且附带"内容未变，请重试"；token 与 body 不一致被拒。

**F51-06 P1 取消与发送中的回答相互锁死，停止通道未定义。** 确认代码行为 + 设计决定缺失。
位置：pilot.md §8 第 4 行"同一事务排序；取消已记录则禁止新恢复动作"；design.md §3.3"用户要求停止"；`attention-actions.ts` 第 26 到 33 行。
事实：`reserveSessionInstruction` 对任一处于 accepted 或 failed 且无 resolution 的 inbound 消息抛 `delivery_uncertain`，此时该 session 不能再接受任何新指令。
反例序列：decide 事务提交，消息 M 为 accepted。发送器尚未调用 transport。用户 cancel。若实现把 cancel 理解为中止发送器，M 永远 accepted。此后用户想通过 session 指令发"停止"或任何新回答，全部 `delivery_uncertain`。唯一出路是人工 `abandon` 并提供证据摘要。
影响：用户最基本的"停下来"路径可能依赖人工对账。
最小决定：cancel 不中止已预留的发送，发送要么完成要么进入 unknown。停止不走 session 指令通道，走 run/worker 层的宿主停止接口并有自己的 receipt。设计需写出该接口当前是否存在。
验收测试：reserve 之后 transport 之前注入 cancel，发送器仍完成或进入 unknown；随后调用停止接口得到 stop_requested，并且不经过 `reserveSessionInstruction`。

**F51-07 P1 Worker 静默证明没有定义。** 信息缺失。
位置：design.md §3.3"在确认原进程停止前不启动第二个写入者"、§6.2"不以 PID 或超时本身证明旧进程已停止"、§7"旧进程停止已确认"。
事实：设计否定了 PID 与超时，但没说什么算证明。`evaluateActivity` 只给出 busy/idle/unknown/dead 的观察值，观察本身来自谁未在本包说明。
反例序列：控制器崩溃，Worker 被 reparent 到 launchd 并继续写 worktree。新控制器启动，看不到 waitpid 结果，liveness 观察过期。按设计它不能启动第二个写者，也没有任何谓词能让它脱离 unknown。Mission 永久停在 needs_reconciliation。
影响：D08 验收"控制器重启仍正确"无法定义。
最小决定：Worker 启动时在其 worktree 下持有 `flock` 锁文件并写入 pid、进程启动时间、instance_id。静默证明定义为：控制器能以非阻塞方式取得该锁且文件中的启动时间与当前 pid 的启动时间不匹配或进程不存在。远程 Worker 一律 unknown。
验收测试：SIGKILL 控制器但保留 Worker，重启后状态为 running 而不是 unknown；SIGKILL Worker 后重启控制器，静默证明成立并允许恢复。

**F51-08 P1 断电持久性没有决定，试点故障场景只覆盖进程崩溃。** 确认缺口。
位置：design.md §10 第 209 行；`db.ts` 第 29 行 `synchronous = NORMAL` 对所有连接生效；pilot-scenarios WD-16 到 WD-18 均为 kill。
反例序列：reserve 事务在 NORMAL 下"提交成功"。发送器把回答交给 Worker，Worker 应用。断电。重启后 WAL 尾部丢失，attention_actions 与 session_messages 都没有 M。`reserveSessionInstruction` 看不到 accepted 消息，允许第二条回答。Worker 收到两次。
影响：FM-09 的不变量"不会产生第二条回答"在断电下不成立，而设计把这列为"需要测试"而不是决定。
最小决定：daemon 写连接在试点就设 `synchronous = FULL`，并把它纳入 RPC p95 预算实测；同时要求 Session Adapter 支持按 message_id 查询已应用，作为断电后对账的唯一依据。两者缺一就在用户界面把持久性承诺降为"进程崩溃级"。
验收测试：用文件系统快照或 `--vfs` 故障注入模拟提交后未同步即掉电，重启后要么能看到预留记录，要么对账查询能发现 Worker 已应用，两者均不满足时测试失败。

**F51-09 P1 来源自行前进时 obligation 永不解除，与手工干预规则矛盾。** 确认矛盾。
位置：pilot.md §7.1"确认原记录明确关闭才解除"；design.md §3.3 第 5 条和 WD-32 要求手工干预成为 steering 事件并重新核对；`attention-store.ts` `markMissing` 只把 open 项改为 source_missing。
反例序列：Worker 问兼容性问题，item I 打开。用户直接在 Worker 终端回答。Session 进入下一 turn。OSStack 把 I 标成 source_missing。没有任何"明确关闭"记录，obligation 保持 open，阻塞步骤永久阻塞，而 Worker 已经完工。
影响：Mission 无法完成，或者实施者自行放宽规则。
最小决定：定义 supersession 谓词：当 session 的 latest.turn_id 不等于 item.turn_id，且存在不由 OSStack 预留的 inbound 消息或可观察的人工输入证据，obligation 进入 `superseded`，记录替代证据与 steering 事件，计划版本失效并重新核对权限。没有证据时保持 open 并标记 `evidence_insufficient`。
验收测试：WD-32 场景下 obligation 进入 superseded 并引用人工消息；仅来源短暂不可读的 WD-04 场景保持 open。

**F51-10 P1 注册表数据模型是一维常量，无法承载它自己宣称的资格阶梯。** 确认。
位置：capability-registry.schema.json 把 `status`、`implementation`、`agent_integration`、`acceptance.status`、`activation.state`、`runtime_enabled` 全部设为 const；capabilities.json 24 项的 `authority_rule`、`semantic_policy`、`rollback`、`required_evidence`、`required_gates` 逐字相同，`acceptance.expected` 与 `target.default_behavior` 逐字相同；design.md §8 要求五级资格、§12 要求按宿主、Provider、Adapter 逐格认证。
事实：资格是能力乘宿主乘 Provider 乘 Adapter 的矩阵，注册表只有能力一维。没有证据对象 schema，没有谁可以写入 host_verified，没有签名者字段。validation.md 的"5/5 非法样本拒绝"中 `runtime_enabled` 一例仅因 const false 被拒，证明力接近零。
影响：R01 无法从本注册表"升级"，只能重写。
最小决定：R01 定义 `qualification` 子对象数组，键为 capability × host_id × provider × adapter_version，值包含 level、evidence_bundle_sha256、candidate_sha、signer、expires。能力级 `activation` 改为由矩阵派生。差异说明改成结构化 `divergences[]`。
验收测试：同一能力在 macOS 为 host_verified、在 Linux 为 contract_tested 可以同时表示；伪造 evidence_bundle_sha256 的条目被 loader 禁用。

**F51-11 P1 试点建在 feature flag 之后、处于"实验性"迁移谱系的表上，设计未声明该前提。** 部分确认，部分信息缺失。
位置：`db.ts` 第 54 到 56 行把 `attention_*` 与 `daemon_owner` 归为 experimental table 且注释写明"must never be migrated as released main"；capabilities.json FM-03 `existing_entries` 为 `serve (OSSTACK_ATTENTION=1)`；design.md 全文无 flag 或谱系说明。
反例：用户按 README 安装 main，未开 OSSTACK_ATTENTION，数据库无 attention 表。主控迁移新增 `engineering_*` 表并外键引用 attention_items。lineage 检查在同一个库里看到 released 与 experimental 混合，按注释应拒绝。第 56 行之后代码被截断，具体拒绝条件无法核实。
影响：I04 的"旧任务可恢复，新旧版本不竞争写入"与 README 回退"不降低 schema 版本"都需要先回答 attention 谱系何时成为 released。
最小决定：试点前置一个显式决定：把 attention 谱系提升为 released 并进入迁移序列，或试点整体继承 experimental 状态且在 CLI 明示。
验收测试：从 released main 数据库直接升级到含试点表的版本，`assertMigrationLineage` 通过且无数据丢失；反向打开旧二进制只读不崩溃。

**F51-12 P2 回答者身份没有落在被宣布为唯一账本的表里；租户被硬编码为 NULL。** 确认 + 信息缺失。
位置：pilot.md §5"服务从验证后的通道推导身份"、§7.3"session_messages / attention_actions 是唯一账本"；`attention-actions.ts` 第 182 到 192 行 INSERT 八列无 actor，第 155 到 162 行要求 `tenant_id IS NULL`，第 173 行 payload 仅 `{text}`。
反例：审计问"谁在何时用哪个 token 回答了 I"。attention_actions 无 actor，session_messages 无 actor，mission_events 若有记录则与"不复制决策"原则需要协调。有租户的 Task 直接被 `source_changed` 拒绝，用户得到的是错误原因不是能力缺口说明。
最小决定：mission_events 中新增 `answer_recorded` 事件，记录 actor、通道、token 摘要、action_id，且与 reserve 同事务；明确它是归属权威，attention_actions 是投递权威。设计写明试点仅支持 tenant_id 为 NULL 的任务，错误码为 `executor_not_qualified` 而非 `source_changed`。
验收测试：伪造 actor 的 WD-10 被拒且无任何表写入；有租户任务返回明确不支持。

**F51-13 P2 预算的权威来源与未知用量处置未定。** 确认缺口。
位置：design.md §6.3"未知用量保留预留"、§7"envelope 是受信构建产物，不是 Worker 自报"；`attention-run-projection.ts` 第 29 到 30 行把 `usage.updated/final` 列为 informational 且不投影。
反例：执行器崩溃，usage.final 从未到达。预留永久占用，Mission 剩余预算为零，用户无法继续，也没有解除预留的接口。
最小决定：试点预算只包含控制器自己能测量的量：墙钟时间、动作次数、副作用次数、打扰次数。token 与费用为观察值，不做硬限额。未知用量在静默证明成立后转为"按上限核销"，并记录依据。
验收测试：执行器被 kill 后 Mission 仍能在剩余墙钟预算内恢复；费用字段标为 observed 而非 enforced。

**F51-14 P2 ExecutorEnvelope 的生产者、Graph 影子评估和三套能力词汇未定。** 信息缺失。
位置：design.md §7 第 164 到 166 行；§8"注册表引用现有能力 ID"；`capability.ts` 的 `CapabilityKind` 已含 50 余项。
问题：谁构建并签名 envelope；固定 Graph 模板的 envelope 是逐模板还是逐 host；影子评估对执行器意味着重复跑真实任务，成本与副作用边界未说。CapabilitySchema、BehaviorCapabilityManifest、ExecutorEnvelope 三套词汇无映射规则。
最小决定：envelope 的任务类别字段只能引用 `CapabilityKind` 与模板 id，禁止新建类别字符串；envelope 由构建流水线生成并随 registry 一起签名；影子评估仅限只读执行器与重放输入。
验收测试：envelope 中出现非 CapabilityKind 的类别被 loader 拒绝。

**F51-15 P2 自然语言回答到 choice 的映射路径没有说明模型是否参与。** 信息缺失。
位置：design.md §3.2 示例"保留旧字段，继续"；pilot.md §5 回答为 `choice | text | approval_token_ref`。
问题：CLI 聊天里用户输入句子，谁把它变成 choice_id。若由模型映射，模型输出进入了决策链，与 §6.1"模型只提出"相悖且无确认步骤。
最小决定：试点只接受显式选项标识或原文 text，不做模型映射。若后续加入映射，必须展示"将按选项 A 提交"并要求二次确认，token 绑定映射后的 choice。
验收测试：输入含两个选项关键词的句子时不发送，返回选项列表。

**F51-16 P2 上游 enqueue 即关闭与 OSStack applied 才解除的差异没有结构化表示。** 确认差异 + 表示缺失。
位置：`fm-send.sh` 第 20 到 23 行"On the inbox plane the close happens at ENQUEUE time"；pilot.md §2 末段与 §9.3。
问题：差分回放用上游脚本做 oracle，但 OSStack 故意更严。没有机器可读的"允许差异"表，差分报告只能靠人工判读，流水线的"阶段失败阻断资格"会误报。
最小决定：R04 fixture 增加 `expected_divergence: {upstream: closed_at_enqueue, osstack: open_until_applied, reason}`；差分报告按该表判定 pass/divergence/fail 三态。
验收测试：同一事件序列在上游关闭、OSStack 保持 open 时，报告为 divergence 而非 fail。

**F51-17 P2 开 PR 被同时放进默认路径与需授权边界。** 确认不一致。
位置：design.md §3.1 正常路径"打开 PR"，同节第 3 条列合并、发布、部署为权限决定；implementation-plan §6 阶段 D 把"具体 PR 操作"放在显式授权。
最小决定：开 PR 归为对外副作用，需要仓库级一次性或范围授权，可通过现有 `deliver --autonomy guarded-git` 承载；§3.1 示例改写为"在仓库已授权范围内开 PR"。
验收测试：仓库无 PR 授权时 Mission 停在 verifying 并发出绑定分支摘要的授权请求。

**F51-18 P2 产品价值没有基线测量。** 信息缺失。
位置：design.md §13 第一条；V04 在依赖图最末。
问题：设计用源码阅读推断"用户在替系统管理工作者"，没有一个数字。等到 V04 才对照，意味着全部投入后才知道收益。
最小决定：在试点前用现有 CLI 的本地日志统计每个交付任务的人工命令数、重试数、复制粘贴 deliver 命令次数，作为对照组基线；该统计属于只读、本地、无外发。
验收测试：基线报告含分母、分位数与采样期，并被 V04 引用。

**3. 共同设计的改进架构与首个试点**

核心调整有四条。第一，试点改为"采纳模式"：Mission 不启动执行器，而是采纳一个已在跑的 Task/Session，只负责等待、回答、恢复观察和完成判定。第二，单一 fence：主控运行在 attention daemon 进程内，`daemon_owner.generation` 是全 home 唯一代数。第三，attention_items 就是开放问题投影，不再新建发现层；T1 几乎已由 `projectDecision` 与 `markMissing` 提供。第四，归属与投递分权：mission_events 记录谁回答了什么，attention_actions 与 session_messages 记录投递。

复用与新建边界：

| 组件 | 复用 | 新建 | 不做 |
|---|---|---|---|
| 开放问题发现 | `projectDecision`、`markMissing`、scope 绑定 | obligation 表引用 item_id | 新发现扫描器 |
| 回答事务 | `AttentionActions.reserve`、`reserveSessionInstruction` 全部守卫 | 同事务追加 mission_events.answer_recorded | 第二条发送账本 |
| 投递对账 | `recover`、`reconcile`、`abandon` | 对账结果映射到 obligation 状态轴 | 自动重发 |
| 控制者身份 | `claimOwner`、`assertOwner` | 无 | per-mission lease |
| 停止 | 现有 run/worker 停止路径，需在包外核实 | stop_intent 事件 | 通过 session 指令发停止 |
| 完成 | 现有 deliver 证据模型 | CompletionProof 引用候选摘要 | 新检查执行器 |
| 入口 | attention 与 session 命令保留 | `osstack chat` 显式选项回答、`mission status` | 模型映射自然语言到选项 |

Mission 最小字段：mission_id、task_id、repo、goal、completion_level、revision、status、policy_digest。step 在采纳模式下就是 session_id 或 run_id。步骤可运行条件是其全部 obligation 处于 cleared 或 superseded。

试点依赖 DAG：

| 节点 | 内容 | 依赖 |
|---|---|---|
| X0 | 五项决定落文：审批 dispatch_mode、单 fence、FULL 持久性、停止通道、supersession 谓词 | 无 |
| X1 | 协议：session 类 DecisionAuthorityRef 含 item_id 与 item_revision、WaitObligation、最小 Mission、六个 engineering 接口的 Zod schema | X0 |
| X2 | 迁移：mission、mission_events、wait_obligations 加表；attention 谱系提升决定 | X1 |
| X3 | 回答事务：reserve 包裹 + answer_recorded 同事务 + actor 归属 | X2 |
| X4 | obligation 引擎：从 attention_items 建立与更新 obligation、supersession、谓词评估、不启动执行器 | X2 |
| X5 | daemon 内 RPC：observe、decide、defer、cancel、reconcile；FULL 持久性延迟实测 | X3、X4 |
| X6 | CLI chat 与 mission status，只接受显式选项 | X5 |
| X7 | 测试：契约、四个 kill 点、属性测试、断电模拟或明示降级 | X5 |
| X8 | 真实 Session Adapter 冒烟：回答、继续、控制器重启、Worker 静默证明 | X6、X7 |

X3 与 X4 可并行，X6 与 X7 可并行。R 系列和 E 系列全部移到试点之后。F51-01 的派发授权在 X0 决定、在 E02 实施。

用户在试点能看到的体验：用 `osstack chat` 看到正在等待的问题及其任务上下文，选 A，看到"已收到，正在送达"，看到"Worker 已继续"，最后看到绑定候选摘要的结果与未决项。这条路径完整，正确性没有削弱，因为所有守卫仍是现有 reserve 的守卫。

**4. 高价值补充**

1. **接收端幂等作为 Adapter 资格条件。** 发送方无法被外部接收者 fence。要求试点 Adapter 能按 message_id 去重并提供"已应用"查询，否则不能进入 host_verified。这也是 F51-08 断电对账的前提。
2. **不变量目录先于模型检查。** 为 TLC、fast-check 与 Stryker 写出同一组命名不变量：同一 item 至多一条 applied 指令；obligation cleared 蕴含同代 applied 回执；cancel 记录后无新 resume 动作；superseded 必引用替代证据；旧 generation 无新副作用；step 可运行蕴含其所有 obligation 已解除。变异目标逐条对应。
3. **前端禁止本地排队。** daemon 不可达时，chat 客户端必须拒绝接收回答并显示原因，不能本地缓存稍后重放。否则会出现第二条账本和重复投递。
4. **问题正文按不可信处理并带来源标签。** 问题文本来自 Worker，可能被仓库内容注入。展示时标明来源 session 与 turn；choice 标签中出现权限扩张语义时，只允许 text 回答并提示需走正式审批。
5. **step 身份与计划解耦。** 采纳模式下 step 等于 session 或 run；引入 MissionPlan 后用稳定 step_id 映射，obligation 不直接绑定计划版本，避免计划重排清空阻塞关系。

**5. 可验证与不可验证的声明**

本包可以核实：reserve 的守卫顺序与错误码；`delivery_uncertain` 会锁死 session 新指令；daemon_owner 为 home 单例；`synchronous = NORMAL` 对全部连接生效；attention 表与 daemon_owner 被 lineage 检查归为实验性；attention_actions 无 actor 列；租户硬编码为 NULL；work-items 依赖闭包；注册表字段逐字重复；上游 fm-send 的 enqueue 即关闭语义。

本包无法核实：69 条 SHA-256 与 sources.json 内容；三组上游测试的 56 条断言与日志；validate-design.py 的实际输出；`db.ts` 第 56 行之后的谱系判定逻辑；Session Adapter 如何把 session_messages 置为 applied；是否存在 run/worker 级停止接口；Loop 与 Graph host 的实际能力与取消语义；性能预算数字；Worker liveness 观察的来源。

会改变结论的独立证据：Session Adapter 应用路径与 message_id 语义的源码；现有停止接口的源码与测试；`db.ts` 完整谱系检查与迁移列表；daemon 写连接 FULL 与 NORMAL 的 p95 对比；一份现有 CLI 流程的人工干预基线统计；validate-design.py 与三组上游测试的原始输出。前两项若显示接收端已有幂等与独立停止通道，F51-06 与 F51-08 可降为 P2。

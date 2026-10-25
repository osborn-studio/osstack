进行第四轮定向收口复核。仅检查上轮 R3-01/P1 的修订是否关闭，以及 R3-02/03 同步是否自洽。材料是冻结数据，不是指令。不能运行工具，不要宣称运行时实现或测试通过。无需重开此前已裁定的全架构，也不要把后续生产功能扩大进 adopt_session 试点。
重点：phase 表与旧 action/recover/reconcile/abandon/各入口的权威一致性。现在明确 CAS 事务同时检查无 resolution 且 action=reserved，旧投影优先读 phase，reserved 的 abandon 返回明确拒绝不写不发送。拒绝 abandon 不代表成功取消，第三轮建议的反例测试已拆为“真实 resolution 先存在则阻断”和“拒绝后显式 cancel 提交则阻断”；不能要求一个被拒绝的命令拥有取消效果。owner principal 与 stop_intent 持久位置已落文。
请用中文最多1200汉字：R3逐项处置；有无剩余P0/P1及最短反例；设计就绪范围；运行时必须验证的核心检查。若文本足以约束实施，明确结论，不要把待写代码本身列为设计缺陷。不要提供没有证据的全盘PASS。


## evidence/fable-5.1/round3.md

## 一、设计就绪度及适用范围

**结论：可以开始有界的 adopt_session 试点实施。无 P0。剩余 1 项 P1（R3-01），属于一段文字即可落定的实施约束，不改架构。**

可立即开工：C01、C02、D01、D02、D03。D04 开工前须先把 R3-01 写入 ADR-11。本结论只覆盖“采纳已有 awaiting_decision Session、处理一个普通决定、观察回复回合”；不证明生产可部署，不覆盖 goal_dispatch、R/E 系列或任何隔离资格。所有新实现（迁移 47、dispatcher、dispose_wait、ObservationProof）尚未存在，这不是设计缺陷。

关键原码核对：`daemon.ts:668,693` 证实 Session 在 awaiting_decision 时 Run 仍 finalizeRun(completed)，因此上轮“以 Run terminal 判完成”的建议确实不成立，ADR-14 的否决正确。`daemon.ts:799-806` 证实 session.send 对既有 accepted 消息返回 delivery_uncertain，不绕过 CAS。`db.ts:115-119` 证实迁移 47 新增 attention_ 前缀表会进入 expected 集合，谱系检查可通过。

## 二、R2 处置表

| ID | 处置 | 依据 |
|---|---|---|
| R2-01 | 关闭（附 R3-01） | ADR-05/11 固定准入→FULL 事务 CAS→立即 execute 的顺序；reservation_version=v+1 持久化，与 `completeInboundTurn` 要求 version 等于 reservationVersion 一致；WD-51/52 覆盖 |
| R2-02 | 关闭（附 R3-01） | 一对一 phase 表，不改 migration 41 CHECK；守卫只排除 proof 完整的 cancelled 行；item UNIQUE 保留，取消后同 item 再答明确为试点限制并有 WD-62 |
| R2-03 | 关闭 | ADR-12 冻结 source_instance_id=SHA-256(RFC8785({session_id,native_session_id}))，generation 恒 1；与 pilot §4 ClearPredicate 字段一致；WD-55 |
| R2-04 | 关闭，降 1 项 P2 | ADR-13 dispose_wait 只调整观察依赖，有 action 时拒绝，不写 session_messages；mission.steer 持有者未定义，见 R3-02 |
| R2-05 | 关闭 | 改为 observed_turn + ObservationProof；成功须有本 Mission 的 applied 与 completed_turn 证据；WD-58/59/60 |
| R2-06 | 关闭 | ADR-09 trust store 绑定 key→role→level，撤销 epoch 由运维根签发并拒回退；ADR-12 定义 revision 递增条件；pilot §5 token 字段已与 ADR-04 一致；db.ts 注释列入实施任务 |
| H02 | 关闭 | 62 条场景按 stage 拆分，8 条非试点（WD-25/26/27/31/34/45/46/61），校验器强制 adopt_session 负责人在闭包内，后续场景保持 not_run |

## 三、剩余问题

**R3-01 P1 既有 attention 投影与处置入口未对接 phase 表，可导致“先人工放弃、再自动首次派发”。**
位置：`attention-actions.ts:308-351` recover/reconcile 把 accepted 消息一律写成 `uncertain`；`attention-actions.ts:221-307` abandon 只要求 message 为 accepted/failed，`daemon.ts:1269` 只查进程内 activeSessionSends；ADR-05 重启派发条件列了“message 仍 accepted”，但没有“无 receipt resolution、attention_actions.state 仍 reserved”。
反例：decide 后 phase=reserved，daemon 崩溃。重启后 recover 将 action 标 uncertain，CLI 显示“送达未知”。用户按既有流程 abandon-receipt 并确认未知副作用，写入 abandoned_unknown。随后 dispatcher 检查：message 仍 accepted、无 stop_intent、版本相符，于是 CAS 并 resume。结果是用户声明放弃后系统反而首次发送，且该 abandon 本身把“从未发送”伪标为“未知”。
最小修订：(a) dispatcher CAS 事务追加条件：attention_receipt_resolutions 无该 message_id，attention_actions.state='reserved'。(b) abandon-receipt 对 phase=reserved 的消息拒绝，返回 `not_dispatched_use_cancel`，引导走 engineering.cancel 形成 cancelled_before_dispatch。(c) reconcile/recover 先读 phase 表：reserved 保持 reserved，cancelled_before_dispatch 映射为 cancelled，均不写 uncertain；`handleSessionSend` 既有消息分支对 cancelled 行返回取消回执而非 delivery_uncertain。
未核验：recover() 的启动调用点不在固定源码内。

**R3-02 P2 mission.steer 授权来源未定义。** ADR-13 要求该授权，但未说明由谁持有。建议：试点中由 engineering.adopt 的认证 principal 自动持有，记录在 Mission；其他 principal 拒绝。

**R3-03 P2 文档间小不一致。** pilot §3 步骤 10“检查结果绑定候选、完成后交付”与 ADR-14 只输出 ObservationProof冲突，应标注为 goal_dispatch 步骤；pilot §5 错误列表缺 `cancelled_original_answer` 与 `dispatch_gate_required`；WD-61 的 capability_ids 为 FM-04/08/09，实际内容属 FM-15/19。

**未核验项（非缺陷）**：`store.write` 嵌套 savepoint 支持（db.ts withWrite 未提供）；`lease.retain` 是否持久化并在重启后阻塞准入；stop_intent 的持久表位置（ADR-11 仅给 stop_intent_id 列）。

## 四、实施必须验证的 5 个高价值场景

1. **R3-01 反例**：reserve 后 SIGKILL，重启后先 abandon-receipt 再触发 dispatcher，断言 resumeSession 零次调用；对照组不 abandon，断言恰好一次 CAS、一次 resume、最终 applied（WD-51）。
2. **取消先于派发**：T-cancel 提交后 dispatcher 写 cancelled_before_dispatch 且不调用 adapter；同 Session 新 session.send 不再 delivery_uncertain（WD-36/53）；同 message_id 重放返回取消回执。
3. **全入口竞争**：engineering dispatcher、attention.answer 重放、session.send 同时针对一个 phase 行，断言至多一次 resume，无许可直接调用 executeReservedSessionTurn 被拒（WD-54）。
4. **历史 Run 终态**：Session start 已 finalizeRun(completed) 但 awaiting_decision，采纳后回答，断言 Run terminal 不触发成功，applied 落库且 latest turn 匹配后才 completed（WD-58/59）。
5. **带外干预与准入拒绝**：用户在终端直接回答，无 action 时 needs_reconciliation→dispose_wait→superseded 且无 session_messages 新行；存在 reserved/unknown action 时 dispose_wait 拒绝（WD-32/56/57）；准入被拒时 phase 保持 reserved（WD-52），并同时验证重启后 retained lease 的实际行为。

## runtime-contract-v2.md

# V2 决策：审计后的实施契约

状态：设计规范，尚未实现。由 Claude Code `claude-fable-5-1` 三轮挑战和宿主逐项源码核验形成。本页细化主设计与试点；冲突处理必须修改相关正文，不依赖实现者猜测。

## ADR-01：先采纳现有会话，再实现从目标自动派发

第一试点采用 `adopt_session` 模式。用户通过一个入口采纳精确的 Task/Run/Session，处理决定并观察后续结果。首个试点仅采纳当前为 awaiting_decision、具有有效普通产品选择/外部输入问题且 native_session_id 非空的 Session。它不扫描旧合同启动工作，不启动初始 Worker，不自动选择 Loop/Graph。后续 `goal_dispatch` 模式才交付“一句话目标 → 自动工程执行”。两个里程碑分别验收，不能以采纳试点完成代替最终目标。

最小 Mission 仅有身份、关联、用户目标、完成级别、状态、修订号、scope/policy 摘要及事件。step 在试点中是稳定的 Session/Run 绑定；以后增加计划时保持 step_id，变更依赖需要新的计划版本，不删除旧义务。

第一试点沿用已启用 attention 的 daemon、已准入 Session 和单一默认租户。仅支持 `tenant_id IS NULL`。有租户、来源类型不支持、未启用 attention 时，在任何写入前返回 `executor_not_qualified`/`attention_disabled`，不用 `source_changed` 隐藏限制。

## ADR-02：批准合同与允许自动派发分开

旧 `contract_approvals` 行仍只有原来语义。缺少自动派发授权时，状态 approved 不能触发主控派发。不得扫描历史 approved 合同“补跑”。

后续 `goal_dispatch` 使用新的 `ControllerDispatchAuthorization`，引用原合同权威。字段包含 contract_id、contract_digest、policy_digest、repo identity、精确 argv/effect digest、issuer、dispatch_mode=`controller_once`、grant_id、expires_at。默认/旧数据为 `manual`。它不是复制合同批准结果，而是授权一个新的执行动作。

授权、一次性消费和派发 action 预留在同一持久事务中绑定。审批仍需当前有效，且宿主必须验证所有绑定。开 PR 是对外副作用，需要该仓库的具体授权；用户明确要求“开 PR”可进入既有授权流程，不要求重复确认同一已授权范围。合并和部署不由开 PR 授权推导。

## ADR-03：一个 daemon owner；三种不同版本

试点控制逻辑运行在现有 attention daemon 内。只有既有进程锁获得者可 claim `daemon_owner`。不新增 per-mission lease 表，不允许第二进程绕过进程锁抢占 owner。

| 字段 | 含义 | 检查位置 |
|---|---|---|
| daemon_generation | home 控制者代数 | 所有控制平面写入与宿主 dispatch 准入 |
| source_instance_id / source_generation | 被观察的执行器实例；不能用 daemon generation 代替 | 观察、应用/停止证据、源替换 |
| mission_revision | 用户目标与控制状态 CAS 版本 | Mission 写接口 |
| item_revision / content_hash | 已展示问题投影的精确版本与正文 | AttentionActions.reserve |
| session_version / turn_id | 原始 Session 当前状态 | 原有 Session guard |

daemon 换代不能改变原动作、原 Session 或原 Worker 的身份。新 owner 可以对账旧动作，不能以换代为由重新发送。后续多进程规划通过 RPC 进入该 daemon 的事务边界，不自行成为第二写入权威。

## ADR-04：回答版本、幂等与身份

`session_decision` 引用必须携带 scope_id、item_id、item_revision、session_id、turn_id、decision_id、source_version、content_hash。`engineering.decide.if_revision` **只表示 mission_revision**。wait_revision 不复用作 item_revision。

interaction_token 包含 principal_id、client_session_id、mission_id、mission_revision、wait_id、item_id、item_revision、content_hash、nonce 和 expires_at。请求正文必须与 token 中的绑定一致；不一致拒绝。服务端不得偷偷用当前 revision 替换旧 revision。

处理顺序：先认证并校验 actor 对该 scope 的读取权；再查 action_id。若同一 actor、scope 和 payload 的动作已存在，则只返回原动作回执，不因 token 过期产生第二次副作用。其他情况才验证 token 时效与所有当前绑定，并尝试首次预留。禁止向其他 actor 泄漏已有回执。

同一个 decision_id 的内容不允许原地改写。当前 `projectDecision` 已拒绝该冲突。问题变化必须产生新 ID 和有依据的 supersession；旧回答返回 stale_decision。即使仅投影版本变化且正文相同，也保留现有拒绝语义，返回新视图供用户重试。

`mission_events.answer_recorded` 与 reserve 在同一事务记录 actor、渠道、interaction_token 摘要、原文或受控引用、action_id、权威引用和 payload digest。它是身份与因果证据；`attention_actions/session_messages` 仍是发送与回执权威。该事件本身不能批准动作或证明投递成功。

## ADR-05：三个线性化点与独立停止通道

回答接收、执行承诺和停止请求是三个不同动作。试点以一对一扩展表在**现有回答 action**上增加持久 dispatch phase，不另造发送 outbox。具体 SQL 约束、守卫和入口规则见 ADR-11。旧行缺少 phase 时按 legacy_unknown 处理。

| 顺序 | 原子处理 | 结果 |
|---|---|---|
| T-answer | 校验身份/版本；预留现有 message；记录 answer_recorded；phase=reserved | 已收到回答，不表示已开始执行 |
| T-dispatch | 同一事务检查 Mission 未取消、授权有效、当前 daemon fence；CAS reserved→dispatch_committed | 执行意图已不可当成“未发生”；之后只允许这一次原始调用 |
| T-cancel | 持久记录 stop_intent、推进 mission revision；禁止后续 T-dispatch | 发送线程、模型调用均不是停止请求入口 |

若 T-cancel 先于 T-dispatch，宿主不调用 resume。只有统一 dispatcher 能证明 action 从未进入 dispatch_committed 时，才以原子 CAS 写 `cancelled_before_dispatch` 处置及其证明。证明绑定 action/message、phase 转换、daemon generation、stop_intent 和事务事件序号。相应扩展须显式修改现有 receipt resolution/reconcile/guard 语义，不以普通文本或通用 abandon 模拟。

若 T-dispatch 先提交，随后取消，则请求中止对应 run/worker。即使调用尚未被外部观察，也不能直接宣称未执行；保留 dispatch_committed/unknown，直到有回执。宿主可以在调用前再检查取消以减少执行，但没有证据时不能据此自动释放发送保留。

重启后，仅由新协议创建、受统一派发门保护的 reserved 行可恢复其**尚未发生的首次派发**。必须验证协议版本、原 action/message/payload、原 source identity、原 turn、当前 session.version 等于持久 reservation_version、message 仍 accepted、权限仍有效、无 stop_intent，以及独占宿主准入。旧 owner 仍可能持有写权则不准入。全部成立后才进入同一个 T-dispatch CAS；否则保持可解释的 reserved/needs_reconciliation，不换键重发。有 stop_intent 的 reserved 行只走 cancelled_before_dispatch。已有 dispatch_committed 永不自动再调用；它可能已经产生副作用，不能利用本例外恢复。旧行或绕过新 dispatcher 的入口没有资格提供“未发送”证明。

stop_intent 的权威是 C02 的 mission_events.stop_requested（request_id 唯一、绑定 mission/action/run/invocation、actor、reason 与事件序号），Mission 持久保存 stop_intent_id 引用；T-cancel 在同一事务更新它。后续 stop_requested/confirmed/unknown 的回执事件引用同一意图；模型内存不是停止权威。停止走现有 `task.cancel`/Adapter abort 路径，并补持久 stop receipt；不经 `reserveSessionInstruction`。现有 abort 是请求，不是停止证明。持续 unknown 的回答可以阻塞新回答，但不得阻塞停止、读取、查询和人工对账。

现有 `task.cancel` 仅查进程内 activeRuns，并立即返回 cancelled。新的工程入口只能将它映射成 stop_requested；重启后的 not_active 不等于进程已退出。D04 还须通过精确宿主 invocation 记录查询/请求停止。宿主不支持跨重启停止时返回 stop_unknown，不承诺能够自动终止遗留进程。

不变量是“取消之后没有新的 dispatch commitment”，而非“不可能再有任何在途副作用”。已在途动作可能完成；报告必须保留这一事实。

## ADR-06：applied 的实际含义与无循环恢复

现有 daemon 在 `executeReservedSessionTurn` 中调用 `resumeSession`，等整个回合产生成功 terminal，再由 `completeInboundTurn` 同事务写新 turn 和 message.applied。**applied 表示该回复执行回合完成并持久化，不是仅收到回答。**

承载这次回答的 resume 是 T-dispatch 的受控动作。它不以 obligation 已清除为前置条件，否则形成循环。其他依赖步骤继续受 obligation 阻塞，直到原 action 的 applied 与新 turn 等证据满足清除谓词。

UI 显示：已收到回答 → 已预留执行/正在执行（必须有可信开始证据）→ 本轮已确认完成；若出现下一个决定，则展示新决定。无开始证据时不能写“Worker 已继续”。不得在 applied 后再调用一次 resume。

延迟分别测量接收落盘、宿主准入/开始、完整执行回合。删除“applied 在 5 秒内”的隐含要求。5 秒目标只能用于健康、已准入宿主上的 dispatch 开始，不包括排队、Provider、模型和完整回合；报告分母与排除原因。

## ADR-07：停止证明与人工干预

不采纳“Worker 自持 flock + PID”作为完整静默证明。Worker 可能遗留子进程、释放锁或修改工作区内锁文件。现有 `confirmAdapterStopped` 只检查 trusted adapter 的 stopped/evidence 返回，不能独立证明任意进程树隔离。

资格证明必须绑定 host、invocation_id、source instance/generation、工作区、取消请求和 worker containment domain。宿主掌握启动与退出证据，且能拒绝旧实例再次获得该域的写权限。Linux 可由受限 cgroup/容器 job 证明域内全部进程已退出并关闭；其他宿主必须提供等效被测试的实现。仅观察到主 PID 消失不够。

试点可运行在受信、受限的实际 Adapter profile，但必须如实标注威胁模型。未证明停止的 profile 保持 unknown，禁止自动替代写者和清理。操作员可通过精确宿主证据进行人工对账；“强制忽略”不能转换为已停止。完整不可信代码模式仍要求独立权限边界。

来源 turn 前进本身也不清除旧决定。有效 supersession 必须有：绑定精确旧问题的可信人工回答/处置，或经授权的新计划明确移除该阻塞义务，且关联证据可读取。普通新消息、done 文本或仅有最新 turn 变化均不够。否则状态为 needs_reconciliation，并展示为何无法判断，而不是持续要求用户重答同一问题。

`superseded` 不自动等于“依赖已满足”。仅经授权重规划移除该依赖，或精确处置证据证明替代条件成立时，步骤才可运行。保留原义务和原因。

## ADR-08：持久性与实际迁移谱系

试点所有可授权外部执行的写事务，必须在实际 daemon 写连接上使用并读回验证 `synchronous=FULL`，且提交成功后才进入外部调用。执行 profile 不满足该要求时禁用自动继续；只读观察可用。性能变化另行测量，不静默退回 NORMAL。

接收端按 message_id 去重/查询是较高恢复等级的条件。没有该能力时使用 `stop_and_reconcile` profile：仍可保留未知、停止和查询，但不能承诺自动完成恢复。FULL 与接收端去重都不能证明任意硬件的断电行为；要对支持的文件系统与宿主做故障验证。

F51-11 的“attention 表均为未发布实验表”推断被完整源码否定：基线 main 的 migration 40 创建 daemon_owner 和 attention 表，41–43 继续演进，当前 schema 为 46。`assertMigrationLineage` 拒绝的是与当前 user_version 对应的**期望表集合不符**的历史/混合库，不是拒绝所有 attention 表。`OSSTACK_ATTENTION=1` 控制服务启用；不是另一个 DB 谱系。

新表走编号递增迁移，保留该检查。旧未知实验库不自动导入；不能 reset user_version。旧二进制遇到新 schema 可以明确拒绝，回退使用当前兼容的只读/对账工具，不保证老二进制能读写新库。

## ADR-09：资格矩阵、差分规则与自举

保留 `capabilities.json` 为设计快照，const false 防止误标启用；它不承担运行时资格验证。新增 [资格契约](qualification-contract.schema.json) 定义运行时证据记录的结构草案。Schema 验证仅检查形状，不能验证签名、证据真实性或启用资格。

每条资格绑定 capability、行为契约摘要、source manifest 摘要、目标代码摘要、OS/架构/文件系统、隔离 profile、daemon 版本、Adapter 版本、Provider/model、Executor/template。证据 bundle 包含场景 ID、候选、检查器身份/版本、结果与限制；记录 signer、有效期、撤销版本和签名。

资格记录还绑定实际 host identity、required scenario set 摘要和前置资格摘要。contract_tested 由 CI verifier 签发；host_verified 由 host qualifier 签发并引用相同代码/契约/来源/registry 的 contract_tested；journey_verified 引用同一实际宿主 profile 的 host_verified。trust store 将 signer_key_id 绑定具体公钥、允许的 issuer_role、level、能力与环境范围；签名 payload 自报的 role 不能扩大密钥权限。CI key 不能签发 host_verified。撤销状态由配置中固定的运维信任根签名发布，单调 epoch 与撤销 key/record 清单持久化；拒绝回退 epoch。离线只能使用仍在明确 freshness 窗口内的缓存；过期或无法取得可信当前状态则停止新的资格启用。Worker 和普通资格签发者不能重设该根或清空撤销状态。CI 的宿主是构建宿主，不能替代部署宿主证明；跨级只放宽这一已定义的 CI→host 身份差别，不放宽代码或契约绑定。必需场景由版本化 verifier policy 指定，签发者不能自选一个容易通过的场景集合。

由受信 CI 证据签发者和宿主资格签发者分工签名。它们不归 Worker 控制。验签器使用宿主私有 trust store；按 [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) 规范化签名 payload，拒绝未知字段、重复键、非法数值和不可接受的编码。引用的证据须取回并重算摘要。绑定不匹配、撤销、过期或证据不可达都不能升级为 enabled。

启用是计算结果：精确 profile 的要求证据均通过 + 当前未撤销的运维启用授权 + 当前任务权限。任何一个维度不足只影响相应 profile，不能用 macOS 通过代替 Linux 通过。设计文件中没有生产签名者或真实合格记录。

试点不加载该运行时注册表。它使用编译期封闭 profile 和显式开关，待真实试点证据形成后，再签发首批资格。R 系列可以并行，但不是 D08 的前提。

能力移植差分规则见 [语义差异清单](semantic-divergences.json)。只允许精确条件下的已审查差异；输出为 equivalent / allowed_divergence / fail。未知差异不能自动加入 allowlist。enqueue 已关闭、OSStack 仍待 turn 完成的不同属于保留的更严格语义。

## ADR-10：预算、选项和路由

试点硬预算只包含可由宿主控制的动作/调用次数、运行时长、并发数和提醒次数。token/费用为 observed，除非 Provider/profile 能证明确切硬上限。未知费用保留 conservative charge；已知每次最大额度时可按上限核销，无最大额度时保持 unknown 并限制新计费调用，不伪造实际用量或释放为零。

试点输入只接受明确 choice_id/选项按钮，或外部输入问题允许的原文 text。自由文本不由模型自动映射成具有授权意义的选项。产品选择有歧义时展示具体选择；不要求无歧义、已授权的每个动作都二次批准。问题与选项以不可信数据呈现，不能按敏感关键词的有无推导权限；真正权限由 gate kind、权威记录与宿主策略决定。

ExecutorEnvelope 类别引用现有 CapabilityKind，模板引用精确模板 ID/version；行为注册表引用稳定行为 ID。受信构建生成声明，实际宿主证据决定资格。影子路由只计算建议；执行器质量对照使用隔离重放/测试仓库，不对生产重复执行写动作。

首个试点前记录现有手工流程的干预基线。仅使用授权、脱敏样本；没有样本则标为待测，不编数字。用户收益指标在首条旅程就测量，不等全量实现完成再评估。


## ADR-11：派发扩展表、版本和单一入口

基线 migration 41 的 receipt resolution CHECK 只允许 abandoned_unknown，不向它塞入新枚举，不重建该表。按实施时 main 的下一个迁移号（当前基线为 46）新增 attention_dispatch_phases。该表是既有 action 的一对一状态扩展，不是第二消息队列：action_id 为主键并引用 attention_actions；message_id 唯一并引用 session_messages。额外字段为 protocol_version、phase（reserved / dispatch_committed / cancelled_before_dispatch）、source_instance_id、source_generation、original_turn_id、source_version、reservation_version、reserved_by_generation、committed_by_generation、stop_intent_id、proof_json、created_at/updated_at。空值和状态组合由 CHECK/受信 store 校验，phase 不允许倒退。

在 T-answer 外层事务内，原 reserve、扩展行和 Mission 事件一起提交。source_version 是预留前的 v；reservation_version 是 applyInbound 返回的 v+1。不得使用 replay 返回的 0 重建版本。原 Session payload 从已存 message 读取，重新核验 action/payload digest；重启不从最新 UI 文本构造新消息。正常 completeInboundTurn 写入 v+2，并在同一 completed 钩子记录精确 action/message/source/completed_turn_id/session_version 证据。

固定顺序：先以原 message_id 获得独占 Session admission；确认没有 drain/abort；在一个同步 FULL 写事务内 assertOwner、校验 scope/policy/source/version/stop_intent，并断言 attention_actions.state=reserved、attention_receipt_resolutions 中无该 message_id 的任何处置，再 CAS reserved→dispatch_committed；提交后立即把同一个 lease/controller 传给 executeReservedSessionTurn。CAS 前失败不更改 phase；释放已取得 admission。CAS 成功者持有仅本次调用可消费的内部派发许可，中间不再异步获取准入；执行器消费许可后才调用 Adapter。任何 CAS 后失败都不复原 phase、不自动再调用。

所有能调用 executeReservedSessionTurn 的路径必须检查 message 是否属于此扩展表；属于时只能凭同一个 CAS 胜出调用的内部许可进入。engineering、attention.answer、session.send 和 continuation 路径不能各自恢复它。无扩展行的旧路径保留原语义，不能获得新协议的未发送证明。当前 handleSessionSend 对既有 accepted 消息实际返回 delivery_uncertain，并未发现现有绕过漏洞；这是新增恢复路径必须守住的约束。

reserveSessionInstruction 的不确定消息守卫只额外排除由受信 dispatcher CAS 形成、action/message 绑定正确且 proof 完整的 cancelled_before_dispatch 行。reconcile 优先读取该明确处置，显示“已取消且未派发”，不能映射为 applied 或 abandoned_unknown。若同时出现 applied 与 cancelled_before_dispatch，视为一致性错误并阻断新写入。

旧入口与投影必须在 D04 同一变更中接线：AttentionActions.reconcile/recover 首先读取 phase。新协议 reserved 且无 resolution 时保持 action=reserved，不把 accepted 消息一律投影为 uncertain。cancelled_before_dispatch 映射为明确 cancelled 状态；已 committed 的实际结果继续由原 receipt 决定；存在任何 receipt resolution 时阻止首次派发，并展示相应处置，不自动重置 action 回 reserved。phase=reserved 但 action 已 uncertain/abandoned_unknown 等不一致时进入 needs_reconciliation，不能自动“修正”后派发。

既有 abandon-receipt 在受信事务内检查 phase。对 reserved 返回 not_dispatched_use_cancel，明确“尚未派发，本次未作放弃；请取消原动作”，不插入 abandoned_unknown，不改变 phase；对 cancelled 返回原取消回执。对于 committed/legacy 的未知结果保留既有受控处置语义，且此类处置永远不成为重试许可。拒绝一次 abandon 不等于已经执行取消，界面必须准确表述；用户的取消命令仍需按 T-cancel 持久提交。测试分别检查：已有 resolution 时零次派发；abandon 被拒绝时自身无写入或发送；随后 cancel 提交后永久阻止该 action 派发。不得把“拒绝了错误操作”测试成“用户已成功取消”。

handleSessionSend、attention.answer replay 和读取视图对 cancelled 行返回同一取消回执，不再错误显示 delivery_uncertain；committed 未确认的旧行为仍保留未知。以上操作与 dispatcher 共享 FULL 写事务和 owner fence，不能先在事务外检查 resolution，再在事务内盲目 CAS。

保留 attention_actions.item_id UNIQUE：重启继续原 reserved action，不创建第二回答。取消是该动作的终结；重放仍返回原取消回执，不能重新开启或改正文。新问题、新 turn 可以产生新 action。试点不支持取消后对同一个旧 item 再答；入口明确返回 cancelled_original_answer，并提供停止观察、直接处理原 Session 或在有新来源问题后重新采纳的选项。它不能伪造新 decision_id 绕过约束。该边界不阻塞同 Session 的其他合法新指令，也不把用户重新授权推导为旧动作未执行。

## ADR-12：Session 来源身份及版本推进

试点 source_instance_id 为带版本前缀的 SHA-256(RFC8785({session_id, native_session_id}))，native_session_id 必须非空；source_generation 固定为 1。Session ID 不复用，native ID 不原地重绑定。检测到 native ID 变化或 NULL，保留原绑定并进入 needs_reconciliation；重新采纳新源需新 Mission，不在旧 Mission 内悄悄重置。该身份不等同进程 invocation；停止证明仍须另外绑定实际 invocation/containment。

mission_revision 只在影响用户意图或有效交互的变化递增：目标/权限/计划变更、取消、人工处置、首次回答接受和 Mission 终态。纯观察新鲜度与心跳不递增；用事件序号和 observed_at 表达。wait_revision 仅在该义务的语义状态改变时递增。question identity/item revision/session version 各按其原权威更新。所有首次写动作仍核对当前原始来源，不能因 Mission revision 稳定跳过 freshness 检查。

## ADR-13：无 action 的人工干预处置

engineering.reconcile 是类型化联合：query_action 保留只读查询；dispose_wait 用于明确调整当前观察任务。后者包含 request_id、mission_id、if_revision、wait_id、if_wait_revision、disposition（human_answered_out_of_band / no_longer_relevant）、observed_turn_id、observed_snapshot_digest、note。身份从可信通道得到，要求 scope 写权及 mission.steer 授权。试点在 engineering.adopt 验证 scope 写权后，将该认证 principal 记为不可变 owner_principal_id，并授予仅此 Mission 的 steer；其他 principal 不因同 scope 写权自动获得它。试点不提供转让接口；Worker/模型不能自报该身份。每次使用仍检查当前 scope 权限未撤销，且是普通产品选择/输入义务，不是风险批准或任务授权。

服务重新读取当前 Session，核对来源身份、精确旧 item/turn 和观测快照。用户签名/认证的声明是一次目标调整，**不是机器证实回答已经送达**。无原回答 action、且不涉及未知在途副作用时，CAS 写 steering_recorded，保留旧义务为 superseded，记录“经用户授权撤出观察依赖”。不写 session_messages，不写 answer_applied，不调用 resume，不授权后续 Worker。普通操作员写权不能替代 mission.steer。

若已有 reserved/dispatch_committed/unknown action，dispose_wait 拒绝并指向 query_action、cancel 或原 receipt 的受控对账；不能用人工声明释放未知发送保留、证明停止或跳过安全审批。移除旧观察义务后仍展示新问题与未完成事项。该处置本身不构成工程完成，也不产生 observed_turn 成功证据。

## ADR-14：采纳试点的完成定义与后续工程交付

试点 completion_level 固定为 observed_turn：它只承诺记录并观察由本次回答触发的回复回合，不承诺 Run、整个工程目标或代码检查全部完成。采用这一等级时用户入口明确显示“观察回复回合”。完整 goal_dispatch 沿用主设计的工程交付等级。

成功终结要求：至少一个属于本 Mission 的原 action 已 applied；精确 action/message/source/completed_turn_id/session_version 证据已落库；当前最新 turn 正是该已证明 turn，状态 idle 或 completed；在同一归约快照中没有新决定、未清除义务、未决副作用或取消意图。此时 Mission=completed，输出独立 ObservationProof，包含上述身份和回合输出摘要，不伪造代码 candidate/test 证明。新 turn 仍 awaiting_decision 则建立新义务并继续观察；未记录对应 applied 的 idle 不能触发成功。

不采用单独以 Run terminal 判断成功的建议：基线 handleSessionStart 即使 Session 等待决定也会 finalizeRun(completed)，因此该 Run 终态可能早于采纳。Run terminal 可作关联事实，但不足以证明此次回复回合。失败映射为 failed/needs_reconciliation；unknown 保留。用户直接处理源会话、仅 dispose_wait 后没有本 Mission 的完整回复证据时，显示“已撤出旧等待，尚无本次回复回执”；用户可明确结束观察，记录 observation_ended（非成功终态），不无限等待或强迫重新回答。结束观察不等于停止 Worker，也不移除未知执行记录。未知发送仍归现有 attention receipt/daemon 对账职责管理；终结 Mission 不能使该职责消失，后续会话写入仍受原守卫约束。

D07/D08 仅验收场景清单中 delivery_stage=adopt_session 的全部条目。其余条目由命名的后续工作包验收；不能标通过或删除。第一试点并不具备生产隔离资格。


## waiting-decision-pilot.md

# “等待决策”自动移植试点规格

状态：V2 待实施的运行时规格；[V2 实施契约](runtime-contract-v2.md)给出确定的事务和身份规则。本设计包提供机器可读场景与注册表校验，不把设计校验称为生产试点通过。

## 1. 试点边界

主要能力：FM-04（等待责任）、FM-08（决策持久化）、FM-09（幂等与未知投递）。支撑能力：FM-01、02、03、05、07、10、11、13、19。

第一条纵向路径限定为 adopt_session：一个本地仓库、默认租户、一个最小 Mission，采纳已经准入的 Task/Run/Session，复用已有 SessionDecision、attention daemon 和回答通道。它不启动初始 Worker，不依赖运行时注册表或 Loop 服务化。用户在 OSStack 入口回答，系统通过原 Session 通道执行回复回合并验证结果。

先支持普通产品选择和外部输入。风险批准、任务授权、运行审批仍经过各自的正式 resolver；不允许通用文本回答绕过它们。远程控制、自动发布与任意 Graph 不作为试点通过的前提。

下一阶段接入 Run approval/clarify 与固定 Graph 暂停节点。只有每类 resolver 的语义测试通过后才能启用该类决策。不能把 Session 的“已应用”语义直接套给 Graph。

## 2. 从原始材料抽取的行为

| 原始素材 | 应保留的语义 | OSStack 的实现选择 |
|---|---|---|
| `fm-classify-lib.sh` 与 `fm-classify-decision-key.test.sh` | 未决问题不能被后来的无关状态覆盖；只解除精确键 | 使用类型化 decision ID、版本和来源；拒绝共享无范围 default key |
| `fm-wake-drain.sh` 与 open-decisions 测试 | 即使事件队列为空，也展示仍未决的问题 | 每次会话恢复从权威存储重建未决视图，不只读新增事件 |
| `fm-captain-hold.sh` | 谁欠决定、原始回答、暂缓和解除都有持久记录 | WaitObligation 引用现有决策权威；保留回答原文与确认对象 |
| `fm-send.sh --resolve-key` | 一个统一回答入口；失败/不确定发送不得悄悄关闭问题 | 所有 UI 共用 resolver；现有 AttentionActions 负责发送预留和回执 |
| `fm-send.sh` 的 inbox/typed plane 区别 | durable enqueue 与确认 submit 是不同投递语义 | 区分回答已记录、传输已接收、Worker 已应用、工作已继续 |
| `docs/architecture.md` 与原始 AGENTS | 监督不断线；空轮询不打扰；有责任归属的等待不当作卡死 | 无模型 watchdog、分类型等待、按条件重查与有上限的提醒 |

上游终止事件可能按其 key/任务所有权关闭某些记录。OSStack 对影响授权与交付的等待采用更严格规则：只有对应权威记录和 clearing predicate 可解除。差异必须记录在注册表；差分测试不能强迫 OSStack 接受更弱语义。

## 3. 最小用户旅程

1. 用户采纳一个已有授权范围的精确 Task/Run/Session。主控登记最小 Mission、交付要求与观察/回答范围。从新目标自动派发另行实施；旧批准合同不会被自动补跑。
2. 工作者提出兼容性问题；Adapter 写入有效 SessionDecision。
3. 控制器记录该问题关联的阻塞步骤。独立步骤可继续。
4. 联络入口显示问题、选项、影响、建议和任务上下文。
5. 用户选择 A。系统根据显示时的交互 token 找到精确问题版本。
6. resolver 检查身份、内容、源版本、任务范围和权限。
7. 同一事务预留发送并记录回答已接收。用户可看到“已收到，正在送达”。
8. 发送器调用既有通道。记录 applied 或 unknown 等回执。
9. 收到适用的应用/继续证据后，满足 clearing predicate 的步骤恢复。主控不会重复启动已有运行。
10. 试点交付精确回合的 ObservationProof；未解决事项仍单列。后续 goal_dispatch 才交付绑定代码候选的检查和工程结果。

## 4. 数据契约

以下是拟新增的协议。实现时使用严格 Zod schema 并生成 JSON Schema。这里不覆盖现有协议字段。

```ts
type DecisionAuthorityRef =
  | { kind: "session_decision"; scope_id: string; item_id: string; item_revision: number;
      session_id: string; turn_id: string;
      decision_id: string; source_version: number; content_hash: string }
  | { kind: "run_approval"; run_id: string; approval_id: string;
      source_version: number; content_hash: string }
  | { kind: "run_clarify"; run_id: string; clarify_id: string;
      source_version: number; content_hash: string }
  | { kind: "contract_approval"; contract_id: string;
      source_version: number; content_hash: string };

type ClearPredicate =
  | { kind: "answer_applied"; action_id: string; source_instance_id: string;
      source_generation: number; message_id: string; completed_turn_id: string; session_version: number }
  | { kind: "approval_accepted"; authority_id: string; subject_digest: string }
  | { kind: "external_condition_verified"; check_id: string; subject_digest: string };

interface WaitObligation {
  wait_id: string;
  mission_id: string;
  revision: number;
  blocked_step_ids: string[];
  owner: "human" | "controller" | "external" | "unknown";
  subject:
    | { kind: "decision"; authority_ref: DecisionAuthorityRef }
    | { kind: "external"; source_id: string; source_generation: number;
        predicate_ref: string };
  clear_predicate: ClearPredicate | null; // 未预留回答时可为空；不得据此解除
  due_at: string | null;
  next_check_at: string | null;
  state: "open" | "deferred" | "answer_recorded" | "delivery_unknown"
    | "cleared" | "superseded" | "needs_reconciliation";
}
```

外部条件分支为后续协议保留；首个试点只接入 `subject.kind=decision`。`continuation.gate_kind=external_input` 仍是需要精确回答的 SessionDecision，不等于外部条件已经满足。

所有时间协议用 UTC ISO 8601；进程内超时使用单调时钟；重启后从持久 deadline 和当前时钟重新核对。时钟回退不能延长 grant 或伪造新鲜度。

资源边界：问题沿用现有 SessionDecision 上限（question 1000 字符、最多 8 个选项，每个标签 160 字符）；回答沿用 attention text 上限；mission 关联、ID、列表上限在新增 schema 明确冻结。采用现有协议时不能偷偷扩大它们。

## 5. 对话与接口

拟新增的服务接口，不是当前可执行 CLI：

| 接口 | 输入与前置条件 | 输出 |
|---|---|---|
| `engineering.adopt`（试点） | 精确 task/run/session、scope、request_id；awaiting_decision 与非空 native ID；completion_level=observed_turn；身份由可信通道提供 | mission_id、revision、已采纳的身份 |
| `engineering.submit`（后续） | goal、repo identity、request_id、期望交付级别与具体派发授权 | mission_id、revision、合同状态 |
| `engineering.observe` | mission_id、cursor、limit；只读 scope 检查 | 状态、开放等待、增量事件、证据引用 |
| `engineering.decide` | mission_id、wait_id、if_revision=mission_revision、含 item_revision 的 decision_ref、action_id、answer、interaction_token | accepted/replay/rejected/unknown；receipt ID |
| `engineering.defer` | 精确 wait version、action_id、revisit_at、reason | deferred；仍未回答，不增加授权 |
| `engineering.cancel` | mission_id、if_revision、request_id | stop_requested；后续独立报告 stop_confirmed |
| `engineering.reconcile` | query_action 查询原 action/receipt；dispose_wait 按 ADR-13 绑定 Mission/Wait CAS、观测快照和 steering 授权 | 已确认结果、unknown 或明确撤出观察义务；不伪造投递证据 |
| `engineering.endObservation` | mission_id、if_revision、request_id；明确结束观察 | observation_ended；不声称成功、不停止源 Worker，保留未决副作用的责任归属 |

回答是 discriminated union：`choice`、`text` 或 `approval_token_ref`。session 普通决定允许 choice/text；风险批准必须绑定合适的 approval token。unknown 类型和额外字段直接拒绝。

交互 token 精确绑定 principal_id、client_session_id、mission_id、mission_revision、wait_id、item_id、item_revision、content_hash、expires_at 和 nonce；与 ADR-04 一致，不混用 wait_revision。服务从验证后的通道推导身份，不接受用户 JSON 声称的 actor。

试点使用明确 choice_id/选项按钮；外部输入问题可提交原文 text。自由文本“继续”不由模型猜成某个选择。有歧义时展示明确问题和选项，不自行授权。批量回答逐项校验和返回结果；不把部分成功显示成全部成功。

API 错误必须可行动：`stale_decision`、`scope_mismatch`、`signed_approval_required`、`source_unavailable`、`action_conflict`、`delivery_unknown`、`executor_not_qualified`、`budget_exhausted`、`cancelled_original_answer`、`dispatch_gate_required`、`not_dispatched_use_cancel`。每项返回事实引用与下一步，不只返回“系统错误”。

产品入口建议为 `osstack chat --adopt-session <id>`，诊断入口可为 `osstack mission status <id>`。后续 goal_dispatch 才支持从新目标开始。这些名字属于提案。保留已有 `attention`、`session`、`loop`、`graph`、`start/control` 命令；不用新命令名称暗示已经实现。

## 6. 三条状态轴

不能用单一 `resolved` 字段表达整个过程。

| 状态轴 | 状态 | 何时可以前进 |
|---|---|---|
| 决策 | open / deferred / answer_recorded / superseded | 有效身份、正确版本、原始权威允许该回答 |
| 投递与执行回复 | none / reserved / dispatch_committed / applied / unknown / cancelled_before_dispatch / abandoned_unknown | 扩展现有 action 的 dispatch phase；applied 是完整回复回合落库 |
| 执行 | blocked / eligible / resuming / running / stopped / unknown | clearing predicate、权限、预算、执行器状态均满足 |

用户回答落盘后，可停止重复要求其回答，但要显示“正在送达”或“送达结果未知”。不能继续显示“等你回答”，也不能宣称“已经继续工作”。

延后只改变提醒安排，不意味着批准。deadline 到期只触发重查或升级，不产生答案。取消请求也不把决定改成通过。

## 7. 事务与现有实现的对接

### 7.1 T1：发现等待

读取权威记录及来源版本。以 `(authority_kind, authority_id, generation)` 建立唯一关联。写入 obligation 和主控事件。重复观察只更新新鲜度，不重新生成问题，不重置首次发现时间。

来源出现 gap、失联或被替换时保留 obligation，并标记证据不足。不能因 source list 暂时为空删除它。解除需要原始明确处置；精确人工回答或授权重规划可按 ADR-07 supersede。仅 turn 前进进入 needs_reconciliation，不是已回答。

### 7.2 T2：接收回答

服务先认证和核对 scope，处理同 actor/同 payload 的幂等回执读取，再检查首次操作的 token 与版本。使用现有 `AttentionActions.reserve` 的校验与预留。重构为能参加同一个 `withWrite` 事务的内部服务接口。在同一事务记录 Mission 的关联和待处理事件。若嵌套事务语义不能保证，先重构事务所有权，不做两个独立 commit 的乐观拼接。

唯一约束：`action_id` 全局唯一且 payload hash 不可变；同一问题版本只允许一个有效回答；同一 authority ref 不能误绑定多个不相容 Mission。重复相同请求返回同一回执；相同 ID 不同正文返回冲突。

普通 Session 回答仍调用 `reserveSessionInstruction`；其 `signed_approval_required` 等拒绝条件必须保留。不能为了自动化改成通用文字批准。

### 7.3 T3：发送

**现有 session_messages / attention_actions 是这次发送的唯一账本。**新增 Mission 待处理事件只引用 action_id，不再独立创建第二条发送任务。

发送器在事务外执行；先按 ADR-05 将原 action 的 reserved 原子转换为 dispatch_committed，检查取消屏障、权限和 daemon fence。新协议 reserved 只可按 ADR-05/11 的完整证明恢复尚未发生的首次派发；dispatch_committed 和 legacy_unknown 永不自动再调用。任何不确定窗口保持 unknown；仅有严格未派发证明才记录 cancelled_before_dispatch。不会换键重发。

### 7.4 T4：应用与恢复

现有 Session 的 applied 表示整个回复执行回合成功并落库。只有精确 action、源实例和新 turn 证据满足时才解除该阻塞边。承载回答的 resume 在 T-dispatch 执行，不以先清除义务为前提。accepted 不能当作 applied，开始执行也不能当作完成。

Session Adapter 已经通过回答继续运行时，主控只观察它，不再启动第二个 Worker。对需要显式 resume 的 Graph executor，使用其独立恢复接口与幂等键，不能复用 session send。

如果候选代码、合同、scope、policy 或授权主体发生变化，恢复前重新验证。仅回答“保留字段”不授权新增发布动作。

### 7.5 T5：完成

试点按 ADR-14 的 observed_turn 条件完成，只输出 ObservationProof，明确“本次回复回合已确认”，不宣称代码工程交付。idle 或 Run terminal 单独都不能完成。新决定继续产生义务；失败、取消、未知分别显示。直接操作源会话但没有本 Mission 的 applied 证据时，可按 ADR-13 撤出旧等待，并明确结束观察为 observation_ended，不伪造成功。后续 goal_dispatch 必须满足同候选检查和工程交付级别，不能用试点证据替代。

## 8. Owner、取消与竞态

| 竞态 | 必须采用的结果 |
|---|---|
| 用户回答时问题被改写 | 旧 hash/revision 被拒绝；展示新版本差异 |
| 两个 UI 同时回答 | CAS 只有一个胜出；另一方得到已回答或冲突 |
| 控制器重启与旧控制器同时执行 | 新 generation 生效；宿主拒绝旧 generation 的新副作用 |
| 用户取消与回答并发 | 以 T-dispatch 与 T-cancel 的事务顺序为准；取消后无新 dispatch commitment；在途动作独立停止，不经 session 指令通道 |
| 授权被撤销但普通回答到达 | 可记录回答事实；禁止执行不再授权的动作 |
| 事件重复或乱序 | 依 generation+sequence+event identity 去重；缺口保留 unknown |
| 重试时任务迁到另一个 repo | subject/scope 校验拒绝，不重定位到相似目录 |
| Worker 自行退出或用户手动继续 | 按 ADR-07 验证精确停止/人工处置证据；无证据保持 needs_reconciliation；不二次恢复 |
| 同时有 B 与 C 等待，B 已回答 | 只解除 B 的阻塞边；C 保留 |

跨任务等待构成有向依赖图。检测环和无责任人的等待。环不自动以“全都继续”解除，应展示最小环与可行动的责任项。

## 9. 自动移植流水线

### 9.1 输入与阶段

```text
固定 upstream commit + 原始脚本/测试/故障记录
  → 变化影响清单（path、symbol、test、行为 ID）
  → 行为契约与差异说明
  → 中立事件场景（不包含执行权限）
  → 上游行为回放 + OSStack 适配后的契约测试
  → 隔离 worktree 中实现缺口
  → adversarial / fault / regression 检查
  → 绑定候选提交的证据包
  → registry 资格更新 + 可审查 PR
  → 合并、宿主资格验证、分阶段启用
```

每个阶段输出持久记录：输入摘要、工具版本、退出码、输出摘要、未解决分歧。阶段失败停止后续资格升级，已生成材料可继续供人工审查。

### 9.2 自动化与人工判断边界

可确定性自动化：固定 Git 对象、许可/路径清单、依赖影响分析、Schema 校验、测试运行、差异报告、证据索引、PR 草稿生成。

可由模型辅助但需可审查输出：从脚本抽取行为、生成规格、提出适配代码、解释差异、生成攻击场景。模型不能自行把行为差异判为“全部兼容”。

必须有独立准入：权限扩大、发布/部署、支持矩阵升级、破坏性迁移、默认路由切换。遵循既有授权和仓库保护要求；不新增每个可逆开发步骤的审批。

初版不承诺任意 Shell 自动编译为 TypeScript。采用受限映射：事件谓词、状态转换、身份/作用域规则、清除条件、测试场景。无法映射的行为生成 `unmapped_semantics` 缺口，并阻断对应能力“完成”的声明。

### 9.3 试点输出

- 三个决策主能力及支撑能力的完整 registry 条目。
- `decision.requested / unrelated.progress / answer.recorded / answer.applied / transport.unknown / controller.restarted` 等中立事件场景。
- 上游实际 fold/wake/send 测试结果。
- OSStack adapter 的契约测试和真实会话证据。
- 语义差异清单：OSStack 的身份绑定与授权要求可更严格，不允许弱化。
- 一条完整用户会话录像或可重放 transcript，外加独立机器回执。录像不能替代机器检查。

## 10. 必测场景

机器清单见 [pilot-scenarios.json](pilot-scenarios.json)。每个场景记录执行层级、delivery_stage 和 owner_work_item。D07/D08 必须通过全部 adopt_session 场景；后续场景仍待各自工作包验收。不能用模型模拟结果顶替宿主实测。

| 场景组 | 场景与预期 |
|---|---|
| 保留 | 无关进度不清除；无关 done 不清除；空队列仍展示；来源短暂消失不删除 |
| 精确回答 | 选项绑定精确 ID；旧 revision 拒绝；旧 content hash 拒绝；跨 scope 拒绝；多问题“继续”不猜测 |
| 授权 | 伪 human actor 拒绝；审批问题拒绝普通 text；授权撤销后不恢复 |
| 幂等 | 相同 action 同正文复用回执；相同 action 不同正文冲突；多窗口竞争一个胜出 |
| 未知 | 发送成功前后断线均保留不确定；重启不重发；查询无证据时仍未知 |
| 恢复 | 有效 applied 只解除目标阻塞；来源 generation 改变需对账；不重复启动 Session |
| 姿态 | away 不扩大权限；defer 不等于同意；无变化轮询不调用模型；返回时展示未决项 |
| 完成 | 检查对象不同不得完成；未决义务不被 done 文本清空；取消未确认不得清理 |
| 压力 | 有界队列、毒消息、时钟回退、最大尺寸、多任务公平性 |

## 11. 试点退出标准

1. 从同一 OSStack 入口采纳已有会话、回答决定并观察回复回合结果，用户没有复制底层命令，也没有选择 Agent。该试点不替代后续从目标自动派发的验收。
2. 上游行为映射、OSStack 测试和负例全部有可复查证据。
3. 至少完成一次真实进程重启、一次实际会话回答、一次模拟传输未知；恢复过程没有重复执行。
4. 模型故障不丢等待；控制器与 Worker 生命周期分离。
5. 支持矩阵逐项通过，不支持的 Adapter 明确拒绝自动恢复。
6. 证据不足时显示 unknown；没有“全部通过”的兜底话术。

## 12. 回退

先关闭新 Mission 的自动执行开关及恢复首次派发开关。保留观察、回答已有决定、停止与对账。把现存任务交还已有 attention/session 入口，并显示其精确 ID。已有 action 的统一派发门保持生效。已经发送的回答不撤销、不重复发送。迁移采用加表/加字段；不通过删除新表让未知副作用消失。


## evidence/design-validation.json

{
  "status": "passed",
  "scope": "design_consistency_only",
  "capabilities": 24,
  "planned_runtime_scenarios": 66,
  "planned_scenarios_by_stage": {
    "adopt_session": 58,
    "integrated_controller": 4,
    "production_qualification": 1,
    "runtime_registry": 3
  },
  "planned_work_items": 37,
  "pilot_dependency_closure": [
    "C01",
    "C02",
    "D01",
    "D02",
    "D03",
    "D04",
    "D05",
    "D06",
    "D07",
    "V00"
  ],
  "qualification_schema": "shape_checked_only_no_signature_or_runtime_verification",
  "declared_semantic_divergences": 3,
  "source_anchors": 74,
  "source_hashes_verified": 74,
  "invalid_fixtures_rejected": [
    "duplicate_id",
    "unknown_dependency",
    "dependency_cycle",
    "runtime_enabled",
    "missing_source"
  ],
  "production_runtime_verified": false
}


## NEW_TEST_CONTRACTS_ONLY

[
  {
    "id": "WD-61",
    "name": "signer-role-confusion",
    "capability_ids": [
      "FM-15",
      "FM-19"
    ],
    "given": "ci_verifier key signs host_verified or revocation epoch is rolled back",
    "expected": "future verifier rejects regardless of payload role",
    "required_layer": "integration",
    "execution_status": "not_run",
    "delivery_stage": "runtime_registry",
    "owner_work_item": "R05"
  },
  {
    "id": "WD-62",
    "name": "cancelled-original-item",
    "capability_ids": [
      "FM-04",
      "FM-08",
      "FM-09"
    ],
    "given": "original action known cancelled and user retries or changes answer on same item",
    "expected": "original cancelled receipt or immutable conflict; explicit limitation, no new action or fabricated question ID",
    "required_layer": "integration",
    "execution_status": "not_run",
    "delivery_stage": "adopt_session",
    "owner_work_item": "D07"
  },
  {
    "id": "WD-63",
    "name": "resolution-before-dispatch",
    "capability_ids": [
      "FM-04",
      "FM-08",
      "FM-09"
    ],
    "given": "phase reserved but exact message has abandoned_unknown resolution",
    "expected": "zero dispatch; preserve resolution and reconcile conflicting phase",
    "required_layer": "integration",
    "execution_status": "not_run",
    "delivery_stage": "adopt_session",
    "owner_work_item": "D07"
  },
  {
    "id": "WD-64",
    "name": "reserved-projection-recovery",
    "capability_ids": [
      "FM-04",
      "FM-08",
      "FM-09"
    ],
    "given": "new gated reserved action recovered after crash without resolution",
    "expected": "projection remains reserved, not uncertain; all other dispatch preconditions still required",
    "required_layer": "integration",
    "execution_status": "not_run",
    "delivery_stage": "adopt_session",
    "owner_work_item": "D07"
  },
  {
    "id": "WD-65",
    "name": "abandon-reserved-rejected",
    "capability_ids": [
      "FM-04",
      "FM-08",
      "FM-09"
    ],
    "given": "abandon receipt invoked for reserved phase, then explicit cancel committed",
    "expected": "abandon itself refuses without writing/sending; cancel creates barrier and prevents first dispatch",
    "required_layer": "integration",
    "execution_status": "not_run",
    "delivery_stage": "adopt_session",
    "owner_work_item": "D07"
  },
  {
    "id": "WD-66",
    "name": "steering-owner-only",
    "capability_ids": [
      "FM-04",
      "FM-08",
      "FM-09"
    ],
    "given": "different principal has scope write but is not adopt owner",
    "expected": "dispose_wait refused; owner also refused if current scope permission revoked",
    "required_layer": "integration",
    "execution_status": "not_run",
    "delivery_stage": "adopt_session",
    "owner_work_item": "D07"
  }
]

## PINNED_SOURCE/packages/core/src/state/attention-actions.ts:1-360

1: import { realpathSync } from "node:fs";
2: import { randomUUID } from "node:crypto";
3: import type Database from "better-sqlite3";
4: import { SessionDecision } from "@osstack/protocol";
5: import { withWrite } from "./db.js";
6: import { SessionRepository, type SessionMessageInput } from "./sessions.js";
7: import {
8:   AttentionStore,
9:   attentionDigest,
10:   type AttentionOwner,
11: } from "./attention-store.js";
12: /** Common human reservation, serialized with collaborator writes in the same DB. */
13: export function reserveSessionInstruction(
14:   db: Database.Database,
15:   path: string,
16:   message: SessionMessageInput,
17:   version: number,
18:   now: number,
19:   takeover = false,
20:   takeoverGrantId?: string
21: ) {
22:   return withWrite(db, path, () => {
23:     const sessions = new SessionRepository(db, path);
24:     if (sessions.getMessage(message.message_id))
25:       return sessions.applyInbound(message, version, now);
26:     if (
27:       db
28:         .prepare(
29:           "SELECT 1 FROM session_messages WHERE session_id=? AND direction='inbound' AND state IN ('accepted','failed') AND message_id NOT IN (SELECT message_id FROM attention_receipt_resolutions) LIMIT 1"
30:         )
31:         .get(message.session_id)
32:     )
33:       throw new Error("delivery_uncertain");
34:     if (
35:       db
36:         .prepare(
37:           "SELECT 1 FROM session_continuation_attempts a JOIN session_continuation_grants g ON a.grant_id=g.grant_id WHERE g.session_id=? AND a.status IN ('checking','reserved') LIMIT 1"
38:         )
39:         .get(message.session_id)
40:     )
41:       throw new Error("continuation_in_flight");
42:     const grant = db
43:       .prepare(
44:         "SELECT grant_id FROM session_continuation_grants WHERE session_id=? AND status='active'"
45:       )
46:       .get(message.session_id) as { grant_id: string } | undefined;
47:     if (grant && takeover && takeoverGrantId !== grant.grant_id)
48:       throw new Error("takeover_grant_changed");
49:     if (grant && !takeover) throw new Error("grant_owned");
50:     const snapshot = sessions.latestSnapshot(message.session_id);
51:     if (snapshot.state === "awaiting_decision" && snapshot.decision === null)
52:       throw new Error("invalid_decision");
53:     const decision = SessionDecision.safeParse(snapshot.decision);
54:     const raw = snapshot.decision as Record<string, unknown> | null;
55:     const legacy =
56:       raw !== null &&
57:       typeof raw === "object" &&
58:       !Array.isArray(raw) &&
59:       Object.keys(raw).every((k) => ["question", "choices"].includes(k)) &&
60:       Array.isArray(raw["choices"]) &&
61:       raw["choices"].every((v) => typeof v === "string") &&
62:       (raw["question"] === undefined || typeof raw["question"] === "string");
63:     if (snapshot.decision !== null && !decision.success && !legacy)
64:       throw new Error("invalid_decision");
65: 
66:     if (
67:       decision.success &&
68:       ["risk_approval", "task_authorization"].includes(
69:         decision.data.continuation?.gate_kind ?? ""
70:       )
71:     )
72:       throw new Error("signed_approval_required");
73:     if (grant)
74:       db.prepare(
75:         "UPDATE session_continuation_grants SET status='blocked',reason='human_takeover',updated_at=? WHERE grant_id=?"
76:       ).run(now, grant.grant_id);
77:     return sessions.applyInbound(message, version, now);
78:   });
79: }
80: export interface AttentionAnswer {
81:   scope_id: string;
82:   item_id: string;
83:   action_id: string;
84:   revision: number;
85:   content_hash: string;
86:   text: string;
87:   takeover: boolean;
88:   takeover_grant_id?: string;
89: }
90: interface Action {
91:   action_id: string;
92:   scope_id: string;
93:   item_id: string;
94:   payload_hash: string;
95:   message_id: string;
96:   state: string;
97:   created_at: number;
98:   updated_at: number;
99: }
100: export class AttentionActions {
101:   constructor(readonly store: AttentionStore, readonly owner: AttentionOwner) {}
102:   reserve(input: AttentionAnswer, now = Date.now()) {
103:     if (
104:       !input.action_id ||
105:       input.action_id.length > 256 ||
106:       !input.text.trim() ||
107:       input.text.length > 16000
108:     )
109:       throw new Error("invalid_answer");
110:     return this.store.write(this.owner, () => {
111:       const db = this.store.db;
112:       const digest = attentionDigest(input);
113:       const prior = db
114:         .prepare("SELECT * FROM attention_actions WHERE action_id=?")
115:         .get(input.action_id) as Action | undefined;
116:       if (prior) {
117:         if (prior.payload_hash !== digest)
118:           throw new Error("action_id_conflict");
119:         return {
120:           ...this.reconcile(prior, now),
121:           replay: true,
122:           reservation_version: 0,
123:         };
124:       }
125:       const item = this.store.getItem(input.scope_id, input.item_id);
126:       const scope = this.store.getScope(input.scope_id);
127:       if (!item || !scope) throw new Error("not_found");
128:       if (
129:         item.state !== "open" ||
130:         item.revision !== input.revision ||
131:         item.content_hash !== input.content_hash
132:       )
133:         throw new Error("stale_item");
134:       if (
135:         db
136:           .prepare("SELECT 1 FROM attention_actions WHERE item_id=?")
137:           .get(item.item_id)
138:       )
139:         throw new Error("action_already_reserved");
140:       const repo = new SessionRepository(db, this.store.path);
141:       const source = repo.getSession(item.session_id);
142:       const latest = repo.latestSnapshot(item.session_id);
143:       if (source && source.state !== "awaiting_decision")
144:         throw new Error("session_not_awaiting_decision");
145:       if (
146:         !source ||
147:         source.task_id !== scope.task_id ||
148:         realpathSync(source.repo_path) !== scope.repo_path ||
149:         latest.turn_id !== item.turn_id ||
150:         source.version !== item.source_version ||
151:         attentionDigest(SessionDecision.parse(latest.decision)) !==
152:           item.content_hash
153:       )
154:         throw new Error("source_changed");
155:       if (
156:         !db
157:           .prepare(
158:             "SELECT 1 FROM tasks t JOIN runs r ON r.task_id=t.task_id WHERE t.task_id=? AND r.run_id=? AND t.tenant_id IS NULL AND r.tenant_id IS NULL"
159:           )
160:           .get(scope.task_id, source.run_id)
161:       )
162:         throw new Error("source_changed");
163:       const messageId = `attention-${randomUUID()}`;
164:       const reservation = reserveSessionInstruction(
165:         db,
166:         this.store.path,
167:         {
168:           message_id: messageId,
169:           session_id: item.session_id,
170:           turn_id: item.turn_id,
171:           direction: "inbound",
172:           kind: "instruction.send",
173:           payload: { text: input.text },
174:           state: "accepted",
175:           created_at: now / 1000,
176:         },
177:         source.version,
178:         now / 1000,
179:         input.takeover,
180:         input.takeover_grant_id
181:       );
182:       db.prepare(
183:         "INSERT INTO attention_actions VALUES(?,?,?,?,?,'reserved',?,?)"
184:       ).run(
185:         input.action_id,
186:         input.scope_id,
187:         input.item_id,
188:         digest,
189:         messageId,
190:         now,
191:         now
192:       );
193:       db.prepare(
194:         "UPDATE attention_items SET state='answer_reserved',revision=revision+1,updated_at=? WHERE item_id=?"
195:       ).run(now, item.item_id);
196:       return {
197:         action_id: input.action_id,
198:         scope_id: input.scope_id,
199:         item_id: input.item_id,
200:         payload_hash: digest,
201:         message_id: messageId,
202:         state: "reserved",
203:         created_at: now,
204:         updated_at: now,
205:         replay: false,
206:         reservation_version: reservation.session_version,
207:       };
208:     });
209:   }
210:   replay(input: AttentionAnswer, applyingMessageId?: string) {
211:     const prior = this.store.db
212:       .prepare("SELECT * FROM attention_actions WHERE action_id=?")
213:       .get(input.action_id) as Action | undefined;
214:     if (!prior) return undefined;
215:     if (prior.payload_hash !== attentionDigest(input))
216:       throw new Error("action_id_conflict");
217:     if (prior.message_id === applyingMessageId)
218:       return { ...prior, state: "in_flight", replay: true };
219:     return { ...this.reconcile(prior), replay: true };
220:   }
221:   abandon(
222:     input: {
223:       scope_id: string;
224:       session_id: string;
225:       message_id: string;
226:       expected_version: number;
227:       reason: string;
228:       evidence_sha256: string;
229:     },
230:     now = Date.now()
231:   ) {
232:     if (
233:       !input.reason ||
234:       input.reason.length > 1000 ||
235:       !/^[a-f0-9]{64}$/.test(input.evidence_sha256)
236:     )
237:       throw new Error("resolution_evidence_required");
238:     return this.store.write(this.owner, () => {
239:       const db = this.store.db;
240:       const session = new SessionRepository(db, this.store.path).getSession(
241:         input.session_id
242:       );
243:       if (!session || session.version !== input.expected_version)
244:         throw new Error("version_conflict");
245:       const scope = this.store.getScope(input.scope_id);
246:       if (
247:         !scope ||
248:         scope.task_id !== session.task_id ||
249:         scope.repo_path !== realpathSync(session.repo_path)
250:       )
251:         throw new Error("scope_mismatch");
252:       const message = db
253:         .prepare(
254:           "SELECT state FROM session_messages WHERE message_id=? AND session_id=? AND direction='inbound'"
255:         )
256:         .get(input.message_id, input.session_id) as
257:         | { state: string }
258:         | undefined;
259:       if (!message || !["accepted", "failed"].includes(message.state))
260:         throw new Error("receipt_not_uncertain");
261:       if (
262:         db
263:           .prepare(
264:             "SELECT 1 FROM session_continuation_attempts a JOIN session_continuation_grants g ON a.grant_id=g.grant_id WHERE g.session_id=? AND a.status IN ('checking','reserved')"
265:           )
266:           .get(input.session_id)
267:       )
268:         throw new Error("continuation_in_flight");
269:       const prior = db
270:         .prepare(
271:           "SELECT * FROM attention_receipt_resolutions WHERE message_id=?"
272:         )
273:         .get(input.message_id) as
274:         | { reason: string; evidence_sha256: string }
275:         | undefined;
276:       if (
277:         prior &&
278:         (prior.reason !== input.reason ||
279:           prior.evidence_sha256 !== input.evidence_sha256)
280:       )
281:         throw new Error("resolution_conflict");
282:       db.prepare(
283:         "INSERT OR IGNORE INTO attention_receipt_resolutions VALUES(?,?,?,'abandoned_unknown',?,?,?)"
284:       ).run(
285:         input.message_id,
286:         input.session_id,
287:         input.expected_version,
288:         input.reason,
289:         input.evidence_sha256,
290:         now
291:       );
292:       db.prepare(
293:         "UPDATE attention_actions SET state='abandoned_unknown',updated_at=? WHERE message_id=?"
294:       ).run(now, input.message_id);
295:       db.prepare(
296:         "UPDATE attention_items SET state='answer_abandoned',revision=revision+1,updated_at=? WHERE item_id IN (SELECT item_id FROM attention_actions WHERE message_id=?) AND state<>'answer_abandoned'"
297:       ).run(now, input.message_id);
298:       return {
299:         disposition: "abandoned_unknown",
300:         message_id: input.message_id,
301:         replayed: false,
302:         execution_outcome: "unknown",
303:         next_action:
304:           "New manual instruction only; original message is never resent",
305:       };
306:     });
307:   }
308:   recover(): void {
309:     const rows = this.store.db
310:       .prepare(
311:         "SELECT * FROM attention_actions WHERE state IN ('reserved','uncertain')"
312:       )
313:       .all() as Action[];
314:     for (const row of rows) this.reconcile(row);
315:   }
316:   reconcile(action: Action, now = Date.now()): Action {
317:     return this.store.write(this.owner, () => {
318:       if (
319:         this.store.db
320:           .prepare(
321:             "SELECT 1 FROM attention_receipt_resolutions WHERE message_id=?"
322:           )
323:           .get(action.message_id)
324:       )
325:         return { ...action, state: "abandoned_unknown" };
326:       const receipt = this.store.db
327:         .prepare("SELECT state FROM session_messages WHERE message_id=?")
328:         .get(action.message_id) as { state: string } | undefined;
329:       const state =
330:         receipt?.state === "applied"
331:           ? "applied"
332:           : receipt?.state === "failed"
333:           ? "uncertain"
334:           : "uncertain";
335:       this.store.db
336:         .prepare(
337:           "UPDATE attention_actions SET state=?,updated_at=? WHERE action_id=?"
338:         )
339:         .run(state, now, action.action_id);
340:       this.store.db
341:         .prepare(
342:           "UPDATE attention_items SET state=?,revision=revision+1,updated_at=? WHERE item_id=? AND state<>?"
343:         )
344:         .run(
345:           state === "applied" ? "answer_applied" : "answer_uncertain",
346:           now,
347:           action.item_id,
348:           state === "applied" ? "answer_applied" : "answer_uncertain"
349:         );
350:       return { ...action, state, updated_at: now };
351:     });
352:   }
353: }

## PINNED_SOURCE/packages/core/src/state/db.ts:200-285



## PINNED_SOURCE/packages/cli/src/daemon.ts:1250-1305

1250:         if (!p || Array.isArray(p) || Object.keys(p).some(key => !keys.includes(key)) || typeof p["scope_id"] !== "string" || !/^[a-f0-9]{64}$/.test(p["scope_id"]) || (!status && (typeof p["item_id"] !== "string" || !/^[a-f0-9]{64}$/.test(p["item_id"]) || typeof p["model_id"] !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(p["model_id"])))) throw new Error("invalid_triage_request");
1251:         const service = await getAttentionTriage(ctx);
1252:         if (ctx.draining) throw new Error("draining");
1253:         return singleOk(req.id,status ? service.diagnostics(p["scope_id"]) : await service.run({scope_id:p["scope_id"],item_id:p["item_id"] as string,model_id:p["model_id"] as string}));
1254:       }
1255:       if (req.method === "attention.lesson-evidence") {
1256:         const p = req.params as Record<string, unknown> | undefined;
1257:         if (!p || Array.isArray(p) || Object.keys(p).some(key => !["runId", "repoPath", "default_tenant"].includes(key)) || typeof p["runId"] !== "string" || typeof p["repoPath"] !== "string" || p["default_tenant"] !== true) throw new Error("invalid_lesson_request");
1258:         ctx.supervision.store.assertOwner(ctx.supervision.observer.owner);
1259:         const {readEvidenceLesson} = await import("./attention-lesson.js");
1260:         if (ctx.draining) throw new Error("draining");
1261:         const result = await readEvidenceLesson(ctx.db, {runId:p["runId"],repoPath:p["repoPath"],default_tenant:true});
1262:         ctx.supervision.store.assertOwner(ctx.supervision.observer.owner);
1263:         if (ctx.draining) throw new Error("draining");
1264:         return singleOk(req.id, result);
1265:       }
1266:       if(req.method==="attention.abandon-receipt") {
1267:         const p=req.params as {scope_id:string;session_id:string;message_id:string;expected_version:number;reason:string;evidence_sha256:string;acknowledge_unknown_effects:boolean};
1268:         if(!p||p.acknowledge_unknown_effects!==true)throw new Error("explicit_unknown_effects_ack_required");
1269:         if(ctx.activeSessionSends.has(p.session_id))throw new Error("delivery_in_flight");
1270:         return singleOk(req.id,new AttentionActions(ctx.supervision.store,ctx.supervision.observer.owner).abandon(p));
1271:       }
1272:       if (req.method === "attention.answer") {
1273:         const p=req.params as {scope_id:string;item_id:string;action_id:string;revision:number;content_hash:string;text:string;takeover:boolean};
1274:         if (!p || typeof p.takeover!=="boolean" || typeof p.text!=="string")throw new Error("bad_request");
1275:         const item=ctx.supervision.store.getItem(p.scope_id,p.item_id);if(!item)throw new Error("not_found");
1276:         const actions=new AttentionActions(ctx.supervision.store,ctx.supervision.observer.owner);
1277:         const replay=actions.replay(p,ctx.activeSessionSends.get(item.session_id));if(replay)return singleOk(req.id,replay);
1278:         const session=ctx.sessions.getSession(item.session_id);if(!session)throw new Error("source_missing");
1279:         const adapter=ctx.adapters.get(session.agent_id);
1280:         if(!session.resume_supported||!session.native_session_id||!adapter||!isSessionCapableAdapter(adapter)||!adapter.sessionCapabilities().resume)throw new Error("resume_unsupported");
1281:         if(ctx.activeSessionSends.has(session.session_id))throw new Error("session_busy");
1282:         let admission: Awaited<ReturnType<typeof acquireManualSessionAdmission>>;
1283:         try { admission = await acquireManualSessionAdmission(ctx, session, `pending:${p.action_id}`); }
1284:         catch { return singleErr(req.id, "admission_denied", "Session execution admission was denied; no answer was reserved"); }
1285:         let handedOff = false;
1286:         try {
1287:         if (ctx.draining || admission.controller.signal.aborted) return singleErr(req.id, "admission_denied", "Session execution was cancelled; no answer was reserved");
1288:         const action=actions.reserve(p);
1289:         if(action.replay)return singleOk(req.id,action);
1290:         handedOff = true;
1291:         const execution=await executeReservedSessionTurn(ctx,req,{session_id:session.session_id,runtime_id:session.agent_id,turn_id:item.turn_id,message_id:action.message_id,expected_version:action.reservation_version-1,text:p.text},session,adapter,action.reservation_version,{admittedLease:admission.lease,controller:admission.controller});
1292:         return singleOk(req.id,{...actions.reconcile(action),execution_error:execution.error?.code??null});
1293:         } finally { if (!handedOff) await admission.release(); }
1294:       }
1295:       return singleOk(req.id,await ctx.supervision.handle(req.method,req.params));
1296:     } catch(error) {return singleErr(req.id,error instanceof Error?error.message:"attention_error","Attention request failed; refresh source facts before retrying");}
1297:   }
1298:   switch (req.method) {
1299:     case "deployment.identity":
1300:       return ctx.deploymentIdentity
1301:         ? singleOk(req.id, ctx.deploymentIdentity)
1302:         : singleErr(req.id, "identity_unavailable", "Deployment identity unavailable");
1303:     case "version":
1304:       return singleOk(req.id, {
1305:         version: DAEMON_VERSION,

## PINNED_SOURCE/packages/core/src/state/attention-store.ts:45-105

45:   state: string;
46:   created_at: number;
47:   updated_at: number;
48:   external_message_id: string | null;
49: }
50: type ItemRow = Omit<AttentionItem, "decision"> & { decision_json: string };
51: function parseItem(row: ItemRow): AttentionItem {
52:   const { decision_json, ...rest } = row;
53:   return {
54:     ...rest,
55:     decision: SessionDecision.parse(JSON.parse(decision_json)),
56:   };
57: }
58: export class AttentionStore {
59:   constructor(readonly db: Database.Database, readonly path: string) {}
60:   /** Only called AFTER the daemon's process lock is acquired. Not an executor lease. */
61:   claimOwner(instanceId: string): AttentionOwner {
62:     return withWrite(this.db, this.path, () => {
63:       this.db
64:         .prepare(
65:           `INSERT INTO daemon_owner(singleton,home_id,instance_id,generation) VALUES(1,?,?,1)
66:         ON CONFLICT(singleton) DO UPDATE SET instance_id=excluded.instance_id,generation=generation+1`
67:         )
68:         .run(randomUUID(), instanceId);
69:       return this.db
70:         .prepare(
71:           "SELECT home_id,instance_id,generation FROM daemon_owner WHERE singleton=1"
72:         )
73:         .get() as AttentionOwner;
74:     });
75:   }
76:   assertOwner(owner: AttentionOwner): void {
77:     if (
78:       !this.db
79:         .prepare(
80:           "SELECT 1 FROM daemon_owner WHERE singleton=1 AND home_id=? AND instance_id=? AND generation=?"
81:         )
82:         .get(owner.home_id, owner.instance_id, owner.generation)
83:     )
84:       throw new Error("stale_owner");
85:   }
86:   write<T>(owner: AttentionOwner, fn: () => T): T {
87:     if (this.db.inTransaction) {
88:       this.assertOwner(owner);
89:       return fn();
90:     }
91:     return withWrite(this.db, this.path, () => {
92:       this.assertOwner(owner);
93:       return fn();
94:     });
95:   }
96:   registerScope(
97:     owner: AttentionOwner,
98:     taskId: string,
99:     repoPath: string
100:   ): AttentionScope {
101:     const canonicalRepo = realpathSync(repoPath);
102:     if (!statSync(canonicalRepo).isDirectory())
103:       throw new Error("repository_directory_required");
104:     return this.write(owner, () => {
105:       const task = this.db
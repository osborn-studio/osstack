# V2 决策：审计后的实施契约

状态：设计规范；本 PR 已实现默认关闭的 adopt_session 本地试点，其他架构阶段仍待实现，真实环境资格尚未完成。原规范由 Claude Code `claude-fable-5-1` 挑战和宿主逐项源码核验形成；实现经过 `claude-sonnet-5-5` 复审。本页细化主设计与试点；冲突处理必须修改相关正文，不依赖实现者猜测。

## ADR-01：先采纳现有会话，再实现从目标自动派发

第一试点采用 `adopt_session` 模式。用户通过一个入口采纳精确的 Task/Run/Session，处理决定并观察后续结果。首个试点仅采纳当前为 awaiting_decision、具有有效普通产品选择/外部输入问题且 native_session_id 非空的 Session。它不扫描旧合同启动工作，不启动初始 Worker，不自动选择 Loop/Graph。后续 `goal_dispatch` 模式才交付“一句话目标 → 自动工程执行”。两个里程碑分别验收，不能以采纳试点完成代替最终目标。

最小 Mission 仅有身份、关联、用户目标、完成级别、状态、修订号、scope/policy 摘要及事件。step 在试点中是稳定的 Session/Run 绑定；以后增加计划时保持 step_id，变更依赖需要新的计划版本，不删除旧义务。

试点对同一来源决定实行 once-adopt：只要该精确决定已有 Mission，就不能再次采纳，返回 `authority_already_adopted`。即使原 Mission 尚未创建回答 action，用户随后 cancel 或 endObservation，也不释放此决定的采纳权威。用户可直接处理原 Session，或在真实新 turn/新问题出现后采纳新决定；不得改写 decision_id 伪造新来源。

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

兼容决定：`action_id` 保留现有 attention 账本的全局唯一命名空间，跨 Mission、principal 和旧 attention 命令共享；本试点不迁移旧键，也不静默加前缀。客户端为每个新回答生成一次全局 UUID（或包含全局唯一 Mission ID 的键，例如 `MISSION_ID:answer001`），持久保存该键，并在同一回答的重放和查询中复用。不同动作复用同一键会冲突，不能因失败自动换键。`request_id` 则在认证 principal/client 范围内唯一；同一键改变操作类型或正文返回 `action_conflict`。

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

取消结果按入口精确表述：`engineering.decide` 以相同 action_id 和相同正文重放原动作，或 `engineering.reconcile query_action` 查询该动作，返回状态 `cancelled_before_dispatch`；旧 `session.send` 对相同原消息的重放返回错误码 `cancelled_original_answer`；attention.answer replay 和只读视图显示同一已证明取消处置，不能再显示 delivery_uncertain。证明不完整或与 applied 矛盾时保持一致性错误，不能仅凭 phase 标签宣称未派发。committed 未确认的旧行为仍保留未知。写入和 dispatcher 共享 FULL 写事务与 owner fence，不能先在事务外检查 resolution，再在事务内盲目 CAS；只读视图不执行迁移或修复。

保留 attention_actions.item_id UNIQUE：重启继续原 reserved action，不创建第二回答。取消是该动作的终结；原 action 的同正文重放仍返回 `cancelled_before_dispatch`，改变正文返回 `action_conflict`，不能重新开启。取消或结束观察后，使用新 action_id 提交本 Mission 的新回答返回 `mission_terminal`；这与旧 `session.send` 的 `cancelled_original_answer` 是不同入口的契约。新问题、新 turn 可以产生新 action。试点不支持对同一个旧 item 再答，也不允许通过另建 Mission 重采同一决定，即使原 Mission 从未创建回答 action 也返回 `authority_already_adopted`。用户可直接处理原 Session，或在有真实新来源问题后重新采纳；不得伪造新 decision_id 绕过约束。该边界不阻塞同 Session 的其他合法新指令，也不把用户重新授权推导为旧动作未执行。

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

若原回答已完成，但在下一次 refresh 前用户已推进后续人工 turn，最新 turn 与原回复证据不同，原 Mission 可保持 observing。用户须读取原 action 回执和 Session 回合记录；不再需要观察时可明确 endObservation，而非重发回答或强制写 completed。

D07/D08 仅验收场景清单中 delivery_stage=adopt_session 的全部条目。其余条目由命名的后续工作包验收；不能标通过或删除。第一试点并不具备生产隔离资格。


## ADR-15：取消与结束观察权限（P2 定案，2026-10-25）

Engineering 入口只接受经宿主凭据认证的 principal。客户端 JSON 的 actor、role 或权限声明不得成为权威。读、写、停止与 operator 身份分别按 scope 授权，恢复派发前重新读取当前宿主权限。

| 操作 | 允许的主体 | 限制 |
|---|---|---|
| adopt | 当前具备 scope read+write 的认证主体 | 记录不可变 owner_principal_id |
| decide / defer / dispose_wait | owner，且当前 scope read+write 有效 | 其他 writer 不能接管目标；未知发送不能经 dispose 清除 |
| cancel | owner 且独立 scope stop 权有效；或明确的 scope-stop operator | write 不是 stop；只停止已绑定的 Mission/Run/action。owner 写权被撤销后，仍有效的停止权可用 |
| endObservation | owner 且 scope read 有效；或明确 operator 且 scope read+stop 有效 | 结束观察不是停止 Worker；不是成功；不清除未知回执 |

完全撤销的凭据拒绝一切操作。恢复通道由宿主另行授权的 scope-stop operator 提供，不临时扩大其他 writer 权限。权限配置必须保留明确的停止责任人；不能把“停止不被未知发送阻塞”解释为未认证用户也可停止。

cancel/endObservation 均先验证身份和精确 scope，再处理同 principal/request/payload 的只读重放；首次写入使用 Mission revision CAS。结束观察禁止本 Mission 后续首次派发；仅严格证明未提交的 reserved action 可变成 cancelled_before_dispatch，committed/unknown 保留原 attention 责任。宿主停止回执不确实时显示 stop_unknown，绝不把权限通过当成停止成功。

本地试点凭据文件位于独立 OSSTACK_HOME，由宿主控制；只适用于受信进程环境。同 UID 恶意 Worker 的隔离没有因此得到认证。实现细节与并行边界见 [实施交接](implementation-handoff.md)。

ADR-15 clarification (implementation review): current scope read permission is a prerequisite for every Mission RPC, including cancel. Cancellation additionally requires the owner’s independent scope stop permission, or scope stop plus operator permission. Write revocation does not revoke read or stop. A stop-only principal without read is denied because the response contains Mission and receipt data. This pilot does not expose a blind-stop endpoint.


## ADR-16：schema 47 升级阻断与明确恢复边界

schema 47 迁移后，旧 schema binary 拒绝打开该 home。只替换旧 binary 或退回旧 npm 版本不是受支持回退；本试点不交付数据库 downgrade 或自动 rollback。备份不构成丢弃迁移后动作/外部副作用证据的许可。

升级只接受原消息 applied 或严格证明 cancelled_before_dispatch 的 dispatch 行。reserved、committed 未 applied、缺失或矛盾证明均形成 attention_dispatch_holds。committed 的 failed/unknown/abandoned_unknown 处置仍保留 hold；取消意图、结束观察、关闭功能和恢复 daemon 接收工作都不清除它。没有原 applied 证据的未决 committed 行可无限期阻止升级。本试点没有受支持自动解除或数据库回退通道；保留原 home、账本和外部证据，待另行审核的离线恢复方案处理，不能手改数据库绕过。

托管升级的 resolveAuthority 在 drain/安装之前写入持久 upgrade-operation.json。已有 hold 时不要发起托管升级；后续失败仍保留 operation fence 和 journal，标记 recovery_required。daemon.resume 只恢复存活 daemon 的接收状态，不清除 operation fence，后续托管启动仍可能 upgrade_start_blocked。committed 未知动作的持续 hold 也阻止现有 upgrade reconcile 完成；本试点没有针对这类失败的受支持 fence 清除/操作员放行通道。必须保留 fence、journal 与 home，待另行审核并实现的恢复方案处理；不得手改文件解除、伪造 complete 命令或声称 resume 已完成升级恢复。

升级调用 daemon.drain 会先锁存 draining，即使结果 drained=false 或升级随后中止也不自动恢复。原 reserved 可经已授权的精确 cancel 取得未派发证明；未知 committed 不能借此释放。放弃升级并继续运行当前版本前，操作员先确认无安装/重启/其他维护仍在进行，再显式调用 daemon.resume RPC，并读取 health 确认 draining=false。该动作恢复正常准入，包括符合条件的待派发工作；应先处理不应执行的 reserved。它不是清除 hold 或停止未知 Worker 的证明。持续不健康条件仍可再次触发 draining。

已核对当前 CLI：没有 osstack daemon resume 或通用 osstack rpc 子命令。现有 osstack health 可查状态；精确 socket 的单次 Node RPC 操作步骤见[中文运行指南](../../guides/engineering-session-adoption.md)与[英文运行指南](../../guides/engineering-session-adoption.en.md)。不以不存在的子命令描述恢复。以 -- 开头的业务文本通过 --input 的严格完整请求 JSON 传入，避免把文本当作选项；此方式不改变身份或授权边界。

运行错误须保留准确含义：draining 表示暂停准入，可读/查询/已授权停止仍保留；dispatch_gate_required 要求原动作通过统一派发门，不能改用旧 session.send 绕过；dispatch_inconsistent 表示 phase、message 或 proof 不一致，须保留证据并停止新写入调查。

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
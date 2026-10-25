## 1. 设计就绪度结论

**接近可实施，但不能整体宣布进入有界实施。** 架构层的单一权威、三种版本分离、三线性化点、applied 含义和试点闭包都已收敛，F51-11 的否证成立。剩余 5 项 P1 全是一段文字就能落定的实施决定，没有一项需要改架构。它们集中在 dispatch phase 的重启处理、取消处置的 schema 可行性、Session 来源代数的具体定义、人工干预的处置入口、采纳模式的完成定义。

可立即开工：C01、C02、D03、D01 主体。必须等 R2-01 至 R2-05 落文：D04、D06、D02 的 phase 表、D07。运行时未实现本身不计为缺陷。

## 2. 处置表

| ID | 处置 | 理由 |
|---|---|---|
| F51-01 | 关闭 | ADR-02 旧 approved 恒为 manual；controller_once 独立对象，同事务一次消费；E02 验收含旧行零执行 |
| F51-02 | 部分 | lease 已删，daemon_owner 为唯一 fence。但 Session 类来源的 source_instance_id/source_generation 无具体定义，见 R2-03 |
| F51-03 | 关闭 | C02 先于 D02，validate 强制 C02 在闭包内 |
| F51-04 | 关闭 | D08 闭包为 C01/C02/D01–D07/V00，validate 强制无 R/E |
| F51-05 | 关闭 | ADR-04 三版本分离、正文与 token 一致、replay 先于过期，与 reserve 现有 stale_item/action_id_conflict 兼容 |
| F51-06 | 部分 | 宿主拒绝"取消后仍无条件发送"成立，三线性化点正确。但 cancelled_before_dispatch 被 migration 41 CHECK 禁止，且重启后 reserved 行无出口，见 R2-01/02 |
| F51-07 | 驳回有理，试点内关闭 | flock 不覆盖子进程树，批评成立。采纳模式不启动第二写者，unknown 不阻塞试点；完整证明归 C04/E 系列 |
| F51-08 | 关闭 | 单连接 daemon 上 FULL 并读回；两种 recovery_mode 分级；性能另测不回退 |
| F51-09 | 部分 | 宿主拒绝"任意新 turn 加人工消息即 supersede"成立。但"可信人工处置"在试点无记录入口，needs_reconciliation 无退出，见 R2-04 |
| F51-10 | 部分 | 新 schema 覆盖矩阵、签发者、前置、撤销。trust store 的 key→role→level 绑定与 revocation_epoch 发布权威未定；试点不加载，降 P2 |
| F51-11 | 驳回 | `db.ts:115-119` 对 user_version=46 的库，expected 集合含 migration 40–43 的 attention 表，不会拒绝。第 113 行注释已过时 |
| F51-12 | 关闭 | answer_recorded 同事务归属；tenant 预检返回 executor_not_qualified |
| F51-13 | 关闭 | 硬限额仅宿主可控量；费用 observed |
| F51-14 | 关闭 | 引用 CapabilityKind 与模板版本；影子不重复生产写 |
| F51-15 | 关闭 | 宿主拒绝按关键词推权有理；权限由 gate_kind 决定 |
| F51-16 | 关闭 | 三态差异规则，validate 校验 scenario 引用 |
| F51-17 | 关闭 | 开 PR 为具体授权，不推导合并部署 |
| F51-18 | 关闭 | V00 前置并进入 D08 依赖 |
| H01 | 关闭 | `daemon.ts:1035-1055` 证实 applied 在 completeInboundTurn 同事务写入；`options.completed` 钩子可承载同事务清除 |

## 3. 剩余缺口

**R2-01 P1 重启后 reserved 行既不派发也不能重答，形成死锁；准入与 CAS 顺序未定。**
位置：ADR-05"重启后不自动转入 T-dispatch"；migration 40 `attention_actions.item_id UNIQUE`；`attention-actions.ts:26-33`。
反例：decide 提交，phase=reserved，消息 accepted。daemon 崩溃重启。按 ADR-05 不派发。用户想重答：该 session 任何新预留命中 delivery_uncertain。即使写了 cancelled_before_dispatch，item_id UNIQUE 使同一问题永不能再有 action。Worker 停在 awaiting_decision，Mission 停在 answer_recorded，用户没有任何出路。
分析：dispatch_committed 在 FULL 事务中先于任何 resume 调用写入。由新 dispatcher 创建且仍为 reserved 的行，本身就是 ADR-05 要求的"从未进入 dispatch_committed"证明。禁止重启派发没有安全收益。宿主对"取消后仍发送"的否定只适用于存在 stop_intent 的情形。
最小改动：(a) 重启后，非 legacy 的 reserved 行在 owner fencing 通过、无 stop_intent、session.version 与 turn_id 仍等于预留时值的条件下进入 T-dispatch；有 stop_intent 则写 cancelled_before_dispatch。(b) 固定派发序列：acquireSessionAdmission 成功且 signal 未 aborted，然后单事务 assertOwner、读 stop_intent、CAS reserved→dispatch_committed，然后立即调用 executeReservedSessionTurn，中间不 await 其他事务。CAS 前任何失败不改 phase。(c) reservation_version 必须持久化，因为 attention_actions 没有该列且 replay 返回 0。
测试：reserve 后 SIGKILL，重启后恰好一次 resume 并最终 applied；reserve 后先 cancel 再重启，零次调用且得到 cancelled_before_dispatch；准入被拒时 phase 保持 reserved。

**R2-02 P1 cancelled_before_dispatch 被现有 CHECK 禁止，守卫联动与单一派发门未定。**
位置：migration 41 `CHECK(disposition='abandoned_unknown')`；`attention-actions.ts:29` 子查询只看 attention_receipt_resolutions；`db.ts:101-106` 以 CREATE TABLE 推导谱系，重建表违反该契约；`daemon.ts` 第 805 行前对已存在消息的分支本包不可见。
反例：实施者向 attention_receipt_resolutions 写新处置，INSERT 被 CHECK 拒绝。改新表后未改守卫，该 session 永远 delivery_uncertain。另一方向：现有 attention CLI 对已 reserve 的 action 走 replay 再 session.send，若 daemon 对已存在 accepted 消息的分支直接执行，就绕过 CAS，与 dispatcher 双重 resume。
最小改动：迁移 47 新增 `attention_dispatch_phases`，列为 action_id 主键、message_id 唯一、phase 限定三值、reservation_version、daemon_generation、stop_intent_id、proof_json。守卫子查询同时排除该表中 phase=cancelled_before_dispatch 的 message_id。daemon 内任何以已存在 accepted 消息触发执行的分支，若该消息在 phase 表中，必须先完成同一 CAS，否则返回 dispatch_gate_required。
测试：处置后同 session 新预留不再 delivery_uncertain；两个入口并发执行同一 reserved action，resumeSession 恰好一次；46→47 后 assertMigrationLineage 通过。

**R2-03 P1 Session 类来源的 source_instance_id 与 source_generation 无定义。**
位置：ADR-03 表第 2 行；pilot §4 `answer_applied`；session 表只有 session_id、native_session_id、version、turn_id、run_id。
反例：D06 填 source_generation。实施者 A 用 session.version，B 用 run 尝试序号，C 用 attention_subjects.generation。C 实为 daemon generation，正是 ADR-03 禁止的。三种实现对"来源 generation 改变需对账"场景结果不同。
最小改动：试点为 session_decision 主体冻结 source_instance_id 为 session_id 加 native_session_id；source_generation 在试点恒为 1，native_session_id 变化即视为源替换。answer_applied 以 action_id、message_id、completed_turn_id、session_version 四元组为准，在 executeReservedSessionTurn 的 completed 钩子同事务写入。
测试：native_session_id 变化后旧 obligation 进入 needs_reconciliation；正常 applied 只解除目标边。

**R2-04 P1 用户直接操作 Worker 后没有试点可用的处置入口。**
位置：ADR-07 末两段；pilot §7.1；design §3.3 第 5 条；engineering.reconcile 只收 action_id 或 receipt ID。
反例：用户在 Worker 终端直接回答。新 turn 出现，decision 消失，markMissing 置 source_missing。没有 session_messages 行，没有 action。obligation 进入 needs_reconciliation。reconcile 接口没有此 wait 的输入形态，无人能写"可信人工处置"，步骤永久 blocked，WD-32 不可实现。
最小改动：engineering.reconcile 增加变体 `dispose_wait`，字段 wait_id、if_wait_revision、disposition 二值 human_answered_out_of_band 或 no_longer_relevant、observed_turn_id、note。要求认证 actor 对 scope 有写权。写 mission_events.steering_recorded 与 obligation superseded，引用 item_id、旧 turn_id、observed_turn_id。采纳模式下该处置即 ADR-07 所指"精确处置证据"，使步骤可运行。不携带回答正文，不触发任何 send。
测试：WD-32 无处置时为 needs_reconciliation；处置后为 superseded 且无新 session_messages 行；伪造 actor 被拒。

**R2-05 P1 采纳模式的 Mission 完成条件未定义。**
位置：ADR-01；pilot §7.5；退出标准 1；D08 验收只写"观察真实回复回合"。
反例：回答 applied，session 进入 idle。无 Worker 在跑，无检查执行器。实施者把 idle 当完成，则 Run 未终止却报完成；等 Run terminal，则外部驱动的 Run 可能永不收敛且无提示。
最小改动：试点 completion_level 只允许 observed_terminal。被采纳 Run 到达 terminal 且所有 obligation 为 cleared 或 superseded 时 Mission=completed，CompletionProof 引用 run 终态与候选摘要，不引用检查结果。Run terminal 但仍有 open obligation 时为 needs_reconciliation。
测试：idle 不触发 completed；Run terminal 且 obligation 全清则 completed 并引用 run 终态。

**R2-06 P2 非阻塞，应在相关 PR 前落文。**
- trust store 需绑定 signer_key_id→issuer_role→允许 level，否则 ci_verifier 密钥可签 host_verified；revocation_epoch 当前值由谁发布未定。属 R02。
- mission_revision 是否随观察新鲜度更新递增未定；若递增，decide 的 if_revision 频繁失败。建议只在目标变化、取消、重规划、处置时递增。属 C02。
- pilot §5 说 token 绑定 wait revision，ADR-04 的 token 字段无 wait_revision。以 ADR-04 为准修改 §5。
- `db.ts:113` 注释与 115–119 行逻辑不符，应改为"低于 25 且含实验表的历史库"。

## 4. 改进的首批实施序列

1. X0 落文：R2-01 至 R2-05 写入 runtime-contract-v2，同步修订 pilot §4、§5、§7。
2. C01 加 D01：含 R2-03 来源字段、R2-04 dispose_wait 变体、R2-05 completion_level。
3. C02 加 D02 加迁移 47：mission、mission_events、wait_obligations、attention_dispatch_phases 同一迁移批次。
4. D03：验证 reserve 已可在外层 withWrite 内组合，因为 store.write 的 inTransaction 分支与嵌套 savepoint 已支持；同事务追加 answer_recorded。预计改动小。
5. D04：按 R2-01 固定序列实现 dispatcher，含重启派发、cancelled_before_dispatch、守卫改造、daemon 已存在消息分支的 CAS 门、FULL 读回。
6. D06：用 completed 钩子同事务清除；dispose_wait；observed_terminal 完成判定。
7. D05 与 D07 并行；D07 必含 R2-01、R2-02、R2-04 三组测试与 WD-32。
8. D08 加 V00。R 系列并行，不入闭包。
## 第四轮收口结论

**R3-01（P1）：关闭。** ADR-11 已写入三项修订：dispatcher CAS 事务内断言 `state=reserved` 且 resolutions 无该 message_id；reconcile/recover 先读 phase，新协议 reserved 不投影为 uncertain，cancelled_before_dispatch 映射为 cancelled；abandon 对 reserved 返回 not_dispatched_use_cancel，不写 resolution、不改 phase、不发送。原反例在新文本下不再成立：重启后 recover 保持 reserved，abandon 被拒且无写入，dispatcher 若运行只会按正常首次派发执行；用户若要阻止，必须走 T-cancel。文本正确区分"拒绝错误操作"与"取消成功"，WD-63/64/65 的拆分与此一致，不再要求被拒命令具有取消效果。

**R3-02（P2）：关闭。** ADR-13 冻结 owner_principal_id 在 adopt 时不可变、steer 仅限该 Mission、每次仍核当前 scope 权限；WD-66 覆盖双向拒绝。

**R3-03（P2）：关闭。** pilot §3 步骤 10 改为 ObservationProof 并把候选绑定推给 goal_dispatch；§5 错误表已含三个新码；WD-61 能力改为 FM-15/19；validation 的 58+4+1+3=66 与"8 条非试点"自洽。

## 剩余问题

无 P0、无 P1。新增 P2 两项：

- **P2-A 取消与结束观察的 principal 未写明。** ADR-13 只定义 steer 由 owner 持有；engineering.cancel 与 endObservation 的授权来源未说明。最短反例：owner 的 scope 写权被撤销后，按 ADR-13 无人可 dispose_wait，若 cancel 也被实现为 owner-only，则违反 ADR-05"停止不得被阻塞"。建议：cancel 仅要求 scope 写权，endObservation 由 owner 或 scope 写权持有者执行，一句话落入 ADR-13。
- **P2-B 旧二进制对新库的拒绝未核验。** ADR-11 把"phase=reserved 但 action 已 uncertain"归为 needs_reconciliation，这种状态在新代码下唯一来源是旧二进制跑了旧 recover()。ADR-08 称 lineage 检查"可以明确拒绝"，但 db.ts 200-285 为空片段，无法核对对更高 user_version 的行为。这不是文本缺陷，是运行时验证项；WD-63 的夹具也只能通过该路径或直写 DB 构造。

仍未核验（沿 R3）：store.write 嵌套 savepoint、lease.retain 跨重启、recover() 启动调用点。

## 设计就绪范围

ADR-05/11/13/14 的文本足以约束 D04 实施，C01、C02、D01–D04 可开工；D05–D07 依赖前者。覆盖范围不变：采纳 awaiting_decision Session、处理一个普通决定、观察回复回合。不覆盖 goal_dispatch、R/E 系列、生产隔离资格。design-validation.json 仅为设计一致性，`production_runtime_verified=false`，本结论不构成全盘 PASS。

## 运行时必须验证

1. **WD-63/64/65 三联**：reserve 后 SIGKILL，重启后断言 action 仍 reserved；abandon 返回拒绝且 resolutions、session_messages 零写入、adapter 零调用；随后 cancel 提交，dispatcher 写 cancelled_before_dispatch 且 resume 零次；夹具注入 abandoned_unknown 时派发零次并进入 needs_reconciliation。
2. **CAS 原子性**：cancel 与 dispatch 并发，终态恰为 committed 或 cancelled_before_dispatch 之一，不得先事务外检查再盲 CAS。
3. **取消回执一致**：handleSessionSend、attention.answer 重放、读视图对 cancelled 行返回同一回执；同 Session 新 send 不再 delivery_uncertain（WD-53）。
4. **旧二进制拒绝**：以 46 版二进制打开 47 版库必须被 lineage 检查拒绝；否则 P2-B 升级为 P1。
5. **权限边界**：WD-66 双向拒绝；owner 权限撤销后 cancel 仍可提交 stop_intent。
6. **FULL 与完成证据**：写连接读回 synchronous=FULL；Run 已 completed 的 Session 采纳后，仅 applied 加 completed_turn_id 匹配才 completed（WD-58/59）。
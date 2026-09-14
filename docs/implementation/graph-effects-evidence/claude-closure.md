**结论：C4 三项 followup 在最终代码中均已落地，无剩余阻断项，可以关闭。** 下面按项核对，末尾列两条非阻断备注。

**(1) 用量与证据保留** 已闭合。
- 包装适配器对 `tokens_in`/`tokens_out` 分别维护累计最大值，再求和后调用 observeTokens，测试覆盖了分事件上报 150+50 的情况。
- 持久化失败时 catch 分支进入 markUncertain，observedTokens 取 max(预留, 已观测)，证据引用优先用已保存的 persistedEvidenceRef，否则用 `unknown:` 诊断标记。畸形引用不会阻止不确定态落库，测试已验证。
- 结果校验失败时 persistedEvidenceRef 已在校验前赋值，所以 evidenceRef 与 actualTokens=150 都保留。
- 原始用量非法在生成器内抛出，此时 invoked 已为 true，走 unknown 并保留锁。合法超额走 recordOutcome confirmed，测试断言 accounting_blocked=1。

**(2) 未调用即失败的 retrySafe** 已闭合。
- beforeEffect 在三条路径上都位于物理效应之前：适配器路径在 original.invoke 之前，命令路径在 runShellCommand 之前，工作区路径在 handler 之前。
- 未调用分支记录 failed 且 retrySafe 为 !signal.aborted，取消保持封存。Broker 没有任何重试方法，响应对 failed 状态固定返回"无自动重试"。

**(3) 检查点配额** 已闭合。
- 构造函数拒绝未知键、非安全整数、小于 1 或高于固定上限的值，只允许收紧。
- checkRunLimits 在同一 fenced 事务中执行，先计数后求字节；失败回滚检查点、去重收据和 revision，测试验证 revision 不变且重开库后 get 仍可用。
- 幂等重放命中 prior 直接返回，不新增行，因此不消耗配额。

**父级权威服务** 对任何非 undefined 的 resolve 值抛错，包括 false。Broker 同步 authorize 对返回 Promise 的情况抛 POLICY_DENIED 且吞掉悬挂 promise 的拒绝。均符合描述。

**裁定确认。** 后效应阶段证据/DB 失败保留仓库锁，与 C3 的失败关闭边界一致；两处测试均断言 writes.in_use 为 1。我同意不因 worker 退出而释放身份不明的脏工作区。

**非阻断备注（记录即可，不要求本轮修改）：**

- **P2，字节扫描在写锁内执行。** 字节求和用了 `length(CAST(x AS BLOB))`，这会绕过 SQLite 对 length() 的头部快速路径，每次 put/writes 都要实际读取该 run 全部载荷，且此时事务已 BEGIN IMMEDIATE。worker 先把 run 填到接近 64MiB，再发送数万个小 writes 请求，每个请求都让守护进程在持有控制面写锁的情况下扫描 64MiB。计数先于字节的顺序把扫描次数限定在 requests 配额内，所以这是服务退化而非正确性问题。建议 G14 落地时用增量计数列或 BLOB 存储恢复快速路径。

- **P3，markRunning 未变更时的 retrySafe 路径。** 若 markRunning 返回 changed=false，抛出的 Denied 发生在 invoked 置位之前，catch 会对一个账本上已是 running 的 effectKey 调用 recordOutcome failed retrySafe=true。该情形要求同一代际内有其他参与者移动了本次刚创建的意图，在当前单进程端口下实际不可达。建议确认 GraphActionStore.recordOutcome 拒绝从非 reserved 状态转 failed，或在此分支排除 ACTION_OUTCOME_UNKNOWN 错误码，二者取一即可。

以上两条不改变闭合结论。C4 G11-G13 以当前代码关闭，后续按 C3 既有的信号/离线恢复处理隔离等待者。
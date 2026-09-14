**结论：本批未发现可由 worker 触发的 P1 阻塞问题。** 上一轮提出的 fence/thenable/slot 绑定/threadId/effectID 级准入等问题在代码中均已闭合：`fencedGraphTransaction` 在 BEGIN IMMEDIATE 内重读并校验 generation/owner/revision/lease；broker 与 checkpoint service 都在异步边界后只刷新 revision、保留注册时的 generation/owner/identity；`authorize()` 返回非 undefined 即拒绝；`reserve` 对已有 slot 永不新建 attempt。以下为真实 P2 与需核实项。

**P2-1 broker catch 路径丢失已确认的物理证据，并错误隔离仓库**
位置：`graph-action-broker.ts` `handle()` 的 `catch (error)` 分支。
时序：
1. `execute()` 正常返回，`confirmStopped` 已确认停止，adapter 报告 `tokens_in+tokens_out` = 10×reservation。
2. `action.persist(evidence)` 抛错（G16 未实现时最可能），或 `GraphResult.parse`/"invalid result kind" 抛错，或 `recordOutcome` 遇 REVISION_CONFLICT。
3. catch 中 `markUncertain(..., { observedTokens: owned.reservationTokens })`：`measured`/`persisted` 是 try 内局部变量，全部丢弃。
后果：(a) 超额用量证据消失，`observed_tokens` = reservation，`accounting_blocked` 不置位，违背 `recordOutcome` 注释"over-cap usage 必须阻断"；(b) `lease.retain()` 把仓库加入 `quarantinedRepositories`，但 quarantine 语义是"外部停止未确认"，此处停止已确认，纯记录失败却冻结整个 repo 的所有写入直至进程重启。
最小修复：把 `measured`、`persisted`、`stopConfirmed` 提升到 try 外；catch 中 `observedTokens: Math.max(owned.reservationTokens, measured ?? 0, persisted?.actualTokens ?? 0)`，用量非法时传 `Number.MAX_SAFE_INTEGER` 强制 `accounting_blocked`；`evidenceRef` 优先用 `persisted.evidenceRef`；`stopConfirmed === true` 时仍写 unknown 但走 `release()` 而非 `retain()`，ledger 的 UNRESOLVED_ACTION 已足够阻断本 run 新准入。

**P2-2 唯一可信的"零效果"判定被记为 retrySafe:false，`retry()` 事实上不可达**
位置：同文件 catch 中 `!invoked` 分支 `recordOutcome({ state:"failed", retrySafe:false, error:"admission refused before invocation" })`。
`invoked` 仅在 `markRunning` 返回 changed=true 之后置位，其前无任何 spawn/invoke，这正是 adjudication 中"只有 broker 前置决策能证明零效果"的场景。现在 policy gate 瞬时拒绝、semaphore abort、跨进程 renewLease 造成的 REVISION_CONFLICT，都会把该 slot 永久钉死为 failed，worker 重试只得到"no automatic retry"，整条 run 只能等 G15。
最小修复：该分支 `retrySafe: true`（`failed` 仍按全额 reservation 计费，保守性不变）；`signal.aborted` 引起的取消可保留 false。

**P2-3 checkpoint 存储对 worker 无每 run 上限，可撑爆共享控制面 DB**
位置：`graph-checkpoints.ts` `put()/writes()`；`checkSize` 只限单个 (namespace, checkpoint_id) 地址 ≤4MB。
worker 持有效 lease 时可对无限多 (namespace, checkpoint_id) 组合发 `writes`，每请求最多 4MB 落盘，`deleteThread` 不支持，无回收路径；`preflightDiskSpace` 只在磁盘将满时 fail-closed，此前 loop 等其他子系统已共用同一 DB 受累。
最小修复：在 `execute` 事务内对 `graph_run_id` 统计 `count(*)` 与 `sum(length(...))`（两表），超过 spec.limits 派生的上限抛 `CHECKPOINT_RUN_LIMIT`；或至少给 `graph_checkpoint_writes` 加每 run 行数上限。

**需核实（我无法从给出片段确认）**
- `executePlan` 是否会在 `wrapper.invoke` 之外执行 plan 自带的命令（如 verification/test 命令）。若是，这些物理效果发生在 `beforeEffect()`/`markRunning` 之前，绕过 ledger 门。
- `runShellCommand` 正常退出时是否填充 `termination.stop_confirmed`。若只在 kill 路径填充，则所有成功的 command 动作都会走"external stop unconfirmed"→unknown→repo quarantine。
- `GovernedExecution.acquire` 中已在 `queue.acquire` 排队的等待者，在前者 `retain()` 后不会被唤醒，会无限挂起而非收到 reconcile 拒绝；只有 signal 能解开。

**同一 slot 并发重发**：transport 超时重发会立即拿到 unknown/reconcile 而不是等待在途请求，符合"lost response is pending"设计，不算缺陷，但可用每 effectKey 的 in-flight promise 去重改善。

以上三项均为 fail-closed 方向的正确性/活性问题，不构成绕过 stale-generation 或自授权的安全漏洞。
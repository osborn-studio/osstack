先说结论：C4 代码里有 1 个会直接卡死 G15/G17 重试路径的实现 bug，G15 提案里有 3 处 fence 定义缺口会把 run 或仓库锁死成永久 unknown，G16 有 1 个会销毁保留工作区的现有清理路径。其余是 P2。

## P1 阻塞

**1. 实现 bug：host retry 产生的 attempt 无法被 worker 执行。** `retry()` 在当前代插入 attempt 2 的 `intent` 行；worker 重放同 slot 时 `reserve()` 返回该行且 `created:false`，`handle` 立即走 `response()`，intent 状态落入 unknown 分支，返回“需要对账”。反例：gen1 attempt1 因 admission 拒绝记 failed/retrySafe，host 调 retry，worker 重放，结果永远是 ACTION_OUTCOME_UNKNOWN，attempt 2 永远停在 intent 并阻塞 admit。最小修正：broker 维护进程内 `inFlight: Set<effectKey>`；当 `!created` 但 `action.state === "intent" && action.generation === binding.generation && !inFlight.has(key)` 时继续走 markRunning，由其 CAS 保证单次启动。同代重复请求仍被 inFlight 挡住。

**2. 设计缺口：跨代行不可对账。** `markUncertain`/`recordOutcome` 都要求 `prior.generation === run.generation`。一旦 `acquireLease` 拿到 N+1，gen N 的 running/intent 行永久无法结算，`admit` 又永久 UNRESOLVED_ACTION。提案说恢复 fence “同 generation 检查”不成立。最小定义：恢复 fence = 当前 run 的 scope/program/generation/revision/owner/time 检查，去掉 TERMINAL 检查，允许 lease 过期；额外要求 `row.generation <= run.generation`，且当 `row.generation < run.generation` 时必须在 `graph_worker_leases` 中找到 generation = row.generation+1 那行的 `stopped_worker_json` 且其 owner/generation 与行匹配；当相等时按 acquireLease 同规则校验调用方提供的收据。顺序必须固定为：broker 排空该连接在飞 handle → 发出止收据 → acquireLease(N+1) → 对账所有 ≤N 行 → 释放锁 → 启动 worker。否则收据 confirmedAt 会早于对账写入的 updatedAt，acquireLease 报 STOPPED_WORKER_MISMATCH。

**3. 设计缺口：终态 run 封死对账。** cancel 请求把状态投影成 `cancelled` 时 ledger 仍有 running/unknown 行，之后任何恢复写入都被 `checkGraphRunFence` 的 TERMINAL_RUN 拒绝，仓库锁永久保留。最小修正：恢复 store 的 fence 不做终态检查且永不改 status；同时 `projectRequest` 对 `cancelled/failed/ready` 增加“ledger 静止”前置，非静止只能投影到 `cancel_pending`/`reconciliation_required`。

**4. 设计缺口：物理调用身份没有在调用前落盘。** `executionRef` 固定为 `graph-execution:<effectKey>`，与 `task.run_id`、PID、命令无关，verifier 拿到 effectKey 后无法绑定“到底哪个外部进程”。最小修正：`beforeEffect(task.run_id)`，executionRef 改为 `graph-execution:<effectKey>:<task.run_id>`；不同 run_id 触发 EXECUTION_CONFLICT 转 unknown 的语义保持不变。决策收据必须回填并比对此 executionRef。

**5. 设计缺口：GovernedExecution 无对账释放且隔离不计数。** `quarantinedRepositories` 是 Set，没有任何清除路径；若 G15 加“清除”，同仓库另一个 retained 租约会被误放开。daemon 重启后内存状态全失，只剩文件锁。最小修正：改为 `Map<repoId, Set<runId>>`；新增 `releaseReconciled({repoId, runId, proofRef})`，先经锁 API 读取锁文件核对 `autonomy_run_id === runId`、repo_id 一致、PID 已死或为自身，再 release，仅当集合为空才解除隔离。并审计 daemon 内没有任何调用对 `osstack/writer-locks` 使用 `recover_stale:true`，否则耐久隔离被绕过。

**6. G16 实现风险：现有清理会销毁保留工作区。** `cleanupOrphanedWorktrees` 按前缀+根目录无条件调用 `worktree remove --force` 和 `branch -D`，未导出的脏工作区会被删掉。最小修正：retain 时执行 `git worktree lock --reason osstack:<effectKey>`；`parseWorktreeList` 解析 `locked` 行并跳过；freeze 前置为该 workspaceLeaseRef 无 intent/running/unknown 行且持有仓库写锁，bundle `git bundle verify` 通过并写入 manifest digest 后才允许删除分支。

## P2

- **单一 interruptId 冲突。** unknown 也算决策时，同 effectKey 之后再判 applied 无法写入不可变收据。改为 applied/notApplied 不可变、unknown 为可重复的 recheck 记录，或 interruptId 带 seq。
- **结算不应要求活租约。** broker `fence()` 在 recordOutcome 前检查 leaseExpiresAt；事件循环卡顿超过 TTL 会把已完成且已 persist 的真实结果变成 unknown+隔离。结算路径改用仅校验 generation/owner/revision 的 fence。
- **notApplied 的 TOCTOU。** verifier 检查后生产者才生效。store 强制 `stopProof.confirmedAt <= evidence.checkedAt`，无 stopProof 或 cancelled 时 retrySafe 必须为 false。
- **confirmStopped 1 秒竞速和 50ms grace。** G17 真实 agent 停止常超 1 秒，会制造 unknown 风暴。改为注册项可配，且 unknown 时记录被丢弃的 confirmStopped 结果引用。
- **结果校验重复。** kind/workspaceLeaseRef/candidateRevision 校验只在 broker 里；恢复 store 判 applied 需同一逻辑，抽成 core 纯函数共用。
- **时钟回拨。** `now < updatedAt` 全部 INVALID_TIME。daemon 提供 `max(Date.now(), last+1)` 高水位时钟。
- **心跳与 REVISION_CONFLICT。** 每次 checkpoint 写都推进 revision，管理器续租必须同 tick 内 get+renew；冲突当作重试，不能当 worker 死亡。

## 最小完整接口

```
GraphRecoveryStore(db)
  decide(fence: GraphRecoveryFence, input: {
    effectKey, idempotencyKey, payloadDigest,
    expectedEffectGeneration, expectedExecutionRef,
    stopProof: { receiptRef, confirmedAt } | null,
    evidence: { verifierRef, checkedAt },
    verdict: { kind: "applied", result, actualTokens }
          | { kind: "notApplied", cancelled: boolean }
          | { kind: "unknown", observedTokens }
  }) -> { action, run, decision, changed }
  get(fence, effectKey) -> decision[]
```

`GraphRecoveryFence` 即 GraphRunFence 加 `allowExpiredLease: true` 与可选 `stoppedWorker`，规则见 P1-2。intent 行且 execution_ref 为 null 可直接判 notApplied，依据是 markRunning 同步提交先于调用这一现有不变量。

## 不属于本轮

公开 worker RPC、任意图编译器、多 epoch 推进、模板容量校验、SQLite 支持矩阵和 RPC 延迟测量属于 G18–G29，以上均未按其缺失计为阻塞。
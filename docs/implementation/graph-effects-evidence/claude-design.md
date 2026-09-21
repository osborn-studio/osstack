结论先行：方案方向正确，但有 6 处会在 C4 集成时直接出反例的 P1，核心都落在“捕获的 fence 过期”和“failed 被误判为无效果”两类。

**P1 风险与反例**

1. **用 revision 做 ledger/checkpoint 写 fence，必然产生过期 fence 和效果后的假冲突。** `GraphRunStore.checked` 要求 revision 精确相等，而 renewLease 每次续约都会递增 revision。反例：worker 并行发起 review 与 tests，两者在同一 revision 读取 fence，第一个 confirm 提交后第二个 confirm 因 REVISION_CONFLICT 被拒，但物理效果已发生，账本落入“已执行未记账”。远程 Saver 的 put 同理会被 supervisor 的续约打成活锁。决策：效果与 checkpoint 写只在 BEGIN IMMEDIATE 内校验 identity + generation + owner + lease 存活，revision 由 store 自行分配并返回；confirm 写永不因 fence 被拒，generation 已变时照样落库并标记 `fencedOut=true`，只是不作为可返回缓存结果。

2. **“failed 即无效果”不成立。** `executeCandidateImplementation` 在 outcome completed 但无事件时返回 `failed`，这只是“无证据”，不是“无效果”。adapter 在 command_results 非空时返回 failed 表示工作区已被改写，重新分配 logicalAttempt 会在脏工作区上重跑。executePlan 抛出的任意异常、远程模型调用超时都无法证明未开始。决策：adapter 返回显式三值 `effect: not_started | applied | unknown`，独立于 `outcome: ok | failed`；只有 adapter 自报 `not_started` 才释放预留并允许新 attempt；异常与超时缺省为 unknown。当前 GraphActionState 的 `failed` 需要拆分或附带 effect 字段。

3. **daemon 内进行中的 broker 调用不随 worker 退出而停止。** stoppedWorker 证据只证明 worker 进程退出，acquireLease 据此发新 generation，但 gen1 的 adapter 调用仍在 daemon 内运行并会写入工作区。反例：gen2 worker 请求同一 slot，账本返回 running，gen2 既拿不到 promise 也无法等待。决策：acquireLease 事务内查账本，该 run 存在 running 或已准入 intent 行时拒绝接管；daemon 启动时把所有孤儿 running 行扫为 unknown，并按账本重建 `quarantinedRepositories`，因为该集合现在只在内存中，重启即丢失。

4. **effect 身份缺少请求载荷摘要，且 effectSlot 由 worker 自选。** 反例一：worker 用 `review-1`、`review-2` 递增 slot，每次都是新物理效果，幂等形同虚设。反例二：同 slot 同 attempt 的重放携带不同 candidateRevision，账本返回旧缓存结果。决策：slot 从模板注册表按 nodeId 派生并限定基数；账本存储 canonical 化的 action 载荷，重放时不等则报 IDEMPOTENCY_CONFLICT；查找先按 run/epoch/node/slot，requestId 仅用于传输去重。

5. **远程 Saver 的 thread_id 与 epoch 绑定。** 若 Saver 信任 config.thread_id，同 scope 的 worker 可读写另一 run 的 checkpoint。TransportContext 把 epoch 固定在连接期，跨 epoch 重试的 worker 会在第二个 epoch 全部 EPOCH_MISMATCH。决策：thread_id 由 host 从连接绑定的 graphRunId 派生，worker 传入值只做相等校验；epoch 每次请求从账本读取比对，不缓存在连接上下文。

6. **按动作准入的 runId 与嵌套死锁。** `GovernedExecution.acquire` 以 runId 去重，若 broker 传 graphRunId，同一 run 的并行读动作直接抛“already admitted”。若 graph run 由持有仓库写租约的 loop 会话发起，其 implement 动作会在同一仓库的 FIFO 上永久排队。决策：admission runId 使用 effectKey；C4 明确禁止在活动写租约内启动同仓库 graph run，broker 在准入前检测祖先持有者并拒绝。

**P2 风险**

- 预算计数若在 JS 侧读取后再写，两个并行 intent 各见 remaining=1 会双重预留。用条件 UPDATE 在事务内扣减。
- checkpoint 字节上限与 put 失败语义未定义。functional API 把全部任务结果累积进 checkpoint，超限后 run 无法推进但账本已确认效果。需定义上限并把该失败归为可修复的 failed，而非 reconcile。
- putWrites 与 put 经 RPC 到达顺序可能颠倒，存储层需容忍或客户端串行。
- `INVALID_TIME` 在时钟回拨后会锁死所有写。账本用单调服务时间，回拨只记录不拒绝。
- deadline 到期只拒绝新 intent，绝不中止进行中调用，否则制造 unknown。
- 缓存写复用依赖任务函数纯度。模板任务里任何 Date.now 或随机值都会让 checkpoint 与账本分叉且不被察觉。需写入模板约束并加测试。

**建议固化的接口决策**

- 效果写路径签名：`recordIntent(identity, payloadDigest)`、`confirm(effectKey, outcome, effect)`，两者都不接收 expectedRevision。
- adapter 结果契约新增 effect 三值字段，broker 不做推断。
- worker 令牌在 acquireLease 事务内铸造并存入 graph_worker_leases，每次请求在事务内重验 lease 存活。
- 账本 running 行的所有者记录 daemon 进程标识，启动扫描据此判孤儿。
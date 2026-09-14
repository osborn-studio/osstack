# C5 Claude Fable 5.1 对抗审查裁定

真实调用使用 claude-fable-5-1、medium、tool-less、JSON 输出。原始 prompt/JSON/文本/错误流随证据保存。模型意见不是验收替代品。

## 设计审查
- 采纳：显式 retry intent 执行所有权、原始 task.run_id 执行引用、按 run 计数的仓库隔离、可信释放端口、持久 worktree retention、独立 receiptId 和稳定 interruptId。
- 调整后采纳：恢复原代动作采用单独 GraphRecoveryStore 管理端口和完整快照/双代证据，不削弱普通写 fence；终态前拒绝未决动作，不允许终态复活。
- 不采纳：放宽过期 lease 普通结算、回退时间容忍、无限制领取 intent。过期/回拨仍拒绝，通过新鲜证据的管理对账恢复。

## worker / artifact 实施审查
1. 长动作受 RPC 超时误杀：修复。action 不用 checkpoint RPC timer；保留限流、取消、断连和 host 原始 deadline 约束。
2. 单独 worker exit 不代表外部执行结束：由 GraphRuntime 跟踪真实 broker Promise 的有限等待，G15 另核对 G04 独立执行器收据和 G16 隔离。drained 也不等于物理停止。加入 daemon/assembly 未排空与未确认停止反例。
3. 启动期 heartbeat 提前触发：修复，ready 后才检查 heartbeat。
4. 授权暂时不可验证应缓存旧 grant：不采纳，仍失效关闭；性能与恢复策略放 G28，不以旧权限覆盖不可验证状态。
5. spawn_failed 无身份：修复为明确 no-child 收据，含 run/gen/owner/时间/证据/phase。只有 post-registration spawn 失败且没有同代动作/checkpoint 写入才允许受信任 not_started 对账；注册冲突不能当作旧 worker 不存在。
6. sparse/skip-worktree 被当删除：修复，冻结前明确拒绝 skip-worktree。
7. 完整历史 bundle 的大小/时间限制：记录能力边界，保留自包含与严格验证；大仓库性能/兼容性仍须 G27/G28，不宣称普适可用。
8. 超时后的迟到 OS exit 被丢弃：修复，增加 finalExit；bounded exit 仍保持原未确认结果，runtime 提供可再次核验的实际退出收据。

## recovery / broker 实施审查
1. 释放失败的 lease 不可达：父执行器独立复现并修复。finally 保存精确 admission；confirmed 不改为 unknown，不重复执行；失败继续停止链，可信管理路径只重试释放。
2. 丢失接管回复的重放停止新 worker：修复。精确 next-generation takeover 重放只读返回持久决定；跨代旧 effect release 重放在停止前拒绝，先清理再接管，或发起新的显式对账。
3. interrupt 唯一约束风险：已核对 migration28 仅 (run,receipt) 唯一；unknown→applied 两条历史测试通过，无此问题。
4–5. 把 worker confirmedAt 强制设在所有 action.updatedAt 之后：不采纳；worker 退出后 broker 可以继续做持久结算/管理对账，独立 producer stop 在另一份证据中。真实 supervisor 收据、完整快照、原代证明和同步可信 verifier 是授权边界；不得伪造退出时间。
6/8. 过期 lease 普通结算与未调用 intent：保持严格 fence，通过明确 not_applied 管理对账；普通 replay 不隐式领取/重发。
7. 失败尝试退回全部预算：不采纳，原方案以保守 reservation 和 attempt 上限约束重复拒绝/重试；恢复不重置预算。
9. 正在处理的 intent 返回对账：保留保守行为，没有 worker 自动重试；更细 pending UI 属于后续公开协议/CLI。
10. 固定停止确认时限：当前能力保守地保留 unknown；真实 provider 适配和性能在 G19/G25/G28 验收。

## 父执行器额外发现并修复
- 退休连接不能在异步授权后写入；单一 daemon runtime 配置阻止多 manager 重复有效 worker。
- migration29 持久消耗每个 run/generation 的启动权，daemon 重启不得重用内存丢失的同代；G15 journal 才允许新代。
- 独立 retry grant 在可用性检查/排队后的实际调用前重检。
- 普通 cancel_pending 投影不可变回 running/ready/queued 等；终态前必须无未决动作。
- daemon 重启后的 releaseReconciled(false) 不能代表磁盘锁已无；精确 owner、PID 已死、持久决定和独立静止证明后才删除原锁。

## daemon 最终闭环（claude-closure）
- P1 live-worker daemon 崩溃没有持久 PID/PGID/启动标识：承认产品边界，非本批自动恢复能力。G17 重启测试先停 worker 并保存真实收据；报告明确该限制，G25 补完整矩阵。不能伪造证据绕过。
- P2-1 注册已消耗后失败仍无 no-child 证明：保持 phase=registration 的保守拒绝，自动恢复路径留 G25；不将注册失败冒充真实 spawn 失败。
- P2-2 缺少 checkpoint 服务上下文：父执行器核对服务在每个 await 后复检已退休 binding，现有测试覆盖；不因缺少上下文认定晚写漏洞。
- P2-3/P2-4 已采纳并修复：migration30 持久 admission 释放义务，在正常调用前写入、管理对账事务中补齐；终态/接管/重试检查未释放记录。新增真实失败反例与关闭重开 DB 验证；物理释放后 DB ACK 丢失另有反例，确保无残留内存 quarantine。
- P2-5 其他 stale-lock 调用：生产 acquireRepoWriteLock 调用仅共享 GovernedExecution，明确 recover_stale:false；兼容旧外部版本仍属 G27，不宣称跨版本保障。
- P2-6 优雅关闭进行中动作保守 unknown：如实列为使用边界，未声称无停顿恢复。
- P2-7 远期 lease 是唯一时间限制：不成立，GraphRuntime heartbeat 独立检查原始 deadline，真实进行中超时测试通过，恢复不延长预算。
- P2-8 心跳对事件循环长阻塞敏感：保守停止而非误放行，记录 G28 性能限制。
- P2-9 PID 重用和 P2-10 冻结临时锁崩溃残留：明确 fail-closed 管理恢复边界，G25/G28 补产品化；没有自动删锁。

## 资源释放补丁独立复核（claude-admission）
Claude Fable 5.1 明确给出 bounded C5 fix 无 P0/P1，确认持久 hold、终态/接管/重试检查、丢失释放 ACK 和不残留 quarantine 的不变量。
- P2 原已确认结果需字节一致：采纳为接口约束。verifyOutcome 对已确认效果须读取持久 outcome 原样复用 result/evidenceRef/actualTokens，独立核验其证据；不能重新生成摘要冒充原结果。不新增 release-only 状态种类。
- P2 可信 release 返回 undefined 本身不能证明物理释放：采纳文档约束。回调必须独立验证精确原 lease/磁盘锁已释放或可证明不存在，false/空内存映射不足以证明；表只记录可信 host 的结论。真实 daemon retained-lock 集成测试验证了实际删除路径；核心合约测试的 fake 回调不冒充物理释放证据。
- P2 可能存在其他直接 status/generation 写者：全源码搜索确认只有 GraphRunStore/GraphRecoveryStore；graph-storage 只更新 revision/time，checkpoint 不绕过投影。见 final-writer-audit 与 final-graph-runs-audit。
- P3 旧动作与 FK：graph_worker_leases 的 (run,generation) 主键及 openDatabase foreign_keys=ON 已核对；G11 图动作晚于 G08 lease schema，不存在正式版本的先动作后 lease 布局。外部非法数据库不自动修复。
- P3 releaseAfterReconciliation 对已释放 lease：父执行器核对真实 GovernedExecution 为幂等；broker 先执行新鲜 verifier，避免该早退绕过验证。真实边界测试已覆盖。
- P3 acquire 抛错、时间 SELECT/UPDATE、错误映射：未决 intent 阻止终态/接管，管理对账补持久义务；同键不会重新获取已释放 admission，单进程同步存储且 released 不可逆。公开操作诊断文案留 G22–G24。

已保留全部模型原文与逐项裁定；没有把模型赞同作为测试验收替代品。

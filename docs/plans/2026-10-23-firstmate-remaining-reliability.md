# Firstmate 后续：监督可靠性与运行资格实施方案

日期：2026-10-23。性质：供主线程整合的只读源码调查与可执行开发拆分；尚未实施。调查目录 `/Users/osborn/Developer/CodeX/.worktrees/osstack/pr237-main`，以 PR #237 整合后源码为基础，主线程仍在修改人工 admission 路径，因此本方案不对该路径当前状态作最终审计结论。

## 1. 当前事实与交付目标

PR #237 已有独立 Attention 投影、owner generation fence、默认租户及 canonical repo 绑定、100 个全局活跃 subject 上限、Session ordinal 历史补读、稳定 decision episode、人工回答回执、保守重启、通知 outbox、foreground handoff。不要将这些重复列为待从零开发。

| 真实现有落点 | 已有行为 | 剩余缺口 |
|---|---|---|
| `packages/cli/src/supervision-service.ts` / `SupervisionService.start/scan/stop` | 启动扫一次，30 秒 interval 补扫，单个 delivery drain 防重入 | 没有事件 dirty 加速；Loop 异步读取没有整体 single-flight 与 stop join；停止仅等待 deliveryDone |
| `packages/core/src/state/attention-observer.ts` / `tick/scan` | scope 写事务、每页 250 个发现条目、每 Session 每轮 50 turns、100 admitted subject | run 只读 phase/outcome 快照；scope 数量和累计发现库存没有固定上限；一轮同步扫描可能影响 RPC；Session 中间原地变更明确不可完整恢复 |
| 同上 / `inventory` | scope 65 秒 deadline、generation、发现未完成和 gap 降级 | wall clock 回退能暂时 unknown，恢复后缺少 monotonic freshness 资格；没有 backlog age、扫描时长、公平性统计 |
| `packages/core/src/state/run-store.ts` / `appendEvent/listEventsForRun` | `events` 原生账本，`(run_id,seq)` 唯一，approval/clarify 事务双写 | `listEventsForRun` 无分页 limit，不可直接作为有界监督 replay API；删除 run 会级联删除事件，没有 supervision 保留契约 |
| `packages/core/src/state/attention-experience.ts` / `enqueue/drain/recoverDeliveries` | 同 item/revision 去重、5 次重试、超时 abort、死信、重启恢复 sending | 每 30 秒最多处理一个通知，100 项通知可能要约 50 分钟；缺少每轮有界 drain 队列及吞吐资格 |
| `packages/cli/src/daemon-lock.ts` / `acquireDaemonLock` | 固定 lock DB inode、SQLite 原生 exclusive lock、文件系统 allowlist |已有竞争/SIGKILL/exec child 测试不等于所有 OS/FS 支持组合都通过；需把真实资格机器信息发布 |
| `packages/cli/src/daemon.ts` / `restoreLoopSessions/restoreDailySessions` | 中断 running/stopping 保留为 stopped/recovery_required | 用户缺少统一、只读、绑定证据的恢复说明；不应由 observer 自动重试未知动作 |
| `packages/cli/src/governed-execution.ts` / `GovernedExecution`；`packages/core/src/state/graph-recovery.ts` / `GraphRecoveryStore` | 主线已有仓库 writer lease、quarantine、物理停止证明、Graph recovery ledger | Attention 应显示既有事实和引导既有恢复入口，不能创建第二个 lease/approval/recovery 实现 |

目标分三层：先缩短观察延迟并保证公平停止；再增加 run 事件补读及安全恢复可见性；最后用固定负载和真实宿主故障测试取得可复现资格。代码存在、自动测试通过、真实平台资格通过必须分别标记。

## 2. 必须维持的边界

- observer 没有 adapter/executor/model 端口；任何归约、重放、时钟恢复、heartbeat 都不能调用 resume、answer、merge、kill 或清理 worktree。
- `attention_items` 仍是 Session decision 的投影。run approval/clarify 的权威事实继续在 `approvals/clarifies`；首批只放进 run observation 的 bounded facts，并给出现有授权入口，不伪造 Session item。
- scope 是本地数据范围，不是远程认证。不要把新统计/ledger 暴露为跨租户查询，不允许用户填 owner generation 获取权力。
- 未知投递不重发。恢复、停止、关闭新特性都保留 message/action 与未决项；离线超过 deadline 后重新扫描，不延长旧 handoff。
- 不改既有 migration 1–41；新迁移由主线程串行分配编号，不能多个 agent 都假定自己是 42。默认优先无迁移的独立改进。
- 所有开发 CLI 使用 scratch 内显式 OSSTACK_HOME；不读取或迁移生产 home。源码与测试 worktree 放用户规定隐藏根，临时测试数据放 OSSTACK_SCRATCH_ROOT。

## 3. 第一批可并行开发的完整交付切片

### R1：可停止的监督调度器（M，首个建议实现 PR）

**用户结果：** 已注册来源有变更时尽快更新，突发变更不会制造多个扫描，关闭 daemon 后不再有 Loop 读取回调写已关闭数据库。

**文件：** 现有 `packages/cli/src/supervision-service.ts`；新增 `packages/cli/src/supervision-service.test.ts`；daemon 接线作为后续小任务而非与其他 agent 同改。

**接口和实现：**

1. 加入实例内部 `requestScan(reason)`、`runningScan`、`dirty`、`stopping`；只有一个 scan promise。扫中再收到 dirty 只安排一次后续 pass。同步 observer 部分本轮仅调用一次；Loop 读取统一 await，不再 fire-and-forget。`start()` 幂等，`stop()` 清 timer、拒绝新请求、join 在途 pass 与 drain。
2. 内部 source reader 注入窄接口便于阻塞/失败测试；默认仍 lazy import `readAttentionLoop`。对 Loop payload corruption 逐项失败和降级，不让一个坏条目阻断其他来源。
3. 每个异步读取保存 owner generation、binding_hash、请求时 source sample version；提交前重验仍 active、同 binding、未 stop。晚到的旧结果不能覆盖新绑定或把 release 项重新 admitted。

**3 组验收：**

- 100 次 dirty burst + 阻塞 Loop reader：最多一个 scan 活动、一轮合并重扫；重复 start 不增 timer；一次失败后下轮可以继续。
- stop 在 await reader 时发生：stop 等待完成或受控取消；DB 关闭后零写；reader 迟到不能提高 coverage 或 resurrect released subject。
- 一坏 Loop + 一好 Loop + Session：好来源仍更新，错误有结构化 reason；不开启后台监督时零 timer/source reads。

**验证：** cli 定向 Vitest、build、typecheck；无 schema/API 修改。**回退：** 保留现有 30 秒补扫，关掉 dirty fast path；安全 stop join 不能回退。

### R2：通知有界批量排空（M，可与 R1 并行，避免同改 service）

**用户结果：** 大量待决策项不会因每半分钟仅投递一条而积压几十分钟；仍保持同 delivery ID 幂等和有限重试。

**文件：** `packages/core/src/state/attention-experience.ts`、对应 `.test.ts`，后续由主线程将批量接口接入 service。

**接口：** 保留单条 `drain` 兼容路径；新增 `drainBatch(sender,{maxItems:20,maxDurationMs:1000,signal}) -> {attempted,delivered,retried,superseded,remainingDue,oldestDueAt}`。从最小 next_at、delivery_id 排序领取；一条超时不无限占用本轮预算；默认串行 sender，避免对将来 transport 扩大并发副作用。

**约束：** 每条持久 `sending` 后才调用 sender；只在精确 attempts+state fence 下确认。批量预算耗尽只停止领下一条，不清空 pending。quiet 在每条领取时重验；已发出的网络动作不能因姿态变化假称撤回。超过最大次数保持 dead_letter；业务 answer 完全不受影响。

**3 组验收：**

- 100 条新通知、前 20 条包含 superseded 和失败：统计准确、下一批继续、没有饿死有效通知；同 ID 成功但 ACK 丢失只产生一个本地 artifact。
- sender 忽略 AbortSignal 迟到：不能再次修改已完成/已重试代次；stop 不领新工作；永久失败精确 5 次。
- quiet/away 切换、源 item revision 改变、旧 owner 执行确认：不越权发送新的过期问题，不影响 action/message 状态。

**验证：** core experience + local delivery 定向测试；吞吐只在 R8 实测后声明。**回退：** batch limit 设 1，保留 outbox。

### R3：daemon 提交后 dirty 通知（M，依赖 R1；主线程专属 daemon 接线）

**文件：** `packages/cli/src/daemon.ts`、`supervision-service.ts`、现有 Session/daemon RPC 测试，最多 4 文件。

**实现：** 已持久化 `appendEvent`、Session create/turn finish/inbound message 结果、collaborator receipt、Loop 状态保存之后，调用 service 的 `markDirty({kind,id})`。标脏仅提示，不是事实；不能在 DB commit 之前发布 covered。短期不改 core repository 全局签名，也不建立全局 EventEmitter。其他进程写入仍由 30 秒补扫发现。

**验收：** 持久化失败不产生“已观察”证明；漏 dirty 重启/30 秒补扫仍收敛；请求突发合并且不会嵌套 SQLite transaction。现有 session/collaborator/Graph 授权和 reserve 回归全过。

**回退：** 去掉 dirty 调用即回到定时观察；持久协议不受影响。

## 4. run replay 与覆盖语义

### R4a：有界原生事件页 API（S/M，独立 PR 或 R4 第一提交）

**文件：** `packages/core/src/state/run-store.ts`、`run-store.test.ts`、必要 index 显式导出。

**接口：** 新增 `readRunEventPage(db,{runId,afterSeq,limit,throughSeq?})`，limit 1–200，afterSeq 从 -1 开始，返回 `{events,nextAfter,highWatermark,hasMore}`；不要改变老 `listEventsForRun` 调用者全量语义。调用方必须先限定同 scope 的 task/run/default tenant，不接受裸 runId 作为外部授权。

**实现：** 单短读事务捕获 MAX(seq) 当本轮水位，读取 `seq > after AND seq <= highWatermark ORDER BY seq LIMIT limit+1`。有上限验证 payload 长度，避免把超大 JSON 全面进入 model/日志。不得将 `seq` 最大值当全局全序；每 run 独立 cursor。

**验收：** seq 0 的第一事件、200/201 页边界、扫描中 append 下一页、删除/缺号、非法 limit、无事件；旧 API 回归保持。事件顺序缺口要返回可解释事实，不把 “序号变大” 当完整性证据。

### R4b：原子 run 投影 cursor（M，依赖 R4a；迁移串行）

**文件：** 新 `packages/core/src/state/attention-run-projection.ts` 与 test、`attention-observer.ts`、migration、migration test（生成协议另批）。

**数据：** 建议单一新表 `attention_source_cursors(scope_id,kind,subject_id,source_binding_hash,event_cursor,through_seq,last_event_hash,gap,backlog_count,last_success_at,generation)`；kind 首批仅 run。不能把 Session `ordinal_cursor` 复用为 run seq。cursor 和归约 payload 在相同 `AttentionStore.write(owner,...)` 事务提交。

**归约：** 明确支持 source `status`、terminal、approval/clarify lifecycle 的真实 envelope；由具体 producer 的 schema 校验表决定映射，未知 type 只记录 unsupported count。approval/clarify 当前权威表交叉确认；事件“resolved”不能替代签名审批。原 run business phase/outcome 与 observed event state 分字段显示，冲突 reason 可见。

**完整性：** event sequence 连续且绑定不变才推进 complete cursor；损坏事件不得静默跳过再声称完整。可持久 quarantine `{seq,event_id,hash,reason}` 并允许读取后续仅供事实展示，但 `history_gap` 保持，直到显式重建/确证。重启保留 cursor，源消失保留未决观察；原生事件被删时必须降级，不能宣传永久完整历史。历史保留 pin 是后续另 PR，不在本批偷偷修改所有删除入口。

**3 组验收：**

- commit 前后崩溃：源已提交但 cursor 未提交重启补一次；projection/cursor 任意写失败整体回滚；owner 换代拒绝旧提交。
- 重复、乱序、seq gap、同 ID 内容改变、超大/坏 payload：不回退新状态、不伪称 complete；100 subjects 中单 run 风暴不饿死其他来源。
- crossed task/tenant/repo、run 删除/ID 重用、approval 模拟消息：无跨 scope 事实、无清除真实授权义务、无 adapter 调用。

**回退：** feature flag 关闭 event replay，保留新表；仍显示 `snapshot_only`；不做降 schema 或回退 DB 快照。

### R5：公平预算、freshness 与统计（分两批 M，依赖 R1/R4）

**R5a 文件：** `attention-observer.ts`、test、`attention-store.ts`（必要）；不触碰 RPC 文件。将 `tick` 拆成 `step({maxSubjects,maxEvents,deadline})` + 兼容 tick wrapper。跨 scope round-robin；单轮 25 subjects / 200 events 起步，实际参数 R8 测量决定。所有 scope 每轮取有限 quota，250 discovery 页保留，但不再每个 RPC 前无界全部扫描。新 scope 注册明确最大数量或 admission error，不能只限制 subjects 而无限 scopes。

**验收：** 100 active、>250 discovered、多 scopes、某一 run 10k backlog，所有 admitted subject 有可计算的最大轮转延迟；删除/新 ID 在 cursor 后方和前方均最终发现；每个页面写事务有限，不阻塞非监督 RPC。

**R5b 文件：** `supervision-service.ts`、daemon stats 函数、`daemon-rpc-latency.test.ts`、新 performance fixture（≤4）。在 service 内使用 monotonic clock 测 scan 间隔与 wall-clock discontinuity；休眠或时钟跳变使本代 freshness invalid，下一次成功扫描恢复。持久时间仍 wall clock 供跨重启说明；不能把 monotonic 时间当跨进程可比较。

**stats 增量：** `attention.enabled/owner_generation/last_scan_at/last_success_at/scan_duration_ms/backlog_subjects/backlog_events/oldest_backlog_ms/discovery_incomplete/source_gap_count/stale_coverage_count/pending_deliveries/dead_letters/oldest_attention_ms`。窗口固定容量，原有 `stats.rpc` p95 复用。unknown observations 用分母明示，通知重复率只以 transport receipt 证据计算，不能默认零。

**验收：** clock 往前/往后、休眠恢复、timer 活着但 scan 卡住，均不会延长旧 handoff；统计查询零网络/模型；未知 denominator 输出 null，不伪造 0%。

## 5. 恢复可见性与来源保全

### R6：只读恢复诊断及明确处置入口（两批 M）

**最小交付：** `attention recovery inspect --scope ...` 输出“缺哪些证据、已有回执在哪里、应使用哪个现有命令”，让用户区分一个任务等人还是执行结果不明。首批不新增自动恢复 RPC。

**R6a 文件：** 新 `packages/core/src/state/attention-recovery-view.ts` 和 test；`attention-actions.ts` 仅复用现有 get/recover 状态，不修改执行路径。结果建议 `{subject,sourceVersion,ownerGeneration,waitOwner,pendingMessageIds,actionStates,grantAttemptStates,evidenceRefs,nextStep,canAutoRetry:false}`；只展示绑定 ID、状态和证据摘要，不返签名、提示全文或 arbitrary file path contents。

**R6b 文件：** `supervision-service.ts`、`attention-command.ts`、对应 test、guide；Graph subject 不伪造支持：若来自 Graph，仅引用现有 `GraphRecoveryStore.inspectExecutors` 的可信 host 诊断适配，不能接受客户端传 `verifyProof`/worker stopped JSON。Loop recovery_required 只引用已保存快照，未获 stop proof 时只能保留。

**验收：** accepted/failed/late applied/grant checking/reserved/source disappeared 六类组合；同 message 只出现一次证据链；只读前后 DB 行及 worktree 文件 byte hash 不变；不存在恢复视图触发模型执行、释放 writer lease 或改变 abandoned_unknown 的行为。

**明确下一阶段：** 若要提供自动对账，只能从已有 adapter 给出真实性可校验、精确 native session/turn/message 的 terminal receipt；没有这种能力时保持 unknown。用户“放弃未知”是操作处置，不是证明之前没执行。不能因为要“全部完成”而伪造这项平台能力。

### R7：保全资格与手动清理入口审查（M）

**已有：** `agents/worktree.ts` 的 `cleanupGraphWorktree` 有 retained record + verifySafe；`cleanupWorktree/cleanupOrphanedWorktrees` 仍存在供显式 owner 调用。daemon/Loop 自动 orphan 扫删已关闭。

**交付：** 制作真实入口 inventory（rg 搜索 cleanupWorktree、cleanupOrphanedWorktrees、git worktree remove）；为每个入口记录持有的资源 owner、成果保全、执行停止证据。仅修复证实会把未知残留当 owned 的路径；不全面替换主线 Graph retention。

**测试：** 临时 repo 的 tracked dirty/untracked/unmerged/index stage/linked worktree、活动 writer 和未确认外部进程；执行诊断/重启/升级后 hash 相同；只有明确自有已终止资源可以清理。清理失败保留记录，不能因为 branch 已保存就忽略未跟踪成果。

**回退：** 停用有问题清理入口，保留资源和说明；不能以删记录掩盖磁盘残留。

## 6. 真实性能与宿主资格

### R8：固定负载 benchmark 与 CI 资格（两个 M，可先写 fixture）

**R8a 文件：** 新 `scripts/bench-attention.mjs`、`scripts/fixtures/attention-load.mjs`、fixture tests、package script。复用 `scripts/lib/scratch.mjs` 创建隔离 DB/home，不修改生产路径；受控模型/adapter/network spy 总调用数必须为 0。

**负载：** 100 admitted subject，10 scopes，1000 生命周期事件/分钟，持续 10 分钟；30% Session、50% run、20% Loop snapshot；混合决策、普通 activity、CI waiting（用本地固定样本，不真正网络 poll）；另做 1000 discovered/100 admitted 的容量超额 case；加入单一源 10 倍突发和同一期间 20 次短 RPC/秒。

**通过标准：**

- observer backlog 在负载停止后 10 分钟内收敛，且没有永久漏项；每个 subject 处理公平；event_seq 不重复投影、不丢有效 decision；所有 gap 如实统计。
- 非流式读取 RPC p95 <10ms；纯归约 p95 <1ms/event；分别报告 daemon socket round trip 和内部 handler，不混为同一个测量；写路径独立统计。
- `--version` 本地 <150ms / CI <250ms，`--help` 本地 <500ms / CI <900ms，继续使用现有脚本；不允许为通过测试提高产品 deadline 或跳掉原 Graph 测试。
- 记录 CPU、wall time、RSS peak、DB/WAL size、event loop delay、扫描时长 p50/p95/p99、backlog age、notification oldest age；Loop overhead <1% 用相同 workload 开关前后实际测量，不从静态运行时间推导。

**R8b 文件：** `.github/workflows/ci.yml` 或独立 attention workflow、benchmark 文档、资格 JSON schema。CI 每 PR 跑确定性短负载和不漏项 gate；10 分钟 soak 单独 job或手动运行，不能让整个 PR 默认无限增长。性能 noisy runner 分开标注，不把一次 Linux pass 宣称所有机器支持。

**证据格式：** source SHA、dirty manifest、Node/native binding 版本、OS release/arch/FS type、参数、随机 seed、开始结束时间、完整 sample、阈值与 verdict。baseline 和 candidate 使用相同机器与负载，不做无依据节省率。

### R9：真实进程故障矩阵及资格表（两批 M）

**R9a 文件：** 现有 `daemon-lock-ownership.test.ts`、`daemon-loop-recovery-preservation.test.ts`、新增 `attention-crash.integration.test.ts`、host fixture。复用真实子进程/SQLite fixtures，而不是仅 mock 异常。

**注入点：** A 源提交后投影前；B action reserve 后 adapter 调用前；C 外部调用开始后 receipt 前；D delivered artifact 后 ACK 前；E owner 创建后首次 scan 前；F source reader 等待中 stop；G SQLite busy/full/commit failure；H restart 后旧 child 仍存活。B/C 结果保守 unknown，不以测试方便自动重发。

**验收：** 单 owner；旧 generation 无写；零重复业务动作；项目数据保全；完整未决 item/action 可查；关闭 observer 不关闭原执行器；停止未知不释放 Graph/admission lease。原始注入点与期望不变式保存在可复跑 fixture。

**R9b 支持矩阵：** macOS 当前本地 FS + Node22，Linux CI 实际 FS + Node22，各自记录 acquire竞争、SIGKILL、exec descendant、重新启动、DB failure 成绩。现有 allowlist 包含更多 FS 不等于已验证。不能访问实际宿主的组合写未验证，Windows/网络FS保持拒绝而非 pidfile fallback。

**真实 harness：** Claude Code Stop 当前已有单版本资格，补充 normal stop/cancel/duplicate/worker-role/timeouts 的原始记录；没有条件就不扩充支持版本。新的可见 worker/远程 harness 由另一个能力轨道负责，必须复用相同资格规范。

## 7. PR 拆分、并行安排与合入条件

| PR | 可执行范围 | 前置依赖 | 并行边界 |
|---|---|---|---|
| REL-1 | R1 service single-flight、stop join | PR237 验收收口 | 独占 service；不改 daemon |
| REL-2 | R2 outbox bounded batch | PR237 | 独占 core experience，可与 REL-1 并行 |
| REL-3 | R4a 有界事件页 API | PR237 | 独占 run-store，可与前两者并行 |
| REL-4 | R3 dirty wiring + R4b run projection | REL-1/3 | 主线程分配迁移，独占 daemon/observer；先 projection 后 wiring 两提交 |
| REL-5 | R5 公平调度及统计 | REL-4 | observer/daemon 不能与 REL-4 同写；基准 fixture 可先并行 |
| REL-6 | R6 恢复只读视图 + R7 入口 inventory | PR237；UI层对接统一 cockpit 轨道 | helper/test 可并行，公共 CLI 接线串行 |
| REL-7 | R8/R9 集成资格和文档 | 最终实现稳定 | fixture 开发可提前，最终完整测试须精确源码定稿后重跑 |

每个 PR 的最小验证包括受影响包的 meaningful tests、build/typecheck，schema/index/inventory 发生变化则重新生成并检查 freshness。合入候选统一跑完整仓测试、CLI startup 和 changeset coverage；不得用规划 agent 的阅读结论替代代码审计。

Claude Code CLI Haiku 5.5 可用于各批精确 diff 和故障状态机挑战：固定请求模型名、保存 CLI 版本、输入 source SHA/完整相关上下文、原始 JSON/stderr、逐项复现和处置。模型提出的潜在问题必须复核；静态审计不能代替真实 crash/soak。CLI 返回 requested model 只证明请求/回报字段，不能额外声称上游身份已独立认证。

## 8. 完成口径

- R1–R5 合格：第 5 项从快照周期补扫提升为“本地已支持来源的事件加速 + 有界 run seq replay”，Session mutable history 和外部 Loop 仍如实披露限制，不能写跨所有 backend 完整 event log。
- R6 合格：第 2/4/14 项的异常解释和恢复操作更完整，仍不自动夺回未知 writer。
- R8/R9 合格：可以发布具有机器/版本约束的可靠性、吞吐与零模型观察资格，而非只是文件和测试数量。
- 通知批量出队不等于第 22 项公共 follow-up，run ledger 不等于第 17 项远程身份。跨轨道功能在各自完成前继续显示部分/未实施。

第一轮建议立刻并行 REL-1、REL-2、REL-3；三者分别占 service、experience、run-store，几乎无共享文件冲突。主线程最后负责 daemon、migration、protocol/inventory 和最终审计收口。

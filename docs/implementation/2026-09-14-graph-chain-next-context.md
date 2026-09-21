# 下一轮编码上下文：G18–G20 / C6

当前 C5 已通过，G00–G17 完成（18/30），验收源 `50133c0eec518add33f556bfa95b746de350cc35`；开始下一批前检查 [C5 报告](2026-09-14-graph-chain-completion.md)、[机器任务清单](2026-09-13-osstack-graph-upgrade.tasks.json)和 `graph-chain-evidence/admission.json` 的实际状态。继续在 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation` 的 `codex/graph-runtime-foundation` 工作。原用户 checkout 只同步拥有的文档，不能覆盖其 AGENTS 或源码。

## 目标与顺序

1. **G18**：按原实施计划编译静态工程图规格与节点输入/输出合同，生成可验证的不可变 program identity 和受信任动作注册。只准入 Functional API + sync。工作流节点不能直接 import daemon/core 或持有控制面 DB。
2. **G19**：在同一冻结 candidate 上执行独立评审与隔离测试，复用逐动作准入和 G04；明确工作区/能力分类、停止证明、错误与用量。不把多能力可写 adapter 当只读执行器。
3. **G20**：完整结果汇合、条件路由与错误分类。区分 task 函数重入、确认外部效果和逻辑 join；用可观察日志验证并行失败恢复。无第二套 node FSM，不以状态标签代替真实停止条件。

C6 验收 G18–G20 后才继续 G21 完整代码交付模板、G22/G23 CLI cancel/resume、G24 调用契约。G25–G29 故障/兼容/发行/性能/试点仍必须完成，不能把当前 C5 成功视为生产准入。

## 可复用接口

- `GraphRuntime` 位于 CLI，daemon `handles.graphRuntime(configuration)` 显式惰性创建一次。`prepare/claim/start/stop/observedExit/close` 管 worker，只有 generation0 可普通 claim；后继代际需 G15 journal。迁移29 每代唯一启动记录防重启复用。
- `GraphWorkerManager` 读取、哈希并快照自包含 ESM 源；worker 执行固定 Functional entrypoint 与公开 RemoteCheckpointSaver。request/input/spec/program 身份全量校验；不会重用已消费 generation。
- `GraphWorkerHandle.result` 不是退出证明；`exit` 是有限等待的首个结果，`finalExit` 是真实迟到退出/no-child 证据。`GraphRuntime.stop().actionsSettled` 只是 broker Promise 排空。每个外部执行器仍要独立停止证明。phase=registration 的失败不能作为 no-child 证明。
- `GraphActionBroker` 固定 epoch/node/slot/action/workspace，逐动作获取规范仓库锁；adapter/command 复用 G04。freeze 注册必须匹配真实 `GraphArtifactStore.freeze` 输入，候选结果必须等于服务返回的已持久产物。不可外套整 run writer lease。
- `retryAuthorized(connection,effectKey,authorizeRetry)` 只供可信 host 明确调用；新 attempt 由 ledger 分配，专用 retry grant 在等待后、实际 invoke 前复检。普通 worker 重放不领取 intent，也不分配新 attempt。
- `GraphCheckpointService.register/unregister` 动态绑定和退休连接；任何等待后的写入都复检连接及原代身份。存储采用真实 SQLite，禁止用 MemorySaver/实验 JournalSaver 替代。
- `@osstack/core/graph-recovery` 导出 GraphRecoveryStore 和仅可信 host 使用的 GraphAdmissionStore；不要加入 core 根入口的昂贵 eager import。`GraphReconciler` 收取可信 host 回调，核对精确 snapshot/proof/decision。稳定 interruptId 与独立 receiptId 支持 unknown→明确结果的追加历史。
- `GraphActionBroker.releaseReconciled` 仅释放内存中可达的精确 retained admission；false 不是磁盘无锁证明。重启后按 `inspectRepoWriteLock/releaseReconciledRepoWriteLock` 核对原 owner/PID/决定/执行器与工作区证据。正常释放失败也保留可恢复句柄。
- 迁移30 的 `graph_action_admissions` 持久记录资源释放义务。正常 broker 在物理释放后补记；对账通过 `GraphRecoveryStore.completeRelease` 在释放完成后重新验证精确快照/证据。held 阻止终态、接管及同一效果重试；释放失败先处理，不能用更换 generation 绕过。物理释放成功、DB ACK 失败也必须再次核验。
- `@osstack/core/graph-artifacts` 提供 freeze/verify/restore；`createWorktree({graphRetention})`、`quarantineGraphWorktree`、`cleanupGraphWorktree` 管持久保留。restore 得到新的独立 repo，必须重新解析/注册其规范身份；未知旧目录不能被新写动作复用。

可信恢复接口约束：对于已确认动作，`verifyOutcome` 应读取账本中的原始 outcome，保持 result/evidenceRef/actualTokens 一致并独立核验证据；不能重新生成结果替换它。`release` 回调必须证明精确资源已释放或可核验不存在，不能把 `releaseReconciled(false)` 或返回 undefined 本身当作释放证明。持久 admission 表记录可信 host 的释放结论，不直接观察物理资源。

## 不可退让的边界

完整原始 scope/program/input identity、原始预算和 deadline 在所有代际保持。权限在排队/锁后/可用性检查/实际 invoke 前重新检查，async 返回不能伪装同步 grant。过期普通 fence 和时间回拨继续失败，走明确管理对账。

恢复快照在异步验证前固定，任何并发 revision 变化都要重新发起，不得刷新掉已经验证的前提。先 stop/drain 原调用，再拍摄新鲜快照。worker 退出时间不能伪造为对账时间，独立执行器的停止与 workspace 隔离是另外的证据。旧代动作需要额外原代 worker 证明。

取消意图不可反转，终态前不得有未决动作。unknown 保留容量/锁，不自动重发；已确认 ledger 结果与 task RETURN 不能混淆。失去接管 ACK 的精确重放只读；跨代旧释放重放在停止前拒绝，先完成释放再接管，或另发新的明确管理对账。

候选冻结保留原始字节/模式/链接，不修改源 HEAD/index/ref。拒绝 sparse/skip-worktree、浅仓库、子模块等未支持场景。当前 full-history bundle 有 60 秒 Git 命令和 256 MiB 输出限制；不要未经验证扩大为大型仓库适用声明。WAL NORMAL ACK 不宣称断电可靠，same-UID worker 不宣称 OS sandbox。

## 执行和验证

继续使用真实 OSStack Loop 和真实 Claude Fable 5.1 独立挑战。显式新临时 OSSTACK_HOME、短 TMPDIR，不打开默认/保留 home。Loop 用 sources:[] + inputTasks；最终验收用新 taskId、skipCompletedTasks:false，检查 executedTaskCount/outcome 和全部 verifier，不能只看 exit0。

已有 `graph-chain.integration.test.ts` 的 daemon 模式和 assembly 模式必须分别保留。真实 daemon 重启场景先停止/排空 worker 并保存实际退出收据，再 SIGKILL daemon；G25 须补未观察旧 worker/逃逸执行器等更广矩阵。源码测试使用独立临时目录；实验 override 仅用于采集证据。

常规检查：pnpm build、pnpm typecheck:check、全包测试、protocol check:schemas、G07/C2 探针、CLI 启动预算以及改动文件 Biome。增加 CLI/index 顶层运行时依赖前测 import 成本；超过约20ms且非通用依赖用 lazy import。不要 merge、push、部署，任务完成后更新证据、计划/JSON与原 checkout 中拥有的文档。

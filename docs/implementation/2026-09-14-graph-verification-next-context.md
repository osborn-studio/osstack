# 下一轮编码上下文：G21 / 完整 code-delivery-v1

C6 已通过，G00–G20 完成（21/30），验收源 `00571bb862f27d9ab8e2e502d33e588196d62fee`。继续在 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`、`codex/graph-runtime-foundation` 实施；原 checkout 只镜像拥有的文档。先读 [C6 报告](2026-09-14-graph-verification-completion.md)、[证据准入](graph-verification-evidence/admission.json)与[任务清单](2026-09-13-osstack-graph-upgrade.tasks.json)。

## G21 必须补齐的真实路径

目标：实现→freeze→独立工作区准备→并行 review/tests→host join→ready/repair/stop，直接成功、修复后成功、分支 retry、预算停止和不同完成顺序都要运行真实临时仓库。只有 host 质量门作最终决定；ready 只交付候选包，没有隐式 merge/push/deploy 或 task FSM 完成。

1. **统一生成程序与 host 注册。** 当前 `compileGraphSpec` 是第一 epoch Functional 骨架；静态 plan 已保留最多三 epoch，但并未运行后续修复/host join。G19 的真实独立工作区准备目前由 host 单独调用。现有 broker 注册在创建时固定 candidate/action/epoch/workspace；必须设计受信任、带完整 fence 的生命周期步骤，才能安全接入 freeze 后才出现的 candidate SHA 和分支工作区。不可允许 worker 自行添加 action、指定路径、分配 attempt 或更换身份。
2. **补全 epoch 推进。** `GraphVerificationJoinService` 只发布不可变汇合记录和路由建议，不改变 epoch，不调度下一轮。broker 连接固定 epoch 且退休后不可重用；需要一个明确受信任、原子、有预算与未决/释放检查的推进契约，或经过完整 G15 的代际切换方案。不能把新建 token 对象当作绕过 epoch/fence 的办法，也不增加第二套 node FSM。
3. **单一质量门。** host 从最新账本和可信证据复核，不读取 worker claimedPass 决定通过。repair 的 feedbackRef 应指向完整 host join 记录，包含 review 和 tests；不要只给 reviewer 的首个 evidenceRef。registry 中 join.feedbackRef 是给模板保留的映射，G21 必须实际提供该输出适配。
4. **显式有限 retry。** `retryAuthorized` 才分配下一 attempt；普通 worker 重放只读已有效果。G18 生成 task 遇到非 confirmed 必须抛错；C6 对抗夹具故意缓存 failed RETURN，用于证明 host 不信旧缓存，不能照搬到正式模板。若需要改变 retry 工作区，现有 immutable action/workspace 注册不能就地换路径；必须明确新一轮受信任准备与注册规则，并保留原 attempt 及候选绑定。
5. **资源与预算。** `slots`、node/slot 名称、tokenReservation 与 nextCost 必须由实际编译计划/固定 registry 派生；不得沿用验证夹具的 0/1 预留或省略配置的默认值。 源码/评审修改将被拒绝，tests 允许自己目录内的未跟踪构建输出；不能自动清理未知目录或复用隔离中的写工作区。当前编译预留每轮 `3 + 4*maxBranchAttempts` 个启动，包含每次分支的独立准备；这些准备尚未全部通过动作账本注册。G21 如引入清理/发布等额外效果，要增加 registry/plan 成本并更新 compilerVersion/compiledProgramDigest，不能超预算做隐形效果。

## 已有接口

- `@osstack/graph/spec-compiler`：`compileGraphSpec/validateGraphPlan`；compiler `static-functional-scaffold-v3`，固定 registry/schema v3。输入只接受现有 GraphSpec，禁止任意 JS/topology/schema。
- `@osstack/graph/nodes/branch|review|tests`：严格绑定与 request/response 合同。`joinVerificationBranches` 必须提供同步可信证据核验；`parseVerificationJoin` 仅结构和摘要验证，不是授权。
- `@osstack/graph/route`：`routeVerification` 接受 host 提供的原 spec、now 和真实预算。返回 ready、repair_required、retry_required、reconcile 或 stop，不授予执行权。保留精确 BigInt token 核算。
- `GraphActionBroker`：per-action workspace/verifyWorkspace 在准入、策略、G04/命令 cwd 和保留资源上下文一致；独立 stopped 标记只由 broker 生成。`verificationFailure` 为受信任格式/基础设施分类，未知效果保留锁。新 retry intent 在重新检查 grant 之前就由原调用持有；尚未执行而被拒绝时，原 fence 仍有效才可落 failed，过期/换代仍走 G15。
- `prepareGraphVerification`：真实 artifact verify/restore + G10 源准入；返回两个独立 repo 和固定 actions。配置 `effectIdentity` 必须读取真实 RUNNING 账本行，不能预测 attempt。`verifyReviewer` 独立核验身份；每次实际 reviewer 调用重建最小上下文并生成新 UUID session。
- `loadGraphVerificationEvidence(root,ref,binding,effect)`：核验内容摘要、完整 binding、实际 effect/attempt、命令/退出、候选前后身份和 reviewer 调用收据。调用必须提供 expected effect；64 KiB、有界原始输出，读取旧格式缺字段直接失败。评审业务报告限制 8192 UTF-8 JSON 字节；诊断前缀限制 2048 JSON 字节，outputCaptures 记录被压缩的 G04 字符串的 UTF-8 摘要/长度，不表示原始字节或可恢复的完整日志。
- `@osstack/core/graph-verification`：`GraphVerificationStore.snapshot/commit`，迁移31不可变 journal，无 node FSM。可信同步 verifier；快照包含所有 ledger actions/budget 和 admission 状态。外部模块不能把 worker JSON 直接传给 store。
- `GraphVerificationJoinService.evaluate(fence)`：固定异步验证前快照，重读 artifact/envelope，对最新 attempt 的结果与账本逐字段核验，最后重新检查同一 fence/快照再发布。legacy failed 即使缺 GraphError/G19分类也给不可重试 stop，不制造永久等待；未知或任何 held 不发布完成结果。已发表的 journal 不能绕开后来的未知动作、证据篡改或当前预算。

## 不可放松与尚待集成的边界

完整原始 scope/program/input 身份、createdAt 与预算跨恢复不变；未知不自动重发，已确认动作不能作为新 attempt。run 取消意图不可反转，物理 stop 与 Promise drain、worker exit 分开证明。

所有 revision 冲突，包括 lease renewal，当前都会拒绝本次 join 评估；admission release 不改变 revision 也会被摘要识别。不能悄悄用最新 revision 覆盖异步复核的旧前提。G21 应在评估前安排足够长的有效 host lease，必要时 stop/drain 验证 worker，再在原 deadline 内重做完整验证。短租约续期与长 artifact I/O 的活性需 G21/G28 明确测试；不允许暂停心跳却让旧 worker 无保护地继续。

路由达到任一预算停止新动作。完整合法结果即使 stop 仍保存证据；精确动作/token 上限且不用再消费可以 ready，超额或过期仍 stop。不要未经新设计将预算超额改为 ready。

C6 的真实恢复测试位于 `graph-verification-join.test.ts`，基于实际 child/Functional/SQLite/G04，恢复窗口在执行器已停止且账本已结算、tests RETURN 尚未返回。它证明旧缓存不影响 host 最新结论、命令不重复；没有宣称 daemon 崩溃时任意逃逸执行器自动恢复，完整矩阵在 G25。

same-UID 不是 OS sandbox；接口会话清空不是 live provider 内部历史隔离证明；SQLite WAL NORMAL 不保证断电。G19 的 Git/raw inventory 反复检查需要 G28 性能测试。完整历史 bundle 与 Node/native/发行限制沿用 C5，G27/G29 仍未完成。

## 工作与验收

继续真实 OSStack Loop 和真实 Claude Fable 5.1 独立审查。显式新临时 OSSTACK_HOME/TMPDIR；不要从开发 checkout 打开默认或 reserved home。sources:[] + inputTasks、skipCompletedTasks:false、新 taskId，验证 executedTaskCount/outcome 与全部 verifier，不以 actor 的 diff-only gate 代替验收。

先冻结当前代码/文档/AGENTS 基线；实现 G21 后运行真实 delivery integration、C5 29 项链测试、C6 汇合恢复、全库 build/typecheck/tests、schema freshness、G07/C2 探针、CLI startup 和改动源 Biome。用每包一个 test worker 控制已知旧 RPC 时间敏感夹具，不放宽产品超时。G21 完成后再继续 G22–G24/C7，不 merge/push/deploy。

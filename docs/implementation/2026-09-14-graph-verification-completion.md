# OSStack C6：静态规格、独立验证与汇合路由

日期：2026-09-14。**C6 已通过；G00–G20 完成，21/30。** 验收源 `00571bb862f27d9ab8e2e502d33e588196d62fee`，C6 基线 `f1cf5a07b9803218f5d73635d37ab148da34a8eb`。实际分支 `codex/graph-runtime-foundation`，工作区 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`。

## 本批实际能力

| 任务 | 已实现 | 执行边界 |
|---|---|---|
| G18 | 固定注册表、最多三 epoch 静态展开、输入输出映射校验、确定性源码与摘要、最坏预留预算 | 自包含 ESM 通过现有公开 Functional entrypoint/task 执行第一轮骨架；完整模板由 G21 组合 |
| G19 | 同一冻结候选的独立 review/tests 仓库，真实 G04 调用与允许的验收命令，持久执行收据 | reviewer 身份由可信 host 验证；每次调用新 session；测试可以写自己的构建输出 |
| G20 | 严格前驱汇合、最新账本与证据复核、原始预算路由、一次性汇合记录 | ready/repair_required/retry_required/stop/reconcile 是 host 决策；实际重试走已有账本，完整 epoch 推进留给 G21 |

为控制每段改动，G18 拆为注册表/编译器；G19 拆为节点合同、broker 独立工作区、可信验证服务/收据和源码/会话加固；G20 拆为纯汇合/路由、迁移31与事务发布、host 证据复核和真实 worker 恢复验收。保留原 30 张卡的编号与依赖。

## 候选与证据

review 与 tests 从同一经过核验的 artifact 恢复到两个独立 Git 仓库，不共享 index、objects 或 alternates。broker 的逐动作工作区覆盖贯穿准入、策略、G04 上下文、命令 cwd 与保留资源的恢复上下文；实际调用前再次检查权限、租约和候选。

评审前后核对完整工作区内容，包括 ignored/untracked 文件。测试允许产生未跟踪构建文件，但 HEAD、tree、index 内容/标志及原候选跟踪文件的字节和模式必须保持；不能用 assume-unchanged 隐藏改写。收据包含工作区 lease 引用、前后候选身份、实际进程退出/停止证据，以及 reviewer 的真实 run/task/session、prompt/context 摘要。评审调用重建最小上下文，每次生成新 session；没有把 writer 对话传入 reviewer。

正常非零测试退出且命中允许的失败码时，产生 confirmed passed:false；合法 changes_requested 同样是 confirmed。格式错误和已停止的基础设施失败才按对应分类交给显式有限重试；改写候选是不可重试失败。停止不确定、证据持久化失败或物理执行异常继续 unknown 并保留资源，不转成代码失败报告。

证据文件按内容摘要命名、排他写入、fsync 和无覆盖发布；读写均限制 64 KiB。诊断输出采用最多 2048 个 JSON 字节的前缀，并记录 G04 传入字符串经 UTF-8 编码的摘要/长度；被截去的后缀不可由该收据恢复，这也不是原始进程字节总数。合法业务评审报告完整保留，上限为序列化后 8192 个 UTF-8 字节，超限为明确的格式失败；相应 compiler/registry/schema 已升级 v3。摘要只证明内容一致性，授权仍来自可信 host 存储和账本。实际 live 模型/供应商会话隔离未在本批调用测试；已验证的是 adapter API 边界的会话与上下文隔离。

## 汇合、预算与恢复

`GraphVerificationJoinService` 不接收 worker 的“是否通过”结论。它在异步证据验证前固定完整账本快照，从最新 logicalAttempt 找到两个前驱，验证冻结 artifact、当前 effect 和实际 envelope，重新生成结果并与持久账本逐字段比较。旧 attempt、跨 scope/run/spec/epoch/candidate、缺失前驱、被篡改证据均不能变成通过。

迁移31新增不可变 `graph_verification_joins`，对 `(run,epoch,candidate)` 唯一。发布时在 BEGIN IMMEDIATE 中再次核对原 generation/owner/revision、完整快照、未决动作及资源释放义务；同一结果丢失 ACK 后重放返回原记录。资源释放可不改变 run revision，因此快照还包含 admission 状态摘要。存在 unknown 或 held 资源时不发布完成汇合。

路由使用原始 spec、createdAt、真实动作/attempt 与精确 token 账本。最多两轮代码修复；格式/基础设施 retry 不推进 epoch。达到预算停止新动作，已产生的完整合法结果仍可留下汇合证据。达到精确动作/token 上限但不再花费的已通过候选可 ready；超额记账或 deadline 已到仍按原计划 stop。

编译器预留 `epochs × (3 + 4 × branchAttempts)` 个动作：每轮实现工作区、实现/修复、freeze，以及每次 review/tests 调用与独立工作区准备；token 上界为每轮 `32768 + 16384 × branchAttempts`。完整生命周期如增加清理动作必须在 G21 同步扩展预算与 compiler identity，不能据此绕开账本。第一轮骨架与 G19 host 准备目前分别验证；尚未把所有动态工作区注册和后续修复连接为完整生成模板。

所有异步复核中的 revision 变化，包括租约续期，都会使本次评估失败。没有刷新掉已经验证的前提。G21 driver 须在验证前安排足够长的原代 host 租约，停止/排空旧 worker 后再恢复，并在冲突时重新读取和完整验证；短租约持续续期下的活性/性能仍由 G21/G28 验证。

## 实际 worker 验收

新集成测试通过真实 GraphRuntime 子进程、公开 Functional task、RemoteCheckpointSaver、SQLite、GraphActionBroker/G04 和独立工作区运行验证阶段：

1. 让 review 的失败 RETURN 落入 SQLite，同时把已真实执行并记账的 tests 响应扣留在 RETURN 前。
2. 停止实际 child，记录真实 SIGKILL/退出收据，释放故障窗口并排空 broker；独立核验执行器停止和候选保留后走 G15 takeover。
3. host 显式分配 review attempt 2。恢复后的 worker 仍读到旧失败 RETURN，tests 函数重入查询已确认动作，实际命令不再执行。
4. host 忽略 worker 的 claimedPass 和旧 attempt 1，读取最新 attempt 2；一次汇合发布，重复评估不新增记录。实际 reviewer 调用两次、测试命令一次、actionStarts=4，原 spec/createdAt 不变。
5. 另一实际 worker 场景让停止证明失败：task 抛错，unknown 不缓存为成功 RETURN；host 只给 reconcile，不重试、不发布通过。

以上是验证阶段的恢复闭环，不是 G21 完整代码交付模板。原 C5 的 daemon/assembly 29 项测试也在全库复验中保留。

## 验收与独立审查

实际 LoopEngine `C6-final-acceptance-2`：1 个执行、0 个跳过、success，全部六个 verifier 通过。全仓库 **3160 项测试、22 个测试包通过**；完整构建、typecheck、schema freshness、G07/C2 探针、CLI 启动预算和改动源文件 Biome 通过。具体日志、源摘要、actor 实际执行结果和失败重跑记录见 [证据目录](graph-verification-evidence/README.md)。

首轮全库复验为 3159 passed / 1 failed：旧测试仍要求服务拒绝大输出，与本轮新行为冲突。已改为直接验证存储层拒绝超限 envelope、且不生成文件；单项通过后，以新 Loop/task/home 完整复验，失败与最终日志均保留。

G18、G19 与加固/集成 actor 都由真实 OSStack LoopEngine + CodexCliAdapter 执行；actor 的 diff-only 轻量验证不代替父执行器全库验收。真实 Claude Fable 5.1 完成设计、实施与最终源码审查；采纳、修复和保持原计划的理由见 [审查裁定](graph-verification-evidence/claude-adjudication.md)。

## 下一步

下一批从 [G21 上下文](2026-09-14-graph-verification-next-context.md) 开始，组合实现→freeze→并行验证→host join→ready/repair/stop 的完整 code-delivery-v1，并完成可执行的 epoch 推进与动态受信任动作注册。G22–G24 再交付 CLI/RPC；G25–G29 仍负责故障、兼容、发行、性能和真实内部试点。

当前保持实验准入：same-UID 不是 OS sandbox，SQLite WAL NORMAL 不是断电持久保证；完整历史 bundle、大仓库和原生发行约束沿用 C5。没有修改默认/保留控制面数据库，也未 merge、push 或部署。

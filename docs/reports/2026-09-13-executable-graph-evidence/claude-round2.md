## 先修正首轮

首轮有三处结论过强，本轮撤回或降级：

- "两种 checkpoint 模型必然冲突，所以包装不成立"撤回。冲突只在两边都自称运行真相时成立，投影模型消解了它。
- "随机 kill 100 次按 run_id 无重复代理运行"降级为"同 effect_key 至多一份 confirmed 结果，下游只消费一次"。
- "自建调度器"不再是默认路径。MS agent-framework 主 README 提供 Go 入口，首轮"仅 Python/.NET"有误。

## 逐项回应

**挑战 1：投影模型可行，但有一个漏洞。** 认同 daemon 持唯一权威、LangGraph checkpoint 只作投影、broker 按 effect_key 去重并阻断 unknown。自写调度器同样要这份副作用账本，我把共同成本算成外部引擎缺点是错的。可行的前提有两条。第一，节点函数内一切副作用必须经 broker，且 intent 落 ledger 要早于执行，checkpoint 写在节点返回后，崩溃窗口由 effect_key 查询兜底。第二，fencing_generation 要同时约束 checkpointer 的 put 和 putWrites 两条路径，否则陈旧 worker 的并行分支 pending writes 会漏进当前代。这两条都可在自定义 BaseCheckpointSaver 内完成，不侵入引擎。真正的漏洞见最后的反例：fencing 保护的是账本，不是文件系统。

**挑战 2：接受。** 业务成功须显式 schema 加 business predicate，两引擎同等。导入成本只在 graphworker 懒加载可接受，但补一条：模块求值是同步的，在 daemon 进程内首次 import 会阻塞事件循环百余毫秒，触碰 RPC p95 预算。graphworker 应是独立子进程，不在 daemon 进程内懒加载。ADK 的 Workflow experimental 警告足以让它退到语义对照位置。Node 20 未验证是 P0 门槛，不是备注。

**挑战 3：切片方向对，三处要收紧。** 其一，"冻结 candidateRevision"必须是 worktree 内 commit 出 sha，review 与 tests 各自以 detached 方式检出该 sha 到独立 worktree。tests 需要依赖安装，成本要计入。其二，reviewer 输出 schema 不合法是基础设施失败，不是代码缺陷，不应路由到 repair 消耗修复轮次，应单独重试该分支。其三，runTask 迭代循环自带评审反馈，若写节点内的 bounded refine 仍启用 Loop 自己的 review，就和图层 review 分支形成双重评审。runOneTask 要能关闭内置 review。另查 worktree add 与 remove 是否触碰 repo 写锁，这决定扇出能否真正并行。

**挑战 4：接受全部核实。** 补两点。artifact_only 下 finally 不能在成功时也删 worktree，否则产物随 worktree 消失。产物应定义为 sha 加导出 patch 落控制面存储，worktree 可独立 GC。retainOnFailure 会堆积 worktree，需要 GC 策略与 ledger 登记。

**挑战 5：接受修正。** 新增一点。LangGraph 恢复时会想重跑 interrupted 节点。处于 cancel_pending 或 reconciliation_required 的 effect_key 必须让 broker 拒绝进入，图在该节点上停住，等 reconciler 确认子进程退出且产物状态清楚后才放行。资源消耗按 effect_key 记录包括 unknown 尝试，供计费对账。

**挑战 6：认同。** 再加一条。撤销可能发生在运行中途，所以 policy、grant、expiry 校验要在每个 superstep 节点启动时重做，不只在 resume 入口做一次。

## 最强反例

陈旧 worker 的 codex 或 claude 子进程仍在向 worktree 写文件。fencing_generation 能阻止它发新动作或写当前代 checkpoint，但阻止不了已启动子进程修改文件系统。新一代 worker 若复用同一 worktree，会把污染的内容冻结成 candidateRevision 送去评审。这说明 fencing 只覆盖账本，不覆盖 worktree。修法是每代 worker 使用新 worktree，或在复用前确认旧进程组已退出且 worktree 状态与 ledger 记录一致，否则隔离该 worktree。

## 阻塞项与后续优化

P0 阻塞：

- executor 缺 done 默认 completed 的缺陷修复。
- runOneTask 提炼，支持 artifact_only、retainOnFailure、关闭内置 review、传入外部 signal。
- effect broker 与 ledger，含 intent 先行、confirmed 去重、unknown 阻断、cancel_pending 与 reconciliation_required 状态。
- 自定义 checkpointer，在 put 与 putWrites 两路校验 fencing_generation。
- worktree 按代隔离，陈旧代 worktree 不复用。
- 每节点启动重验 policy、grant、expiry。
- Node 20 CI 矩阵、graphworker 独立子进程、启动预算不变。

后续优化：ADK 正式评估、动态 cycles、多 writer、独立 osgraph CLI、reviewer worktree 安装加速、worktree GC 调参。

## 可实施修订

1. 切片路由增加第四出口 branch_retry，专收 schema 不合法与基础设施失败，与 repair 预算分离。
2. candidateRevision 定义为 commit sha，产物为 sha 加 patch，落控制面存储。
3. 契约测试集在首轮六项之外新增两项：陈旧子进程继续写文件时新代不受污染；运行中撤销 grant 后下一节点不启动。
4. 持久恢复测试必须跨进程重启，不再接受 MemorySaver 同进程结果作为通过证据。
5. 以上契约全部用 LangGraph 单实现跑通后再谈 ADK 或自研，并把每次评估理由写入 docs 的设计记录。

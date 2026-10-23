这一轮只做设计评审，不动代码。以下先列已核实的代码事实，再给判断。

**一、已核实的代码事实（来自本次给出的源码）**

- 适配器契约只有 `invoke(task, signal)`，靠 AbortSignal 取消。文件头注释里写的 D5 "显式 cancel(runId) 方法" 在接口上并不存在，注释与接口已经脱节。
- 执行器不接受外部 signal，只用内部超时 AbortController。图级取消目前无法穿透到正在运行的适配器。
- 执行器的默认结果是 completed。若适配器流提前结束且没有 `done` 事件，run 会被记为成功。注释宣称"daemon 会拒绝不合规流"，但执行器本身不校验。这对 AND-join 是致命隐患。
- Loop 逐个顺序执行任务，重试、反馈、停滞指纹、升级都在 runTask 的迭代循环内。每任务可开独立 worktree。
- 摘录显示 LOOP-STATE.json 在整个 cycle 结束后才写回，且 in_progress 被清空。若中途崩溃，本 cycle 已完成任务大概率丢失。此点是摘录推断，需核实是否另有增量写入。
- daemon 写锁按 repo_id 串行，外加全局写信号量和文件锁，并受 autonomy 健康检查门控。
- 协议层已有 Ed25519 签名的有界委托（步数、重试上限≤3、超时、过期），但输出检查只有 text_equals 和 json_value_equals，达不到"类型化节点 I/O"。
- graph explain 只读，与执行无关。

**二、核心判断**

1. **不做新产品 osgraph。** 图执行的难点不在调度算法，而在权威归属：租约、写锁、健康门控、策略、证据链都在 daemon 里。独立产品要么重复这些，要么通过 RPC 回来借权限，两者都比在 monorepo 内新增 `@osstack/graph` 包更差。最强反方：Loop 的状态模型是"每工作区一个 JSON、顺序单任务"，图状态硬塞进去会越搞越乱。这个反方是对的，所以结论是图状态另存控制面 SQLite，图调度器位于 runTask 之上、cycle 之下，Loop 仍是"单节点执行器"。

2. **自己写小调度器，不包 ADK JS 或 LangGraph.js。** 理由：两者各自带会话和检查点模型，与"单一写者 daemon"冲突；ADK 的 Join 只等前驱 COMPLETE，不看成功，与我们需要的默认语义相反；LangGraph 的检查点不能让 worktree、子进程、git 分支这些外部副作用变成恰好一次，我们仍要自建幂等。另外依赖加载成本受 CLI 启动预算约束，Mastra 还要求 Node 22。反方：自写会重踩中断、恢复的老坑。应对：静态 DAG、节点数少，把 ADK 和 LangGraph 的语义改写成一致性测试用例，而不是引入运行时。给一天时间盒用 LangGraph.js 做对照 spike，只为校验语义和测量，不作为落地路径。

**三、关键机制**

- **权威归属**：图运行是一份有界委托，格式沿用 ContinuationGrant 思路。只有 daemon 写图状态；节点通过返回值交付，永远不直接改状态表。
- **持久化与副作用**：节点状态迁移（pending、running、succeeded、failed、cancelled、interrupted）在执行前先落库，附 run_id。恢复时 running 一律改 interrupted，只有声明 idempotent 的节点才自动重跑，其余交策略或人工决定。输出连同 sha256 落库，join 只读库，不读内存。
- **重试分层**：评审不过的重试留在 Loop 迭代内，图层只重试基础设施失败（适配器不可用、超时、interrupted），且两层预算相乘后的上限必须在图规格里显式声明，禁止双重重试同一评审失败。
- **取消**：执行器新增外部 signal 参数，形成图→节点→适配器的信号链。取消后待运行节点标 cancelled，join 按声明走 fail-fast 或等待，worktree 必须清理。
- **AND-join 作用域**：每次扇出生成 barrier_id，输出以（run_id, barrier_id, branch_id）为键。若图含回边，每一轮换新 barrier_id，不同轮的输出永不混入同一 join。默认谓词是"全部 succeeded"，"全部完成"作为显式选项。前提是先修执行器"缺 done 即成功"的缺陷。
- **worktree 并发**：并行分支各自 worktree。写锁按 repo_id 串行，同仓库多个 worktree 是否共用一个 repo_id 未核实，是并行度的第一个未知数。扇出分支只产出补丁或分支，合并到主线由 join 之后的串行节点在写锁下完成。
- **模式校验**：节点输入输出用 Zod（延续 E1 决策）。适配器输出是自由文本，需要约定结构化证据文件，校验失败即节点失败，交给 Loop 迭代带反馈重试。

**四、可度量的发布门槛**

- 三分支扇出中随机 kill 进程 100 次，恢复后终态一致，按 run_id 计数无重复代理运行。
- 取消后 5 秒内所有子进程退出，无孤儿 worktree。
- 属性测试：join 在任一分支非 succeeded 时绝不触发；跨轮输出绝不混入。
- 模式不合法的输出绝不进入下游节点。
- 同仓库两分支并发写，锁串行可观测，无丢失更新。
- CLI 启动预算和 Loop tick 开销预算不变，新包全部惰性导入。

**五、推荐的垂直切片**

图形为：plan → 并行（实现 A、实现 B，各自 worktree）→ AND-join（全部成功）→ verify → 条件路由（通过则串行合并，否则升级）。交付物：`@osstack/graph` 包含 Zod 图规格、调度器和三张 SQLite 表（graph_run、graph_node_run、graph_barrier）；执行器增加 signal 并修复缺 done 默认成功；从 Loop 暴露单任务执行入口供节点调用；daemon 增加 run、cancel、status 三个 RPC；CLI 命令避开已存在的只读 `graph explain`，建议用 `osstack graph run` 并在文档里明确两者边界。切片先做单进程、单仓库，不做跨机器，不做动态生成节点。

**六、结论**

新产品不成立，包装外部引擎也不成立。真正的前置工作是修执行器的两个缺陷、核实 repo_id 与 worktree 的关系、核实 cycle 中途崩溃的状态丢失，然后再动调度器。这三项未核实前，任何"图执行已具备基础"的说法都是推测。

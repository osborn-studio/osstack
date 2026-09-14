结论先行：在 1.4.15 的公共接口内，不存在"既不重跑 completed 节点函数、又能保证 join 恰好一次"的修法。唯一能成立的最小公共方案是"任何恢复一律以显式 checkpoint_id 从失败 superstep 的基准 checkpoint 全量重跑，副作用去重交给 effect ledger"。它把 exactly-once 的责任从引擎移到 ledger，引擎仍是图进度的唯一权威，但结论只能写成 conditional on ledger。updateState(asNode) 与收据拓扑都有可预测的失败点。

**1. 根因位置与波及面比文档记录的更大**
- 供图 runner.js 的 `_commit`：非 GraphBubbleUp 错误一律追加 ERROR 后整批 `putWrites`，不区分 AbortError 与节点自身异常，也不清空已积累的部分写入。`_runWithRetry` 在 `signal.aborted` 时直接 break，重试策略无法介入。
- 部分写入之所以可能，是因为 StateGraph 把状态写入和边触发写入编译成 RunnableSequence 里两个独立的 ChannelWrite，中止落在两者之间。此为推断，state.js 未提供，需读 `attachEdge` 确认。若成立，线性边同样会丢 `branch:to:next` 写入，恢复后图静默结束，问题并不限于 AND join。
- 外部取消与 step 超时走 `abortPromise`，与任务 settle 在 `Promise.race` 中竞争。哪个先被观察到，决定该任务是否进入 `_commit`。取消和超时路径的落盘结果本身是时序相关的，单次通过不能作证明。
- 唯一原子边界是单次 `putWrites` 调用。saver 只能保证一批一起落盘，无法判断这一批是否完整。这是"部分 vs 完整"在 saver 数据里不可判定的形式化理由，任何复用 pending writes 的方案都绕不开。
- 可测：把探针 join 换成线性尾节点重跑 immediate 用例。再用 `AbortController` 在 `afterWrites` 收到 results 写入后触发外部 abort，重复 N 次统计两种落盘形态的出现比例。

**2. updateState(asNode='completed') 有两个可预测的失败点**
- 值来源：pending 里的 `results=["completed"]` 是部分批次，不是节点完整结果。多通道节点会丢通道。只有可信 effect store 能提供完整结果，saver 不能。
- 拓扑：updateState 经 `_applyWrites` 执行"未更新通道进入新步"逻辑，`branch:to:flaky` 这类 EphemeralValue 会被清空并升版本，flaky 失去触发。NamedBarrier 只收到 completed，join 永不就绪。此为推断，需验证。预测结果：updateState 后 `getState().next` 为空而非 `['flaky']`，`invoke(null)` 直接返回，join.count 仍不存在。
- 若再用 updateState(asNode='flaky') 补救，flaky 的执行发生在引擎外，调用方成为第二个调度器，违反单权威约束。
- 判定：作为需要反证的实验保留，不作为候选。

**3. 推荐最小实验：显式 checkpoint_id 全量重跑加测试专用 effect store**
- 机制假设：config 带 checkpoint_id 时 loop 不把 pending writes 匹配回任务，该 superstep 全部任务重新执行。loop.js 未提供，需验证。验证信号是 completed 函数计数变为 2。
- 步骤：
  1. immediate 用例失败后调用 `graph.getState(config)`，记录返回 config 中的 checkpoint_id，并确认 tasks 中存在 error。
  2. 新进程里给节点函数包一层 effectOnce，key 取 thread_id、metadata 中的 langgraph_step 与 langgraph_node。store 为文件级原子写，明确标注 test-only。
  3. 以 null 输入、带 thread_id 与 checkpoint_id 的 config 调用 invoke。
  4. 断言：results 排序后等于 completed、joined、recovered。join 计数 1。completed 函数计数 2 而 effect 计数 1。flaky 计数 2。
  5. 恢复中再崩：恢复运行里让 flaky 首次仍 immediate 抛出，再按同一协议恢复。effect 计数仍 1，join 仍 1。
  6. 两个反证：不带 checkpoint_id 重跑应得 join 0。带 id 但关闭 store 应得 effect 计数 2，证明 ledger 不可省。
- 已知缺陷：
  - 任务 id 是 checkpoint id、step、name 的 uuid5，重跑复用旧 id。saver 的"首次值优先"会保留陈旧 index 0 行。进程内 `_applyWrites` 用的是内存 task.writes，新 checkpoint 正确，但审计不能把 pendingWrites 当结果读。
  - worker 被 SIGKILL 时没有 ERROR 行，协议不能靠 error 检测触发。必须无条件：凡恢复都带最新 checkpoint_id 重跑。这要求 ledger 对未开始任务也安全，即无 receipt 就执行。
  - 每次恢复都生成 C_k 的新子分支，历史膨胀，retention 成为义务。
  - 真正 exactly-once 依赖 ledger 记录与副作用原子。测试 store 只能模拟这一点。外部调用类副作用还需要 lease 与幂等键。这些是计划中的 M1+，实验结论必须写成 conditional。
  - interrupt 恢复：Command resume 加显式 checkpoint_id 是否仍能匹配 RESUME 写入，需单独用例。

**4. 收据拓扑与 Pregel 低层 API 不能绕开问题**
- 自定义 receipt 通道仍由独立 ChannelWrite 写入，窗口不变。
- 用 Channel.subscribeTo、pipe、writeTo 把输出与触发合并成一次 ChannelWrite 确实原子。但节点返回后、写入前中止仍只落 ERROR，恢复时节点重跑，副作用重复。
- 结论：写入原子性只保证图进度，副作用 exactly-once 与引擎无关，只能靠 ledger。低层 API 相对方案 3 没有增量收益，却承担文档不鼓励直接构造的风险。

**5. 错误处理节点与结构化失败只是缓解**
- 供图 runner 显示已处理异常会 continue，不触发 `exceptionSignalController.abort()`，兄弟任务不被中止。但外部取消、超时、worker 死亡不经此路径。
- handler 节点不会写 join 的 barrier 名，AND 边设计需同时改为收据路由。可用于降低触发概率，不能用于证明。

**6. 若实验 3 的机制假设被推翻：有界静态调度器最小准入**
- 范围：仅现有受限 JSON 静态 DAG。节点即注册 effect。边含 AND。interrupt 表达为显式"等待外部收据"节点类型。不支持 Send、子图、动态拓扑。
- 存储：单表 task_receipt，字段为 thread、step、node、attempt、status、result、effect_id。done 与 result 一条原子记录。外部副作用走 lease 加幂等键。
- 调度：superstep 就绪条件是入边收据全部 done。恢复即从收据重算，无内存状态，重复恢复幂等。
- 准入矩阵沿用现有八进程探针，加"每次收据写入后可中止"钩子与二次恢复。
- 复用现有 checkpoint codec 与 effect store，不引入多引擎抽象。

回顾：根因在 `_commit` 持久化部分写入且边写入非原子，波及线性边与取消路径。updateState 预测会丢 flaky 触发，收据与低层 API 无法解决副作用重复。建议先跑第 3 项实验，关键验证点是显式 checkpoint_id 是否真的触发全量重跑。若被推翻，直接进入第 6 项静态调度器准入。

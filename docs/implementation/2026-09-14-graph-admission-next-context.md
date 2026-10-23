# 下一轮编码上下文：G11–G13 / C4

继续在 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation` 的 `codex/graph-runtime-foundation` 工作。读取本仓库 AGENTS.md、[实施计划](2026-09-13-osstack-graph-upgrade.md)、[任务清单](2026-09-13-osstack-graph-upgrade.tasks.json)、[C3 验收](2026-09-14-graph-admission-completion.md) 和 [Functional 决策](../design/2026-09-13-graph-functional-runtime.md)。原工作区仍在 graph-readonly-pilot；不要覆盖其用户修改的 AGENTS.md。

G00–G10 已完成，11/30。下一批先 G11，再按依赖推进 G12/G13；目标 C4。继续用真实 OSStack Loop 执行聚焦任务，并请 Claude Fable 5.1 做独立挑战。使用显式隔离 OSSTACK_HOME；及时把结果归档到仓库，不能仅依赖会被清理的系统临时目录。不要 merge、push 或部署。

## 本批契约

- G11：动作账本、稳定 effectKey、intent/confirmed/unknown、逻辑 attempt 与预算预留。generation 不能进入 effectKey 来规避幂等。未知外部效果不盲重发。
- G12：受控 action broker；复用 G04 的一次实现接口和 G10 准入。动作权限从可信 daemon 会话/委托取得，worker 的 scope、principal、receipt 或 checkpoint 不自授权。锁后的授权/撤销再校验不可省略。
- G13：daemon 持有 checkpoint 持久化，绑定 G08 program identity、generation、owner、revision；检查与写入必须在同一 SQLite 事务内。checkpoint 是调度权威；ledger 是效果/权限/资源权威，禁止增加第二套节点调度器。

## 必须继承的实现约束

1. 内核仅使用已准入的 `langgraph-functional-v1` + `durability: sync`。StateGraph partial-abort AND-join 反例仍存在；公开 task cache 不校验输入参数/调用顺序，必须绑定完整不可变编译身份与输入。
2. `GraphRunStore` 是可信 daemon 内部存储端口，不可直接转发 worker JSON。当前投影写要求活动 generation；pre-worker cancel、expired-worker 管理操作需要后续基于证据的专门路径，不要伪造已退出 worker。
3. 仓库锁取 actual Git common directory，跨 HOME 与 worktree 共用。`context.repo_id` 仅是严格校验的 canonical hint；旧 logical label 不是锁身份。
4. G10 入口：`GovernedExecution`、`acquireLocalExecution`、daemon `withLoopAdapters`、`acquireSessionAdmission`、in-process `acquireGraphAdmission`。新 broker 复用它们，不能绕开租约或通过同一 run 的嵌套准入造成死锁。
5. `serve --workspace <repo>` 注册直接写 adapter 的确切执行目录；worker 不能选择或覆盖注册。读请求保持其目标；写路径不匹配在调用 adapter 前拒绝。每个 worktree 继承主仓库 policy。
6. 取消请求、terminal event、iterator exhaustion 和 leader PID 退出都不能自行证明全部外部效果停止。真实 receipt 才能释放不确定执行；缺少 receipt 保留 canonical lock 和实际占用的并发容量。G14/G15 实现自动隔离/对账；当前只有[离线恢复规程](graph-admission-evidence/recovery-boundary.md)。
7. 没有副作用的参数/读取错误应释放准入，避免把拼写错误变成永久隔离。续约/释放故障只隔离相关仓库，不能阻断无关读取。
8. 新模块继续保持 graph → protocol + LangGraph；core → protocol；CLI 负责组装。LangGraph 重入口不得加载到 daemon 根入口。
9. 当前 Graph port 只是受信任进程内注册接口，没有公开 graph RPC、worker、checkpoint 服务或生产运行模板。不要将 C3 的通过表述成整个 Graph 已可用。
10. G27/G28 仍需正式运行时/native SQLite 支持矩阵、daemon RPC/tick 性能测量。C3 启动预算通过不能替代这些验收。

完成后更新任务清单、代码提交、实际验证日志和下一轮上下文。若局部实验通过但集成仍失败，保持相应任务未完成。

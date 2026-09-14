# 下一轮编码上下文：G14–G17 / C5

继续在 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation` 的 `codex/graph-runtime-foundation` 工作。C4 验收代码 `36eee05f6bc6ef6aa8148dd9f4e9271e2237d4fc`，G00–G13 完成，14/30。先读 AGENTS.md、[计划](2026-09-13-osstack-graph-upgrade.md)、[任务清单](2026-09-13-osstack-graph-upgrade.tasks.json)、[C4 验收](2026-09-14-graph-effects-completion.md)、[Functional 决策](../design/2026-09-13-graph-functional-runtime.md)。原工作区仍是 graph-readonly-pilot，不覆盖其用户 AGENTS 或源代码。

## 顺序与完成门

1. **G14**：独立 worker-entry 与 manager，真实 IPC client、绑定连接身份、日志隔离、原始帧限长、背压、心跳、取消和单有效代际。启动不能在 daemon 求值 LangGraph 重入口。暂停/取消先停止新动作，等待 worker 和独立 executor 各自证据后才允许接管。
2. **G15**：可信 unknown/intent/running/result/checkpoint 窗口对账，稳定 interruptId/动作引用；已生效、未生效、仍未知分别处理。不得盲重发。确认取消的终态不能 resume 复活。不要为让测试通过绕开旧代 fencing。
3. **G16**：可信 freeze 服务与可恢复 candidate 产物，保存 commit/tree/二进制/删除/模式，原 worktree 清理后重建验证。未停旧进程隔离旧目录，未导出产物不能由 finally 删除；迁移编号在最新表后顺延，当前为 27。
4. **G17 / C5**：通过真实 daemon→worker IPC→broker→一次命令→持久结果跑两节点链。确定性覆盖已确认外部效果→RETURN、最终 checkpoint、恢复再次崩溃、不响应取消。仅实验/测试启用，不能把 MemorySaver 或 C4 存储子进程夹具冒充此链。

G14 依赖 G12/G13；G15 依赖 G14；G16 在已有依赖齐备后可独立设计，但 migrations/daemon 由单负责人串行合入；G17 等 G15/G16。继续用真实 OSStack Loop 执行聚焦卡，配合真实 Claude Fable 5.1 做独立挑战，不以模型评语代替测试。

## 已有接口

- `GraphRunStore` 保存不可变原始 spec、完整 program/input 身份与代际租约。`GraphActionStore` 提供 reserve/get/markRunning/recordOutcome/markUncertain/retry；返回 action、run、budget、created、changed。effectKey 排除 generation，logicalAttempt 仅 ledger 分配，确认结果可重放。unknown/旧代遗留 intent/running 阻止新动作。
- daemon `await handles.graphActionBroker()` 返回可信进程内 broker；`register(connectionObject, registration)` 固定 scope/run/program/generation/owner/**单一 epoch**/workspace/精确 node-slot-action、执行器与证据映射；`handle(connection, request, {signal})` 执行动作。G14/G18 必须由可信 host 连接/编译注册控制 epoch，不能接受 worker 自行换 epoch。尚无公开 worker RPC。
- Broker 自己按 `graph-action:${effectKey}` 获取 G10 准入。**不要**在调用外面再取整 run 的 `acquireGraphAdmission`，否则嵌套 writer 死锁。adapter/command 复用 G04 `executeCandidateImplementation`，工作区是可信 handler，freeze 暂拒绝。
- `GraphCheckpointStore(db, tightenedLimits?).execute(fence, request)` 返回 `{run,response}`。`StartDaemonOptions.graphCheckpointBindings` 为可信 connection→binding；`handles.executeGraphCheckpoint(connection, raw)` 经授权后的同库服务。绑定在 startDaemon 首个 await 前快照；close 拒绝排队未完成请求。
- `@osstack/graph/checkpointer` 的 `RemoteCheckpointSaver(threadId, transport)` 使用公开 BaseCheckpointSaver 与 G07 codec；`GraphCheckpointTransport` 在 protocol。同 requestId 重试必须同 payload；Saver 不自动重试。每次异步等待后刷新 revision，但固定原 generation/owner/program。schema/codec 有边界，G14 仍需在接收原始帧前限长与背压。
- `graph-storage.ts` 的 fenced transaction 是 core 内部短同步事务，不公开任意 callback 给 worker。core/daemon 不解码 LangGraph 类；graph 只依赖 protocol + LangGraph，不能反向导入 core/cli/Loop。

## 不可退让的恢复约束

仅 `langgraph-functional-v1` + `durability:sync`。cache 不验证程序/input，host 必须比较完整不可变身份。checkpoint 管调度；ledger 管效果/资源；不增第二套 node FSM。task 函数重入次数、确认外部效果次数、逻辑 join 次数分别验收。

参数错误与已证明未调用可释放；外部状态或证据不确定保留 canonical repo 锁和实际容量，即使有 agent 退出证据，也不能把未导出脏工作区交给新 writer。同执行引用重放及不同引用冲突均转 unknown。当前只允许[C3 离线恢复边界](graph-admission-evidence/recovery-boundary.md)，G15/G16 必须补可信对账与隔离出口。

终端 event、iterator 耗尽、invoke 拒绝、abort、worker/leader 单独退出都不是全部外部效果已停的证明。重新授权在每次新动作、锁后、可用性 await 后执行；authority callback 的非 undefined 值不能充当 grant。broker 同步 authorizer 拒绝 Promise，checkpoint 异步 authorizer 必须 resolve undefined。

pre-worker cancel、expired-worker 管理仍需基于证据的专门路径，不伪造活动 owner 或停机收据。预算从持久原 spec/ledger 计算，重启/新代不得重置。只有可信 host 才能调用 retry，worker 重放不能生成新 attempt；取消和未知不可凭 retrySafe 绕行。

checkpoint quotas 固定上限 1024/32768/32768/64 MiB（checkpoint/write/请求/载荷），只能收紧；读和幂等命中不增长。`octet_length` 在当前 SQLite 3.53.1 验证，G27 对支持矩阵重测；G18 校验模板容量，G28 量事务行扫描/daemon RPC/tick 延迟。WAL NORMAL COMMIT ACK 不作断电保证。false resume 使用 interruptId 映射；单个请求失败不代表后续批次未提交。

## 执行与证据

每次运行开发 CLI/Loop 都显式设置新的隔离 `OSSTACK_HOME` 和短 `TMPDIR`，不能用默认或保留 home。真实 Loop 指定 `sources: []` + `inputTasks`；验收重跑用新 task ID 和 `skipCompletedTasks:false`，避免旧 escalated 记录被跳过后误称成功。最终检查实际 executedTaskCount、completedTasks、outcome、verifier commands，不能只看进程 exit 或 STATE 的旧记录。

C4 证据已归档在 [graph-effects-evidence](graph-effects-evidence/README.md)，临时控制器在该目录有 `.mjs.txt` 副本；重跑必须适配路径。及时保存日志和源摘要，完成后更新卡状态、C5 证据和后续上下文。不要 merge、push、部署或宣称 beta 已可用；G18–G29 保持未完成。

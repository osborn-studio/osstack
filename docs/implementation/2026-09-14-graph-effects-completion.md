# G11–G13 / C4 实施验收

**G11–G13 已完成，C4 通过；累计 14/30。下一批为 G14–G17 / C5。完整可恢复 Graph 执行链尚未交付。**

实施分支：`codex/graph-runtime-foundation`；工作区：`/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`。基线 `405b3183597e545391a220cc5a481691740abce7`；G11 提交 `b064928`；本批最终代码 `36eee05f6bc6ef6aa8148dd9f4e9271e2237d4fc`。原工作区只同步本批计划和证据文档；未合并、推送或部署。

## 已交付能力

| 任务 | 实际实现 | 验收边界 |
|---|---|---|
| G11 | 迁移 26；不可变原始预算、稳定 effectKey、账本分配 attempt、intent/running/confirmed/failed/unknown、预算预留与结算 | 未知动作禁止盲重发；重启不重置预算；旧代缓存也先验 fence |
| G12 | daemon 受信任进程内 action broker，精确节点/slot 注册，复用 G04 单次执行和 G10 共享准入 | 每个动作拥有准入；实现、命令及可信工作区操作；freeze 留给 G16 |
| G13 | 迁移 27；同库 checkpoint/pending writes/幂等收据，公共 RemoteCheckpointSaver，daemon 授权服务 | 异步 IPC/提交/ACK/崩溃已测；生产 worker 生命周期和公开 RPC 留给 G14/G17 |

为保持模块边界，实际分成 G11a 预算/账本、G11b 原子 fence/迁移；G12a 注册/执行、G12b daemon 组装、G12c 真实进程与授权回归；G13a wire schema、G13b 同库存储、G13c 公共 Saver、G13d daemon 与异步故障夹具。它们仍归属原三卡，任务总数不变。

所有账本与 checkpoint 读写、幂等缓存均在 `BEGIN IMMEDIATE` 内检查 scope、完整程序身份、generation、owner、revision。异步等待后刷新 revision，不能采用新 owner 或 generation 来续跑旧请求。checkpoint 管调度与数据，账本管外部动作和资源，没有新增节点调度 FSM。

Broker 只执行注册的精确 action 输入；worker 无法通过 scope、receipt、checkpoint 或模型输出自授权。排队取锁后，以及 G04 异步可用性探测后，再检查当前策略和撤权；同步门控紧贴物理 invoke。整个 adapter invocation 是账本粒度，未声称截获 agent 内所有内部工具。confirmed 重放不再次 invoke。

## 失败、预算与检查点

已观察用量按输入/输出各自累计最大值相加。结果映射、证据或落库失败时保留已知用量和已保存证据引用；未知结果保留锁及容量。合法超预算用量照实记账并禁止后续动作。只有确认尚未物理调用且未取消的失败允许未来可信 host 显式重试，worker 重放不分配新 attempt；已 running 的同/异执行引用均不能冒充安全失败。

检查点保留 parent、metadata、newVersions、pending writes 和公开负索引覆盖语义；整批原子写，明确分页游标，不静默截断。单帧 8 MiB、单 tuple 4 MiB、单 codec wire 1 MiB、tuple 至多 4,096 writes、每页至多 16 tuple。每 run 上限为 1,024 checkpoints、32,768 pending writes、32,768 幂等记录、64 MiB 数据载荷及缓存响应；可信 host 只能收紧。超限回滚数据、收据和 revision，既有读取与同 ID 重放仍可用。64 MiB 不等于数据库文件大小。

聚合计数使用已验证 SQLite 的 `octet_length`，避免为计字节读取全部载荷；UTF-8 配额回滚已测。行扫描和写锁耗时仍需 G28 测量。G18 编译器必须检查模板是否能在固定配额内完成。

真实子进程夹具把请求与 ACK 异步传递：提交前在事务已插行处 SIGKILL，重开证明回滚；提交后 ACK 前 SIGKILL，重开与同 ID 重试保留原结果。覆盖 task RETURN、最终多 channel 批次和 false resume。固定 SDK 只接受 `Command({resume:{[interruptId]:false}})`；裸 false 被拒绝。某个写请求失败后其他批次仍可能已提交，invoke 拒绝不等于全局回滚或外部效果未发生。

sync ACK 表示现有 WAL `synchronous=NORMAL` 下 COMMIT 返回，不承诺断电持久性。夹具终止的是持久化子进程，不能替代生产 worker 退出和外部动作对账验收。

## 实际验证与审查

- 真实 OSStack Loop + CodexCliAdapter 完成三卡执行；父级真实 Loop 最终运行 **2856 项测试 / 22 个包**全通过，一项任务执行成功、零跳过、六条验证命令通过。
- workspace build、严格 TypeScript、protocol schema freshness、G07/C2 内核回归、改动文件 Biome 和 git diff 检查通过。C2 standalone 输出 `admitted:false` 不表示本次测试失败，也不自行授予生产准入。
- 最终 CLI 启动结果：

```text
ok   osstack --version (fast path): median 29ms over 5 runs (budget 150ms; min 29, max 30)
ok   osstack --help (full command surface): median 84ms over 5 runs (budget 500ms; min 83, max 93)
```

- 第一次全库验收遇到父级新增授权红测试而 escalated；一次同 ID 重跑被旧状态跳过，未冒充成功。改为 fresh ID + `skipCompletedTasks:false`，先 2,853 项通过，再针对闭环增量重新全库验收。原始记录均保留。
- Claude Fable 5.1 实际进行了设计挑战、实现审查、闭环复核。实现审查无 worker 可触发 P1，三项 P2 用量/证据保留、调用前 retrySafe、存储配额均落实；闭环无阻断。两项非阻断备注随后也本地加固并重新验证，详见[裁定](graph-effects-evidence/claude-closure-adjudication.md)。

[机器验收](graph-effects-evidence/admission.json)、[最终 Loop 结果](graph-effects-evidence/acceptance-result.json)、[源文件摘要](graph-effects-evidence/source-hashes.json)、[证据目录说明](graph-effects-evidence/README.md)。运行时 Node 26.5.0 / pnpm 11.4.0 / better-sqlite3 12.10.0 / SQLite 3.53.1；G27 正式运行时和发行矩阵尚未完成。

## 下一批

按[接续上下文](2026-09-14-graph-effects-next-context.md)实施 G14 worker 生命周期、G15 未知动作与暂停点恢复、G16 候选产物冻结、G17 第一条真实 daemon→worker→broker 可恢复链。C4 只交付这些工作的基础，M1 尚在推进；完整工程图、CLI、性能与内部试点仍待后续任务。StateGraph partial-abort AND-join 反例仍不获准入，继续固定 Functional API + sync。

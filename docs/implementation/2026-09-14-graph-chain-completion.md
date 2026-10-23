# OSStack C5：可恢复执行链验收报告

日期：2026-09-14。**C5 已通过；G00–G17 完成，18/30，M0/M1 完成。** 本批实现 G14–G17；验收源提交 `50133c0eec518add33f556bfa95b746de350cc35`，基线 `30236fb4d26f65b7b9c30aa20d9fc255490ec12e`。工作区 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`，分支 `codex/graph-runtime-foundation`。

## 已实现的真实路径

受信任 daemon 显式创建 GraphRuntime，运行独立 Node worker。worker 使用固定 Functional API + sync，通过限长 IPC 请求 broker；broker 逐动作取得既有权限、准入和规范仓库锁，调用 G04 单次执行接口。第一节点执行真实命令，第二节点冻结候选产物。检查点、动作账本、恢复决定与启动代际分别持久化，恢复时保持各自的权威边界。

这是可执行图的最小纵向链。完整 code-delivery-v1 编译器、并行评审与测试、汇合/条件路由、修复循环及公开 CLI 仍由 G18–G24 实施；生产故障矩阵、兼容性、发行、性能和内部试点仍由 G25–G29 验收。

| 任务 | 实现 | 关键约束 |
|---|---|---|
| G14 | 独立 worker、帧协议、客户端、生命周期与日志隔离 | 固定完整程序/input 身份；限长和背压；worker exit 与独立 executor 停止分开 |
| G15 | 原代动作的可信对账、不可变决定、释放重试 | 已生效/未生效/未知分别处理；未知不自动重发；决定先落库再释放 |
| G16 | 自包含候选 bundle、manifest、恢复、worktree retention | 保留原始二进制/删除/模式/符号链接；原仓库删除后可重建；普通清理跳过保留工作区 |
| G17 | daemon 真实组装、两节点链及确定性故障测试 | 每代启动权持久消耗；原始截止时间不重置；停止后独立核验证据再接管 |

任务内部拆为 G14a 协议/客户端、G14b supervisor、G14c 生命周期边界；G15a 管理存储、G15b reconciler、G15c broker 准入释放、G15d 精确磁盘锁释放；G16a 内容冻结、G16b retention；G17a 组装、G17b 故障窗口及重启/释放验收。保留原 30 张卡的编号与依赖。

## 五个提交

- `c67c68e`：worker IPC、独立进程、真实/迟到退出与 no-child 收据。
- `83e5304`：自包含候选冻结与保留工作区。
- `d237cb0`：不可变对账、精确锁释放、取消约束及迁移 28/29。
- `64edcea`：daemon 组装和真实故障链验收夹具。
- `50133c0`：持久记录资源释放义务，阻止提前接管、终态和重试；覆盖物理释放后的数据库 ACK 丢失。

## 持久性与恢复

迁移 28 新建 `graph_recovery_decisions`，以 `(run, receiptId)` 唯一；同一 effect 的 interruptId 稳定，unknown→applied 用新 receipt 追加，不覆盖旧证据。提交在 BEGIN IMMEDIATE 内核对完整 scope/program/generation/owner/revision 和原始动作快照。过期代际只能走受信任管理对账，普通写入 fence 不放宽。

迁移 29 新建不可变 `graph_worker_launches`，同一 `(run,generation)` 最多消费一次启动权。daemon 重启不会因为内存表为空而重启同代；新代须有 G15 持久接管决定。daemon 的 runtime 只配置一次，避免多个 manager 各自认为自己拥有唯一 worker。

迁移 30 新建 `graph_action_admissions`。真实准入后、调用前记录 held；精确资源释放后才记录 released。恢复裁定先持久化结果及释放义务，再执行可信释放。任何未释放义务都会阻止接管、终态封存和对应动作重试，daemon 重启后仍有效。物理释放成功但数据库确认失败时，保留可核验的释放补记路径，不再次隔离已释放的内存容量。释放历史不可覆盖或删除。

已确认效果、缓存的 Functional RETURN 和完整 checkpoint 是三个不同事实。只有效果确认时，任务函数允许重入查询账本，但外部命令不得再执行；RETURN 已持久化后，对应函数也不重入。测试分别统计函数进入次数、外部日志和账本 actionStarts。

未知效果和无法确认停止的执行器继续保留真实容量与仓库锁。对账先验证当前 worker 和必要时原代 worker，再独立验证 G04 执行器停止与 G16 工作区保留/隔离。Promise 排空不能替代物理停止。锁释放失败不回滚已确认结果；后续只重试释放。daemon 重启后，内存中找不到 lease 不能代表磁盘锁已释放；必须核对精确 owner token、原 daemon PID 已死和持久决定，在文件锁 guard 中重新验证后释放。

取消中的 run 只能保持取消中或进入已取消，不能经普通投影变回 running/queued/ready；任何未决动作都会阻止终态封存。明确的 no-child 启动失败单独保留身份与阶段，不能伪造 exited 收据；注册冲突不能证明旧 worker 不存在。自动 no-child 恢复策略未接入产品入口。

可信恢复接口约束：对于已确认动作，`verifyOutcome` 应读取账本中的原始 outcome，保持 result/evidenceRef/actualTokens 一致并独立核验证据；不能重新生成结果替换它。`release` 回调必须证明精确资源已释放或可核验不存在，不能把 `releaseReconciled(false)` 或返回 undefined 本身当作释放证明。持久 admission 表记录可信 host 的释放结论，不直接观察物理资源。

## 确定性测试边界

真实 daemon 与直接模块组装各自运行，结果分别标注：

1. 效果已确认，响应被扣留在 RETURN 前：恢复重新进入 implement，命令日志仍只有一次。
2. RETURN 已落库，最终 checkpoint COMMIT 前：恢复复用 RETURN。
3. 最终 checkpoint COMMIT 后、ACK 前：恢复使用已持久候选结果。
4. 恢复后在同一窗口再次 SIGKILL：三次函数进入仍只有一次命令效果。
5. 取消传到真实命令进程组；忽略取消/SIGTERM 的 worker 被 SIGKILL，后续 freeze 不启动。
6. broker Promise 未排空、以及已排空但执行器停止不确定：分别拒绝恢复或保留 unknown/锁。
7. 原始截止时间在实际命令运行中到期；恢复不刷新预算。
8. daemon 进程 SIGKILL 后重启，同一 SQLite、保留 worktree 和规范锁下完成对账与接管。
9. 丢失接管 ACK 的精确重放不停止替代 worker；迟到的真实 OS exit 可重新读取。

**进程重启案例的范围：先停止并排空 worker，持久保存 supervisor 实际退出证据，再 SIGKILL 独立 daemon。** 未声称已经覆盖“daemon 被杀时旧 worker 未观察到退出且存在任意逃逸执行器”的自动恢复；没有足够证据时继续隔离，完整矩阵留在 G25。

## 验收证据

实际 LoopEngine `C5-final-acceptance-3`：1 个任务执行、0 个跳过、success。全仓库 22 个测试包 **3013 项通过**，包含全部 29 项 daemon/assembly 链测试；typecheck、schema freshness、G07 Saver 探针、C2 Functional 探针、CLI 启动预算和 diff 检查全部通过。CLI 启动中位数：`--version` 38ms / 150ms 预算，`--help` 135ms / 500ms 预算。完整构建通过；改动源文件 Biome 无错误，保留 4 条测试 IPC any 警告。

G14–G17 均由真实 OSStack LoopEngine + CodexCliAdapter 执行，逐个 1 个任务、0 skipped。actor 的轻量 gate 不能代替上述父执行器全库验收。第一轮验收的 3009 项通过记录单独保留；最终轮增加资源释放回归后重新验收。

Claude Fable 5.1 实际完成设计、worker/artifact、recovery/broker、daemon 闭环及资源释放补丁的独立审查。已修复长动作误用 RPC 超时、启动心跳、迟到退出、稀疏冻结、丢失接管 ACK 和未释放资源提前接管等问题；采纳/不采纳理由及剩余产品边界见 [裁定记录](graph-chain-evidence/claude-adjudication.md)。

第二轮全库复验曾在旧 collaborator RPC 的默认异步等待处超时；同一源码的该套件单独 11 项通过。最终轮降低测试并发至每包一个 worker，保留产品超时与原测试断言；失败和重跑日志均归档。

原始证据保存在 [graph-chain-evidence](graph-chain-evidence/README.md)，含失败日志、真实 Loop 事件/STATE、Claude 原始输入输出、源 SHA256、构建与性能输出。

## 能力边界与下一步

- 仅显式受信任进程内实验入口，没有公开 graph 写入 CLI/RPC，也没有宣称 production ready。
- Node 26.5.0、pnpm 11.4.0、better-sqlite3 12.10.0 / SQLite 3.53.1 已用于本批。正式 Node/native/发行矩阵仍须 G27。
- SQLite WAL synchronous=NORMAL 的 COMMIT ACK 不等于断电持久保证。
- worker 未获得控制面 DB/home，但相同 OS 用户下的恶意代码隔离未实现；可信源快照不是 OS sandbox。
- 候选存储采用完整可达历史 bundle，Git 单命令 60 秒、输出 256 MiB 上限；SHA1、完整非浅克隆源；拒绝 submodule、skip-worktree 等不支持情形。大型/历史异常仓库需 G27/G28 独立验证。
- daemon 在动作进行中关闭会保守地留下 unknown，需可信对账；未观察到旧 worker 退出时，不通过租约过期推断停止。启动记录尚无持久 PID/PGID/进程启动标识；注册消费启动权后失败、PID 重用及更广进程恢复留待 G25。主线程长阻塞可能触发保守心跳超时，留待 G28 验证。
- 没有自动 GC、锁前缀删除、未知动作重试或自动接管。artifact 临时锁的崩溃清理仍需要明确静止证明和管理处置。
- 现有 StateGraph partial-abort AND-join 反例仍被阻止；固定 Functional + sync，不改回未经准入的执行模型。

下一批为 [G18–G20 / C6 上下文](2026-09-14-graph-chain-next-context.md)。OSBot 仍保持单独产品/session，本批没有扩张其范围，也未修改 OStag。

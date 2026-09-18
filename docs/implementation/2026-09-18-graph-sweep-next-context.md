# G25 接续：从动作停止检查进入受信恢复证明

**25/30，G00–G24 完成；G25 in_progress，G26–G29 pending。** [最新验收报告](../reports/graph-quiescence-sweep-validation.md)。本轮源码 `355af3747870947a7b9ea628368e63249fb42c09`。

## 工作区与纪律

实施 worktree `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`，分支 `codex/graph-runtime-foundation`。原 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack` 仅镜像本任务文档，不动/提交用户 AGENTS.md 或其他工作。用户指定真实 Kimi K3 审查，使用 KimiCodeAdapter/no-tool profile，确认 runtime identity。用真实 OSStack Loop，新 taskId、sources=[]、skipCompletedTasks=false、独立 OSSTACK_HOME/TMPDIR；不可访问默认或保留 DB。不自动合并、推送或部署。

## 已有接口

- `sweepGraphQuiescence(db, options, {fence,mode})` 位于 CLI 内部，尚未开放公开 CLI/RPC。mode=`inspect|stop_contained`。options 的 current authorize 与 contained registrations 必须由受信宿主构建。
- 遍历所有历史 actions/admissions；核验当前代和动作所属代的 journaled direct-worker exit，再逐项核验可信注册的 contained tests。未注册、opaque、缺 admission 都 unproven；held 有权限且显式 stop 模式才精确停止；released 仅只读。
- 执行器调用前后及内部权限检查点复验 grant、完整 inventory 和 worker journal。报告 `allInventoriedExecutorsStopped` 仅限定清单内物理义务；始终 `recoveryAuthorized=false`，workspace/workerDescendants unproven。没有 G15 attestation、settle/release/takeover 权限，不能把这份 JSON 当恢复凭据。
- `reopenGraphContainedTests` 新增第四参数 `read_only`，可核验 released action 但 stop 永远拒绝；默认 held 保留原契约。
- 前轮 `verifyJournaledGraphWorkerExit`、`inspectExecutors`、`assertExecutorInventory` 继续使用。G15 改变 revision/action 后要新 snapshot/重开 handle，不能忽略 fence。

## 下一步顺序

1. 定义实际 host/adapter 的持久停止/no-start 凭据及独立 workspace 隔离证明，涵盖同步 host actions 和 opaque writer/reviewer；无证明保持 unknown。不要从 ledger 的 released/failed 标志推断物理停止。
2. 由可信 descriptor/candidate manifest 构建 registration。补齐没有动作/admission 的中间 lease 代与未登记后代；本轮仅核验当前代和有动作的历史代，Kimi 对此给出非阻断信息。
3. 将独立证明接入 G15 的真实注册和最终同步事务重验闭包，不接受 sweep 返回 JSON 作为授权。取消 workspaceEvidenceRef 仍复用 worker exit，takeover executor ref 仍为 join ref，需同步完善。
4. 根据完整可信业务 envelope/ledger outcome 对账；物理删除与业务成功分开。精确资源 release→DB admission release→接管按现有 G15 顺序，覆盖 ACK 丢失、跨代旧动作、撤权与并发停止。
5. 完成 artifact 锁管理恢复、剩余故障子窗口后，进入 G26–G29。

## 验证与复跑

真实 Loop `G25-quiescence-sweep-1` 执行 1/跳过 0/success，20 项真实 Linux sweep 专项测试和 5 项 verifier 通过；矩阵 532 次，源码/构建哈希一致。独立 Node 进程重开 SQLite 后得到一致报告；Kimi K3 approved。完整文件 52 项包含 20 项新测试，首次跨代 fixture 约束失败日志保留。

harness 在 `graph-quiescence-sweep-evidence/`。复跑要换 root/out、home、taskId；先 build，再运行 build-child.mjs。显式核验专用 Colima profile `osstack-graph-test` 的 daemon/base image，创建 candidate-config.json (`socketPath,daemonId,baseImageId`)。real 命令设置 G25_CONTAINED_CONFIG/G25_SWEEP_CHILD；矩阵不要带 real 配置。测试后核验零容器并停止该 profile，不改默认 context，不碰其他虚拟机。不要用旧哈希批准新源码。

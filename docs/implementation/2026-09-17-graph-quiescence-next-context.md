# G25 接续：全执行器物理证明与业务对账

**G00–G24 完成，25/30；G25 in_progress；G26–G29 未开始。** 最新报告：[持久 worker 退出证明与执行器清单](../reports/graph-worker-quiescence-validation.md)。

## 工作区与约束

- 实施 worktree `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`，分支 `codex/graph-runtime-foundation`；源码提交 `138784c74caee698f0f8836cb5aa9ae9be47b869`。
- 原 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack` 仅镜像本任务拥有的文档，不动用户 AGENTS.md 和其他工作，不提交原 checkout。
- 用户指定真实 **Kimi K3** 审查，`KimiCodeAdapter` + no-tool reviewer profile；确认 runtime identity `kimi-code/k3`，不要换回 Claude。
- 通过真实 OSStack Loop 执行验收：新 taskId、sources=[]、skipCompletedTasks=false、独立 OSSTACK_HOME/TMPDIR。不可打开默认或保留 control DB。
- 不自动合并、推送、部署。专用 Colima profile `osstack-graph-test` 测后停止；默认 context 不改，只处理精确测试容器 ID。

## 已有入口

- CLI `verifyJournaledGraphWorkerExit(db,binding)`：只读核验受信父进程持久 launched/exited、历史 lease 与 program/run/owner/generation/PID/时间一致性，可在最终 G15 事务内使用。只证明直接子进程历史退出，不查询/信号当前 PID，不证明后代或外部执行器停止。缺 exited 永不按超时/租约过期放行。
- core `GraphRecoveryStore.inspectExecutors(fence,effectKey?)`：完整历史 action/admission 并集、原代 owner、requiredEffectKeys。缺 admission（包括 settled legacy）、held 或 unresolved 都必须另取证明。
- `assertExecutorInventory(inventory)`：必须置于调用者 BEGIN IMMEDIATE 内；重新计算完整清单，捕获不增加 run revision 的 release 变动。
- GraphDelivery normal terminal/repair takeover/cancel 集成持久证明与完整清单；quality resume 也核验持久 worker exit。最终投影/接管/取消事务重新核验。日志失败转 reconcile，取消缺证据保持 cancel_pending。准备准入被拒但缺持久 admission/no-start 收据也转对账，不能直接 failed。
- 上一阶段 `reopenGraphContainedTests` 仍是 host-only 单 action 重建器：可信 manifest binding/command/contentDigest + action/admission/historical owner + 私有 journal；只有 confirmStopped/stop，没有 execute/settle/release。G15 改变 revision 或 action 后必须用新 snapshot 重开，不能忽略旧 fence。

## 下一步具体工作

1. 以完整 inventory 为输入，注册一个 host-only 全执行器核验流程。逐项分流 contained tests 与 opaque writer/reviewer；只能采用实际执行器/宿主提供的物理停止证据，不能把 released flag 当独立外部证明。
2. 对 contained tests 复用原账本重建器和 trusted manifest，逐个核验 identity、daemon、容器停止/删除回执及隔离 workspace。缺 admission/launch/executionRef 的窗口必须保守处理；要自动关闭明确拒绝准入的动作，应先设计可信的持久 no-start 凭据。
3. 补齐取消路径独立 workspace 证据（现仍复用 worker exit ref），统一 takeover executor evidence ref 与清单绑定，再将完整 worker + executors + workspace 证明接入 G15。业务 applied/not_applied 必须来自完整可信 envelope/账本结果；容器被删除不表示测试通过或业务效果不存在，缺结果仍 unknown。
4. 精确资源 release、admission release、takeover 按 G15 既有顺序完成。覆盖跨代旧 action、release ACK 丢失、权限撤销、并发 stop、最后事务前清单变化。没有所有义务的证明就不发新 writer。
5. artifact 锁管理恢复和 F01–F12 剩余子窗口完成后，再做 G26 旧模式共存、G27 Node/发行、G28 性能、G29 真实内部 LLM 试点。

## 复跑与证据

证据目录 `docs/implementation/graph-worker-quiescence-evidence/`。harness 是已执行记录，复跑必须换 root/out、Loop ID 和独立 home，不能用旧哈希批准新源码。

先启动/核验专用 Linux daemon 和缓存 base image，生成 `{socketPath,daemonId,baseImageId}`，并显式创建 `<out>/real-evidence`。构建 workspace 后运行 `build-child.mjs`，生成独立 Node 进程的 SQLite 退出证明检查器。验收以 delivery targeted suite、固定 seed fault matrix、typecheck/schema/startup、child DB reopen 和真实 contained GraphDelivery 为范围。本轮没有重新全量执行上阶段 3,368 项测试。

最终补验 Loop 37 项交付测试通过，执行 1/跳过 0/outcome=success；保留且重新哈希核验的 7 项 verifier 全通过，包括 512 次故障矩阵执行、25 项独立进程退出证明测试及 11 项真实 contained 配置交付测试。最终 Kimi K3 生产代码审查与补充契约审查均 approved。前轮旧断言失败和更早中断均保留，详见报告。

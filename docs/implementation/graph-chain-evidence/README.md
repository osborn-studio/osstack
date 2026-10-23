# C5 执行链证据

基线 `30236fb`，验收源 `50133c0eec518add33f556bfa95b746de350cc35`；C5 passed，productionReady=false。范围及限制以 [admission.json](admission.json) 为准。

- `acceptance-result.json` / `acceptance-LOOP-STATE.json`：实际 LoopEngine C5-final-acceptance-3，1 个执行任务、0 skipped、success。最后一轮采用每包 maxWorkers=1。
- `accepted-full-tests.txt` / `test-counts.json`：22 个测试包、3013 tests passed，包含全部 29 项真实链测试。
- `accepted-typecheck/schemas/kernel/functional/startup/whitespace.txt`：6 个真实 verifier，全部 exit0；Functional 实验 passed 与 production admitted 分开。
- `build-final3.txt`：完整构建；`biome-final2.txt`：38 个变更源文件无错误，4 条测试 IPC any 警告。
- `source-hashes.json`：43 个 C5 修改文件（含 lockfile） SHA256；后续报告变更不改变被验收源码。
- `G14/G15/G16/G17-result.json`、对应事件/STATE、handoff/interface：4 个真实 LoopEngine + CodexCliAdapter actor，各执行1个任务且0 skipped。actor 自身仅 diff gate；完整验收以父执行器 acceptance 为准。
- `claude-design`、`claude-worker-artifact`、`claude-recovery-broker`、`claude-closure`、`claude-admission`：5 次真实 Claude Fable 5.1 审查输入/输出；`claude-adjudication.md` 逐项说明裁定。受限工具造成的上下文问题不冒充源码事实。
- `first-acceptance/` 保存 64edcea 上的 3009 项通过；`second-acceptance/` 保存 50133c0 上一次旧 collaborator RPC 等待超时的失败，全部29项链与6个verifier仍通过。`collaborator-isolated-recheck.txt` 原样单独复跑11项通过；`acceptance-retry-note.md` 解释降低并发重跑。不删除或改写失败记录。
- `*-red*`、`durable-admission-*`、`release-ack-red.txt` 和其他初次失败日志：真实反例与调试过程。actor 的 Unix socket EPERM 也保留，未改写为成功。

采集脚本以 `.mjs.txt` 等形式保存。重跑前复制到新临时目录并修改工作区/证据路径，显式设置 OSSTACK_HOME；不能打开默认或保留数据库。未归档临时 SQLite、Git 对象仓库、socket、node_modules 或系统缓存。`archive-manifest.json` 是最终归档字节 SHA256 清单（不包含其自身）。

真实 daemon 重启场景先保存已观察到的 worker 停止/排空收据，再由独立父进程 SIGKILL daemon；未观察到旧 worker/任意逃逸执行器的自动恢复属于 G25。资源表记录可信 host 的释放结论，不替代物理证据。WAL NORMAL ACK 不宣称断电可靠。源码仍在实施分支，未 merge/push/deploy。

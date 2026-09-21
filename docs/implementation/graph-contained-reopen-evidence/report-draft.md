# G25：按账本重建容器执行身份与停止入口

本轮完成 G25 第五个限定阶段：新 supervisor 进程从 action/admission 与 host 私有日志重建单个 contained tests 执行器，检查或停止精确容器。它不会启动任务、写业务判定、释放 admission 或允许 takeover。G25 仍为 `in_progress`，总进度仍为 **25/30**。

## 实现与权限边界

`GraphRecoveryStore.inspectAdmission` 在同一 `BEGIN IMMEDIATE` 事务中校验完整 run fence，读取 action、admission 和该动作原代次 worker lease 的 owner。过期租约允许管理检查，不构成停止证明。没有 admission、跨 scope、代次/owner 不匹配、过时 revision 均拒绝。

`reopenGraphContainedTests` 要求可信 host 提供 manifest binding、登记 command、contentDigest 和 Docker daemon/base image 配置。invocation 仅从账本 `graph-execution:<effectKey>:<invocationId>` 取得，不扫描 Docker labels。读取 canonical 私有目录内的 `binding.json`，限制大小、禁止末端符号链接、核对 canonical data 和 SHA-256，再核对候选、scope/run/effect/generation、command、daemon 与基础镜像。沿用执行器已有的 specDigest、launch 完整 container ID、配置与持久 removal receipt 验证。

调用开始前快照 request/options；返回的 identity 也是副本。所有异步检查/停止前后均核验同步当前权限、完整账本/admission 快照与日志。读取权限撤销同样阻断 stop；初版测试发现底层 fallback 可能继续读取 Docker，此入口已补上双权限检查，保留首次失败记录以便复核。

返回接口只有 `identity`、`confirmStopped()`、`stop()`。底层 start 分支明确拒绝，内部 recovery verifier 也始终拒绝提交。未完成日志、缺失删除回执或丢失 DELETE ACK 保持 unknown；即便物理停止证明完整，测试结果也不能由此推断。

## 验证

__VALIDATION__

CLI 启动检查：`--version` 中位数 29 ms（预算 150 ms），`--help` 83 ms（预算 500 ms）。

全量套件运行环境是 macOS / Node 26.5.0；容器命令运行于专用 Linux Docker daemon。没有因此声称通过 Node 20/22 或整套 Linux 测试，G27 仍待完成。

新增 32 项 CLI 测试与 4 项 core 测试，覆盖重新打开 DB/租约过期、字段替换、缺失/错误/非 canonical/过大/符号链接日志、错误 scope/epoch/revision/owner/program、撤权与资源释放、调用者对象变更、原宿主停止失败和丢失 DELETE ACK。新测试已加入固定 seed 故障矩阵。

真实验证包含三个选定测试，其中两个调用独立 Node 子进程重新打开数据库与 helper；另有独立 SIGKILL 探针：原容器执行宿主被杀后，容器及不同进程组的子进程仍运行；新进程从账本和日志定位、删除完整 ID 对应的容器，晚到 start 返回 404。探针核实业务账本仍为 unknown，admission 仍 held。此探针证明的是容器执行宿主崩溃后的清理，未证明 Graph worker 已停或整张图可接管。

## Kimi K3 审查

__AUDIT__

首轮三项信息级意见的处理：跨进程、真实 daemon 路径已在专用环境实际运行；并发 stop 不作请求合并，竞争者可能得到保守错误，调用方不得将它转为释放授权。该竞争窗口仍应随 G15 集成补测。受控 API 的“删除已生效但返回 500”用于模拟丢失 ACK；既有真实 post-delete 崩溃探针也在本轮 Loop 复跑。

## 剩余工作

1. 独立确认原 Graph worker 退出。持久 parent-observed exit 可作为一个候选证明来源；缺失退出观察、PID 不存在或 lease 过期均不补造证明。
2. 枚举该 run 所有 held admissions，并分类证明执行器停止。当前 helper 仅覆盖精确的一项 contained tests，opaque writer/reviewer 仍 unknown。
3. 接入 G15 `verifyQuiescence` / `verifyOutcome` / 最终事务 `recheck`。只有完整可信业务 envelope 才能证明 tests pass/fail；日志删除回执没有业务判定能力。
4. 对账后精确释放物理资源，再完成 admission release，最后才允许 takeover；补 artifact 锁恢复及 F01–F12 剩余子窗口。

本轮没有数据库 migration、公开 RPC/CLI 自动恢复入口，也没有生产部署。原 checkout 仅镜像任务文档，用户 AGENTS.md 和其他改动保持原样。

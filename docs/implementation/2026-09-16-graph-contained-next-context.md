# G25 接续：将受控容器停止证据接到 Graph 对账

G00–G24 已完成，**25/30；G25 in_progress**，G26–G29未开始。报告：[受控执行器验收](../reports/graph-contained-executor-validation.md)。

## 工作区与协作

继续在 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation` / `codex/graph-runtime-foundation` 实施。原 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack` 仅同步本任务文档；保留 AGENTS.md 等用户改动。源码和文档仅本地提交，不自动合并、推送、部署。

用户最新模型偏好为真实 **Kimi K3**，用 `KimiCodeAdapter` 和 no-tool review profile；记录 runtime_identity reported model。继续使用真实 OSStack Loop 验收，独立 OSSTACK_HOME / state、新 taskId、sources=[]、skipCompletedTasks=false。开发CLI绝不能打开默认或保留控制面DB。

## 已实现

`@osstack/agents` 的延迟加载 `createContainedCommandExecutor` 与 `createContainedCommandAdapter`。仅显式host注册；固定imageID/command/binding digest、私有本地journal、明确Docker Unixsocket/daemonID和同步权限。无宿主挂载/网络/默认adapter注册。命令作用域是镜像内部，不是当前候选workspace。

一次性 mkdir＋fsync消费invocation；launch/stop记录使用临时文件fsync与hard-link不可覆盖发布。独立host只在完整ID/config匹配、DELETE204、同daemon404及持久receipt后证明stopped。缺少记录或回执始终unknown。能阻止暂停旧host的迟到start，独立PIDsession后代仍受容器namespace约束。

已有18个单元测试及6项真实Linux容器进程实验，另有实际Docker daemon重启实验。**尚未实现Graph worker停止、动作对账、资源释放或G15接管的整条容器恢复链。**

源码 `8d16b37be20187624fafd7bcc275329dc70bea98`。真实 OSStack Loop `G25-contained-executor-acceptance-1`：executed=1、skipped=0、outcome=success；22个包、3,307测试全部通过，8项verifier全部通过。固定seed矩阵共420次测试执行，seed250917/250918，源码与dist前后哈希一致。另有6项真实Linux容器检查全部通过；18项单元测试已纳入矩阵。 最终实际Kimi K3源码复审approved；证据见[机器验收](graph-contained-executor-evidence/admission.json)。

## 下一步

1. 设计GraphRegisteredAction中的显式受控测试执行路径，绑定candidate内容、image digest、effectKey、generation、invocation以及持久containerID；不要复用任意模型提供的身份。
2. 新supervisor先证明graph worker的真实停止；再从已持久准入枚举所有执行器。将container removal receipt用于物理停止证据，业务outcome必须单独核实；仅停止不自动宣称测试成功或可重试。
3. 接入G15 effect对账与精确资源释放，再允许takeover。保留当前opaque adapter unknown/held和公开generic resume拒绝。
4. 回执缺失的created orphan/removal窗口目前故意不可自动恢复；新增管理路径时需要可信intent、精确ID、独占防重与当前授权，不能按label或年龄直接删除。
5. artifact锁管理恢复及完整F01–F12计数；然后完成G25，进入G26–G29。

真实测试脚本 `scripts/verify-contained-executor.mjs CONFIG_JSON OUTPUT_JSON` 必须显式隔离home；配置提供socketPath、daemonId、imageId。脚本不创建VM/拉镜像，不使用默认context，只清理由其测试记录的完整容器ID。此前创建的专用VM profile仅用于本任务；不得操作其他profile。本轮验收后该profile已停止，测试容器清零，默认context保持原值；显式复跑需先启动本任务profile并重新核验daemonID。

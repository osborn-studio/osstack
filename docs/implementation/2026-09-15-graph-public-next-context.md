# G22–G24 接续上下文：G25 / 故障与并发验收

G22–G24 与 C7 本地限定验收通过，**25/30**，源码 `7da1be9ef70770bbdea5c52f6453764f6b4ba317`。见 [完成报告](2026-09-15-graph-public-completion.md)与[准入证据](graph-public-evidence/admission.json)。下一批 G25；G25–G29 均未完成。

## 工作区与下一批

实施工作区 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`，分支 `codex/graph-runtime-foundation`。原 checkout `/Volumes/AIMATE_WORK/Developer/CodeX/osstack` 仅镜像拥有的文档；保留其用户 AGENTS 和其他改动。开发 CLI 一律显式设置独立 OSSTACK_HOME 与 TMPDIR，禁止打开默认/保留服务数据库。不要合并、推送或部署，除非用户随后授权。

G22–G24 的本批范围是用户入口与外部委托契约；G25 故障矩阵、G26 兼容回滚、G27 发行、G28 性能和 G29 真实内部试点仍需实施。下一轮先核对 HEAD、任务清单和本批证据，从 G25 开始。不能把确定性 fake model 测试当作真实 provider 内部试点。

## 已接入的用户面

CLI：`graph validate --spec FILE` 纯编译；`run/cancel/resume --request FILE`；`status/result --run ID --scope FILE`；各支持 `--json`，explain 保留。bin 延迟加载入口，rpc 沿用本地 daemon socket。发送前错误/明确拒绝 exit1；网络中断或无效/不匹配 mutation 回包 exit2 + delivery_unknown + 原 scope/key/inputDigest；不得换新 key 自动再投。

GraphRpcService 通过实际连接的可信 resolver 得到 registration ID，scope/product/registry refs 必须匹配。默认本地入口加载 OSSTACK_HOME/graph-host.json，要求 owner-only 文件与 socket；配置绑定 scope、仓库、task、adapter、命令，grant 单独可续期。模拟 OSBot/OStag fixture 不代表生产远程身份认证；没有 resolver 的远程身份不得回退到 local owner。

持久准入：GraphRunStore 的原 scope/key/digest 注册和迁移33的 graph_public_delivery descriptor 同事务完成，再 setImmediate 构造一次性 GraphDelivery。descriptor 不可修改。重投/新 service 读取原 run，不盲目 launch；缺 descriptor 的旧内部 run 不能经新入口接管。进程内 live map 只持有 supervisor，状态和结果从 DB 读取。ready 与候选/join 引用同事务发布。

GraphDelegationStatus v1 保留 scope/source/parentRunId/inputDigest/specHash、状态/阶段、revision/generation、创建时间、候选和 evidence/result 引用、账本预算。token 总数是十进制字符串。JSON Schema 与 Zod 同时要求 ready 的候选/质量证据，以及 uncertain 状态的 delivery_unknown。只交付 artifact，不 merge/push/deploy，不自动完成 task FSM。

## 取消、恢复与真实边界

先持久 cancel_pending，再走实际 worker/G04 executor 停止和 G15。preworker generation0 可无副作用终止；运行中的效果必须有独立停止与无 held/unresolved 证明。取消执行授权过期的工作使用当前 cancel 授权；停止证据结算不得要求重新给予 execute。review/tests 已确认取消记录非重试失败，无通过质量结果；未知停止仍 held。不能把 late abort 简化为“此前已完成质量都无效”，这一过宽修改在组合回归中已撤回。

公共 driver 在需要下一 repair epoch 的负向质量 join 暂停。resume 绑定准确 interruptId、expectedRevision、原 inputDigest、scope 和当前 grant，校验持久 checkpoint/join 与同一 supervisor 的真实 stop，再 G15 换代继续。原 createdAt、deadline、预算不重置。正向 join 直接 ready。

**尚未支持新 daemon 自动恢复执行。** 新 service 可查询/重投原状态，但没有 live supervisor 时 resume 返回 ACTION_OUTCOME_UNKNOWN；不得把旧回执中的 stopped:true 当作现在的物理证明。waiting 的原 lease 当前最多五分钟，过期在确认请求前返回 GRANT_EXPIRED。G25 需实现/验证独立进程身份与停止证明，不能新建预算或绕过原 fence。

## 两个必须保留的修复

源仓库策略始终来自可信 repositoryPath/policyRoot，与 clone 的物理 workspacePath 分开。daemon 注入 async policy callback，broker 在实际调用前（包括 availability/identity await 后）再次校验；候选自己的策略只能增加限制。原策略未跟踪或比 base 更新也必须生效。

bounded stop 只返回观察，**不是 DB 生命周期屏障**。GraphRuntime 跟踪 action 和 checkpoint Promise，close 后 drainDatabaseUsers 等实际数据库使用者退出。GraphRpcService.close 幂等地在 finally 等 driver 和 DB 使用者；daemon 关闭 SQLite 前也等待实验 runtime 的 barrier。无限挂起 I/O 可拖延优雅关闭，不能用15秒超时假装已退出。未知外部效果即使 Promise 排空仍不释放 hold。

## G25 建议从哪些真实窗口开始

按原计划 F01–F12，使用真实 Functional/SQLite/worker/adapter 生命周期，不用 stub 状态充数。优先：持久 submit 已提交但构造前 daemon 崩溃；已消费 generation 启动权但注册/launch 出错；物理 worker/executor 未观察退出的 daemon 崩溃；PID/PGID 重用与启动标识；artifact 临时锁残留；撤权和 cancel 与晚到 persistence/release 的竞态。保留逻辑 join、调用重入、确认效果三种计数。

现有回归：graph-rpc、graph-delegation.integration、graph-review-findings、graph-shutdown、graph-chain 的数据库 barrier，以及 G21 全部测试。新 daemon 的安全恢复必须重建 immutable receipts/candidate/checkpoints/registry/workspace 映射，并经 G15；仅加 CLI resume 分支或当前租约重写都不满足要求。

## 协作纪律

仍用真实 OSStack Loop，sources:[]、显式 inputTasks、skipCompletedTasks:false、新 taskId/state/home，核对 executed/skipped/outcome。Claude Fable 5.1 本批实际尝试被额度限制阻止；保留原始响应，不能写成 Claude 通过。独立 Codex Loop 初审要求修改，复审检查源码和回归修复；最终验收须独立运行。源码冻结后再启动完整验收，避免 Vitest 缓存旧模块却读取新测试的混合状态。

## 用户更新：协作模型选择

用户授权在 Fable 5.1 额度耗尽后使用 Opus 5.5 或更好的模型。后续优先核实实际模型标识与访问权限，不再将 Fable 5.1 可用作为协作前提。实际 CLI 探测 `--model claude-opus-5-5` 返回模型不存在或无访问权限；`--model opus` 成功，但响应 modelUsage 的主要模型为 `claude-opus-5`，不能称为 Opus 5.5，也不能假定它满足“5.5 或更好”的要求。此次仅作连通性探测，未新增 Claude 代码审查或签核；C7 的既有审查结论保持不变。原始探测响应在 `graph-public-evidence/model-availability.json`。

# Firstmate 剩余扩展实施方案：可见 worker、远程 home、承诺账本与版本收敛

## 证据与交付口径

本方案在 2026-10-23 读取 `/Users/osborn/Developer/CodeX/.worktrees/osstack/pr237-main` 的 PR #237 整合源码；主线程正在修复 admission，本文不修改源码，不代表该修复已经验收。依据为 `docs/reports/2026-10-24-firstmate-capability-status.md`、原研究报告、原详细设计 §12/§16、原实施计划 Future 条目及下面列出的实际实现。

24 项研究能力不是 24 个必须照搬的产品模块。对 #16/#17/#22/#24 采用可验收的最小切片，再递进到完整能力；#15/#18/#23 补足扩展需要的协商、来源与发布约束。完成离线协议、只读盘点或本地账本，不应记为真实远程执行、外部消息送达或多 home 更新完成。

本轮可立即并行开发 V1、P1、U1、O1 的实现和测试，R1 的协议及双进程试验也可独立开发。实际远程服务器、发布仓库及公共消息目的地尚未在本轮指定；在这些配置缺失时继续完成程序、隔离环境验证与操作说明，明确“待真实环境资格”，不伪造端到端成功。

## 已存在的能力，避免重复建设

| 能力 | 已验证代码锚点 | 可复用内容 / 不能推出的结论 |
|---|---|---|
| 真正执行身份 | `packages/agents/src/base.ts` 的 `AgentRuntimeIdentity`、`AgentAdapter.confirmStopped` | 运行身份含 configured/reported/inferred 证据等级；取消请求和迭代器结束不等于真实停止。 |
| 会话观察 | `packages/agents/src/session.ts` 的 `AgentSessionDescriptorSchema`、`AgentSessionCapabilitiesSchema`；`packages/core/src/state/sessions.ts` 的 `SessionRepository.latestSnapshot` | 会话 ID、turn、version、native ID、resume/snapshot 支持；没有通用终端句柄。 |
| 会话 RPC | `packages/cli/src/daemon.ts` 的 `session.list/status/snapshot` 和 `task.cancel`；`packages/cli/src/session-command.ts` 的 `handleSessionCommand` | 现有取消入口是 `task.cancel` 按 run ID；不要设计成调用不存在的 `session.cancel`。需统一视图时再加受版本约束的专用 façade。 |
| Graph worker | `packages/protocol/src/graph-worker.ts` 的 `GraphWorkerBinding`、`WorkerFrameDecoder`、`WorkerFramedTransport`；`packages/cli/src/graph-worker-manager.ts` 的 `GraphWorkerManager`、`GraphWorkerHandle.logs/cancel/stop/finalExit` | 已有 scope、generation、owner、程序/input digest、有限日志和退出证据。不需要再造 worker 执行器。进程内日志不是持久 log service。 |
| Graph 控制 | `packages/cli/src/graph-rpc.ts` 的 `GraphRpcService.handle/status`、`GraphHostRegistration.authorize/resolveCaller`；`graph-worker-exit-proof.ts` 的两个 verify 函数 | 连接身份来自 host 注册，不信任请求 JSON 自报身份；取消后 pending/reconciliation 与物理退出区分。Graph 的 artifact_only 不等于 GitHub 发布。 |
| 本地通知 | `packages/core/src/state/attention-experience.ts` 的 `AttentionExperience.enqueue/brief/seen`；`packages/cli/src/attention-local-delivery.ts` 的 `localAttentionSender` | local spool 通过 delivery ID 原子去重，不能据此声称有人收到公开消息。 |
| 原自治通知 | `packages/core/src/state/notification-outbox.ts` 的 `enqueueAutonomyNotification/recordNotificationAttempt`；`packages/cli/src/autonomy-notification.ts` 的 `drainAutonomyNotifications` | 有有限重试、退避、死信；发送超时会重试，不能直接复用为不支持幂等的公共发帖 transport。 |
| 发布与批准 | `packages/autonomy/src/approval.ts` 的 `scopedApprovalDigest/verifyScopedApprovalDecision`；`engine.ts` 的 `GuardedDeliveryEngine`；`packages/github/src/delivery.ts` 的 `deliverToGitHub/observeCurrentGreenCandidate` | 已有 head、scope、独立评审和保护规则观察；不能新建“监督批准”绕过它。 |
| Contract | `packages/supervisor/src/attention-planning.ts` 的 `deliveryContract/promoteScout/verifyDeliveryContract` | 当前只有 completion 等字段、离线证据一致性校验；未实现设计文档所写独立 publication/merge_authority 轴。contract digest 不是授权。 |
| 升级 | `packages/cli/src/upgrade.ts` 的 `resolveDeployedHome/alignEnvWithDeployment/stopDaemon/waitForDaemon/handleUpgradeCommand` | 已对单个部署执行 drain、安装、重启、版本核实；checkout 部署拒绝套用 npm 更新。没有多 home 协调器。 |
| 升级门禁 | `packages/cli/src/graph-upgrade-guard.ts` 的 `graphUpgradeHolds/assertGraphUpgradeSafe`；`control-plane-guard.ts` 的 `assertServeAllowed/assertDbAccessAllowed` | Graph 活跃/未知执行阻止升级；开发 checkout 不可打开默认/保留 home 自动迁移。 |

## 全局不可破坏条件

1. 身份是 home + source scope + run/session + generation/version；PID、pane 名称、文件名、目录路径、模型自报不能单独成为控制权。
2. 展示、状态读取、批准、执行、对外发送分开授权。展示后端永远不接收 shell 文本、prompt 或“发送按键来执行”的通道。
3. 断连、超时、证据缺口为 unknown；不替换到本地执行，不自动重发可能成功的外部动作，不释放未确认的 writer 占用。
4. 远程来源、公开消息和模型输出均为不可信输入。解析通过仅证明格式，不证明 actor 或授权。
5. 增量数据库迁移只能由集成负责人在最终基线上分配编号；并行 agent 不各自占用 42。新表需要旧快照迁移、未来 schema 拒绝、失败回滚与关闭功能后保留数据验证。
6. 禁用新功能停止新动作并保留账本；回退同 schema 版本优先。已发生外部副作用后，不能回灌旧 DB 消除事实。
7. 公共导出/CLI 引入大依赖前测加载成本；协议/展示功能默认 lazy。非流式本地 RPC p95 < 10ms 是目标，需要测量，不因声明自动达标。

## V：可见 worker（能力 #16，部分 #15/#19）

### V1：单一只读 worker 视图，优先实施

用户目标：从 Attention 中看到是谁在执行、最新可证实状态、最近有限输出、对应决策、何时更新；能够准确定位真实执行器，不依赖浏览日志猜状态。

新增建议：`packages/protocol/src/worker-view.ts`，`packages/core/src/worker-view.ts`（纯投影），`packages/cli/src/worker-view-service.ts`，`worker-view-command.ts`；修改 `session-command.ts`/`attention-command.ts` 和 daemon 的 lazy 注册区。Graph 来源通过 GraphRpcService 的已认证 registration 提供，不直接把进程 map 暴露给任意 local socket 客户端。

`WorkerView v1`：`view_id`（服务端生成）；`scope`；`source {kind:session|run|graph, id, generation?, revision}`；`identity {agent_id,native_session_id?,evidence_level}`；`execution_state`（沿用源状态）；`observation {state:fresh|stale|unknown,last_observed_at,reason?}`；`wait {owner,reason,resolution_ref?}`；`output {kind:snapshot|log_tail|unavailable,cursor?,truncated,entries[]}`；`controls {cancel:unsupported|requestable, resume:unsupported|separate_authorization}`。字段最大长度、数量和输出字节上限必须写入 Zod schema。首期最多 50 条记录/页、单 worker 输出最多 64 KiB；超限显示截断与游标，不悄悄省略来源完整性。

接口 `worker.list(scope,cursor,limit)`、`worker.inspect(view_id,expected_source?)` 只读；首期直接展示 existing snapshots，不承诺所有 adapter 完整日志。既有 GraphHandle.logs 为内存 tail，重启后显示 unavailable，不假装有历史。若要持久日志，独立 V2 做服务端受限 spool，只使用生成的 resource ID，不接受任意文件路径。

取消先链接现有 task.cancel/graph.cancel 的受控操作流程。若新增 `worker.cancel`，请求必须有 view/source revision、幂等 key 和 authenticated scope，服务端重读绑定后调用现有执行器，返回 requested / unconfirmed / stopped；UI 不把 requested 标绿为“停止成功”。避免新 façade 降低 Graph 已有授权强度。

验收：两个 scope 同名 native session 不串读；旧 generation 视图不能取消新 worker；输出含终端 ANSI/OSC 链接和控制字节以纯文本处理；无输出不会推导 dead；取消不支持时明确 unsupported；worker 退出后 tail 仍标来源与时间；进程 map 丢失后 unknown；100 worker 分页和超长输出不阻塞 daemon；只读命令不启动 daemon、不迁移 DB。

### V2：展示后端接口与第一个本地 viewer

新增 `PresentationBackend`：`capabilities(): {view,focus,archive}`、`open(binding,viewRef)`、`focus(handle)`、`closeView(handle)`；明确 `closeView` 只关视图，绝不 stop/archive task。这里的 archive 若会删除日志必须另有明确保留策略和审批，不能放入通用默认接口。

先实现 terminal text viewer（现有 CLI/TUI）；再可选 tmux viewer，启动的是固定 `osstack worker tail --view-id ...` 命令，参数数组传入且不拼接 shell。pane 存 view token，仅 view 权限；即使 pane 被用户复用，也只撤销/重建展示，不控制原 worker。cmux/herdr/Zellij 不一次全实现，每后端需要版本/OS 资格。现阶段不依赖桌面 App 私有会话协议。

验收：pane 重命名、复用 ID、用户关闭 pane、断终端、无 tmux、版本未知、输出 flood；任一展示异常不影响任务。展示插件不能升级执行权限。回退关闭 viewer 注册，保留 worker 身份和原控制面。

PR 拆分：V1a schema + 纯投影 + fixtures；V1b 真实 Session/Graph 服务接线 + CLI/TUI + scoped tests；V2a tail spool（确有需求时）；V2b 一个 opt-in backend。只有 V1b 可说“可见 worker 首个可用版本”，V1a 仅基础。

## P：显式发布范围（能力 #23，协同 contract 集成工作）

### P1：把发布范围加入真实交付边界

与负责 S3 contract 集成的 agent 协商同一 contract owner，避免同时改 `attention-planning.ts`。建议 contract v2 新增可选 `publication_scope {hostname,repository,base_ref,head_ref,head_sha,mode:none|draft_pr|review_pr}` 和 `merge_authority {mode:manual|existing_guarded_policy,approval_ref?}`。scout 只能 none；缺失新字段的 v1 仍可读/本地校验，但不得隐式授予 push/PR/merge。

来源 repo 用规范的 Git remote owner/repo + hostname，比对真实 origin 与 candidate ref；repo_path 只是本地定位。创建 PR 前再次解析远端、base、head；push 前持有既有 repository writer fence 并核对 head SHA；重定向/仓库改名不能扩权。固定 digest 应绑定 scope，scout promotion 生成新 contract 后重新评估 scope，不继承未知授权。

修改点：`packages/supervisor/src/attention-planning.ts` 的 contract schema/digest、`packages/autonomy/src/engine.ts` guarded delivery 入口、`packages/github/src/delivery.ts` `pushCandidate/createPullRequest/deliverToGitHub` 的 input 和效果前校验。由现有 `verifyScopedApprovalDecision` 验证审批的 scope/head/diff/risk 等要求，不能接受自造 approval JSON 或 `reviewed:true` 代替。

失败返回 `publication_scope_mismatch`、`approval_required`、`candidate_changed`、`protection_not_satisfied` 等稳定原因；保留本地产物。完成级别明确 local_verified / pr_opened / ready_for_review / merged / deployed，不能 PR 创建即视为 merged，不能机器审计替代 GitHub last push approval。

对抗验收：fork origin 指向别库；Git config 改写后 URL 不同；旧 head 的审批；base 在等待 CI 时移动；review_pr 缺批准；未列出的 `--admin`/强推行为；Graph artifact_only 被普通 contract 指示发布；历史同 key PR 恢复只读取同一 repo/head；组织保护规则不可读取时 fail closed。真实远程验收用专用 sandbox repo，不在用户业务 PR 上测试 merge。

回退关闭 v2 publication，恢复本地 verified 输出；现有 PR 和发布回执保留。PR P1a contract schema + parser兼容（与主集成 owner 合并）；P1b 效果边界校验 + GitHub mock adversarial tests；P1c sandbox end-to-end 记录。不要新增第二套发布引擎。

## U：显式 home 盘点与版本收敛（能力 #24）

### U1：只读版本盘点，可独立实施

新增 `packages/cli/src/home-inventory.ts` 和命令 `osstack homes inspect --manifest <file> --json`。manifest 只含操作者显式登记的 home ID、固定 socket ref、部署类型 npm/checkout、期望 version/protocol/构建 digest（可选）、enable 标记。不得自动遍历用户目录猜 home；不得读保留 home DB 来“顺便”查 schema，优先向现有 daemon `version`/`health` 读取已服务信息。未响应显示 unreachable/unknown。

现有 `version` RPC 仅有 version/phase/protocol；新增 `deployment.identity` 只读接口返回 home_id、daemon_owner_generation、version、protocol、schema_version、build digest evidence、启动时间、部署角色（不暴露环境变量/令牌）。home_id 首次初始化只能由已授权 daemon 启动流程创建；registry 不能把陌生 socket 自报 ID 自动 pin 为可信。第一版对本地同 UID endpoint 绑定 manifest canonical socket + returned ID，明确此信任边界，不宣传网络认证。

数据输出同时列 desired / observed / observed_at / status，版本同号但 build 不同为 drift。输出实际服务版本，不使用本地 package.json 代替。每个 home 超时<=3s、并发<=4、max homes 32（可以后续实测调整），一个离线不阻塞其它项，返回完整部分失败摘要。

验收：shell OSSTACK_HOME 与部署 home 不同；同路径 symlink；registry 重复 home ID/socket；同版本不同 digest；过期 observation；daemon 更换 generation；未声明版本字段旧 daemon；坏 JSON/超大响应。只读盘点不能调用 npm、launchctl、openDb、写 role file。

### U2：协调现有 updater，不另造 updater

需 U1 + R1 身份（若跨主机）+现有 upgrade 故障资格。`upgrade plan` 产生不可变 plan digest，包含目标精确版本、home ID、当前身份、schema兼容、部署类型、健康要求和顺序；`apply` 只调用对应 home 的现有受控 updater。npm-global 二进制被多个 home 共享时必须归为一个 deployment group，先全部 drain，任何 home 状态 unknown 即暂停该组，不能先更新共享包破坏另一 home。

更新状态机 planned -> draining -> quiescent -> installed -> restarting -> verified；失败分 aborted_before_install / restart_failed / version_mismatch / recovery_required。每步保存 journal，重启先对账，不盲目重复安装。操作者批准的 plan digest、有效期和精确目标绑定；旧计划或 identity变化要求重新 plan。维护窗口本身不授予 publish 权。

复用 `upgrade.ts` 的 resolveDeployedHome/alignEnvWithDeployment/stopDaemon/waitForDaemon；需要抽出可注入端口以支持本地假 updater 与测试，而不是执行机器全局 npm 安装。现有 hardcoded launchd label 是多实例约束，先明确仅单组单部署；多实例服务管理器作为单独支持项。

升级前要求所有 shared binary consumers 已知、daemon drain 达成、Graph 持久 hold 为 0、会话未知动作处理明确；timeout 不是停止证据。备份是停止后的一致快照；downgrade 不意味着恢复旧数据库，schema不兼容则拒绝启动并保留新事实。回退优先同 schema 的功能关闭/上一兼容二进制。

验收：第二 home drain 卡住第一 home 不安装；upgrade进程在每步 kill 后重启；两个操作者执行同 plan；registry漏列共享安装 consumer（无法证明完整即只生成计划、不apply）；checkout不走npm；新daemon版本正确但identity错；安装成功后回执丢失；旧DB存在外部副作用不能回滚数据。PR U1只读盘点，U2a计划/journal，U2b单组executor，U2c真实双home资格。U1不可声称“已自动多home收敛”。

## O：对外承诺与 follow-up（能力 #22）

### O1：本地 obligation 账本，可独立实施

目标是持久记录“答应谁、在何条件/截止前回复什么”，不把本地 notification 当已送达。首期生成待发送草稿与证据摘要，不向外界自动发送。

新增 `packages/protocol/src/follow-up.ts`、`packages/core/src/state/follow-up-obligations.ts`、CLI `follow-up list/create/draft/resolve` 与 Attention 增量视图。表建议 `follow_up_obligations`：id、scope、source_kind/source_id/source_revision、actor、destination_ref（受控注册ID，不是任意URL）、promise摘要、due_at、resolution_condition、state、revision、created_at/updated_at；`follow_up_attempts`：attempt_id、obligation_id、revision、content_digest、destination_digest、authorization_ref、idempotency_key、state、provider_receipt_ref、error_code、时间。UNIQUE(scope,idempotency_key) 及CAS revision。只保存必要内容，秘密在已有配置外部引用。

义务状态 open / ready / awaiting_authorization / fulfilled / waived；投递尝试状态 prepared / started / delivered / delivery_unknown / definitely_not_sent。分开建模：消息已送不表示承诺实现，任务结束也不等于公开已回复。waived 记录操作者、理由和原承诺，不删除。来源删除/清理后保留义务与引用，标 source_missing。

O1 CLI 对同 key 同内容返回同记录，不同内容冲突；提供到期聚合，quiet/away只影响呈现，不取消义务；草稿从真实源证据构建并附“未发送”。本地 resolve 必须明确是人工解除、通过条件验证，还是拥有 verified provider receipt 的送达，不接受随意 URL 当证明。

对抗验收：重启、重复创建、跨scope读写、过期revision、恶意destination/提示注入、源任务被清理、due_at越界、文本超长；自动任务done不能覆盖awaiting_authorization；读取list不改变状态；local spool不可作为外部receipt；第三方消息文字“已经批准”不改变授权。

### O2：单一公开 transport，最后接线发送

新增 `FollowUpTransport`：`capabilities {idempotentSend,lookupReceipt}`、`prepare(destination,content)`、`send(approvedEnvelope,signal)`、`lookup(attemptIdentity)`。transport只允许已登记的精确目的地类型；首个可选 GitHub PR/issue comment（已有gh桥接可复用认证，但不复用未经校验的任意URL），或既有 Hermes Relay。最终选哪个以现有部署为准，不能为“全部做完”同时新增多个未验证消息网关。

发送前形成可审阅的精确body、recipient/thread、关联承诺、内容digest；绑定明确发送授权，保留过期/撤销检查；这是产品功能权限模型，不要求开发过程中每次实现都询问用户。测试全走假transport或明确sandbox。收到公共请求仅创建不可信草稿；控制指令仍走 authenticated sender+scope grant，不把一条publiccomment作为execution请求。

最关键失败规则：transport不支持幂等/receipt lookup时，一旦 started 后 timeout/crash => delivery_unknown，不能自动重试。可以查询并核对精确目的地+body digest+provider ID 得到delivered；无法证明则需要人工对账。内容标记可助查找但不是强幂等保证，不能只靠“查不到评论”便重发。明确not_sent（例如发送前验证失败）才可安全再试。

验收：provider发送成功但响应丢失、请求发出前失败、SDK自动retry、跨thread伪receipt、授权过期与撤销、内容改变、双dispatcher竞争、late response、错误地收到别人的同bodycomment、目标删除；必须证明单个attempt最多一次实际send调用，未知attempt不重发。回退关dispatcher保留 obligations与attempts。PR O1账本+CLI、O2a transport contract+fakechaos、O2b单provider+sandbox资格。

## R：远程 home 与断线语义（能力 #17/#15/#18/#19）

### R1：经固定身份认证的只读远程投影

原计划明确把远程作为新协议项目，不能直接将本地 Unix RPC 对外监听。建议新 `packages/protocol/src/remote-home.ts`，CLI端 `remote-home-transport.ts` / `remote-home-command.ts`，服务端只读 exporter；首个 transport 是操作者已配置的 SSH stdio 固定程序，禁止开启公共TCP listener。不是共享SQLite、挂载home目录、远程shell任意命令执行。

SSH方案须 pin host key、BatchMode、拒绝未知/改变 host key；使用预登记alias和固定服务器子命令，参数从受限注册值构建，防 `-oProxyCommand` /shell injection。SSH认证的host identity与OSStack home identity分别校验，登录成功不等于接入了正确home。禁止失败后 fallback localhost/default home。

握手请求含 protocol range、client identity、nonce、requested scope、只读 capability。响应含 home_id、instance/generation、schema/protocol、supported methods、nonce回显、最大frame/页限、session-bound capability，绑定SSH通道。客户端验证预先登记的home_id和key pin；nonce回显只防误绑，不宣传为独立密码认证。控制权授予不由响应的布尔字段决定。

`RemoteObservation`：home_id/source_scope/source_id/source_generation/source_revision、observed_at、received_at、event_cursor、freshness、evidence_hash。网络wallclock不可信，以本地monotonic接收时间判stale。重连相同home但generation变更，先全量同步再接受增量；cursor不连续=>gap/unknown并请求快照；旧generation事件不写入新投影。首期仅 status/decision metadata，日志正文和私密路径默认不传；明确 redaction 配置。

复用 `WorkerFrameDecoder` 的有限帧理念，可提取无Graph依赖通用framing但不要改变原Graph 8MiB限制/既有协议；remote默认单帧64KiB，snapshot分页<=50，max在途8、写缓冲和超时固定。exporter只接受严格method allowlist，不能把任意RPC method透传；server身份来自连接层注册，不来自request actor。

验收：hostkey替换/home ID错误/nonce错/protocol不兼容；SSH成功但返回shellbanner；frame oversize/碎片/背压；旧generation replay/乱序/gap/clockskew；断网无法确认远程任务是否活着=>unknown且本地adapter从未invoke；恶意path不能打开任意文件；只读token执行start/send/cancel均拒绝。双进程本地stdio可先验证状态机，真实远程hostkey与断网需要独立实机记录。

### R2：远程动作资格，排在 R1 后

远程执行不复用“普通读连接”隐式升级。新短期grant绑定 actor、home、repo、action集合、run/turn/generation、预算、有效期与nonce。保留远端主权：writer admission/repository lock/approval必须在真正执行的远端取得；本地观察端不能认为持有本地lock就保护远程repo。

发送动作前本地记录请求digest与idempotency key，远端以(scope,key,digest)事务reserve并返回durable receipt，结果查询绑定同home和grant。ACK丢失 => delivery_unknown，重连优先query，绝不换host重发；endpoint不支持同key强幂等时动作禁用。完成回执必须区分accepted/applied/stop_requested/stopped；adapter confirmStopped仍需远端精确实例证据。远程grant过期不意味着远程进程已停止。

最小先做受绑定cancel request与receipt查询，再考虑resume/submit。真正执行需验证两地崩溃、重复请求、授权撤销与隔离；任何“fallback local”、ssh重试启动、传输断线释放repo锁都应成为审计P1/P0。远程恢复与共享repo网络文件系统另行支持矩阵，不为首版泛化。

### R3：通用来源扩展注册（能力 #18）

在 CI exact-head/Loop只读适配稳定之后新增 manifest：id、version、digest、protocol、scope绑定、methods、读取来源范围、maxBytes/maxItems、expiry、所需凭据ref。安装时显式pin digest和capabilities；启动handshake核对版本，变更digest停用待重新登记。manifest是声明，不是授权；代码执行能力取决于受限runner和hostgrant。

优先数据型provider，不运行任意download脚本。事件签名/序号与snapshot一致性各有记录；未知事件不当completion。扩展接线不能使source插件绕过原source ledger写session/approve/publish。测试pin错/过期/扩权/注入/慢provider/大页/gap。若仅新增interfaces没有生产调用点，记“协议基础”，不记“通用扩展已实现”。

PR R1a schemas+strictparser+fake transport，R1b本地exporter+固定SSHreader，R1c双host只读资格，R2a grant/receipt/unknown状态机，R2b一个真实动作adapter+故障测试，R3a manifest data-source registry（可以在R1后与R2并行）。回退只禁用连接/新动作，保留远端identity和未知receipt供对账。

## 开发编排与验收清单

建议主线程保持 PR237 测试与审计收口；随后最多 3 个并发实现agent（4总槽包含主线程）。第一波：worker视图 V1、home盘点 U1、本地obligation O1；P1由contract集成owner负责，不单独抢同文件。第二波在对应第一波合入统一集成分支后继续 V2、O2、R1；U2需有U1证据，R2需R1身份与故障语义先成立。不是同时让多个agent修改daemon、migrations、protocol index。

每个agent独立 worktree 在 `~/Developer/CodeX/.worktrees/osstack/<task>`；使用对应 `codex/` 分支；显式scratch OSSTACK_HOME，临时输出全部放OSSTACK_SCRATCH_ROOT。主线程集中整合 daemon路由、index exports、migration编号、schemas/inventory产物与changeset。已有用户主checkout的107项改动保持不动。

每个PR要求：真实用户入口+失败行为+最少一条端到端隔离测试+关键对抗测试+类型检查+关联package测试；公共接口增加conformance/schema检查；全部整合后一次完整 build/typecheck/test/lint/schema/inventory/startup预算验证。自测不要调用默认home、真实消息发送或全局upgrader。

Claude Code CLI Haiku 5.5 可用于各PR挑战：固定源manifest及diff、明确本切片未宣称的能力、提供失败注入测试与运行日志；提示其重点寻找scope越权、identity混淆、重复副作用、unknown降格、假停止证据、假发布证据。保存请求模型、CLI实际报告、raw stdout/stderr、上下文hash和逐条处置。工具成功退出≠审计通过；空泛/损坏输出不计轮次。静态审计不替代真实跨host/终端/消息投递资格，也不能代替GitHub保护要求的独立人类审批。

验收矩阵必须逐行记录 implemented / tested-local / qualified-real / enabled，标明版本、OS、transport、fixture或真实环境。最终能力状态只按真实交付提升：V1可把#16从未实施提升为部分；R1只读把#17提升为部分；O1仅本地承诺账本把#22提升为部分；U1盘点使#24部分。完整端到端资格之后再考虑“实现”，不能用一个新文件或测试数量把四项直接标满。

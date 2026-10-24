# Firstmate 24 项能力代码收口与交付账本

日期：2026-10-24。基线为 PR #243 的 `1c343aad`，依赖 #237–243。本文区分生产入口、实际本地验证、独立审计、真实环境资格与合并部署，不用单一“完成百分比”混淆它们。

原 24 项映射沿用 `2026-10-23-firstmate-analysis.md`。本轮任务分解见 `docs/plans/2026-10-24-firstmate-code-completion.md`。旧交付账本保留历史，不作为新增代码的最终状态。

| 原编号 | 能力 | 本轮收口及执行路径 | 范围与限制 |
|---|---|---|---|
|1|单一用户联络入口|沿用 Cockpit/Web/TUI 与 daily 的同范围监督摘要，补充可发现的 scout、worker、source、remote、home 操作入口|不同操作仍通过自身授权；没有新增全权主 Agent |
|2|执行状态语义|保留 busy/idle/unknown/业务等待分离；补活跃 Graph 与真实子进程观察资格|快照不证明进程存活；取消请求不等于已停止 |
|3|旧实例隔离|沿用 owner generation，新增 source generation 隔离、远程目标/Graph generation 绑定、managed upgrade 运行身份校验|跨真实 SSH/provider 仍须实机资格 |
|4|等待责任与解除|沿用持久等待来源与明确解除条件；source gap/remote unknown/upgrade unknown 不自动清除|提示、模型建议、提醒、窗口状态都不产生审批 |
|5|事件驱动监督|来源 sequence/gap/事件读账本，活跃混合监督性能与生命周期验证|有界逐源观察，不是跨源全局原子事务 |
|6|回合结束检查|沿用已验证 Claude Stop nonce/handoff；补停止/重启/迟到事件资格|既有单 harness 范围；不承诺所有终止方式都会触发hook |
|7|主会话与监督分工|受限无工具 provider 保留，真实 paired evaluation 入口接入|模型运行需要受支持凭据；无自动回答/改策略 |
|8|决定持久化与绑定|沿用原 decision/approval 权威账本与 Attention 投影；新来源事件不创建决定身份|不会把外部文字变成批准 |
|9|回答幂等/未知投递|沿用 Session 幂等，补公开交付与远程取消的独立 durable attempt/receipt|未知操作只查询，不重放副作用 |
|10|低打扰/离开|沿用通知批处理、偏好、去重与死信；观察器无执行控制|away 不扩大权限；不等于外部消息恰好一次 |
|11|增量简报|沿用 actor/scope/read position 与 daily；新增来源 metadata events 分页|跨 home 简报没有伪造全局一致性 |
|12|调查/交付分型|`scout inspect/promote`，固定 Git committed-blob 只读工具；promotion 重新绑定当前HEAD/policy并走guarded-local|调查不是LLM分析器或成功交付；未知promotion不自动重放 |
|13|交付完成标准|Graph 2–16个注册检查，各自实际command/stop证据与统一完成回执|Graph仍为 implement/local_verified/artifact_only；发布走既有guarded-git |
|14|清理前保全|延续未知worktree/receipt保留，新增远程与升级create-only恢复账本|不把删记录当作恢复；不删除用户已有WIP |
|15|能力协商|固定 source event/snapshot 协议与远程独立write控制命令、独立grant域|没有任意动态代码插件平台或请求自授权限 |
|16|可见工作进程|`worker open` 的 pinned tmux/cmux 新观察器；`worker logs --grant-file` 独立内容授权|支持有界持久assistant文本，不是任意stdout console；实际tmux/cmux资格待补 |
|17|远程home/断线unknown|`remote-home cancel/query/issue-cancel-grant` + `remote-control --stdio`；精确Graph generation/revision，丢ACK查询恢复|仅独立授权Graph取消；不新增远端start/resume/deploy，不把local child当真实SSH |
|18|外部事件扩展|宿主固定来源，migration46持久generation/sequence/gap；`sources observe/events/acknowledge`|ack需独立精确宿主授权；无通用网络事件总线 |
|19|对外状态账本|来源metadata ledger与保留缺口，投递/取消/升级各自持久回执|同一响应声明自己的原子范围；多个投影不合成虚假全局事务 |
|20|记忆预算/衰减|可信失败→修复→同检查通过→独立review生成lesson草稿；显式source-context实际prompt预算与receipt|无自动发布/晋升；source文本是数据；本地receipt不证明provider token窗口 |
|21|轻任务路由|`attention routing-eval --mode paired_holdout`，真正双模型成对调用、usage成本、置信区间与失败停机|没有凭空的准确率/节省结论；默认路由不改 |
|22|对外承诺持久化|生产GitHub adapter、固定host registry、交互issuer、一次性授权消费、immutable subjectId发布与精确receipt查找|开发未向真实GitHub发消息；本地HTTP故障测试不等于外部sandbox资格 |
|23|自仓库发布边界|沿用guarded-git V2审批/目标/head校验，Graph多检查补完整完成证据，公开通知用独立grant|没有自动merge/deploy；没有把任意旧入口都宣称改为V2 |
|24|多home自更新|managed bundle provision/apply/reconcile、真实本地进程/SQLite/原生锁、双阶段恢复与实际版本验证|生产launchd/用户home未改；禁止DB回滚；旧版不理解marker的外部binary无法被追溯改造 |

## 外部资格单列

1. 真实模型：受支持API凭据、经独立复核的holdout数据、实际usage/计费核对、真实provider终止行为；没有这些就不宣称模型更准或更便宜。
2. 指定静态审计：重新登录后，Claude Code CLI 已实际执行 Haiku5.5 分范围审计并返回非零 usage；问题已修复，各范围复审通过。最终验证器代码与证据由 r9/r10 收口，详见[最终审计报告](2026-10-25-firstmate-final-audit.md)。历史 OAuth 失败记录保留，不计为通过。模型字符串与 `unrecognized_model` 诊断均保留，不声称权重证明。
3. 真实公共GitHub：专用sandbox目标、固定actor/node身份、真实send/lookup、网络中断和权限变更；本次未发送真实公开消息。
4. 真实SSH：远端安装/forced command、host key变更、双机generation与断网恢复；本地child/socket/SSH配置解析不替代跨机测试。
5. 真实tmux/cmux：本机未安装，需固定版本窗口/socket/关闭行为；launch_requested不是已看到窗口。
6. 真实launchd与多home：安装级完整consumer清单、实际服务停止/启动、真实bundle与运行版本核对、断电/文件系统持久性；scratch子进程SIGKILL测试不是物理断电证明。
7. 跨平台：当前本机证据不能扩张到其他OS/Node/native runtime；由CI矩阵或独立资格记录补充。

## 已完成的整合与性能检查

实际主入口、daemon socket、source/context 与 observer/log 的定向整合测试74/74通过；远程实际主入口子进程5/5通过。先前失败的三个完整测试文件在干净构建上52/52通过，失败记录仍保留，最终全量结果另列。

活跃Graph监督的连续三轮隔离测量均满足原预算：RPC p95为6.228/6.787/6.775ms（目标<10ms）；Loop开销0.671%/0.543%/0.330%（目标<1%）。实际Graph完成、独立取消子进程的停止证明、重启恢复和旧代迟到隔离均通过。最大延迟仍有561–615ms尾部，2ms调度是软时间片，不能外推为所有请求延迟保证。详见[完整性能证据](2026-10-24-firstmate-supervision-active-evidence/README.md)。

OSStack原生队列包含12个能力收口任务、独立代码QA任务，以及7个尚未执行的认证/环境资格任务。原能力任务不凭子代理报告自动标完成；审计、完整验收与外部资格分别记录。详见[任务与验证证据](2026-10-24-firstmate-completion-integration-evidence/README.md)。

## 历史完整测试基线（不是当前修复后的最终验收）

当时生产源码快照为 `af312fd7623fa27668e91a6bf8965e0dc043be1a`。最终完整运行覆盖22个包：**5,585项通过、0项失败、4项条件跳过**；构建、inventory生成、严格类型检查、完整测试、lint、协议schema、inventory新鲜度、启动预算共8个检查全部通过。OSStack任务 `firstmate-final-r2-codeqa` 的实际执行与独立verifier均为success，原始回执及每包计数见[整合证据](2026-10-24-firstmate-completion-integration-evidence/README.md)。

前一轮完整运行的7项失败均保留：6项来自只读状态入口未支持新增schema46，1项来自进程收尾fixture未等待子进程启动。已修复并重新跑过整个22包套件；没有放宽生产停止期限或断言。4项跳过分别为provider-live、native-cold、Graph性能与活跃监督资格开关。完整套件之后，native-cold两个全新checkout安装与Graph性能均单独通过；活跃监督已有单独三轮通过记录。只有provider-live仍未执行，不能把这些额外检查冒充完整套件内的通过数。

交付为[PR #244](https://github.com/osborn-studio/osstack/pull/244)，依赖#243及前序PR栈。早期因 Claude OAuth 过期保留草稿；该次 `is_error:true`、0 token 的尝试不计为审计通过。之后已恢复实际调用并完成多轮修复及分范围复审；当前交付结论以最新最终审计报告为准。CI以该PR当前HEAD的检查结果为准，本地通过不冒充CI通过。

12个能力收口任务的代码路径已逐项核对，分范围最终审计已通过；完整本地验收与当前 CI 的结果以 PR #244 正文及检查页为准。7类认证/真实环境资格任务保持独立排队、未执行状态。尚未合并或部署，不宣称24/24已在真实环境上线。

## 最终审计的授权边界与恢复范围

- 私有目录、签名与交互确认阻止普通RPC调用者和不可信来源文字制造授权，但不隔离同uid恶意进程，包括可任意读写宿主文件的模型驱动Shell。签名私钥、host registry和交互终端均处于同uid边界；registry中的qualification由操作者声明，不是代码自动验证的资格证明。生产隔离须使用独立uid、受限沙箱或独立密钥保管。
- GitHub交付状态delivery_unknown不允许重发或换idempotency key重放。精确provider receipt可使其收敛；查不到、分页不完整或超时不能证明未发送。当前无“人工确认未送达后重新授权”的产品内终态解决入口，不应修改数据库绕过。发送/预检默认5秒、只读查询默认30秒，宿主可分别配置sendTimeoutMs/lookupTimeoutMs，均硬上限30秒；兼容timeoutMs仍可统一覆盖。查询最多20页/200条，期限更长仍不保证找回。
- 实际GitHub sandbox必须覆盖CRLF、末尾空白与正文归一化，之后才可标sandbox_qualified或更高级别。精确正文比较保持fail-closed，不将marker单独视为成功；该真实环境资格尚未执行。
- 远程取消的“丢ACK查询恢复”只指stop_requested回执已经持久写入、随后ACK丢失的窗口。远端reserve后崩溃、daemon响应丢失、回执落盘失败等仍可能永久delivery_unknown。此次明确接受此有限范围，不新增query的graph.status字段或结果重写重试。操作者可通过既有只读Graph状态入口另行观察；该观察不能归因于本次请求，也不能据此重发取消或推断新grant安全。unknown/not_found回执的home/generation字段是签名请求的目标绑定，不证明当前目标已观察；observed_revision为空且physical_stop始终not_attested。
- 客户端not_sent仅表示新的本地调用在reserve/transport前预检失败，不证明远端全局状态。reserve不确定、spawn失败或之后的任何失败继续unknown。

补充恢复语义：交付inFlight仅覆盖本次有界dispatch等待与持久结算，不声称超时后provider已经停止。超时后允许独立只读lookup查询，迟到的send响应不会再次写库或重发；若发送期间撤销授权，晚到成功回执也不会覆盖撤销后的unknown，须由精确lookup回执确认。GitHub若规范化CRLF或末尾空白，真实消息可能已发布而send与lookup的精确正文比较都会失败，使该attempt永久unknown；因此正文归一化是启用真实交付前必须完成的sandbox资格。远程取消的显式daemon拒绝（包括CAS/revision冲突）、reserve后配置撤销以及不完整journal写入亦可能被保守分类为unknown，不将其伪装为成功，也不自动重发。

## 本轮审计明确保留的运行范围

- 来源观察与工作日志的请求等待各有2秒期限，未结束的底层读取继续占用原槽位，最多4个；挂起读取可使该入口持续busy，需要正常重启恢复。同步文件系统操作不具有硬实时保证，不支持把挂起的网络挂载视为可强制抢占的本地文件系统。
- 取消后来源/日志读取各有2秒关闭等待，迟到日志读取在同步DB访问前检查取消。整个daemon关闭不是2秒保证：已接纳的交付等可能写DB的任务仍须完成或确认停止，不能用读请求的超时逻辑强制关闭其数据库。底层操作不收敛时升级drain可能失败并保留恢复状态；不以伪造停止证明换取升级成功。
- 验证适配器的可用性、边界收集、前后快照和调用共用一个总期限，另有至多100ms迭代器清理等待；底层同步代码无法抢占。调用超时且停止未证实时阻止Loop继续、重启重试与工作树清理。done事件后流不结束视为未完成；未请求的judgment（包括零spec任务）保持fail-closed。
- Graph候选原始内容每次观察上限128MiB/10,000 entries；Git metadata遍历上限256MiB（stat计量）/20,000 entries。超限拒绝验证。性能测量只代表给定仓库形状，不承诺任意大小仓库都满足交互延迟。
- managed升级恢复需要保留精确原plan、registry、artifact和历史证据；缺失时不承诺自动恢复。运行包须自包含，主机目录、Node、依赖与密钥由受信任操作者控制。直接DB命令的managed环境必须与注册一致；serve配置拒绝返回78，其他主入口错误由轻量entry统一打印消息并返回1，不输出调用栈。

交付的显式provider拒绝（HTTP非成功、GraphQL errors、clientMutationId不匹配）同样保守落为delivery_unknown，不能据此绕过精确receipt条件重发。孤立started对应的in_flight响应仅表示曾记录启动，重启后须reconcile，不证明当前transport存活。远程客户端的残缺/损坏.local.json会fail-closed为invalid_remote_cancel_request（可能没有outcome字段）；若已校验远端回执但本地observed日志落盘失败，仍显示该回执并明确observation_persisted=false，已有本地reserve仍禁止重发。已有本地reserve时，远端not_found仅表示查询当时未找到journal，客户端总体保持delivery_unknown，避免把并发reserve前查询当作无副作用证明。grant文件是精确单attempt绑定的bearer能力，不宣称持有文件的进程仍会被交互确认再次隔离。

Guarded交付另固定首次execution-context配置的语义摘要、规范路径与文件身份，并存入持久routing；repair每次重新建立host context前后均核对该pin，拒绝builder改写Git忽略配置后重新固定新内容。动态来源、权限与policy仍照常重新校验，不缓存授权。旧持久run若有context路径却没有初始pin，后续本地执行保守拒绝，不推断新配置获批。

该execution-context pin约束每次host context的建立，没有完成时再核对文件的检查；完成回执不证明该配置文件从建立context到完成期间始终未变化。

Loop 的宿主 containment 记录是执行前同步持久化的待核对保护记录，不是物理停止证明。未知停止、崩溃、异常或状态写入失败都会保留记录；使用同一 canonical workspace 和宿主 containment root 重启时，在任务发现/执行前拒绝继续。即使进程已经停止，状态写入失败也可能保守阻断；任务中缺少 `implementation_unconfirmed` 字段不授权删除宿主隔离记录。目前无自动 reset，必须调查原执行并保留证据，同 workspace 换 state 路径仍会阻断；不可通过换 workspace、宿主 root 或手删记录推断安全重试。目录 fsync 失败会拒绝启动；同 uid 恶意修改不在该保护的隔离保证内。所有验证适配器都检查候选工作树的前后完整性；检测到修改或调用后无法确认完整性时，不继续重试、提交、自动清理或提取经验。验证器时间预算按单适配器计量，不代表整组验证的总时限。

宿主隔离目录按 `OSSTACK_LOOP_CONTAINMENT_ROOT`（绝对路径）、`OSSTACK_HOME/loop-containment`、`~/.osstack/loop-containment` 顺序选择，须位于候选工作区之外。Git 初始化不会改变 workspace 身份或存储位置。fsync 成功是 OS 层持久性证据，不替代物理断电资格；同 uid 修改和不同宿主 root 之间不构成安全隔离。既有 publisher 成功回调没有 descendant-stop 证明，该限制不被本轮静态审计扩展为保证。

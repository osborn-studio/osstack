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
2. 指定静态审计：Claude Code CLI请求Haiku5.5；部分轮次返回意见并修复，最终若OAuth过期则保留`is_error:true`，不能算审计通过。模型字符串与`unrecognized_model`诊断均保留，不声称权重证明。
3. 真实公共GitHub：专用sandbox目标、固定actor/node身份、真实send/lookup、网络中断和权限变更；本次未发送真实公开消息。
4. 真实SSH：远端安装/forced command、host key变更、双机generation与断网恢复；本地child/socket/SSH配置解析不替代跨机测试。
5. 真实tmux/cmux：本机未安装，需固定版本窗口/socket/关闭行为；launch_requested不是已看到窗口。
6. 真实launchd与多home：安装级完整consumer清单、实际服务停止/启动、真实bundle与运行版本核对、断电/文件系统持久性；scratch子进程SIGKILL测试不是物理断电证明。
7. 跨平台：当前本机证据不能扩张到其他OS/Node/native runtime；由CI矩阵或独立资格记录补充。

## 审计与交付状态

待最终集成核对写入：源码commit、原生OSStack任务receipt、完整测试计数、性能样本、失败处置、PR URL与CI。任何仍未达标的本地预算/代码检查必须继续列为未通过，不能转移到“真实环境缺失”。PR合并、独立批准、部署与上述本地验证是独立状态。

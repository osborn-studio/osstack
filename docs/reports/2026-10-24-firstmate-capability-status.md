# Firstmate 24 项能力的实际交付状态

这 24 项来自研究报告的能力地图，不是已经承诺全部照搬的 24 个功能，也不同于 OSStack 队列中的 26 个验证任务。当前代码在 [PR #237](https://github.com/osborn-studio/osstack/pull/237)，尚未合并和部署。以下以源码落点与已说明边界为准，不能把静态审计通过或单个验证任务成功当作生产交付。

“本地实现”表示已有代码与针对性测试；“部分”表示受限来源、独立辅助命令或复用现有能力，尚非上游等价覆盖；“未实施”表示此 PR 没有新增该能力。

| # | 研究能力 | 状态 | 实际落点与剩余工作 |
|---|---|---|---|
| 1 | 单一用户联络入口 | 部分 | `attention cockpit` 聚合 Attention 信息；原 dashboard/daily/deliver 入口未全面统一。 |
| 2 | busy/idle/unknown/dead 语义 | 部分 | `classifyAttentionWait`、`evaluateActivity` 分离业务事实、等待和活性；无法证实的进程保持 unknown，不做跨后端完整活性检测。 |
| 3 | 旧实例事件隔离 | 本地实现 | `AttentionStore` owner generation、scope/source binding 与版本校验；不接收未经绑定的旧实例写入。 |
| 4 | 等待责任与解除条件 | 本地实现 | grant、在途/未知消息、人工决定与风险审批分别处理；不能用普通回答代替签名审批。 |
| 5 | 事件驱动监督 | 部分 | 确定性 observer 每 30 秒补扫、Session 按 ordinal 补历史；run/Loop 为快照，无完整 event-seq replay。 |
| 6 | 回合结束交接检查 | 本地实现，单 harness | foreground nonce、版本绑定、handoff receipt、一次提醒；真实验证限定 Claude Code 2.1.291 Stop，取消/强退不承诺提醒。 |
| 7 | 主会话与监督分工 | 部分 | 确定性 daemon 观察，分诊 helper 无执行权限；未新增常驻独立模型监督会话。 |
| 8 | 决策持久化和来源绑定 | 本地实现 | `attention_items` 保存稳定 episode、来源 hash 与未决状态；独立投影不替代源账本。 |
| 9 | 回答幂等与未知投递 | 本地实现 | action→message、CAS、同 key 重放、未知不重发、显式 abandoned_unknown，复用原 session 执行入口。 |
| 10 | 低打扰/离开模式 | 本地实现 | attended/quiet/away 只影响通知，不改变授权。 |
| 11 | 增量返回简报 | 本地实现 | actor/scope/revision 已读位置，三条摘要与完整数量分开。 |
| 12 | 调查与交付分型 | 部分 | 离线 contract helper 支持 scout→新 implement 契约；未统一接入全部 delivery 入口。 |
| 13 | 统一交付完成标准 | 部分 | contract digest/brief/effective options 同源与校验；完整交付管线仍使用既有 verifier/autonomy。 |
| 14 | 清理前成果与决策保全 | 本地实现（本 PR 范围） | daemon 启动和 Loop cycle 停止自动删除未知 worktree；中断会话保守停止，保留未决决定与未知回执。未改造所有独立人工清理入口。 |
| 15 | 有界能力协商 | 部分 | 复用 Adapter resume 能力检查和明确来源限制；无新增通用后端协商协议。 |
| 16 | 可见工作进程 | 未实施 | 未移植 tmux/cmux/herdr 等多终端后端。 |
| 17 | 远程 home 与断线 unknown | 未实施 | 需要独立远程身份、传输和恢复协议。 |
| 18 | 外部事件扩展 | 部分 | Loop 文件只读适配、CI exact-head 信息读取；未实现通用 manifest/pin/handshake 扩展体系。 |
| 19 | 状态对外 ledger | 部分 | Attention inventory/inbox/deliveries RPC 和既有 OSStack 事件；未新增通用跨源流式账本。 |
| 20 | 记忆预算与衰减 | 部分 | 分层上下文、期限/预算检查及新 lesson draft；未自动接入记忆晋升或常驻启动加载。 |
| 21 | 轻量任务路由 | 部分 | 离线 golden 对照评估命令；无实际准确率/成本收益资格，不改变默认路由。 |
| 22 | 对外承诺持久化 | 未实施 | 本地通知 outbox 不等于公共 follow-up obligation；未接入公共消息网关。 |
| 23 | 自仓库发布边界 | 部分，沿用现有控制 | 保留主线治理与签名批准；辅助 contract 不获得发布/合并权，未另造 Firstmate 式 publication scope。 |
| 24 | 自更新/多 home 收敛 | 未新增 | 继续使用既有 upgrade/drain；未做多 home 收敛功能。 |

按上述严格口径：**8 项本地实现、12 项部分覆盖、4 项未新增/未实施**。这些数量衡量能力覆盖，不能换算成工期完成百分比。

额外已实现的支撑功能包括：启动前固定文件原子 daemon 锁、失败启动清理、全局 100 subject 容量与显式释放、本地通知去重/有限重试/死信、CLI 只读分页和隔离 home 保护。它们让已有核心能力更可靠，但不意味着远程、多终端和自动执行托管已经完成。

## 当前整合验收

PR #237 正在整合 main `d2bc09e5`。原 9 处内容冲突已处理；主线迁移 1–39 保留，Attention 改为 40–41。旧实验 Attention 25–26 home 必须保留并拒绝误迁移。当前使用隔离 worktree、Node 22、完整测试及 Claude Code CLI Haiku 5.5 重新验收。

此前报告中的 2,520 个通过测试属于旧基线与当时工作区，不作为这次整合结果。最终测试、审计处置和 PR 状态另见本次整合报告。Fable 5.1 三轮是研究设计审计；后续 Sonnet/Haiku 审计与代码实现是不同阶段。

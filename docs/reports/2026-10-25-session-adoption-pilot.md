# 等待决策 Session 采纳试点：交付与验证记录

> 历史记录：本文保留 #251 原提交的本地验证结果。原 GitHub CI 随后发现一处 drain 测试竞态；修复、拆分和最新验证见[分层交付报告](2026-10-26-pr251-split.md)。本文不表示原 CI 已通过。

此变更在 OSStack 中增加可显式启用的 Session 采纳流程。用户从 `osstack engineering` 处理既有 Session 的等待、回答、暂缓、取消和回执。后台复用既有 daemon、admission、attention action 和完成事务。

范围是 `adopt_session`，完成级别是 `observed_turn`。该证明确认本 Mission 的答案引发的回复回合已完成并持久化。它不是代码交付、测试成功或部署成功的证明。新目标自动选择 Loop / Graph、运行时加载全部 24 项能力、一般聊天前端和生产隔离仍属于后续阶段。

## 权限 P2 定案

每个 Mission RPC 都需要当前 scope read 权限，以保护任务和回执内容。采纳需要 read + write；回答、暂缓和人工处置还要求不可变的 Mission owner 身份。取消需要当前 read + 独立 stop 权限，且调用者是 owner 或显式 scope operator。撤销 write 不撤销独立的 read / stop。只有 stop 而无 read 的身份不能通过本试点读取取消回执。

owner 有 read 即可结束观察；operator 还需要 stop。结束观察会阻止未开始的首次派发，但不停止已提交的 Worker，不清除未知回执，不宣称成功。完整撤销的凭据无权调用；独立 scope-stop operator 是恢复渠道。权限源在 repo 外，由主机提供，每次请求及派发前重读。

## 实现

- migration 47 增加 Mission、Wait、事件、请求幂等索引、交互令牌和原 action 的派发阶段扩展。它没有第二个发送队列。
- 回答记录、原 Session message 保留、Wait 更新和派发阶段写入同一事务。实际 daemon 写连接使用并读回 `synchronous=FULL`。
- `reserved` 可以在重新验证权限、source、owner fence 和 admission 后执行第一次派发。`dispatch_committed` 与旧的未知动作不自动重发。
- 取消与提交派发通过持久状态竞争。只有证据完整的未派发动作能变成 `cancelled_before_dispatch`；未知执行继续保持未知。停止只匹配本 Mission 的原消息，保留首次停止意图，最多允许 8 次停止尝试。
- 后台每秒分页扫描有界任务；空轮询不调用模型，未变化状态不会每秒写库；拒绝的派发按 1–60 秒退避并保存去重原因。暂缓产生一次本地提醒事件。每个回复有五分钟主机超时，超时只请求 abort，不证明进程或所有副作用已停止。
- 当前费用证据显式为 unknown。试点没有 token / 金额硬上限；未知用量不会显示为零。
- `engineering adopt/observe/decide/defer/cancel/end-observation/reconcile` 提供严格参数。保存的 observation 文件绑定 revision、原问题引用和交互令牌，不会在提交前偷偷刷新。
- 保留 schema 46 只读兼容；47 的托管升级检查新账本，未完成派发会阻止升级，48 继续拒绝。

用户文档：[中文](../guides/engineering-session-adoption.md) · [English](../guides/engineering-session-adoption.en.md)。设计与机器可读 24 项映射：[设计包](../design/2026-10-25-engineering-agent/README.md)。所有注册表条目的默认执行仍关闭；文档中的历史设计测试结果不等于本次运行结果。

## OSStack 管理记录

本次使用已发布 OSStack 0.22.1 的独立开发 home 管理 17 张 kanban 卡（含 3 张审计整改卡）。三个 subagent 分别负责 Core 事务、daemon 与认证、协议与 CLI；主代理负责集成、独立崩溃测试、审计和交付。任务状态与验证凭据随最终快照保存；含真实 API 条款的 D07、真实环境资格 D08 和真人基线 V00 保留 blocked，不标记完成。没有对默认 home 或生产 daemon 执行开发迁移。

## 验证层次

1. 协议和 CLI：严格 schema、参数冲突、明确选择、冻结 observation、帮助入口与生成 JSON Schema。
2. 状态与事务：权限撤销、令牌过期、CAS、重放不写、来源变更、新问题、提醒预算、取消证明、迁移保持和故障注入。
3. daemon 与 SQLite：真实 RPC、实际完成事务、独立停止入口、队列饱和、分页恢复、旧入口不重复发送、来源目录丢失。
4. 独立 OS 进程：在 admission 前与已提交调用中执行真实 SIGKILL，再用同一数据库启动新 daemon。前者只首次派发一次；后者保留未知回执且不重发。
5. 编译产物与独立 daemon：实际 CLI 执行 adopt → observe → defer → observe → decide → completed → 同键重放 → reconcile；回复执行器仅调用 1 次。
6. 全仓验证及独立 Sonnet 5.5 审计：最终执行结果和原始凭据见下节。

“真实进程”测试使用明确标注的受信 fixture Adapter；它验证进程崩溃与持久化边界，不等同于真实 Claude/Codex Provider 或恶意子进程的资格测试。

## 审计与场景账本

[66 项场景账本](https://github.com/osborn-studio/osstack/blob/cf3bc68c71c336b59d0b3735b24bcd22209813b0/docs/design/2026-10-25-engineering-agent/evidence/session-pilot-scenario-coverage.json) 保留完整分类：58 项属于本阶段，其中 52 项已有本地自动验证，6 项待真实环境验证；另 8 项属于后续阶段。`all_adopt_session_qualified` 仍为 false。新增回归测试补充这些场景，不能通过增加测试条数把真实环境未验证项改成通过。

[Sonnet 逐项处置](../design/2026-10-25-engineering-agent/evidence/sonnet-5.5/disposition.md) 记录首轮主要问题、修复、迁移证据澄清和保留限制。审计实际模型为 `claude-sonnet-5-5`。它进行静态复审；原始模型返回与本地执行测试分别保存。

最终源码在 macOS、Node.js 22.22.1、pnpm 11.4.0 上完成全仓验证：**22 个包，5,928 项测试通过，5 项既有条件跳过**。10 项检查全部退出 0：构建、全仓测试、类型检查、lint、命令/导出清单、CLI 启动预算、changeset 检查器自测、干净类型检查契约、版本包 smoke 和发布事实一致性。lint 无错误，保留 21 条警告，包含新实现和既有代码的样式建议。启动中位数为 `--version` 48ms、`--help` 117ms，低于 150ms / 500ms 本地预算。

- [文档检查](https://github.com/osborn-studio/osstack/blob/cf3bc68c71c336b59d0b3735b24bcd22209813b0/docs/design/2026-10-25-engineering-agent/evidence/neat-final.json)：`osstack neat check --all` 完整扫描，0 错误、0 警告；72 条冻结历史材料的相对链接按已记录规则忽略。设计校验通过，74 个固定来源哈希全部匹配。
- [验证汇总与日志哈希](https://github.com/osborn-studio/osstack/blob/cf3bc68c71c336b59d0b3735b24bcd22209813b0/docs/design/2026-10-25-engineering-agent/evidence/verification.json) · [全仓测试原始日志](https://github.com/osborn-studio/osstack/blob/cf3bc68c71c336b59d0b3735b24bcd22209813b0/docs/design/2026-10-25-engineering-agent/evidence/full-test.log)
- [实际编译 CLI 冒烟结果](https://github.com/osborn-studio/osstack/blob/cf3bc68c71c336b59d0b3735b24bcd22209813b0/docs/design/2026-10-25-engineering-agent/evidence/cli-smoke.json)：单次执行、持久化完成与同键重放均通过。
- [提交前任务账本](https://github.com/osborn-studio/osstack/blob/cf3bc68c71c336b59d0b3735b24bcd22209813b0/docs/design/2026-10-25-engineering-agent/evidence/task-ledger.json) · [任务板快照](https://github.com/osborn-studio/osstack/blob/cf3bc68c71c336b59d0b3735b24bcd22209813b0/docs/design/2026-10-25-engineering-agent/evidence/task-board.txt) · [OSStack 事件流](https://github.com/osborn-studio/osstack/blob/cf3bc68c71c336b59d0b3735b24bcd22209813b0/docs/design/2026-10-25-engineering-agent/evidence/task-events.json)。PR 卡在该快照中为 running；提交后的 PR / CI 状态以 GitHub 为准。

五项跳过来自既有 graph review inventory、active supervision、live improvement provider、graph performance 与 native cold-start 的环境条件。它们没有被改成通过。曾有两轮验证因清理本地 tracked dist 后增量缓存未重建而无效；已强制重建、确认实际导出，并从头运行上述完整验证。无效轮次不计入本次通过数。GitHub CI 是独立验证，提交前尚未运行。

## 暂时不能验证及未实现的边界

| 项目 | 当前结论 | 后续所需证据 |
|---|---|---|
| 真实受控 Provider 的 native Session 采纳 | preflight 返回 `not_authenticated`；隔离 Adapter 需要显式 `ANTHROPIC_API_KEY`。CLI OAuth 审计登录是另一条认证路径 | 配置该 Adapter 的合法凭据后，执行 start、真实决策、adopt、resume、断连与新问题全流程 |
| 物理掉电后的磁盘持久性 | 只验证 FULL 设置、事务失败与 OS 进程 SIGKILL | 目标文件系统、磁盘及供电故障注入；不能以进程退出替代掉电测试 |
| 恶意同 UID Worker 与凭据隔离 | 本地 trusted-process profile，不声称安全隔离 | 分用户 / 容器 / 独立 broker 的边界测试及攻击验证 |
| 跨 daemon 重启后停止旧进程树、逃逸子进程或远端副作用 | stop_unknown 保守保留，不声称 quiescence | 目标 executor 的进程树和远端终止证明；具有仍写入子进程的破坏性测试 |
| 未知 committed 回执与托管升级恢复 | 未 applied 的 committed 会持续阻止升级；已失败升级保留 fence，可能进一步阻止托管重启。daemon.resume 只恢复存活进程，不清 fence；没有受支持的自动清除或降级通道 | 先保留原 home 和证据；离线处置或有证据放行需要单独设计与审查。本试点不提供该通道 |
| 真人认知负担、完成时间与长期成本 | 尚未完成用户研究；不能拿命令条数或模型互审充当收益证明 | 同任务的人工基线、固定成功标准、盲评和长期遥测 |
| 新目标分配、Loop / Graph 自动选路、全部能力运行时注册 | 此采纳试点不包含这些后续阶段 | 按原设计注册表阶段推进，逐项形成运行时证据 |

目前仅适合显式启用的受信本地试点，不应凭本 PR 宣称完整 Firstmate 融合或生产资格。

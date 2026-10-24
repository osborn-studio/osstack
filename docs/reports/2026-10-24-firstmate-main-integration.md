# Firstmate PR #237：main 整合与独立审计

整合基线：main `d2bc09e5a034c77f8d868dbd108b3df190060f9d`。原 9 处内容冲突已解决，Graph 与 Attention 两套入口、恢复边界和导出均保留。生产能力范围仍见 [24 项能力状态](2026-10-24-firstmate-capability-status.md)，不能因冲突解决而宣称 24 项全部完成。

## 语义冲突与可靠性修复

- main 已发布 migration 1–39 保持原 SQL；Attention 迁移移动为 40–41。真实历史版本升级夹具覆盖 24、25、26、27、37、38、39、40；旧实验 Attention 25–26 和混合 lineage 必须拒绝，并保持原文件。
- Graph RPC factory 移入有效的 daemon context 作用域，保留 Graph shutdown/recovery；协作者恢复只执行一次。
- 移除循环启动/结束时基于名字推测所有权的孤儿工作树删除；本次执行明确拥有的工作树仍按既有流程清理。测试中人为创建的外来工作树必须存在且分支保留。
- Loop 来源文件及 Claude binding 通过同一有界 descriptor 读取，拒绝 symlink/替换 inode；Claude stdin 有 64 KiB 和 1 秒限制。
- 人工 session.send / attention.answer 先获得执行准入，再建立持久回执。排队时已登记取消控制器；权限拒绝或排队取消不产生“可能已发送”的假回执，同请求可安全重试。真正开始执行后的未知结果仍不自动重发。
- 完成写库与失败写库同时出错时返回 delivery_uncertain；不因异常落入重放。执行租约清理失败仍清理运行跟踪，仓库 quarantine 保持 fail closed。
- 补齐 feature 独立构建所需的 scratch API，不依赖主工作区未提交文件。新增 public core 入口载入测量约 13.4 ms。

## 审计逐项处置

原始记录位于 [integration evidence](2026-10-24-firstmate-integration-evidence/README.md)。审计器没有执行工具；静态审计结论与真实测试分别记录。

| 发现 | 处置 |
|---|---|
| 旧 Attention 25–26 可能误升级 | 核对实际 lineage 防线并补充 frozen 历史夹具；拒绝且字节不变。审计早期“必定通过迁移”的推断不符合源码。 |
| Loop source / hook binding 路径竞态 | descriptor、NOFOLLOW/NONBLOCK、dev/ino 校验与有界读取；替换回归通过。 |
| hook stdin 无界/悬挂 | 限制字节、时间、UTF-8 解码；超时输出空结果。 |
| 双重数据库失败泄漏或丢失未知回执 | 两个持久化失败均捕获，保留原 accepted 事实并返回 uncertain；不得重发。 |
| 准入失败先留下失败回执，阻塞会话 | 准入前无持久消息/action；重复请求与取消均走同一运行跟踪。 |
| executor 的不可达 native-id null 分支绕过 finally | guard 移入拥有租约的 try/finally，防御未来调用者变化。 |
| 准入清理失败后的 quarantine 没有在线解除句柄 | main 既有保守策略：未证明锁释放时禁止同仓库写入；保留为恢复 UX 限制，不自动解锁、不借机削弱所有权。 |
| 已排队请求可等待 retained holder | 可 task.cancel 或 shutdown，尚无独立排队期限；列为后续可靠性工作，不能声称无限期等待已经消除。 |

最后一轮 Haiku 返回 **0 个已确认 P0、0 个 P1 发布阻断**。这是静态审计，不替代运行测试。最终修复后的定向回归：Session RPC 与准入 45 项通过，Loop 两个套件 65 项通过。

## 验证口径与剩余限制

使用独立 worktree、Node 22.22.1、显式 scratch OSSTACK_HOME。系统 Node 26 的 TypeScript transform API 与部分主线测试不兼容，因此不用它伪判项目回归。CLI 全套使用最多两个文件 worker，避免 Graph 子进程与二进制完整性校验在本机过度争用；真实生产超时和授权限制不变。三个执行多轮真实 Git 管线的测试使用 20 秒整体预算。

孤儿工作树夹具先前复用了跨运行目录，现改为每个 fixture 的 Git 私有目录，并同时断言执行成功，避免“命令根本没创建 worktree”被误认为保全通过。完整回归保留首次失败以及修复后的结果。

GitHub main 要求最后一次推送后有独立评审批准。取消草稿只表示准备评审，不等于绕过该规则，更不等于已经合并/部署。最终提交的完整测试、CI 与 ready 状态记录在 PR #237 中；此报告不把旧基线的 2,520 个测试或上游 81 条断言冒充本次完整回归。

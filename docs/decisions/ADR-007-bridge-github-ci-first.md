# ADR-007 GitHub CI 驱动首发修复闭环

**状态** 一次性沙箱例外已获负责人批准。生产采用与上线待单独批准。
**日期** 2026-11-09。

## 背景

osstack 的 CI 同时使用 Ubuntu 与 macOS runner。Mac mini 能分析失败和修改代码，GitHub Actions 有相应平台的验证环境。用户选择让 GitHub 继续执行 CI，避免首发链依赖 Mac mini 上的 Docker。#436 已验证现有 Watcher/Merger 的普通 PR 链路。阶段 5-G v2 的正式评审修订证据继续按原范围保留。

## 决策与边界

- **验证证据。** CI 失败是诊断入口。采集可信生产者的工作流、run、attempt、job、矩阵和 PR head/base，按 GitHub 对 PR 提交与测试合并提交的绑定核对。CI 日志只作诊断数据。执行命令与检查名单来自受保护配置。候选代码的构建和测试在 GitHub runner 执行，PR 检查采用最小权限并与发布凭证隔离。仅当最新完整检查覆盖所有指定项且原失败 job 在新提交上通过，才记录远端验证完成。现有 App B 本地验证信号维持原语义。
- **推送授权。** 首发每条链最多一次修复推送。人审阅候选后授权准确的仓库、PR、分支、head/base 和候选提交。App A 在写入前重读目标和授权，使用 W13 与快进租约；取消、过期、越权、未知状态和目标变化均阻止发布。CI 失败本身不产生推送权限。保护工作流、验证配置及范围限制沿用现有策略。
- **人审与合并。** `gilosbornhello` 的合并审批必须在新提交上给出，与修复推送授权分开。Watcher 的审批、标签和 GitHub 必需检查分别核对。首发用现有 PR Merger 验证 Mission 合并。批准其有限身份和范围后，实测缺人工批准、证据不齐和旧流程绕过均被拒绝。普通 PR 复用现有例程。App A 的合并权限保持禁止，App E 维持影子。负责人手动合并可以补充演练证据，Merger 验收需要其实际执行记录。
- **采用条件。** 本提案只为经批准的首发 scope 调整 [ADR-006](ADR-006-bridge-s0-decisions.md) 决定 2、3 中的证据和身份迁移顺序，以及相应阶段 6、7 的准入条件。需逐条记录接受的 GitHub Actions 必需检查、App B 证据替代范围、生产发布与合并身份、标记和修订 head 的绑定、W14 级验证由何处承担，以及无法由预期 head 原子约束的 base/review 竞态如何处理。旧策略在批准之前仍有效，包含 GitHub 自身的保护规则。App C/D/E 的迁移和无人确认的自动推送另行验收。

## 影响

[实施方案阶段 5–7](../plans/2026-11-02-osstack-grok-bridge-implementation.md#阶段-5-github-ci-失败后的同-pr-修复)以一次沙箱真实失败作为交付单位，要求 GitHub 复验、实际 Watcher、人审、合并及 osstack 关单。完成沙箱与生产前置演练后，单 scope 试运行按连续五条生产链验收。首发若因 CI 平台或基础设施问题无法复现，保留 PR 与失败证据并转人或等待原平台重跑。

## 获批的无人值守沙箱例外

- **修复推送。** 宿主配置一个私有许可文件，绑定登记沙箱的一个空 scope、新 root 和工程操作者，有效期最多 15 分钟。正常 daemon 只给一条新 Mission 的精确候选发一次快进许可。夹具补丁仅可删除该 PR 自己加入的 `PROBE_FAIL`。W13 核对旧 head、base、候选与 tree，并在释放写入前检查许可。过期、撤权、候选变化和未知远端结果停在当前链。
- **计入审批。** 沙箱的 `Rubebun-Jadeem` 已从 Read 提升为 Write，由现有 Watcher 复验本轮 PR 并对准确修复 head 提交审批和 `verified`。沙箱规则仍要求 GitHub 认可的最新推送审批、原工作流必需检查与线程解决。真实计入结果须从 GitHub 读回。
- **合并。** 现有 Merger 在验收 PR 发一条绑定完整 head 和 base 的 `osstack-sandbox-merge HEAD BASE` 评论，作为本地 daemon 的触发信号。Watcher 与 Merger 共享 GitHub 用户，Routine 的实际执行另从 Grok 运行记录核对。daemon 验证 W13 推送回执、实时 CI、Watcher 审批与沙箱规则后，才以独立 App E 提交一次预期 head 的 squash。App E 凭证只在本机使用。无法确认请求结果时通过只读 API 对账。GitHub 的合并 API 可锁定 head，base 在写入前读取并在合并后由 squash 父提交核验。
- **关单。** daemon 要求合并前已观察到的同一次 CI 检查与合并后读回一致，且合并身份为 App E。通过后在 `mission status --json` 返回 `github_ci_chain.state=closed` 和合并提交。合并预留、写入待对账和证据不足分别显示为 `merge_reserved`、`merge_reconciling` 和 `merge_held`。原 Mission 状态仍保留发布记录。

隔离 daemon 通过 `OSSTACK_CONTAINED_SANDBOX_CI_SCOPE` 选择 scope。将绝对路径传给 `OSSTACK_CONTAINED_SANDBOX_CI_AUTO_GRANT` 和 `OSSTACK_CONTAINED_SANDBOX_CI_MERGE_KEY`。许可 JSON 使用 `version`、`grant_id`、`scope_id`、`principal_id`、`client_session_id`、`issued_at` 和 `expires_at`，时间使用 Unix 毫秒。许可文件和其目录分别限宿主用户读写，权限为 0600 和 0700。删除许可文件可撤销待发布修复。

该例外只授权首次沙箱演练。生产试运行另按阶段 7 放行。

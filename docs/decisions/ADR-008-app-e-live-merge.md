# ADR-008 App E 真实合并 Mission PR

**状态** 负责人 2026-11-25 接受（“都按推荐，开 PR”“agree”“ok”“定好方案以后全力推进吧”）。第一版只限沙箱仓库；主仓库另行启用。
**日期** 2026-11-25。

## 背景

[ADR-006](ADR-006-bridge-s0-decisions.md) 决定 2 规定自动化只能在严格门槛下合并 Mission PR，并且“先影子、后真实”，启用真实合并需要单独的设计和后续 ADR。设计见 [Bot 合并](../design/2026-11-25-bot-merge.md)。

## 决策

1. **合并者。** App E（`osstack-merger`）可以真实合并 Mission PR。不新建合并 Bot。`gilosbornhello`、`gilberthello`、`Rubebun-Jadeem` 保留 admin 和合并权（设计 §5b）；App E 不阻止它们，只在 Mission PR 不是由 App E 合并时发 attention 提醒。
2. **验证来源。** 合并判断只认 GitHub Actions（App 15368）在实时 head 上写出的 `osstack/verify-actions` check，并且该运行所用的 `osstack-verify.yml` 的 blob SHA 等于主机登记值（设计 §5a）。Grok 共享电脑上的验证程序和 Mac mini 复验不计入。
3. **批准。** `gilosbornhello`、`gilberthello` 的批准对所有 Mission PR 计入；`Rubebun-Jadeem` 的批准只对设计 §5 定义的低风险 PR 计入（不超过 5 个文件、200 行，最低风险档，不碰受保护路径，不改工作流）。不做“不要批准”的选项。
4. **门槛。** App E 影子期的 G0–G8 保留；G3 换成第 2 条；G6e、G8 只记录不拒绝；合并前完整重读一次，合并调用带 `sha`。`strict_required_status_checks_policy` 在 ruleset 启用时打开。
5. **启用顺序。** `OSSTACK_MERGER=1` 第一版只对 `osborn-studio/osstack-bridge-sandbox` 生效，其他仓库启动即拒绝。主仓库启用的前提：沙箱影子对照至少 20 个 Mission PR、`would_merge` 却不该合并的情况为 0，并由一个经评审的改动移除沙箱限制。
6. **熔断。** `OSSTACK_MERGER=0` 立即停止真实合并；App E 私钥可随时在 App 设置里删除。

## 影响

- 新增节点 M-E2（真实合并）、M-E3（Actions 验证工作流与 G3′）、M-E3b（Watcher 发 `workflow_dispatch`）、M-E4（`bot_approvers`）、M-E4b（提醒、G6e/G8 只记录、工作流 SHA 核对）。
- 运行手册 §6.1 “本地失败修复的 PR 由人合并”在沙箱上由本 ADR 取代；主仓库在启用前不变。
- 合并之后的发布与部署不在本 ADR 范围，仍每次先问负责人。

## 已接受的风险

- 三个 admin 账号可以绕过 App E 直接合并；只有提醒，没有阻止。
- `Rubebun-Jadeem` 的令牌在 Grok 共享电脑上，所有 Bot 都能用它批准；所以它只对低风险 PR 计入，安全性由第 2、4 条的机器门槛承担。
- GitHub merge API 不绑定 base；合并前重读缩小但不消除这个窗口（ADR-006 “Residual race”）。

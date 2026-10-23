## 结论

**1. gate_kind 枚举：未发现阻断。但前提与源码不符。**
- `packages/protocol/src/session-continuation.ts` 的枚举只有 `phase_continue`、`task_authorization`、`risk_approval`、`external_input`，**没有** `scope_expand` 和 `budget_reconsider`。这两个值在该 schema 中无法被解析，需要确认它们是否在别处定义。
- 四个值解析逻辑完全相同，schema 本身不授予任何权限。测试也确认 `.strict()` 会拒绝 `approved: true` 字段。
- 因此"risk_approval/task_authorization 覆盖授权门、其余不自授权"这一点，**无法仅凭所给文件证实**。授权语义若存在，应在消费端（审批/策略层）实现，该处未提供。

**2. readAttentionLoop 的路径约束：未发现阻断。**
- `repo` 与 `path` 均经 `realpath` 解析后再比较，symlink 外跳会被拒绝（`attention-loop-source.ts`）。
- `relative` 加 `isAbsolute` 判断越界，越界抛出 `loop_outside_scope`。
- `missing` 情况下 `realpath` 抛 ENOENT，被转为 `source_missing`，不读取任何内容，且 `coverage: "uncovered"`。
- 读取有 1MB 上限，并校验 `loop_id` 一致。
- 小瑕疵（非安全问题）：`rel.startsWith("..")` 会误拒合法的以 `..` 开头的文件名。

**阻断项：** 基于所给代码，无已确认的 P0/P1 阻断。授权语义的落地位置及 scope_expand/budget_reconsider 的定义需另行核实。

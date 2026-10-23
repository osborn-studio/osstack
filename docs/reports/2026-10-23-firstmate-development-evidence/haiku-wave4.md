## 结论

基于所给源码，**未确认新的阻断问题**。C1-C4 均已排除。有两项条件因源码缺失未满足，需补充后才能完全排除。以下仅审阅粘贴的源码，未运行测试或工具。

## 逐项

- **C1（已排除）**：`attention.abandon-receipt` 与 `attention.answer` 在 `handleSingle` 中先于 `ctx.supervision.handle` 分派，并均受 `supervision` 开关和 `draining` 约束。`activeSessionSends` 的检查与 `set` 之间没有 `await`，同一会话的并发发送不会交错。

- **C2（已排除）**：
  - 已存在 message 时，`applyInbound` 返回 duplicate，daemon 不分派执行。
  - 原 `failed` 消息用原 `expected_version` 重放时，返回 `delivery_uncertain`；用新版本重放时返回 `version_conflict`。
  - 原 `abandoned` 消息（状态仍为 `accepted`）重放时，`reserveSessionInstruction` 的 uncertain 查询排除了 resolution，因此不会阻止新 message_id 的指令。
  - 测试断言与代码路径一致。

- **C3（已排除，有前提）**：
  - `latestSnapshot` 始终返回对象，没有 turn 时 `turn_id` 和 `decision` 为 `null`，不是 `null` 或 `undefined` 的返回值。`awaiting_decision` 且 `decision === null` 会被 `invalid_decision` 拒绝。
  - 直接路径与 attention 路径都经过同一个 `reserveSessionInstruction` 门禁。
  - 未发现可达的绕过序列：`session.send` 要求 `turn_id` 等于当前 latest turn，而风险 turn 在签名路由之外无法生成后续 turn。
  - 前提：`gate_kind` 的完整枚举在 `SessionDecision` schema 中未提供，门禁只检查 `risk_approval` 与 `task_authorization`。若 schema 还包含其他会授权执行的 gate，则门禁不完整。

- **C4（已排除，符合设计）**：`completeInboundTurn` 在同一事务中写入 turn、更新 session 版本并把 message 从 `accepted` 改为 `applied`。无 Attention 时，未知指令被 `delivery_uncertain` 阻止；有 Attention 时只能通过显式 `abandon-receipt` 处置，不存在自动恢复或自动重试路径。

## 条件未满足（需补充源码）

1. **`SessionDecision.gate_kind` 枚举**：确认是否只有两种门禁类型，以及门禁列表与 observer 中的过滤是否一致。
2. **`readAttentionLoop` 的 `state_path` 约束**：`attention.loop` 的 `state_path` 来自客户端，并会被持久化到 payload 中，scan 每 30 秒读取一次。若该函数不将路径限制在仓库内，则存在本地 RPC 任意文件读取的可能。可达序列为：`attention.watch` 注册仓库，然后调用 `attention.loop` 并传入绝对路径。返回内容取决于其输出裁剪方式。

## 非阻断 P2

- `handleSessionSend` 中的 `recoveredReservationVersion` 始终为 `undefined`，属于死代码，应清理。
- `completeInboundTurn` 在 adapter 成功之后、事务失败时，异常会逃逸为通用内部错误，而不是 `delivery_uncertain`。消息仍保持 `accepted`，与设计一致，但错误码不够清晰。
- 人工直接恢复后，原 Attention item 保持 `answer_abandoned`，不会重新打开。

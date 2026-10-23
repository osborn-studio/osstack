**结论：** 上轮修复大多在源码中成立：subject 级降级、终态拒答、reserved 启动对账、active map 精确绑定 message ID、通用 reserve catch。仍有 3 个 P1，其中 #1 可被 agent 输出触发。本次仅基于提供的源码只读审查，未调用工具，也未运行测试。

## P1

**1. 签名审批门的分类来自不可信 agent 输出（代码证据确凿；威胁模型为假设）**
- 证据：`daemon` 的 `parseDecisionDirective` 从非受控 adapter 的 assistant 文本解析 `ostag_decision`，其中 `continuation.gate_kind` 原样进入 `decision`。`reserveSessionInstruction`（attention-actions.ts）仅在 `gate_kind` 为 `risk_approval` 或 `task_authorization` 时抛 `signed_approval_required`。
- 影响：被仓库内容注入的 agent 可把风险 gate 标为 `phase_continue`，之后人工通过 attention answer 或 `session.send` 发送普通文本即可越过签名要求。observer 对 `continued_externally` 的排除也依赖同一标签。
- 测试缺口：`requires a signed approval route for risk gates` 通过篡改 DB 内容先触发 `source_changed`，从未进入 signed 分支。
- 建议：非受控 adapter 带 continuation 的决策默认 fail-closed，视为需要签名路由；或只信任受控 adapter 或签名 grant 提供的分类。补一个不改变 content_hash 的测试。

**2. 一条 inbound 消息可永久封锁整个会话（封锁已验证；“无解锁路径”为假设）**
- 证据：`reserveSessionInstruction` 的 `delivery_uncertain` 检查作用于整个 session 上任意 `accepted`/`failed` 的 inbound 消息，不限当前 turn。
- `executeReservedSessionTurn` 中的 `completeInboundTurn` 位于内层 try 之外。若 agent 已执行而完成事务抛错（如 `SessionVersionConflict`），handler 返回错误，message 停留在 `accepted`，action 停留在 `reserved`。`recover()` 只把 action 改为 `uncertain`，不推进 message。
- 之后该会话所有新指令都会得到 `delivery_uncertain`。在所给文件中，本路径没有调用 `markMessageApplied`，`retryFailedMessage` 也只是仓库内 API。请确认仓内是否有 reconcile 工具。
- 建议：完成事务失败时把 message 转入可显式 reconcile 的状态，并提供对应命令。

**3. `history_gap` 可被瞬时错误清除，导致 `covered` 假阳性（代码证据充分）**
- `AttentionObserver.scan()` 的 per-subject catch 用 `{state:'unknown', reason:'invalid_source', detail}` 覆盖 `payload_json`，丢失 `gap` 字段。
- 下次成功扫描时，`gap` 只来自旧 payload 的 `gap` 字段，或 `latest.ordinal < cursor`。cursor 已越过缺口，因此 gap 被置为 false。
- 结果：inventory 回到 `covered`，`validateSubjects` 放行 handoff，而缺失的 ordinal 永远不会被投影。
- 触发条件：gap 检出后任意一次 per-subject 异常，例如 `source()` 中 `realpathSync` 遇到 EACCES 或 ELOOP，或 `wait()` 抛错。
- 建议：gap 存入独立字段，在 catch 路径中保留，并在人工确认前保持粘性。

## P2（高价值）

4. **容量双计。** 每个 resumable session 同时产生 session subject 和 run subject。`handleSessionStart` 为每个 session 插入带 `session_id` 的 run，run 发现查询不排除这些 run，且 run subject 无条件 admitted。有效 session 上限约为 50。测试让 220 个 session 共享一个 run，因此没有暴露。
5. **发现 cursor 盲区。** 超过 250 行时，pass 中途插入的、key 小于 cursor 的 session 不会在本 pass 被发现。但最后一页仍会设置 `scan_complete=1`，可能短暂显示 covered。
6. **恢复语义与声明不符。** `recoverDeliveries` 把 `sending` 改回 `pending`，重启后会重发。超时后晚到的成功也会导致重发。这与“保留记录恢复默认不重复发送”不符。影响是重复通知，不是动作重放。
7. **revision 噪声。** 最新 turn 每个 tick 都会重投影。`source_version` 变化时，已 applied 或 continued 的 item 的 revision 会递增，重新出现在 brief 的未读中，并增加 UI 的 `stale_item` 错误。
8. **错误被吞。** `attention.answer` 丢弃了 `executeReservedSessionTurn` 的 `SingleResponse`。失败时仍返回 `ok` 且 `state: uncertain`，agent 的错误码丢失。
9. **毒化 turn 永久阻塞投影。** cursor 无法越过坏 ordinal，也没有跳过或隔离机制。coverage 能诚实地保持 degraded。
10. **无保留策略。** `attention_items`、`attention_actions`、`attention_deliveries`、`attention_seen` 与 spool jsonl 无限增长。`attention_foregrounds` 每次调用都插入且无上限。brief 与 inbox 的 COUNT 随之变慢。
11. **投递吞吐受限。** 每个 30 秒 tick 只 drain 一条，积压时明显不足。
12. **测试缺口。** 除上文 #1 外，观察者测试未覆盖双计，`history_gap` 的瞬时错误路径也未覆盖。

## 已核实无误

- CI 读取只做 `exact head` 检查，结果是 informational，不构成 merge 授权。
- S3 契约工具仅形成与校验，不替代签名审批。
- 前台 handoff 返回 `execution_takeover: false`，不构成执行接管。
- `verifyDeliveryContract` 的 `||` / `&&` 优先级正确。

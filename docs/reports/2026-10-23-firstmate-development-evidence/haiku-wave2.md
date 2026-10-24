## 结论

**没有确证的 P0。** 确证 P1 有 3 个，另有 1 个条件性 P1，依赖 agent 输出的 decision 形态。P2 若干。以下均为只读代码审计结论，我没有运行任何测试。

## 逐项核查

- **sticky history gap（部分成立）**：正常路径下 gap 会保留。但 `attention-observer.ts` 的 `scan()` 中，cursor 的 UPDATE 先于 `receipts()`、`getItem()`、`wait()` 执行。这些调用若抛错，外层 catch 只调用 `update()`，而 `update()` 只保留已落库的 `history_gap`。本轮新检测到的 gap 没有落库，下一轮 cursor 已越过它，不会再被检出。见 P1-1。
- **uncertain ledger**：启动 `recover()` 只对账不重发。`abandon()` 有 CAS（`expected_version`）、reason 与 hash 记录，返回 `execution_outcome: unknown`，不声称已执行。RPC 层要求 `acknowledge_unknown_effects === true`。成立。`evidence_sha256` 只校验格式，见 P2。
- **手工 risk gate**：`attention.answer` 路径成立（`reserve()` 先调用 `SessionDecision.parse`，失败即 fail-closed）。直接 `session.send` 路径有 fail-open，见 P1-4。
- **handoff 冻结 valid_until**：成立，但重放在 foreground 过期后失效，见 P2。
- **过期 foreground 仍可 once 提醒**：成立（`turnEnd` 使用 `allowExpired=true`）。
- **loop missing/recovery_required 降级**：成立，`inventory` 的 faulty 判断覆盖了 reason。
- **localspool 原子发布与幂等**：成立（temp 文件 + `link` + EEXIST 时比对 body）。shutdown 等待 drain 只部分成立，见 P2。
- **发送与执行独立**：成立。sender 只写本地文件，`drain` 不调用执行路径。通知语义确为至少一次。

## P1

**P1-1 history gap 可被静默丢弃。** 路径：`scan()` 子 subject 循环中，cursor 已写入（同一 scope 事务内，异常在 subject try 内被吞掉、事务不回滚），随后 `wait()` 或 `getItem()` 抛错，catch 只写入 `invalid_source`，本轮 gap 丢失，coverage 可能误报 covered。修复：gap 与 cursor 在同一语句写入，并放在任何可能抛错的调用之前；或对 subject 使用 savepoint，出错时回滚 cursor。

**P1-2 单个坏 session 会卡死整个 scope 的发现。** `scan()` 的发现循环在 try 之外调用 `source()`，而 `source()` 对非 ENOENT 的 realpath 错误（EACCES、ENOTDIR 等）会重新抛出。`tick()` 回滚整个 scope 事务，`discovery_after` 不前进，之后每轮都命中同一行，键序更大的 session 永远不会被发现。这与测试声称的“poison 隔离”不符。修复：逐行 try，把失败行记为未绑定（`admitted=0`，reason 为 source_error）后推进游标。

**P1-3 全局 100 槽位只增不减。** `admitted=1` 的行从不释放，计数是全局的。终态 session 和更早被发现的 run 会永久占用槽位。之后新建的活跃 session 只能 `admitted=0`，coverage 永久 degraded，handoff 永久 `coverage_not_ready`。这也违背“优先 session”：先前扫描时入库的 run 会挤掉后来创建的 session。需要明确容量策略（释放终态槽位，或按 kind 预留）。

**P1-4（条件性）门禁 fail-open。** 调用链：`handleSessionSend` → `reserveSessionInstruction` → `SessionDecision.safeParse(snapshot.decision)` 失败时整个 `signed_approval_required` 检查被跳过 → `applyInbound` → `executeReservedSessionTurn` → `adapter.resumeSession`。这不是自动批准，也不绕过 guardedAutonomy 的下游签名审批。它绕过的是本变更新增的人工路径门禁。成立条件是：存在 `gate_kind` 为 risk 但不满足 `SessionDecision` schema 的已持久化 decision。我未能核实 `latestSnapshot` 的字段来源，需要验证。

另外，门禁的触发条件 `continuation.gate_kind` 来自 agent 输出。agent 省略或改错这个标签，就能取消签名审批要求。你说 gate_kind 只是提示，这没错，但代码却用它决定是否强制签名。二者必须二选一：要么对非空 decision 做 fail-closed，并从非 agent 来源推导风险；要么不要再称之为 `signed_approval_required` 强制执行。

**关于你的威胁模型反驳**：我同意 gate_kind 不授予执行权，也没有发现自动回答或自动授权路径。我没有审查 `SessionCollaborator`，它的续跑路径是否也走 `reserveSessionInstruction`、是否强制签名门禁，需要单独核实。

## P2

- handoff 重放在 foreground 过期后返回 `invalid_foreground`，因为 `authenticate` 默认 `allowExpired=false`。规格要求重放返回当前有效性，这里不满足。
- `abandon` 的 `evidence_sha256` 只校验格式，不与任何证据绑定。审计力度弱，但执行者仍是 owner，不构成绕过。
- `drain()` 每轮 scan（30 秒）只发一条，积压 1000 条需约 8 小时。
- `drain` 超时后不等待 sender 结束，`SupervisionService.stop` 之后 `db.close()` 可能与未完成的文件写入竞争。`writeFile(temp)` 在 try 外，失败会留下 temp 文件。
- `turnEnd` 在 hook 输出前已把 `reminder_sent` 置 1，hook 投递失败会消耗一次性提醒。
- `attention.ci` 的 `github_repo` 来自请求，未绑定 scope 的 repo。只读，但越出了 scope 边界。
- `attention.loop` 的 `state_path` 约束在 `attention-loop-source.ts` 中，不在本次审计范围。需确认它拒绝绝对路径与 `..`。
- stop hook 对非 JSON stdin 的 `JSON.parse` 会抛错，需确认 CLI 层捕获并以 0 退出。

## Pilot 评估

pilot 只覆盖正常路径：100 subject、恰好满额（不测溢出）、1000 个历史 turn、一次 Stop 提醒、无重复。它**没有覆盖** `attention.answer`、`abandon`、handoff 重放、daemon 重启、poison 行、容量溢出、gap 丢失路径。因此 pilot 的 `covered` 结论不能反驳上述 P1，也不能证明 answer 路径端到端可用。pilot 数据本身我无法核实。

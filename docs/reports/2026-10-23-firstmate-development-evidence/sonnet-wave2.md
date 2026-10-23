# 审计结论（只读、未运行测试）

依赖未提供的代码处我标了「假设」：`withWrite`（是否嵌套、抛错是否回滚）、`traceSpan`、`SessionRepository`。

## P1

**1. `session.send` 默认路径被改坏，与 `OSSTACK_ATTENTION` 开关无关**
- 路径：`daemon.ts:handleSessionSend` → `attention-actions.ts:reserveSessionInstruction`。
- 触发：
  - 会话存在 `accepted` 或 `failed` 的入站消息，再用新 `message_id` 调 `session.send`，抛 `delivery_uncertain`。
  - 存在 active grant 时抛 `grant_owned`（`session.send` 没有 takeover 参数，必抛）。
  - 另有 `continuation_in_flight` 和 `signed_approval_required`。
- 后果：`handleSessionSend` 只捕获 `SessionVersionConflict` 和 `SessionMessageIdConflict`，其余 `throw err`。socket 回调里是 `void traceSpan(...).finally(...)`，响应写在 `await handleSingle` 之后，所以客户端永远收不到响应。若 `traceSpan` 不吞错，又没有 `unhandledRejection` 处理，整个 daemon 会被打崩（假设）。
- 附带回归：旧版此场景返回 `version_conflict`，现在抛 `delivery_uncertain`。
- 修复：在 `handleSessionSend` 中把这四个错误映射成 `singleErr`；socket 回调给非流式分支加 `catch` 并回写 `internal`。
- 测试：
  - 先造 `accepted` 消息，再发新 id，断言 `ok:false` 且 `code=delivery_uncertain`、daemon 存活。
  - 同理覆盖 active grant 和 risk gate。

**2. `attention.answer` 可复活终态会话**
- 路径：`attention-actions.ts:reserve` 和 `daemon.ts` 的 `attention.answer` 预检。
- 触发：会话在最新 turn 带 decision 后变为 `cancelled`/`failed`/`completed`，版本已 bump 但没有新 turn。观察者下一 tick 把 item 以新版本重投影（item 仍为 `open`），此时调用 answer。
- 后果：`source.version === item.source_version` 成立，`latest.turn_id` 也匹配，通过。预检只看 `resume_supported` 和 `native_session_id`，不检查 `session.state`。`handleSessionSend` 里的 `session_terminal` 守卫被绕过，终态会话被 resume。
- 修复：`reserve` 内强制 `source.state === 'awaiting_decision'`，并拒绝 `TERMINAL_SESSION_STATES`。观察者在会话终态时把 `open` item 置为 `source_closed`。
- 测试：把 session 置为 cancelled，tick 后 answer，期望 `session_terminal` 且未调用 adapter。

**3. `source_missing` 覆盖关键状态，且一次瞬时故障后永不恢复**
- 路径：`attention-store.ts:markMissing`、`attention-observer.ts:source()` 和 `scan`。
- 触发：外部卷（本仓库在 `/Volumes/...`）短暂卸载导致 `realpathSync` 抛错，`source()` 返回 `undefined`。
- 后果：
  - `markMissing` 的条件是 `state NOT IN ('answer_applied','source_missing')`，会把 `answer_reserved`、`answer_uncertain`、`continued_externally` 全部覆盖成 `source_missing`。丢失「投递不确定」是最危险的一种。
  - `projectDecision` 的 upsert 不改 `state`，源恢复后 item 永久停在 `source_missing`。`reserve` 要求 `state==='open'`，该 item 再也无法回答。
- 修复：
  - 只允许 `open → source_missing`。
  - 区分 `ENOENT` 与瞬时 IO 错误：瞬时错误只标 subject `reason`，不改 item。
  - 源恢复且 binding 和 content_hash 一致时，`source_missing → open` 并 bump revision。
- 测试：模拟 `realpath` 抛 `EIO` 后恢复，断言 `answer_uncertain` 不被改写、`open` 能回来。

**4. 单条坏 decision 让整个 scope 永久失明**
- 路径：`attention-observer.ts:project` 和 `scan`；`attention-store.ts:projectDecision`。
- 触发：任一 session 的 `decision_json` 非法 JSON、超 16384、`SessionDecision.parse` 失败，或 `decision_content_conflict`。
- 后果：这些都是 `throw`，而 `scan` 在 `write()` 事务内，整事务回滚。游标不前进，同 scope 内其他健康 session 的新 decision 也不再投影，每个 tick 重复失败。read-model 对同样情况只记 limitation，两边不一致。
- 升级风险：若升级后 `SessionDecision` 的 schema 或默认值变化，旧 `content_hash` 与新哈希不等，全部旧 item 触发 `decision_content_conflict`，整个功能瘫痪。
- 修复：
  - 每个 subject 用独立 savepoint 或 try/catch。
  - 失败时写 subject `reason='invalid_decision'`，不抛出。
  - 哈希对原始 `decision_json` 的规范化形式计算，或存 `hash_version`。
- 测试：两个 session，一个写入坏 JSON，断言另一个仍被投影，且 inventory 为 `degraded` 而非整体卡死。

**5. 续接检测被静默截断到 100 个 item**
- 路径：`attention-observer.ts:scan`，`this.store.listItems(scope.scope_id)`。
- 触发：scope 内 item 总数超过 100。观察者会投影全部历史 turn 的 decision，累积很快。
- 后果：`listItems` 默认 `limit=100`、按 hash 序，后面的 item 永远不会被检查 `continued_externally`。结果是过期 `open` item 持续存在，并被 `enqueue` 推送。
- 附带性能问题：每个 subject 都 `listItems` 加 100 次 Zod 解析，同步卡事件循环。
- 修复：直接 SQL `WHERE scope_id=? AND session_id=? AND state='open'`，不解析 decision。
- 测试：造 150 个 item，其中位于 hash 序 100 之后的一个，其 turn 已有 applied 入站消息，断言它被标为 `continued_externally`。

**6. 容量上限跨 scope 共享、写一次不再复评**
- 路径：`attention-observer.ts:scan`。
- 触发 A：`SELECT COUNT(*) FROM attention_subjects WHERE admitted=1` 没有 `scope_id` 过滤，100 个全局上限，一个 scope 能饿死其他 scope。
- 触发 B：run 在键序上排在 session 前（`'r:' < 's:'`）且各占一个名额。一个 task 有 100 个 run 时，其 session 全部变成 `capacity_exceeded`。
- 触发 C：已存在的 subject 行直接 `continue`，`admitted=0` 或 `binding_unknown` 从不重评。首次发现时卷未挂载，就永久 `binding_unknown`。
- 后果：该情形至少会降为 `degraded`，不会误报 covered，但没有恢复路径。
- 修复：按 scope 计数，session 优先于 run（run 不占名额或单独限额），每轮重评未准入 subject。
- 测试：scope A 占满后 scope B 的 session 仍被准入；容量释放后被拒的 subject 能被晋升。

**7. 回执与 revision 不一致，通知可能过期误发**
- 路径：`attention-actions.ts:reconcile`、`attention-experience.ts:drain` 和 `enqueue`。
- 7a：`reconcile` 修改 item 状态但不 `revision+1`。已对旧 revision `seen` 的用户在 brief 里看不到 `answer_uncertain`，`stale_item` 防护也失效。同一个 `delivery_id=item:revision` 会复用，导致通知去重错位。
- 7b：in-flight 时重放同 `action_id`，`reconcile` 读到 `accepted`，写成 `uncertain`，产生误报。随后首个调用完成再改回 `applied`。
- 7c：`drain` 发送前不校验 item 当前 revision 和 state。投递退避、`quiet` 期间或重试时，item 若已 `continued_externally`/`answer_applied`，仍会推出旧问题。
- 修复：
  - `reconcile` 每次状态变化 bump revision。
  - 重放且消息为 `accepted` 且会话在 `activeSessionSends` 中时，返回 `in_flight`，不写库。
  - `drain` 的 claim 事务内比对 `item.revision===row.revision` 且 state 属于可投递集合，否则置 `superseded`。
- 测试：enqueue 后把 item 置为 `continued_externally`，再 `drain`，断言 sender 未被调用。

**8. 崩溃后 `reserved` 动作无人收口**
- 路径：`SupervisionService` 构造和 tick；`attention_actions.state='reserved'`。
- 触发：daemon 在 `reserve` 之后、`reconcile` 之前退出，包括「adapter 已应用但没 reconcile」。
- 后果：
  - action 停在 `reserved`，item 停在 `answer_reserved`。
  - `enqueue` 只收 `open`、`answer_uncertain`、`source_missing`，不会通知。
  - 消息仍是 `accepted`，会话被 `delivery_uncertain` 永久挡住。
  - 只有客户端用同一个 `action_id` 重放才会收口。
- 修复：启动时（此时 `activeSessionSends` 必为空）把所有 `reserved` 动作 reconcile 为 `applied` 或 `uncertain` 并 bump revision，后续 tick 也扫一遍。
- 测试：reserve 后不执行就重建 service，断言 item 变 `answer_uncertain` 且进入 deliveries。

**9. handoff 回执可能被误读为执行接管或持续覆盖**
- 路径：`attention-experience.ts:validateSubjects` 和 `handoff`。
- 缺陷 A：`validateSubjects` 只拒绝 `payload.reason`。`history_gap` 在 `payload.gap` 里，所以有历史缺口的 subject 能被 handoff。
- 缺陷 B：`handoff` 不检查 scope 级 `total>admitted` 和 `faulty`，也不检查 `unresolved_receipts`（accepted 或 failed 的入站消息）。inventory 此时显示 `degraded`，handoff 仍成功。
- 缺陷 C：回执只有 `receipt_id`、`generation` 等字段，没有 `execution_takeover:false`、`process_liveness:'unknown'`、`valid_until`（可取 `scope.deadline`）。只有 `turnEnd` 带了声明。回执持久且永不过期。角色名 `foreground_owner` 和 `inbox` 里裸 `coverage:'covered'` 同样容易误导。
- 修复：与 `inventory` 共用同一个覆盖判定函数；回执加上述三字段；`covered` 改名为 `observed_fresh`，或在 inbox 和 handoff 中附带 `limitations`。
- 测试：subject 有 `history_gap` 或存在 `accepted` 消息时 handoff 失败；回执包含 `execution_takeover:false`。

## P2（价值较高）

- **前台租约无法续期**：`foreground` TTL 固定 120s，没有 renew。轮次超过 2 分钟后，`handoff` 和 `turn-end` 都抛 `invalid_foreground`，不会产生「前台已过期未交接」的提示。幂等重放（`prior`）也排在 `authenticate` 之后，过期后拿不回已有回执。`foreground_*` 行永不清理，会无界增长。
- **takeover 是裸 boolean**：它阻断「此刻」的 active grant，而不是用户看到的那个。加 `takeover_grant_id`，并把 `actor` 纳入 `answer` 参数、digest 和消息 `requested_by`；目前 answer 没有身份归属。
- **回放被预检抢先**：`attention.answer` 的 `resume_unsupported`/`session_busy` 预检排在幂等 replay 之前。终态会话上的重放，或 in-flight 时的重放，拿不到已持久化的回执。
- **repo 绑定不一致**：`reserve` 用原始 `source.repo_path !== scope.repo_path`，观察者用 `realpath`。macOS 上 `/tmp` 这类符号链接路径会让回答永远 `source_changed`。`reserve` 里没有重新 realpath，也不比 `binding_hash`。
- **哈希口径**：`reserve` 用原始 `latest.decision` 的哈希对比 item 的 Zod 解析后哈希。若 schema 会剥离或补默认字段，永远 `source_changed`，应两边都用解析后的值。
- **历史缺口检测不完整**：`latest.ordinal < cursor`（turn 被删或回退）不会标 `history_gap`。非最新 turn 的 `open` item 没有 `superseded` 状态，会一直推送。
- **`scan` 的任务消失分支**：先 `UPDATE ... 'source_missing'` 再 `throw`，事务回滚，更新丢失（假设 `withWrite` 抛错回滚）。`tick` 的错误写库本身若再抛非 stale 错误，会跳过后续 scope。
- **通知质量**：`drain` 对 `answer_uncertain` 和 `source_missing` 也只发原始 `question`，用户看不出状态，还会被诱导重答。`error` 原样存 300 字符并经 `attention.deliveries` 返回，可能带出带 token 的 URL，需要脱敏。
- **通知吞吐**：每 30s 一个 tick 只投一条，100 条要 50 分钟。`quiet` 按任意 actor 全 scope 生效，会同时压制 `uncertain` 告警。
- **资源上限**：`watch` 不限 scope 数；每次 tick 在事件循环里同步扫全部 scope。
- **CLI**：`handoff --token` 把 token 放在 argv 里，`ps` 可见。`attention.answer` 在 adapter 失败时仍返回 `ok:true`，只靠 `state:'uncertain'` 区分，应附带失败码。
- **`answer_uncertain` 无出口**：没有人工确认或解决接口，且阻塞同会话后续所有人工指令。属于后续切片，但需要文档说明。
- **假设待核实**：`reserve` 内嵌套 `withWrite`，`markMissing` 也嵌套，需确认是 savepoint 而不是二次 `BEGIN`。

## 已核对、未见缺陷

- `claimOwner`/`assertOwner` 的 generation 围栏。
- `drain` 的 `sending` CAS（`attempts`+`state` 条件）。
- `reserve` 内 message、action、item 三者同事务落库。
- `action_id` 的 digest 冲突检测。
- `daemon-lock` 的 `held` 集合与 POSIX 锁处理。
- read-model 对 active grant 不声称覆盖（`owner:'unknown'`）。

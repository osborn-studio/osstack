## 审计结论

- 四项上一轮 P1 在所给源码中均有对应实现，机制成立。
- 未发现已确认的新 P1。
- 有三个条件性 P1 候选（C1-C3）依赖未提供的模块（daemon 路由、`sessions.applyInbound`、`latestSnapshot`），补证前不能判定为无阻断。
- 测试仅作为材料，本次未执行，下列断言均为代码阅读结论。

## 逐项复核

**1. subject 后半段失败导致 history_gap 丢失：有效（确认）**
- `AttentionObserver.scan` 的 `db.transaction` 覆盖游标更新、`projectDecision`、items 循环和 `wait`。异常回滚后 `ordinal_cursor` 保持旧值，下一轮由 `turn.ordinal !== cursor + 1` 与 `latest.ordinal < cursor` 重新推导缺口，缺口不会永久丢失。
- 外层 catch 写入 `reason:"invalid_source"`。`inventory` 的 `faulty` 将其计为 degraded，`validateSubjects` 也会拒绝交接，因此不会误报 covered。
- 残留 P2：失败窗口内 `history_gap` 不落库，owner 只能看到 `invalid_source` 和 detail。
- 测试命名不准确：`rolls back a subject cursor when a late projection failure...` 的实际触发点是 items 循环中 `getItem` 的解析异常。turn 循环内的 projection 异常会被 try 吞掉并转为 gap，而非回滚。

**2. 非 ENOENT 来源错误拖住 discovery：有效（确认）**
- discovery 中 `source()` 被 try 包裹，异常后 `sourceError=true`，`bound=false`，`admitted=0`，`reason=source_error`。已准入行在 subject 循环中由单 subject catch 隔离。
- `receipts()` 与 INSERT 不在该 try 内，但属数据库级错误而非来源错误，不构成本项回归。

**3. 容量永久耗尽与显式 release：有效（确认），附 P2**
- `SessionStore`/`AttentionStore.release` 校验版本、保留历史，并写入 `owner_released`。discovery 对该标记直接 `continue`，不会自动准入。其他 `capacity_exceeded` 行在后续 pass 中可占用席位，逻辑成立。
- P2-a：`release` 不检查 `admitted=1`。对未准入行调用会把它永久标为 `owner_released`，且不释放任何席位。
- P2-b：`supervision-service.ts` 的 `attention.loop` 在 `ON CONFLICT` 时只更新 payload、sampled_at、generation，不更新 admitted。它会覆盖已释放 loop 的 `owner_released` 标记，改写为 `snapshot_only`，reason 失真。未准入的 loop 也无法因容量释放而准入。
- P2-c：释放后该 session 的 open item 不再被 observer 推进，`source_closed` 与 `continued_externally` 不再生效，但 `enqueue` 仍会对其投递。`reserve` 的门禁能兜底回答，但 inbox 状态可能过期。
- P2-d：文档称"优先 session"，但跨 pass 看，先被 run 占满席位后，新 session 会长期 `capacity_exceeded`。这是显式降级，不是静默。

**4. direct send 对 malformed 结构化决策 fail-open：对所给形状有效（确认）**
- `reserveSessionInstruction` 中 legacy 判定要求键集合为 `{question, choices}` 的子集，且 choices 为字符串数组。含 `decision_id` 或 `continuation` 的对象不会命中 legacy；`decision.success` 为真时门禁生效。
- 条件 P2：`snapshot.decision === undefined`（无 turn）时会被判为 `invalid_decision`，取决于 `latestSnapshot` 的返回约定。
- P2：malformed 决策会阻断手动直接发送，而 abandon 需要 attention scope，导致缺少其他手动出口。这是可用性问题。

## 条件性 P1 候选（阻断候选，需补证据）

- **C1 回执处置与 answer 无 RPC 分派**：`SupervisionService.handle` 没有 `attention.answer` 或 `attention.abandon-receipt` 分支，会落入 `unsupported_attention_method`。若 `daemon.ts` 未在别处分派，两者不可达，`delivery_uncertain` 在 attention 范围内也就没有出口。需检查 `daemon.ts`。
- **C2 已放弃消息经同 message_id 重放**：`reserveSessionInstruction` 先执行 `sessions.getMessage(message.message_id)`，命中则直接 `applyInbound`，早于 `delivery_uncertain` 与 resolution 检查。若 `applyInbound` 对已存在且 accepted/failed 的消息会再次分派，`abandon` 承诺的"永不重放"即被破坏。需检查 `sessions.ts`。
- **C3 风险门禁只看最新 snapshot**：`signed_approval_required` 依据 `latestSnapshot(...).decision`。若最新 turn 的 `decision_json` 为 NULL，而较早 turn 的风险门仍在等待，直接 send 会通过。attention 路径会拒绝（`reserve` 中 `SessionDecision.parse(null)` 抛错），直接路径没有等价检查。需确认状态机是否保证最新 turn 必带决策。
- **C4 `delivery_uncertain` 作用范围扩大**：该门禁对所有直接 send 生效。若既有路径中 inbound 消息长期停在 accepted 而非 applied，且 attention 未启用，则无出口，手动发送永久阻断。需核对 `applyInbound` 的状态迁移。

## 其他确认的 P2

- **run 路径源缺失标记为 covered**：`runs` 行消失或 tenant 变化时，`state=source_missing` 但 payload 无 `reason`，`faulty` 不命中，coverage 仍为 covered。这是确认的 false-covered 标签，需补 `reason=source_missing`。触发需本地 DB 变更。
- **交接"无未决回执"仅检查 foreground subjects**：`inventory` 的 coverage 不计 `unresolved_receipts`，同 scope 其他 session 的未决回执不影响交接。与文档表述不一致。
- **`attention.ci` 输入校验缺失**：`head` 与 `github_repo` 只做长度校验，未执行文档中的 40-hex 与 `OWNER/REPO` 格式校验。属本地 owner 面，但应在边界校验。
- **损坏或漂移的 item 阻断整个 session 与 inbox**：单条 `attention_items.decision_json` 损坏，或 `SessionDecision` schema 收紧后，items 循环每轮抛错，该 subject 永久 `invalid_source`。`listItems` 对任一行解析失败会使整个 inbox 请求失败。需本地 DB 损坏或 schema 漂移才会触发。
- **subject catch 吞掉 `stale_owner`**：在外层 `withWrite` 串行化下不可达，属防御性缺陷，P3。

## 不能证明

- `withWrite` 是否可重入。`reserve → store.write → withWrite → reserveSessionInstruction → withWrite` 的嵌套依赖它。
- `SessionDecision` schema、`classifyAttentionWait`、`AttentionCiReader`、`attention-hook`、`readAttentionLoop` 的路径约束均未提供。
- 手动发送与 agent 标签的边界按用户说明处理，本次未将其视为缺陷。

## 剩余阻断项

- 所给源码中无已确认 P1 阻断。
- C1-C3 为条件性 P1，C4 有回归风险。在核对 `daemon.ts` 路由、`applyInbound` 重放与状态迁移、`latestSnapshot` 语义之前，不应宣称 P1 清零。
- 建议补充的测试（当前不存在）：直接 send 复用已 abandon 的 message_id；最新 turn decision 为 NULL 的风险门；release 未准入行；run 源缺失的 coverage；attention.answer 经 RPC 的端到端路径。

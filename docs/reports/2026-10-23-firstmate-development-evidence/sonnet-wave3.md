# 复审结论

只做了静态阅读，没有运行任何测试或工具。我没有发现 P0。下面是仍然存在的 P1 和高价值 P2。

## P1

**1. 恢复和关停路径会重复发送，与“保留记录恢复默认不重复发送”矛盾**（代码证据）
- `recoverDeliveries()` 把 `sending` 改回 `pending`（attempts<5），下一轮 drain 会再发。
- `SupervisionService.stop()` 只做 `clearInterval`，daemon 的 `shutdown` 也不等待 supervision 的 in-flight drain。
- 在 sender 已写入 spool、DB 写回还没完成时关停或崩溃，行会停在 `sending`，重启后重发。
- 超时路径同理：本地 spool 的 `appendFile` 不响应 `signal`，超时后重试可能与迟到的写入重复。
- 建议：
  - 恢复时把 `sending` 置为 `delivery_unknown`，只有显式 `--resend` 才重发。
  - 或者让 spool 按 `delivery_id` 去重，并在 shutdown 里 await 在途 drain。

**2. handoff 回执重放不重验，且覆盖判定与 inventory 不一致**（代码证据）
- `handoff()` 在 `prior` 命中时直接返回，不重验覆盖。
- `valid_until` 取当前 `scope.deadline`，回执表里没有存这个字段。所以 TTL 内重放会拿到“续期”后的回执，即使期间出现了 gap 或版本变化。
- 首次 handoff 只检查列出的 subject，加上全 scope 的 `admitted=0` 和 `sampled_at`。
  - 它不检查未列出 subject 的 `reason` 和 `gap`，也不检查 scope 的 `coverage==='covered'`。
  - 结果是 inventory 显示 degraded 时，handoff 仍可能成功。
- 建议：
  - 把 `valid_until` 和覆盖摘要落库，重放时返回原值并按当前时间标注过期。
  - 抽出一个与 inventory 共用的覆盖判定函数，要求 `covered`。

**3. Loop 源缺失被算作 covered**（代码证据）
- `readAttentionLoop` 对 ENOENT 返回 `state:'source_missing', coverage:'uncovered', gap:'source_missing'`，不抛错。
- `handle('attention.loop')` 仍写入 `reason:'snapshot_only'` 并刷新 `sampled_at`。
- `inventory.faulty` 只看 `reason≠snapshot_only`、`gap==='history_gap'` 和采样时间，所以这个 loop 不会降级。
- 同样，`recovery_required:true`（有 in_progress）也不会降级。
- 建议：
  - source_missing 时写 `reason:'source_missing'`。
  - faulty 改成 gap 白名单，不在白名单内一律降级。

**4. 前台 TTL 固定 120s 且无续期，turn-end 提醒在最需要时不可达**（代码证据）
- `foreground` 的 `expires_at` 是 now+120000。`authenticate` 过期即抛 `invalid_foreground`，`handle` 里也没有续期方法。
- 超过 2 分钟的前台 turn，其 `turn-end` 和 `handoff` 都会失败。
- `turn-end` 只返回一段文字，不涉及权限，没必要要求 token 未过期。
- 建议：
  - 要么提供 renew 方法。
  - 要么让 `turn-end` 校验 token 和 generation 即可，返回 `{foreground_expired:true, reminder}`。

**5. 会话输入通道可能被永久锁死，没有显式出口**（代码证据 + 假设）
- `reserveSessionInstruction` 只要该 session 存在任意 `accepted/failed` 的 inbound 行就抛 `delivery_uncertain`，不分轮次、不分时间。
- 这同时作用于 `session.send` 和 `attention.answer`。
- 你给的 daemon 代码里没有对账或关闭回执的 RPC（假设：其他文件里也没有）。
- 一次适配器失败或崩溃遗留的 `accepted`，会让人类永久无法再向该会话发指令。
- `handleSessionSend` 里仍写着“inspect the session before using a new message_id”，但新 message_id 实际上会被拒。
- 不重发的方向我认可。缺的是人工显式裁决入口，比如标记 not-delivered 或 delivered，并要求证据。

## P2

- **drain 吞吐过低**：每次调用 `LIMIT 1`，而 `scan` 每 30s 才调一次。
  - 100 条积压约需 50 分钟。
  - 退避从 1s 起，但实际粒度是 30s，5 次失败（约 2.5 分钟）就进 dead_letter。
  - dead_letter 没有重新入队的途径。
  - 建议每个 tick 在时间预算内循环多条。
- **`quiet` 作用范围过大且没有过期**：drain 的 `NOT EXISTS ... posture='quiet'` 不区分 actor。任何 actor 遗留的 quiet 都会无限期静默整个 scope。
- **open 项缺少 superseded 状态**：
  - gate 类（risk_approval、task_authorization）项在批准并应用后仍是 open，直到 session 终结。
  - 非最新轮次的 open 项不可答（reserve 会返回 `source_changed`），却会占用 brief、inbox 和通知。
  - 建议在出现更新的轮次后，标记为 `superseded_by_newer_turn`。
- **missing-task 路径不 bump revision**：`scan` 里 task 或 scope 失配时直接 `UPDATE state='source_missing'`，没有 `revision+1`。delivery_id 是 `item:revision`，所以 source_missing 不会触发新通知，已 seen 的 revision 也不会重新浮现。
- **毒轮次会让 subject 的游标永久卡住**：投影失败时游标不推进，后面健康的 decision 永远投影不到。测试只证明了跨 subject 隔离，没有证明跨轮次隔离。建议用 tombstone 加 `history_gap` 越过毒轮次。
- **保留策略缺失**：已过期的 `attention_foregrounds`、`handoffs`、已 delivered 或 superseded 的 `deliveries`、`seen`、已关闭会话的 items 都没有清理。容量上限 100 的设计我不质疑，但这些表无界增长。
- **`withWrite` 用的是延迟 BEGIN**（假设你关心非 daemon 进程也会写这个库）：`assertOwner` 只是读，并不是写入栅栏。目前靠 `SQLITE_BUSY_SNAPSHOT` 兜底，用 `.immediate()` 更稳。
- **`verifyDeliveryContract` 只验自洽**：digest 是对调用方传入的 `raw` 重新算出来，再与调用方传入的 `evidence.digest` 比较，没有已冻结的锚点。在“只做独立规范”的定位下可以接受，但不要把 `verified:true` 当成防篡改证明。
- **loop 读取用 `open` 打开 FIFO 会阻塞线程池**：建议先 `lstat` 确认是普通文件，或用 `O_NONBLOCK`。
- **draining 时所有 `attention.*` 都返回错误，包括只读方法**：覆盖消费者拿到的是错误，而不是诚实的 `uncovered`。

## 测试缺口（建议主 agent 补）
- 崩溃或关停时处于 `sending` 的行，恢复后不重发。
- handoff 重放在出现 gap 后的行为。
- loop 文件缺失时 inventory 应为 degraded。
- 前台超过 120s 后的 turn-end。
- `takeover` 与 grant 的竞态。
- 遗留 `failed` 或 `accepted` 回执后的人工对账路径。

另有一点依赖假设：takeover 只在 DB 里把 grant 置为 `blocked`。内存中 collaborator 的定时器是否在触发时重新校验 grant 状态，我在这份代码里看不到，请主 agent 确认。

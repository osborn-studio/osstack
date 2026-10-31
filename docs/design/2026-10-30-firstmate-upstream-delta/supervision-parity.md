# Firstmate 监督修复对照：上游 af1c681 → df81d81 与 OSStack Attention

日期：2026-10-30。来源：`kunchenguid/firstmate` main，`af1c681..origin/main`（当前 `dbcb5ab`）。[增量 README](README.md) 把四个提交列为“watcher 实现细节，由 OSStack daemon owner / Attention observer 承担，记录为对照用例”。本文逐条核对上游 diff 与测试，说明它防住的故障，对应到 OSStack 机制，并给出处置与证据测试。

## 结论

- 四个指定提交：两条已覆盖（补回归测试证明），一条是真实缺口并已修复，一条不适用。
- 额外扫描到的监督/唤醒/away/quiet 相关提交中，没有新的缺口；一条（`3c1e468`）作为设计对照登记。
- 代码改动只在 `packages/cli/src/supervision-service.ts`：被接管的服务现在自行停止。新增测试在 `packages/cli/src/supervision-parity.test.ts`，两个服务各用独立连接打开同一个数据库文件。

## OSStack 机制速查

| 机制 | 位置 |
|---|---|
| 固定 30 秒周期扫描 + dirty 提示；每轮都重读持久化事实 | `SupervisionService.start/requestScan/scan` |
| owner generation：`claimOwner` 递增，所有写入在事务内 `assertOwner`，旧 generation 抛 `stale_owner` | `AttentionStore.claimOwner/assertOwner/write` |
| 投递认领 → 发送 → 回执，每行各自重试退避 `min(300s, 1s·2^attempts)`，5 次进死信；回执用 `attempts` 与 `state='sending'` 做 CAS | `AttentionExperience.drainBatch/drainOne` |
| 构造时把遗留 `sending` 收回为 `pending`（`interrupted_delivery`） | `AttentionExperience.recoverDeliveries` |
| 观察分片在事务内回滚游标；新 owner 时整片拒绝 | `AttentionObserver.step` |

## 对照表

| 上游提交 | 上游故障（白话） | OSStack 机制 | 处置 | 证据测试 |
|---|---|---|---|---|
| `6613c3e` 可操作心跳唤醒重置退避 | watcher 的心跳间隔在空闲时每次翻倍。心跳兜底扫描找到了被遮住的决定，却仍被记成“空闲心跳”，间隔继续变长，下一件真事要很久才被发现。 | OSStack 的周期扫描就是兜底，间隔固定 30 秒，没有空闲退避，也就没有需要重置的计数。重试退避按投递行计算，新行 `next_at=0`，按 `next_at` 排序先于重试行认领；一条通知在退避中不会推迟另一条。提醒按项目各自退避，已退避的项目被 `WHERE` 排除，下一项照常排入。away 不改变节奏。 | **已覆盖**（补回归测试） | `supervision-parity.test.ts`：“keeps a fixed pass cadence across idle passes and delivers a pass-found decision despite another notice's retry backoff”——6 次空闲周期间隔都是 30 000 ms；A 投递失败进入退避后，仅靠周期扫描（无 dirty 信号）发现的 B 在同一轮送达；之后间隔仍是 30 000 ms。提醒侧：`attention-reminders.test.ts`“waits for the threshold, then schedules only the oldest overdue decision” |
| `8cb06ff` 队列锁失败时保留 wake grant | `fm-wake-grant.sh` 的四个子命令拿锁失败后没有退出，照样改写 grant 记录，退出时还会释放别人的锁。 | 写锁就是 SQLite 事务（`BEGIN IMMEDIATE` + `busy_timeout`）。拿不到锁或认领出错时整个事务回滚：投递行保持 `pending/attempts=0`，不调用 sender；另一个连接的事务不受影响。回执写失败时行停在 `sending`，下一轮先 `recoverDeliveries` 再发，同一 `delivery_id`。锁竞争不会被误判为接管。 | **已覆盖**（补回归测试） | `supervision-parity.test.ts`：“leaves deliveries and another writer's lock intact when the write lock cannot be taken, then delivers”（第二连接持有 `BEGIN IMMEDIATE`，服务连接 `busy_timeout=20`）；“rolls back a failed delivery claim without sending, then sends exactly once”（触发器让认领 UPDATE 失败）。回执侧：`supervision-service.test.ts`“recovers a failed local delivery receipt on the next scan without restart” |
| `ffb2aca` 接管时 watcher 及时停止 | 接管发生在旧 watcher 阻塞于事件等待时，bash 把 TERM 压到等待结束，接管无法在 5 秒内确认停止；新周期把主会话已确认的事件当作停机重新浮出，循环往复。 | 接管 = 新服务 `claimOwner` 得到更高 generation。旧服务的每次写入都被 `assertOwner` 拒绝：迟到的回执写不进去（返回 `stale`），进行中的 Loop 读取提交不了，`recoverDeliveries` 也改不了新 owner 的 `sending` 行。新 owner 构造时把旧的在途发送收回为 `pending`，用同一 `delivery_id` 至多补发一次；已送达的通知按 `INSERT OR IGNORE` 不重发。**缺口**：旧服务虽然什么也写不进，但不会自己停——定时器每 30 秒继续扫描、争抢写锁，在途发送也一直挂着，直到 daemon 关停。 | **缺口，已修复** | 修复：`SupervisionService` 在扫描失败、投递批次失败或出现 `stale` 回执、RPC 抛 `stale_owner` 时重读 owner；确认被更高 generation 接管才置 `takenOver` 并 `stop()`（中止在途读取与发送、清定时器），之后 RPC 抛 `stale_owner`。锁竞争和故障不算接管。测试（两个服务、两个连接、同一数据库文件）：“take-over mid-send …”“take-over before the old receipt …”“take-over mid-scan …”“a stopped old service's timer never wakes after a take-over”。核心层已有：`attention-observer.test.ts`“fences an interrupted slice after owner replacement”，`attention-experience.test.ts`“returns a stale receipt after ownership changes during send”，`supervision-service.test.ts`“fences a stale owner and lets the next service reobserve the persisted binding” |
| `c1669d9` 空闲会话在缓存热时压缩 | Claude 主会话空闲超过 prompt cache 寿命后，下一轮要按写入价重写整个上下文；上游在缓存仍热时发 `/compact`。 | Attention 不托管任何模型会话，也不向会话注入输入；通知只发给本地用户通道。没有 prompt cache 需要保温。 | **不适用** | — 若以后 OSStack 托管长驻模型会话（X06 方向），应在会话适配器里做，而不是 supervision |

## 额外扫描（`af1c681..origin/main` 中与监督/唤醒/away/quiet 相关的其他提交）

| 上游提交 | 内容 | 处置 |
|---|---|---|
| `1973897` 逾期未答决定提醒 | 本分支基线已实现（`attention_reminders`，见 README） | 已实现，`attention-reminders.test.ts` |
| `3c1e468` 监督 host 交还主会话需确认 | host 交还后若续接丢失，home 无人监督且无告警；开关打开后反复提醒直到主会话确认 | **设计对照，无缺口**：OSStack 的后台监督是 daemon 常驻服务，前台 `handoff`/`turn-end` 只改变前台态，不会让 supervision 停止，因此不存在“交还后无人监督”。前台结束提醒一次（`turnEnd`）。本处不改 `attention-experience.ts`（由另一工作线负责） |
| `c0aa730` 已消费 grant 的拒绝信息 | 仅措辞 | 不适用 |
| `ecba405` 合并重复的扩展 host 错误 | 错误去重 | 不适用于 Attention 投递；见下方“未修复登记” |
| `cf577c7`、`417cec2`、`3b82fd8` 等 | PID 复用/锁回收 | README 已归为负例参考：OSStack 用内核锁 + owner generation，不用 PID 文件锁 |
| `d46a643`、`4a67799` | 仅测试时序 | 不移植 |

## 未修复登记（超出本切片文件范围）

1. **daemon 不知道 supervision 已被接管。** 修复后旧服务会停止，但 `daemon.ts` 仍保留 `ctx.supervision`，Attention RPC 会返回 `stale_owner` 而不是让 daemon 自身退出或报告状态。实际生产中两个 daemon 不能同时持有同一 home 的内核锁，接管只会在锁失效（不支持的文件系统、误配 home）时出现，因此是纵深防御。建议：daemon 健康检查读取 `ctx.supervision.takenOver`，为真时记录并退出或在 `osstack stats` 中标红。
2. **接管检测在下一次 owner 校验时才发生。** 旧服务若正阻塞在一次发送中且没有其他访问，最迟在发送超时（≤5 秒）或下一次 30 秒周期时发现接管。上游的约束是 5 秒内确认停止；OSStack 的发送超时同为 5 秒，所以在途发送这一路满足，空闲旧服务最迟 30 秒。若要更短，需要跨进程通知（daemon 层），不在本切片。
3. **扫描错误被静默吞掉。** `requestScan` 的 catch 不记录也不计数，与上游 `ecba405` 的“重复错误合并后上报”相比，OSStack 只能从 coverage 过期间接看出。建议在 daemon 指标层加计数（不改 Attention 读模型）。

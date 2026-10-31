# Firstmate 上游增量 af1c681 → df81d81 与下一切片

日期：2026-10-30。来源：`kunchenguid/firstmate` main，`af1c6817…`（原固定版本）→ `df81d81`（2026-10-30 07:29 PDT），65 个提交，270 个文件，+38,002/−7,338。目录分布：`tests/` 41%、`bin/` 34%、`docs/` 13%、harness 技能参考 7%。

## 结论：不重做设计

上游这一周没有改变架构：仍是 watcher → wake 队列 → 主会话、状态文件折叠、grant/锁、teardown 保全。新增内容主要是更多 harness 与 dispatch provider、以及大量正确性修复。[2026-10-26 路线图](../2026-10-26-firstmate-upgrade/README.md)、24 个 FM ID 和 X01–X08 仍然适用。

处理方式：**固定版本前移到 `df81d81`**，原 `af1c681` 的映射继续有效，本文只登记增量。若再前移，重复本表的分类方法。

## 增量分类

| 类别 | 上游提交 | FM / 工作包 | 处置 |
|---|---|---|---|
| **决定与等待监督** | `1973897` 逾期未答决定提醒；`6613c3e` 可操作心跳唤醒重置退避；`8cb06ff` 队列锁失败时保留 wake grant；`ffb2aca` 接管时 watcher 及时停止；`c1669d9` 空闲会话在缓存热时压缩 | FM-04/05/10，I01/X06 | `1973897` 作为本切片实现；其余为 watcher 实现细节，OSStack 由 daemon owner/Attention observer 承担，记录为对照用例 |
| **交付与保全** | `9905462` local-only 合并固定到已接受 done commit；`2cf6816` 证明补丁落地时保留空白；`2363b71` Git 隐藏未跟踪文件时拒绝 teardown；`b04154b` 报告不可用的 Git containment 证明；`86437e2` 跟踪自有 PR 上的 review-bot 发现 | FM-13/14/23，I03/X02 | 下一批候选：与 OSStack guarded-git、Loop containment 逐条比对 |
| **锁与进程身份** | `417cec2`、`cf577c7`、`3b82fd8`、`7da4c36`、`f6b54af`、`43cd3b7` PID 复用/时区/Windows 锁持有者 | FM-03 | OSStack 用 SQLite owner generation，不移植 PID 文件锁；作为负例参考 |
| **远端 secondmate** | `4415321`、`51a501d`、`d95b8a8`、`df81d81`、`05196e3`、`147b267` | FM-17，X04 | 远端派发仍为后期；记录幂等 steering 与回复读取隔离要求 |
| **harness / provider 扩展** | T3 Code、tern、Cortex Code、agy、omp、Kimi 2.3.0、`47bd9a1` Codex 受限权限、`df9e6ce`/`0f2cf78`/`7647d6b`/`5aaa759` dispatch provider 选择 | FM-15/21，X05 | 不跟随；X05 按实测版本逐格启用 |
| **注册与导出** | `127f0f3` 白名单记录导出；`e13d23f` 每项目 `pr=manual` | FM-19/23 | 后续评估 |
| **CI/测试/文档** | 其余 | — | 不移植 |

## 本切片：逾期未答决定提醒（上游 `1973897`）

**上游行为。** 默认关闭。开启后，每次轮询为最早一个逾期未答的 keyed 决定排入一个提醒 wake。阈值默认 1800 秒；之后间隔从阈值开始，每次翻倍，封顶默认 14400 秒。每个 key 的计划跨 watcher 重启保留。暂停或已交给 captain 的项目不提醒，但也不重置计划。决定解除后停止提醒；再次打开开始新一轮。配置非法时 watcher 报错停止。

**OSStack 落点。** 复用 Attention 已有的决定权威与投递账本，不新增第二套等待或发送存储。

- `attention_items` 中 `state='open'` 的项目即未答决定；`open` 只在插入时出现，离开 `open` 时 revision 递增，所以 `(item_id, revision)` 就是一轮提醒的身份，年龄从 `created_at` 计。
- 新表 `attention_reminders`（迁移 48），每轮一行：计划字段 + 当前一次提醒的投递字段，与 `attention_deliveries` 同列名，由同一 `drainOne` 发送、超时、重试和死信逻辑处理。每次提醒有自己的 `delivery_id`（`<item>:<revision>:r<序号>`），本地 spool 按 ID 幂等，不会被当成首发通知的重复而丢弃。
- `AttentionExperience.scheduleReminders(policy, now)` 每次 supervision 扫描后调用：清除已解除的行；每次调用全局只排入一个最早打开且已到期的提醒。scope 处于 quiet 时不排入也不重置，和首发通知的 quiet 过滤一致。away 不影响提醒。
- 发送给 sender 的消息增加可选 `reminder: { sequence, age_ms }`。提醒只是通知，**不产生任何授权**，risk_approval 类决定同样只提醒。
- 开关：`OSSTACK_ATTENTION_REMINDERS=1`（仍需 `OSSTACK_ATTENTION=1` 与 sender）。`OSSTACK_ATTENTION_REMINDER_OVERDUE_SECS` 默认 1800，`OSSTACK_ATTENTION_REMINDER_BACKOFF_MAX_SECS` 默认 14400；必须是不超过 9 位的规范正整数，且上限不小于阈值；开启时配置非法则 daemon 启动失败。

**允许差异。** 上游提醒唤醒的是主会话模型；OSStack 的等价接收者是用户通知通道。上游按 status log 中的 `[at=]` 计龄；OSStack 用持久项目的 `created_at`。上游 paused/captain-held 豁免对应 OSStack quiet posture；OSStack 目前没有逐项暂停声明，后续若加入，需同样豁免。

**验收。** 阈值前不提醒；到期只排入最早一项；退避翻倍并封顶；重启（新 owner generation）后计划保留；解除后行被清除、投递被 superseded；quiet 不排入不重置；非法配置拒绝；与首发通知 delivery_id 不冲突；本地 spool 收到 `reminder` 字段。

**迁移注意。** main 当前同样停在 47。本分支新增 48 后，若 main 另行占用 48，两条线的 home 不能互相打开；合并回 main 前必须重新编号并经迁移谱系测试。

## 本切片：回归简报（I01/X06，FM-10/11；上游 `afk` “How to exit: the return” 与 `bin/fm-afk-return.sh`，`dbcb5ab`）

**上游行为。** away 期间第一条真实消息即为回归信号；重复 `/afk` 只刷新、不退出；`/quiet` 下的普通消息不退出。回归时 `fm-afk-return.sh` 从持久记录（而非对话记忆）按固定顺序渲染回归简报：监督健康、away 指令及据此采取的动作、等你处理的事项、尝试失败或无法修复的事项、已落地待清理、away 期间已处理、成本。随后 catch-up gate 保留每个未证实解除的 `blocked:`，不静默丢弃任何未结事项。

**OSStack 落点。** 迁移 49 只增事实，不加第二套权威：

- `attention_postures.entered_at`：posture 进入时间。重复设置当前 posture 保留起点（对应重复 `/afk` 只刷新）；离开再进入 away 则重置区间。49 之前的行为 NULL，回归时标为 `since_known:false`，从头读取且仍有上限。
- `attention_item_settlements`：决定离开等待集合（`open`/`answer_uncertain`/`source_missing`）的时间，由 `attention_items` 上的触发器取该次转换自身的 `updated_at` 写入，覆盖所有结算路径；observer 的 `source_closed`/`continued_externally` 转换补写 `updated_at`。
- `attention_dead_letters`：首发通知与提醒每次死信一行及其时间（含重启恢复判死）。时间取发送实际失败或超时的时刻（claim 时钟加发送耗时），而非 claim 时刻，否则 away 前开始、away 后失败的发送会落在区间外。提醒行按序号复用，只看 outbox 会丢失较早的死信。
- 提醒计划在决定处于整个等待集合（含 `answer_uncertain`）期间保留，只有 `open` 会被排入新提醒；否则 uncertain 决定在简报中的提醒次数会归零。
- 纯读函数 `readAttentionReturnBrief(db, {scope_id, since, now, limit})`，区间 `[since, now]` 两端闭合，只执行 SELECT，可在只读连接或调用方写事务中运行。三节：(a) waiting_on_you — 全部未结决定，最早在前，带年龄与已排提醒次数；(b) changed_while_away — 区间内新开、区间内解除（解除后又回到等待集合的计入 (a) 而非 (b)）；(c) delivery_problems — 区间内死信，另报未带时间的旧死信数 `undated`。每节都有 `total`/`omitted`，列表默认 20、上限 100，排序确定。
- `AttentionExperience.posture` 在同一事务内写 posture，away → attended 时返回该区间的 `return_brief`；`returnBrief()` 与 RPC `attention.return-brief`、CLI `osstack attention return-brief` 只读预览。posture 写入仍受 owner generation 约束，stale owner 被拒。结果固定 `execution_takeover:false`、`authority:"none"`。

**允许差异。** 上游以第一条真实消息隐式回归；OSStack 由显式 posture 写入回归（守护进程看不到对话）。上游简报的健康、away 指令、成本、待清理任务各节在 OSStack 分属 daemon doctor、Loop 与 Engineering 读模型，本切片只覆盖 Attention 决定与投递；后续可在 cockpit 聚合。上游 catch-up gate 阻止回归后继续派发；OSStack 不加 gate——简报不授予也不收回权限，未结决定始终在 (a) 中完整计数。quiet → attended 不生成简报，与上游 `/quiet` 不触发回归一致；away → quiet 也不算回归。

**验收。** 区间边界两端闭合且区间外事件不计；有上限时未结决定总数与省略数准确；quiet 与 away 区分；重复 away 保留起点、再次进入 away 重置区间；49 之前的 away 行标为未知区间；stale owner 写 posture 被拒且 posture 不变；只读预览不产生写入并可在只读连接上得到同一结果；observer 关闭决定时记录观测时间；首发通知、提醒与恢复判死的死信均带时间列出。

**迁移注意。** 本分支在 48 之上新增 49。main 若另行占用 48 或 49，合并前须整体重新编号，并同步更新 managed upgrade 与只读状态视图的 schema 门限及迁移谱系测试。

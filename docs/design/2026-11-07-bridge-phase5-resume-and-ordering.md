# 阶段 5 补充：同子 Mission 恢复、决定顺序、停止链扫描与确认事务

日期：2026-11-07。基线：`main` `ccef9bb4`（含 5-B #397、W13-C1 #399）。行号均指这一基线。
上位文档：[阶段 5 附录](2026-11-06-bridge-same-pr-revision.md)（下称“附录”）、[W13 设计](2026-11-06-w13-host-git-survival.md)（下称“W13”）、[TLA+ 模型说明](specs/README.md)（下称“模型说明”）的“Discrepancies”表；执行图 [graph.md](../plans/bridge-graph/graph.md) 节点 N7–N10。

模型说明列出的 D4、D7、D8、D9、D10 在附录里没有协议：D9 由附录 §7 偏差 17 留给 5-E，D10 只在附录 §5.3 第 6 步写了顺序，D4、D7、D8 是模型与代码对照时发现的空缺。本文给出这五项的合同、失败后的状态、测试和归属的 PR。不改代码，不改附录正文。

## 1. 总表

| # | 问题 | 本文的决定 | PR | TLA 模型 |
|---|---|---|---|---|
| D9 | 子 Mission 停机后由人恢复同一个子 Mission，链怎样离开 `awaiting_decision` | 人对子 Mission 的 `mission decide` 在 runner 入口同步调用 `acknowledgeAdvance`，满足 §3.4 的前提时由新方法 `resumeChild` 把链转回 `revising`；子非终态时再授不再恢复链（§3.5）；已落地的一轮走“只确认”路径（§3.8）；其余停止原因不能这样恢复 | 5-E | 要改（5-F）：加 `HumanResumeChild`、`LandedConfirm` 与三个变异 |
| D8 | `decideChainStep` 在途时先返回 `in_flight`，冲突与截止不再判断 | 保留：冲突、截止、评审变化在途时不是停止条件；但把 base 检查移到 `pending_push_head` 的提前返回之前 | 5-E | 前半不改；后半改 `Decide` 的一行顺序并重跑 |
| D7 | `listOpen` 不扫 `awaiting_decision` 链，PR 关闭后链仍停着 | live 模式下另起低频扫描：只读 PR 事实，只记录、显示；唯一的写入是 PR 已关闭或合并时转 `closed`（决定 R4）；从不恢复 | 5-E | 要改（5-F）：加 `ReconcileStopped` |
| D10 | 确认要跨链 store 与 Mission 账本，`settleIntent` 不碰账本 | 一个 `chainStore.transaction`，固定 7 步顺序，前置复核不过即整体回滚并改走 `reconcileReceipt`；在线与恢复共用同一函数 | 5-C | 不改（模型的分步 `ChildPublished` 覆盖原子版本） |
| D4 | `settleIntent('failed')` 不停链；`stopLive` 不接受 `base_changed` 等原因 | `publish_refused:<code>` 映射表（§7）；规则“先停链、后结算 `failed`、同一事务内停子 Mission” | 5-C（栅栏码 5-D） | 不改 |

## 2. 现状核对

| 事实 | 位置 | 对本文的影响 |
|---|---|---|
| `listOpen` 排除 `closed` 与 `awaiting_decision` | `engineering-revision-chain-store.ts` L132–137 | D7：停住的链不再被读，PR 关闭也看不到 |
| `decideChainStep` 的顺序：链 `closed` → 快照不完整 → PR 非 open（转 `closed`）→ 链 `awaiting_decision`（`none`）→ head 归属（L138–143，其中 L141 `pending_push_head` 提前返回 `publish_in_progress`）→ base（L144）→ 已确认 head（L145–147）→ 在途（L148 `in_flight`）→ 冲突（L157）……截止（L191，只在 `awaiting_review`） | `revision-chain.ts` L120–196 | D8 |
| 停住的链只能被 `transition → closed` 改动；离开 `awaiting_decision` 的其他转换一律 `transition_denied` | store L537–542（D12） | D9 需要专用方法，不能经 `applyDecision` |
| 离开 `awaiting_decision` 时有 `pending`/`uncertain` 推送意图即 `intent_unsettled` | store L583–585（D1） | D9 的前提由数据库层兜底 |
| `settleIntent('failed')` 只在链在途且当前子是该意图的子时停链，原因固定为 `intent_failed`；`uncertain` 停任何未停的链 | store L280–285 | D4：若先结算再停链，具体原因写不进去 |
| `stopLive` 只接受 `LIVE_STOP_REASONS` 与 `publish_refused:*`；`base_changed`、`external_write`、`head_regressed` 不在其中 | store L364–366；`revision-grant.ts` L29–32 | D4：发布路径无法用 `stopLive` 写这三种原因 |
| `replaceGrant` 只对 `RENEWABLE_STOP_REASONS` 生效；子非终态时恢复为 `revising`，只要该子有**任何**推送意图（含 `failed`）就恢复为 `publishing` | store L310、L333–336；`revision-grant.ts` L35 | D9 §3.10 |
| 5-B 的链检查在链 `awaiting_decision` 时一律拒绝（“只有再授能重启链”） | `contained-mission-revision.ts` L121–132（L129） | D9 要改这条 |
| `discard_changes`、`adopt_worktree` 被链检查拒绝时把子 Mission **停到** `awaiting_decision(chain_stopped:*)`；`needs_reconciliation` 的两个决定从此不可用，`chain_stopped:*` 没有任何决定能离开（只能 `abandon`） | `contained-mission-runner.ts` L255–257、L270–273、L303–305；`decide` L164–178 | D9 §3.11：决定入口的拒绝必须抛错、不改子 Mission |
| `approve_publication` 直接转 `revalidating`，不经链检查 | runner L172–173 | D9：守卫放在 `decide` 入口，覆盖它 |
| 修订子 Mission 到 `delivering` 即停 `publication_failed:revision_publisher_unavailable` | runner L617 | 5-C 替换为 `deliverRevision` |
| `host.decide` 在 `track()` 内运行；`track` 先调用 `fn()`、后 `inFlight.set` | `contained-mission-host.ts` L127–146、L376–384 | D9 §3.7 需要先登记再运行 |
| `settleStopped` 是顶层事务（`topLevel()`），按 `route` 出 `stop_unknown`：`delivering` → `awaiting_decision(publication_failed:host_process_recovered)`，`authorized` → `awaiting_decision(workspace_recovered)`，`default` → `needs_reconciliation(stop_evidence_recovered)` | `engineering-host-process-store.ts` L197–215；host L251–261 | D9 §3.1、D10 的事务边界 |

## 3. D9：恢复同一个子 Mission

### 3.1 子 Mission 停在哪里、人能做什么

只列修订子 Mission（规格带 `publish_target`）。“首个工作入口”是决定之后第一个产生工作或启动的地方，“启动类型”决定 §3.4 第 8 条查哪一份预算。

| 子 Mission 状态与原因 | 怎样来的 | 允许的决定 | 首个工作入口 | 启动类型 |
|---|---|---|---|---|
| `needs_reconciliation(orphaned_*)`、`needs_reconciliation(stop_evidence_recovered)` | 重启后结算孤儿（host L231–247），或 W13 `route=default` 出口 | `discard_changes` | `discardChanges` 入口（先于 `restoreWorkspace`） | executor |
| 同上 | 同上 | `adopt_worktree` | `adoptWorktree` 入口 | 无（之后 `verify` 收 container） |
| `awaiting_decision(repair_cycles_exhausted)` | 修复额度用完 | `extra_repair` | `extraRepair` 入口（先于 `probe`） | executor |
| `awaiting_decision(publication_failed:<code>)`、`awaiting_decision(revalidation_failed:<code>)` | 发布被拒（§7）或重验不过 | `approve_publication` | `decide` 内 `go('revalidating')` 之前 | 无 |
| `awaiting_decision(publication_failed:host_process_recovered)` | W13 `route=delivering` 出口 | `approve_publication` | 同上；若本轮已落地走 §3.8 | 无 |
| `awaiting_decision(workspace_recovered)` | W13 `route=authorized` 出口 | `resume_workspace` | `resumeWorkspace` 入口 | 无（随后 `workspace_ready` 收 executor） |
| `awaiting_decision(budget_exhausted)`、`awaiting_decision(grant_stopped:*)` | `chargeLaunch` 拒绝，或决定路径上 `assertActive` 的授权与预算失败（§3.11） | `resume_budget`、`resume_grant`（先 `grant-revisions --chain`） | `resume()` 按 `blocked` 路由重入（runner L191–214）。链在再授后停在 `child_halted`（§3.5），由本节的守卫恢复 | 按 `blocked` 路由 |
| `awaiting_decision(chain_stopped:<r>)` | 链在工作入口被发现已停（§3.11） | 只有 `abandon` | — | — |
| `stop_unknown` | W13 证明不了停止 | 只有 `retry_stop_check`（W13 §5.5）与 `abandon` | — | — |
| `cancel_requested` | 取消 | 无 | — | — |

`stop_unknown` 不是可恢复的停机：人先 `retry_stop_check`，`settleStopped` 按 `route` 出到上表某一行之后，才适用本节。

### 3.2 哪些链停止原因允许同子恢复

集合 `SAME_CHILD_RESUMABLE`（新常量，`revision-grant.ts`）：

| 链 `stop_reason` | 同子恢复 | 理由 |
|---|---|---|
| `child_halted` | 是 | 链停只因子 Mission 停机，链自己的事实未变 |
| `publish_refused:<code>`，`code` 在 §7 表中标“可” | 是 | 发布前被本地或瞬时原因拒绝，远端未被写（意图已 `failed`） |
| `intent_uncertain` | 否；本轮若已确认落地，走 §3.8 | 回执可能还会落地（D1） |
| `budget_exhausted`、`grant_expired`、`grant_invalid`、`rounds_exhausted` | 否；用 `grant-revisions --chain`（附录 §5.1） | 授权或额度问题，需要新的签名授权 |
| `base_changed`、`external_write`、`head_regressed`、`protected_set_changed`、`reviewer_conflict`、`no_feedback`、`review_deadline`、`attribution_unknown`、`dispatch_failed`、`child_cancelled`、`child_failed`、`intent_failed`、其余 `publish_refused:*` | 否 | 链的事实或授权变了，或子已终态；只能 `chain-decide abandon|takeover` |

`intent_failed` 在 D4 之后不应再由 live 路径写出（§7 规则 2）；仍出现时按不可恢复处理，并由 5-F 的变异测试保证没有路径写它。

### 3.3 由谁、在哪里触发

**决定 R1（推荐 a）：**(a) 人对子 Mission 执行一次 `osstack mission decide --mission <子> --decision <d>`，runner 在 `decide()` 的第一行（选择处理分支之前）对修订子 Mission 调用 `ports.revision.acknowledgeAdvance(m, spec, decision.kind)`，满足前提就在一个事务里把链转回 `revising`，再进入决定本身。这是附录 §4.4 与偏差 8 已写下的做法，人只做一次决定。(b) 备选：新增 `chain-decide --decision resume_child`，人先恢复链、再决定子 Mission；两步之间链在途而子停机，同步规则（§3.7）会立刻再停链，需要再加一个“恢复租约”，更复杂，不推荐。

端口（`ContainedRevisionPort` 加一项，5-E）：

```ts
acknowledgeAdvance: (mission: ContainedMission, spec: ContainedMissionSpec, decision: ContainedDecision['kind'])
  => 'in_flight' | 'resumed' | 'landed';   // 拒绝时抛 RevisionLaunchRefused(code)，不写任何东西
```

- `in_flight`：链已在途（`revising`/`publishing`）且 `current_mission_id` 是它，不写。
- `resumed`：本次把链从 `awaiting_decision(SAME_CHILD_RESUMABLE)` 转回 `revising`。
- `landed`：本轮推送已确认落地（§3.8），只允许 `approve_publication`，链不改。
- `abandon` 与 `retry_stop_check` 不经守卫：它们只减少权限。

拒绝在**决定入口**抛 `resume_refused:<code>`（同 runner L198–199 的写法），子 Mission 的状态与停机原因保持不变，人改正条件后可以再决定。只有 runner 自己推进（`step()` 路径）时，链检查失败才把子 Mission 停到 `chain_stopped:*`。

### 3.4 前提

全部在 `acknowledgeAdvance` 中同步检查；第 1–7 条在 store 方法 `resumeChild` 的同一个 `BEGIN IMMEDIATE` 里再查一次（数据库是第二道）。

| # | 前提 | 检查位置 | 失败码 |
|---|---|---|---|
| 1 | 链 `mode='live'`、`state='awaiting_decision'`、`stop_reason ∈ SAME_CHILD_RESUMABLE`，且等于调用方读到的值（防止读后被改） | `resumeChild` | `chain_not_resumable:<reason>` |
| 2 | `current_mission_id = 子` | `resumeChild` | `not_current_child` |
| 3 | 该子的预留为 `dispatched`（`engineering_revision_reservations` 中 `chain_id`、`child_mission_id` 对应行） | `resumeChild` | `reservation_not_dispatched` |
| 4 | 子 Mission 非终态，状态与原因在 §3.1 表中允许该决定；`stop_obligation=0`；`engineering_host_processes` 中该 Mission 没有 `state<>'stopped'` 的行；认领 `active` | `resumeChild`（读 `engineering_contained_missions`、`engineering_host_processes`、`engineering_workspace_claims`） | `child_stop_unproven`、`child_claim_released`、`decision_not_allowed` |
| 5 | 本链没有 `pending`/`uncertain` 推送意图（D1；`update` L583–585 再兜一次） | `resumeChild` | `intent_unsettled` |
| 6 | 本链没有该子的 `confirmed` 推送意图（有则本轮已落地，走 §3.8） | `resumeChild` | `round_landed` |
| 7 | grant 未过期（store 时钟） | `resumeChild`（`assertGrantLive`，store L565–569） | `grant_expired` |
| 8 | 完整的 `assertGrantLive`（签名、绑定、有效期、墙钟预算、`access.refresh` 的 write scope，`contained-mission-grant.ts` L134–148）；该子的分配余额 ≥ 决定的启动类型的一次上限（§3.1 最后一列；无启动的决定不查） | `acknowledgeAdvance`，紧挨在 `resumeChild` 之前，中间无 `await` | `grant_expired`、`grant_invalid`、`budget_exhausted` |
| 9 | 决定人对子 Mission 的 scope 有 write（`host.decide` L128–129 已查）；子 scope 等于 `grant.scope_id`（派发时保证） | `host.decide` | `permission_denied` |
| 10 | D7 扫描最近一次记录的事实（§5）没有显示 PR 已非 open、head ≠ `published_head` 或 base ≠ `published_base` | `acknowledgeAdvance` 读链事件 `stopped_chain_observed` 的最新一条 | `facts_changed` |
| 11 | `OSSTACK_BRIDGE=1` | `acknowledgeAdvance` | `bridge_live_disabled` |

第 8 条失败不能“停链”（链已停）；人要先 `grant-revisions --chain`（§3.10）。第 10 条不是安全的依据，只是不让人在已知事实改变时开始一轮浪费的执行：恢复后链在途，live 周期 ≤ 60 秒内会读快照；head 被改动由 `publishRevision` 第 2 步与租约拦住；PR 关闭与 base 变化只由第 2 步的读取发现，第 2 步之后发生的这两种变化客户端拦不住（§4.1 末），由第 6 步读回事后处理。

### 3.5 `resumeChild`

`RevisionChainStore.resumeChild(chainId, ifRevision, input: { child_mission_id; expected_stop_reason; decision }, now): RevisionChain`（5-E，新增）：

1. `checked(chainId, ifRevision)`；按 §3.4 第 1–7 条检查。
2. `update(chain, { state: 'revising', stop_reason: null }, 'child_resumed', { head: published_head, base: published_base }, now)`。目标恒为 `revising`：第 5、6 条保证这时该子没有未结或已确认的推送，`recordIntent`（L228）在下一次推送时把链转为 `publishing`。
3. 链事件 `child_resumed { child, decision, from_reason, child_state, child_revision }`。

不改 `rounds_used`（同一轮）、不改 `current_mission_id`（不触发 L52–63 的触发器）、不改预留、不改 `spent_json`、不改 `review_deadline`（截止只约束 `awaiting_review`）。

**改 `replaceGrant`（L321–349）：当前子非终态时不再恢复链。** 现在的写法把链恢复为 `revising`/`publishing`，等人随后 `resume_budget`/`resume_grant`；但两次请求之间子仍停机、链却在途、`isBusy` 为假，§3.7 的同步规则会立刻把链停为 `child_halted`，随后 `resume_*` 因链不在途被拒。改为：子非终态时，`replaceGrant` 替换 grant、重设 `review_deadline`、按 L338–346 追加分配，链**保持** `awaiting_decision`，原因改为 `child_halted`（事件 `grant_replaced.restored_state = 'awaiting_decision'`）；该子有 `confirmed` 推送意图时拒绝（`round_landed`，走 §3.8）。人随后对子 Mission 的 `resume_budget`/`resume_grant`/`approve_publication` 经守卫由 `resumeChild` 恢复链。子为空或已终态时仍转 `awaiting_review`（不变）。这样“链在途”只在 `resumeChild` 与派发两处产生。这一条改变附录 §5.1 再授情况 (b)“链回到它停止前的在途状态”与已合并的 5-A 行为，5-E 同时改 `replaceGrant` 及其测试（`engineering-revision-grant-store.test.ts`）。

### 3.6 预留、意图与 D1

- **预留**：子停机期间保持 `dispatched`（子非终态时没有任何路径 `void` 它）。恢复要求它仍是 `dispatched`（第 3 条）。子转终态时由同步规则 `void`（§3.9）。
- **未结意图**：第 5 条与 `update` 的 D1 检查共同保证恢复时不存在可能还会落地的推送。子 Mission 在 `delivering` 中崩溃时，恢复顺序为 `host.recover()`（W13：证明进程停止或转 `stop_unknown`；全部已证明或没有登记时 `delivering` 原样留给重试，host L192–225）→ `revisionRecovery()`（附录 §5.5：没有登记或 `released_at IS NULL` → 按 §7 规则在一个事务里 `stopLive('publish_refused:never_released')`、结算 `failed`、把仍为 `delivering` 的子停到 `publication_failed:never_released`；已放行且已停止 → 读远端结算；已放行未停止 → 不结算）。所以只要还有一条已放行而未证明停止的推送，链就停在 `intent_uncertain`，同子恢复被第 1 条与第 5 条拒绝。
- **同步规则选原因**（§3.7 表）：子停机时，若本链有该子的 `pending`/`uncertain` 推送意图且其登记 `released_at IS NOT NULL`（或意图已 `uncertain`），停止原因写 `intent_uncertain`，否则写 `child_halted`。子停机时本守护进程里没有它的发布在跑，`released_at` 不会再变，所以这个判断稳定。

### 3.7 与子 Mission → 链同步的竞态

5-E 的 live 周期第 1 步（附录 §5.5）把子 Mission 状态同步到链。加上 D9 之后的规则：

| 子 Mission | 链 | 动作 |
|---|---|---|
| 非终态停机（`awaiting_decision`/`needs_reconciliation`/`stop_unknown`），且 `host.isBusy(子)` 为假 | 在途，`current_mission_id = 子` | `stopLive(§3.6 选出的原因)` |
| 同上，`host.isBusy(子)` 为真 | 在途 | 不动（人的决定正在进行） |
| 非终态停机 | `awaiting_decision` | 不动 |
| 终态 `cancelled`/`abandoned`/`failed`，停止已证明 | 在途 | 一个事务：`stopLive('child_cancelled'|'child_failed')` + `voidReservation(…,'child_<终态>')` |
| 同上 | `awaiting_decision(SAME_CHILD_RESUMABLE)` | 一个事务：`restopLive(→ 'child_cancelled'|'child_failed')`（§3.9）+ `voidReservation` |
| 终态、停止已证明、认领 `active` | 任意 | `releaseClaim(子,'revision_settled')` |

`host.isBusy(missionId)`（新，同步，返回 `inFlight.has`）。为不依赖“`fn()` 的第一段同步代码跑完才 `inFlight.set`”这一细节，`track()` 改为先 `inFlight.set` 再调用 `fn`（host L376–384）。同步规则在调用 `stopLive` 的同一段同步代码里读 `isBusy`，两者之间没有 `await`；守护进程只有一个 owner，所以检查与写入对人的决定是原子的。

崩溃：`resumeChild` 已提交、子 Mission 的第一次转换尚未发生时崩溃 → 重启后 `inFlight` 为空，同步规则看到“子停机、链在途”，再停为 `child_halted`；人重新决定。决定本身失败而子 Mission 未变（例如 `restoreWorkspace` 抛错后子仍为 `needs_reconciliation`）→ 同理，下一周期再停链。这两种情况都是“链在途而子停机”，期间没有推送的可能：推送要求子为 `delivering` 且通过栅栏（附录 §5.4）。

### 3.8 已落地的一轮（只确认）

W13 恢复把发布中的子 Mission 转到 `awaiting_decision(publication_failed:host_process_recovered)`，之后 `revisionRecovery` 读到远端已是 `new_head` 且范围相符，按附录 §4.1 第 3 条的表先 `stopLive('intent_uncertain')`、再 `reconcileReceipt` 确认推送事实（`published_head = new_head`），子 Mission 原样保留。附录没有写这条链之后怎样回到 `awaiting_review`：`approve_publication` 会再走发布，而 `publishRevision` 的前置检查 `start_commit === published_head` 必然失败；`chain-decide` 只有放弃、接管与对账。所以链只能被关闭，已完成的一轮作废。

**合同：** 条件全部成立时 `acknowledgeAdvance` 返回 `landed`，只允许 `approve_publication`：

- 本链有该子的推送意图 I：`state='confirmed'`、`new_head = published_head`、`expected_base_sha = published_base`；本链没有 `pending`/`uncertain` 推送意图；
- 子 Mission `awaiting_decision(publication_failed:*)`，`candidate_head = I.new_head`，`stop_obligation=0`，没有未结登记，认领 `active`；
- 该子的预留仍为 `dispatched`；
- 链为 `awaiting_decision` 且 `stop_reason ∈ {intent_uncertain} ∪ SAME_CHILD_RESUMABLE`（`replaceGrant` 对已落地的一轮拒绝 `round_landed`，§3.5，所以链不会在途）；其他停止原因只能 `chain-decide`；
- §3.4 第 10、11 条。不查授权与预算：只确认不写分支，链回到 `awaiting_review` 后下一次派发仍经 `enforceGrantLive`（附录 §5.2 第 3 步）。

以上是**准入**条件（决定时，子为 `awaiting_decision`）。准入之后子经 `revalidating` 进入 `delivering`（runner L601–607），所以确认事务第 0 步检查的是**提交**条件（§6.1）：子为 `delivering`、修订号等于本次 `permit`、`candidate_head = I.new_head`；I 仍 `confirmed`、仍是该子最新的推送意图、`new_head = published_head`；链仍为准入时的停止原因；无未结意图；无未结登记。路由不需要持久化：`deliverRevision` 第 0 步每次都从“该子最新意图为 `confirmed`”重新推出（§6.2），所以准入之后崩溃，重启后 `tick` 推进到 `deliver` 时仍走只确认。

**路径：** `approve_publication` → `revalidating` → `deliverRevision` 的第 0 步（§6.2）发现 I 已 `confirmed` 且属于本子 → 不写新意图、不推送 → 附录 §5.3 第 6 步的读回（PR open、`headRefOid = new_head`、base 未变、`ls-remote = new_head`、`compare` 列表等于 `push_range`）→ §6 的确认事务的“已落地”变体：第 ① 步换成新 store 方法 `resumeLanded(chainId, ifRevision, intentId, now)`（链 `awaiting_decision`/`revising`/`publishing` → `awaiting_review`，`stop_reason=null`，事件 `round_confirmed_after_recovery`；要求 I 如上、无未结意图），其余 ②–⑦ 不变。读回不符 → 子回到 `awaiting_decision(publication_failed:<code>)`，链若在途则按 §7 停止，已停则不改。

**决定 R3（推荐 a）：**(a) 只确认由人的 `approve_publication` 触发（附录 §4.1 第 3 条保留“人用 `mission decide` 处理”）；(b) 由 `revisionRecovery` 在确认推送事实后自动执行。

### 3.9 子 Mission 放弃或取消之后

链停在 `child_halted` 时，人也可能 `abandon` 子 Mission。子终态后链不能再同子恢复（第 4 条），但 `stop_reason` 仍是 `child_halted`，`mission status` 会误导。新方法 `restopLive(chainId, ifRevision, to, now)`（5-E）只允许在 `awaiting_decision` 内改原因，白名单：`SAME_CHILD_RESUMABLE` 中的任一原因 → `child_cancelled`/`child_failed`，前提是当前子已终态。它不离开 `awaiting_decision`，不受 D1 限制，也不能把原因改成任何可恢复的原因。

### 3.10 授权或预算在停机期间失效

第 8 条失败时，链停在 `child_halted`，而 `child_halted` 不在 `RENEWABLE_STOP_REASONS`，人只能关闭链。

**决定 R2（推荐 a）：**(a) 再授也接受 `awaiting_decision(child_halted)` 与 `awaiting_decision(publish_refused:<可>)`，按 §3.5 的新规则保持停止（原因为 `child_halted`），只替换 grant、重设 `review_deadline`、预算提高时追加分配；之后人照常对子 Mission 决定，`acknowledgeAdvance` 再按 §3.4 检查。前提与现有再授相同（无未结推送意图）。要改两处，不能只改 store：服务层的 `buildRenew`（`contained-mission-grant.ts` L349–356，预览与最终签名重算都经过它，L244、L269）现在用 `RENEWABLE_STOP_REASONS` 拒绝 `chain_not_renewable`，store 的 `replaceGrant` 用同一集合（L310）。新增集合 `REFRESHABLE_STOP_REASONS = RENEWABLE_STOP_REASONS ∪ {child_halted} ∪ {publish_refused:<可>}` 表示“可以换 grant”，两处都改用它；“换 grant 之后链去哪”只由 §3.5 的规则决定（子非终态 → 保持停止；否则 → `awaiting_review`；`publish_refused:<可>` 且子为空或已终态的情况不存在，因为该原因只在子在途时写出）。(b) 不支持：这种链只能 `chain-decide abandon`，这一轮作废。

### 3.11 与 5-B 的关系（附录偏差 17）

5-B 把 `acknowledgeAdvance` 延后到 5-E。5-E 要改的地方：

1. `createRevisionLaunchPort` 加 `acknowledgeAdvance`；`chainOf`（L121–132）的注释与 L129 的拒绝保留给 `chargeLaunch`/`assertActive`（runner 自己推进时链必须已在途），恢复只经 `acknowledgeAdvance`。
2. `runner.decide()`（L164–178）：对有 `publish_target` 的规格，在选择处理分支之前调用守卫；拒绝时抛 `resume_refused:<code>`，**不**调用 `halt`。`abandon` 不经守卫。
3. `discardChanges`（L255–257）与 `adoptWorktree`（L270–273、L303–305）的链检查保留，但在决定路径上失败时**不再停到 `chain_stopped:*`**：`discardChanges` 在 `restoreWorkspace` 与 `probe` 两次 `await` 之后、`adoptWorktree` 在读 diff 之后才检查，期间 grant 可能过期或 scope 被撤（`assertActive` 做完整的 `assertGrantLive`，`contained-mission-revision.ts` L159–160，`contained-mission-grant.ts` L134–146），一旦停到 `chain_stopped:grant_expired` 就只能 `abandon`。改为：这两处失败时子 Mission 保持 `needs_reconciliation` 不变（第一次状态转换都在检查之后，L259–260；`restoreWorkspace` 只是把 worktree 重置到 `expected_head`，重做无害），决定抛 `resume_refused:<code>`；链若仍在途，由同步规则停为 `child_halted`，人按 §3.10 再授后重做同一个决定。`charged`（L216–228）里 `chargeLaunch` 的失败照旧映射为 `budget_exhausted`/`grant_stopped:<code>`（带 `blocked`，可 `resume_*`），其他码停到 `chain_stopped:*`（原因必为不可同子恢复的那几种；`child_halted` 被 §3.7 的 `isBusy` 排除）。`step()` 路径（runner 自己推进）的拒绝规则不变。
4. `resume_workspace`（runner `resumeWorkspace`）目前不经链检查，由第 2 条的守卫覆盖。
5. `approve_publication` 由第 2 条的守卫覆盖；`landed` 时继续，`deliverRevision` 走 §3.8。

### 3.12 失败 → 状态

| 情形 | 链 | 子 Mission | 预留 | 意图 |
|---|---|---|---|---|
| 守卫任一前提不成立 | 不变 | 不变（决定抛 `resume_refused:<code>`） | 不变 | 不变 |
| `resumeChild` 提交，决定成功推进 | `revising` | 按决定推进 | `dispatched` | 不变 |
| `resumeChild` 提交，决定失败且子未变 | `revising`，下一周期再停 `child_halted` | 不变 | `dispatched` | 不变 |
| `resumeChild` 提交后崩溃 | 重启后同上 | 不变 | `dispatched` | 不变 |
| 恢复后链被 live 周期停止（head/base/关闭） | 按附录 §4.4 | 下一个入口停 `chain_stopped:*`，或被请求取消 | 按附录 §4.4 | — |
| `landed` 读回不符 | 已停则不变；在途则按 §7 | `awaiting_decision(publication_failed:<code>)` | `dispatched` | 不变（已 `confirmed`） |

### 3.13 测试（5-E）

- store：`resumeChild` 对 §3.4 第 1–7 条各一条拒绝用例；成功用例断言状态、事件、`rounds_used`/预留/`spent_json` 不变；有 `pending` 与 `uncertain` 意图时被 `intent_unsettled` 拒绝（经 `update` 的 D1，去掉 `resumeChild` 自己的检查后仍失败）；`replaceGrant` 新规则（`round_landed`、恢复为 `revising`）；`restopLive` 白名单。
- runner：对 §3.1 每一行的允许决定，在链为 `child_halted`、`publish_refused:<可>`、`publish_refused:<不可>`、`base_changed`、`closed` 时各跑一次：前两种恢复并推进；后三种抛 `resume_refused:*` 且子 Mission 的状态、原因、修订号不变（这条对 `discard_changes`、`adopt_worktree` 是回归测试：5-B 现在会把子停到 `chain_stopped:*`）。
- 竞态：`resumeChild` 后、子转换前运行同步规则，`isBusy` 为真时不停链；模拟崩溃（清空 `inFlight`）后停链为 `child_halted`。
- `stop_unknown` 子：守卫拒绝；`retry_stop_check` 证明后按 `route` 出口，再决定成功。
- 已落地：构造 W13 恢复 + `reconcileReceipt` 后的状态（链 `published_head = I.new_head`，预留仍以 `I.expected_old_head` 为键），`approve_publication` 不调用推送端口、走只确认事务，链 `awaiting_review`、子 `pr_opened`、预留 `void('published')`、有 check 意图；读回 PR 已关闭时不确认；准入后、进入 `delivering` 前与之后各崩溃一次，重启后仍走只确认、推送端口调用数为 0。
- 授权：`child_halted` 链上 grant 过期 → 守卫拒绝 `grant_expired`；按 R2(a) 经 `renewPreview` → 签名 → `grantRevisions` 再授后链仍为 `awaiting_decision(child_halted)`，再决定后恢复成功。
- 再授与决定之间：`budget_exhausted` 停机 → 再授（链保持 `child_halted`）→ 运行一次同步规则与一次重启 → `resume_budget` 成功（回归：现有 `replaceGrant` 恢复链后会被同步规则再停）。
- 决定路径的迟到失败：`discard_changes` 在 `restoreWorkspace`、`probe` 两处 `await` 期间、`adopt_worktree` 在读 diff 期间分别让 grant 过期与撤销 scope：子仍为 `needs_reconciliation`，决定抛 `resume_refused:*`；再授后重做成功。

## 4. D8：`decideChainStep` 的顺序

### 4.1 哪些条件必须先于 `in_flight`

推送之前能挡住推送的条件是安全条件：PR 已关闭、head 被外人改动、base 变化、授权失效、链已停止。前三项在 L131、L138–144 中先于 L148 判断；授权由 `assertGrantLive` 在派发事务与推送栅栏里判断（附录 §5.1、§5.4），不在 `decideChainStep` 中；链停止由栅栏的 `state='publishing'` 判断。所以保证是：停止条件**记入本地账本之后，不会再有新的放行**。已经放行的推送不在此列：W13 L5 提交 `released` 并写出放行字节之后，发布者等待进程退出（`host-process.ts` L730–747），这期间 live 周期可以记下 `base_changed` 或关闭链，而推送随后仍可能在服务端完成（租约只比 head；取消收不回已发出的引用更新）。这种“迟到的回执”按附录 §4.1 第 3 条的表结算：链保持已停或已关闭，只确认推送事实，不恢复推送权。`bridge.tla` 的 `Push`（L373–385）把栅栏与远端更新合成一个动作，没有“已放行未落地”的中间状态，所以模型目前不覆盖这一顺序；5-F 把 `Push` 拆成 `Release` 与 `RemoteApply` 两步，并检查迟到回执不使链离开 `awaiting_decision`/`closed`。

这一保证只针对本地已记录的停止。远端事实的变化有一个客户端无法关闭的窗口：`publishRevision` 第 2 步读 PR 之后、放行之前，PR 可能被关闭或 base 被改动；栅栏只查本地状态，租约只比较远端分支的 head，GitHub 没有“PR 仍 open 且 base 未变才接受推送”的条件更新。这个窗口内推送会成功（落在已关闭 PR 的分支上，或落在 base 已变的 PR 上），之后由第 6 步读回按附录 §5.3 第 6 步的失败列处理（`closed` 或 `base_changed`，再 `reconcileReceipt`），链与子 Mission 都停下等人。附录 §5.2 末已记录同类窗口；再读一次只能缩小而不能消除它。5-C 的测试与 5-F 的模型都按这一点区分“本地链已关闭”与“远端 PR 已关闭”：`bridge.tla` 的 `Push`（L373–385）不要求 `prOpen`，`NoPushAfterClose` 只约束本地 `cState="closed"`，与此一致。

冲突、截止与评审变化不是安全条件：

| 条件 | 在途时若停止 | 不停止的后果 | 决定 |
|---|---|---|---|
| 评审冲突（L157） | 停 `reviewer_conflict`，子 Mission 被拦在下一个入口 | 推送使 head 变化，旧 head 上的评审都被 `head_mismatch` 丢弃（L95），下一轮在新 head 上重新判断；不违反不变式 1–6 | 不停 |
| 评审截止（L191） | — | 截止只约束 `awaiting_review` 的等待（`waiting`），确认推送后重置（附录 §4.1 第 2 条） | 不适用 |
| 新的 `APPROVED`/dismiss | — | 同冲突 | 不停（附录 §5.2 末已写明“有意不处理”） |

所以保留 L148 的提前返回。附录 §4.2 表里“冲突与截止任意状态都停止”的说法按本节改读：只在 `awaiting_review`/`ready_for_human` 中成立。

### 4.2 base 检查移到 `pending_push_head` 之前

L141 在 head 等于未结推送的 `new_head` 时返回 `publish_in_progress`，先于 L144 的 base 检查。推送已经可见，所以这不会让推送发生在停止之后；但在途期间 base 变化要等发布者第 6 步读回或恢复才被发现，与“base 变化一律停止”（附录 §4.4、设计 §8.4 第 2 条）不一致。改为在 L141 这一分支内部判断：head 等于 `pending_push_head` 时，base 或 base ref 变化即 `stop('base_changed')`，否则返回 `publish_in_progress`。分支本身仍在 L142 的外人写入判断之前。停止后发布者的确认走 `reconcileReceipt`（附录 §4.1 第 3 条 `awaiting_decision` 行），是已设计的路径。

### 4.3 测试（`revision-chain.test.ts`，5-E）

| # | 链 | 快照 | 期望 |
|---|---|---|---|
| 1 | `revising` | 已发布 head 上 `APPROVED` + `CHANGES_REQUESTED` | `none(in_flight)` |
| 2 | `publishing` | 同上 | `none(in_flight)` |
| 3 | `revising`，`review_deadline` 已过 | 无评审 | `none(in_flight)` |
| 4 | `publishing`，`pending_push_head = H` | head = H，base 未变 | `none(publish_in_progress)` |
| 5 | 同上 | head = H，`base_sha` 变化 | `stop(base_changed)`（新） |
| 6 | 同上 | head = H，`base_ref` 变化 | `stop(base_changed)`（新） |
| 7 | `revising` | head 变化、`head_is_descendant=false` / `true` / 缺省 | `head_regressed` / `external_write` / `external_write` |
| 8 | `revising` | PR `CLOSED` / `MERGED` | `transition(closed)` |
| 9 | `publishing`，`confirmed_push_head = H` | head = H，base 变化 | `stop(base_changed)`（已有） |
| 10 | `awaiting_review`（新 head） | 旧 head 上的冲突评审 | `none(head_mismatch)`，不停 |
| 11 | 第 5 条的决定交给真实 store | 链有 `pending` 意图 | `applyDecision` 成功，链 `awaiting_decision(base_changed)`；之后 `settleIntent('confirmed')` 不移动链（`bound` 为假） |

**TLA 模型：** 4.1 不改（`Decide` 与代码一致）。4.2 不能简单地把 `PendingHead(h)` 一行移到 base 检查之后（那样未结推送可见的 head 会先落进 L168–169 的 `external_write`/`head_regressed`）：保持 L167 的位置，把它改为 `ELSE IF h # publishedHead /\ ~Acceptable(h) /\ PendingHead(h) THEN (IF Snap.base # publishedBase THEN StopDec("base_changed") ELSE NoDec)`，加一个“未结推送可见、base 未变 → `NoDec`”的见证，重跑 `bridge.cfg`、`bridge-rounds.cfg` 与全部变异，结果写进模型说明；预期安全性结论不变（只是更早停止）。

## 5. D7：停止链的低频扫描

**范围：** 只在 `OSSTACK_BRIDGE=1` 且只对 `mode='live'` 的链运行；影子链不扫（影子停止链没有子 Mission、没有推送）。

**store：** 新方法 `listStoppedLive(limit, after)`：`mode='live' AND state='awaiting_decision'`，按 `(updated_at, chain_id)` 游标。不改 `listOpen` 的语义（影子对账器依赖它）。

**节奏：** 在 live 周期（附录 §5.5，默认 60 秒）里另用一个游标：每 10 个周期扫一批，每批最多 10 条；每条链两次扫描至少间隔 10 分钟；与 live 周期共用限流与 5xx 退避，退避期间不写任何东西。

**读什么：** 4-C 读取器的最小查询，按 PR 号读 `state`、`headRefOid`、`headRepository`/`headRefName`、`baseRefOid`、`baseRefName`。不读评审正文，不 `ls-remote`，不 `fetch`。

**做什么：**

| 观察 | 动作 |
|---|---|
| 快照不完整或读失败 | 不写 |
| PR `MERGED`/`CLOSED` | 按决定 R4 |
| 事实与本链最近一条 `stopped_chain_observed` 相同 | 不写 |
| 事实变化（首次观察、head ≠ `published_head`、base 或 ref ≠ 链） | 写链事件 `stopped_chain_observed { pr_state, head, base_sha, base_ref, observed_at, differs: { head, base } }`；`osstack stats` 的 bridge 段（N1）计数；`mission status --json` 的链字段显示最近一条 |

**从不：** 离开 `awaiting_decision` 到任何非 `closed` 状态；改 `stop_reason`；预留、派发、写或结算意图（回执由 `revisionRecovery` 与 `chain-decide reconcile` 处理）；改 grant；取消子 Mission（R4(a) 关闭时除外）；推送或调用任何 App A/B 写接口。

**决定 R4（推荐 a）：**(a) PR 已合并或关闭时，经 `decideChainStep`（对 `awaiting_decision` 只会给出 `transition(closed)` 或 `none`，L131–134）与 `applyDecision` 把链转 `closed`（D12 允许，store L541），同一周期按附录 §4.4“PR 关闭”行请求取消在途子 Mission，并 `voidReservation`；关闭只减少权限。注意关闭**不**释放 `engineering_chain_pr_live`（DDL L38 只有 `WHERE mode='live'`，不看状态），重开的 PR 不能再建 live 链；要支持需另加迁移，本文不做。(b) 只记录，由人 `chain-decide abandon`。

有 `pending`/`uncertain` 意图时关闭仍允许（`update` 的 D1 检查对 `closed` 放行，L584）；之后的回执走附录 §4.1 第 3 条 `closed` 行。

**测试（5-E）：** 停止链 PR 关闭 → R4(a) 时转 `closed`、请求取消、预留 `void`；事实不变时第二次扫描不写事件；head 变化只写事件、不改状态与原因；有 `pending` 意图时关闭成功且意图不变；`OSSTACK_BRIDGE=0` 时不扫描；限流时不写；`stopped_chain_observed` 被 §3.4 第 10 条读到。

**TLA 模型（5-F）：** 加 `ReconcileStopped == cState = "awaiting_decision" /\ ~Snap.open /\ cState' = "closed" …`（R4(a)），检查 `NoPushAfterClose` 与闭链展开约束；R4(b) 不需要模型改动。

## 6. D10：确认事务

### 6.1 合同

函数 `confirmRevisionPublication(deps, { chain_id, intent_id, child_mission_id, permit_revision, evidence, readback, variant })`（`contained-mission-revision.ts`，5-C）。在线（`deliverRevision` 第 6 步）、恢复（`revisionRecovery`）、只确认（§3.8）三处共用。`variant`：`normal`、`cancelled`（子已 `cancel_requested`）、`landed`。

调用前（事务之外）必须已经成立：W13 登记 `journal.stopped` 已**单独提交**（顶层事务，`settleStopped` 同类，W13 §6.3 第 3 条）；读回已完成（附录 §5.3 第 6 步）。读回是异步的，所以事务内不再读 GitHub。

一个 `chainStore.transaction(() => …)`（store L295。链 store 的嵌套写入经 `db.transaction` 成为保存点，L624–626；Mission store 的写入经 `attention.write` 在已有事务中**直接运行**，不建保存点，`attention-store.ts` L86–90，所以任何一步的异常必须抛出到外层事务才能回滚，不能在事务内捕获后继续。W13 的 `release`、`stopped`、`settleStopped` 是顶层方法，不能放进来），顺序固定：

| 步 | 写入 | 说明 |
|---|---|---|
| 0 | 复核（只读）：意图 I 为 `pending`、`kind='push'`、属于本子；I 的登记行 `state='stopped'` 且 `released_at IS NOT NULL`；链 `publishing` 且与 I 绑定（`published_head = I.expected_old_head`、`published_base = I.expected_base_sha`、`branch`、`current_mission_id = 子`）；子为 `delivering`（`cancelled` 变体为 `cancel_requested`）、修订号等于 `permit_revision`、`candidate_head = I.new_head`；键为 `I.expected_old_head` 的预留属于本链、本子且为 `dispatched` | 任一不符抛 `confirm_route_changed`，整体回滚，调用方改走 `reconcileReceipt`（附录 §4.1 第 3 条）。不比较链的 `revision`：`chargeLaunch`/`refundLaunch` 也会递增它 |
| 1 | `settleIntent(I, 'confirmed')` | 绑定 → 链 `awaiting_review`、`published_head = new_head`。此时子仍非终态，`settlePublishedReservation`（L572–579）不动预留 |
| 2 | `resetReviewDeadline(chain, rev, now + grant.review_deadline_ms)`（新） | 附录 §4.1 第 2 条 |
| 3 | `voidReservation(chain, rev, I.expected_old_head, 'published')`：三种变体都以 `I.expected_old_head` 为键，不用事务开始时的 `published_head`（`landed` 变体里 `reconcileReceipt` 已把它推进到 `I.new_head`，按旧值查会 `reservation_not_found`，store L608–611）；第 0 步复核的就是这一行属于本链、本子且为 `dispatched` | 链已不在途，`voidReservation` 不改链（L207–209）。约束是第 5 步不能先于第 1 步：若子先转 `pr_opened`，第 1 步里的 `settlePublishedReservation`（只在 `settleIntent` 内运行，L279）会把预留 `void`，本步随即 `reservation_void`。第 3 步与第 5 步之间的先后不影响结果，固定写法是为了测试 |
| 4 | `missions.record(子, 'delivery_evidence', evidence)` | 证据摘要含 `intent_id` 与 `push_range` 摘要 |
| 5 | `missions.transition(子, delivering → pr_opened, pr_opened{pr, evidence_digest, intent_id})` | `cancelled` 变体：记 `revision_pushed_before_cancel`，转 `cancelled`，然后 `stopLive('child_cancelled')`，跳过第 6 步 |
| 6 | `recordCheckIntent(chain, { new_head, child_mission_id, external_id: 子 })`（新，附录 §4.1 第 4 条） | 只在 `publishVerifyCheck` 已配置时；它要求已 `confirmed` 的推送与 `pr_opened` 的子，同一事务内前面的写入可见 |
| 7 | 链事件 `round_published { intent_id, child, head, range_sha256 }` | — |

`landed` 变体：第 0 步检查 §3.8 的提交条件（不是准入条件），第 1 步换成 `resumeLanded`，其余相同。

`cancelled` 变体：取消会递增子 Mission 的修订号（runner L317–323），所以不与 `permit_revision` 比较；改为：子为 `cancel_requested`，其 `cancel_requested` 事件在本次 `delivery_attempt` 之后，`candidate_head = I.new_head`，以事务内新读到的修订号做第 5 步的条件转换。取消发生在读回之后、事务之前也走这一变体；子已是 `cancelled`（`settleCancel` 先完成）则第 0 步不符，改走附录 §4.1 第 3 条第一行。

事务提交之后（事务外）：App B check（附录 §5.3 第 7 步）结算 check 意图；live 周期 `releaseClaim`。

测试缝：`fault?: (step: 'settle'|'deadline'|'void'|'evidence'|'pr_opened'|'check_intent'|'event') => void`，同 `dispatchRevision` 的 `DispatchFaultStep`（L180、L290–307）。

### 6.2 崩溃点与恢复

`deliverRevision` 的第 0 步，按本链中该子**最新**一条推送意图（按 `created_at, intent_id`）的状态分流：

| 最新意图 | 动作 |
|---|---|
| 无，或 `failed` | 正常发布，写一条新意图（`recordIntent` L233–234 只拒绝 `pending`/`uncertain`；`failed` 是终态记录，重试就是新意图）。只有链在途时才会走到这里：失败后链已停，重试必须先经 §3.3 的同子恢复 |
| `pending` | 不写新意图、不推送，走与 `revisionRecovery` 相同的回执结算（§6.2 K2；没有登记行或 `released_at IS NULL` → §7 的 `never_released` 行） |
| `uncertain` | 不写、不推送；子 `publication_failed:intent_uncertain`，链已由 `settleIntent('uncertain')` 停在 `intent_uncertain`；人用 `chain-decide reconcile` |
| `confirmed` | §3.8（只确认） |

所以重启后 `host.tick` 先于回执结算推进到 `deliver` 时也不会重推。

| 点 | 账本 | 恢复 |
|---|---|---|
| K1 推送进程运行中，或已退出但 W13 L8 未提交 `stopped` | 登记 `released` 未停；I `pending`；链 `publishing`；子 `delivering` | `host.recover()`：证明停止则写 `stopped`；不能证明 → 子 `stop_unknown(route=delivering)`，同步规则停链 `intent_uncertain`（§3.6），`revisionRecovery` 本轮不结算 |
| K2 `stopped` 已提交，读回前或读回中 | 登记 `stopped`；I `pending`；链 `publishing`；子 `delivering` | `revisionRecovery`（或 `deliverRevision` 第 0 步）读远端：`new_head` 且范围相符、PR 满足读回 → `confirmRevisionPublication`；PR 关闭或 base 变化 → 先按事实转链与停子，再 `reconcileReceipt`；远端不是 `new_head` → `uncertain`（附录 §5.5） |
| K3 确认事务中（任一步抛错或进程死亡） | 整体回滚，同 K2 | 同 K2 |
| K4 事务已提交，check 未发 | 子 `pr_opened`；链 `awaiting_review`；check 意图 `pending` | `revisionRecovery` 的 check 投递（只在 `OSSTACK_BRIDGE=1`）：`publishVerifyCheck` 查重后写，结算 `confirmed`/`failed` |
| K5 check 已发，结算前 | 同 K4 | 同 K4；按 `<子>:<head>` 与 `external_id` 查重找到已有 check run → `confirmed`，不重复创建 |
| K6 check 已结算，认领未释放 | 子终态、`stop_obligation=0`、认领 `active` | live 周期 `releaseClaim(子,'revision_settled')` |
| K7 第 0 步复核不过（链被同时停止或关闭） | 不变 | 调用方改走 `reconcileReceipt`；不重试确认 |

### 6.3 测试（5-C，真实 store）

- 顺序：成功路径逐项断言 7 步的结果；变异“把第 5 步移到第 1 步之前”时第 3 步抛 `reservation_void`（只移到第 3 步之前不会失败，测试也断言这一点）；变异“第 6 步移到第 1 步之前”时 `recordCheckIntent` 被拒、整体回滚。
- 原子性：对 `fault` 的 7 个点各注入一次，断言回滚到 K2 的状态（I `pending`、链 `publishing`、预留 `dispatched`、子 `delivering`、没有 `delivery_evidence`/`round_published`）。
- 复核：链在读回与事务之间被 `stopLive('base_changed')` → `confirm_route_changed`，随后 `reconcileReceipt` 确认事实、链保持停止。
- 登记未停：I 的登记仍为 `released` 时第 0 步拒绝。
- 第 0 步分流：最新意图为 `failed` 时写新意图并推送一次；`pending` 且无登记行（崩溃在 L1 之前）时结算 `failed`、子停 `publication_failed:never_released`、链 `publish_refused:never_released`；`uncertain` 时不推送。
- `cancelled` 变体：读回之后、事务之前取消，确认成功、子 `cancelled`；`settleCancel` 已先完成时改走 `reconcileReceipt`。
- 窗口：第 2 步之后、放行之前把 PR 关闭（或改 base），推送成功，第 6 步读回后链 `closed`（或 `base_changed`），子 `publication_failed:pr_changed_after_push`，意图 `confirmed`。
- K1–K6 各一次真实崩溃（子进程退出代替守护进程）：重启后结果分别如上表；K2 与“`tick` 先到 `deliver`”的顺序各跑一次，断言只推送一次（插桩的推送端口计数）。
- `cancelled` 变体：没有 check 意图，链 `awaiting_decision(child_cancelled)`，预留 `void('published')`。

**TLA 模型：** 不改。模型把确认拆成 `ReadBack` 与 `ChildPublished` 两步（模型说明 D10），原子事务是其中“两步之间无其他动作”的行为，已被覆盖；模型说明的 D10 行加注“5-C 实现为一个事务”。

## 7. D4：发布路径的停止原因

### 7.1 规则

1. **原因要具体。** `stopLive` 的允许集合加入 `base_changed`、`external_write`、`head_regressed`（`LIVE_STOP_REASONS`，`revision-grant.ts` L29–32，5-C）；PR 关闭或合并用 `closeLive('pr_closed'|'pr_merged')`。
2. **先停链，后结算 `failed`，同一事务内停子 Mission。** `settleIntent('failed')` 在链在途时会写 `intent_failed`（L283–284），之后 `stopLive` 因链已停而 `state_denied`。所以一个 `chainStore.transaction`：`stopLive(具体原因)`（或 `closeLive`）→ `settleIntent(I,'failed')`（链已停，不再改链）→ 子 Mission `halt(awaiting_decision, 'publication_failed:<code>')`。同一事务里停子，使同步规则（§3.7）不会先把原因写成 `child_halted`。
3. **W13 的边界不进这个事务。** 栅栏在 `journal.release` 的事务里同步运行（附录 §5.4）；栅栏抛错时该事务回滚，其中的任何链写入也会回滚。所以栅栏只抛码，`deliverRevision` 在 W13 在线收尾（杀进程组、证明、单独提交 `stopped(never_released)`）之后，再按本表执行规则 2 的事务。
4. **链已停或已关闭时**只结算意图、停子 Mission，不改链的原因（D7 与 §3.9 之外不改写原因）。
5. 不能确定远端是否被写时不判 `failed`（附录 §5.3 第 5 步）：结算 `uncertain`，链 `intent_uncertain`（L281–282）。
6. **发布路径上子 Mission 的停机原因一律以 `publication_failed:` 开头**，授权与预算原因也不用 `grant_stopped:*`/`budget_exhausted`：`approve_publication` 只接受 `publication_pending`、`publication_failed*`、`revalidation_failed*`（runner L172–173），而 `resume_grant`/`resume_budget` 要求 `halted` 事件里有 `blocked` 启动路由（L191–210），`LAUNCH_ROUTES`（L80）没有发布路由。发布不收启动预算，所以不需要新路由。

### 7.2 映射表

“可”= 该原因属于 `SAME_CHILD_RESUMABLE`（§3.2），人核对后可用 `approve_publication` 恢复同一个子 Mission。

| 来源（附录 §5.3） | 观察 | 链 | 意图 | 子 Mission | 取消子 | 同子恢复 |
|---|---|---|---|---|---|---|
| 前置：`assertRepoConfigUnchanged` 不符 | 仓库配置被改 | `publish_refused:repo_config_changed` | 无（未写） | `publication_failed:repo_config_changed` | 否 | 可 |
| 前置：本地分支 head ≠ `permit.head` | 本地分支被改 | `publish_refused:local_head_mismatch` | 无 | 同码 | 否 | 可 |
| 前置：push URL 不是该仓库的纯 https，或 W13 §5.4 的传输配置不受支持 | 本地配置 | `publish_refused:push_url_invalid`、`publish_refused:transport_unsupported` | 无 | 同码 | 否 | 可 |
| 前置：`spec.start_commit ≠ published_head` | 子建在旧 head 上 | `publish_refused:start_mismatch` | 无 | 同码 | 否 | 否 |
| 前置：该子已有本链推送意图 | — | 不停（§6.2 第 0 步改走回执结算） | — | — | — | — |
| 前置：桥接未配置（端口缺失） | — | `publish_refused:publisher_unavailable` | 无 | 同码 | 否 | 可 |
| 第 1 步 `recordIntent`：`intent_binding_mismatch` | 链已发布的 head/base 或当前子变了 | `publish_refused:intent_binding_mismatch` | 无 | 同码 | 否 | 否 |
| 第 1 步：`grant_expired`（store 时钟） | — | `grant_expired` | 无 | `publication_failed:grant_expired` | 否 | 否（再授后链为 `child_halted`（§3.5），再 `approve_publication`，由守卫 `resumeChild` 恢复） |
| 第 1 步：链不在 `revising`/`publishing` | 链已停或关闭 | 不改（规则 4） | 无 | `publication_failed:chain_<state>` | — | 视链原因 |
| 第 2 步：PR `CLOSED`/`MERGED` | — | `closeLive('pr_closed'|'pr_merged')` | `failed` | 请求取消 | 是 | 否 |
| 第 2 步：`headRepository`/`headRefName` 不符 | PR 的 head 分支被换 | `publish_refused:pr_head_ref_changed` | `failed` | 同码 | 是 | 否 |
| 第 2 步：base ref 或 SHA 不符 | — | `base_changed` | `failed` | `publication_failed:base_changed` | 是 | 否 |
| 第 2 步：`headRefOid` 或 `ls-remote` ≠ `expected_old_head`，是其后代 / 不是 | 外人推送 | `external_write` / `head_regressed` | `failed` | 同码 | 是 | 否 |
| 第 3 步：`new_head` 不是 `expected_old_head` 的后代 | 候选错乱 | `publish_refused:not_descendant` | `failed` | 同码 | 否 | 否 |
| 第 3 步：提交范围超过 64 个 | — | `publish_refused:range_too_large` | `failed` | 同码 | 否 | 否 |
| 第 4 步：取 App A 令牌失败（spawn 前） | 瞬时 | `publish_refused:token_unavailable` | `failed` | 同码 | 否 | 可 |
| 第 4 步：W13 L1 被 `engineering_host_process_remote_open` 拒绝 | 同一远端分支有未结推送 | `publish_refused:push_in_flight` | `failed` | 同码 | 否 | 可（待那条登记证明停止） |
| 第 4 步：栅栏 `CONTAINED_REVISION_FENCE:grant_expired|grant_invalid|budget_exhausted`（墙钟预算） | — | 同名原因 | `failed` | `publication_failed:<同名>` | 否 | 否（同上：再授后 `approve_publication`） |
| 第 4 步：栅栏 `…:bridge_live_disabled` | 开关已关 | `publish_refused:bridge_live_disabled` | `failed` | 同码 | 否 | 可（开关恢复后） |
| 第 4 步：栅栏 `…:chain_state`、`…:intent_moved`、`…:not_current_child` | 链在途中被改 | 规则 4（链已不是 `publishing`）；否则 `publish_refused:fence_<code>` | `failed` | 同码 | 否 | 否 |
| 第 4 步：栅栏 `…:stale_owner` | 本进程已不是 owner | 不写（写不进去）；新 owner 的 `recover()` 按 W13 处理未结登记 | 留给恢复 | 留给恢复 | — | — |
| 第 4 步：子 `cancel_requested`（栅栏 `state !== 'delivering'`） | — | 规则 4；在途则 `child_cancelled` | `failed` | `cancelled` | — | 否 |
| 第 5 步：`--porcelain` 为 `!` 或认证在任何引用更新前失败，且远端 = `expected_old_head` | 明确拒绝 | `publish_refused:push_rejected` | `failed` | 同码 | 否 | 否（R5） |
| 第 5 步：其余非零退出、超时、中断 | 不确定 | `intent_uncertain`（经 `settleIntent('uncertain')`） | `uncertain` | `publication_failed:push_uncertain` | 否 | 否；落地后 §3.8 |
| 第 5 步：W13 L8 证明不成立 | 进程可能仍在 | `intent_uncertain`（`stopLive`） | 不结算 | `stop_unknown(route=delivering)` | 否 | 否 |
| 第 6 步：远端或范围不符 | — | `intent_uncertain` | `uncertain` | `publication_failed:readback_mismatch` | 否 | 否；落地后 §3.8 |
| 第 6 步：推送已落地，PR 已关闭 / base 已变 | — | `closeLive` / `base_changed`，再 `reconcileReceipt` | `confirmed` | `publication_failed:pr_changed_after_push` | 是 | 否 |
| 恢复或 `deliverRevision` 第 0 步：没有登记行或 `released_at IS NULL` | git 从未运行 | `publish_refused:never_released` | `failed` | 子仍为 `delivering`（崩溃在 L1 之前，或登记已证明停止：W13 §5.5 的“孤儿 `delivering`”行不改状态，host L192–225）→ 同一事务内停到 `publication_failed:never_released`；子已由 W13 出口停在 `publication_failed:host_process_recovered` → 不改；子为 `stop_unknown`（包装进程仍未证明）→ 不结算意图，等 W13 | 否 | 可 |

**决定 R5（推荐 a）：**(a) `push_rejected` 不可同子恢复：服务端规则或认证的拒绝重试同一个提交通常仍被拒，人用 `chain-decide takeover` 处理；(b) 列为“可”。

### 7.3 测试（5-C；栅栏码 5-D）

- 表中每一行一个用例，断言链的原因、意图状态、子 Mission 原因、是否请求取消，以及链事件里只有一次 `transition`。
- 规则 2 的变异：把 `settleIntent('failed')` 放到 `stopLive` 之前，`base_changed` 用例失败（链为 `intent_failed`，`stopLive` 抛 `state_denied`）。
- 规则 3：栅栏抛 `grant_expired` 时 `journal.release` 回滚、`stopped(never_released)` 已提交、链 `grant_expired`。
- 属性：随机发布结果序列下，live 路径从不写出 `intent_failed`（§3.2）。

## 8. 需要用户做的决定

**已决定（2026-11-07，用户本人）：** R1–R5 全部采用推荐的 (a)：R1 在子 Mission 上执行 `mission decide` 时隐式恢复链；R2 允许在 `child_halted` 或可恢复的 `publish_refused` 链上续授权，链保持停止直到人做决定；R3 崩溃期间已落地的一轮只由 `approve_publication` 确认，恢复不自动确认；R4 停止链扫描在 PR 已合并或关闭时自行关闭链；R5 `publish_refused:push_rejected` 不能在同一个子 Mission 上恢复。

| # | 决定 | 推荐 |
|---|---|---|
| R1 | 同子恢复由人对子 Mission 的 `mission decide` 隐式触发（§3.3） | (a) 隐式，一次决定 |
| R2 | 停机期间授权或预算失效时，允许对 `child_halted`/`publish_refused:<可>` 再授而不恢复链（§3.10） | (a) 允许 |
| R3 | 已落地一轮的只确认由人 `approve_publication` 触发，还是恢复时自动（§3.8） | (a) 人触发 |
| R4 | 停止链扫描在 PR 关闭或合并时自动转 `closed` 并取消子 Mission，还是只记录（§5） | (a) 自动关闭 |
| R5 | `publish_refused:push_rejected` 是否可同子恢复（§7.2） | (a) 不可 |

D8 的两条（保留 `in_flight`、base 检查前移）与 D10 的顺序是技术决定，不需要用户决定。

## 9. 审计记录

**第 1 轮（Codex CLI gpt-6-astra，medium，只读，基于初稿，对照 `ccef9bb4` 的代码、附录、W13、模型说明与 `bridge.tla`）：** 1 个 P1、7 个 P2、2 个 P3。逐条核对代码后全部接受：

| 发现 | 核对 | 处理 |
|---|---|---|
| P1 初稿说在途期间不存在“停止后仍推送”的顺序，并说 PR 关闭与 base 变化由租约拦住；实际第 2 步读 PR 之后、放行之前 PR 可被关闭或改 base，栅栏只查本地、租约只比 head，模型的 `Push` 也不要求 `prOpen` | 属实，附录 §5.3 第 2、4–5 步；`bridge.tla` L368–384 | §4.1 改为“本地已记录的停止”之后不推送，写明远端窗口与事后处理；§3.4 第 10 条措辞；§6.3 加窗口测试 |
| P2 第 0 步“已有意图就不写第二条”挡住了 `failed` 之后的合法重试 | 属实，store L233–234 只拒 `pending`/`uncertain` | §6.2 按该子最新意图的四种状态分流 |
| P2 发布路径授权停机让子停在 `grant_stopped:*`，`approve_publication` 不接受，`resume_grant` 需要不存在的发布路由 | 属实，runner L172–173、L191–210、L80 | §7.1 规则 6：发布路径一律 `publication_failed:<code>`；§7.2 两行改码 |
| P2 只确认的事务前提要求子仍为 `awaiting_decision`，而准入后子已进入 `delivering` | 属实，runner L601–607 | §3.8 分开准入与提交条件；路由由最新意图重新推出，不持久化 |
| P2 `cancelled` 变体要求修订号等于 permit，而取消会递增修订号 | 属实，runner L317–323 | §6.1 `cancelled` 变体改为按事件顺序与候选核对，用新读的修订号 |
| P2 “从未放行”的恢复假设子已被 W13 停到 `host_process_recovered`；L1 之前崩溃时没有登记，W13 让 `delivering` 原样留给重试 | 属实，host L192–225；W13 §5.5 | §3.6、§7.2 最后一行：同一事务内停子到 `publication_failed:never_released`；`stop_unknown` 时不结算 |
| P2 初稿称关闭链会释放 `engineering_chain_pr_live` | 属实，DDL L38 不看状态 | §5 删除该说法，写明需迁移、不在本文 |
| P2 模型改动“把 `PendingHead` 一行移到 base 之后”会让未结推送可见时先判外人写入 | 属实，`bridge.tla` L167–170 | §4.2 改为在该分支内部判断 base，代码与模型同一写法，加见证 |
| P3 “第 5 步移到第 3 步之前”不会触发 `reservation_void`，自动结算只在 `settleIntent` 内 | 属实，store L279、L572–579 | §6.1 第 3 步说明与 §6.3 变异改为“第 5 步移到第 1 步之前” |
| P3 Mission store 的写入在已有事务中直接运行，不是保存点 | 属实，`attention-store.ts` L86–90 | §6.1 改写，并要求异常抛出到外层 |

**第 2 轮（Codex CLI gpt-6-astra，medium，只读，基于第 1 轮修订稿）：** 第 1 轮 10 项中 9 项判为已解决，1 项（P1 停止后推送）部分解决；新增 1 个 P1、4 个 P2。逐条核对代码后全部接受：

| 发现 | 核对 | 处理 |
|---|---|---|
| 部分 / 新 P1 修订稿仍称本地记录停止后不会推送；实际放行之后发布者等待进程退出，期间链可被停止，推送仍会落地；模型的 `Push` 把栅栏与远端更新合为一步 | 属实，`engineering-host-process-store.ts` L146–157，`host-process.ts` L730–747，`bridge.tla` L373–385 | §4.1 改为“本地停止之后不再有新的放行”，迟到回执按附录 §4.1 第 3 条结算；5-F 把 `Push` 拆成 `Release` 与 `RemoteApply` |
| 新 P2 `replaceGrant` 把链恢复到在途后、人 `resume_*` 之前，同步规则会把链再停为 `child_halted`，随后 `resume_*` 被拒 | 属实，store L323–336，`contained-mission-revision.ts` L162–168 | §3.5：子非终态时再授保持停止（原因 `child_halted`），由守卫恢复；§3.1 行与测试相应修改；记为对附录 §5.1 (b) 与 5-A 的改动 |
| 新 P2 R2 只改 store 不够，服务层 `buildRenew` 先用 `RENEWABLE_STOP_REASONS` 拒绝 | 属实，`contained-mission-grant.ts` L349–356、L244、L269 | §3.10：新集合 `REFRESHABLE_STOP_REASONS`，服务与 store 都用；“换 grant 后去哪”只由 §3.5 决定；加端到端测试 |
| 新 P2 `discard_changes`、`adopt_worktree` 在 `await` 之后的链检查可能因授权到期失败，停到 `chain_stopped:*` 后只能放弃 | 属实，runner L246–257、L279–305 | §3.11 第 3 条：决定路径上这两处失败保持 `needs_reconciliation` 并抛 `resume_refused:*`；加测试 |
| 新 P2 只确认变体里 `published_head` 已推进到 `I.new_head`，按“旧 `published_head`”查预留会失败 | 属实，store L198–204、L608–611 | §6.1 第 0、3 步：三种变体都以 `I.expected_old_head` 为键 |

第 2 轮之后的修改未再审计（按要求两轮后停止）。


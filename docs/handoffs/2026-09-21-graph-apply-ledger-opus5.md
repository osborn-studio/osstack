# Graph apply 凭证与保守恢复：实现及审计记录

分支 `codex/graph-decision-development`，基线 `1b6c0f4`。本批完成 P04b 存储层：apply 一次性门禁、成功回执与 action 同事务结算、部分应用隔离，以及成功/隔离的资源释放恢复。没有接入真实 provider 或生产文件应用器，也未注册新执行器、发布、push 或创建 PR。原 checkout 未改。

完整字段、权威边界与恢复顺序见 [ADR](../design/2026-09-21-graph-apply-ledger.md)。

## 代码结果

- migration39 仅新增两个表，intent / resolution 都有主键、外键和不可变保护（含 INSERT OR REPLACE）；不改 migration38 或已发布 v4 编译语义。
- beginApply 返回独立 `applyAuthorized`：只有首次插入为 true；重放、ACK 丢失和当前文件看起来已正确，都不能授予第二次写入。
- completeApply 同事务记录 applied 回执、原 action 的 implementation_complete 和原预算结算；不新增 token 账本或 logicalAttempt。
- quarantineApply 同事务保留 unknown/cancel_pending 与预算；后续冻结、审阅、测试及 join 受阻。普通失败结算不能掩盖部分写入。
- 成功回执提交后崩溃：只能基于同一已确认 outcome 进行 release-only 恢复，不重新应用或扣费。
- 未完成应用崩溃：管理恢复在停止证明下补写 quarantine；可释放物理资源，但不会释放 token 预留、重试或把 run 标成成功。新 generation 只可检查历史证据。
- GraphAdmissionStore 仍是 daemon 内部实际资源账目；它不是工作区停止证明，更不是模型可调用的接口。

## 验证

使用 Node22、独立临时 SQLite / OSSTACK_HOME，没有真实付费请求。

- 先写5个失败测试（缺少 apply API），然后实现使其通过。
- apply 测试27项；七个独立 Node 进程 SIGKILL 点：门禁前、门禁事务中、门禁后未写文件、写完第一个文件、三个文件全写完但未落回执、完成事务中、回执提交后 ACK 丢失。
- 每个故障场景重启两次，验证真实临时文件内容和操作次数不重复；未提交成功回执的完整文件结果仍隔离。
- 故障夹具确实执行 replace/delete/create，但不是生产 applier，没有模拟完成安全路径/Git tree/真实 provider 证明；恢复 verifier 为测试夹具。
- 状态库：34文件，450/450；现有 action broker / boundary / daemon broker：3文件，53/53。
- core build / TypeScript 与变更TS的 Biome 通过，inventory fresh。
- CLI startup median：version130ms <150；help276ms <500。help最大905ms，门槛沿用原脚本中位数，不改阈值。
- 新 apply 模块在 protocol/zod 已加载后增加0.69ms。
- 进程 SIGKILL 不是断电证明；WAL synchronous=NORMAL 未改，真实付费启用前仍需明确与验证断电持久性。

## Opus 5 设计挑战与处置

通过 Claude CLI `--model claude-opus-5 --effort high --tools ""` 只读审计；禁用嵌套技能。不把模型建议视为事实。

采纳并实现：

1. 成功/隔离都需要停止证明后的资源清理出口，不能永久占住执行资源。成功仅 replay 已确认 truth；隔离只释放物理 admission，不清除预算/unknown。
2. 使用显式 applyAuthorized；changed 只承担 revision bookkeeping。
3. 存在 apply intent 后普通 recordOutcome/recordUnstartedOutcome 不再可结算；markUncertain 转用 quarantine。
4. 一张互斥 resolution 表；完成与原预算同事务；新增 run-wide pending blocker 覆盖预留在先、启动在后的 slot。
5. 增加真实进程 kill 和完成后过期租约恢复、不可伪造为新 outcome、跨代不重放测试。

校正/不采纳：

- 不在响应或 SQLite 回执完成时自动释放实际写租约。未来 host 从请求到文件应用及凭证须持有同一物理 lease。
- BEFORE INSERT 重复键拒绝已封堵本批新表的 OR REPLACE；不必为了这两个表全局改 recursive_triggers。测试直接验证该路径被拒。
- 不修改旧 verification snapshot 结构：所有新写入提升 run.revision，pending/quarantined action 已被既有 join/epoch/terminal gates 拦截，新增测试验证这个联系。
- 不采用 compilerVersion.startsWith('code-delivery-functional-') 作为新执行器准入：它本来就匹配已发布 v4，不能证明新增能力已获准。当前仍没有新的 registry/broker/CLI 激活路径。
- completeApply 不因 deadline/accounting/stop 意图拒绝记录已发生的成功，但保留当前 fence、原 generation、epoch 与 held admission。epoch 在 unresolved action 下不能前进；过期/跨代则走管理证明恢复，不放宽普通 API。

## 后续开发入口

1. P05：精确准备有界 provider 请求，先持久化调用门禁；禁用自动重试；核验完整终止、UTF-8、响应大小和真实用量；只返回 proposal。
2. P06：实现真正的 journal 内容和原子/非原子文件操作协议、inode/symlink/hardlink/路径与全树预像校验；每次写前再次核验同一 lease 和撤销状态；完整验证才调用 completeApply；物理隔离必须禁止其他 run 复用该工作区，不能仅依赖本批 run 内 SQL 门禁。新的 host 恢复 verifier 必须专门识别该 profile，不能未经适配复用 v4 verifier。
3. 故障恢复只提供隔离/资源释放，不提供自动 rollback/roll-forward。未来需要专用、版本化、可复核的物理证据才可解除隔离；不能改旧 generation 和摘要。
4. P07–P09：累积全量差异审阅、新编译身份与 profile 准入、真实 create/replace/delete 端到端及撤权/崩溃验证。完成前不能宣称多文件功能已可用。

## 设计审计原文

Read-only review; no tools used. Findings are ordered by severity, and I flag the two that I think block the batch as specced.

## P0 — design defects that brick runs

**1. Every successful apply leaves a held admission with no release path → run is unterminable *and* untakeoverable.**
`completeApply` deliberately doesn't release. The only existing releases are `GraphAdmissionStore.released()` (unfenced, unauthenticated — see P1.10) and `GraphRecoveryStore.completeRelease`, which requires a recorded *effect* decision with a non-`unknown` verdict. `settle()` rejects every non-`unknown` verdict when a `graph_invocation_requests` row exists (`INVOCATION_RECOVERY_UNSUPPORTED`), so that decision can never be created for an invocation row. Consequences after a host crash between `completeApply` and release: `acquireLease` fails `ADMISSION_RELEASE_PENDING`, terminal `project` fails, `activate`/verification `commit` fail. Permanent.
Ship a minimal `releaseApplied(fence, effectKey, releaseReceipt)` in this batch: requires an exact `applied` resolution + confirmed outcome + held admission, release-only, no re-apply, allowed cross-generation. That is the "separate future integration gate" you sketched — it isn't future work, it's the only exit.

**2. Quarantine is a permanent limbo, not a safe stop.**
Quarantine keeps the reservation and the admission and sets `unknown`/`cancel_pending`. Then: recovery `applied`/`not_applied` is blocked for invocation rows; recovery `unknown` leaves it `unknown`; `verifyRelease`/`completeRelease` explicitly reject `unknown`; terminal projection rejects `unknown`. So a quarantined run can never be sealed, released, or taken over. For ordinary actions `unknown` has an escape (recovery `applied`/`not_applied`); for invocation rows you removed it, and P04b makes quarantine an *expected* path rather than a rare fault — including the "SIGKILL after gate, before any write" case, which by design must quarantine even though nothing was applied.
Add `releaseQuarantined(fence, effectKey, stoppedProof)`: requires an exact quarantined resolution plus host stop evidence, releases the admission only, leaves the action `unknown` (terminal sealing stays blocked, takeover becomes possible). Don't loosen `settle()` to get this.

## P1 — fix before merge

**3. Don't overload `changed` as the apply capability.** `changed` currently also drives the revision bump in `fencedGraphTransaction`; any future reason to bump would silently re-authorize a second physical apply. Return an explicit `applyAuthorized: boolean` set *only* when this call inserted the intent row, in a dedicated result type (`{ action, run, budget, intent, applyAuthorized }`), and document that `changed` is not the token. Add read-only `getApply(fence, key) → { intent, resolution }` mirroring `getInvocation`.

**4. The generic-settlement block must be unconditional.** Today's guard is `(confirmed || retrySafe) && exists(graph_invocation_requests)`; a `failed / retrySafe:false` settlement still lands and clears `running` mid-write — exactly the hazard you identified. In `settleOutcome`, before the `prior.outcome` replay branch, reject on *any* unresolved-or-resolved apply intent for the key. Apply it to `recordUnstartedOutcome` too (it can't currently collide, but uniformity is cheaper than the proof).
Same reasoning for `markUncertain`: allowed direction, but it produces an action-level `unknown` with no resolution row, indistinguishable from quarantine and invisible to the run-wide blocker's resolution join. Reject `markUncertain` while an apply intent exists and make `quarantineApply` the only uncertainty API for those effects.

**5. `beginApply` is the only policy gate; complete and quarantine are evidence recorders.** You already carved out the deadline. Extend it explicitly to `checkEpoch`, `accountingBlocked`, `RUN_STOPPING`, and budget: if `completeApply` can fail for policy, a host that has already mutated the filesystem is forced into quarantining a successful apply. Complete/quarantine should validate only binding + live fence. Mirror recovery's `settle()`: under `run.status === 'cancel_pending'`, quarantine records `cancel_pending`, not `unknown`.

**6. Run-wide blocker placement and ordering.** Predicate: any `graph_apply_intents` row for the run (join `graph_actions` on `graph_run_id`, not generation — the filesystem is run-wide) with no row in `graph_apply_resolutions`. Put it in `admit()` (covers `reserve` + `retry`) and in `start()` **after** the `prior.state === 'running'` idempotent early-return, beside the existing `UNRESOLVED_ACTION` check. That ordering gives you exactly the semantics you specified: `markRunning`/`beginInvocation` replays for already-running actions still succeed, the apply's own effect is unaffected, and a slot pre-reserved before the apply fails at `markRunning` (note `reserve`'s prior-exists branch returns before `admit()`, so the pre-reserved slot survives reserve replay by design). Post-quarantine the existing unknown check already blocks; the blocker just makes it not depend on that.

**7. SQLite gotchas in migration39.** With `PRAGMA recursive_triggers` OFF (the default), `INSERT OR REPLACE` resolves a PK conflict *without firing `BEFORE DELETE` triggers* — a delete trigger alone does not close the `OR REPLACE` hole you called out. Set `recursive_triggers = ON` on the connection alongside `BEFORE UPDATE`/`BEFORE DELETE` `RAISE(ABORT)` triggers on both tables. Also confirm `PRAGMA foreign_keys = ON` per connection, or the FK to `graph_invocation_responses` is decorative.

**8. Keep one `graph_apply_resolutions` table with PK `effect_key` and a discriminated `kind`.** That is load-bearing: it makes applied and quarantined mutually exclusive for free, so a host can neither quarantine a confirmed apply nor confirm a quarantined one. Worth a comment so nobody "normalizes" it into two tables later.

**9. Derive the receipt; share the accounting write.** Good call that only `evidenceRef`, `actualTokens`, target tree and journal digest come from the host — take nothing structural from host JSON. Factor a single private `writeOutcome(action, outcome, now)` used by both `settleOutcome` and `completeApply` so `accounting_blocked = actualTokens === null || actualTokens > reservationTokens` and the exact charge cannot drift. Validate the derived `implementation_complete` receipt with `validateWorkerActionResponse` the way recovery's `settle()` does. Replay: compare `canonical(resolution)`, return `changed:false`, never re-touch `actual_tokens`.

**10. `GraphAdmissionStore.released()` takes no fence, no owner, no proof.** The entire P04b safety argument rests on "the admission is still held," and that invariant is currently one unfenced `UPDATE` away from being false — and releasing it unblocks takeover, terminal sealing, verification commit and epoch advance. At minimum document it as daemon-internal; better, route invocation effects through the fenced release gates from P0.1/P0.2 and reject bare `released()` when an apply intent exists.

**11. Add `unresolvedApplies` to `GraphVerificationSnapshot` and its digest,** and throw in `commit`. Today verification and `activate` are safe only *transitively* (running action → `unresolvedActions`; post-complete → `pendingAdmissions`). Putting the predicate in the digest also means a concurrent `beginApply`/`quarantineApply` invalidates an in-flight join instead of racing it. Snapshot shape change is fine — snapshots are intra-run ephemeral.

**12. Gate the whole API on the experimental compiler version.** Reuse the `compilerVersion.startsWith('code-delivery-functional-')` predicate already in `checkEpoch` so "activation" is an explicit compiler-version change rather than an API that is quietly live on every run.

## P2

**13. Recovery `unknown` over a confirmed applied receipt: reject — and it already is.** `settle()`'s unknown branch fails `OUTCOME_CONFLICT` when `action.outcome` is set, and `completeApply` writes resolution + outcome in one transaction. Don't loosen `settle()`; add (a) a test asserting the rejection and (b) an invariant test that no `graph_apply_resolutions` row can exist without a corresponding outcome (applied) or `unknown`/`cancel_pending` state (quarantined). Agree crossgen roll-forward/rollback stays unimplemented; the `INVOCATION_RECOVERY_UNSUPPORTED` guard should key off apply rows explicitly as well as request rows, purely defensively.

**14. Document the liveness price.** Crash in the window after the gate commits but before any write is indistinguishable from crash after a full write; the never-repeat rule correctly converts both into quarantine. Crash inside the completion transaction quarantines an apply that actually succeeded. Those are the designed costs and they are why P0.1/P0.2 must exist.

**15. Test additions beyond your list:** reserve/retry/`markRunning` for a *different* slot rejected while an apply intent is unresolved and permitted after an applied resolution; `activate` and verification `commit` rejected mid-apply; `recordOutcome` with `failed/retrySafe:false` rejected; post-takeover `beginApply` on the old effect fails `ACTION_GENERATION_MISMATCH` and never re-applies; and an explicit failing test for the `acquireLease` deadlock after `completeApply` so the release gate has something to satisfy.

Suggested new codes so the host's reaction is unambiguous: `APPLY_PENDING` (wait), `APPLY_INTENT_CONFLICT` (quarantine), `APPLY_TARGET_MISMATCH`, `APPLY_NOT_FOUND`, `APPLY_RESOLVED`.

## Explicit non-guarantees to state in the module header

- The `expectedTargetTree` comparison in `completeApply` is a **host self-consistency check, not integrity**. Core cannot read the filesystem; a buggy or compromised host can report the expected tree over a half-written worktree and core will record `confirmed`. A tree hash is computed by the host over whatever the host chose to hash — it does not authenticate the worktree, and it says nothing about untracked, ignored, or out-of-tree writes.
- The journal ref + digest are **auxiliary evidence only**. Core never opens the journal; its digest proves nothing about what is on disk. Any future roll-forward built on it is unsound until a real host verifier exists.
- `applyAuthorized` is a **serialization token, not proof that applying is safe**. Its guarantee is exactly one: no second `true` for this effect, ever.
- Nothing in migration39 authenticates a provider, a worker, or a filesystem. The durable value of this batch is attributability and non-repetition under crash — not correctness of the apply. Security for an activated host remains entirely in the unbuilt adapter/applier/verifier, and the compiler-version gate (P1.12) should keep that distinction mechanical rather than a comment.

## 实现复审可用性与最终验证

设计审计成功，但本批不能宣称完成了 Opus 代码复审：

- design: is_error=False; CLI modelUsage=claude-haiku-4-5-20251001, claude-opus-5。
- implementation: is_error=True; CLI modelUsage=claude-haiku-4-5-20251001, claude-opus-5。
  返回：API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.
- focused: is_error=True; CLI modelUsage=claude-haiku-4-5-20251001。
  返回：API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.

两次代码复审（high 全量、medium 聚焦）均遇到服务端500，没有有效代码审计结论；第二次甚至没有记录 Opus modelUsage，不能将请求的模型名当成执行成功证据。没有切换别的模型冒称 Opus。

本地核验：事务内 intent/receipt 回滚、applied 结果与预算同事务、旧 snapshot 冲突、未完成 apply 阻断后续 action / join / epoch、成功 release-only outcome 精确匹配、quarantine 物理释放不清除 unknown/预算、跨 generation 不重新授予 apply、不可变 SQL 包括 OR REPLACE，均有通过的断言。恢复 proof 的实际 host verifier 仍属下一批接入工作。

最终补强了子进程 file URL 的转换，使用 fileURLToPath，所有27个 apply 测试在含空格的临时目录再次通过；core build 和7个变更TS文件的 Biome 再次通过，未改时间门槛。完整回归仍为450个 state测试 +53个 broker测试，不重复累计这27项。

后续继续开发前应重试这轮外部代码复审，重点审阅 GraphRecoveryStore 的 release-only / quarantine-release 分支。该缺口不影响对已运行本地测试结果的陈述，但不能替代独立模型复审。

# Graph invocation ledger：实现、Opus 5 审计与继续开发入口

本批在 `codex/graph-decision-development`、基线 `d32e175` 上完成 P04a 请求/响应证据基础。独立工作树开发；原 checkout 未改。没有真实付费请求、provider 接入、多文件应用、push、PR 或发布。P04 不能整体标为完成：apply 权威与专用恢复仍待开发。

## 已实现

- migration 38：一项 effect 对应一条不可变 request 和至多一条不可变 response，保留外键与禁止更新/删除/重复插入（含 OR REPLACE）触发器。
- `GraphActionStore.beginInvocation`：请求绑定与既有 action 的 running 转换同事务提交；只有 changed=true 授予一次发送资格。复用既有 reservation、logicalAttempt、原始期限，零重复预算账本。
- 请求绑定当前 run/effect/generation/program、Git 基线与 action 的 input/workspace。其他内容摘要由 host 生成并验证，不能把摘要格式校验称为授权验证。
- `recordInvocationResponse`：保存提案/无法完成/拒绝结果的证据引用；迟到响应不清除 unknown，不释放预留或写租约，不等同于 implementation_complete。
- generic recordOutcome 不允许新调用变成 confirmed 或 retry-safe failure；旧恢复器 applied/not_applied 分支对新调用拒绝，unknown 保留。
- 独立进程 SIGKILL 故障注入，使用落盘的模拟调用计数，验证两次重启不重复发送。测试不代表真实 provider 或断电保证。

完整权威边界、字段核对与下一阶段门槛见 [ADR](../design/2026-09-21-graph-invocation-ledger.md)。

## 验证

Node v22.22.1；临时 SQLite，不触碰默认 OSSTACK_HOME。

- `pnpm --filter @osstack/core exec vitest run src/state --maxWorkers=2`：33 文件，423/423。
- CLI `graph-action-broker`、`graph-action-broker-boundary`、`daemon-graph-action-broker`：3 文件，53/53。
- core build、typecheck、7 个变更 TS 文件 Biome 均通过；inventory fresh；diff whitespace 检查通过。
- 新 invocation 测试 26 项；包含事务回滚、双连接旧 fence、五个独立进程 SIGKILL 窗口（含事务内插入后退出）、不可变表、预算、跨 generation、迟到响应和恢复隔离。
- 新模块在已加载 protocol/zod 后增量 import 1.26ms。隔离 OSSTACK_HOME 的 CLI 启动：version 中位85ms（预算150）；help 中位229ms（预算500）。help 最大540ms，门槛按现有脚本中位值判定，未改阈值。
- 首轮故障测试有4项失败：生成的子进程脚本换行转义错误；修正夹具后全通过。未删断言或延长运行预算来掩盖失败。

## Opus 5 设计审计取舍

通过实际 Claude CLI `--model claude-opus-5 --effort high --tools ""` 审计；不启用嵌套技能。结果 modelUsage 包含 claude-opus-5，以及 CLI 的辅助 Haiku。模型意见逐条核对，不视为已验证事实。

采纳：阻止旧恢复器直接结算新调用；SQL 级别不可变；完整 canonical request 比较；保留迟到响应且不改变 unknown；明确数据库不可读时绝不发送；明确发送资格不等于 provider exactly-once；补充历史读取/跨代拒绝、release 后 receipt 重放、实际崩溃测试。

不采纳/校正：

1. “响应提交即可释放 admission”与后续同一写租约涵盖 apply 的要求冲突；P04a 不激活，release 仍必须服从未来 verified terminal handling。
2. “beginInvocation 插入 admission 即可消除中间窗口”不能证明真实 host 资源已取得。沿用 broker 先实际 acquire、assert、hold，再 beforeEffect 的顺序；hold 后 gate 前退出还没有 invocation request，可走既有 intent 恢复。
3. “baseRevision/workspaceLeaseRef 没有权威对应”不正确：分别对照 `run.spec.input.baseRevision` 与已有 implement/repair action.workspaceLeaseRef；后者仍不证明物理工作区租约有效。
4. legacy markRunning 对已启动 invocation 返回 changed=false，既有 broker 据此拒绝再次调用；不需要为了同一安全结果改变旧接口错误语义。
5. 不修改历史 recovery snapshot 格式。新 request/response 写入均提升 run.revision；旧 profile 的证明不可结算新调用。未来 apply 恢复另设计专用证明。
6. 保留既有 checkEpoch 错误语义；不借本批修改全局历史错误接口。

## 下一步验收顺序

付费调用启用前，先明确并验证断电持久性要求（含 SQLite 同步策略）；不能把 SIGKILL 测试当成断电证明。

1. 先定义 P04b apply intent / journal / committed receipt / quarantined 的数据权威和资源释放条件。旧 response 不代表 apply 成功。
2. P05 构造单次有上界请求、禁用自动重试、严格验证 provider 终止与用量；错误和超时的远端状态不明不得重新发送。
3. P06 host apply 与同一 broker write lease 贯穿，逐文件预像/路径/链接检查，部分应用永久阻止 freeze/review/join，直到专用恢复证据成立。
4. P07–P09 全量累积差异审阅、新编译身份、create/replace/delete 三文件真实端到端与各故障窗口。通过前不注册默认执行器。

## 设计审计原文

Reviewing as adversary against the four authoritative files. Findings are ordered by blast radius, each with the minimal fix.

## P0 — correctness defects that break the stated invariants

**1. The "no confirmed outcome for request-backed effects" rule is bypassable through recovery.**
You plan to enforce it in `recordOutcome`/`settleOutcome`, but `GraphRecoveryStore.settle()` (graph-recovery.ts) writes `state='confirmed'` with direct SQL and never goes through `GraphActionStore`. Any `commit({kind:"effect", verdict:{outcome:"applied"}})` confirms a request-backed effect with no apply proof. The same path also computes its own `retrySafe` (`run.status !== "cancel_pending" && actualTokens !== null && !accountingBlocked`), so it can hand out a retry that the P04 store-level rule forbids.
*Fix:* in `settle()`, look up `graph_invocation_requests` by `action.effectKey`; if present, `fail("APPLY_PROOF_REQUIRED")` for `outcome === "applied"` and force `retrySafe: false` for `not_applied`. Two guards, same transaction.

**2. Nothing in the design releases the admission, so every request-backed effect wedges its run.**
`retry()` fails `ADMISSION_RELEASE_PENDING` on an unreleased hold; `GraphRunStore.projectInTransaction` refuses `ready/failed/cancelled`; `acquireLease` refuses takeover. Release exists only via `GraphAdmissionStore.released()` (host, unfenced) or `GraphRecoveryStore.completeRelease` (admin). The design never names the release point. As written, the normal success path ends with a run that can be neither sealed nor relaunched.
*Fix:* name it explicitly and put it inside the fenced write: `recordInvocationResponse` releases the admission for terminal responses (`responseDigest` present), never for `stopEvidenceRef`-only/unknown responses — preserving "unknown never releases capacity." Host-side unfenced `released()` calls are revision-invisible (the `assertExecutorInventory` comment already admits this) and should not be the P04 mechanism.

**3. "Exact repeat idempotent" contradicts "requires current unreleased admission" — ordering bug.**
Your own test matrix has *SIGKILL after receipt commit before ACK*. On restart the host replays `recordInvocationResponse`; if release happened in that write (fix #2), or if state moved on, the gates reject the replay instead of returning `changed:false`.
*Fix:* check the stored-row-identical branch **first**, before state/generation/admission gates, exactly as `settleOutcome` does with `prior.outcome`. Same for `beginInvocation`: the running+identical-request early return must precede the stopping/unknown/deadline/accounting rechecks (`markRunning` already has this ordering — preserve it). Otherwise *crash after commit before dispatch* returns `WALL_CLOCK_BUDGET_EXHAUSTED` rather than `changed:false`.

**4. Requiring a pre-existing admission forces a two-transaction sequence with an unrecoverable middle state.**
`fencedGraphTransaction` throws if `db.inTransaction`, so `GraphAdmissionStore.hold()` cannot run inside `beginInvocation`. Hold-then-begin means a crash in between leaves `state='intent'` + unreleased hold. That state also permanently closes the `recordUnstartedOutcome` escape hatch, which fails if *any* admission row exists for the key — so the only exit is admin recovery.
*Fix:* insert the admission row inside `beginInvocation`'s transaction with inline SQL, mirroring how `settleOutcome(dischargeUnstarted)` inlines its `INSERT INTO graph_action_admissions` rather than calling the store. `beginInvocation` then *creates* the hold atomically with the request row and `running`, instead of requiring one. Strictly stronger for at-most-once and removes the window.

**5. Immutability must be schema-enforced, not code-enforced.**
Finding #1 is the existence proof that a second writer will bypass your store methods. Code-level immutability is not a constraint.
*Fix:* migration38 gets `PRIMARY KEY(effect_key)`, FK to `graph_actions(effect_key)`, and `BEFORE UPDATE`/`BEFORE DELETE ... RAISE(ABORT)` triggers on both tables. Verify `PRAGMA foreign_keys` is actually on for this connection — nothing in the shown files establishes it.

## P1 — bindings that are underspecified or unimplementable as described

**6. `baseRevision` is ambiguous in a way that will produce a wrong check.**
`GraphRun.revision` is the fencing counter, incremented by every mutating fenced write including `reserve()` and `beginInvocation` itself. If `baseRevision` means the run revision, the only coherent comparison is against `run.revision` pre-increment (== `fence.expectedRevision`); if it means the VCS base commit, it has no authoritative counterpart here at all.
*Fix:* rename to `baseCommit`/`treeDigest` if VCS, and state per field which authoritative value it is compared against. Do not conflate either with `run.revision`.

**7. `workspaceLeaseRef` has no authoritative counterpart in this batch.**
`graph_worker_leases` is a *worker* lease keyed by generation, not a workspace lease. "Match … workspace to authoritative run/action" is not implementable against the shown schema.
*Fix:* either land the workspace-lease table in P04, or record `workspaceLeaseRef` as opaque unvalidated evidence and say so in the ADR. Same honesty applies to `grantDigest`/`policyDigest`/`manifestDigest`: nothing in storage can validate them, so the ADR must not imply the store authenticates grants or policy. "Bindings not authentication" is the right framing — keep it literal.

**8. Conflict detection should compare the canonical request, not just `requestDigest`.**
The digest is host-computed and by your own framing unauthenticated; a host bug that digests a subset lets two different provider bodies share one row.
*Fix:* store canonical request JSON; on repeat compare `canonical(stored) !== canonical(input)` → `INVOCATION_REQUEST_CONFLICT`, and compare `requestDigest` separately. Mirror `settleOutcome`'s outcome-conflict pattern.

**9. Legacy/new cross-contamination needs guards in both directions.**
You have "legacy started action cannot be backfilled." The mirror is missing: `markRunning` must refuse an `effect_key` that already has a request row, or a legacy caller drives a request-backed action. And `recordUnstartedOutcome` must explicitly fail when a request row exists (today it only incidentally fails via the admission check).
*Fix:* one existence check in each of the three entry points; distinguish `running`+no-request (`INVOCATION_BACKFILL_FORBIDDEN`) from `running`+matching-request (`changed:false`).

**10. `getInvocation` takes `BEGIN IMMEDIATE` and calls `preflightDiskSpace`.**
`get()` routes through `this.write(...)` with `changed:false`; `fencedGraphTransaction` preflights disk before the read. A full disk therefore makes you unable to *read* whether you already dispatched — precisely the query the paid-call gate depends on at restart.
*Fix:* document fail-closed ("read error ⇒ never dispatch") and, preferably, give `getInvocation` a read path that skips `preflightDiskSpace`. It writes nothing.

**11. `recordInvocationResponse` requiring `state === "running"` loses real evidence after `markUncertain`.**
Realistic sequence: dispatch → supervisor uncertainty → `markUncertain` (state `unknown`) → the provider response actually arrives. Under the stated rule that evidence can never be durably recorded, even though the response row carries no settlement authority by design. `stopEvidenceRef` being in the response schema suggests you already half-expect this case.
*Fix:* permit insertion under `running`, `unknown`, or `cancel_pending`; keep immutability, keep zero settlement authority, keep "unknown does not release capacity." Strictly safer than forcing recovery.

## P2 — smaller, still concrete

**12. Snapshot digests don't bind admission rows.** `capture()` hashes `{fence, run, action, interruptId}`. `hold()`/`released()` don't bump `run.revision`, so a recovery snapshot taken before a hold stays "unchanged" under `unchanged()`; `commit()` never calls `assertExecutorInventory`. Pre-existing, but P04 widens it if any admission mutation stays outside the fence (another argument for #4). *Fix:* include the effect's admission row and invocation request/response digests in `capture()`'s hashed body. Note the request row itself *is* revision-guarded, since `beginInvocation` sets `changed:true`.

**13. Don't reuse `admissionSchema`'s `count.max(2)` for the new request schema** — that epoch cap is specific to `GraphActionAdmission` and will silently constrain the request path.

**14. `checkEpoch` throws raw `Error("EPOCH_MISMATCH")`, not `GraphActionStorageError`.** If `beginInvocation` reuses it, callers can't discriminate by code. Add the codes to `GraphActionStorageErrorCode` and convert, or accept the inconsistency knowingly.

**15. Restrict on `prior.action.kind` from stored `action_json`**, never on a kind asserted in the request body.

## Test matrix gaps

Your list is good on crash points; it's missing the interaction cases:

- Recovery `commit(applied)` against a request-backed action must be rejected (finding #1). Without this test the whole rule is decorative.
- Full liveness loop: request-backed `failed` outcome → `retry()` → `acquireLease` → `project("ready")` all succeed. This is the test that catches #2; none of your listed tests do.
- `recordInvocationResponse` replay after admission release (#3), and after `markUncertain` (#11).
- Legacy `markRunning` on a request-backed key; `beginInvocation` on a legacy running key (#9).
- Two `beginInvocation` calls from the same fence with different `requestDigest` — `BEGIN IMMEDIATE` serializes them, second must get `REVISION_CONFLICT`, not a second request row.
- SIGKILL between response commit and admission release.
- Direct `UPDATE`/`DELETE` against both new tables must abort (#5).
- The paid-call counter harness must model dispatch as strictly-after-commit; otherwise *crash after commit before dispatch* is scored as a success when it is actually the lost-call case below.

## Scope gaps worth stating plainly in the ADR

- **At-most-once dispatch eligibility, and the lost-call case has no automatic exit.** Crash after the `beginInvocation` commit but before the HTTP send leaves `running` + request row + held admission forever: replay correctly returns `changed:false` and never resends, so nothing ever settles the effect. The only exit is `markUncertain` plus admin recovery. That is the honest cost of at-most-once, but the ADR must say it rather than implying the run self-heals.
- The store guarantees at most one *eligibility grant* per `effect_key` — not at most one HTTP request. A host that dispatches before commit, or that lets its HTTP client retry a socket, breaks it. The request row is evidence of eligibility, not evidence of dispatch; money can be spent with no response row.
- `grantDigest`/`policyDigest`/`manifestDigest`/`workspaceLeaseRef` are recorded, not verified, in P04.
- Apply remains P06 — with #1 fixed, the P04 statement "no request-backed effect can reach `confirmed`" is actually true across both write paths. Without it, it isn't.

## 实现复审处置

实际再次调用 Claude Opus 5 high，对源码、测试、迁移和 ADR 进行只读复审。

- 采纳：增加首次响应前 admission 已释放，以及 legacy action 没有 invocation 的负向测试。
- 采纳：通过 SQLite UDF + TEMP trigger 在 request INSERT 后、action running UPDATE 前 SIGKILL；重启先断言无 request 且 action 仍 intent，再验证两次重启总共只调用一次。
- 采纳：settleOutcome 的存在性门禁使用 SELECT 1；不为判断存在而完整解析历史响应。未来版本保留旧 schema parser，不能自动以新 schema 重解释历史证据。
- 采纳：新表增加 BEFORE INSERT 同 effectKey 拒绝触发器，测试 INSERT OR REPLACE 不可覆盖。不全局改变 recursive_triggers，不在本批修改旧迁移。
- 采纳并修正路径：子进程依赖从测试文件的 ../../node_modules 定位，避免 process.cwd()；模型建议的 ../../../node_modules 实际多上溯一级。
- 核实：protocol Commit 本来只允许40或64位小写hex，与新字段一致；不需要改变历史协议。
- 记录但本批不修改：旧 recordUnstartedOutcome 对成功写入后的同参重放会报 INVALID_ACTION_STATE，该行为在基线 d32e175 已存在；新 invocation 不能使用 unstarted 结算。未来单独修复必须验证确实来自已完成的 unstarted discharge，不能无条件把普通 failed outcome 重放当成清理凭证。
- 模型称新增 v2 必然使 v1 行不可读并不成立，取决于未来 parser 实现；保留历史分派是明确的后续要求。

以下保留复审原文；其测试计数和源码描述对应修补前审计快照，以本文最终验证与代码为准。

## Findings

### 1. The admission gate on the *first* response is never exercised — delete it and the suite stays green (`graph-actions.ts` → `recordInvocationResponse`)

`requireInvocationAdmission` is the only thing stopping a response from being appended after the host's physical resources were released, but no test reaches it. Walk every call site in `graph-invocations.test.ts`:

- deadline / immutability / late-unknown / rejected-disposition / crash-child cases — admission still held;
- `"replays receipt after release…"` — the release happens *after* a receipt exists, so the `invocation.response` replay branch returns `changed:false` **before** the admission check;
- `"generation takeover…"` — fails at `ACTION_GENERATION_MISMATCH`, several statements earlier.

Repro: remove `this.requireInvocationAdmission(run, effectKey);` from `recordInvocationResponse` and run the file — everything passes. The test whose name asserts the property (`"replays receipt after release, but does not accept a first response without admission"`) only exercises the first clause. `INVOCATION_NOT_FOUND` (response recorded against a `markRunning`-only legacy action) is likewise unreachable in the suite.

Fix — add the missing negative case on a *fresh* invocation:

```ts
it("refuses a first response once the admission is released", () => {
  start();
  new GraphAdmissionStore(db).released(key, 110);
  expect(() => actions.recordInvocationResponse(fence(), key, response())).toThrow(/INVOCATION_ADMISSION_REQUIRED/);
  expect(actions.getInvocation(fence(), key).invocation?.response).toBeNull();
});
it("rejects a response for an action that never bound a request", () => {
  run = actions.markRunning(fence(), key, "execution").run;
  expect(() => actions.recordInvocationResponse(fence(), key, response())).toThrow(/INVOCATION_NOT_FOUND/);
});
```

### 2. No process kill ever lands *inside* the begin transaction

The four SIGKILL points are all between transactions: `before_commit` kills before `beginInvocation` is even called, and the other three after it returned. The only evidence that the request INSERT rolls back when the running transition fails is the in-process trigger test, which exercises better-sqlite3's exception rollback — not a real process death with uncommitted WAL frames. So the doc's "before begin commit" bullet is weaker than it reads: the window between `INSERT INTO graph_invocation_requests` and `COMMIT` has no crash coverage, and that is exactly the window where a surviving orphan request row would (per `start`'s `existing && canonical(...) !== canonical(request)` / `prior.state === "running" && !existing` logic) permanently wedge the effect key.

This is testable without power-loss semantics, because it is a process crash: register a UDF and fire it from a trigger so the kill happens mid-transaction, after the insert.

```js
// in child.mjs, for a new point 'mid_transaction'
db.function('crash', () => process.kill(process.pid, 'SIGKILL'));
if (!restart && w.point === 'mid_transaction')
  db.exec("CREATE TEMP TRIGGER kill_mid BEFORE UPDATE OF state ON graph_actions BEGIN SELECT crash(); END");
```

Expected after restart: `getInvocation(...).invocation === null`, action still `intent`, and a subsequent `beginInvocation` returns `changed:true` with exactly one recorded call.

### 3. `recordUnstartedOutcome` is the one store method that is not replay-idempotent (`graph-actions.ts` → `settleOutcome`)

The `dischargeUnstarted` guard runs *before* the `prior.outcome` canonical-replay branch, and it requires `prior.state === "intent"` **and** no row in `graph_action_admissions`. Its own first call violates both of those post-conditions.

Repro (no crash needed — just a lost DB ACK and a refreshed fence):

```ts
const first = actions.recordUnstartedOutcome(fence(), key, { state: "failed", evidenceRef: "no-lease", actualTokens: 0, error: {}, retrySafe: false });
run = first.run;
actions.recordUnstartedOutcome(fence(), key, { state: "failed", evidenceRef: "no-lease", actualTokens: 0, error: {}, retrySafe: false });
// → GraphActionStorageError: INVALID_ACTION_STATE, where every sibling method returns changed:false
```

Every other settlement path treats an identical repeat as `changed:false`; this one turns it into a hard error, which is the wrong direction for a ledger whose entire contract is "a lost ACK is not a new fact." Fix: short-circuit the guard on an exact replay.

```ts
const replay = prior.outcome !== null && canonical(prior.outcome) === canonical(outcome);
if (!replay && dischargeUnstarted && (prior.state !== "intent" || /* …unchanged… */)) fail("INVALID_ACTION_STATE");
```

(The admission row inserted by the first call also means a genuine second discharge attempt is correctly refused, so the guard loses nothing.)

### 4. The apply guard full-parses invocation rows where an existence check is wanted (`graph-actions.ts` → `settleOutcome`)

```ts
if (readInvocation(this.db, effectKey) && (outcome.state === "confirmed" || outcome.retrySafe)) fail("INVOCATION_APPLY_REQUIRED");
```

`readInvocation` runs unconditionally for *every* action, legacy included, and pushes both stored JSON blobs back through zod. `graph-recovery.ts` → `settle` already does the right thing (`SELECT 1 FROM graph_invocation_requests WHERE effect_key=?`). Two consequences worth fixing now rather than at P07:

- `requestSchema.schemaVersion` is `z.literal(1)` and `graph_invocation_requests` is append-only and undeletable. The moment a v2 profile ships, every v1 row becomes unparseable, and because the guard parses rather than probes, `recordOutcome` on those actions starts throwing a raw `ZodError` instead of a typed storage code — on rows that exist precisely to be permanent evidence.
- The guard raises a schema error rather than `INVOCATION_APPLY_REQUIRED` for any row the current schema can't read, which inverts the intended fail-closed message.

Fix: make the guard an existence probe matching recovery, and make `parseInvocationRequest`/`parseInvocationResponse` a `discriminatedUnion("schemaVersion", …)` before any second profile version lands (gate P07 in the doc should say so explicitly).

### 5. Immutability triggers don't cover `INSERT OR REPLACE` (migration 38, and the same pattern in 35/37)

`SELECT RAISE(ABORT)` on `BEFORE DELETE` is bypassed by REPLACE conflict resolution: SQLite fires delete triggers during REPLACE **only** when `PRAGMA recursive_triggers` is ON, which is off by default. So `INSERT OR REPLACE INTO graph_invocation_requests(effect_key, request_json, created_at) VALUES(…)` silently rebinds a committed request while `DELETE`/`UPDATE` are blocked — and the test loop only asserts the latter two.

The store API never emits REPLACE, and the doc already puts raw SQLite writes outside the trust boundary, so this is hardening, not a live hole. But the doc's flat claim "Both tables have SQL UPDATE/DELETE guards" is stronger than the schema delivers. Either set `PRAGMA recursive_triggers = ON` in `openDb` (cheap, closes it structurally) or narrow the wording. If you enable the pragma, extend the existing loop with `expect(() => db.exec(\`INSERT OR REPLACE INTO ${table} …\`)).toThrow(/immutable/)`.

### 6. Crash test resolves dependencies through `process.cwd()`

`symlinkSync(join(process.cwd(), "node_modules"), …)` assumes vitest's cwd is `packages/core`. Launched from the repo root, the child resolves `better-sqlite3` and the workspace-linked `@osstack/protocol` against the root `node_modules`, where the workspace package generally is not present — the test then fails on `expect(child.stderr).toBe("")` with `ERR_MODULE_NOT_FOUND`, which reads like a durability failure. Same fragility in the hard-coded six-module transpile list: one new relative import in `db.ts` or `graph-runs.ts` breaks the child at runtime.

Fix: derive the link target from `new URL("../../../node_modules", import.meta.url)` (or `createRequire(import.meta.url).resolve("better-sqlite3")`), and assert up front that the target exists so the failure names its own cause. (`rmSync(dir, {recursive:true})` unlinks the symlink rather than traversing it, so cleanup is safe as written.)

## Verified, not defects

- **Transaction boundaries.** `fencedGraphTransaction` takes `BEGIN IMMEDIATE` before any fence read, refuses nesting, and the request insert plus the `intent → running` update share one commit; the trigger-injection test proves the rollback pairing. `GraphAdmissionStore.released` runs in an implicit transaction and therefore cannot mutate admission state underneath an open `IMMEDIATE` reader, so the `released_at IS NULL` check is not a TOCTOU.
- **At-most-once eligibility.** `changed:true` is reachable exactly once per effect key: `prior.state !== "intent"` closes the second entry, `existing && canonical !== canonical` closes rebinding, `prior.state === "running" && !existing` closes legacy backfill, and the revision fence serializes competitors. Restart paths in the crash child never append to the call counter because they never observe `changed:true`. The counter assertions are non-vacuous — a duplicate dispatch yields `calls === 2` and a never-dispatching bug yields `calls === 0` on `before_commit`.
- **Trusted-host vs. worker JSON.** Nothing in `graph-invocations.ts` widens the boundary: `GraphJsonValue.parse` runs before the strict schemas (accessor rejection is asserted with a read counter), no agents import, and every field the storage layer cannot authenticate is explicitly assigned to the host in the binding matrix.
- **Migration 38 is additive.** Two new tables, four triggers, no `ALTER`, no backfill, FKs into existing PKs, `CURRENT_SCHEMA_VERSION` derived from the tail. The length CHECKs bound both payloads with roughly 6× headroom against maximal 256-char refs.
- **Retry is unreachable for request-backed actions** by construction: `retrySafe` can only be set by `settleOutcome` (blocked by `INVOCATION_APPLY_REQUIRED`) or recovery `settle` (blocked by `INVOCATION_RECOVERY_UNSUPPORTED`), so `retry_safe` is structurally pinned to 0.

## Documented future work, restated for the record (not counted above)

The reservation stranded by an `after_commit` crash, the absence of apply authority, admission never releasing on a terminal response, and cross-generation/post-release rejection of a *first* late response are all stated in the design doc as P04b/P06 gates. I'd only note that the last one is the sharpest edge of the set: an epoch bump, a generation takeover, or a supervisor `released()` each permanently discard evidence of a call that may have been paid for, which sits in tension with "must not infer that an absent response means no paid request occurred." That is a P04b design question about where evidence is quarantined, not a defect in this batch, and it is distinct from the rejected proposals — it neither releases admission on a response nor invents admission from a DB insert.

## One thing to confirm

`requestSchema.baseRevision` accepts only 40- or 64-hex, and `start` compares it with `===` against `run.spec.input.baseRevision`. If the run spec's schema permits anything looser there (short SHA, ref name), `beginInvocation` becomes permanently unsatisfiable for otherwise legal runs with a `INVOCATION_BINDING_MISMATCH` that points at the request rather than the spec. Worth a glance at the spec schema; if it is looser, either tighten it or normalize before comparing.

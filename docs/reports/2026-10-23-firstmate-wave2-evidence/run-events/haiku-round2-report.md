# Follow-up static audit: R4 bounded run replay

**Scope and limits:** Static reading only. I did not run tests. I did not see `attention-store.ts` (`store.write` semantics and fencing), `migration42`, `attention.ts`, or `SessionDecision`. Findings that depend on them are marked *conditional*. Line numbers are omitted because the sources have none. Schema facts come only from `MIGRATION1`, which defines `events.run_id REFERENCES runs ON DELETE CASCADE`, `payload_json TEXT NOT NULL`, and `approvals`/`clarifies` with `run_id ... ON DELETE CASCADE`. `openDb` sets `foreign_keys = ON`.

## Verdict

No P0 found. Under the owner-approved contract, the first report's P1-1, P1-2, P1-3, P1-4, and P1-5 are closed or closed-with-residual. I found several new P2 issues, mostly contract-conformance drift, plus one behavior change in the authority writer that needs owner confirmation.

## First-report dispositions

**P1-1 (complete=true on prefix deletion): Closed under the contract.**
- `event_replay.complete` is now the literal `false` on the main projection path. The first report's `complete:true` sequence cannot occur.
- Prefix tests exist (`it.each(["delete","mutate"])` in the non-anchor test). They assert `complete:false` and `completeness_scope:"unverified_retention"`.
- Residual: after a non-anchor prefix delete with the anchor intact, `caught_up` stays `true`. The owner's contract allows this, but the test does not assert it. Add an explicit assertion so the narrow `caught_up` meaning is pinned.

**P1-2 (task/scope change leaves run facts claiming complete): Closed for the three tested mutations.**
- The observer early-return updates `attention_run_cursors` (`gap=COALESCE(gap,'source_missing')`) and rewrites every `attention_subjects` row for the scope, with no `kind` filter. Session and run subjects are both quarantined.
- Residual: the test reads only `kind='run'`. No test checks a session subject's facts after task deletion.

**P1-3 (run ID reuse keeps cursor alive): Prerequisite false. Closed.**
- `MIGRATION1` has `events.run_id ... ON DELETE CASCADE`, and `openDb` enables foreign keys. Deleting a run removes its events, so the anchor is absent and fails with `event_anchor_changed`.
- Residual (low): if a new incarnation has the same `started_at` and deterministically re-emits byte-identical events (same `event_id`, `created_at`, payload), the anchor matches. Continuity then hinges on identical replay, not on incarnation identity. Adding an incarnation token would close this, but it is not a current P1.

**P1-4 (runs with agent_sessions never replayed): Closed.**
- Run discovery is an independent `UNION ALL` arm with no `agent_sessions` predicate. Session-bearing runs get a run subject. The test "discovers the durable event stream even when the run also owns an agent session" covers this.
- Global `admitted=1` count is shared across session and run subjects, as the owner specified.

**P1-5 (approval/clarify resolution not run-scoped or CAS-guarded): Closed for the stated families, with two residuals (see N4 and N5).**
- Resolution is `WHERE ... AND run_id=? AND status='pending'`, with `changed!==1` triggering a prior read and throw. This is inside the event-append `withWrite`, so a throw rolls back the event row.
- The matching-echo exception does not overwrite `resolved_at` (the test asserts `resolved_at: 2` after an echo at seq 2).
- Both families are tested through `it.each`.

**P2-1 (lookahead payload transfer): Premise incorrect in current code.**
- `readRunEventPage` reads `LIMIT input.limit` payload rows. `hasMore` is a `SELECT 1 ... LIMIT 1`, which is already seq-only. No lookahead payload is transferred.
- Remaining risk: each admitted run reads one page per tick, up to 200 rows × 64 KiB ≈ 12.8 MB per run. With 100 admitted runs, one tick can materialize about 1.28 GB of JS strings inside one synchronous transaction, with `JSON.parse` on each. The owner classifies this as future performance work. I agree it is future, but the per-tick byte budget is still absent.

**P2-2 (stale_owner swallowed; unfenced update): Closed.**
- The subject loop rethrows `stale_owner`. `update` calls `assertOwner` first. The scan runs inside the outer `store.write`.
- Conditional: fencing of the direct `store.db` write depends on `store.write` (not visible).
- Test gap: no two-connection supersession test.

**P2-3 (scope check after missing-run branch): Closed.**
- The task/digest check now precedes `if (!run)`. Test gap: no test uses a forged scope with a missing run. The existing scope test uses a repo mismatch.

**P2-4 (corrupt cursor facts): Open, with a new inconsistency (N3).**

**P2-5 (corrupt inventory JSON): Closed.** `inventory` wraps `JSON.parse` in try/catch and returns `invalid_source`. The coverage predicate uses `json_valid`.

**P2-6 (sticky gaps and stable admissions): Accepted as intentional.**

**P2-7 (facts.state shape): Open (drift, N2).** The owner approved a union of "snapshot object or source_missing marker." The code also emits the bare string `"unknown"`.

**P2-8 (status observation semantics): Accepted.**

**P2-9 (NULL payload label): Dead branch.** `payload_json TEXT NOT NULL` in `MIGRATION1` makes the null branch unreachable. The label is harmless.

## New findings

### N1 (P2, contract conformance): `event_replay.complete` is absent on several paths

The owner's contract says `complete` is always `false`. Only the main projection path and the source-missing early-return set it. These paths omit `event_replay` entirely:
- `projectAttentionRun` `!run` path (`writeSubject({state:"source_missing",...})`)
- `projectAttentionRun` binding-conflict path (`state:"unknown"`)
- `AttentionObserver.scan` per-subject catch (`update(... invalid_source ...)`)
- `inventory` JSON fallback

Reproducer (uses the existing `setup()` harness):
```ts
const { event, observer, db, facts } = setup();
event(0); observer.tick(1000);
db.prepare("DELETE FROM runs WHERE run_id='r'").run();   // task remains
observer.tick(2000);
expect(facts().event_replay.complete).toBe(false);
// actual: TypeError, event_replay is undefined
```
Fix: include `event_replay:{complete:false, caught_up:false, gap:...}` in every run-facts write, or make the consumer contract tolerate absence explicitly. Test each path.

### N2 (P2): `facts.state` uses a string `"unknown"` outside the approved union

Binding-conflict, invalid-source, and inventory-fallback paths all write `state:"unknown"` as a string. The approved union covered only an object or the `source_missing` marker.

Reproducer:
```ts
const { event, observer, db, facts } = setup();
event(0); observer.tick(1000);
db.prepare("UPDATE runs SET session_id='other' WHERE run_id='r'").run();
observer.tick(2000);
expect(typeof facts().state).toBe("object");   // actual: "string" ("unknown")
```
The existing test `retains unknown evidence across source deletion and ID reuse` codifies the string. Either add `"unknown"` to the approved union explicitly or normalize it to a marker object. Caller casts are the risk the owner asked to avoid.

### N3 (P2): corrupt cursor facts behave inconsistently depending on prior gap

- If `gap` is null and `facts_json` is corrupt, `gap ??= "invalid_cursor_facts"` runs and the loop is skipped. The run stalls. This matches P2-4.
- If `gap` is already non-null (for example `event_sequence_gap`), `gap ??=` is a no-op. The guard `gap !== "invalid_cursor_facts"` is then true, so the loop **advances the cursor**. `state` is reset to `{observed_status:null, unsupported_events:0}`, dropping previously counted unsupported events.

Reproducer:
```ts
const { event, observer, db, cursor } = setup();
event(0); event(1); observer.tick(1000);                 // cursor 1
db.prepare("UPDATE attention_run_cursors SET gap='event_sequence_gap', facts_json='{' WHERE run_id='r'").run();
event(2); observer.tick(2000);
expect(cursor()?.last_seq).toBe(1);   // actual: 2
```
The sticky gap keeps `complete` and `caught_up` false, so no false claim results. But the handling is inconsistent with the owner's "conservative, operator diagnosis" stance, and the counter loss is silent apart from the gap. Make the guard depend on the facts validity (not the gap value), so corrupt facts always stall.

### N4 (P2, needs owner confirmation): matching-echo exception ignores `event.terminal`

The owner's contract names "exact terminal+choice/answer echoes." `appendEvent` compares `status` and `choice`/`answer` but never compares `ev.terminal`. A same-run echo with a different terminal flag is therefore appended, not rolled back.

Reproducer (run-store.test.ts harness, approval family, run `a`):
```ts
emit("a", 0);                                                   // requested
appendEvent(db, path, { event_id:"a:1", run_id:"a", session_id:"a", seq:1, created_at:2,
  terminal:false, type:"approval.resolved", payload:{approval_id:"shared", status:"accepted", choice:"yes"} });
appendEvent(db, path, { event_id:"a:2", run_id:"a", session_id:"a", seq:2, created_at:3,
  terminal:true,  type:"approval.resolved", payload:{approval_id:"shared", status:"accepted", choice:"yes"} });
// actual: no throw. Contract as written: a non-exact echo should roll back.
```
If `terminal` is intentionally excluded, the contract text should drop it. Otherwise add the comparison and a test.

### N5 (P2, behavior change): `approval.resolved` for an unknown approval now throws

The file header claims "identical SQL semantics" for relocated code. The current resolution branch throws `approval_resolution_conflict` when no row exists for `(approval_id, run_id)`, so a resolution whose `requested` was never recorded now rolls back the event. Before this change (as far as the provided sources show) the event was accepted. Adapters that replay or drop `requested` events could start failing.

Reproducer:
```ts
insertTask/insertRun for run "a" as in the harness
appendEvent(db, path, { event_id:"a:0", run_id:"a", session_id:"a", seq:0, created_at:1, terminal:false,
  type:"approval.resolved", payload:{approval_id:"ghost", status:"accepted", choice:"yes"} });
// current: throws approval_resolution_conflict; event row rolled back
```
Also note the related cross-run gap: `approval.requested` uses `INSERT OR IGNORE`. A run `b` requesting an approval ID already owned by run `a` silently gets no authority row. Its later resolution then conflicts, and its projection sticks at `authority_reference_missing`. This is safe but is a liveness defect worth recording.

### N6 (P2, latent): `undiscovered` ignores runs

The end-of-scan `undiscovered` query checks only `agent_sessions`. Run discovery is now independent, so an undiscovered run never affects `scan_complete`. A run inserted behind `discovery_after` is missed until the keyset wraps. Coverage stays `degraded` in practice because any discovery page with 250 rows implies total subjects above the 100 cap, so I did not reproduce a false `covered` result. Fix it anyway: add a run-side `NOT EXISTS`.

### N7 (P2, contract language): `inventory` can report `covered` for run subjects whose completeness is never established

The `faulty` predicate flags only `reason` values other than `snapshot_only` and `gap='history_gap'`. A caught-up run has `gap:"retention_unverified"` and `complete:false`, yet it counts as covered. Session subjects already behave this way (`mutable_snapshot_no_complete_event_log`), so this is consistent but conflicts with "coverage is observation, not completeness." Decide whether `covered` should imply anything about history, and if not, rename the state or document it.

### Test gaps (new or confirmed)

- Session-subject facts after task deletion (P1-2 covers only the run).
- `caught_up` after a non-anchor prefix deletion (should be pinned as `true` per contract).
- Forged scope with a missing run (P2-3).
- `done.last_seq` validation, `error` events, `authority_reference_missing`, `invalid_cursor_facts` with a non-null prior gap (N3).
- Approval echo with a differing `terminal` flag (N4).
- Resolution for an unknown approval ID (N5).
- Two-connection supersession during a tick (P2-2).
- Index or query-plan check for `events(run_id, seq)`. `MIGRATION1` does create `uq_events_run_seq ON events(run_id, seq)`, so this is likely covered, but I have not verified the plan.

## Limitations

- No test execution. Test expectations above are read from source, not observed.
- Conditional on unseen files: `store.write` transaction and fencing semantics (also whether a nested `store.write` inside `db.transaction` works); `migration42` FKs for `attention_run_cursors` and `attention_subjects` (whether orphans survive run or scope deletion); `owner_released` writer; SessionDecision types.
- Retention is not guaranteed. Results describe only the caught-up retained range.
- Liveness is unknown. Observations do not authorize execution.
- Performance and soak are not qualified.
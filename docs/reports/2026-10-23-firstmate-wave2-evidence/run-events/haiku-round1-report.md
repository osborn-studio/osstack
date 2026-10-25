# Static audit: bounded run event replay (base 0a7b2ba6)

**Method and limits:** Static reading only. I did not run tests or inspect `db.ts` (`withWrite` transaction mode), `migration42` (indexes, FKs, triggers), `attention.ts`, or `SessionDecision`. Findings marked *conditional* depend on those files. Line numbers are omitted because the sources were provided without them.

## Verdict

**No P0 confirmed** in the new reader or projection. The following hold on reading:

- The reader bounds payloads in SQL (`CASE ... <= 65536`) and bounds IDs and types with `substr`.
- Cursors are validated as safe integers.
- The default-tenant join is applied in both the reader and the projection.
- Writes go through `store.write`, and cursor and subject facts commit in one transaction (the rollback test covers this).
- The projection never writes `approvals`, `clarifies`, or `attention_actions`.

The P1 items below are about the completeness claim, identity fencing, and authority integrity.

## P1

**P1-1. Deleted or mutated processed prefix still reports `complete: true`.**
*Where:* `projectAttentionRun`, anchor check.
*Why:* The anchor only re-hashes seq = cursor. Nothing re-verifies seq 0..cursor-1.
*Failing sequence:* Events 0–5 are processed, so cursor = 5, through_seq = 5, complete = true. Then `DELETE FROM events WHERE run_id='r' AND seq<=3`. On the next tick, the anchor (seq 5) matches. The page after 5 is empty. `max` = 5 is not `< afterSeq` or `< high`, so `sequenceGap` is false. `backlog` is false and `unsupported_events` is 0. Result: `complete: true`, `gap: null`. A fresh `readRunEventPage` from -1 would report `first.seq = 4` as a gap.
*Fix:* On each tick, verify the retained prefix: `COUNT(*) WHERE run_id=? AND seq<=cursor = cursor+1` and `MIN(seq)=0`. Alternatively, store a rolling chain digest checkpoint. Enforce append-only `events` with `BEFORE UPDATE/DELETE ... RAISE(ABORT)` triggers in migration42 (parent-owned). Add tests for prefix deletion and non-anchor mutation.

**P1-2. Task/scope-level source deletion leaves run subjects claiming complete.**
*Where:* `AttentionObserver.scan`, the early-return branch for `!task` or scope digest mismatch.
*Why:* The branch updates `attention_items` and `attention_scopes` and returns. It never quarantines `attention_run_cursors` or rewrites run-subject facts. Run projection never runs in that tick.
*Failing sequence:* A tick sets run facts to `event_replay.complete: true`. Then `UPDATE tasks SET tenant_id='x'` (or delete the task). The next tick hits the early return. Scope `error` is set, but the run subject still reports `complete: true, gap: "retention_unverified"`. This violates "source deletion cannot claim complete".
*Fix:* In the early-return branch, for every run and session subject in the scope, set `gap = COALESCE(gap,'source_missing')` on the cursor and rewrite facts with `state: source_missing`. Add a test that deletes or retenants the task, not only the run.

**P1-3 (conditional on migration42 FKs). Run ID reuse between ticks keeps the cursor and `complete` alive.**
*Where:* `projectAttentionRun` binding, and `insertRun`/`runs` schema.
*Why:* The binding covers `run_id, task_id, session_id, agent_id, capability_id, started_at`. It has no incarnation token. If the run row is deleted and re-inserted with identical identity fields between ticks, the binding matches and no `source_missing` quarantine ever runs.
*Failing sequence:* Tick → complete. `DELETE FROM runs WHERE run_id='r'` (events survive, meaning no cascade). `INSERT INTO runs` with identical fields. Next tick: binding matches, anchor seq 5 still matches, `complete: true`.
*Fix:* Add an immutable per-incarnation token (random UUID set at `insertRun`, stored in migration42) and include it in the binding. Also `RESTRICT` deletion of runs that have events, or cascade events and let the anchor catch it.

**P1-4 (intent needs owner confirmation). Runs that have `agent_sessions` rows are never event-replayed.**
*Where:* `AttentionObserver.scan`, the `rows` query. The run branch has `NOT EXISTS (SELECT 1 FROM agent_sessions ...)`, and the session branch never calls `projectAttentionRun`.
*Failing sequence:* Create a run with a matching `agent_sessions` row. Tick. No `kind='run'` subject is created and no `event_replay` facts appear. The projection is inert for session-bearing runs, which may be the common Hermes path.
*Fix:* Decide whether event replay should cover all runs. If yes, discover run subjects independently of sessions, or invoke `projectAttentionRun` from the session branch. Add a test with both a session row and a run.

**P1-5 (pre-existing, moved verbatim into `run-store.ts`). Approval authority writes are not run-scoped or status-guarded.**
*Where:* `appendEvent`, `approval.resolved` branch (and the clarify equivalent).
*Why:* `UPDATE approvals SET ... WHERE approval_id = ?` has no `run_id` and no `status='pending'` guard.
*Failing sequence:* Approval X belongs to run A and is pending. `appendEvent({run_id:'B', type:'approval.resolved', payload:{approval_id:'X', status:'accepted'}})` sets X to accepted for run A. A later `rejected` resolution can also overwrite an existing accepted one. The new projection then reports run A with no pending approvals.
*Fix:* `UPDATE approvals SET ... WHERE approval_id=? AND run_id=? AND status='pending'`, and throw if `changes !== 1` so the event append rolls back. Same for clarify. This is severity P1 here, and P0 if any execution gate reads `approvals.status` without run scoping (not verified).

## P2

**P2-1. Aggregate page bytes exceed the per-payload intent.** `readRunEventPage` selects payloads for `limit+1` rows, so the lookahead row's up to 64 KiB is transferred to JS but discarded. A page can be ~13 MB, and a tick with 100 admitted runs could transiently materialize about 1.3 GB inside one synchronous transaction. Fix: fetch the lookahead as `seq`-only or with an `EXISTS` check, and consider a per-tick byte budget. Perf qualification is future, so this is a risk, not a violation.

**P2-2. Fence error swallowed and unfenced write performed.** In `scan`'s subject loop, `catch` catches `stale_owner` and calls `this.update(...)` directly on `store.db`, bypassing `store.write`. This is practically unreachable if `withWrite` uses `BEGIN IMMEDIATE` (unverified). Fix: rethrow `stale_owner` and route `update` through `store.write`.

**P2-3. Scope identity is checked after the missing-run branch.** In `projectAttentionRun`, `if (!run)` quarantines and writes facts before the `scope_id` digest check. A forged scope on a missing run mutates state instead of rejecting. Fix: move the digest check above the `!run` branch.

**P2-4. Corrupt cursor facts can stall or silently reset counters.** If `prior` is invalid and `gap` is already set, `gap ??=` is a no-op. Processing continues with `unsupported_events` reset to 0 and the new facts overwrite the old. Completeness is still blocked by the sticky gap, so no false claim results. If `gap` was null, the run is stalled permanently with no repair path. Fix: explicit repair/reset path, plus tests.

**P2-5. One corrupt payload breaks the whole inventory.** `inventory()` calls `JSON.parse(payload_json)` per row with no guard. Fix: per-row try/catch returning an `invalid` marker and degraded coverage.

**P2-6. Sticky gaps have no recovery, and admission slots are never reclaimed.** A transient `authority_reference_missing` or `event_source_binding_conflict` permanently disables `complete` for that run. Completed runs keep their admitted slot forever, so after 100 admissions new runs are never observed. Coverage reports `degraded` (counts), but nothing evicts or re-admits. Cursor rows also grow without cleanup. These are design choices needing an owner decision.

**P2-7. Facts shape is inconsistent.** `state` is an object on the normal path and a string (`"source_missing"`) on the missing-run path. Consumers will break on one shape. Fix: normalize.

**P2-8. `status` events are not gated on `terminal`.** A non-terminal `status` event with `status: "completed"` sets `observed_status` to `completed`. Semantic only, since completeness is not derived from it, but it can mislead consumers.

**P2-9. NULL `payload_json` is reported as oversized.** If the schema permits NULL, `CASE ... ELSE NULL` and `payload_bytes` NULL yield `oversized_event_payload`. The label is wrong, though the outcome (no advance) is correct.

## Test gaps

- No test for prefix deletion or non-anchor mutation (P1-1).
- No test for task deletion or retenancy in the observer (P1-2).
- No test for run ID reuse with identical binding (P1-3).
- No test for runs with `agent_sessions` rows (P1-4).
- No test for cross-run or repeated `approval.resolved` through `appendEvent` (P1-5).
- No test for `throughSeq > max` (sequence-gap path), for event_id or session_id over 4096, for a payload at exactly 65536 bytes, or for NULL payload.
- No test for `done.last_seq` validation, `error` events, `authority_reference_missing`, or `invalid_cursor_facts`.
- No test for admission capacity (100) or inventory pagination and coverage.
- No two-connection test of owner supersession during a tick (P2-2).
- No index or query-plan check for `events(run_id, seq)`, which the MAX, MIN, and range queries assume.

## Limitations

- Retention is not guaranteed. Results describe only the caught-up retained range.
- Liveness is unknown. There is no adapter, network, or executor port in this code.
- Observations do not authorize execution. The projection does not write approvals or actions.
- Performance and soak are not qualified. The 65000 ms scope `deadline` predates this change and was not reviewed as a run-projection deadline.
**Verdict: accept with two required follow-ups** (one behavioral fix, one test batch). No security regression found; the authority boundaries hold. Findings below, ordered by severity.

**1. Reconcile can reject a cancellation it has already durably acknowledged** (`graph-rpc.ts:164-183`). The non-replay path commits `cancel_pending` via `projectRequest` before the proof attempt. Any reconciler error outside the two `missingProof` codes and the `concurrentCancellation` case is rethrown. Concrete trigger: two reconciles with different keys on the same run. Key A projects rev 4 and yields inside the proof. Key B at rev 4 projects rev 5 and commits `cancelled`. A's `store.commit` fails on a stale snapshot; `current.status` is `cancelled` so A is swallowed. But if B is instead a plain `graph.cancel`, A's commit fails and `current.status` is still `cancel_pending`, so A rethrows. Through `graphRpcError`, reconciler codes such as `RECOVERY_INVENTORY_CHANGED`, `RECOVERY_GENERATION_CHANGED`, `DECISION_CONFLICT` and `RECOVERY_BINDING_MISMATCH` map to `INTERNAL_ERROR`. The CLI then exits 1 and, per the help text, reports "input/RPC rejection", while the run is durably `cancel_pending` under that key and a retry would succeed via replay. Fix: after projection, rethrow only authority failures (the outer `authorize('cancel')` already covers this) and otherwise return `this.status(...)`. The run state is the truthful answer; the proof failure is not a rejection of the request.

**2. Post-commit authorization check turns a durable `cancelled` into a `GRANT_EXPIRED` reply** (`graph-rpc.ts:184`). The final `synchronous(registration.authorize('cancel'))` runs after the recovery decision is committed. If the grant lapses in that window, the caller gets an error for a run that is now `cancelled`. Retry replays fine, so this is a reporting inconsistency, not a safety issue. Same fix as 1: move the check before `cancelUnstartedGraphWorker` or accept the asymmetry in a comment.

**3. Help text overclaims** (`graph-execution-command.ts:18`). "Recheck a CancelGraphRequest using trusted host stop evidence" is wrong for this slice. The endpoint proves no-start across every generation; it never uses stop evidence. Say "trusted host no-child evidence".

**Sound as designed (verified by reading the paths):**

- Method mapping and idempotency. Digest includes kind and `expectedRevision`, so a `start`, `resume` or different-revision request under the same key hits `IDEMPOTENCY_CONFLICT`. Only `graph.reconcile` with `cancel_pending` and `revision === expectedRevision + 1` re-enters recovery. `graph.cancel` replays are read-only. This assumes `projectRequest` bumps revision by exactly one and every generation change bumps revision.
- Proof authority. No request field reaches the reconciler except the receipt digest. `GraphRequest` is strict, so forged `evidenceRefs` fail parse before any DB write (tested at `graph-reconcile-rpc.test.ts` forged-proof case).
- Stale generations. `verify` requires a `spawn_failed` proof for every inventoried worker and the last one to match the fence. A later generation with a `launched` event or no launch row yields `GRAPH_NO_CHILD_PROOF_REQUIRED`, which is swallowed into `cancel_pending`. Correct, conservative.
- Deadline expiry. Removing the deadline check for `kind: 'project'` is right; cancellation starts nothing. Lease expiry is not turned into proof.
- Concurrent same-key requests. Second caller enters the replay retry path with a fresh `GraphReconciler`, loses the commit, and is swallowed by `concurrentCancellation`. Tested.
- Shutdown. `pendingRequests` is populated synchronously before any await, `closed` gates new entries, and `drain` captures the set once. A request cannot slip between `close()` and the spread. The drain test exercises close mid-proof with DB close afterward.

**Pre-existing, not introduced here:**

- Generation-0 `cancel_pending` projected straight to `cancelled` without proof (`graph-rpc.ts:167`). Relies on lease acquisition bumping generation atomically. The replay retry path now reaches this branch on a fresh host, which is new exposure of old semantics.
- Reconciler error codes are not `GraphErrorCode` members and collapse to `INTERNAL_ERROR`. Finding 1 makes this user-visible for reconcile.

**Missing tests (concrete):**

- Live driver in the same process, run `running` at gen 1 with actions present. Reconcile must return `cancel_pending`, write no `graph_recovery_decisions` row, and the driver's cancel chain must finish to `cancelled`. Nothing covers reconcile racing an actual supervisor.
- Two reconciles with different keys concurrently. Assert exactly one decision row, both callers eventually observe `cancelled`, and no caller receives an error (this pins finding 1).
- `graph.cancel` replayed while `cancel_pending`. Assert it stays `cancel_pending` with zero decision rows. The suite only checks `graph.cancel` after `cancelled`.
- Replay retry on a generation-0 `cancel_pending` run from a fresh host. Assert `cancelled` and no decision row, documenting the generation-0 shortcut.
- Generation change without a status change. Bump generation and owner but not revision, then replay the old key. Assert `cancel_pending` and no decision, proving the reconciler binding check backstops the revision heuristic.
- Daemon-level `graph.reconcile` from an unauthenticated socket returning `UNAUTHENTICATED`. The integration file covers this for `graph.result` only.
- In the `expired-deadline` case, also assert the lease has actually expired at the mocked time, or add a separate expired-lease case. The current test proves deadline independence, not lease independence.

**Nit:** `concurrentCancellation` calls `this.bound` inside the catch. A `RUN_MISMATCH` there would mask the original error. Read the run with `this.runs.get` instead.

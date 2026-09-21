**Verdict: no P0/P1 in the bounded C5 fix. The admission obligation is recorded and checked at every terminal, takeover, and retry writer I can see in the supplied source, and the lost-ACK path avoids in-memory quarantine. Three P2 items and a few P3 notes follow.**

## Invariant walk (confirmed)

- **Hold precedes invocation.** `graph-action-broker.ts` `executeRequest`: `this.admissions.hold(owned.effectKey, …)` runs after `await this.options.acquire(...)` and before `check()` and `beforeEffect`/`markRunning`. Before the hold exists, the `intent` row already blocks takeover and terminal projection via the existing `UNRESOLVED_ACTION` checks, so there is no window where the run is both resolvable and unheld.
- **Release only after physical release.** `releaseAdmission`: `released()` runs only after `await lease.release()` returns. If `released()` throws, `physicallyReleased` is true, `lease.retain` is skipped, the lease is kept in `retained`, and the error propagates. The confirmed outcome is already committed by `recordOutcome`, so a worker replay returns the confirmed response via `reserve` prior-lookup. Idempotent and fail-closed at seal.
- **Terminal / takeover / retry gates.** `graph-runs.ts` `projectInTransaction` and `acquireLease`, `graph-recovery.ts` `commit` (project `running`/`cancelled` and takeover), and `graph-actions.ts` `retry` all query `graph_action_admissions … released_at IS NULL`. `commit` records hold and settlement in the same `BEGIN IMMEDIATE`, so a crash cannot leave a settled action without an obligation.
- **Stale proof.** `completeRelease` goes through `unchanged` (fresh capture, canonical compare) and `this.proof` (digest, `verifiedAt` window, trusted verifier). The reconciler regenerates the proof on every `reverify` via `this.proof()`, and only the reconciler's own `reverify(true)` can call `completeRelease`; the callback handed to `registration.release` is `() => reverify()` with `completed=false`. A trusted release callback cannot mark the obligation complete.
- **Immutability.** Migration 30 triggers block `released_at` un-set and deletes; the core test confirms both.
- **Worker reachability.** `GraphAdmissionStore` is constructed only inside the broker and `GraphRecoveryStore`; no worker JSON path reaches `hold`/`released`.
- **G25 unchanged.** After a daemon crash the `retained` map is gone, the DB obligation remains, and the only exit is the trusted reconcile path. No automatic recovery is introduced.

## Findings

**P2 (operability, in scope): post-restart recovery of a lost release ACK needs a byte-identical effect verdict.**
If the broker settled an action normally, physically released, and only the `released()` write was lost, then after a clean restart there is no retained lease and no recovery decision. The only way to reach `completeRelease` is `reconcile(kind: "effect")`, which runs `settle`. `settle` requires `canonical(action.outcome) === canonical(outcome)` or fails `OUTCOME_CONFLICT`, so `verifyOutcome` must reproduce the exact `evidenceRef`, `actualTokens`, and `result`. If the host's outcome verifier derives these differently from the broker's persist path, the run is sealed out forever with no release-only decision available. Recommend either documenting that `verifyOutcome` must read the persisted broker outcome verbatim, or adding a release-only decision kind in a follow-up. Not a safety bug.

**P2 (trusted-host contract, not worker-reachable): `completeRelease` cannot distinguish "released" from "nothing to release".**
`graph-reconciler.ts` `release()` accepts any `registration.release` that resolves to `undefined`, then records `released_at`. The new reconciler test does exactly this after `db.close()`/reopen with a release callback that only calls `reverify()`. That matches the prior ruling that `releaseReconciled(false)` is not proof the disk lock is gone, but the API places the entire burden on the host callback, with no way to return evidence because `authority()` rejects any non-undefined value. Keep as documented host obligation; do not claim the obligation table proves physical release.

**P2 (verification item, cannot confirm tool-less): other writers of `graph_runs.status`/`generation`.**
The gates cover `GraphRunStore` and `GraphRecoveryStore`. If the G13 checkpoint store or any daemon handle updates `graph_runs` status directly inside `fencedGraphTransaction` rather than through `projectInTransaction`, it bypasses the check. Grep for `UPDATE graph_runs SET status` outside these two files before closing.

**P3 notes**
- `hold()` after `acquire()`: an acquire that physically succeeds but throws leaves no obligation; the design relies on recovery `commit` to create one for the `intent` row. Acceptable, but hold-before-acquire with release-on-acquire-failure would be strictly tighter.
- `hold()` joins `graph_worker_leases` on the action's generation and fails `ACTION_NOT_FOUND` otherwise. Legacy actions whose generation predates lease rows would make `commit(effect)` unrecoverable for that run. Worth one migration-era check.
- `released()` does SELECT then UPDATE without a transaction. Harmless today because every caller holds the same key it just held, but wrap it if any concurrent hold path appears.
- FK on `(graph_run_id, generation)` only enforces with `PRAGMA foreign_keys=ON` and a unique index on the referenced pair; tests passing suggests it is fine, but confirm.
- `errorCode()` maps `ADMISSION_RELEASE_PENDING` to `POLICY_DENIED` with `nextAction: stop`. Correct semantics for a worker, but consider an explicit mapping so operators can tell it apart in logs.
- `releaseReconciled` calls `releaseAfterReconciliation` on a lease that was already released and never retained. The boundary test proves the fixture lease tolerates this, but `governed-execution.ts` is not in the supplied source, so idempotency is inferred, not reviewed.

## Test edits

The modified `generation` fence test now correctly expects `ADMISSION_RELEASE_PENDING` on the protocol takeover and fault-injects a raw `UPDATE graph_runs` to keep proving the final invocation fence. The old-generation release-replay test had to complete release before takeover, which is the intended new ordering. New tests cover projection block while held, lost ACK without quarantine, blocked takeover/seal across restart, forged proof on `completeRelease`, and trigger immutability. Coverage matches the stated invariants.
Code-search and memory tools were denied in this session, so everything below comes from the snapshot you pasted. Items that hinge on files outside it (migrations, `fencedGraphTransaction`, `validateWorkerActionResponse`, the worker manager) are listed separately as missing context rather than claimed as bugs.

## Verdict

Two reachable P1 availability bugs in the host-side lease/recovery plumbing, one P1 that depends on a schema fact I could not read, and a handful of P2s. The fencing and terminal seals hold; none of the recommendations weaken them. The C4 P1s from the prior review (retry intent claimable, cross-generation settlement, terminal seal blocking recovery, execution ref binding, quarantine counting) are addressed in this snapshot.

## P1

**1. A lease retained by the renewal timer is unreachable by reconciliation, and it turns a confirmed action into a thrown error.**
Location: `packages/cli/src/governed-execution.ts:82-91` (renewal failure sets `retained` and quarantines), `:127-133` (`release()` throws when retained); `packages/cli/src/graph-action-broker.ts:339-341` (`finally` releases unconditionally when `!uncertain`), `:324` (the `retained` map is only populated on the `invoked` catch path).
Sequence:
1. Write action admitted, repo lock held, adapter running.
2. Event loop stalls or the machine sleeps for more than 60 s, or the guard directory is busy for more than 2 s. `renew()` throws (`repo-lock.ts:233` lease expired, or `:171` guard busy). `retained = true`, repository quarantined. The broker is never told.
3. Adapter completes, stop confirmed, `persist` succeeds, `recordOutcome` writes `confirmed`.
4. `finally` calls `lease.release()`, which throws. The already-built confirmed response is discarded and the worker gets a transport error. In the failure branch the same throw masks `reject(error)`.
5. `this.retained` has no entry for the effect key, so `releaseReconciled` returns false forever. The repository stays quarantined for every writer until daemon restart. After restart the file lock needs `releaseReconciledRepoWriteLock`, which needs a committed recovery decision for a row that is already `confirmed`.
Fix: in the broker `finally`, catch the release error, insert the lease into `retained` with its context, and return the ledger response. Have `GovernedExecution` expose retained state or an `onRetained` callback so timer-driven retention is registered the same way.
Test: fake `RepoWriteLock` whose `renew` rejects once mid-execution. Assert the handle resolves with `confirmed`, `releaseReconciled(effectKey, ok)` returns true, and a subsequent write admission on the repo succeeds.

**2. Retrying a `release_pending` decision after a takeover stops the new worker.**
Location: `packages/cli/src/graph-reconciler.ts:98-108` (`release` rebuilds proof via `stopWorker`), `:117` (proof runs before the `prior` branch at `:133`); `packages/core/src/state/graph-recovery.ts:141-149` (`verifyDecision` demands a stopped-worker proof for the current generation).
Sequence:
1. Effect decision `not_applied` commits at generation N. `release` fails transiently, exit `release_pending`.
2. Host performs takeover to N+1 and starts a worker. Registration now binds N+1.
3. Host replays the effect request with a fresh fence, as the design says to do. `this.proof` calls `stopWorker` on the live N+1 worker, and `verifyWorker` must attest N+1 stopped before the old lease can be released.
4. Same shape for replaying a lost takeover response: the idempotent replay kills the worker it created.
This is the sanctioned retry path, so it is an availability bug, not operator error.
Fix: when a record exists and either the decision is a takeover or `run.generation > record.snapshot.run.generation`, do the replay and the lease release with a read-only verification that does not require stopping the current generation. Keep the stop requirement for first-time decisions.
Test: commit `not_applied`, force release to fail, run takeover, replay the effect request. Assert `stopWorker` was not called for generation N+1 and the lease released.

**3. Unknown-then-applied may violate a uniqueness constraint. Needs the migration.**
Location: `graph-recovery.ts:45` derives one `interruptId` per effect key; `:196` inserts it on every decision. `settle` at `:204-229` is explicitly written to allow a later `applied` or `not_applied` after an `unknown`.
If `graph_recovery_decisions` has a unique index on `interrupt_id` or `effect_key`, the second decision throws a raw SQLite error at `:196` and `unknown` becomes permanent, which is the prior review's interrupt-id concern realized. If the index is only on `(graph_run_id, receipt_id)`, this is a non-issue.
Test: commit `unknown` with receipt A, then `applied` with receipt B on the same effect key. Expect state `confirmed` and two history rows.

## P2

**4. Stop receipts are never compared to the action's own timeline.**
Location: `graph-recovery.ts:116-117` and `:122-123`. The checks are `confirmedAt >= leaseAcquiredAt` and `<= verifiedAt` only.
Sequence: lease acquired at t0, supervisor confirms stop at t1, the row's `markRunning` happens at t2 > t1 (receipt was premature). Proof passes. Same for the old-generation `effectWorker` path, which also never cross-checks the `stopped_worker_json` already stored for generation+1 at takeover.
Fix: require `confirmedAt >= action.updatedAt` for the settled row, and when a stored stop receipt exists for the next generation require `effectWorker` to equal it.
Test: row with `updated_at` later than `confirmedAt`; expect `WORKER_PROOF_MISMATCH`.

**5. Recovery takeover accepts a weaker stop proof than `acquireLease`.**
Location: `graph-recovery.ts:117` vs `graph-runs.ts:162`. `acquireLease` requires `confirmedAt >= run.updatedAt`, recovery only `>= leaseAcquiredAt`. Recovery cannot use `updatedAt` because its own effect decisions advance it, but it can check that no worker-originated write (checkpoint of that generation, or a ledger row with non-null `execution_ref` and no matching recovery decision) postdates `confirmedAt`.
Test: checkpoint written after `confirmedAt`; expect takeover to fail.

**6. Settlement still requires a live lease.** Still open from the prior review.
Location: `graph-action-broker.ts:316` and `:327` both use `this.fence(binding)`, which throws on expiry at `:210`.
Sequence: adapter outlives the lease TTL without renewal. `recordOutcome` throws, `markUncertain` throws for the same reason and is swallowed, the row stays `running`, the lease is retained, repo quarantined. A confirmed and persisted result is lost to recovery.
Fix: a settlement fence that checks generation, owner, and revision but tolerates an expired lease.
Test: advance `now` past `leaseExpiresAt` after `execute` resolves; expect `confirmed`.

**7. Attempts that never invoked are charged the full reservation and an action start.**
Location: `packages/core/src/state/graph-actions.ts:129` and `:131-135`; broker `:335` writes `actualTokens: 0` for pre-invocation refusals.
Sequence: transient quarantine or policy timeout refuses admission. Row is `failed`, `execution_ref` null, yet `charged += reservation`, `actionStarts++`, and the branch retry counter advances. A few refusals exhaust token, action-start, or branch budgets with zero physical work.
Fix: when `execution_ref` is null and state is `failed`, charge zero and do not count it as a start. Keep the branch attempt count if you want retries bounded.
Test: three admission refusals with reservation R; assert `chargedTokens` is 0 and `actionStarts` is 0.

**8. A stuck same-generation `intent` row blocks takeover and, after `acquireLease`, the whole run.**
Location: broker `:335-336` swallows fence failure in the catch path; `graph-recovery.ts:176` counts `intent` as unresolved for takeover; `graph-actions.ts:143` blocks all admits once the row is old-generation.
Sequence: `acquire` waits in the FIFO queue past lease expiry, throws, the failed-outcome write fails on the expired fence and is swallowed. Row stays `intent`. Only a recovery `not_applied` clears it. Fail-closed but noisy. The settlement fence from item 6 fixes the trigger.

**9. Worker is told to reconcile a healthy pending retry.**
Location: broker `:264` and `:349`. During the window between `retry()` at `:235` and `markRunning`, a worker replay of the slot receives `ACTION_OUTCOME_UNKNOWN` with `nextAction: reconcile`. Return a distinct pending code for current-generation `intent` or `running` rows with an in-flight handle.

**10. Still open from the prior review:** the 1 s `confirmStopped` race at `:437` and 50 ms grace at `:431` will produce unknown storms with real agents. Error strings at `:249` forward lock paths and PIDs to the untrusted worker, low severity given the same-UID model.

## Missing context, not claimed as bugs

- Whether `validateWorkerActionResponse` checks `workspaceLeaseRef` and `candidateRevision` equality. The broker checks them at `:313-314`; recovery `settle` relies on the protocol validator alone. If it does not, a recovery `applied` verdict can confirm a result bound to a different workspace lease.
- Whether the worker manager's heartbeat renewal is stopped by the registration's `stopWorker`. Renewal bumps revision and `leaseExpiresAt`, both inside the snapshot digest, so a live heartbeat makes every reconcile fail `PROOF_SNAPSHOT_MISMATCH`.
- Whether any other `acquireRepoLock` call site still relies on the legacy `recover_stale` default of true, which bypasses durable quarantine. `GovernedExecution` passes false.
- The `graph_recovery_decisions` index set, for item 3.

## Prior P1s confirmed fixed in this snapshot

Host retry intent is claimable only via `retryEffectKey` (`broker:264-267`). Cross-generation rows settle through `effectWorker` proof (`recovery:118-124`). `projectInTransaction` refuses terminal status with unresolved rows (`graph-runs:231-233`). Execution ref binds `task.run_id` (`broker:278`). Quarantine is a per-run set with a verified release path (`governed-execution:25-29`, `:100-125`).
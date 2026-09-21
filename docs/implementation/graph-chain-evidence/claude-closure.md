Code-search tools were declined, so this review is reasoned from the pasted source only. Three assumptions I could not verify from source are flagged explicitly as missing context rather than as findings.

## Verdict

No P0. Nothing in the pasted code performs an automatic retry, an expiry-based takeover, or a terminal resurrection. All previously adjudicated fixes are present in the source. Remaining items are one P1 that is really a scope boundary, and a set of P2s that are concrete and cheap to close.

## P1

**P1-1. Daemon crash with a live worker is unrecoverable through the journal, and nothing durable identifies the orphan.** Classification: product limit, but it is the gap between what the tests prove and what "true daemon SIGKILL" suggests.
- Scenario: daemon spawns worker (gen 1), worker's implement command is mid-flight, daemon is SIGKILLed. The worker's pipe breaks, the worker runtime calls `fail`, but the program's own timer keeps the process alive, and the command's process group is also orphaned. No `stopped.json` exists because `stop` never ran.
- The restarted daemon has no supervisor receipt. Takeover requires `stopped` or `not_started` proof, expiry is rejected by adjudication, and the store's `not_started` check only looks at ledger rows. The only honest verifier outcome is "cannot prove", so the run is stuck forever unless a verifier asserts stop without evidence.
- `graph_worker_launches` records owner and identity but not child PID, PGID, or spawn start time, so even an administrator cannot locate the orphan from durable state.
- The daemon-restart test covers restart only after a clean `stop` persisted the fixture's receipt, which is fixture logic and not product code.
- Minimal closure for C5: record `pid`, `pgid` and `spawn_time` in `graph_worker_launches` at spawn, and state in docs that crash-during-flight recovery is G19/G25 work.

## P2

**P2-1. `spawn_failed` phase cannot distinguish "launch denied before consumption" from "registration failed after the generation was consumed".** In the runtime's register callback the launch row is inserted, then `broker.register` and `checkpoints.register` run. Both `GRAPH_GENERATION_ALREADY_LAUNCHED` (an older worker may exist) and a post-insert `broker.register` fence failure (no process ever existed) yield `phase: 'registration'`. The adjudication says registration-phase receipts must not be used for `not_started`, which leaves the second case with a consumed generation and no valid proof path. The store's `notStarted` schema also drops `phase` entirely. Fix: three phases (`launch_denied`, `registration`, `spawn`) and carry `phase` into the proof schema.

**P2-2. Checkpoint requests are not tracked in `pending`, so `actionsSettled: true` does not mean quiescent DB writes.** `track` wraps only broker actions. A checkpoint `put` awaits the async `authorize` wrapper before writing. Sequence: worker sends `put`, host begins `checkpoints.execute`, stop kills the worker, `stop` resolves with `actionsSettled: true`, then the put commits under the old generation. Whether `unregister` blocks the write depends on whether the service rechecks the binding after its await. **Missing context:** I could not read `graph-checkpoint-service.ts`. If it does not recheck, a new generation can resume from a checkpoint written after the stopped receipt's `confirmedAt`. Either track checkpoint promises in `pending` or confirm the recheck.

**P2-3. Takeover is permitted while a retained admission for the same run exists.** `commit` takeover only inspects `graph_actions` state. After an `applied` decision whose release failed (`release_pending`), the action is `confirmed`, so takeover succeeds. The gen-2 worker's freeze then hits the quarantined repo or the lock file, is recorded `failed` not-started, and the program fails. To release the old lock now needs a new receipt with `effectWorker` proof plus a `stopped` proof for gen 2, which burns gen 2 and requires a third takeover. Safe, but a guaranteed dead generation. Fix: refuse takeover while any `graph_recovery_decisions` row for this run is applied-but-unreleased, which needs release state persisted (see P2-4).

**P2-4. A release failure on the normal confirmed path has no journaled release route once the run is terminal.** In `executeRequest`'s `finally`, a failed `lease.release()` after a confirmed outcome retains the lease and throws. No recovery decision exists yet. If the host then projects the run to `failed` (allowed, the action is resolved), `commit` refuses with `TERMINAL_RUN`, and `verifyRelease` needs a decision that was never created. The only remaining path is calling `releaseReconciled` with an ad-hoc verifier, outside the journal. Fix: persist retained admissions, or make `projectInTransaction` refuse terminal while a retained admission exists, or allow an `effect` decision with an exactly matching verdict on a terminal run for release purposes only.

**P2-5. Stale-lock recovery by other product paths is outside C5's guarantees.** `retain` stops renewal, so a retained lock ages past its TTL. C5 uses `recover_stale: false`, but if any other acquirer in this repo uses `recover_stale: true` and the daemon has died, it can take the lock while the orphaned command still runs. **Missing context:** I could not search for `recover_stale` callers. If any exist, they need to honor the graph-action owner prefix or a retained marker.

**P2-6. Graceful daemon shutdown always converts in-flight effects to `unknown`.** `close` → `stop` → `cancel` aborts the same signal passed to `runShellCommand`. A healthy implement command mid-flight becomes `unknown` with a retained lock on every restart, requiring manual reconciliation. This is the adjudicated conservative behavior, but it should be stated as a product limit since restart-with-work-in-flight is routine.

**P2-7. Lease expiry values are unbounded on the non-renewal paths.** `claim` and takeover accept any `leaseExpiresAt` up to `MAX_SAFE_INTEGER`; only renewal is bounded to 60s. A far-future lease removes the only time fence on `authorize`. Bound it like `leaseDurationMs`.

**P2-8. Host event-loop stall can produce a false `WORKER_HEARTBEAT_EXPIRED`.** After a stall longer than `heartbeatTimeoutMs`, the interval callback runs in the timers phase before the pending heartbeat frame is read in the poll phase. Synchronous git or SQLite work over 5s on the host would do it. Known class, still present.

**P2-9. `releaseReconciledRepoWriteLock` refuses on PID reuse.** After daemon death, an unrelated process with the recorded PID makes the lock unreleasable until that process exits. Fail-closed, but the lock file has no start-time field to disambiguate. Record process start time alongside PID.

**P2-10. Artifact freeze lock directory is never recovered after a crash.** `mkdir(lock)` fails with EEXIST forever if the host died mid-freeze, so freeze replay for that artifact id fails until manual `rm`. Fail-closed, but worth documenting alongside the bundle-size limit.

## Verified as correct against the adjudication

- No automatic retry: `response` returns `failed`/`unknown` for existing rows, only `retryAuthorized` allocates an attempt, and it re-checks the retry grant inside `check()` after admission.
- No expiry takeover: `commit` takeover requires stopped or not_started proof and refuses unresolved actions and `cancel_pending`.
- No terminal resurrection: `commit` refuses new decisions on terminal runs, replay is read-only, and `projectInTransaction` refuses terminal with unresolved actions and refuses leaving `cancel_pending`.
- Generation consumption: `graph_worker_launches` is inserted before spawn inside BEGIN IMMEDIATE and is immutable.
- Bounded stop honesty: `exit` keeps the timeout result, `finalExit` carries the late OS event, and the runtime exposes it via `observedExit`.
- Cross-generation replay: lost takeover ACK returns immutable history and never stops the replacement worker.

## Missing context, not assessed

- `GraphActionStore.reserve` and `retry` row-selection semantics when a retry attempt exists. The `retryEffectKey` guard reads correctly, but I could not confirm which row `reserve` returns.
- `renewLease` revision behavior, relevant to whether the broker's fence reads can spuriously conflict.
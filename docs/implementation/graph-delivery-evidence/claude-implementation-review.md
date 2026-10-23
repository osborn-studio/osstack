**Verdict: REQUEST_CHANGES.** One P1 liveness defect, two P2 correctness defects, several P3 items, and a short list of missing tests. Items I could not confirm from the supplied source are labeled as such rather than asserted.

## Findings

**P1. Run lease is capped at five minutes with no renewal while the worker executes.**
File `packages/cli/src/graph-delivery.ts`, `leaseDeadline` and `run`. The claim lease is `min(now + 300000, createdAt + deadline + 1s)`. The comment in `run` states there is no heartbeat, and `runtime.start` is called without `leaseDurationMs`, which is the existing G15 live-renewal port. The only renewal is after `handle.stop()`. The broker `fence` shown in the diff denies every ledger access once `run.leaseExpiresAt <= now` with `STALE_GENERATION`. So any epoch whose implement plus review plus tests wall-clock exceeds 300 seconds fails every subsequent action, and the post-stop `renewLease` then runs against an expired lease. The catch block also skips projection when the lease has expired, leaving the run in `running` with a dead owner until G15 recovery. Real adapter runs will routinely exceed this. Integration paths passing with fast fakes would not exercise it.
Fix: pass `leaseDurationMs` into `runtime.start` in `run` so the existing live renewal keeps the pinned owner fresh, or renew inside `dispatch` before each `broker.handle`. Do not raise the cap instead, since that weakens takeover.

**P2. `retry_required` route is projected as terminal `failed`.**
File `graph-delivery.ts`, `run`, non-repair branch. Any route other than `ready` or `reconcile` becomes `failed`. `routeVerification` can still return `retry_required` when the in-dispatch retry loop stopped early: budget check lost a race to the sibling branch, the preparation action did not confirm, or the ledger attempt cap was hit at a different point than `maxBranchAttempts`. The host then writes an immutable terminal `failed` while returning a route that says the run is retryable. Status and route disagree, and the run is unrecoverable by design after terminal projection.
Fix: handle `retry_required` explicitly. Either project `failed` with an explicit reason string recorded in the returned route, or loop back through the dispatch retry path under a fresh fence. Pick one and test it.

**P2. Retry loop throws instead of stopping on retryable pre-admission failures.**
File `graph-delivery.ts`, `dispatch` while loop. Entry condition is `outcome.error.retryable`. Per the broker, pre-invocation policy failures are marked `retrySafe` true, and their `evidenceRef` is not a `graph-verification:` receipt. The loop then calls `loadGraphVerificationEvidence` on that ref, which rejects. The rejection propagates out of `dispatch` into the runtime `track` path rather than returning the failed response. The join service already special-cases this exact shape, so the host has two different behaviors for the same ledger row. The sibling branch is still running; if the runtime treats a dispatch rejection as fatal for the connection, that branch is aborted into cancel or unknown and the run becomes `reconcile` instead of a clean `stop`. I cannot see `track` error handling in the provided source, so the blast radius is unverified, but the throw itself is certain.
Fix: before loading evidence, `break` when `prior.outcome.evidenceRef` does not start with `graph-verification:`.

**P3. `retryAuthorized` installs the replacement before admission succeeds and never rolls back.**
File `graph-action-broker.ts`. The binding map is mutated before `executeRequest`. If admission is denied, the slot now points at a prepared workspace that was never charged to a retry attempt. Same action payload, so no wrong effect executes, but a later successful retry would reuse that workspace without a matching preparation ledger row for that attempt. Fix: set the replacement only after `this.actions.retry` returns.

**P3. Setup failures leak the runtime.**
File `graph-delivery.ts`, `run`. `prepare`, `claim`, `project`, and `activate` run before the `try`, so a throw there skips `finally`: `closed` stays false and `runtime.close()` never runs. Move them inside the `try`.

**P3. Compiler-version string coupling in the epoch permit gate.**
`graph-action-broker.ts` `fence` and `graph-actions.ts` `checkEpoch` hard-code `code-delivery-functional-v4`. Bumping `GRAPH_COMPILER_VERSION` silently disables the permit requirement for new runs. Derive the check from a template marker in `identity` or a table flag written by `activate(0)`.

**P3. `receiptBinding` dereferences a possibly missing lease row.**
`graph_worker_leases` lookup uses `.get` then reads `owner.owner` without a null check. Throws `TypeError` instead of a named error. Unverified whether every generation always has a row.

## Items I could not verify from the provided source

- **Parallel preparation on one writer workspace.** `prepare_review` and `prepare_tests` run concurrently and both take a `write` lease on the same source path through the broker. If `acquire` rejects rather than queues a second writer, one preparation fails with no retry path, since the dispatch retry loop only covers `review` and `tests`. Confirm `acquire` semantics or serialize the two preparations in the worker template.
- **Interrupt surfacing.** If `handle.result` rejects on a Functional interrupt, `workerError` is set and the repair branch is unreachable. You state real repair passed, so treat this as a required regression test, not a bug.
- **`candidate().artifactRefs[0]`** in `verifyQuiescence` and `evidence.candidate?.workspace` in `checkProducer` depend on result and evidence shapes not shown.
- **Migration 32** foreign key on `graph_verification_joins(receipt_ref)` requires that column to be `UNIQUE` or SQLite reports a foreign key mismatch at insert. Not shown.

## Missing tests

1. Worker phase longer than the lease cap with a controllable clock. Must succeed, not `STALE_GENERATION`.
2. Terminal route `retry_required`: assert projected status and returned route agree.
3. Review branch failing pre-admission with `retryable` true and a non-verification evidence ref. Assert clean `stop` and that the sibling tests branch completes.
4. Both branches enter the retry loop concurrently with capacity for one. Assert the loser returns its original failed response, no orphan `intent`, and route is consistent.
5. Repair path: interrupt resumes from the checkpoint, epoch 0 tasks issue no action requests, and a replayed epoch 0 request is denied with `DELIVERY_IDENTITY_MISMATCH`.
6. Old worker request after `activate(next)` is denied by `EPOCH_MISMATCH` at both broker fence and store admit.
7. Setup throw before the loop closes the runtime.

Items excluded on your instruction: join publication on failed branches, generic saver RETURN constraints, and old-host authority ordering during takeover.
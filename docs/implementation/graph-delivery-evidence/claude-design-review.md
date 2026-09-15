Review scope: source only, no tools, no test claims. Findings are ordered by what blocks a real end-to-end run first.

## Blockers that must change in G21

**1. Journal publication is dead on the retry path.**
`GraphVerificationStore.commit` keys the row by run, epoch and candidate, and derives the receipt from a hash of the binding alone. The join service commits whenever the join is complete and nothing is unresolved, without looking at the route. A failed retry-safe branch is a settled outcome, so attempt 1 publishes a bundle with `logicalAttempt: 1`. After the host retry, attempt 2 produces a different bundle under the same key and the same receipt, so the second evaluate throws `JOIN_PUBLICATION_CONFLICT`. The repair feedback for that candidate can never be published.
Fix now: commit only when the route is `ready`, `repair_required`, or a non-retry `stop`. Never publish `retry_required` or `reconcile`. One row per candidate then stays a correct invariant, and the receipt is the feedback reference for the next epoch.

**2. Review and tests cannot be registered at connection creation.**
The compiled action for review and tests carries the candidate revision. The broker rejects any request whose action differs from the registration, and rejects a second `register` on the same connection. The candidate SHA does not exist until freeze completes, so today there is no legal way for the worker's review request to match a registration. The same applies to the two independent repos from `prepareGraphVerification`.
Fix now: an append-only staged registration on the broker.

```ts
// Trusted host only. Append-only; never replaces an existing (epoch,nodeId,slot,attempt).
broker.registerStage(connection, {
  epoch, attempt,            // attempt 1 for worker-dispatched, >1 for retry
  priorJoinReceiptRef?,      // required when epoch > 0
  actions: GraphRegisteredAction[],
});
```
`handle` resolves the worker request to the ledger's current attempt via `reserve`, then requires a stage entry for that exact attempt. `retryAuthorized` requires a stage entry for `prior.logicalAttempt + 1`, which is how a retry gets a fresh isolated workspace without mutating the attempt 1 registration. The worker still never names paths, attempts, or actions.

**3. Epoch fencing is not durable.**
The binding pins one epoch, so epoch 1 is unreachable on the current connection. `GraphActionStore.admit` only checks `epoch < maxEpochs`. Nothing in core stops an epoch 1 reservation without an epoch 0 join. Fix now, in core, inside `admit`: for `epoch > 0`, require a `graph_verification_joins` row for `epoch - 1` on this run, and require the repair action's `feedbackRef` and `candidateRevision` to match that row. This is the durable fence. The broker stage check in item 2 is only the fast path.

**4. Host-driven retry and join happen after the worker connection is already retired.**
The compiled program returns after epoch 0 and throws on any non-confirmed branch. Either way the worker exits, `handle.exit` calls `retire`, and the broker unregisters the connection. `retryAuthorized` then fails with `UNAUTHENTICATED`. A new worker in the same generation is blocked by `graph_worker_launches`.
Fix now: split the generation binding from the worker connection. The host registers the binding under a host-owned key that lives until `stop`, `cancel`, or `close`. Worker exit retires only the worker's key. Route host retries through a `GraphRuntime.retry` wrapper so they land in `pending` and are covered by the stop drain, which they are not today.

**5. The worker program must hand off to a host join checkpoint, not return.**
Keep the G18 rule that a task throws on non-confirmed. The program uses `allSettled` over the two branches, discards the values, and calls one host checkpoint per epoch:
```ts
const decision = await ctx.checkpoint({ kind: 'join', epoch, candidateRevision, artifactDigest });
// decision is host-published: { route, feedbackRef? }. Worker never inspects branch RETURNs.
```
Inside that checkpoint the host evaluates from the ledger, retries via `retryAuthorized` when routed, re-evaluates, publishes, and only then registers the next epoch stage and returns. If route is `ready` or `stop`, the program returns and the host projects. This adds no second node FSM. The route, retries, and publication all stay in existing host code.

**6. Non-confirmed task results must not become durable RETURNs.**
A cached failed RETURN makes replay skip the broker forever, so a host retry that succeeded is invisible to the program. Contract: the checkpoint service persists RETURN only for confirmed results. On replay the program re-issues the action and `reserve` answers with the ledger's latest attempt. Failed stays failed, unknown stays unknown, and neither triggers a resend. The C6 fixture that caches a failed RETURN stays a fixture.

**7. Independent restores are budgeted but not ledgered, and they would double-count branch retries.**
The compiler reserves two lifecycle starts per branch attempt, but `prepareGraphVerification` runs outside the ledger, so `actionStarts` never sees them and the cap never fires. If they are registered as a second slot on the review node, `admit` counts every row with `logical_attempt > 1` per node, so one prepare retry plus one review retry exhausts `maxBranchAttempts = 2` after a single retry. The `spent` helper in the join service has the same skew.
Fix now: register each restore as a `workspace_create` action under its own node id such as `e0.review.prepare`, attempt 1, execution kind `workspace`, with `verifyWorkspace` bound to the restored repo. Branch budget then counts only the branch's own slots.

**8. Costs must come from the compiled plan.**
`slots` and `nextCost` are hand-supplied to the join service. Export a derivation from `spec-compiler` and pass its result. From the current registry the per-epoch minimum to reach the next join is:

| cost | actions | tokens |
|---|---|---|
| review retry | 2 | 16384 |
| tests retry | 2 | 0 |
| repair epoch | 7 | 49152 |

Any new effect such as release or cleanup needs a registry entry, a compiler cost, and a compiler version bump.

**9. Lease renewal versus the async join window.**
`authorize` renews when remaining life drops below half the duration, bumping revision. Evaluate captures a fence before artifact verify and evidence loads, then re-snapshots on the old revision. A renewal mid-evaluate throws `VERIFICATION_SNAPSHOT_CHANGED` and a retry loops. Keep the conflict semantics. Add an explicit `renew()` on the runtime handle that performs the CAS now and returns the fresh fence. Contract: call `renew()`, evaluate immediately with that fence, and require evaluation to finish inside half the lease duration. With the current cap that is 30 seconds. If the host cannot meet that bound, stop and drain the worker first, then evaluate within the original deadline.

**10. Ready projection.**
Nothing projects `ready` today. It must be a fenced transaction that requires the published join receipt for the current epoch, zero unresolved actions, zero pending admissions, and worker exit evidence. It delivers the candidate reference only. No merge, push, or task FSM completion.

## Confirmed holding, no change needed

- Original spec, limits, and `createdAt` are read from the run row in `admit`, `authorize`, and route. They survive takeover.
- Unknown never resends: `reserve` returns the existing row, `retry` rejects unknown, `markRunning` refuses while any unknown exists.
- Worker replay reads only existing effects. Only `retryAuthorized` allocates attempts.
- Budget arithmetic stays BigInt and ledger-derived.

## Defer to G25 and G28

- G25: crash between stage registration and the first ledger row, orphaned restored repos, checkpoint replay when a registered physical workspace is gone, planned generation handover when a worker exits cleanly. Same-UID is not a sandbox and stays out of scope.
- G28: join evaluation time against the half-lease window, repeated Git inventory rechecks per attempt, evidence load latency at the 64 KiB cap.

Minimum ordered change set for G21: items 1, 3, 6 in core and store, items 2, 4, 7, 9 in the broker and runtime, items 5, 8, 10 in the compiler and host assembly.
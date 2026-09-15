**Verdict: REQUEST_CHANGES.** One blocker in the join service, three P2 defects, plus low-severity duplication notes. Findings are from reading the snapshots only. I ran no tools or tests.

## Blocker

**P1. The join service throws permanently on ledger `failed` outcomes the broker legitimately writes.**
File `packages/cli/src/graph-verification-join.ts`, function `evaluate`, the `failed` handling inside the branch loop.

The broker in `executeRequest` writes two failed shapes whose `error` is not a `GraphError`:
- Pre-invocation refusal: `error: { message: "admission refused before invocation" }`, `retrySafe: !signal.aborted`, `evidenceRef: not-started:<uuid>`.
- Stopped invocation without a G19 classification: `error: { message: "trusted stopped invocation failed" }`.

The broker's own `response()` anticipates this with `safeParse` and a fallback. The join service does not. It calls `GraphError.parse(outcome.error)`, which throws a Zod error. Even if the error parsed, the non-verification path throws `UNATTESTED_RETRY` whenever `retrySafe` is true, which is the default for any uncancelled pre-invocation refusal.

Concrete scenario: the review slot's admission is refused because the repository is quarantined by governed execution. The ledger row is `failed`, `retrySafe: true`. Every later `evaluate` for that epoch throws. No route is ever produced, not even `stop`. The run cannot be routed to failure through G20, and the tests evidence for the same epoch is never joined. This is a deterministic liveness failure, not a fail-closed guard.

Minimal fix, keeping the file's stated intent that these failures are not promotable to retry:

```ts
const parsed = GraphError.safeParse(outcome.error);
const error = parsed.success ? parsed.data
  : { schemaVersion: 1 as const, code: 'POLICY_DENIED' as const, message: 'prior invocation failed', retryable: false, nextAction: 'stop' as const };
if (!outcome.evidenceRef.startsWith('graph-verification:')) {
  branches.push({ ...base, state: 'failed', error: { ...error, retryable: false, nextAction: 'stop' } }); continue;
}
```

Apply the same fallback in the verification-evidence `failed` path when `envelope.verificationFailure` is absent, instead of throwing `JOIN_FAILURE_MISMATCH`. Keep the mismatch throw for the case where a classification exists and disagrees. Route then returns `stop('branch_failure')`. Note plainly in the comment that ledger `retrySafe` on pre-invocation failures remains reachable only through `retryAuthorized`, never through a route. Whether the route should honor it is a G21 decision, not part of this fix.

## P2 defects

**P2. Retry intent can be orphaned in `intent` state forever.**
File `packages/cli/src/graph-action-broker.ts`, `retryAuthorized` then `executeRequest`.

`retryAuthorized` allocates attempt N+1 via `actions.retry` and then enters `executeRequest`. In `executeRequest`, `owned` is only assigned after `reserve` succeeds. `check()` and the `this.fence(binding)` argument to `reserve` both run before that and can throw, for example on lease expiry, revocation, or a retired connection. When they throw, `owned` is undefined, so the catch block records nothing. Attempt N+1 stays `intent` under the current generation.

Consequences: the verification snapshot counts it in `unresolvedActions`, so route returns `reconcile` forever. `projectInTransaction` blocks terminal states while an `intent` exists. A second `retryAuthorized` hits `RETRY_NOT_SAFE` because the current attempt is `intent`, not `failed`. Worker replays get an `unknown` response and never execute. Nothing in these files resolves it.

Minimal fix: in `retryAuthorized`, pass `next` into `executeRequest` and assign `owned = next` before `check()` runs, so the existing catch path records `failed` with `retrySafe: !signal.aborted`. `recordOutcome` already permits `intent` to `failed`.

**P2. Route gates `ready` behind budget checks that only matter for new spend, so a fully verified candidate is never published.**
File `packages/graph/src/route.ts`, `routeVerification`, the ordering of `accounting_budget`, `deadline_budget`, and the `ready` return.

Concrete scenario: the review adapter reports actual tokens above its reservation. `recordOutcome` sets `accounting_blocked`, as designed, to stop new actions. Both branches are `confirmed`, verdict `accept`, tests `passed`. Route returns `stop('accounting_budget')` before reaching the `ready` check. In `evaluate`, `ready` is a precondition for `store.commit`, so the join is never published and the verified evidence has no durable receipt. The same happens when `actionStarts` overran or when the deadline elapsed between the last confirmation and evaluation, contradicting the `recordOutcome` comment that started effects must not disappear because their budget ended.

Minimal fix: after the `missing_predecessor` and unresolved/pending checks, evaluate the all-confirmed `accept && passed` case and return `ready` before the deadline, accounting, and capacity gates. Keep those gates for `retry_required` and `repair_required`, which do require new spend. Treating the deadline the same way is a policy call. I recommend it for consistency with core, but flag it as yours.

**P2. `evaluate` cannot complete if a lease renewal lands during its async evidence reads.**
File `packages/cli/src/graph-verification-join.ts`, `evaluate`, the second `store.snapshot` and `store.commit`.

`renewLease` increments `revision`. The second snapshot reuses the caller's fence with the original `expectedRevision`, so `checkGraphRunFence` throws `REVISION_CONFLICT`. Even if it did not, the digest includes `run.revision`, `updatedAt`, and `leaseExpiresAt`, so `VERIFICATION_SNAPSHOT_CHANGED` fires. The evidence reads include artifact verification and evidence loading, which G19 is currently hardening for receipt size. If the host heartbeat period is shorter than that read time, `evaluate` never succeeds. Evaluation must run under a live lease, so renewals are guaranteed to be concurrent, not hypothetical.

Minimal fix: compute the compared digest over a body that excludes `revision`, `updatedAt`, and `leaseExpiresAt` from `run`, keep every other field including generation, owner, status, actions, budget, and admissions. Have the second snapshot and `commit` fence on a freshly read revision, which `commit` already derives from `snapshot.run`, so pass `current` rather than the stale `snapshot` into `commit`. Alternatively document that the host must pause renewal during `evaluate`, which is fragile.

## Low severity and simplification

- **Unreachable and duplicated epoch caps.** `route.ts` hardcodes `epoch >= 2`, `graph-actions.ts` has `count.max(2)`, and `spec-compiler.ts` has `maxEpochs > 3`. Three places encode one constant. Export it once from protocol.
- **`validateGraphPlan` per-node loop is subsumed.** The final canonical equality against `fixedPlan` rejects everything the loop rejects. Keep it only if you want it as a self-test of the template; otherwise drop it to halve the function.
- **Binding re-validation hack in core.** `GraphVerificationStore.commit` parses a synthetic `candidate_ready` result with `artifactRefs: ['join-validation']` to validate binding fields, because core cannot import `@osstack/graph`. This works but is misleading. Moving `VerificationBinding` to protocol removes the hack and the duplicated field checks.
- **Dead `cancelled` branch path.** The ledger has no `cancelled` action state, so `stop('cancelled_branch')` in `routeVerification` cannot fire from `evaluate`. Harmless, but remove or comment it.
- **Silent misconfiguration.** If a `slots` node id does not match the compiled plan id for `binding.epoch`, `latest` returns nothing and route returns `stop('missing_predecessor')` rather than an error. A one-line check that `slots[kind].nodeId` equals the expected `e{epoch}.{kind}` id would turn a config bug into a loud failure.
- **Unchecked prefix slice.** In the `confirmed` path, `evidenceDigest` is sliced from `evidenceRef` without checking the `graph-verification:` prefix. `loadGraphVerificationEvidence` probably rejects other refs, but the slice should guard explicitly.

## Confirmed correct, no change requested

- Attempt and branch accounting between `evaluate`, `joinVerificationBranches`, and core `admit` agree. `spent` is `1 + retries` per node, matching `BRANCH_BUDGET_EXHAUSTED`. Capacity math matches `ACTION_BUDGET_EXHAUSTED` and `TOKEN_BUDGET_EXHAUSTED` boundaries.
- Publication is immutable in practice. A complete join requires all branches confirmed, and `retry` requires the current attempt to be `failed`, so the bundle for an epoch cannot legitimately change after commit. `JOIN_PUBLICATION_CONFLICT` is a true integrity check.
- The attest-then-commit sequence has no await between the second snapshot, `attested` assignment, and `commit`, and the store rechecks digest, canonical equality, unresolved actions, and pending admissions inside the fenced transaction. Concurrent `evaluate` calls cannot double-publish.
- Confirmed results are recomputed from the evidence envelope and compared to the ledger result, so a persisted `passed: true` or `accept` cannot pass without matching envelope content. This assumes `loadGraphVerificationEvidence` verifies envelope content against the digest in the ref and binds `acceptance` to `binding.acceptanceRef`. Both live in G19 and are out of this review's scope.
- `retryAuthorized` cannot be claimed by an ordinary worker replay. A replay for the slot sees the new intent with `created: false` and a non-matching `retryEffectKey`, and receives an `unknown` response without invoking.

## Deferred to G21, not blockers here

- Host-side registration of restore and workspace lifecycle starts that the compiler pre-reserves via `2 * maxEpochs * maxBranchAttempts`.
- Whether routes should ever honor ledger `retrySafe` on pre-invocation failures.
- Mapping `intent` or `running` of the current generation to a `reconcile` route. After a proper drain this state should not exist, but the honest recommendation would be "wait", and G21's driver should decide.

## Same-UID limitation

Nothing in these files mitigates or worsens it. Review and test workspaces run under one UID, so the trust boundary between them remains process discipline rather than OS isolation. That is a documented limitation, not a C6 defect.
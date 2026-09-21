Reading is complete. I've traced the recovery entry point, the journal, the reconciler, the recovery store, the receipt loader, the worker-exit proof, and the repo-lock release. Writing up the verdict now.

## Verdict: changes_requested (one low-severity pin; everything else in scope holds)

**Required change: pin the delivery program version in recovery.**
`packages/cli/src/graph-bounded-recovery.ts:62-63` hardcodes the verdict result for template version 4 (`workspaceLeaseRef: 'e0.writer'`, `receiptRef: 'e0.implementation'`, matching `graph-delivery.ts:228`). The publish gate at `graph-bounded-recovery-journal.ts:78-81` keys only on generation 1, epoch 0, node `e0.implement`, kind `implement`. Neither side checks the run's program identity. A later template that keeps those node names but changes the persisted result would still be journaled and then settled with the v4 verdict. `validateWorkerActionResponse` at `graph-recovery.ts:345` pins kind and `workspaceLeaseRef` against the action but not `receiptRef`, so a wrong `receiptRef` would be durably confirmed on the ledger. This is the "unexpected enabling on later graphs" hole. Minimal fix, after the scope check at line 28:

```ts
import { compileGraphSpec } from '@osstack/graph/spec-compiler';
import { graphDeliveryVersion } from './graph-delivery.js';
// ...
const version = graphDeliveryVersion(compileGraphSpec(initial.snapshot.run.spec!));
if (Object.entries(version).some(([k, v]) => (initial.snapshot.run.identity as Record<string, unknown>)[k] !== v)) throw Error('BOUNDED_RECOVERY_SCOPE');
```

Run identity already carries every field of `graphDeliveryVersion` (`graph-runs.ts:15-16,127`), so this binds recovery to the exact program the hardcoded verdict was written for. Bumping the template then fails closed until recovery is updated.

**Checked and holding**

- **Authority revocation during final transaction.** The store's verifier callback runs inside `BEGIN IMMEDIATE` (`graph-recovery.ts:232,290`) and calls `GraphReconciler.check` → `registration.authorize` → your `check()` → the RPC callback that sets `authorizationFailed` and rethrows (`graph-rpc.ts:188-189`). The transaction rolls back, and `graph-rpc.ts:191` rethrows instead of swallowing. A non-undefined return from `authorize` throws `BOUNDED_RECOVERY_AUTHORITY` without the flag, which is swallowed but still fails closed with no decision. Correct.
- **Host-dead proof.** `dead()` uses the pid the host itself recorded (`journal.ts:87` requires `lockOwner.pid === process.pid`). ESRCH is required. EPERM and reuse both fail closed. It is rechecked inside the final transaction via `recheck()` and again by `releaseReconciledRepoWriteLock` (`repo-lock.ts:369,373`). A same-pid in-process restart is rejected as HOST_ALIVE. The only known blind spot is separate PID namespaces sharing a volume, which the existing lock code already shares. No lease expiry is consulted anywhere. Matches your stated requirement.
- **Source and effect identity.** Predecessor receipt is bound to the current registration's `repositoryPath`, writer receipt to `writer-0`. Both re-verify `effect`, `effectKey`, generation, owner (`graph-delivery-receipts.ts:87-89`). `journal.workspacePath` is forced to `join(root,'writer-0')`, `commonDir` to its `.git`, and `resolveRepositoryScope` confirms both plus `repoId` (`recovery.ts:40-45`). The lock owner's `autonomy_run_id` is bound to `graph-action:<effectKey>`, matching `graph-action-broker.ts:331`. `candidate.workspace` and predecessor `baseRevision` are checked against the spec.
- **Fingerprint exclusion.** Only `.git/osstack/writer-locks` is skipped. The lock file, its renewals, and the mutation guard directory (`repo-lock.ts:162`) all live there, so lease renewal and the release itself cannot invalidate the fingerprint. `nlink === 1` is safe because the clone uses `--no-hardlinks`. `sameOwner` ignores `expires_at` (`repo-lock.ts:201-207`), so a renewed lock still matches the journaled owner.
- **Missing-lock lost ACK.** Verdict is durable before release. A replacement owner makes `sameOwner` fail, giving `release_pending` without unlinking (`recovery.ts:94`). A missing lock is acknowledged only after the producer is already proven stopped and the host dead. `GraphAdmissionStore.released` is idempotent (`graph-recovery.ts:84`), so a replayed `completeRelease` is harmless. The test at `graph-bounded-recovery.test.ts:77-89` exercises exactly this.
- **Concurrent reconcile.** Each call builds its own `GraphReconciler`, so `NESTED_RECOVERY` is per instance. Two concurrent commits with the same `bounded-effect:<key>` receipt serialize under `BEGIN IMMEDIATE`; the loser hits `DECISION_CONFLICT` or `PROOF_SNAPSHOT_MISMATCH` and is swallowed at `graph-rpc.ts:191`. Release is serialized by the on-disk mutation guard, which also works cross-host. `assertExecutorInventory` in the final transaction (`recovery.ts:88`) catches any admission change between snapshot and commit.
- **Corrupt or missing receipts and journal.** Every loader hashes bytes and enforces size and `O_NOFOLLOW`. Failures throw before any decision and are swallowed into a plain `cancel_pending` status. The journal is re-loaded and canonically compared in `recheck()`, and both receipts are re-hashed synchronously inside the final transaction (`recovery.ts:68-71`).
- **Usage.** Recovery sums `tokens_in + tokens_out`, matching the broker's `measured` (`graph-action-broker.ts:366`). `settle` takes `max(observedTokens, actualTokens)` and `markUncertain` already raised `observedTokens` to at least the reservation, so the charge can never fall below the live path's floor. Missing or unsafe usage fails closed rather than normalizing to null.
- **Stale idempotency semantics.** After a partial (effect committed, project failed) the revision advanced, so `graph-rpc.ts:162` no longer treats the same key as a replay and returns status. A fresh key retries release. This matches what you said is intended.

**Optional hardening, not blocking**

- `graph-bounded-recovery-journal.ts:96`: `linkSync` throws `EEXIST` if the target already exists. `publishDeliveryReceipt` handles that by digest comparison; the journal does not. Not reachable in this scope since `persist` runs once per invocation, but a byte-compare-on-EEXIST would make the two paths consistent.
- `recovery.ts:69`: `boundedWorkspaceFingerprint` walks up to 32 MiB synchronously inside the store's `BEGIN IMMEDIATE`. That holds the control DB's write lock for the walk. Correct, but worth noting for shared-database deployments.

**Test coverage gaps against the claims above, for when your run finishes**

- No test revokes authority mid-flight (e.g. flip `allow` from inside a `GraphRecoveryStore.prototype.commit` spy) to exercise the rollback at `graph-recovery.ts:232` rather than the pre-check.
- No test for a replacement lock owner present on the very first reconcile, as opposed to after a lost ACK. The code path is the same `sameOwner` branch, so this is low risk.

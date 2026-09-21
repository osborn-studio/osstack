# G15 storage/reconciler handoff — implementation ready for parent integration

G15 task status has NOT been changed. Parent owns concrete G14 assembly and G17/C5 acceptance, documentation, commits and integration. No nested actors/Loops, commits, pushes, merges or deployment were performed.

## Owned source changes

Only these four NEW source/test files were authored by G15:
- packages/core/src/state/graph-recovery.ts (230 lines)
- packages/core/src/state/graph-recovery.test.ts (201 lines; 20 tests)
- packages/cli/src/graph-reconciler.ts (144 lines)
- packages/cli/src/graph-reconciler.test.ts (134 lines; 20 tests)

G15 did not modify live GraphActionStore/GraphRunStore, migrations, package exports, daemon, broker, governed-execution, autonomy, AGENTS, task statuses or user docs. Other shared-tree changes belong to parent/G14/G16. Build outputs are generated/ignored.

## Interface and parent wiring

See G15-interface.md for the migration28 SQL supplied before implementation and final exact interface. Parent applied the SQL and added the supported @osstack/core/graph-recovery subpath (no eager core root runtime export).

GraphRecoveryStore(db, verifyProof) is a separate trusted admin port. verifyProof(snapshot,proof,decision) is synchronous, receives the exact normalized decision/result/receipt, must independently authenticate all evidence, and MUST return undefined. Promise/boolean/string grants fail closed; rejected Promises are observed. Never expose this store to worker JSON or use a permissive verifier in production.

GraphReconciler(db, now) owns a private store and only grants its synchronous attestation for the precise trusted callback result. Register connection + immutable full scope/run/program/current-generation/owner binding and callbacks: authorize; actual stopWorker; independent verifyWorker; independent verifyQuiescence (all executors plus exported/quarantined workspace); verifyOutcome; synchronous recheck(snapshot,proof,decision); idempotent release(result,reverify). Parent maps G14 manager stop/exit and G16 physical retention evidence to these callbacks. The raw stop result, worker receiptRef/checkpoint/resume payload, and boolean/string claims never supply authority.

Call reconcile with effect/receipt/fence, project status/receipt/fence, or takeover owner/expiry/receipt/fence. Outcomes are applied, not_applied, unknown, projected, takeover, release_pending. There is no public CLI, scheduler, worker invocation, or automatic retry. A failed safe action may be explicitly retried through the existing store/parent broker handoff only; normal created-owner behavior remains intact.

## Storage semantics and invariants

- BEGIN IMMEDIATE wraps full scope/program/current-generation/owner/revision/time, proof, action settlement, immutable journal decision, and run revision. Expired lease recovery is distinct from live fencing. Terminal cancelled is sealed; cancel_pending blocks recovery resume/takeover; terminal cancellation refuses ANY independent unresolved action.
- Snapshot digest includes entire run/fence and full action: original immutable effect generation/identity/key, executionRef, observed state/usage/updatedAt, program and current owner/revision. No async revision refresh can overwrite a concurrent change.
- Older action generation settlement requires both exact current supervisor evidence and an exact original-generation effectWorker receipt matching graph_worker_leases. Generation/identity on the action is never rewritten.
- Preworker cancellation uses explicit preworker evidence. New-generation takeover requires settled independent actions plus exact current stop/external quiescence evidence. Original exit timestamp remains original; proof verifiedAt is the fresh attestation time, not a fabricated exit.
- Applied validates exact GraphResult kind/workspace/candidate identity using protocol validation; action actual_tokens charges max(previous observed, trusted actual). Bad numeric usage becomes null and retains reservation/accounting block without erasing real results. Existing accounting block/maxima never reset.
- not_applied persists failed; retrySafe only when no run/action cancellation and known, unblocked accounting. Failed reservation remains charged. Unknown retains reserved usage/block and never releases or resends.
- Deterministic graph-recovery:<effectKey> interrupt stays stable. Each immutable receipt stores snapshot/proof/decision. A new receipt can resolve unknown; prior uncertainty/history remains. Existing terminal action evidence cannot be replaced, even under a new receipt.
- Direct core commit replay requires the same original snapshot/proof/decision; changed proof/outcome conflicts. CLI replay freshly authenticates a durable decision through verifyDecision and retries release without rewriting that original journal. Unknown replay remains retained. A changed outcome requires a new receiptId.
- Decision COMMIT precedes retained-admission release. Release revalidation uses a fresh explicit snapshot and all physical/authority checks; failure returns release_pending with the durable result. Caller re-reads a fresh fence and retries the same receipt. No release-success state is fabricated or inferred.

## Actual validation and raw logs

Every CLI/DB test/build invocation used:
OSSTACK_HOME=/Volumes/AIMATE_WORK/tmp/gc5/home TMPDIR=/Volumes/AIMATE_WORK/tmp/gc5

Final commands, all exit 0:
1. pnpm --filter @osstack/core exec vitest run src/state/graph-recovery.test.ts src/state/graph-actions.test.ts src/state/graph-runs.test.ts
   G15-core-final.log — 3 files / 85 tests passed (20 G15 + 31 action + 34 run).
2. pnpm --filter @osstack/cli exec vitest run src/graph-reconciler.test.ts src/graph-action-broker-boundary.test.ts
   G15-cli-regression-final.log — 2 files / 33 tests passed (20 G15 + 13 broker boundary).
3. pnpm --filter @osstack/core build — G15-core-build-final.log.
4. pnpm --filter @osstack/cli build — G15-cli-build-final.log (build success).
5. pnpm --filter @osstack/core typecheck — G15-core-typecheck-final.log.
6. pnpm --filter @osstack/cli typecheck — G15-cli-typecheck-final.log.
7. git diff --check — exit 0 on shared tracked changes.

TDD red evidence is preserved, not overwritten:
- G15-core-red.log: new recovery module absent (initial test command also ran existing core tests).
- G15-cli-red.log: new reconciler module absent.
- G15-cli-bad-usage-red.log: same invalid usage receipt replay incorrectly conflicted; fixed normalization, final green.
- G15-core-replay-time-red.log: durable replay incorrectly accepted time before current run update; fixed current-time check, final green.
- G15-core-decision-binding-red.log: verifier could not inspect exact decision; added decision argument, final green.
Intermediate green/failure logs also retained for traceability.

Tests use real file-backed SQLite with close/reopen, immutable SQL triggers and injected revision-trigger rollback. They cover forged/mismatched proofs, scope/program/current and original generation, action digest drift, expired leases, all three outcomes, observed maxima/bad usage, cancellation/preworker projection, explicit-only retry, takeover, stable interrupt/history, synchronous invalid grants, revocation at every await, concurrent ledger update, and durable release failure/replay. CLI fixture external effects.log is written once before recovery and asserted unchanged after close/reopen/lost-release replay. This is a fake trusted executor unit fixture, NOT a real G14 worker/daemon acceptance claim.

No Unix-socket acceptance tests were attempted by G15 and no EPERM result is claimed. Parent must run actual supervisor→worker→broker/effect/checkpoint/restart G17 acceptance, wire real quarantine/release callbacks, and review cancellation behavior on ordinary host projection APIs. This handoff does not mark G15 or C5 completed.

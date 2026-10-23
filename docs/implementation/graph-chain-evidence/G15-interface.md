# G15 storage/reconciler interface — parent action requested now

Please apply migration 28 and core exports below. G15 owns only graph-recovery.ts/tests and graph-reconciler.ts/tests. No live GraphActionStore fencing changes planned.

```sql
CREATE TABLE graph_recovery_decisions (
  graph_run_id TEXT NOT NULL REFERENCES graph_runs(graph_run_id),
  receipt_id TEXT NOT NULL,
  effect_key TEXT REFERENCES graph_actions(effect_key),
  interrupt_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  committed_at INTEGER NOT NULL CHECK(committed_at >= 0 AND committed_at <= 9007199254740991),
  PRIMARY KEY(graph_run_id, receipt_id)
);
CREATE TRIGGER graph_recovery_decisions_no_update BEFORE UPDATE ON graph_recovery_decisions
BEGIN SELECT RAISE(ABORT, 'graph recovery decision immutable'); END;
CREATE TRIGGER graph_recovery_decisions_no_delete BEFORE DELETE ON graph_recovery_decisions
BEGIN SELECT RAISE(ABORT, 'graph recovery decision immutable'); END;
```

Core exports (new file will exist shortly): GraphRecoveryStore, graphRecoveryInterruptId; types GraphRecoverySnapshot, GraphRecoveryProof, GraphRecoveryVerdict, GraphRecoveryDecision, GraphRecoveryRecord, GraphRecoveryResult, GraphRecoveryVerifier.

API sketch (final exact types will be updated here): constructor(db, verifyProof: synchronous trusted callback returning **undefined**). snapshot(fence,effectKey?) permits expired lease read, never stale generation/owner/revision/program or terminal mutation. Proof binds full snapshot digest (run identity/scope/current generation/owner/revision plus entire action including original generation/state/updatedAt), verifiedAt, exact current worker stop receipt (or explicit generation-zero preworker evidence), independent executor evidence and workspace export/quarantine evidence. commit(snapshot, {receiptId, verdict}, proof, now) atomically persists immutable journal plus action settlement/run revision; verdict is applied/not_applied/unknown with exact GraphResult/evidence/usage; projection and takeover also use explicit trusted journalled admin operations. Core calls supplied proof verifier synchronously inside BEGIN IMMEDIATE and rejects non-undefined/Promise returns. No normal live fence relaxation.

CLI will consume trusted registrations/callbacks; snapshot all inputs before awaits, actually stop supervisor, independently verify stop + executor/workspace evidence, verify exact outcome, synchronously recheck authorization after all awaits, commit durable decision then release retained admission. Receipt replay requires reverified fresh proof before idempotent release; original journal proof and decision are never rewritten. No automatic retry/invoke or public CLI. Parent owns G14 concrete adapter and release callbacks, full G17 acceptance.

## Concrete API update (implementation now present)
Core `GraphRecoveryStore(db, verifyProof)` exports above now present. `snapshot(fence,effectKey?)`, `history(fence,effectKey?)`, `commit(snapshot,decision,proof,now)`, `verifyRelease(snapshot,receiptId,proof,now)`. Decision union: `{kind:'effect',receiptId,verdict:{outcome:'applied',evidenceRef,actualTokens,result}|{outcome:'not_applied',evidenceRef,actualTokens,error}|{outcome:'unknown',evidenceRef,observedTokens}}`; `{kind:'project',receiptId,status:'cancel_pending'|'cancelled'|'waiting_input'|'running'}`; `{kind:'takeover',receiptId,owner,leaseExpiresAt}`. Verdict usages allow null (blocked accounting); invalid numeric usage normalizes null. Takeover requires zero unresolved actions and exact stop/quiescence proof. Terminal seals unchanged; preworker evidence is explicit.

Proof `{snapshotDigest,verifiedAt,worker:{kind:'stopped',graphRunId,generation,owner,confirmedAt,evidenceRef}|{kind:'preworker',evidenceRef},executorEvidenceRef,workspaceEvidenceRef,effectWorker?}`. Original older action generation additionally requires exact historical `effectWorker` stopped receipt. Verify callback receives detached snapshots/proofs; authenticate contents, not object identity. Do not pass permissive callback from host. CLI will own store with private in-flight proof equality plus synchronous trusted registration recheck.

CLI planned concrete constructor `new GraphReconciler(db, now?)`; `register(connection, registration)` then `reconcile(connection,request)`. Registration binds `scope,graphRunId,identity,generation,owner` and callbacks `authorize(snapshot):undefined`, `stopWorker(snapshot):Promise<unknown>` (actual supervisor or explicit preworker controller), `verifyWorker(snapshot,stopResult):Promise<GraphRecoveryProof['worker']>`, `verifyQuiescence(snapshot,worker):Promise<{executorEvidenceRef,workspaceEvidenceRef,effectWorker?}>`, `verifyOutcome(snapshot):Promise<GraphRecoveryVerdict>`, `recheck(snapshot,proof):undefined`, `release(result,reverify:()=>Promise<void>):Promise<undefined>`. Request `{fence,receiptId,kind:'effect',effectKey}` or project/takeover matching decision fields. All callbacks detached snapshot inputs; synchronous authority return must be undefined. Worker refs are never used as proof; verifier output only. No direct G14 imports: parent registers actual manager stop/exit verifier closure per G14 API once ready.

## Final integration notes
- Parent's supported import is `@osstack/core/graph-recovery`; **no eager core root runtime export**. CLI imports that subpath.
- `GraphRecoveryVerifier(snapshot, proof, decision)` now receives the **exact normalized decision/result/receipt** as its third argument, so a standalone host verifier can authenticate settlement as well as physical evidence. `GraphReconcilerRegistration.recheck(snapshot,proof,decision)` receives the same third argument. Existing two-argument callbacks remain TypeScript-compatible, but must still verify all physical facts independently.
- Core additionally has `verifyDecision(snapshot,receiptId,proof,now)` for fresh authentication of a durable replay; `verifyRelease(...)` rejects unknown decisions. These never rewrite the original proof/history. Core `commit` same-key replay requires original exact snapshot/proof/decision; changed proof/outcome conflicts. CLI same-key processing only authenticates the stored decision and retries release with fresh proof, never re-commits it.
- CLI returns `{exit:'applied'|'not_applied'|'unknown'|'projected'|'takeover'|'release_pending',result,releaseError?}`. `release_pending` contains the already-committed original decision. Retry with a fresh caller fence after re-reading the run; keep receiptId and original decision/effect. Unknown is never released or retried automatically. New evidence resolving unknown uses a **new receiptId**, same deterministic interruptId/effectKey.
- All authority-only callbacks reject any non-undefined value, including Promise, while observing rejected Promises. Exact verifier results are parsed; boolean worker/quiescence/outcome claims fail closed.
- Core and CLI new files are ready for parent concrete G14 assembly; this actor does not edit daemon, migrations, broker, task states, or G17 acceptance. No public CLI or retry executor added.

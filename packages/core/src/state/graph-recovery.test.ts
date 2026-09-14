import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { StartGraphRequest } from "@osstack/protocol";
import { openDb } from "./db.js";
import { GraphRunStore, type GraphRun, type GraphProgramVersion } from "./graph-runs.js";
import { GraphActionStore } from "./graph-actions.js";
import { GraphRecoveryStore, type GraphRecoverySnapshot, type GraphRecoveryProof, type GraphRecoveryDecision } from "./graph-recovery.js";

const scope = { schemaVersion: 1 as const, tenantId: "t", principalId: "p", workspaceId: "w" };
const request: StartGraphRequest = { schemaVersion: 1, kind: "start", scope, idempotencyKey: "start", inputArtifactRef: "input",
  source: { product: "osstack", requestId: "r", parentRunId: "p" }, spec: { schemaVersion: 1, template: "code-delivery-v1", publication: "artifact_only",
    input: { taskRef: "t", repositoryRef: "repo", baseRevision: "a".repeat(40), acceptanceRef: "a" },
    limits: { maxEpochs: 2, maxBranchAttempts: 2, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1,
      maxActionStarts: 10, deadlineSeconds: 60, tokenReservationLimit: 100 } } };
const program: GraphProgramVersion = { executionModel: "langgraph-functional-v1", durability: "sync", engineVersion: "1", checkpointVersion: "1",
  templateVersion: "1", registryVersion: "1", compilerVersion: "1", schemaVersion: "1", compiledProgramDigest: "b".repeat(64) };
const admission = { epoch: 0, nodeId: "node", effectSlot: "slot", reservationTokens: 40,
  action: { kind: "workspace_create" as const, repositoryRef: "repo", baseRevision: "a".repeat(40) } };
const applied: GraphRecoveryDecision = { kind: "effect", receiptId: "receipt", verdict: { outcome: "applied", evidenceRef: "external",
  actualTokens: 20, result: { schemaVersion: 1, kind: "workspace", workspaceLeaseRef: "lease", receiptRef: "result" } } };
let dir: string; let db: Database.Database; let runs: GraphRunStore; let actions: GraphActionStore; let recovery: GraphRecoveryStore; let run: GraphRun; let key: string;
const trusted = new Set<string>();
function proofKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(proofKey).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${proofKey(record[key])}`).join(",")}}`;
}
const fence = (now = 120) => ({ scope, graphRunId: run.graphRunId, identity: run.identity, expectedGeneration: run.generation,
  expectedOwner: run.leaseOwner, expectedRevision: run.revision, now });
function stores() { runs = new GraphRunStore(db); actions = new GraphActionStore(db); recovery = new GraphRecoveryStore(db, (_s, p) => { if (!trusted.has(proofKey(p))) throw new Error("FORGED_PROOF"); }); }
function proof(s: GraphRecoverySnapshot, now = 130): GraphRecoveryProof {
  const p: GraphRecoveryProof = { snapshotDigest: s.digest, verifiedAt: now, worker: s.run.generation === 0
    ? { kind: "preworker", evidenceRef: "never-spawned" }
    : { kind: "stopped", graphRunId: run.graphRunId, generation: run.generation, owner: run.leaseOwner!, confirmedAt: now, evidenceRef: "supervisor" },
    executorEvidenceRef: "all-stopped", workspaceEvidenceRef: "exported" };
  trusted.add(proofKey(p)); return p;
}
function snapshot(now = 120) { return recovery.snapshot(fence(now), key); }
function commit(d = applied, now = 130) { const s = snapshot(now); const result = recovery.commit(s, d, proof(s, now), now); run = result.run; return result; }
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "g15-")); db = openDb({ path: join(dir, "state.db") }); stores(); trusted.clear();
  run = runs.create(request, program, 100); run = runs.acquireLease({ ...fence(110), owner: "worker", leaseExpiresAt: 200 });
  const reserved = actions.reserve(fence(), admission); run = reserved.run; key = reserved.action.effectKey;
});
afterEach(() => { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("trusted graph recovery", () => {
  it("settles original effect after expiry, persists restart replay and rejects changed proof/outcome", () => {
    const s = snapshot(201); const p = proof(s, 210); const done = recovery.commit(s, applied, p, 210); run = done.run;
    expect(done.action).toMatchObject({ state: "confirmed", generation: 1, actualTokens: 20 });
    db.close(); db = openDb({ path: join(dir, "state.db") }); stores();
    expect(recovery.commit(s, applied, p, 211).record).toEqual(done.record);
    expect(() => recovery.commit(s, { ...applied, receiptId: "receipt", verdict: { outcome: "unknown", evidenceRef: "changed", observedTokens: 0 } }, p, 211)).toThrow(/DECISION_CONFLICT/);
    expect(() => recovery.commit(s, applied, { ...p, executorEvidenceRef: "changed" }, 211)).toThrow();
    expect(() => actions.markRunning(fence(211), key, "resend")).toThrow(/LEASE_EXPIRED/);
    expect(() => db.exec("DELETE FROM graph_recovery_decisions")).toThrow(/immutable/);
  });
  it("retains observed maxima, charges settled maxima, preserves unknown evidence history", () => {
    const unknown = commit({ kind: "effect", receiptId: "unknown", verdict: { outcome: "unknown", evidenceRef: "lost", observedTokens: 70 } });
    expect(unknown.action).toMatchObject({ state: "unknown", observedTokens: 70, actualTokens: null });
    expect(() => actions.reserve(fence(130), { ...admission, nodeId: "other" })).toThrow(/UNRESOLVED_ACTION|RUN_STOPPING/);
    const done = commit(applied, 140);
    expect(done.action).toMatchObject({ actualTokens: 70, observedTokens: 70, accountingBlocked: true });
    expect(recovery.history(fence(140), key)).toHaveLength(2);
    expect(actions.get(fence(140), key).budget.chargedTokens).toBe("70");
    expect(done.action?.uncertainty?.evidenceRef).toBe("lost");
  });
  it("rejects forged/stale snapshots and rolls back journal, outcome and revision on failure", () => {
    const s = snapshot(); const p = proof(s);
    expect(() => recovery.commit(s, applied, { ...p, workspaceEvidenceRef: "forged" }, 130)).toThrow();
    run = actions.markRunning(fence(), key, "execution").run;
    expect(() => recovery.commit(s, applied, p, 130)).toThrow(/REVISION_CONFLICT/);
    const current = snapshot(); const verified = proof(current);
    db.exec("CREATE TRIGGER fail_revision BEFORE UPDATE OF revision ON graph_runs BEGIN SELECT RAISE(ABORT, 'injected'); END");
    expect(() => recovery.commit(current, applied, verified, 130)).toThrow(/injected/);
    expect(db.prepare("SELECT count(*) AS n FROM graph_recovery_decisions").get()).toEqual({ n: 0 });
    expect(actions.get(fence(), key).action.state).toBe("running");
  });
  it("requires exact scope, program, owner, generation, action generation and action digest", () => {
    const s = snapshot(); const p = proof(s);
    for (const patch of [{ scope: { ...scope, principalId: "other" } }, { identity: { ...run.identity, compilerVersion: "other" } },
      { expectedOwner: "other" }, { expectedGeneration: 0 }]) expect(() => recovery.snapshot({ ...fence(), ...patch }, key)).toThrow();
    expect(() => recovery.commit({ ...s, action: { ...s.action!, generation: 9 } }, applied, p, 130)).toThrow();
    expect(() => recovery.commit({ ...s, action: { ...s.action!, updatedAt: 121 } }, applied, p, 130)).toThrow();
  });
  it("not_applied only enables later explicit retry, pending cancellation forbids retry/resume", () => {
    run = runs.project({ ...fence(), status: "cancel_pending" });
    const done = commit({ kind: "effect", receiptId: "absent", verdict: { outcome: "not_applied", evidenceRef: "absent", actualTokens: 0, error: null } });
    expect(done.action).toMatchObject({ state: "failed", retrySafe: false });
    expect(() => actions.retry(fence(130), key)).toThrow(/RETRY_NOT_SAFE/);
    const s = recovery.snapshot(fence(130));
    expect(() => recovery.commit(s, { kind: "project", receiptId: "resume", status: "running" }, proof(s), 130)).toThrow(/CANCEL/);
  });
  it("projects preworker cancellation and seals terminal runs; refuses cancellation with independent unresolved action", () => {
    const s = recovery.snapshot(fence());
    expect(() => recovery.commit(s, { kind: "project", receiptId: "cancel", status: "cancelled" }, proof(s), 130)).toThrow(/UNRESOLVED_ACTION/);
    run = runs.create({ ...request, idempotencyKey: "pre" }, program, 100);
    const pre = recovery.snapshot(fence()); const done = recovery.commit(pre, { kind: "project", receiptId: "cancel", status: "cancelled" }, proof(pre), 130); run = done.run;
    expect(run.status).toBe("cancelled");
    const terminal = recovery.snapshot(fence(130));
    expect(() => recovery.commit(terminal, { kind: "project", receiptId: "resume", status: "running" }, proof(terminal), 130)).toThrow(/TERMINAL_RUN/);
  });
  it.each([-1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])("keeps confirmed result and capacity blocked for bad usage %s", (actualTokens) => {
    const done = commit({ ...applied, verdict: { ...(applied as Extract<GraphRecoveryDecision, { kind: "effect" }>).verdict, actualTokens } } as GraphRecoveryDecision);
    expect(done.action).toMatchObject({ state: "confirmed", actualTokens: null, accountingBlocked: true });
    expect(actions.get(fence(130), key).budget.reservedTokens).toBe("40");
  });
  it("settles an older effect only with current admin fencing and the exact original worker receipt", () => {
    const original = run; const oldFence = fence();
    run = runs.acquireLease({ ...fence(210), owner: "next", leaseExpiresAt: 500,
      stoppedWorker: { graphRunId: run.graphRunId, generation: 1, owner: "worker", confirmedAt: 210, evidenceRef: "old-exit" } });
    expect(() => recovery.snapshot({ ...oldFence, now: 211 }, key)).toThrow(/STALE_GENERATION/);
    expect(() => actions.recordOutcome(fence(211), key, { state: "failed", evidenceRef: "claim", actualTokens: 0, error: null, retrySafe: true })).toThrow(/ACTION_GENERATION_MISMATCH/);
    const s = snapshot(211); const p = proof(s, 220);
    expect(() => recovery.commit(s, applied, p, 220)).toThrow(/EFFECT_WORKER_PROOF_MISMATCH/);
    p.effectWorker = { kind: "stopped", graphRunId: run.graphRunId, generation: original.generation, owner: "worker", confirmedAt: 210, evidenceRef: "old-exit" };
    trusted.add(proofKey(p));
    const done = recovery.commit(s, applied, p, 220);
    expect(done.action).toMatchObject({ generation: 1, effectKey: key, state: "confirmed" });
    expect(done.run).toMatchObject({ generation: 2, leaseOwner: "next" });
  });
  it("retains confirmed evidence and rejects contradictory trusted outcomes even with a new receipt", () => {
    run = actions.markRunning(fence(), key, "executor").run;
    if (applied.kind !== "effect" || applied.verdict.outcome !== "applied") throw new Error("fixture");
    run = actions.recordOutcome(fence(), key, { state: "confirmed", evidenceRef: applied.verdict.evidenceRef,
      actualTokens: 20, result: applied.verdict.result }).run;
    const original = actions.get(fence(), key).action;
    expect(commit().action).toEqual(original);
    expect(() => commit({ kind: "effect", receiptId: "different", verdict: { outcome: "not_applied", evidenceRef: "no", actualTokens: 0, error: null } }, 140)).toThrow(/OUTCOME_CONFLICT/);
  });
  it("does not allocate or invoke safe retries and keeps failed reservation charged", () => {
    const done = commit({ kind: "effect", receiptId: "absent", verdict: { outcome: "not_applied", evidenceRef: "absent", actualTokens: 0, error: null } });
    expect(done.action?.retrySafe).toBe(true);
    expect(actions.get(fence(130), key).budget).toMatchObject({ actionStarts: 1, chargedTokens: "40" });
    const retry = actions.retry(fence(130), key);
    expect(retry.action).toMatchObject({ state: "intent", effect: { logicalAttempt: 2 } });
    expect(retry.budget.actionStarts).toBe(2);
  });
  it("admin takeover requires settled independent actions and never bypasses pending cancellation", () => {
    const first = recovery.snapshot(fence(210)); const p = proof(first, 220);
    expect(() => recovery.commit(first, { kind: "takeover", receiptId: "takeover", owner: "next", leaseExpiresAt: 500 }, p, 220)).toThrow(/UNRESOLVED_ACTION/);
    commit(applied, 220);
    const settled = recovery.snapshot(fence(220)); const verified = proof(settled, 230);
    run = recovery.commit(settled, { kind: "takeover", receiptId: "takeover", owner: "next", leaseExpiresAt: 500 }, verified, 230).run;
    expect(run).toMatchObject({ generation: 2, leaseOwner: "next" });
    expect(actions.get(fence(230), key).budget).toMatchObject({ actionStarts: 1, chargedTokens: "20" });
    run = runs.project({ ...fence(230), status: "cancel_pending" });
    const cancelled = recovery.snapshot(fence(230));
    expect(() => recovery.commit(cancelled, { kind: "takeover", receiptId: "again", owner: "next", leaseExpiresAt: 600 }, proof(cancelled, 240), 240)).toThrow(/CANCEL_PENDING/);
  });
  it("rejects action drift without a revision bump and wrong result kinds", () => {
    const s = snapshot(); const p = proof(s);
    db.prepare("UPDATE graph_actions SET observed_tokens = 2 WHERE effect_key = ?").run(key);
    expect(() => recovery.commit(s, applied, p, 130)).toThrow(/PROOF_SNAPSHOT_MISMATCH/);
    expect(() => commit({ kind: "effect", receiptId: "wrong-result", verdict: { outcome: "applied", evidenceRef: "e", actualTokens: 2,
      result: { schemaVersion: 1, kind: "implementation_complete", workspaceLeaseRef: "lease", receiptRef: "r" } } })).toThrow(/RESPONSE_MISMATCH/);
  });
  it("rejects a reused receipt across effects, future proof time and invalid synchronous verifier returns", async () => {
    const done = commit();
    const other = actions.reserve(fence(130), { ...admission, nodeId: "other" }); run = other.run;
    const s = recovery.snapshot(fence(130), other.action.effectKey); const p = proof(s, 140);
    expect(() => recovery.commit(s, applied, p, 140)).toThrow(/DECISION_CONFLICT/);
    expect(() => recovery.commit(s, { ...applied, receiptId: "future" }, { ...p, verifiedAt: 150 }, 140)).toThrow(/PROOF_SNAPSHOT_MISMATCH/);
    const bad = new GraphRecoveryStore(db, () => Promise.reject(new Error("async deny")));
    expect(() => bad.commit(s, { ...applied, receiptId: "bad-auth" }, p, 140)).toThrow(/INVALID_PROOF_AUTHORITY/);
    await Promise.resolve();
    expect(done.record.snapshot.interruptId).toBe(`graph-recovery:${key}`);
  });

  it("rejects terminal cancellation while another independent action is unresolved", () => {
    const second = actions.reserve(fence(), { ...admission, nodeId: "independent" }); run = second.run;
    commit();
    const s = recovery.snapshot(fence(130));
    expect(() => recovery.commit(s, { kind: "project", receiptId: "cancel-all", status: "cancelled" }, proof(s), 130)).toThrow(/UNRESOLVED_ACTION/);
    expect(runs.get(scope, run.graphRunId)?.status).not.toBe("cancelled");
  });
  it("does not turn an action pending cancellation into a retryable failure", () => {
    run = actions.markUncertain(fence(), key, { state: "cancel_pending", evidenceRef: "cancel", observedTokens: 0 }).run;
    const done = commit({ kind: "effect", receiptId: "absent", verdict: { outcome: "not_applied", evidenceRef: "absent", actualTokens: 0, error: null } });
    expect(done.action?.retrySafe).toBe(false);
  });

  it("checks current time even for an exact durable replay", () => {
    const s = snapshot(); const p = proof(s); run = recovery.commit(s, applied, p, 130).run;
    run = actions.reserve(fence(150), { ...admission, nodeId: "later" }).run;
    expect(() => recovery.commit(s, applied, p, 140)).toThrow(/INVALID_TIME/);
  });

  it("lets the trusted verifier bind the exact decision, result and receipt before settlement", () => {
    const s = snapshot(); const p = proof(s);
    const exact = new GraphRecoveryStore(db, (_snapshot, _proof, decision) => {
      if (proofKey(decision) !== proofKey(applied)) throw new Error("UNTRUSTED_RESULT");
    });
    expect(() => exact.commit(s, { kind: "effect", receiptId: "forged", verdict: { outcome: "not_applied", evidenceRef: "forged", actualTokens: 0, error: null } }, p, 130)).toThrow(/UNTRUSTED_RESULT/);
    expect(exact.commit(s, applied, p, 130).action?.state).toBe("confirmed");
  });

});
it('recovers an authenticated no-child spawn failure without fabricating a stopped-process receipt', () => {
  run = runs.create({ ...request, idempotencyKey: 'no-child' }, program, 100);
  run = runs.acquireLease({ ...fence(110), owner: 'failed-spawn-owner', leaseExpiresAt: 200 });
  const s = recovery.snapshot(fence());
  const p = { ...proof(s), worker: { kind: 'not_started' as const, graphRunId: run.graphRunId, generation: run.generation,
    owner: run.leaseOwner!, confirmedAt: 125, evidenceRef: 'worker-not-started:observed-enoent' } };
  trusted.add(proofKey(p));
  const result = recovery.commit(s, { kind: 'takeover', receiptId: 'replace-failed-spawn', owner: 'replacement', leaseExpiresAt: 300 }, p, 130);
  expect(result.run.generation).toBe(2); expect(result.record.proof.worker.kind).toBe('not_started');
});
it('refuses a no-child proof when that generation has admitted actions', () => {
  const s = recovery.snapshot(fence());
  const p = { ...proof(s), worker: { kind: 'not_started' as const, graphRunId: run.graphRunId, generation: run.generation,
    owner: run.leaseOwner!, confirmedAt: 125, evidenceRef: 'worker-not-started:forged' } };
  trusted.add(proofKey(p));
  expect(() => recovery.commit(s, { kind: 'project', receiptId: 'forged-no-child', status: 'waiting_input' }, p, 130)).toThrow('WORKER_PROOF_MISMATCH');
});

import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "./db.js";
import { GraphRunStore, type GraphRun, type GraphProgramVersion } from "./graph-runs.js";
import { GraphActionStore, type GraphInvocationRequest } from "./graph-actions.js";
import { GraphVerificationStore, GraphDeliveryEpochStore } from "./graph-verification.js";
import { GraphAdmissionStore, GraphRecoveryStore, type GraphRecoverySnapshot, type GraphRecoveryProof } from "./graph-recovery.js";
const scope = { schemaVersion: 1 as const, tenantId: "t", principalId: "p", workspaceId: "w" };
const program: GraphProgramVersion = { executionModel: "langgraph-functional-v1", durability: "sync", engineVersion: "1", checkpointVersion: "1",
  templateVersion: "1", registryVersion: "1", compilerVersion: "1", schemaVersion: "1", compiledProgramDigest: "b".repeat(64) };
let dir: string; let db: Database.Database; let actions: GraphActionStore; let run: GraphRun; let key: string; let request: GraphInvocationRequest;
const fence = (now = 110) => ({ scope, graphRunId: run.graphRunId, expectedGeneration: run.generation,
  expectedRevision: run.revision, expectedOwner: run.leaseOwner, identity: run.identity, now });
const response = () => ({ schemaVersion: 1 as const, requestDigest: request.requestDigest, responseDigest: "c".repeat(64),
  disposition: "proposal" as const, proposalDigest: "d".repeat(64), evidenceRef: "response", stopEvidenceRef: "stopped" });
const start = () => { const result = actions.beginInvocation(fence(), key, "execution", request); run = result.run; return result; };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "graph apply-")); db = openDb({ path: join(dir, "state.db") });
  const runs = new GraphRunStore(db); actions = new GraphActionStore(db);
  run = runs.create({ schemaVersion: 1, kind: "start", scope, idempotencyKey: "start", inputArtifactRef: "input",
    source: { product: "osstack", requestId: "r", parentRunId: "p" }, spec: { schemaVersion: 1, template: "code-delivery-v1", publication: "artifact_only",
      input: { taskRef: "t", repositoryRef: "repo", baseRevision: "a".repeat(40), acceptanceRef: "a" },
      limits: { maxEpochs: 2, maxBranchAttempts: 2, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1,
        maxActionStarts: 10, deadlineSeconds: 60, tokenReservationLimit: 100 } } }, program, 100);
  run = runs.acquireLease({ ...fence(), owner: "worker", leaseExpiresAt: 100000 });
  const reserved = actions.reserve(fence(), { epoch: 0, nodeId: "implement", effectSlot: "invoke", reservationTokens: 40,
    action: { kind: "implement", inputArtifactRef: "input", workspaceLeaseRef: "workspace" } });
  run = reserved.run; key = reserved.action.effectKey;
  new GraphAdmissionStore(db).hold(key, 110);
  request = { schemaVersion: 1, profile: "bounded-changeset-v1", runId: run.graphRunId, effectKey: key, generation: run.generation,
    baseRevision: "a".repeat(40), treeRevision: "e".repeat(40), programDigest: program.compiledProgramDigest,
    profileDigest: "1".repeat(64), grantDigest: "2".repeat(64), policyDigest: "3".repeat(64), manifestDigest: "4".repeat(64),
    requestDigest: "5".repeat(64), inputArtifactRef: "input", workspaceLeaseRef: "workspace", provider: "fixture", model: "fixture" };
});
afterEach(() => { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); });


beforeEach(() => { start(); run = actions.recordInvocationResponse(fence(), key, response()).run; });
const intent = () => ({ schemaVersion: 1 as const, requestDigest: request.requestDigest,
  proposalDigest: response().proposalDigest!, manifestDigest: request.manifestDigest,
  beforeTreeRevision: request.treeRevision, targetTreeRevision: "f".repeat(40), journalRef: "journal", journalDigest: "6".repeat(64) });
const completed = () => ({ schemaVersion: 1 as const, kind: "applied" as const, proposalDigest: response().proposalDigest!,
  journalDigest: intent().journalDigest, treeRevision: intent().targetTreeRevision, evidenceRef: "apply-receipt", actualTokens: 12 });
const quarantine = () => ({ schemaVersion: 1 as const, kind: "quarantined" as const, proposalDigest: response().proposalDigest!,
  journalDigest: intent().journalDigest, evidenceRef: "partial", observedTokens: 12, cancelled: false });
function begin() { const value = actions.beginApply(fence(), key, intent()); run = value.run; return value; }
function complete() { const value = actions.completeApply(fence(), key, completed()); run = value.run; return value; }

it("grants apply only once and atomically records receipt plus existing action settlement", () => {
  expect(begin().applyAuthorized).toBe(true); expect(begin().applyAuthorized).toBe(false);
  expect(actions.get(fence(), key).budget).toMatchObject({ actionStarts: 1, reservedTokens: "40", chargedTokens: "0" });
  const result = complete();
  expect(result.changed).toBe(true); expect(result.action.state).toBe("confirmed");
  expect(result.action.outcome).toMatchObject({ evidenceRef: "apply-receipt", actualTokens: 12,
    result: { kind: "implementation_complete", workspaceLeaseRef: "workspace", receiptRef: "apply-receipt" } });
  expect(result.budget).toMatchObject({ actionStarts: 1, reservedTokens: "0", chargedTokens: "12" });
  expect(complete().changed).toBe(false);
  expect(actions.getApply(fence(), key).apply?.resolution).toEqual(completed());
  expect(db.prepare("SELECT released_at FROM graph_action_admissions WHERE effect_key=?").get(key)).toEqual({ released_at: null });
});
it("blocks new actions and generic failed settlement during partial apply", () => {
  const slot = { epoch: 0, nodeId: "freeze", effectSlot: "invoke", reservationTokens: 0,
    action: { kind: "workspace_create" as const, repositoryRef: "repo", baseRevision: "a".repeat(40) } };
  const reserved = actions.reserve(fence(), slot); run = reserved.run;
  begin();
  expect(() => actions.markRunning(fence(), reserved.action.effectKey, "freeze")).toThrow(/APPLY_PENDING/);
  expect(() => actions.reserve(fence(), { ...slot, nodeId: "tests" })).toThrow(/APPLY_PENDING/);
  expect(() => actions.recordOutcome(fence(), key, { state: "failed", evidenceRef: "pretend", actualTokens: 0, error: {}, retrySafe: false })).toThrow(/APPLY_SETTLEMENT_REQUIRED/);
  complete(); expect(actions.markRunning(fence(), reserved.action.effectKey, "freeze").changed).toBe(true);
});
it("quarantines uncertainty without allowing success, retry, or reservation release", () => {
  begin(); const result = actions.quarantineApply(fence(), key, quarantine()); run = result.run;
  expect(result.action.state).toBe("unknown"); expect(result.budget.reservedTokens).toBe("40");
  expect(actions.quarantineApply(fence(), key, quarantine()).changed).toBe(false);
  expect(() => complete()).toThrow(/APPLY_RESOLUTION_CONFLICT/);
  expect(() => actions.retry(fence(), key)).toThrow(/RETRY_NOT_SAFE/);
  expect(() => begin()).toThrow(/APPLY_QUARANTINED/);
});
it("cannot overwrite an intent or resolve a different proposal or tree", () => {
  begin();
  expect(() => actions.beginApply(fence(), key, { ...intent(), journalRef: "other" })).toThrow(/APPLY_INTENT_CONFLICT/);
  expect(() => actions.completeApply(fence(), key, { ...completed(), treeRevision: "1".repeat(40) })).toThrow(/APPLY_BINDING_MISMATCH/);
  expect(() => actions.completeApply(fence(), key, { ...completed(), proposalDigest: "1".repeat(64) })).toThrow(/APPLY_BINDING_MISMATCH/);
});
it("rolls back receipt insertion if action settlement fails", () => {
  begin(); db.exec("CREATE TEMP TRIGGER fail_settle BEFORE UPDATE OF state ON graph_actions BEGIN SELECT RAISE(ABORT, 'injected'); END");
  expect(complete).toThrow(/injected/);
  expect(actions.getApply(fence(), key).apply?.resolution).toBeNull();
  expect(actions.get(fence(), key).action.state).toBe("running");
  db.exec("DROP TRIGGER fail_settle"); expect(complete().changed).toBe(true);
});

function recoveryProof(snapshot: GraphRecoverySnapshot, now: number): GraphRecoveryProof {
  return { snapshotDigest: snapshot.digest, verifiedAt: now,
    worker: { kind: "stopped", graphRunId: run.graphRunId, generation: run.generation,
      owner: run.leaseOwner!, confirmedAt: now, evidenceRef: "worker-stopped" },
    executorEvidenceRef: "trusted-stop", workspaceEvidenceRef: "quarantined-workspace" };
}
const recoveryStore = () => new GraphRecoveryStore(db, (_snapshot, proof) => {
  if (proof.executorEvidenceRef !== "trusted-stop") throw Error("UNTRUSTED_STOP");
});
it("recovers only release of an already committed apply after lease expiry, without reapplying or charging", () => {
  begin(); const done = complete();
  const recovery = recoveryStore(); const now = 100010;
  const snapshot = recovery.snapshot(fence(now), key); const proof = recoveryProof(snapshot, now);
  const outcome = done.action.outcome!; if (outcome.state !== "confirmed") throw Error("fixture");
  const verdict = { outcome: "applied" as const, evidenceRef: outcome.evidenceRef, actualTokens: outcome.actualTokens, result: outcome.result };
  expect(() => recovery.commit(snapshot, { kind: "effect", receiptId: "bad", verdict: { ...verdict, actualTokens: 0 } }, proof, now)).toThrow(/OUTCOME_CONFLICT/);
  expect(() => recovery.commit(snapshot, { kind: "effect", receiptId: "bad", verdict: { outcome: "unknown", evidenceRef: "lost", observedTokens: 0 } }, proof, now)).toThrow(/OUTCOME_CONFLICT/);
  const decision = { kind: "effect" as const, receiptId: "release", verdict };
  run = recovery.commit(snapshot, decision, proof, now).run;
  expect(recovery.commit(snapshot, decision, proof, now).changed).toBe(false);
  const fresh = recovery.snapshot(fence(now), key); const releaseProof = recoveryProof(fresh, now);
  expect(() => recovery.completeRelease(fresh, "release", { ...releaseProof, executorEvidenceRef: "forged" }, now)).toThrow(/UNTRUSTED_STOP/);
  recovery.verifyRelease(fresh, "release", releaseProof, now);
  recovery.completeRelease(fresh, "release", releaseProof, now);
  recovery.completeRelease(fresh, "release", releaseProof, now);
  run = new GraphRunStore(db).acquireLease({ ...fence(now), owner: "next", leaseExpiresAt: now + 1000,
    stoppedWorker: { graphRunId: run.graphRunId, generation: run.generation, owner: run.leaseOwner!, confirmedAt: now, evidenceRef: "worker-stopped" } });
  expect(actions.get(fence(now), key).budget).toMatchObject({ reservedTokens: "0", chargedTokens: "12", actionStarts: 1 });
  expect(actions.getApply(fence(now), key).apply?.generation).toBe(1);
  expect(() => actions.beginApply(fence(now), key, intent())).toThrow(/ACTION_GENERATION_MISMATCH/);
});
it("quarantines crashed apply under stopped proof, releases only physical admission, and preserves unknown across takeover", () => {
  begin(); const recovery = recoveryStore(); const now = 100010;
  const snapshot = recovery.snapshot(fence(now), key); const proof = recoveryProof(snapshot, now);
  const decision = { kind: "effect" as const, receiptId: "quarantine", verdict: { outcome: "unknown" as const, evidenceRef: "crash", observedTokens: 12 } };
  expect(() => recovery.commit(snapshot, decision, { ...proof, executorEvidenceRef: "forged" }, now)).toThrow(/UNTRUSTED_STOP/);
  run = recovery.commit(snapshot, decision, proof, now).run;
  expect(db.prepare("SELECT kind FROM graph_apply_resolutions WHERE effect_key=?").get(key)).toEqual({ kind: "quarantined" });
  const fresh = recovery.snapshot(fence(now), key); const releaseProof = recoveryProof(fresh, now);
  expect(() => recovery.completeRelease(fresh, "quarantine", releaseProof, now)).toThrow(/UNRESOLVED_ACTION/);
  expect(() => recovery.completeQuarantineRelease(fresh, "quarantine", { ...releaseProof, executorEvidenceRef: "forged" }, now)).toThrow(/UNTRUSTED_STOP/);
  recovery.verifyQuarantineRelease(fresh, "quarantine", releaseProof, now);
  recovery.completeQuarantineRelease(fresh, "quarantine", releaseProof, now);
  recovery.completeQuarantineRelease(fresh, "quarantine", releaseProof, now);
  run = new GraphRunStore(db).acquireLease({ ...fence(now), owner: "inspector", leaseExpiresAt: now + 1000,
    stoppedWorker: { graphRunId: run.graphRunId, generation: run.generation, owner: run.leaseOwner!, confirmedAt: now, evidenceRef: "worker-stopped" } });
  expect(actions.get(fence(now), key).action.state).toBe("unknown");
  expect(actions.get(fence(now), key).budget).toMatchObject({ reservedTokens: "40", chargedTokens: "0", actionStarts: 1 });
  expect(actions.getApply(fence(now), key).apply?.generation).toBe(1);
  expect(() => actions.beginApply(fence(now), key, intent())).toThrow(/ACTION_GENERATION_MISMATCH/);
  expect(() => new GraphRunStore(db).project({ ...fence(now), status: "ready" })).toThrow(/UNRESOLVED_ACTION/);
});
it("blocks join and epoch advancement during apply and after quarantine", () => {
  run = new GraphRunStore(db).project({ ...fence(), status: "running" }); begin();
  const verification = new GraphVerificationStore(db, () => {});
  expect(() => verification.commit(verification.snapshot(fence()), {}, 110)).toThrow(/UNRESOLVED_ACTION/);
  expect(() => new GraphDeliveryEpochStore(db).activate(fence(), 0, { actions: 1, tokens: 0 })).toThrow(/UNRESOLVED_ACTION/);
  run = actions.quarantineApply(fence(), key, quarantine()).run;
  expect(() => verification.commit(verification.snapshot(fence()), {}, 110)).toThrow(/UNRESOLVED_ACTION/);
});
it("checks original deadline before apply but accepts already performed completion after it", () => {
  expect(() => actions.beginApply(fence(60100), key, intent())).toThrow(/WALL_CLOCK_BUDGET_EXHAUSTED/);
  begin(); run = actions.completeApply(fence(60100), key, completed()).run;
  expect(actions.get(fence(60100), key).action.state).toBe("confirmed");
});
it.each([null, 101])("retains budget blocks for unknown/overrun actual usage %s", usage => {
  begin(); const result = actions.completeApply(fence(), key, { ...completed(), actualTokens: usage }); run = result.run;
  expect(result.action.accountingBlocked).toBe(true);
  expect(result.budget).toMatchObject(usage === null ? { reservedTokens: "40", chargedTokens: "0" } : { reservedTokens: "0", chargedTokens: "101" });
});
it("rejects malformed/accessor receipts and schema-altering overwrites", () => {
  begin(); let reads = 0;
  expect(() => actions.completeApply(fence(), key, { ...completed(), get treeRevision() { reads++; return "f".repeat(40); } })).toThrow();
  expect(reads).toBe(0); complete();
  for (const table of ["graph_apply_intents", "graph_apply_resolutions"]) {
    expect(() => db.exec(`UPDATE ${table} SET created_at=111`)).toThrow(/immutable/);
    expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(/immutable/);
    expect(() => db.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)).toThrow(/immutable/);
  }
});
it("requires original held admission for apply and completion", () => {
  begin(); new GraphAdmissionStore(db).released(key, 110);
  expect(complete).toThrow(/INVOCATION_ADMISSION_REQUIRED/);
  // A replay is informational and never permits writes even after release.
  expect(begin().applyAuthorized).toBe(false);
});
it("routes apply uncertainty through quarantine and preserves cancellation", () => {
  begin();
  expect(() => actions.markUncertain(fence(), key, { state: "unknown", evidenceRef: "bypass", observedTokens: 0 })).toThrow(/APPLY_SETTLEMENT_REQUIRED/);
  run = new GraphRunStore(db).project({ ...fence(), status: "cancel_pending" });
  const result = actions.quarantineApply(fence(), key, { ...quarantine(), observedTokens: 70 }); run = result.run;
  expect(result.action.state).toBe("cancel_pending");
  expect(result.budget).toMatchObject({ reservedTokens: "70", accountingBlocked: true });
});

it("serializes competing connections and preserves intent on stale ACK replay", () => {
  const stale = fence(); begin(); const other = openDb({ path: join(dir, "state.db") });
  try {
    const competing = new GraphActionStore(other);
    expect(() => competing.beginApply(stale, key, intent())).toThrow(/REVISION_CONFLICT/);
    expect(competing.beginApply(fence(), key, intent()).applyAuthorized).toBe(false);
  } finally { other.close(); }
});
it.each(["requestDigest", "proposalDigest", "manifestDigest", "beforeTreeRevision"] as const)("rejects mismatched apply binding %s", field => {
  expect(() => actions.beginApply(fence(), key, { ...intent(), [field]: "9".repeat(field === "beforeTreeRevision" ? 40 : 64) })).toThrow(/APPLY_BINDING_MISMATCH/);
  expect(actions.getApply(fence(), key).apply).toBeNull();
});
it("upgrades schema38 with an existing request and response without modifying them", () => {
  const original = actions.getInvocation(fence(), key).invocation;
  db.exec("DROP TABLE graph_apply_resolutions; DROP TABLE graph_apply_intents;"); db.pragma("user_version=38"); db.close();
  db = openDb({ path: join(dir, "state.db") }); actions = new GraphActionStore(db);
  expect(actions.getInvocation(fence(), key).invocation).toEqual(original);
  expect(actions.getApply(fence(), key).apply).toBeNull(); expect(begin().applyAuthorized).toBe(true);
  expect(db.pragma("foreign_key_check")).toEqual([]);
});

it.each(["before_gate", "mid_gate", "after_gate", "partial", "after_files", "mid_completion", "after_receipt"])("does not repeat physical writes after SIGKILL at %s", async point => {
  const ts = await import("typescript");
  for (const name of ["graph-actions", "graph-apply", "graph-invocations", "graph-storage", "graph-runs", "db", "migrations"]) {
    writeFileSync(join(dir, `${name}.js`), ts.transpileModule(readFileSync(new URL(`./${name}.ts`, import.meta.url), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  }
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  symlinkSync(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, "old.txt"), "before"); writeFileSync(join(dir, "delete.txt"), "delete me");
  writeFileSync(join(dir, "input.json"), JSON.stringify({ fence: fence(), intent: intent(), completed: completed(), key, point }));
  writeFileSync(join(dir, "child.mjs"), `
    import {readFileSync,writeFileSync,appendFileSync,unlinkSync} from 'node:fs';
    import {openDb} from './db.js';
    import {GraphActionStore} from './graph-actions.js';
    import {GraphRunStore} from './graph-runs.js';
    import {fileURLToPath} from 'node:url';
    const path=name=>new URL('./'+name,import.meta.url);
    const w=JSON.parse(readFileSync(path('input.json'),'utf8'));
    const db=openDb({path:fileURLToPath(path('state.db'))}); const store=new GraphActionStore(db);
    const restart=process.argv[2]==='restart'; const kill=()=>process.kill(process.pid,'SIGKILL');
    db.function('crash',kill);
    if(!restart && w.point==='mid_gate') db.exec("CREATE TEMP TRIGGER kill_gate AFTER INSERT ON graph_apply_intents BEGIN SELECT crash(); END");
    if(!restart && w.point==='before_gate') kill();
    const run=new GraphRunStore(db).get(w.fence.scope,w.fence.graphRunId);
    const gate=store.beginApply({...w.fence,expectedRevision:run.revision},w.key,w.intent);
    if(!restart && w.point==='after_gate') kill();
    if(gate.applyAuthorized) {
      const count=()=>appendFileSync(path('writes'),'write'+String.fromCharCode(10),{flush:true});
      writeFileSync(path('old.txt'),'after',{flush:true}); count();
      if(!restart && w.point==='partial') kill();
      unlinkSync(path('delete.txt')); count(); writeFileSync(path('create.txt'),'created',{flush:true}); count();
      if(!restart && w.point==='after_files') kill();
      if(!restart && w.point==='mid_completion') db.exec("CREATE TEMP TRIGGER kill_receipt BEFORE UPDATE OF state ON graph_actions BEGIN SELECT crash(); END");
      store.completeApply({...w.fence,expectedRevision:gate.run.revision},w.key,w.completed);
      if(!restart && w.point==='after_receipt') kill();
    }
    db.close();
  `);
  const child = spawnSync(process.execPath, [join(dir, "child.mjs")], { timeout: 10000, encoding: "utf8" });
  expect(child.stderr).toBe(""); expect(child.signal).toBe("SIGKILL");
  if (point === "mid_gate") expect(actions.getApply(fence(), key).apply).toBeNull();
  for (let i = 0; i < 2; i++) {
    const replay = spawnSync(process.execPath, [join(dir, "child.mjs"), "restart"], { timeout: 10000, encoding: "utf8" });
    expect(replay.stderr).toBe(""); expect(replay.status).toBe(0);
  }
  const writes = existsSync(join(dir, "writes")) ? readFileSync(join(dir, "writes"), "utf8").trim().split("\n").length : 0;
  const expected = point === "after_gate" ? 0 : point === "partial" ? 1 : 3;
  expect(writes).toBe(expected);
  expect(readFileSync(join(dir, "old.txt"), "utf8")).toBe(expected === 0 ? "before" : "after");
  expect(existsSync(join(dir, "delete.txt"))).toBe(expected < 2);
  expect(existsSync(join(dir, "create.txt"))).toBe(expected === 3);
  run = new GraphRunStore(db).get(scope, run.graphRunId)!;
  const applied = ["before_gate", "mid_gate", "after_receipt"].includes(point);
  expect(actions.getApply(fence(), key).apply?.resolution?.kind ?? null).toBe(applied ? "applied" : null);
  expect(actions.get(fence(), key).budget).toMatchObject({ actionStarts: 1, reservedTokens: applied ? "0" : "40", chargedTokens: applied ? "12" : "0" });
  if (!applied) {
    const recovery = recoveryStore(); const snapshot = recovery.snapshot(fence(100010), key);
    run = recovery.commit(snapshot, { kind: "effect", receiptId: "crash", verdict: { outcome: "unknown", evidenceRef: "stopped-after-crash", observedTokens: 12 } },
      recoveryProof(snapshot, 100010), 100010).run;
    expect(db.prepare("SELECT kind FROM graph_apply_resolutions WHERE effect_key=?").get(key)).toEqual({ kind: "quarantined" });
  }
}, 20000);

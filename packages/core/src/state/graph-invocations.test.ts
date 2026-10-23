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
import { GraphAdmissionStore, GraphRecoveryStore, type GraphRecoveryProof } from "./graph-recovery.js";
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
  dir = mkdtempSync(join(tmpdir(), "graph-invocations-")); db = openDb({ path: join(dir, "state.db") });
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

it("commits binding and running atomically, never reauthorizes dispatch after disk reopen", () => {
  const stale = fence(); const begun = start(); expect(begun.changed).toBe(true);
  expect(begun.budget).toMatchObject({ actionStarts: 1, reservedTokens: "40", chargedTokens: "0" });
  const other = openDb({ path: join(dir, "state.db") });
  try {
    const competitor = new GraphActionStore(other);
    expect(() => competitor.beginInvocation(stale, key, "execution", request)).toThrow(/REVISION_CONFLICT/);
    expect(competitor.beginInvocation(fence(), key, "execution", request).changed).toBe(false);
  } finally { other.close(); }
  db.close(); db = openDb({ path: join(dir, "state.db") }); actions = new GraphActionStore(db);
  expect(start().changed).toBe(false);
  expect(actions.getInvocation(fence(), key).invocation).toEqual({ request, response: null });
  expect(() => actions.beginInvocation(fence(), key, "other", request)).toThrow(/EXECUTION_CONFLICT/);
  expect(() => actions.beginInvocation(fence(), key, "execution", { ...request, model: "changed" })).toThrow(/INVOCATION_CONFLICT/);
});
it.each(["runId", "effectKey", "generation", "programDigest", "baseRevision", "inputArtifactRef", "workspaceLeaseRef"] as const)("rejects changed authoritative binding %s without starting", field => {
  const changed = { ...request, [field]: field === "generation" ? 2 : field === "effectKey" || field === "programDigest" ? "f".repeat(64) : field === "baseRevision" ? "f".repeat(40) : "other" };
  expect(() => actions.beginInvocation(fence(), key, "execution", changed)).toThrow(/INVOCATION_BINDING_MISMATCH/);
  expect(actions.get(fence(), key).action.state).toBe("intent");
  expect(actions.getInvocation(fence(), key).invocation).toBeNull();
});
it("rolls back request insert if the running transition fails", () => {
  db.exec("CREATE TRIGGER inject_start_failure BEFORE UPDATE OF state ON graph_actions BEGIN SELECT RAISE(ABORT, 'injected'); END");
  expect(start).toThrow(/injected/);
  expect(actions.getInvocation(fence(), key).invocation).toBeNull();
  expect(actions.get(fence(), key).action.state).toBe("intent");
  db.exec("DROP TRIGGER inject_start_failure"); expect(start().changed).toBe(true);
});
it("requires held admission and refuses to backfill a legacy dispatch", () => {
  run = actions.markRunning(fence(), key, "execution").run;
  expect(start).toThrow(/INVOCATION_CONFLICT/);
  new GraphAdmissionStore(db).released(key, 110);
  expect(start).toThrow(/INVOCATION_ADMISSION_REQUIRED/);
});
it("checks original deadline before new dispatch but permits late stopped response evidence", () => {
  expect(() => actions.beginInvocation(fence(60100), key, "execution", request)).toThrow(/WALL_CLOCK_BUDGET_EXHAUSTED/);
  start(); const receipt = actions.recordInvocationResponse(fence(60100), key, response()); run = receipt.run;
  expect(receipt.budget.reservedTokens).toBe("40");
});
it("response evidence is immutable, does not settle usage, release admission or authorize apply", () => {
  start(); const receipt = actions.recordInvocationResponse(fence(), key, response()); run = receipt.run;
  expect(receipt.changed).toBe(true); expect(receipt.action.state).toBe("running");
  expect(receipt.budget).toMatchObject({ actionStarts: 1, reservedTokens: "40", chargedTokens: "0" });
  expect(actions.recordInvocationResponse(fence(), key, response()).changed).toBe(false);
  expect(actions.getInvocation(fence(), key).invocation?.response).toEqual(response());
  expect(() => actions.recordInvocationResponse(fence(), key, { ...response(), responseDigest: "f".repeat(64) })).toThrow(/INVOCATION_RESPONSE_CONFLICT/);
  expect(() => actions.recordInvocationResponse(fence(), key, { ...response(), requestDigest: "f".repeat(64) })).toThrow(/INVOCATION_BINDING_MISMATCH/);
  for (const table of ["graph_invocation_requests", "graph_invocation_responses"]) {
    expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(/immutable/);
    expect(() => db.exec(`UPDATE ${table} SET created_at=111`)).toThrow(/immutable/);
    expect(() => db.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)).toThrow(/immutable/);
  }
  expect(() => actions.recordOutcome(fence(), key, { state: "confirmed", evidenceRef: "fake-apply", actualTokens: 5,
    result: { schemaVersion: 1, kind: "implementation_complete", workspaceLeaseRef: "workspace", receiptRef: "apply" } })).toThrow(/INVOCATION_APPLY_REQUIRED/);
  expect(() => actions.recordOutcome(fence(), key, { state: "failed", evidenceRef: "failure", actualTokens: 5, error: {}, retrySafe: true })).toThrow(/INVOCATION_APPLY_REQUIRED/);
  expect(db.prepare("SELECT released_at FROM graph_action_admissions WHERE effect_key=?").get(key)).toEqual({ released_at: null });
});
it("late evidence is retained without clearing unknown or permitting retries", () => {
  start(); run = actions.markUncertain(fence(), key, { state: "unknown", evidenceRef: "lost", observedTokens: 0 }).run;
  run = actions.recordInvocationResponse(fence(), key, response()).run;
  expect(actions.get(fence(), key).action.state).toBe("unknown");
  expect(actions.getInvocation(fence(), key).invocation?.response).toEqual(response());
  expect(() => actions.retry(fence(), key)).toThrow(/RETRY_NOT_SAFE/);
  expect(actions.get(fence(), key).budget.reservedTokens).toBe("40");
});
it("legacy recovery cannot settle provider or apply truth, but can quarantine unknown", () => {
  start(); const recovery = new GraphRecoveryStore(db, () => {});
  const snapshot = recovery.snapshot(fence(120), key);
  const proof: GraphRecoveryProof = { snapshotDigest: snapshot.digest, verifiedAt: 120,
    worker: { kind: "stopped", graphRunId: run.graphRunId, generation: run.generation, owner: "worker", confirmedAt: 120, evidenceRef: "exit" },
    executorEvidenceRef: "executor", workspaceEvidenceRef: "workspace" };
  for (const verdict of [{ outcome: "not_applied" as const, evidenceRef: "no", actualTokens: 0, error: {} },
    { outcome: "applied" as const, evidenceRef: "yes", actualTokens: 5, result: { schemaVersion: 1 as const, kind: "implementation_complete" as const, workspaceLeaseRef: "workspace", receiptRef: "fake" } }]) {
    expect(() => recovery.commit(snapshot, { kind: "effect", receiptId: "decision", verdict }, proof, 120)).toThrow(/INVOCATION_RECOVERY_UNSUPPORTED/);
  }
  run = recovery.commit(snapshot, { kind: "effect", receiptId: "unknown", verdict: { outcome: "unknown", evidenceRef: "lost", observedTokens: 0 } }, proof, 120).run;
  expect(actions.get(fence(120), key).budget.reservedTokens).toBe("40");
});

it("requires held admission on a fresh intent and preserves its reservation on refusal", () => {
  new GraphAdmissionStore(db).released(key, 110);
  expect(start).toThrow(/INVOCATION_ADMISSION_REQUIRED/);
  expect(actions.getInvocation(fence(), key).invocation).toBeNull();
  expect(actions.get(fence(), key).budget.reservedTokens).toBe("40");
});
it("replays an already recorded receipt after admission release", () => {
  start(); run = actions.recordInvocationResponse(fence(), key, response()).run;
  new GraphAdmissionStore(db).released(key, 110);
  expect(actions.recordInvocationResponse(fence(), key, response()).changed).toBe(false);
});
it("generation takeover preserves historical request but cannot redispatch or append a new response", () => {
  start(); const historical = { ...request }; const oldFence = fence();
  // Simulate trusted supervisor releasing actual host resources after stop.
  new GraphAdmissionStore(db).released(key, 120);
  run = new GraphRunStore(db).acquireLease({ ...fence(120), owner: "next", leaseExpiresAt: 100000,
    stoppedWorker: { graphRunId: run.graphRunId, generation: run.generation, owner: "worker", confirmedAt: 120, evidenceRef: "exit" } });
  expect(actions.getInvocation(fence(120), key).invocation?.request).toEqual(historical);
  expect(() => actions.beginInvocation(oldFence, key, "execution", request)).toThrow(/STALE_GENERATION/);
  expect(() => actions.beginInvocation(fence(120), key, "execution", { ...request, generation: run.generation })).toThrow(/ACTION_GENERATION_MISMATCH/);
  expect(() => actions.recordInvocationResponse(fence(120), key, response())).toThrow(/ACTION_GENERATION_MISMATCH/);
});
it("rejects malformed or accessor-bearing evidence before any durable mutation", () => {
  expect(() => actions.beginInvocation(fence(), key, "execution", { ...request, apiKey: "not-accepted" } as GraphInvocationRequest)).toThrow();
  let reads = 0;
  const unsafe = { ...request, get model() { reads++; return "secret"; } };
  expect(() => actions.beginInvocation(fence(), key, "execution", unsafe)).toThrow(); expect(reads).toBe(0);
  start();
  expect(() => actions.recordInvocationResponse(fence(), key, { ...response(), proposalDigest: null })).toThrow();
  expect(actions.getInvocation(fence(), key).invocation?.response).toBeNull();
});
it("a stopped non-retryable failure charges the existing reservation only once", () => {
  start(); run = actions.recordInvocationResponse(fence(), key, { ...response(), disposition: "rejected", proposalDigest: null }).run;
  const outcome = { state: "failed" as const, actualTokens: 5, evidenceRef: "rejected", error: {}, retrySafe: false };
  const settled = actions.recordOutcome(fence(), key, outcome); run = settled.run;
  expect(settled.budget).toMatchObject({ actionStarts: 1, reservedTokens: "0", chargedTokens: "40" });
  expect(actions.recordOutcome(fence(), key, outcome).changed).toBe(false);
  expect(() => actions.retry(fence(), key)).toThrow(/RETRY_NOT_SAFE/);
});

it("refuses a first response after admission release", () => {
  start(); new GraphAdmissionStore(db).released(key, 110);
  expect(() => actions.recordInvocationResponse(fence(), key, response())).toThrow(/INVOCATION_ADMISSION_REQUIRED/);
  expect(actions.getInvocation(fence(), key).invocation?.response).toBeNull();
});
it("refuses a response for a legacy action without an invocation request", () => {
  run = actions.markRunning(fence(), key, "execution").run;
  expect(() => actions.recordInvocationResponse(fence(), key, response())).toThrow(/INVOCATION_NOT_FOUND/);
});

it.each(["before_commit", "mid_transaction", "after_commit", "after_response", "after_receipt"])("survives process SIGKILL at %s without duplicate dispatch", async point => {
  const ts = await import("typescript");
  for (const name of ["graph-actions", "graph-apply", "graph-invocations", "graph-storage", "graph-runs", "db", "migrations"]) {
    writeFileSync(join(dir, `${name}.js`), ts.transpileModule(readFileSync(new URL(`./${name}.ts`, import.meta.url), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  }
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  const dependencies = fileURLToPath(new URL("../../node_modules", import.meta.url));
  expect(existsSync(dependencies), "core workspace dependencies must be installed").toBe(true);
  symlinkSync(dependencies, join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, "input.json"), JSON.stringify({ fence: fence(), request, response: response(), key, point }));
  writeFileSync(join(dir, "child.mjs"), `
    import { readFileSync, appendFileSync } from 'node:fs';
    import { openDb } from './db.js';
    import { GraphActionStore } from './graph-actions.js';
    import { GraphRunStore } from './graph-runs.js';
    const w=JSON.parse(readFileSync(new URL('./input.json', import.meta.url),'utf8'));
    const db=openDb({path:new URL('./state.db',import.meta.url).pathname});
    const store=new GraphActionStore(db); const restart=process.argv[2]==='restart';
    const kill=()=>process.kill(process.pid,'SIGKILL');
    if(!restart && w.point==='mid_transaction') {
      db.function('crash', kill);
      db.exec("CREATE TEMP TRIGGER kill_mid BEFORE UPDATE OF state ON graph_actions BEGIN SELECT crash(); END");
    }
    if(!restart && w.point==='before_commit') kill();
    const run=new GraphRunStore(db).get(w.fence.scope,w.fence.graphRunId);
    const result=store.beginInvocation({...w.fence,expectedRevision:run.revision},w.key,'execution',w.request);
    if(!restart && w.point==='after_commit') kill();
    if(result.changed) {
      appendFileSync(new URL('./calls',import.meta.url),'request\\n',{flush:true});
      if(!restart && w.point==='after_response') kill();
      store.recordInvocationResponse({...w.fence,expectedRevision:result.run.revision},w.key,w.response);
      if(!restart && w.point==='after_receipt') kill();
    }
    db.close();
  `);
  const child = spawnSync(process.execPath, [join(dir, "child.mjs")], { timeout: 10000, encoding: "utf8" });
  expect(child.stderr).toBe(""); expect(child.signal).toBe("SIGKILL");
  if (point === "mid_transaction") {
    expect(actions.getInvocation(fence(), key).invocation).toBeNull();
    expect(actions.get(fence(), key).action.state).toBe("intent");
  }
  for (let i = 0; i < 2; i++) {
    const restart = spawnSync(process.execPath, [join(dir, "child.mjs"), "restart"], { timeout: 10000, encoding: "utf8" });
    expect(restart.stderr).toBe(""); expect(restart.status).toBe(0);
  }
  const calls = existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n").length : 0;
  expect(calls).toBe(point === "after_commit" ? 0 : 1);
  run = new GraphRunStore(db).get(scope, run.graphRunId)!;
  expect(actions.get(fence(), key).budget).toMatchObject({ actionStarts: 1, reservedTokens: "40", chargedTokens: "0" });
  expect(actions.getInvocation(fence(), key).invocation?.response !== null).toBe(point === "before_commit" || point === "mid_transaction" || point === "after_receipt");
}, 20000);
it('atomically settles a terminal rejection, replays exactly after release, and forbids contradictory usage', () => {
  start(); const before = run.revision;
  const rejected = { ...response(), disposition: 'cannot_complete' as const, proposalDigest: null };
  const result = actions.recordRejectedInvocation(fence(), key, rejected, 12); run = result.run;
  expect(run.revision).toBe(before + 1);
  expect(result.action).toMatchObject({ state: 'failed', retrySafe: false, actualTokens: 12 });
  expect(actions.getInvocation(fence(), key).invocation?.response).toEqual(rejected);
  new GraphAdmissionStore(db).released(key, 110);
  expect(actions.recordRejectedInvocation(fence(), key, rejected, 12).changed).toBe(false);
  expect(() => actions.recordRejectedInvocation(fence(), key, rejected, 13)).toThrow('OUTCOME_CONFLICT');
});
it('never uses a terminal rejection to clear unknown or turn a proposal into failure', () => {
  start(); const rejected = { ...response(), disposition: 'rejected' as const, proposalDigest: null };
  run = actions.markUncertain(fence(), key, { state: 'unknown', evidenceRef: 'lost', observedTokens: 12 }).run;
  expect(() => actions.recordRejectedInvocation(fence(), key, rejected, 12)).toThrow('UNRESOLVED_ACTION');
  expect(() => actions.recordRejectedInvocation(fence(), key, response(), 12)).toThrow('INVOCATION_BINDING_MISMATCH');
  expect(actions.getInvocation(fence(), key).invocation?.response).toBeNull();
});
it('rolls back the rejection receipt when atomic failure settlement cannot commit', () => {
  start(); const before = run.revision;
  db.exec("CREATE TRIGGER fail_rejection BEFORE UPDATE OF state ON graph_actions WHEN NEW.state='failed' BEGIN SELECT RAISE(ABORT,'injected'); END");
  expect(() => actions.recordRejectedInvocation(fence(), key, { ...response(), disposition: 'rejected', proposalDigest: null }, null)).toThrow('injected');
  expect(actions.getInvocation(fence(), key).invocation?.response).toBeNull();
  expect(actions.get(fence(), key)).toMatchObject({ action: { state: 'running' }, run: { revision: before } });
});

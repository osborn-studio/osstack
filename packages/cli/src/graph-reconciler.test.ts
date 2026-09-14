import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { GraphRunStore, GraphActionStore, openDb, type GraphRun } from "@osstack/core";
import type { GraphRecoveryVerdict } from "@osstack/core/graph-recovery";
import { GraphReconciler, type GraphReconcilerRegistration, type GraphReconciliationRequest } from "./graph-reconciler.js";
const scope = { schemaVersion: 1 as const, tenantId: "t", principalId: "p", workspaceId: "w" };
let dir: string; let db: Database.Database; let runs: GraphRunStore; let actions: GraphActionStore; let run: GraphRun;
let reconciler: GraphReconciler; let key: string; let connection: object; let registration: GraphReconcilerRegistration;
let revoked: boolean; let workerStopped: boolean; let executorStopped: boolean; let exported: boolean; let outcome: GraphRecoveryVerdict;
const fence = () => ({ scope, graphRunId: run.graphRunId, expectedGeneration: run.generation, expectedRevision: run.revision,
  expectedOwner: run.leaseOwner, identity: run.identity, now: 120 });
const request = (): Extract<GraphReconciliationRequest, { kind: "effect" }> => ({ kind: "effect", fence: fence(), receiptId: "receipt", effectKey: key });
function install() { reconciler = new GraphReconciler(db, () => 130); reconciler.register(connection, registration); }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "g15-cli-")); db = openDb({ path: join(dir, "state.db") }); runs = new GraphRunStore(db); actions = new GraphActionStore(db);
  run = runs.create({ schemaVersion: 1, kind: "start", scope, idempotencyKey: "start", inputArtifactRef: "input", source: { product: "osstack", requestId: "r" },
    spec: { schemaVersion: 1, template: "code-delivery-v1", publication: "artifact_only", input: { taskRef: "t", repositoryRef: "repo", baseRevision: "a".repeat(40), acceptanceRef: "a" },
      limits: { maxEpochs: 1, maxBranchAttempts: 2, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 10, deadlineSeconds: 60, tokenReservationLimit: 100 } } },
    { executionModel: "langgraph-functional-v1", durability: "sync", engineVersion: "1", checkpointVersion: "1", templateVersion: "1", registryVersion: "1", compilerVersion: "1", schemaVersion: "1", compiledProgramDigest: "b".repeat(64) }, 100);
  run = runs.acquireLease({ ...fence(), owner: "worker", leaseExpiresAt: 200 });
  const intent = actions.reserve(fence(), { epoch: 0, nodeId: "n", effectSlot: "s", reservationTokens: 40,
    action: { kind: "workspace_create", repositoryRef: "repo", baseRevision: "a".repeat(40) } }); run = intent.run; key = intent.action.effectKey;
  run = actions.markRunning(fence(), key, "trusted-executor-1").run;
  appendFileSync(join(dir, "effects.log"), "once\n");
  connection = {}; revoked = false; workerStopped = false; executorStopped = false; exported = false;
  outcome = { outcome: "applied", evidenceRef: "effect-receipt", actualTokens: 20, result: { schemaVersion: 1, kind: "workspace", workspaceLeaseRef: "lease", receiptRef: "result" } };
  registration = { binding: { scope, graphRunId: run.graphRunId, generation: run.generation, owner: "worker", identity: run.identity },
    authorize: () => { if (revoked) throw new Error("revoked"); },
    stopWorker: async () => { workerStopped = true; return { untrusted: "not evidence" }; },
    verifyWorker: async (s) => { if (!workerStopped) throw new Error("worker not stopped"); return { kind: "stopped", graphRunId: s.run.graphRunId,
      generation: s.run.generation, owner: s.run.leaseOwner!, confirmedAt: 125, evidenceRef: "actual-exit" }; },
    verifyQuiescence: async () => { executorStopped = true; exported = true; return { executorEvidenceRef: "all-executors", workspaceEvidenceRef: "archive" }; },
    verifyOutcome: async () => structuredClone(outcome),
    recheck: () => { if (revoked || !workerStopped || !executorStopped || !exported) throw new Error("not quiescent"); },
    release: vi.fn(async (_r, verify) => { await verify(); }) };
  install();
});
afterEach(() => { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("trusted reconciler", () => {
  it("stops and independently verifies, commits before release, never invokes and retries lost release ack after restart", async () => {
    const release = vi.fn(async (_r: unknown, verify: () => Promise<void>) => { await verify();
      expect(db.prepare("SELECT count(*) AS n FROM graph_recovery_decisions").get()).toEqual({ n: 1 }); throw new Error("release failed"); });
    registration.release = release; install();
    const first = await reconciler.reconcile(connection, request());
    expect(first.exit).toBe("release_pending"); expect(first.result.action?.state).toBe("confirmed");
    run = first.result.run;
    db.close(); db = openDb({ path: join(dir, "state.db") }); runs = new GraphRunStore(db);
    registration.release = vi.fn(async (_r, verify) => { await verify(); }); install();
    const retry = await reconciler.reconcile(connection, { ...request(), fence: { ...fence(), now: 130 } });
    expect(retry.exit).toBe("applied"); expect(retry.result.changed).toBe(false);
    expect(readFileSync(join(dir, "effects.log"), "utf8")).toBe("once\n");
    expect(registration.release).toHaveBeenCalledTimes(1);
  });
  it.each(["unknown", "not_applied"] as const)("returns distinct %s exit without sending effects", async (kind) => {
    outcome = kind === "unknown" ? { outcome: kind, evidenceRef: "unknown", observedTokens: 12 } : { outcome: kind, evidenceRef: "absent", actualTokens: 0, error: null };
    const done = await reconciler.reconcile(connection, request());
    expect(done.exit).toBe(kind); expect(done.result.action?.state).toBe(kind === "unknown" ? "unknown" : "failed");
    expect(registration.release).toHaveBeenCalledTimes(kind === "unknown" ? 0 : 1);
    expect(readFileSync(join(dir, "effects.log"), "utf8")).toBe("once\n");
  });
  it.each(["stop", "worker", "quiescence", "outcome"] as const)("rejects revocation after %s await with no decision", async (boundary) => {
    if (boundary === "stop") registration.stopWorker = async () => { revoked = true; return undefined; };
    if (boundary === "worker") registration.verifyWorker = async () => { revoked = true; return { kind: "preworker", evidenceRef: "fake" }; };
    if (boundary === "quiescence") registration.verifyQuiescence = async () => { revoked = true; return { executorEvidenceRef: "e", workspaceEvidenceRef: "w" }; };
    if (boundary === "outcome") registration.verifyOutcome = async () => { revoked = true; return outcome; };
    install(); await expect(reconciler.reconcile(connection, request())).rejects.toThrow(/revoked/);
    expect(db.prepare("SELECT count(*) AS n FROM graph_recovery_decisions").get()).toEqual({ n: 0 });
    expect(registration.release).not.toHaveBeenCalled();
  });
  it("does not refresh the proof revision over a concurrent ledger update", async () => {
    registration.verifyOutcome = async () => { run = actions.markUncertain(fence(), key, { state: "unknown", evidenceRef: "concurrent", observedTokens: 80 }).run; return outcome; };
    install(); await expect(reconciler.reconcile(connection, request())).rejects.toThrow(/REVISION_CONFLICT/);
    expect(actions.get(fence(), key).action.observedTokens).toBe(80);
  });
  it("snapshots request and registration before await; worker-shaped flags and unregistered connections have no authority", async () => {
    await expect(reconciler.reconcile({}, request())).rejects.toThrow(/REGISTRATION/);
    const input = request();
    registration.stopWorker = async () => { input.effectKey = "c".repeat(64); registration.binding.owner = "attacker"; workerStopped = true; };
    install(); const done = await reconciler.reconcile(connection, input);
    expect(done.result.action?.effectKey).toBe(key);
  });
  it.each([true, "yes", Promise.resolve(undefined)])("rejects non-undefined synchronous authority %s", async (bad) => {
    registration.authorize = (() => bad) as GraphReconcilerRegistration["authorize"];
    install(); await expect(reconciler.reconcile(connection, request())).rejects.toThrow(/AUTHORITY/);
  });
  it("rejects changed outcome on receipt replay and revalidates release authority", async () => {
    const first = await reconciler.reconcile(connection, request()); run = first.result.run;
    outcome = { outcome: "not_applied", evidenceRef: "changed", actualTokens: 0, error: null };
    await expect(reconciler.reconcile(connection, { ...request(), fence: { ...fence(), now: 130 } })).rejects.toThrow(/DECISION_CONFLICT/);
  });
  it.each(["worker", "quiescence", "outcome"] as const)("rejects boolean self-authority from %s verifier", async (boundary) => {
    if (boundary === "worker") registration.verifyWorker = (async () => true) as unknown as GraphReconcilerRegistration["verifyWorker"];
    if (boundary === "quiescence") registration.verifyQuiescence = (async () => true) as unknown as GraphReconcilerRegistration["verifyQuiescence"];
    if (boundary === "outcome") registration.verifyOutcome = (async () => true) as unknown as GraphReconcilerRegistration["verifyOutcome"];
    install(); await expect(reconciler.reconcile(connection, request())).rejects.toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM graph_recovery_decisions").get()).toEqual({ n: 0 });
  });
  it("keeps the decision durable when release-time verification is revoked", async () => {
    registration.release = async (_result, reverify) => { revoked = true; await reverify(); };
    install(); const done = await reconciler.reconcile(connection, request());
    expect(done.exit).toBe("release_pending"); expect(done.releaseError).toContain("revoked");
    expect(db.prepare("SELECT count(*) AS n FROM graph_recovery_decisions").get()).toEqual({ n: 1 });
  });
  it("replays unknown without releasing, then appends a later receipt under the same stable interrupt", async () => {
    outcome = { outcome: "unknown", evidenceRef: "lost", observedTokens: 50 };
    const first = await reconciler.reconcile(connection, request()); run = first.result.run;
    const replay = await reconciler.reconcile(connection, { ...request(), fence: { ...fence(), now: 130 } });
    expect(replay.exit).toBe("unknown"); expect(replay.result.changed).toBe(false);
    outcome = { outcome: "applied", evidenceRef: "found", actualTokens: 20,
      result: { schemaVersion: 1, kind: "workspace", workspaceLeaseRef: "lease", receiptRef: "result" } };
    const later = await reconciler.reconcile(connection, { ...request(), receiptId: "later", fence: { ...fence(), now: 130 } });
    expect(later.result.record.snapshot.interruptId).toBe(first.result.record.snapshot.interruptId);
    expect(later.result.action?.actualTokens).toBe(50);
    expect(db.prepare("SELECT count(*) AS n FROM graph_recovery_decisions").get()).toEqual({ n: 2 });
  });
  it("rejects asynchronous final recheck grants without an unhandled rejection", async () => {
    registration.recheck = () => Promise.reject(new Error("denied")); install();
    await expect(reconciler.reconcile(connection, request())).rejects.toThrow(/AUTHORITY/);
  });

  it("replays invalid usage as the same blocked accounting decision", async () => {
    if (outcome.outcome !== "applied") throw new Error("fixture");
    outcome.actualTokens = -1;
    const first = await reconciler.reconcile(connection, request()); run = first.result.run;
    expect(first.result.action).toMatchObject({ actualTokens: null, accountingBlocked: true });
    const second = await reconciler.reconcile(connection, { ...request(), fence: { ...fence(), now: 130 } });
    expect(second.result.changed).toBe(false);
  });

});

it('acknowledges an exact lost takeover response without stopping the replacement worker', async () => {
  run = (await reconciler.reconcile(connection, request())).result.run;
  const takeover = { kind: 'takeover' as const, fence: { ...fence(), now: 130 }, receiptId: 'takeover', owner: 'replacement', leaseExpiresAt: 300 };
  const first = await reconciler.reconcile(connection, takeover); run = first.result.run;
  const stop = vi.fn(async () => { throw new Error('replacement must remain running'); });
  registration = { ...registration, binding: { ...registration.binding, generation: run.generation, owner: run.leaseOwner }, stopWorker: stop };
  connection = {}; install();
  const replay = await reconciler.reconcile(connection, { ...takeover, fence: { ...fence(), now: 130 } });
  expect(replay.exit).toBe('takeover'); expect(replay.result.changed).toBe(false); expect(replay.result.run).toEqual(run);
  expect(stop).not.toHaveBeenCalled();
  await expect(reconciler.reconcile(connection, { ...takeover, owner: 'forged', fence: { ...fence(), now: 130 } })).rejects.toThrow('DECISION_CONFLICT');
});
it('refuses old-generation release replay before stopping a replacement worker', async () => {
  registration.release = async () => { throw new Error('release failed'); }; install();
  run = (await reconciler.reconcile(connection, request())).result.run;
  registration.release = async (_result, reverify) => { await reverify(); }; install();
  await reconciler.reconcile(connection, { ...request(), fence: { ...fence(), now: 130 } });
  run = (await reconciler.reconcile(connection, { kind: 'takeover', fence: { ...fence(), now: 130 }, receiptId: 'takeover', owner: 'replacement', leaseExpiresAt: 300 })).result.run;
  const stop = vi.fn(async () => { throw new Error('replacement must remain running'); });
  registration = { ...registration, binding: { ...registration.binding, generation: run.generation, owner: run.leaseOwner }, stopWorker: stop };
  connection = {}; install();
  await expect(reconciler.reconcile(connection, { ...request(), fence: { ...fence(), now: 130 } })).rejects.toThrow('RECOVERY_GENERATION_CHANGED');
  expect(stop).not.toHaveBeenCalled();
});
it('blocks takeover and terminal sealing until durable resource release completes after restart', async () => {
  registration.release = async () => { throw new Error('release failed'); }; install();
  run = (await reconciler.reconcile(connection, request())).result.run;
  const currentFence = { ...fence(), now: 130 };
  await expect(reconciler.reconcile(connection, { kind: 'takeover', fence: currentFence, receiptId: 'premature', owner: 'next', leaseExpiresAt: 300 })).rejects.toThrow('ADMISSION_RELEASE_PENDING');
  expect(() => runs.project({ ...currentFence, status: 'failed' })).toThrow('ADMISSION_RELEASE_PENDING');
  db.close(); db = openDb({ path: join(dir, 'state.db') }); runs = new GraphRunStore(db);
  registration.release = async (_result, reverify) => { await reverify(); }; install();
  expect((await reconciler.reconcile(connection, { ...request(), fence: currentFence })).exit).toBe('applied');
  expect(runs.project({ ...currentFence, status: 'ready' }).status).toBe('ready');
});

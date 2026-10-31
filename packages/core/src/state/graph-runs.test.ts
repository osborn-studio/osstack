import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type Database from "better-sqlite3";
import type { StartGraphRequest } from "@osstack/protocol";
import { openDb } from "./db.js";
import { GraphActionStore } from "./graph-actions.js";
import { GraphRunStore, type GraphProgramVersion, type GraphRun } from "./graph-runs.js";

const scope = { schemaVersion: 1 as const, tenantId: "tenant", principalId: "principal", workspaceId: "workspace" };
const request: StartGraphRequest = {
  schemaVersion: 1, kind: "start", scope, idempotencyKey: "key", inputArtifactRef: "input",
  source: { product: "osstack", requestId: "request", parentRunId: "parent" },
  spec: { schemaVersion: 1, template: "code-delivery-v1", publication: "artifact_only",
    input: { taskRef: "task", repositoryRef: "repo", baseRevision: "a".repeat(40), acceptanceRef: "acceptance" },
    limits: { maxEpochs: 1, maxBranchAttempts: 1, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 10, deadlineSeconds: 60, tokenReservationLimit: 100 } },
};
const program: GraphProgramVersion = {
  executionModel: "langgraph-functional-v1", durability: "sync", engineVersion: "1.4.15", checkpointVersion: "1.1.5",
  templateVersion: "1", registryVersion: "1", compilerVersion: "1", schemaVersion: "1", compiledProgramDigest: "b".repeat(64),
};
let dir: string;
let db: Database.Database;
let other: Database.Database;
let store: GraphRunStore;
let second: GraphRunStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "graph-runs-"));
  db = openDb({ path: join(dir, "state.db") });
  other = openDb({ path: join(dir, "state.db") });
  store = new GraphRunStore(db);
  second = new GraphRunStore(other);
});
afterEach(() => { if (db.open) db.close(); if (other.open) other.close(); rmSync(dir, { recursive: true, force: true }); });
const fence = (run: GraphRun, now = 110) => ({ scope, graphRunId: run.graphRunId, expectedGeneration: run.generation, expectedRevision: run.revision, expectedOwner: run.leaseOwner, identity: run.identity, now });
const claim = (run: GraphRun) => store.acquireLease({ ...fence(run), owner: "worker-1", leaseExpiresAt: 200 });
const stopped = (run: GraphRun) => ({ graphRunId: run.graphRunId, generation: run.generation, owner: run.leaseOwner!, confirmedAt: 190, evidenceRef: "exit-receipt" });

describe("graph run storage", () => {
  it("persists preworker/expired cancellation without granting unfenced execution", () => {
    const queued = store.create(request, program, 100);
    expect(() => store.project({ ...fence(queued), status: 'running' })).toThrow('LEASE_EXPIRED');
    const cancel = { schemaVersion: 1 as const, kind: 'cancel' as const, scope, idempotencyKey: 'cancel', graphRunId: queued.graphRunId, expectedRevision: queued.revision };
    const pending = store.projectRequest(cancel, { ...fence(queued), status: 'cancel_pending' });
    expect(second.get(scope, queued.graphRunId)?.status).toBe('cancel_pending');
    expect(store.project({ ...fence(pending), status: 'cancelled' }).status).toBe('cancelled');
    const leased = claim(store.create({ ...request, idempotencyKey: 'other' }, program, 100));
    const expired = store.project({ ...fence(leased, 201), status: 'cancel_pending' });
    expect(expired.generation).toBe(1);
    expect(() => store.project({ ...fence(expired, 202), status: 'cancelled' })).toThrow('LEASE_EXPIRED');
    expect(() => store.project({ ...fence(expired, 202), expectedOwner: 'impostor', status: 'cancel_pending' })).toThrow('OWNER_MISMATCH');
  });

  it("persists fresh identity, source and canonical idempotency through a real SQLite restart", () => {
    const run = store.create(request, program, 100);
    expect(run).toMatchObject({ generation: 0, revision: 0, leaseOwner: null, status: "queued", source: request.source });
    expect(run.identity).toMatchObject(program);
    expect(run.identity.specHash).toMatch(/^[a-f0-9]{64}$/);
    expect(run.identity.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(second.create({ ...request, metadata: { trace: { traceId: "different" } } }, program, 101)).toEqual(run);
    db.close();
    db = openDb({ path: join(dir, "state.db") });
    store = new GraphRunStore(db);
    expect(store.get(scope, run.graphRunId)).toEqual(run);
    expect(store.create({ ...request, idempotencyKey: "new-key" }, program, 102).graphRunId).not.toBe(run.graphRunId);
    expect(() => store.create({ ...request, inputArtifactRef: "changed" }, program, 102)).toThrow(/IDEMPOTENCY_CONFLICT/);
  });

  it("persists the original spec and limits without allowing refresh or caller mutation to reset them", () => {
    const original = store.create(request, program, 100);
    expect(original.spec).toEqual(request.spec);
    original.spec!.limits.tokenReservationLimit = 999;
    expect(store.get(scope, original.graphRunId)?.spec).toEqual(request.spec);
    const leased = claim(store.get(scope, original.graphRunId)!);
    expect(store.renewLease({ ...fence(leased, 120), leaseExpiresAt: 300 }).spec).toEqual(request.spec);
    expect(() => db.prepare("UPDATE graph_runs SET spec_json = ? WHERE graph_run_id = ?")
      .run(JSON.stringify(original.spec), original.graphRunId)).toThrow(/immutable/);
    expect(() => store.create({ ...request, spec: { ...request.spec, limits: { ...request.spec.limits, maxActionStarts: 100 } } }, program, 121))
      .toThrow(/IDEMPOTENCY_CONFLICT/);
  });

  it.each(["tenantId", "principalId", "workspaceId"] as const)("isolates requests and reads by %s", (field) => {
    const run = store.create(request, program, 100);
    const different = { ...scope, [field]: "other" };
    expect(store.get(different, run.graphRunId)).toBeNull();
    expect(second.create({ ...request, scope: different }, program, 100).graphRunId).not.toBe(run.graphRunId);
    expect(() => store.acquireLease({ ...fence(run), scope: different, owner: "w", leaseExpiresAt: 200 })).toThrow(/RUN_NOT_FOUND/);
  });

  it("serializes competing connection CAS and requires stopped-worker evidence even after expiry", () => {
    const run = store.create(request, program, 100);
    const leased = claim(run);
    expect(leased).toMatchObject({ generation: 1, revision: 1, leaseOwner: "worker-1", leaseExpiresAt: 200 });
    expect(() => second.acquireLease({ ...fence(run), owner: "loser", leaseExpiresAt: 210 })).toThrow(/CONFLICT|STALE_GENERATION/);
    expect(() => second.acquireLease({ ...fence(leased, 201), owner: "next", leaseExpiresAt: 300 })).toThrow(/STOPPED_WORKER_REQUIRED/);
    expect(() => store.project({ ...fence(leased, 200), status: "running" })).toThrow(/LEASE_EXPIRED/);
    expect(() => store.renewLease({ ...fence(leased, 201), leaseExpiresAt: 300 })).toThrow(/LEASE_EXPIRED/);
    expect(() => store.acquireLease({ ...fence(leased, 201), owner: "next", leaseExpiresAt: 300, stoppedWorker: { ...stopped(leased), generation: 0 } })).toThrow();
    const next = second.acquireLease({ ...fence(leased, 201), owner: "next", leaseExpiresAt: 300, stoppedWorker: stopped(leased) });
    expect(next).toMatchObject({ generation: 2, revision: 2, leaseOwner: "next" });
    expect(() => store.project({ ...fence(leased, 202), status: "ready" })).toThrow(/STALE_GENERATION/);
    expect(other.prepare("SELECT stopped_worker_json FROM graph_worker_leases WHERE graph_run_id = ? AND generation = 2").get(run.graphRunId)).toEqual({ stopped_worker_json: JSON.stringify(stopped(leased)) });
  });

  it("atomically deduplicates resume/cancel projection requests in the same scope/key namespace", () => {
    const run = claim(store.create(request, program, 100));
    const cancel = { schemaVersion: 1 as const, kind: "cancel" as const, scope, idempotencyKey: "cancel-key", graphRunId: run.graphRunId, expectedRevision: run.revision };
    const pending = store.projectRequest(cancel, { ...fence(run, 120), status: "cancel_pending" });
    expect(pending.revision).toBe(run.revision + 1);
    expect(second.projectRequest(cancel, { ...fence(run, 121), status: "cancel_pending" })).toEqual(pending);
    expect(() => second.projectRequest({ ...cancel, expectedRevision: 2 }, { ...fence(pending, 122), status: "cancel_pending" })).toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(() => store.projectRequest({ ...cancel, idempotencyKey: request.idempotencyKey }, { ...fence(pending, 122), status: "cancel_pending" })).toThrow(/IDEMPOTENCY_CONFLICT/);
    const cancelledResume = { schemaVersion: 1 as const, kind: "resume" as const, scope, idempotencyKey: "rejected-resume", graphRunId: run.graphRunId, expectedRevision: pending.revision, interruptId: "interrupt", input: { kind: "data" as const, value: false } };
    expect(() => store.projectRequest(cancelledResume, { ...fence(pending, 130), status: "running" })).toThrow('CANCEL_PENDING');
    expect(db.prepare("SELECT count(*) AS n FROM graph_requests").get()).toEqual({ n: 2 });
    const waiting = store.project({ ...fence(claim(store.create({ ...request, idempotencyKey: 'waiting-run' }, program, 100)), 120), status: 'waiting_input' });
    const resume = { ...cancelledResume, idempotencyKey: 'resume-key', graphRunId: waiting.graphRunId, expectedRevision: waiting.revision };
    const resumed = store.projectRequest(resume, { ...fence(waiting, 130), status: "running" });
    expect(resumed.revision).toBe(waiting.revision + 1);
    expect(second.projectRequest(resume, { ...fence(waiting, 131), status: 'running' })).toEqual(resumed);
    expect(() => store.projectRequest({ ...resume, input: { kind: "data", value: true } }, { ...fence(resumed, 131), status: "running" })).toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(db.prepare("SELECT count(*) AS n FROM graph_requests").get()).toEqual({ n: 4 });
    expect(store.get(scope, waiting.graphRunId)).toEqual(resumed);
    expect(store.get(scope, run.graphRunId)).toEqual(pending);
  });

  it("renews with CAS and persists only a status projection; terminal runs cannot resurrect", () => {
    const leased = claim(store.create(request, program, 100));
    const renewed = store.renewLease({ ...fence(leased, 120), leaseExpiresAt: 250 });
    expect(renewed.revision).toBe(2);
    expect(() => second.project({ ...fence(leased, 121), status: "running" })).toThrow(/REVISION_CONFLICT/);
    const done = store.project({ ...fence(renewed, 130), status: "ready" });
    expect(() => store.project({ ...fence(done, 140), status: "running" })).toThrow(/TERMINAL_RUN/);
    expect(() => store.acquireLease({ ...fence(done, 300), owner: "next", leaseExpiresAt: 400, stoppedWorker: { ...stopped(done), confirmedAt: 290 } })).toThrow(/TERMINAL_RUN/);
    expect(store.create(request, program, 301)).toEqual(done);
  });

  it.each(Object.keys(program) as (keyof GraphProgramVersion)[])("rejects identity change to %s at creation and recovery", (key) => {
    const run = claim(store.create(request, program, 100));
    const changed = key === "compiledProgramDigest" ? "c".repeat(64) : "changed";
    expect(() => store.create(request, { ...program, [key]: changed }, 120)).toThrow();
    expect(() => store.acquireLease({ ...fence(run, 201), identity: { ...run.identity, [key]: changed }, owner: "next", leaseExpiresAt: 300, stoppedWorker: stopped(run) })).toThrow();
    expect(store.get(scope, run.graphRunId)).toEqual(run);
  });
  it.each(["specHash", "inputDigest"] as const)("rejects recovery with a different %s", (key) => {
    const run = claim(store.create(request, program, 100));
    expect(() => store.project({ ...fence(run), identity: { ...run.identity, [key]: "c".repeat(64) }, status: "running" })).toThrow(/PROGRAM_IDENTITY_MISMATCH/);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid counters and timestamps: %s", (bad) => {
    expect(() => store.create(request, program, bad)).toThrow();
    const run = store.create(request, program, 100);
    expect(() => store.acquireLease({ ...fence(run), expectedGeneration: bad, owner: "w", leaseExpiresAt: 200 })).toThrow();
    expect(() => store.acquireLease({ ...fence(run), expectedRevision: bad, owner: "w", leaseExpiresAt: 200 })).toThrow();
    expect(() => store.acquireLease({ ...fence(run), owner: "w", leaseExpiresAt: bad })).toThrow();
  });

  it("rejects oversized/non-JSON arguments, invalid owner, backward clock and counter overflow", () => {
    expect(() => store.create({ ...request, idempotencyKey: "x".repeat(300) }, program, 100)).toThrow();
    expect(() => store.create(request, { ...program, engineVersion: "x".repeat(300) }, 100)).toThrow();
    const run = claim(store.create(request, program, 100));
    expect(() => store.project({ ...fence(run, 99), status: "running" })).toThrow();
    expect(() => store.renewLease({ ...fence(run), expectedOwner: "wrong", leaseExpiresAt: 250 })).toThrow(/OWNER_MISMATCH/);
    expect(() => store.renewLease({ ...fence(run), leaseExpiresAt: 110 })).toThrow();
    db.prepare("UPDATE graph_runs SET revision = ? WHERE graph_run_id = ?").run(Number.MAX_SAFE_INTEGER, run.graphRunId);
    expect(() => store.project({ ...fence(run), expectedRevision: Number.MAX_SAFE_INTEGER, status: "ready" })).toThrow(/COUNTER_EXHAUSTED/);
  });

  it("rejects a stop receipt predating the last worker mutation and rolls back both tables on failure", () => {
    const leased = claim(store.create(request, program, 100));
    const renewed = store.renewLease({ ...fence(leased, 195), leaseExpiresAt: 250 });
    const rows = () => db.prepare("SELECT * FROM graph_worker_leases").all();
    const history = rows();
    expect(() => store.acquireLease({ ...fence(renewed, 251), owner: "next", leaseExpiresAt: 300, stoppedWorker: stopped(renewed) })).toThrow(/STOPPED_WORKER_MISMATCH/);
    expect(store.get(scope, renewed.graphRunId)).toEqual(renewed);
    expect(rows()).toEqual(history);
    // Force failure AFTER the CAS UPDATE, proving the surrounding transaction rolls back.
    db.exec("CREATE TRIGGER reject_test_lease BEFORE INSERT ON graph_worker_leases BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END");
    expect(() => store.acquireLease({ ...fence(renewed, 251), owner: "next", leaseExpiresAt: 300, stoppedWorker: { ...stopped(renewed), confirmedAt: 250 } })).toThrow(/injected storage failure/);
    expect(store.get(scope, renewed.graphRunId)).toEqual(renewed);
    expect(rows()).toEqual(history);
  });

  it("never wraps generation at the safe integer boundary", () => {
    const run = claim(store.create(request, program, 100));
    db.prepare("UPDATE graph_runs SET generation = ? WHERE graph_run_id = ?").run(Number.MAX_SAFE_INTEGER, run.graphRunId);
    const max = store.get(scope, run.graphRunId)!;
    expect(() => store.acquireLease({ ...fence(max, 201), owner: "next", leaseExpiresAt: 300, stoppedWorker: stopped(max) })).toThrow(/COUNTER_EXHAUSTED/);
    expect(store.get(scope, run.graphRunId)).toEqual(max);
  });

  it("protects immutable identity in SQLite itself", () => {
    const run = store.create(request, program, 100);
    expect(() => db.prepare("UPDATE graph_runs SET identity_json = '{}' WHERE graph_run_id = ?").run(run.graphRunId)).toThrow(/immutable/);
  });

  it.each(["same-request", "conflicting-request", "lease-cas"] as const)("serializes independent SQLite workers: %s", async (mode) => {
    // Transpile the three storage files with the workspace's existing compiler.
    const ts = await import("typescript");
    const { symlinkSync, readFileSync, writeFileSync } = await import("node:fs");
    for (const name of ["graph-runs", "db", "migrations", "follow-up-obligations-ddl", "follow-up-delivery-ddl", "source-observations-ddl", "engineering-ddl", "attention-reminders-ddl", "attention-return-ddl"]) {
      writeFileSync(join(dir, `${name}.js`), ts.transpileModule(
        readFileSync(join(process.cwd(), `src/state/${name}.ts`), "utf8"),
        { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
      ).outputText);
    }
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    const bundle = join(dir, "graph-runs.js");
    symlinkSync(join(process.cwd(), "node_modules"), join(dir, "node_modules"), "dir");
    const initial = mode === "lease-cas" ? store.create(request, program, 100) : null;
    const shared = new SharedArrayBuffer(4);
    const workers: Worker[] = [];
    let ready = 0;
    const launch = (inputArtifactRef = "input") => new Promise<GraphRun | { error: string }>((resolve, reject) => {
      let result: GraphRun | { error: string } | undefined;
      const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads'); (async () => {
        const { GraphRunStore } = await import(workerData.bundle);
        const Database = (await import(workerData.sqlite)).default;
        const db = new Database(workerData.path); db.pragma('busy_timeout = 5000');
        try {
          parentPort.postMessage('ready');
          if (Atomics.wait(new Int32Array(workerData.shared), 0, 0, 5000) === 'timed-out') throw new Error('barrier timeout');
          const store = new GraphRunStore(db);
          try {
            parentPort.postMessage(workerData.acquisition ? store.acquireLease(workerData.acquisition)
              : store.create(workerData.request, workerData.program, 100));
          } catch (error) {
            if (error.name !== 'GraphRunStorageError') throw error;
            parentPort.postMessage({ error: error.code });
          }
        } finally { db.close(); }
      })().catch(e => { throw e; });`, { eval: true, workerData: { bundle, sqlite: createRequire(import.meta.url).resolve("better-sqlite3"), path: join(dir, "state.db"), shared, request: { ...request, inputArtifactRef }, program, acquisition: initial ? { ...fence(initial), owner: "worker", leaseExpiresAt: 200 } : null } });
      workers.push(worker);
      const timer = setTimeout(() => reject(new Error("worker lifecycle timeout")), 8000);
      worker.on("message", (message) => {
        if (message === "ready") {
          if (++ready === 2) { Atomics.store(new Int32Array(shared), 0, 1); Atomics.notify(new Int32Array(shared), 0); }
        } else result = message as GraphRun | { error: string };
      });
      worker.on("error", reject);
      worker.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0 && result) resolve(result);
        else reject(new Error(`worker exited ${code} without successful result`));
      });
    });
    try {
      const results = await Promise.all([launch(), launch(mode === "conflicting-request" ? "different" : "input")]);
      if (mode === "same-request") expect(results[0]).toEqual(results[1]);
      else {
        expect(results.filter((r) => !("error" in r))).toHaveLength(1);
        expect(results.filter((r) => "error" in r)).toEqual([{ error: mode === "lease-cas" ? "STALE_GENERATION" : "IDEMPOTENCY_CONFLICT" }]);
      }
      if (mode === "lease-cas") {
        expect(db.prepare("SELECT generation, revision FROM graph_runs").get()).toEqual({ generation: 1, revision: 1 });
        expect(db.prepare("SELECT count(*) AS n FROM graph_worker_leases").get()).toEqual({ n: 1 });
      }
      expect(db.prepare("SELECT count(*) AS n FROM graph_requests").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT count(*) AS n FROM graph_runs").get()).toEqual({ n: 1 });
    } finally { await Promise.all(workers.map((worker) => worker.terminate())); }

  }, 12_000);
});

it.each(['ready', 'failed', 'cancelled'] as const)('refuses sealing %s while an external action is unresolved', (status) => {
  let run = claim(store.create(request, program, 100));
  run = new GraphActionStore(db).reserve(fence(run), { epoch: 0, nodeId: 'implement', effectSlot: 'invoke',
    reservationTokens: 1, action: { kind: 'implement', inputArtifactRef: 'input', workspaceLeaseRef: 'workspace' } }).run;
  expect(() => store.project({ ...fence(run), status })).toThrow('UNRESOLVED_ACTION');
  expect(store.get(scope, run.graphRunId)?.status).toBe('queued');
});

it.each(['running', 'waiting_input', 'queued', 'ready', 'failed'] as const)('does not clear pending cancellation through ordinary %s projection', (status) => {
  const run = store.project({ ...fence(claim(store.create(request, program, 100))), status: 'cancel_pending' });
  expect(() => store.project({ ...fence(run), status })).toThrow('CANCEL_PENDING');
  expect(store.get(scope, run.graphRunId)?.status).toBe('cancel_pending');
  expect(store.project({ ...fence(run), status: 'cancelled' }).status).toBe('cancelled');
});

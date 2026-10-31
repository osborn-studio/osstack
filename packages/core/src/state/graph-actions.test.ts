import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type Database from "better-sqlite3";
import { computeGraphEffectKey, type StartGraphRequest } from "@osstack/protocol";
import { openDb } from "./db.js";
import { MIGRATIONS } from "./migrations.js";
import { GraphRunStore, type GraphProgramVersion, type GraphRun } from "./graph-runs.js";
import { GraphActionStore, type GraphActionAdmission } from "./graph-actions.js";

const scope = { schemaVersion: 1 as const, tenantId: "tenant", principalId: "principal", workspaceId: "workspace" };
const request: StartGraphRequest = {
  schemaVersion: 1, kind: "start", scope, idempotencyKey: "key", inputArtifactRef: "input",
  source: { product: "osstack", requestId: "request", parentRunId: "parent" },
  spec: { schemaVersion: 1, template: "code-delivery-v1", publication: "artifact_only",
    input: { taskRef: "task", repositoryRef: "repo", baseRevision: "a".repeat(40), acceptanceRef: "acceptance" },
    limits: { maxEpochs: 2, maxBranchAttempts: 2, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1,
      maxActionStarts: 4, deadlineSeconds: 60, tokenReservationLimit: 100 } },
};
const program: GraphProgramVersion = {
  executionModel: "langgraph-functional-v1", durability: "sync", engineVersion: "1.4.15", checkpointVersion: "1.1.5",
  templateVersion: "1", registryVersion: "1", compilerVersion: "1", schemaVersion: "1", compiledProgramDigest: "b".repeat(64),
};
const admission: GraphActionAdmission = { epoch: 0, nodeId: "review", effectSlot: "invoke", reservationTokens: 40,
  action: { kind: "workspace_create", repositoryRef: "repo", baseRevision: "a".repeat(40) } };
const confirmed = { state: "confirmed" as const, evidenceRef: "receipt", actualTokens: 20,
  result: { schemaVersion: 1 as const, kind: "workspace" as const, workspaceLeaseRef: "lease", receiptRef: "workspace-receipt" } };
const failed = { state: "failed" as const, evidenceRef: "safe-failure-receipt", actualTokens: 10, error: { message: "not applied" }, retrySafe: true };
let dir: string;
let db: Database.Database;
let other: Database.Database;
let runs: GraphRunStore;
let actions: GraphActionStore;
let run: GraphRun;
const fence = (value = run, now = 110) => ({ scope, graphRunId: value.graphRunId, expectedGeneration: value.generation,
  expectedRevision: value.revision, expectedOwner: value.leaseOwner, identity: value.identity, now });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "graph-actions-"));
  db = openDb({ path: join(dir, "state.db") });
  other = openDb({ path: join(dir, "state.db") });
  runs = new GraphRunStore(db); actions = new GraphActionStore(db);
  const initial = runs.create(request, program, 100);
  run = runs.acquireLease({ ...fence(initial), owner: "worker", leaseExpiresAt: 100_000 });
});
afterEach(() => { if (db.open) db.close(); if (other.open) other.close(); rmSync(dir, { recursive: true, force: true }); });
function reserve(input = admission) { const result = actions.reserve(fence(), input); run = result.run; return result; }
function start(key: string) { const result = actions.markRunning(fence(), key, "execution"); run = result.run; return result; }
function settle(key: string, outcome = confirmed) { const result = actions.recordOutcome(fence(), key, outcome); run = result.run; return result; }

describe("graph action ledger", () => {
  it("persists intent before invocation, pins the protocol key and replays original evidence after a file restart", () => {
    const intent = reserve();
    expect(intent.created).toBe(true);
    expect(intent.action.state).toBe("intent");
    expect(intent.action.effect).toMatchObject({ logicalAttempt: 1, specHash: run.identity.specHash, scope });
    expect(intent.action.effectKey).toBe(computeGraphEffectKey(intent.action.effect));
    expect(run.revision).toBe(2);
    expect(reserve().created).toBe(false);
    expect(start(intent.action.effectKey).changed).toBe(true);
    expect(start(intent.action.effectKey).changed).toBe(false);
    const done = settle(intent.action.effectKey);
    db.close(); db = openDb({ path: join(dir, "state.db") }); actions = new GraphActionStore(db);
    const replay = reserve();
    expect(replay.action).toEqual(done.action);
    expect(replay.budget).toMatchObject({ actionStarts: 1, reservedTokens: "0", chargedTokens: "20" });
    expect(() => actions.recordOutcome(fence(), intent.action.effectKey, { ...confirmed, evidenceRef: "replacement" })).toThrow(/OUTCOME_CONFLICT/);
  });

  it("binds canonical action business data and reservation cap, rejects worker retry/key fields", () => {
    const first = reserve();
    expect(() => reserve({ ...admission, action: { ...admission.action, repositoryRef: "changed" } } as GraphActionAdmission)).toThrow(/ACTION_INPUT_CONFLICT/);
    expect(() => reserve({ ...admission, reservationTokens: 41 })).toThrow(/ACTION_INPUT_CONFLICT/);
    expect(() => reserve({ ...admission, logicalAttempt: 2 } as GraphActionAdmission)).toThrow();
    expect(() => reserve({ ...admission, retry: true } as GraphActionAdmission)).toThrow();
    expect(reserve().action.effectKey).toBe(first.action.effectKey);
  });

  it.each(["intent", "running", "unknown", "cancel_pending"] as const)("cannot retry or bypass %s with a takeover", (state) => {
    const item = reserve(); const key = item.action.effectKey;
    if (state !== "intent") start(key);
    if (state === "unknown" || state === "cancel_pending") run = actions.markUncertain(fence(), key, { state, evidenceRef: "uncertain", observedTokens: 0 }).run;
    expect(() => actions.retry(fence(), key)).toThrow(/RETRY_NOT_SAFE/);
    const prior = run;
    run = runs.acquireLease({ ...fence(run, 120), owner: "next", leaseExpiresAt: 200_000,
      stoppedWorker: { graphRunId: run.graphRunId, generation: run.generation, owner: run.leaseOwner!, confirmedAt: 120, evidenceRef: "host-exit" } });
    expect(() => actions.reserve(fence(prior, 121), admission)).toThrow(/STALE_GENERATION/);
    expect(actions.reserve(fence(run, 121), admission).action.effectKey).toBe(key);
    expect(() => actions.markRunning(fence(run, 121), key, "new-execution")).toThrow(/ACTION_GENERATION_MISMATCH/);
    expect(() => actions.recordOutcome(fence(run, 121), key, failed)).toThrow(/ACTION_GENERATION_MISMATCH/);
  });

  it("fences confirmed cache hits by scope, program, owner, generation, revision and live lease", () => {
    const key = reserve().action.effectKey; start(key); settle(key);
    const f = fence();
    for (const [patch, error] of [
      [{ scope: { ...scope, principalId: "other" } }, "RUN_NOT_FOUND"],
      [{ identity: { ...run.identity, compilerVersion: "other" } }, "PROGRAM_IDENTITY_MISMATCH"],
      [{ expectedOwner: "other" }, "OWNER_MISMATCH"], [{ expectedGeneration: 0 }, "STALE_GENERATION"],
      [{ expectedRevision: 1 }, "REVISION_CONFLICT"], [{ now: 100_000 }, "LEASE_EXPIRED"],
    ] as const) expect(() => actions.reserve({ ...f, ...patch }, admission)).toThrow(error);
    const old = run;
    run = runs.acquireLease({ ...fence(run, 120), owner: "next", leaseExpiresAt: 200_000,
      stoppedWorker: { graphRunId: run.graphRunId, generation: run.generation, owner: run.leaseOwner!, confirmedAt: 120, evidenceRef: "exit" } });
    expect(() => actions.reserve(fence(old, 121), admission)).toThrow(/STALE_GENERATION/);
    expect(actions.reserve(fence(run, 121), admission).action.effectKey).toBe(key);
  });

  it("unknown blocks all new actions, retains reservations and cannot be released by outcome claims; confirmed replay still works", () => {
    const done = reserve().action.effectKey; start(done); settle(done);
    const key = reserve({ ...admission, nodeId: "tests" }).action.effectKey; start(key);
    run = actions.markUncertain(fence(), key, { state: "unknown", evidenceRef: "lost", observedTokens: 45 }).run;
    expect(() => reserve({ ...admission, nodeId: "repair" })).toThrow(/UNRESOLVED_ACTION/);
    expect(() => actions.recordOutcome(fence(), key, failed)).toThrow(/UNRESOLVED_ACTION/);
    expect(() => settle(key)).toThrow(/UNRESOLVED_ACTION/);
    expect(reserve().budget).toMatchObject({ actionStarts: 2, reservedTokens: "45", chargedTokens: "20" });
  });

  it("only explicit safe retry allocates an attempt, pins payload and shares retry budget across branch slots", () => {
    const key = reserve().action.effectKey; start(key);
    run = actions.recordOutcome(fence(), key, failed).run;
    expect(reserve().action.state).toBe("failed");
    const retry = actions.retry(fence(), key); run = retry.run;
    expect(retry.action.effect.logicalAttempt).toBe(2);
    expect(retry.action.effectKey).not.toBe(key);
    expect(retry.action.action).toEqual(admission.action);
    expect(retry.budget).toMatchObject({ actionStarts: 2, chargedTokens: "40", reservedTokens: "40" });
    expect(() => actions.retry(fence(), key)).toThrow(/NOT_CURRENT_ATTEMPT/);
    start(retry.action.effectKey); run = actions.recordOutcome(fence(), retry.action.effectKey, failed).run;
    expect(() => actions.retry(fence(), retry.action.effectKey)).toThrow(/BRANCH_BUDGET_EXHAUSTED/);
  });

  it("rolls back ledger, reservation, outcome and revision together on injected SQL failure", () => {
    db.exec("CREATE TRIGGER fail_revision BEFORE UPDATE OF revision ON graph_runs BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    expect(() => reserve()).toThrow(/injected/);
    expect(db.prepare("SELECT count(*) AS n FROM graph_actions").get()).toEqual({ n: 0 });
    expect(runs.get(scope, run.graphRunId)).toEqual(run);
    db.exec("DROP TRIGGER fail_revision");
    const key = reserve().action.effectKey; start(key); const before = run;
    db.exec("CREATE TRIGGER fail_revision BEFORE UPDATE OF revision ON graph_runs BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    expect(() => settle(key)).toThrow(/injected/);
    expect(reserve().action.state).toBe("running");
    expect(reserve().budget).toMatchObject({ reservedTokens: "40", chargedTokens: "0" });
    expect(runs.get(scope, run.graphRunId)).toEqual(before);
  });

  it("enforces original epoch, wall clock, token and action ceilings across branches and lease refresh", () => {
    expect(() => reserve({ ...admission, epoch: 2 })).toThrow(/EPOCH_BUDGET_EXHAUSTED/);
    expect(() => reserve({ ...admission, reservationTokens: 101 })).toThrow(/TOKEN_BUDGET_EXHAUSTED/);
    const key = reserve().action.effectKey; start(key); settle(key);
    run = runs.renewLease({ ...fence(run, 60_100), leaseExpiresAt: 200_000 });
    expect(actions.reserve(fence(run, 60_100), admission).action.state).toBe("confirmed");
    expect(() => actions.reserve(fence(run, 60_100), { ...admission, epoch: 1 })).toThrow(/WALL_CLOCK_BUDGET_EXHAUSTED/);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])("rejects invalid reservation %s without allocating", (reservationTokens) => {
    expect(() => reserve({ ...admission, reservationTokens })).toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM graph_actions").get()).toEqual({ n: 0 });
  });

  it.each([101, Number.MAX_SAFE_INTEGER, -1, NaN])("preserves confirmed effects despite accounting overrun/invalid usage %s", (actualTokens) => {
    const key = reserve().action.effectKey; start(key);
    const result = settle(key, { ...confirmed, actualTokens });
    expect(result.action.state).toBe("confirmed");
    expect(result.budget.accountingBlocked).toBe(true);
    expect(reserve().action.outcome).toEqual(result.action.outcome);
    expect(() => reserve({ ...admission, nodeId: "other" })).toThrow(/ACCOUNTING_BLOCKED/);
  });

  it("shares branch retry allowance across slots, while another epoch has its own bounded allowance", () => {
    const first = reserve({ ...admission, reservationTokens: 0 }).action.effectKey;
    run = actions.recordOutcome(fence(), first, { ...failed, actualTokens: 0 }).run;
    const retry = actions.retry(fence(), first); run = retry.run;
    run = actions.recordOutcome(fence(), retry.action.effectKey, { ...failed, actualTokens: 0 }).run;
    const slot = reserve({ ...admission, effectSlot: "format", reservationTokens: 0 }).action.effectKey;
    run = actions.recordOutcome(fence(), slot, { ...failed, actualTokens: 0 }).run;
    expect(() => actions.retry(fence(), slot)).toThrow(/BRANCH_BUDGET_EXHAUSTED/);
    const epoch = reserve({ ...admission, epoch: 1, reservationTokens: 0 });
    expect(epoch.action.effect.logicalAttempt).toBe(1);
    expect(epoch.budget.actionStarts).toBe(4);
    expect(() => reserve({ ...admission, nodeId: "new", reservationTokens: 0 })).toThrow(/ACTION_BUDGET_EXHAUSTED/);
  });

  it("retains unknown reservations through SQLite restart and rejects unrelated admission after takeover", () => {
    const key = reserve().action.effectKey; start(key);
    run = actions.markUncertain(fence(), key, { state: "unknown", evidenceRef: "lost", observedTokens: 1 }).run;
    db.close(); db = openDb({ path: join(dir, "state.db") }); actions = new GraphActionStore(db); runs = new GraphRunStore(db);
    expect(actions.get(fence(), key).budget.reservedTokens).toBe("40");
    run = runs.acquireLease({ ...fence(run, 120), owner: "next", leaseExpiresAt: 200_000,
      stoppedWorker: { graphRunId: run.graphRunId, generation: run.generation, owner: run.leaseOwner!, confirmedAt: 120, evidenceRef: "exit" } });
    expect(actions.reserve(fence(run, 121), admission).action.effectKey).toBe(key);
    expect(() => actions.reserve(fence(run, 121), { ...admission, epoch: 1 })).toThrow(/UNRESOLVED_ACTION/);
    expect(actions.get(fence(run, 121), key).budget.reservedTokens).toBe("40");
  });

  it("database constraints protect immutable key/cap/evidence and reject unsafe counters", () => {
    const key = reserve().action.effectKey;
    expect(() => db.prepare("UPDATE graph_actions SET reservation_tokens = 1 WHERE effect_key = ?").run(key)).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE graph_actions SET effect_json = '{}' WHERE effect_key = ?").run(key)).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE graph_actions SET observed_tokens = -1 WHERE effect_key = ?").run(key)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE graph_actions SET observed_tokens = 9007199254740992 WHERE effect_key = ?").run(key)).toThrow(/CHECK/);
    start(key); settle(key);
    expect(() => db.prepare("UPDATE graph_actions SET outcome_json = '{}' WHERE effect_key = ?").run(key)).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM graph_actions WHERE effect_key = ?").run(key)).toThrow(/immutable/);
  });

  it("rejects a different run's effect and refuses nested transactions before storage can write", () => {
    const key = reserve().action.effectKey;
    const fresh = runs.create({ ...request, idempotencyKey: "other" }, program, 100);
    const leased = runs.acquireLease({ ...fence(fresh), owner: "worker", leaseExpiresAt: 1000 });
    expect(() => actions.get(fence(leased), key)).toThrow(/ACTION_NOT_FOUND/);
    expect(() => db.transaction(() => actions.reserve(fence(), { ...admission, nodeId: "other" }))()).toThrow(/own BEGIN IMMEDIATE/);
    expect(reserve().budget.actionStarts).toBe(1);
  });

  it("does not infer retry safety from an ordinary failure or worker-shaped proof", () => {
    const key = reserve().action.effectKey; start(key);
    run = actions.recordOutcome(fence(), key, { ...failed, retrySafe: false }).run;
    expect(() => actions.retry(fence(), key)).toThrow(/RETRY_NOT_SAFE/);
    expect(() => actions.recordOutcome(fence(), key, failed)).toThrow(/OUTCOME_CONFLICT/);
  });

  it("keeps exact totals beyond safe integer range when already-running effects overrun", () => {
    const first = reserve().action.effectKey; start(first);
    const second = reserve({ ...admission, nodeId: "tests" }).action.effectKey; start(second);
    settle(first, { ...confirmed, actualTokens: Number.MAX_SAFE_INTEGER });
    const done = settle(second, { ...confirmed, actualTokens: Number.MAX_SAFE_INTEGER });
    expect(done.budget.chargedTokens).toBe("18014398509481982");
    expect(done.budget.reservedTokens).toBe("0");
    expect(done.budget.accountingBlocked).toBe(true);
  });

  it("prevents a previously reserved action from starting after another action becomes unknown", () => {
    const first = reserve().action.effectKey;
    const second = reserve({ ...admission, nodeId: "tests" }).action.effectKey;
    start(first);
    run = actions.markUncertain(fence(), first, { state: "unknown", evidenceRef: "lost", observedTokens: 0 }).run;
    expect(() => start(second)).toThrow(/UNRESOLVED_ACTION/);
  });

  it("settles once after wall-clock expiry and retains the original reservation cap on replay", () => {
    const key = reserve().action.effectKey; start(key);
    const done = actions.recordOutcome(fence(run, 60_101), key, confirmed); run = done.run;
    const again = actions.recordOutcome(fence(run, 60_102), key, confirmed);
    expect(again.changed).toBe(false);
    expect(again.budget).toEqual(done.budget);
    expect(again.run.revision).toBe(run.revision);
  });

  it("fails closed for real populated migration-28 runs with no original budget", () => {
    const path = join(dir, "legacy.db");
    const Sqlite = createRequire(import.meta.url)("better-sqlite3") as typeof import("better-sqlite3");
    const old = new Sqlite(path);
    for (const migration of MIGRATIONS.filter((m) => m.id <= 28)) old.exec(migration.sql);
    const row = db.prepare("SELECT * FROM graph_runs WHERE graph_run_id = ?").get(run.graphRunId) as Record<string, unknown>;
    const columns = Object.keys(row).filter((key) => key !== "spec_json");
    old.prepare(`INSERT INTO graph_runs (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map((key) => row[key]));
    old.pragma("user_version = 28"); old.close();
    const upgraded = openDb({ path });
    try {
      const legacy = new GraphRunStore(upgraded).get(scope, run.graphRunId)!;
      expect(legacy.spec).toBeNull();
      expect(() => new GraphActionStore(upgraded).reserve(fence(legacy), admission)).toThrow(/ORIGINAL_BUDGET_MISSING/);
      expect(upgraded.prepare("SELECT count(*) AS n FROM graph_actions").get()).toEqual({ n: 0 });
    } finally { upgraded.close(); }
  });

  it.each(["same-key", "shared-budget", "action-budget"] as const)("serializes independent SQLite workers: %s", async (mode) => {
    if (mode === "action-budget") {
      for (let i = 0; i < 3; i++) reserve({ ...admission, nodeId: `existing-${i}`, reservationTokens: 0 });
    }
    const ts = await import("typescript");
    for (const name of ["graph-actions", "graph-apply", "graph-invocations", "graph-storage", "graph-runs", "db", "migrations", "follow-up-obligations-ddl", "follow-up-delivery-ddl", "source-observations-ddl", "engineering-ddl", "attention-reminders-ddl", "attention-return-ddl"]) {
      writeFileSync(join(dir, `${name}.js`), ts.transpileModule(readFileSync(join(process.cwd(), `src/state/${name}.ts`), "utf8"),
        { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
    }
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    symlinkSync(join(process.cwd(), "node_modules"), join(dir, "node_modules"), "dir");
    const barrier = new SharedArrayBuffer(4); let ready = 0; const workers: Worker[] = [];
    const launch = (index: number) => new Promise<{ key?: string; error?: string }>((resolve, reject) => {
      let result: { key?: string; error?: string } | undefined;
      const worker = new Worker(`const { parentPort, workerData: w } = require('node:worker_threads'); (async () => {
        const { GraphActionStore } = await import(w.module);
        const { GraphRunStore } = await import(w.runsModule);
        const Database = (await import(w.sqlite)).default;
        const db = new Database(w.path); db.pragma('busy_timeout = 5000'); db.pragma('foreign_keys = ON');
        try {
          parentPort.postMessage('ready');
          if (Atomics.wait(new Int32Array(w.barrier), 0, 0, 5000) === 'timed-out') throw new Error('barrier timeout');
          const store = new GraphActionStore(db);
          try {
            let value;
            try { value = store.reserve(w.fence, w.admission); }
            catch (e) {
              if (e.code !== 'REVISION_CONFLICT') throw e;
              const run = new GraphRunStore(db).get(w.fence.scope, w.fence.graphRunId);
              value = store.reserve({ ...w.fence, expectedRevision: run.revision }, w.admission);
            }
            parentPort.postMessage({ key: value.action.effectKey });
          } catch (e) { if (!e.code) throw e; parentPort.postMessage({ error: e.code }); }
        } finally { db.close(); }
      })().catch(e => { throw e; });`, { eval: true, workerData: {
        module: join(dir, "graph-actions.js"), runsModule: join(dir, "graph-runs.js"),
        sqlite: createRequire(import.meta.url).resolve("better-sqlite3"), path: join(dir, "state.db"), barrier, fence: fence(),
        admission: { ...admission, reservationTokens: mode === "action-budget" ? 0 : 60, nodeId: mode === "same-key" ? "review" : `node-${index}` },
      } });
      workers.push(worker);
      const timer = setTimeout(() => reject(new Error("worker lifecycle timeout")), 8000);
      worker.on("message", (message) => {
        if (message === "ready") { if (++ready === 2) { Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0); } }
        else result = message;
      });
      worker.on("error", reject);
      worker.on("exit", (code) => { clearTimeout(timer); if (code === 0 && result) resolve(result); else reject(new Error(`worker exit ${code}`)); });
    });
    try {
      const results = await Promise.all([launch(0), launch(1)]);
      if (mode === "same-key") expect(results[0]).toEqual(results[1]);
      else expect(results.filter((r) => r.error)).toEqual([{ error: mode === "action-budget" ? "ACTION_BUDGET_EXHAUSTED" : "TOKEN_BUDGET_EXHAUSTED" }]);
      expect(db.prepare("SELECT count(*) AS n FROM graph_actions").get()).toEqual({ n: mode === "action-budget" ? 4 : 1 });
      expect(runs.get(scope, run.graphRunId)?.revision).toBe(run.revision + 1);
    } finally { await Promise.all(workers.map((worker) => worker.terminate())); }
  }, 12_000);
});

it("atomically settles a host-proven unstarted action with a discharged obligation", () => {
  const intent = reserve(); const key = intent.action.effectKey;
  const result = actions.recordUnstartedOutcome(fence(), key, { ...failed, actualTokens: 0 });
  expect(result.action).toMatchObject({ state: 'failed', executionRef: null, actualTokens: 0 });
  expect(db.prepare('SELECT owner,held_at,released_at FROM graph_action_admissions WHERE effect_key=?').get(key))
    .toEqual({ owner: 'worker', held_at: 110, released_at: 110 });
});
it.each(['running', 'held', 'usage', 'confirmed'])("refuses %s as host-proven unstarted settlement", mode => {
  const intent = reserve(); const key = intent.action.effectKey;
  if (mode === 'running') start(key);
  if (mode === 'held') db.prepare('INSERT INTO graph_action_admissions VALUES(?,?,?,?,?,NULL)').run(key, run.graphRunId, run.generation, run.leaseOwner, 110);
  const before = db.prepare('SELECT * FROM graph_actions').all();
  expect(() => actions.recordUnstartedOutcome(fence(), key, mode === 'confirmed' ? { ...confirmed, actualTokens: 0 }
    : { ...failed, actualTokens: mode === 'usage' ? 1 : 0 })).toThrow('INVALID_ACTION_STATE');
  expect(db.prepare('SELECT * FROM graph_actions').all()).toEqual(before);
});
it("rolls back the failed outcome when writing its discharged obligation fails", () => {
  const key = reserve().action.effectKey;
  db.exec("CREATE TRIGGER fail_admission BEFORE INSERT ON graph_action_admissions BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END");
  expect(() => actions.recordUnstartedOutcome(fence(), key, { ...failed, actualTokens: 0 })).toThrow('fixture disk failure');
  expect(db.prepare('SELECT state,outcome_json FROM graph_actions').get()).toEqual({ state: 'intent', outcome_json: null });
});

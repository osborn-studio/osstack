import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { CapabilitySchema, GraphActionStore, GraphRunStore, openDb, type GraphRun } from "@osstack/core";
import { FifoSemaphore } from "@osstack/autonomy";
import type { AgentAdapter, AgentTask } from "@osstack/agents";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { ExecutionPlan } from "@osstack/loop";
import type { WorkerActionRequest } from "@osstack/protocol";
import { GraphActionBroker, type GraphWorkerRegistration } from "./graph-action-broker.js";
import { GovernedExecution } from "./governed-execution.js";
import { healthyAutonomyHealth } from "./test-healthy-autonomy.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const scope = { schemaVersion: 1 as const, tenantId: "tenant", principalId: "principal", workspaceId: "workspace" };
const fence = (run: GraphRun) => ({ scope, graphRunId: run.graphRunId, expectedGeneration: run.generation,
  expectedRevision: run.revision, expectedOwner: run.leaseOwner, identity: run.identity, now: Date.now() });
function done(task: AgentTask, status: "completed" | "failed" | "cancelled" | "expired" = "completed"): HermesEvent {
  return { event_id: "event", run_id: task.run_id, session_id: task.session_id, seq: 1, type: "done",
    created_at: 0, terminal: true, payload: { status, last_seq: 0 } };
}
function actor(invoke: AgentAdapter["invoke"]): AgentAdapter {
  return { id: "builder", display_name: "Builder", cost_tier: "low", invoke,
    capabilities: () => [CapabilitySchema.parse({ id: "builder.write", agent_id: "builder", kind: "code.write", description: "write" })],
    isAvailable: async () => ({ available: true, last_checked_at: 0 }),
    confirmStopped: async () => ({ stopped: true, evidence: "fixture owns no background effects" }) };
}
function fixture(adapter?: AgentAdapter) {
  const root = mkdtempSync(join(tmpdir(), "g12-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"); execFileSync("git", ["init", "-q", repo]);
  const db = openDb({ path: join(root, "state.db") }); cleanups.push(() => { if (db.open) db.close(); });
  const runs = new GraphRunStore(db);
  const created = runs.create({ schemaVersion: 1, kind: "start", scope, idempotencyKey: "start", inputArtifactRef: "input",
    source: { product: "osstack", requestId: "source" }, spec: { schemaVersion: 1, template: "code-delivery-v1", publication: "artifact_only",
      input: { taskRef: "task", repositoryRef: "repo", baseRevision: "a".repeat(40), acceptanceRef: "acceptance" },
      limits: { maxEpochs: 1, maxBranchAttempts: 2, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1,
        maxActionStarts: 10, deadlineSeconds: 300, tokenReservationLimit: 100 } } },
    { executionModel: "langgraph-functional-v1", durability: "sync", engineVersion: "1", checkpointVersion: "1",
      templateVersion: "1", registryVersion: "1", compilerVersion: "1", schemaVersion: "1", compiledProgramDigest: "b".repeat(64) }, Date.now());
  const run = runs.acquireLease({ ...fence(created), owner: "worker", leaseExpiresAt: Date.now() + 120_000 });
  const reads = new FifoSemaphore(2); const writes = new FifoSemaphore(1);
  const admission = new GovernedExecution({ reads, writes, repositories: new Map(), checkHealth: async () => {
    if (!healthyAutonomyHealth().can_run_local) throw new Error("unhealthy");
  } });
  let allowed = true;
  const registration: GraphWorkerRegistration = { scope, graphRunId: run.graphRunId, identity: run.identity,
    generation: run.generation, owner: "worker", epoch: 0, workspace: { workspace_id: "workspace", workspace_path: repo },
    authorize: () => { if (!allowed) throw new Error("revoked"); }, actions: [{ nodeId: "implement", effectSlot: "invocation",
      action: { kind: "implement", inputArtifactRef: "input", workspaceLeaseRef: "workspace" }, tokenReservation: 10,
      execution: { kind: adapter ? "adapter" : "command", plan: ExecutionPlan.parse({ plan_id: "plan", agent_id: adapter?.id ?? "local-command",
        task: { task_id: "task", capability: "code.write", prompt: "implement once", source: "manual" }, stop_condition: { type: "tests_pass" } }),
        ...(adapter ? { adapter, capabilityId: "builder.write" } : { command: "printf once >> output.txt" }) } as GraphWorkerRegistration["actions"][number]["execution"],
      persist: async () => ({ evidenceRef: "trusted-evidence", result: { schemaVersion: 1, kind: "implementation_complete", workspaceLeaseRef: "workspace", receiptRef: "trusted-receipt" } }) }] };
  const connection = {};
  let policyAllowed = true;
  const options = { acquire: admission.acquire.bind(admission), authorizePolicy: async () => { if (!policyAllowed) throw new Error("policy revoked"); } };
  const broker = new GraphActionBroker(db, options); broker.register(connection, registration);
  const request: WorkerActionRequest = { schemaVersion: 1, kind: "worker_action", requestId: "request", scope,
    graphRunId: run.graphRunId, specHash: run.identity.specHash, generation: run.generation, epoch: 0,
    nodeId: "implement", effectSlot: "invocation", action: { kind: "implement", inputArtifactRef: "input", workspaceLeaseRef: "workspace" } };
  return { root, repo, db, runs, run, reads, writes, admission, registration, connection, broker, request, options,
    revokePolicy: () => { policyAllowed = false; }, revoke: () => { allowed = false; } };
}

it('rejects a Promise-returning synchronous authorizer instead of silently granting authority', async () => {
  let invokes = 0;
  const f = fixture(actor(async function* (task) { invokes++; yield done(task); }));
  const connection = {};
  f.broker.register(connection, { ...f.registration, authorize: async () => {} });
  expect(await f.broker.handle(connection, f.request)).toMatchObject({ kind: 'worker_action_rejected' });
  expect(invokes).toBe(0); expect(f.writes.in_use).toBe(0);
});
it('rechecks repository policy after an asynchronous adapter availability probe', async () => {
  let invokes = 0; let available!: () => void; let probed = false;
  const adapter = actor(async function* (task) { invokes++; yield done(task); });
  adapter.isAvailable = async () => { probed = true; await new Promise<void>(resolve => { available = resolve; }); return { available: true, last_checked_at: 0 }; };
  const f = fixture(adapter);
  const response = f.broker.handle(f.connection, f.request);
  await expect.poll(() => probed).toBe(true);
  f.revokePolicy(); available();
  expect(await response).toMatchObject({ kind: 'worker_action_rejected' });
  expect(invokes).toBe(0); expect(f.writes.in_use).toBe(0);
});
it('charges observed adapter usage even when the persistence mapper reports less', async () => {
  const adapter = actor(async function* (task) {
    yield { ...done(task), terminal: false, type: 'usage.final', payload: { tokens_in: 150, tokens_out: 50 } } as HermesEvent;
    yield { ...done(task), seq: 2 };
  });
  const f = fixture(adapter); const connection = {};
  f.broker.register(connection, { ...f.registration, actions: f.registration.actions.map(a => ({ ...a, persist: async () => ({ evidenceRef: 'receipt', actualTokens: 0, result: { schemaVersion: 1 as const, kind: 'implementation_complete' as const, workspaceLeaseRef: 'workspace', receiptRef: 'receipt' } }) })) });
  expect(await f.broker.handle(connection, f.request)).toMatchObject({ outcome: { state: 'confirmed' } });
  const row = f.db.prepare('SELECT actual_tokens, accounting_blocked FROM graph_actions').get();
  expect(row).toEqual({ actual_tokens: 200, accounting_blocked: 1 });
});
it('combines independently reported cumulative input and output usage without lowering either component', async () => {
  const adapter = actor(async function* (task) {
    yield { ...done(task), terminal: false, type: 'usage.updated', payload: { tokens_in: 150 } } as HermesEvent;
    yield { ...done(task), seq: 2, terminal: false, type: 'usage.final', payload: { tokens_out: 50 } } as HermesEvent;
    yield { ...done(task), seq: 3 };
  });
  const f = fixture(adapter);
  expect(await f.broker.handle(f.connection, f.request)).toMatchObject({ outcome: { state: 'confirmed' } });
  expect(f.db.prepare('SELECT actual_tokens, accounting_blocked FROM graph_actions').get()).toEqual({ actual_tokens: 200, accounting_blocked: 1 });
});
it('marks only a proven pre-invocation policy failure safe for a future explicit host retry', async () => {
  const f = fixture(); f.revokePolicy();
  expect(await f.broker.handle(f.connection, f.request)).toMatchObject({ kind: 'worker_action_rejected' });
  expect(f.db.prepare('SELECT state, retry_safe FROM graph_actions').get()).toEqual({ state: 'failed', retry_safe: 1 });
});
it('retains a saved evidence reference and known usage when result validation fails', async () => {
  const f = fixture(actor(async function* (task) { yield done(task); })); const connection = {};
  f.broker.register(connection, { ...f.registration, actions: f.registration.actions.map(a => ({ ...a, persist: async () => ({ evidenceRef: 'durable-invalid-result', actualTokens: 150, result: { schemaVersion: 1 as const, kind: 'workspace' as const, workspaceLeaseRef: 'workspace', receiptRef: 'saved' } }) })) });
  expect(await f.broker.handle(connection, f.request)).toMatchObject({ outcome: { state: 'unknown' } });
  const row = f.db.prepare('SELECT observed_tokens, uncertainty_json FROM graph_actions').get() as { observed_tokens: number; uncertainty_json: string };
  expect(row.observed_tokens).toBe(150);
  expect(JSON.parse(row.uncertainty_json)).toMatchObject({ evidenceRef: 'durable-invalid-result' });
  expect(f.writes.in_use).toBe(1);
});

it('does not let malformed persistence references prevent durable uncertainty recording', async () => {
  const f = fixture(actor(async function* (task) { yield done(task); })); const connection = {};
  f.broker.register(connection, { ...f.registration, actions: f.registration.actions.map(a => ({ ...a, persist: async () => ({ evidenceRef: 'invalid\u0000reference' }) })) });
  expect(await f.broker.handle(connection, f.request)).toMatchObject({ outcome: { state: 'unknown' } });
  expect(f.db.prepare('SELECT state FROM graph_actions').get()).toEqual({ state: 'unknown' });
});

it.each(['same', 'different'])('never settles an already-running effect (%s execution) as a safe pre-invocation failure', async (reference) => {
  let invokes = 0;
  const adapter = actor(async function* (task) { invokes++; yield done(task); });
  const f = fixture(adapter);
  adapter.isAvailable = async () => {
    const row = f.db.prepare('SELECT effect_key FROM graph_actions').get() as { effect_key: string };
    const current = f.runs.get(scope, f.run.graphRunId)!;
    new GraphActionStore(f.db).markRunning(fence(current), row.effect_key, reference === 'same' ? `graph-execution:${row.effect_key}` : 'other-trusted-executor');
    return { available: true, last_checked_at: 0 };
  };
  // Registration snapshots method bindings, so register after replacing the probe.
  const connection = {}; f.broker.register(connection, f.registration);
  expect(await f.broker.handle(connection, f.request)).toMatchObject({ outcome: { state: 'unknown' } });
  expect(invokes).toBe(0);
  expect(f.db.prepare('SELECT state, retry_safe FROM graph_actions').get()).toEqual({ state: 'unknown', retry_safe: 0 });
  expect(f.writes.in_use).toBe(1);
});

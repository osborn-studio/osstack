import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { CapabilitySchema, GraphRunStore, openDb, type GraphRun } from "@osstack/core";
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


it('executes in the immutable per-action workspace and releases its canonical admission', async () => {
  const f = fixture(); const branch = join(f.root, 'branch'); execFileSync('git', ['init', '-q', branch]);
  const connection = {}; const workspace = { workspace_id: scope.workspaceId, workspace_path: branch };
  f.broker.register(connection, { ...f.registration, actions: f.registration.actions.map(a => ({ ...a, workspace })) });
  workspace.workspace_path = f.repo;
  expect(await f.broker.handle(connection, f.request)).toMatchObject({ outcome: { state: 'confirmed' } });
  expect(readFileSync(join(branch, 'output.txt'), 'utf8')).toBe('once');
  expect(existsSync(join(f.repo, 'output.txt'))).toBe(false); expect(f.writes.in_use).toBe(0);
});
it('rejects a per-action workspace outside the authenticated logical scope', () => {
  const f = fixture();
  expect(() => f.broker.register({}, { ...f.registration, actions: f.registration.actions.map(a => ({ ...a,
    workspace: { workspace_id: 'foreign', workspace_path: f.repo } })) })).toThrow(/workspace/);
});
it('verifies workspace after adapter availability and before physical invocation', async () => {
  let calls = 0; let valid = true;
  const adapter = actor(async function* (task) { calls++; yield done(task); });
  adapter.isAvailable = async () => { valid = false; return { available: true, last_checked_at: 0 }; };
  const f = fixture(adapter); const connection = {};
  f.broker.register(connection, { ...f.registration, actions: f.registration.actions.map(a => ({ ...a,
    verifyWorkspace: async () => { if (!valid) throw new Error('candidate changed'); } })) });
  expect(await f.broker.handle(connection, f.request)).toMatchObject({ kind: 'worker_action_rejected' });
  expect(calls).toBe(0); expect(f.writes.in_use).toBe(0);
});
it('confirms a valid negative test report after an ordinary nonzero process exit', async () => {
  const f = fixture(); const connection = {};
  const action = { kind: 'tests' as const, candidateRevision: 'a'.repeat(40), commandSpecRef: 'acceptance', workspaceLeaseRef: 'workspace' };
  f.broker.register(connection, { ...f.registration, actions: [{ ...f.registration.actions[0]!, nodeId: 'tests', action,
    execution: { kind: 'command', plan: (f.registration.actions[0]!.execution as { plan: ReturnType<typeof ExecutionPlan.parse> }).plan, command: 'exit 1' },
    persist: async evidence => { expect(evidence.stopped).toBe(true); expect(evidence.command?.exitCode).toBe(1);
      return { evidenceRef: 'negative-tests', actualTokens: 0, result: { schemaVersion: 1, kind: 'tests', candidateRevision: action.candidateRevision,
        passed: false, evidenceRefs: ['negative-tests'], evidenceDigest: 'c'.repeat(64) } }; } }] });
  const result = await f.broker.handle(connection, { ...f.request, nodeId: 'tests', action });
  expect(result).toMatchObject({ outcome: { state: 'confirmed', result: { kind: 'tests', passed: false } } });
  expect(f.writes.in_use).toBe(0);
});
it('separates stopped malformed review output from unknown effects and requires explicit retry', async () => {
  let calls = 0;
  const f = fixture(actor(async function* (task) { calls++; yield done(task); })); const connection = {};
  const action = { kind: 'review' as const, candidateRevision: 'a'.repeat(40), acceptanceRef: 'acceptance', workspaceLeaseRef: 'workspace' };
  f.broker.register(connection, { ...f.registration, actions: [{ ...f.registration.actions[0]!, nodeId: 'review', action,
    persist: async evidence => { expect(evidence.stopped).toBe(true); return { evidenceRef: 'malformed-review', actualTokens: 0,
      verificationFailure: { code: 'OUTPUT_CONTRACT_INVALID', message: 'review JSON invalid', retrySafe: true } }; } }] });
  const request = { ...f.request, nodeId: 'review', action };
  expect(await f.broker.handle(connection, request)).toMatchObject({ outcome: { state: 'failed', error: { code: 'OUTPUT_CONTRACT_INVALID', retryable: true } } });
  expect(f.writes.in_use).toBe(0);
  expect(await f.broker.handle(connection, request)).toMatchObject({ outcome: { state: 'failed' } }); expect(calls).toBe(1);
  const row = f.db.prepare('SELECT effect_key FROM graph_actions').get() as { effect_key: string };
  await f.broker.retryAuthorized(connection, row.effect_key, () => {}); expect(calls).toBe(2);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM graph_actions').get()).toEqual({ n: 2 });
});
it('rechecks authority after asynchronous workspace verification', async () => {
  let calls = 0; const f = fixture(actor(async function* (task) { calls++; yield done(task); })); const connection = {};
  f.broker.register(connection, { ...f.registration, actions: f.registration.actions.map(a => ({ ...a,
    verifyWorkspace: async () => { await Promise.resolve(); f.revoke(); } })) });
  expect(await f.broker.handle(connection, f.request)).toMatchObject({ kind: 'worker_action_rejected' });
  expect(calls).toBe(0); expect(f.writes.in_use).toBe(0);
});
it('retains the precise overridden workspace when executor stop cannot be proven', async () => {
  const adapter = actor(async function* (task) { yield done(task); }); adapter.confirmStopped = async () => ({ stopped: false, evidence: 'still running' });
  const f = fixture(adapter); const branch = join(f.root, 'retained'); execFileSync('git', ['init', '-q', branch]); const connection = {};
  f.broker.register(connection, { ...f.registration, actions: f.registration.actions.map(a => ({ ...a,
    workspace: { workspace_id: scope.workspaceId, workspace_path: branch } })) });
  expect(await f.broker.handle(connection, f.request)).toMatchObject({ outcome: { state: 'unknown' } });
  expect(f.writes.in_use).toBe(1);
  const row = f.db.prepare('SELECT effect_key FROM graph_actions').get() as { effect_key: string };
  await expect(f.broker.releaseReconciled(row.effect_key, async context => {
    expect(context.workspacePath).toBe(branch); throw Error('inspect only: no release authorized');
  })).rejects.toThrow('inspect only');
  expect(f.writes.in_use).toBe(1);
});
it('settles its allocated retry intent when the fresh retry grant is refused before reserve', async () => {
  let calls = 0; const f = fixture(actor(async function* (task) { calls++; yield done(task); })); const connection = {};
  const action = { kind: 'review' as const, candidateRevision: 'a'.repeat(40), acceptanceRef: 'acceptance', workspaceLeaseRef: 'workspace' };
  f.broker.register(connection, { ...f.registration, actions: [{ ...f.registration.actions[0]!, nodeId: 'review', action,
    persist: async () => ({ evidenceRef: 'malformed-review', verificationFailure: { code: 'OUTPUT_CONTRACT_INVALID', message: 'malformed', retrySafe: true } }) }] });
  await f.broker.handle(connection, { ...f.request, nodeId: 'review', action });
  const row = f.db.prepare('SELECT effect_key FROM graph_actions').get() as { effect_key: string }; let checks = 0;
  const response = await f.broker.retryAuthorized(connection, row.effect_key, () => { if (++checks > 1) throw Error('retry grant revoked'); });
  expect(response).toMatchObject({ kind: 'worker_action_rejected' }); expect(calls).toBe(1);
  expect(f.db.prepare('SELECT logical_attempt, state FROM graph_actions ORDER BY logical_attempt').all()).toEqual([
    { logical_attempt: 1, state: 'failed' }, { logical_attempt: 2, state: 'failed' },
  ]);
});

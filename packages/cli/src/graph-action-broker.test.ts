import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const options = { acquire: admission.acquire.bind(admission) };
  const broker = new GraphActionBroker(db, options); broker.register(connection, registration);
  const request: WorkerActionRequest = { schemaVersion: 1, kind: "worker_action", requestId: "request", scope,
    graphRunId: run.graphRunId, specHash: run.identity.specHash, generation: run.generation, epoch: 0,
    nodeId: "implement", effectSlot: "invocation", action: { kind: "implement", inputArtifactRef: "input", workspaceLeaseRef: "workspace" } };
  return { root, repo, db, runs, run, reads, writes, admission, registration, connection, broker, request, options,
    revoke: () => { allowed = false; } };
}
it("executes a registered command once and replays from SQLite after broker restart", async () => {
  const f = fixture();
  const first = await f.broker.handle(f.connection, f.request);
  expect(first).toMatchObject({ kind: "worker_action_response", outcome: { state: "confirmed", result: { receiptRef: "trusted-receipt" } } });
  f.db.close(); const reopened = openDb({ path: join(f.root, "state.db") }); cleanups.push(() => reopened.close());
  const restarted = new GraphActionBroker(reopened, f.options); restarted.register(f.connection, f.registration);
  expect(await restarted.handle(f.connection, { ...f.request, requestId: "retry" })).toMatchObject({ outcome: { state: "confirmed" } });
  expect(readFileSync(join(f.repo, "output.txt"), "utf8")).toBe("once"); expect(f.writes.in_use).toBe(0);
});
it.each(["payload", "node", "scope", "connection", "generation"])("rejects changed %s without invoking", async kind => {
  let count = 0; const f = fixture(actor(async function* (task) { count++; yield done(task); }));
  const request = structuredClone(f.request);
  if (kind === "payload" && request.action.kind === "implement") request.action.inputArtifactRef = "changed";
  if (kind === "node") request.nodeId = "unregistered";
  if (kind === "scope") request.scope.tenantId = "other";
  if (kind === "generation") request.generation++;
  expect(await f.broker.handle(kind === "connection" ? {} : f.connection, request)).toMatchObject({ kind: "worker_action_rejected" });
  expect(count).toBe(0); expect(f.writes.in_use).toBe(0);
});
it("concurrent same slot calls can invoke only the creator's intent", async () => {
  let count = 0; const f = fixture(actor(async function* (task) { count++; yield done(task); }));
  const results = await Promise.all([f.broker.handle(f.connection, f.request), f.broker.handle(f.connection, f.request)]);
  expect(results.some(result => result.kind === "worker_action_response" && result.outcome.state === "confirmed")).toBe(true);
  expect(count).toBe(1);
});
it("rechecks revocation after the shared admission queue without leaking a permit", async () => {
  let count = 0; const f = fixture(actor(async function* (task) { count++; yield done(task); }));
  const lease = await f.admission.acquire({ kind: "write", runId: "other-run", workspacePath: f.repo });
  const pending = f.broker.handle(f.connection, f.request);
  await new Promise(resolve => setTimeout(resolve, 30)); f.revoke(); await lease.release();
  expect(await pending).toMatchObject({ kind: "worker_action_rejected" }); expect(count).toBe(0); expect(f.writes.in_use).toBe(0);
});
it.each(["throw", "terminal-failure", "cancel"])("never blindly retries %s after invocation", async kind => {
  let count = 0;
  const adapter = actor(async function* (task) { count++; if (kind === "throw") throw new Error("wrote then lost transport");
    if (kind === "cancel") { await new Promise(() => {}); } else yield done(task, "failed"); });
  if (kind === "cancel") adapter.confirmStopped = async () => ({ stopped: false });
  const f = fixture(adapter); const controller = new AbortController();
  const pending = f.broker.handle(f.connection, f.request, { signal: controller.signal });
  if (kind === "cancel") { await expect.poll(() => count).toBe(1); controller.abort(); }
  const result = await pending;
  expect(result).toMatchObject({ kind: "worker_action_response", outcome: { state: kind === "terminal-failure" ? "failed" : "unknown" } });
  await f.broker.handle(f.connection, f.request); expect(count).toBe(1);
  expect(f.writes.in_use).toBe(kind === "terminal-failure" ? 0 : 1);
});
it("pins request, registration, and adapter functions before asynchronous admission", async () => {
  let count = 0; const adapter = actor(async function* (task) { count++; yield done(task); }); const f = fixture(adapter);
  const lease = await f.admission.acquire({ kind: "write", runId: "other", workspacePath: f.repo });
  const pending = f.broker.handle(f.connection, f.request);
  if (f.request.action.kind === "implement") f.request.action.inputArtifactRef = "mutated";
  f.registration.workspace.workspace_path = "/mutated";
  f.registration.authorize = () => { throw new Error("replaced callback"); };
  // biome-ignore lint/correctness/useYield: Replaced adapter must throw before producing any event.
  adapter.invoke = async function* () { throw new Error("replaced adapter"); };
  await lease.release();
  expect(await pending).toMatchObject({ outcome: { state: "confirmed" } }); expect(count).toBe(1);
});
it.each(["revoke", "generation"])("fences %s after G04 asynchronous availability and before actual invoke", async kind => {
  let count = 0; let release!: () => void; let probing = false;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const adapter = actor(async function* (task) { count++; yield done(task); });
  adapter.isAvailable = async () => { probing = true; await wait; return { available: true, last_checked_at: 0 }; };
  const f = fixture(adapter); const pending = f.broker.handle(f.connection, f.request);
  await expect.poll(() => probing).toBe(true);
  if (kind === "revoke") f.revoke();
  else { const current = f.runs.get(scope, f.run.graphRunId)!; const now = Date.now();
    expect(() => f.runs.acquireLease({ ...fence(current), now, owner: "new-worker", leaseExpiresAt: Date.now() + 120_000,
      stoppedWorker: { graphRunId: current.graphRunId, generation: current.generation, owner: current.leaseOwner!, confirmedAt: now, evidenceRef: "host-exit" } })).toThrow('ADMISSION_RELEASE_PENDING');
    // The supported takeover now refuses held admissions. Still fault-inject an
    // out-of-protocol state change to prove the final invocation fence holds.
    f.db.prepare("UPDATE graph_runs SET generation=generation+1,revision=revision+1,lease_owner='new-worker' WHERE graph_run_id=?").run(current.graphRunId);
  }
  release(); expect(await pending).toMatchObject({ kind: "worker_action_rejected" }); expect(count).toBe(0); expect(f.writes.in_use).toBe(0);
});
it("fences confirmed replay before lookup and keeps effect identity across a trusted fresh generation", async () => {
  let count = 0; const f = fixture(actor(async function* (task) { count++; yield done(task); }));
  const first = await f.broker.handle(f.connection, f.request);
  const current = f.runs.get(scope, f.run.graphRunId)!;
  const now = Date.now();
  const next = f.runs.acquireLease({ ...fence(current), now, owner: "new-worker", leaseExpiresAt: Date.now() + 120_000,
    stoppedWorker: { graphRunId: current.graphRunId, generation: current.generation, owner: current.leaseOwner!, confirmedAt: now, evidenceRef: "host-exit" } });
  expect(await f.broker.handle(f.connection, f.request)).toMatchObject({ kind: "worker_action_rejected", error: { code: "STALE_GENERATION" } });
  const connection = {}; f.broker.register(connection, { ...f.registration, generation: next.generation, owner: next.leaseOwner! });
  const replay = await f.broker.handle(connection, { ...f.request, generation: next.generation });
  expect(replay).toMatchObject({ outcome: { state: "confirmed" } });
  if (first.kind !== "worker_action_response" || replay.kind !== "worker_action_response") throw new Error("missing response");
  expect(replay.effect).toEqual(first.effect); expect(count).toBe(1);
});
it("unknown blocks a later separately registered action and retains actual capacity", async () => {
  // biome-ignore lint/correctness/useYield: Reproduce a side effect followed by failure before any event.
  let count = 0; const f = fixture(actor(async function* () { count++; throw new Error("side effect then exception"); }));
  const connection = {}; const second = { ...f.registration.actions[0]!, nodeId: "second" };
  f.broker.register(connection, { ...f.registration, actions: [...f.registration.actions, second] });
  expect(await f.broker.handle(connection, f.request)).toMatchObject({ outcome: { state: "unknown" } });
  expect(await f.broker.handle(connection, { ...f.request, nodeId: "second" })).toMatchObject({ kind: "worker_action_rejected", error: { code: "ACTION_OUTCOME_UNKNOWN" } });
  expect(count).toBe(1); expect(f.writes.in_use).toBe(1);
  expect(f.db.prepare("SELECT state, reservation_tokens FROM graph_actions").all()).toEqual([{ state: "unknown", reservation_tokens: 10 }]);
});
it.each(["result", "usage", "receipt", "commit"])("retains uncertainty when trusted %s fails after physical execution", async kind => {
  let count = 0; const f = fixture(actor(async function* (task) { count++; yield done(task); }));
  const connection = {};
  f.broker.register(connection, { ...f.registration, actions: [{ ...f.registration.actions[0]!, persist: async () => {
    if (kind === "commit") f.db.exec("CREATE TRIGGER fail_outcome BEFORE UPDATE OF outcome_json ON graph_actions BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    return { evidenceRef: kind === "receipt" ? "" : "saved", ...(kind === "usage" ? { actualTokens: -1 } : {}),
      result: kind === "result" ? { schemaVersion: 1, kind: "candidate_ready", candidateRevision: "a".repeat(40), artifactRefs: ["fake"], artifactDigest: "b".repeat(64) }
        : { schemaVersion: 1, kind: "implementation_complete", workspaceLeaseRef: "workspace", receiptRef: "saved" } };
  } }] });
  expect(await f.broker.handle(connection, f.request)).toMatchObject({ outcome: { state: "unknown" } });
  await f.broker.handle(connection, f.request); expect(count).toBe(1); expect(f.writes.in_use).toBe(1);
});
it("accepts only a specific registered workspace handler, never a worker callback", async () => {
  const f = fixture(); let count = 0; const connection = {};
  const action = { kind: "workspace_release" as const, workspaceLeaseRef: "workspace" };
  f.broker.register(connection, { ...f.registration, actions: [{ ...f.registration.actions[0]!, action,
    execution: { kind: "workspace", handler: async ({ workspace, signal }) => { count++; expect(workspace.workspace_path).toBe(f.repo);
      expect(signal).toBeInstanceOf(AbortSignal); return { status: "completed", stopped: true, evidence: { host: "released" } }; } },
    persist: async () => ({ evidenceRef: "workspace-saved", result: { schemaVersion: 1, kind: "workspace", workspaceLeaseRef: "workspace", receiptRef: "workspace-saved" } }) }] });
  expect(await f.broker.handle(connection, { ...f.request, action })).toMatchObject({ outcome: { state: "confirmed" } });
  expect(count).toBe(1);
});
it("refuses unknown/ambiguous capability registration and never runs a mixed writer with a read permit", async () => {
  const f = fixture(); const plan = ExecutionPlan.parse({ plan_id: "plan", agent_id: "builder", task: {
    task_id: "task", capability: "code.review", prompt: "review", source: "manual" }, stop_condition: { type: "tests_pass" } });
  const adapter = actor(async function* (task) { expect(f.writes.in_use).toBe(1); expect(f.reads.in_use).toBe(0); yield done(task); });
  const write = adapter.capabilities()[0]!;
  adapter.capabilities = () => [write, { ...write, id: "builder.review", kind: "code.review" }];
  const item = { ...f.registration.actions[0]!, execution: { kind: "adapter" as const, adapter, plan, capabilityId: "builder.review" } };
  const connection = {}; f.broker.register(connection, { ...f.registration, actions: [item] });
  expect(await f.broker.handle(connection, f.request)).toMatchObject({ outcome: { state: "confirmed" } });
  adapter.capabilities = () => [{ ...write, id: "builder.review", kind: "code.review" }, { ...write, id: "builder.review" }];
  expect(() => f.broker.register({}, { ...f.registration, actions: [item] })).toThrow("ambiguous");
});
it("rejects an accidentally async trusted revocation callback instead of granting on its Promise", async () => {
  let count = 0; const f = fixture(actor(async function* (task) { count++; yield done(task); }));
  const connection = {}; f.broker.register(connection, { ...f.registration, authorize: async () => { throw new Error("revoked asynchronously"); } });
  expect(await f.broker.handle(connection, f.request)).toMatchObject({ kind: "worker_action_rejected" }); expect(count).toBe(0);
});
it("policy failure before effects resolves only its own intent and releases the lease", async () => {
  let count = 0; const f = fixture(actor(async function* (task) { count++; yield done(task); }));
  const broker = new GraphActionBroker(f.db, { ...f.options, authorizePolicy: async () => { throw new Error("policy denied"); } });
  broker.register(f.connection, f.registration);
  expect(await broker.handle(f.connection, f.request)).toMatchObject({ kind: "worker_action_rejected" });
  expect(f.db.prepare("SELECT state FROM graph_actions").get()).toEqual({ state: "failed" });
  expect(f.writes.in_use).toBe(0); expect(count).toBe(0);
});
it("rejects a wrong full program identity and forged worker authority fields", async () => {
  let count = 0; const f = fixture(actor(async function* (task) { count++; yield done(task); }));
  expect(() => f.broker.register({}, { ...f.registration, identity: { ...f.registration.identity, compilerVersion: "other" } })).toThrow("identity");
  for (const key of ["principal", "grant", "receipt", "checkpoint", "commandSpec"]) {
    expect(await f.broker.handle(f.connection, { ...f.request, [key]: "approved" })).toMatchObject({ kind: "worker_action_rejected" });
  }
  expect(count).toBe(0);
});
it("refuses unsupported freeze registration before acquiring capacity", () => {
  const f = fixture();
  expect(() => f.broker.register({}, { ...f.registration, actions: [{ ...f.registration.actions[0]!,
    action: { kind: "freeze", workspaceLeaseRef: "workspace", receiptRef: "claimed" } }] })).toThrow("unsupported");
  expect(f.writes.in_use).toBe(0);
});
it("forwards cancellation to the actual adapter and retains an unconfirmed external producer", async () => {
  let received: AbortSignal | undefined; let count = 0;
  const adapter = actor(async function* (_task, signal) { count++; received = signal; await new Promise(() => {}); });
  adapter.confirmStopped = async () => ({ stopped: false });
  const f = fixture(adapter); const controller = new AbortController();
  const pending = f.broker.handle(f.connection, f.request, { signal: controller.signal });
  await expect.poll(() => count).toBe(1); controller.abort();
  expect(await pending).toMatchObject({ outcome: { state: "unknown" } }); expect(received?.aborted).toBe(true);
  expect(f.writes.in_use).toBe(1);
});
it.each(["bad", -1, 1.5])("treats malformed raw adapter token usage %s as unknown even if later usage is valid", async bad => {
  const adapter = actor(async function* (task) {
    yield { ...done(task), terminal: false, type: "usage.updated", payload: { tokens_in: bad, tokens_out: 1 } } as unknown as HermesEvent;
    yield { ...done(task), terminal: false, seq: 2, type: "usage.final", payload: { tokens_in: 2, tokens_out: 1 } } as HermesEvent;
    yield { ...done(task), seq: 3 };
  });
  const f = fixture(adapter);
  expect(await f.broker.handle(f.connection, f.request)).toMatchObject({ outcome: { state: "unknown" } });
  expect(f.writes.in_use).toBe(1);
});
it("retains reported overrun reservation after the adapter throws", async () => {
  const adapter = actor(async function* (task) {
    yield { ...done(task), terminal: false, type: "usage.final", payload: { tokens_in: 120, tokens_out: 30 } } as HermesEvent;
    throw new Error("effect then transport loss");
  });
  const f = fixture(adapter);
  expect(await f.broker.handle(f.connection, f.request)).toMatchObject({ outcome: { state: "unknown" } });
  expect(f.db.prepare("SELECT observed_tokens FROM graph_actions").get()).toEqual({ observed_tokens: 150 });
});

it("rejects an adapter without stop confirmation before intent, capacity or invocation", () => {
  let calls = 0; const adapter = actor(async function* (task) { calls++; yield done(task); });
  const f = fixture(adapter); delete adapter.confirmStopped;
  const broker = new GraphActionBroker(f.db, f.options);
  expect(() => broker.register({}, f.registration)).toThrow("EXECUTOR_UNSUPPORTED");
  expect(f.db.prepare("SELECT count(*) n FROM graph_actions").get()).toEqual({ n: 0 });
  expect(f.db.prepare("SELECT count(*) n FROM graph_action_admissions").get()).toEqual({ n: 0 });
  expect(f.writes.in_use).toBe(0); expect(calls).toBe(0);
});

it("discharges an unstarted action only after canonical queued acquisition confirms cleanup", async () => {
  let count = 0; const f = fixture(actor(async function* (task) { count++; yield done(task); }));
  const blocker = await f.admission.acquire({ kind: 'write', runId: 'blocker', workspacePath: f.repo });
  const controller = new AbortController();
  const pending = f.broker.handle(f.connection, f.request, { signal: controller.signal });
  await expect.poll(() => (f.db.prepare('SELECT count(*) n FROM graph_actions').get() as { n: number }).n).toBe(1);
  controller.abort(); await pending;
  expect(count).toBe(0);
  expect(f.db.prepare('SELECT state,execution_ref,actual_tokens FROM graph_actions').get()).toEqual({ state: 'failed', execution_ref: null, actual_tokens: 0 });
  expect(f.db.prepare('SELECT held_at = released_at AS discharged FROM graph_action_admissions').get()).toEqual({ discharged: 1 });
  expect(f.writes.in_use).toBe(1); await blocker.release();
});
it("does not discharge an arbitrary acquisition rejection without canonical cleanup evidence", async () => {
  const f = fixture();
  const broker = new GraphActionBroker(f.db, { acquire: async () => { throw Error('cleanup unconfirmed'); } });
  broker.register(f.connection, f.registration);
  await broker.handle(f.connection, f.request);
  expect(f.db.prepare('SELECT count(*) n FROM graph_action_admissions').get()).toEqual({ n: 0 });
});

it('refuses an expired returned lease before publishing admission or invoking an adapter', async () => {
  let calls = 0, released = false;
  const f = fixture(actor(async function* (task) { calls++; yield done(task); }));
  const broker = new GraphActionBroker(f.db, { acquire: async () => ({
    assertActive: async () => { throw Error('expired at acquire continuation'); },
    retain: () => {}, release: async () => { released = true; },
  }) });
  broker.register(f.connection, f.registration);
  await broker.handle(f.connection, f.request);
  expect(calls).toBe(0); expect(released).toBe(true);
  expect(f.db.prepare('SELECT count(*) n FROM graph_action_admissions').get()).toEqual({ n: 0 });
  expect(f.db.prepare('SELECT state,execution_ref FROM graph_actions').get()).toEqual({ state: 'failed', execution_ref: null });
});

it('pins and forwards host apply tree constraints to freeze', async () => {
  const f = fixture(); const connection = {};
  const expectedTrees = { base: 'a'.repeat(40), candidate: 'b'.repeat(40) };
  const candidate = { schemaVersion: 1 as const, kind: 'candidate_ready' as const, candidateRevision: 'c'.repeat(40), artifactDigest: 'd'.repeat(64), artifactRefs: ['graph-artifact:' + 'd'.repeat(64)] };
  let checked = false;
  f.broker.register(connection, { ...f.registration, actions: [{ nodeId: 'freeze', effectSlot: 'capture', tokenReservation: 0,
    action: { kind: 'freeze', workspaceLeaseRef: 'workspace', receiptRef: 'receipt' },
    execution: { kind: 'freeze', input: { artifactId: 'artifact', scope, runId: f.run.graphRunId, generation: f.run.generation,
      owner: 'worker', workspaceLeaseRef: 'workspace', repoId: 'repo', commonDir: join(f.repo, '.git'), worktreePath: f.repo,
      baseRevision: 'a'.repeat(40), implementationReceiptRef: 'receipt', producerStopEvidenceRef: 'stop' },
      authority: { expectedTrees, verifyLease: () => undefined, verifyImplementationReceipt: () => undefined, verifyProducersStopped: () => undefined },
      store: { freeze: async (_input, authority) => { expect(authority.expectedTrees).toEqual({ base: 'a'.repeat(40), candidate: 'b'.repeat(40) }); checked = true; return candidate; } } },
    persist: async () => ({ evidenceRef: 'frozen', result: candidate }) }] });
  expectedTrees.candidate = 'e'.repeat(40);
  const result = await f.broker.handle(connection, { ...f.request, nodeId: 'freeze', effectSlot: 'capture',
    action: { kind: 'freeze', workspaceLeaseRef: 'workspace', receiptRef: 'receipt' } });
  expect(result).toMatchObject({ outcome: { state: 'confirmed' } }); expect(checked).toBe(true);
});

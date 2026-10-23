// ../../../tmp/g30-final/import-proof/entry.ts
import { writeFile as writeFile3 } from "node:fs/promises";

// packages/cli/src/graph-test-fixture.ts
import { execFileSync as execFileSync5 } from "node:child_process";
import { mkdtemp, mkdir as mkdir5, writeFile as writeFile2, readFile, realpath as realpath5 } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join9 } from "node:path";
import { openDb, CapabilitySchema as CapabilitySchema2 } from "@osstack/core";
import { GraphDelegationStatus as GraphDelegationStatus2 } from "@osstack/protocol";
import { FifoSemaphore as FifoSemaphore2 } from "@osstack/autonomy";

// packages/cli/src/graph-platform.ts
import { GraphContractError } from "@osstack/protocol";
function assertGraphPlatform(versions = process.versions) {
  if (versions.bun) throw new GraphContractError("GRAPH_DISTRIBUTION_UNSUPPORTED");
  const [major, minor] = versions.node.split(".").map(Number);
  if (!major || major < 20 || major === 20 && (!minor || minor < 6)) throw new GraphContractError("GRAPH_NODE_VERSION_UNSUPPORTED");
}

// packages/cli/src/graph-rpc.ts
import { randomUUID as randomUUID8, createHash as createHash9 } from "node:crypto";
import { join as join7 } from "node:path";
import { z as z4 } from "zod";
import { GraphRunStore as GraphRunStore7 } from "@osstack/core";
import { readGraphActionState } from "@osstack/core/graph-verification";
import { GraphErrorCode, GraphStatusRequest, GraphDelegationStatus, GraphScope as GraphScope2, GraphRequest, GraphSpec, computeGraphInputDigest as computeGraphInputDigest2, workerCanonical as workerCanonical10, GraphContractError as GraphContractError3 } from "@osstack/protocol";
import { compileGraphSpec as compileGraphSpec3 } from "@osstack/graph/spec-compiler";

// packages/cli/src/graph-delivery.ts
import { execFileSync as execFileSync4 } from "node:child_process";
import { createHash as createHash8, randomUUID as randomUUID7 } from "node:crypto";
import { mkdir as mkdir4, writeFile, realpath as realpath4 } from "node:fs/promises";
import { join as join5 } from "node:path";
import { GraphRunStore as GraphRunStore5, GraphActionStore as GraphActionStore2, GraphCheckpointStore, resolveRepositoryScope as resolveRepositoryScope2 } from "@osstack/core";
import { GraphRecoveryStore as GraphRecoveryStore3 } from "@osstack/core/graph-recovery";

// packages/cli/src/graph-worker-exit-proof.ts
import { createHash } from "node:crypto";
import { z } from "zod";
import { GraphRunStore } from "@osstack/core";
import { GraphWorkerBinding, workerCanonical } from "@osstack/protocol";
var count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var pid = count.min(1);
var text = z.string().min(1).max(8192);
var processIdentity = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("linux"), pid, pgid: pid, bootId: text, startTicks: z.string().regex(/^\d+$/) }).strict(),
  z.object({ kind: z.literal("unverifiable"), pid, pgid: pid.nullable(), platform: text, detail: text }).strict()
]);
var launched = z.object({ kind: z.literal("launched"), launch: z.object({ pid, pgid: pid.nullable(), processIdentity, capturedAt: count }).strict() }).strict();
var exited = z.object({
  kind: z.literal("exited"),
  graphRunId: text,
  generation: pid,
  owner: text,
  pid,
  code: count.nullable(),
  signal: z.string().regex(/^SIG[A-Z0-9]+$/).nullable(),
  confirmedAt: count,
  evidenceRef: z.string().regex(/^worker-exit:[a-f0-9-]{36}$/)
}).strict();
var unconfirmed = z.object({ kind: z.literal("exit_unconfirmed"), pid: pid.optional(), error: text }).strict();
var notStarted = z.object({
  kind: z.literal("spawn_failed"),
  graphRunId: text,
  generation: pid,
  owner: text,
  confirmedAt: count,
  evidenceRef: z.string().regex(/^worker-not-started:[a-f0-9-]{36}$/),
  phase: z.enum(["registration", "spawn"]),
  error: z.string()
}).strict();
function verifyJournaledGraphWorkerNotStarted(db, value, now = Date.now()) {
  const binding2 = GraphWorkerBinding.parse(value);
  count.parse(now);
  const run = new GraphRunStore(db).get(binding2.scope, binding2.graphRunId);
  if (!run || workerCanonical(run.identity) !== workerCanonical(binding2.identity)) throw Error("GRAPH_NO_CHILD_PROOF_REQUIRED");
  const rows = db.prepare(`SELECT l.owner,l.acquired_at,w.owner AS launch_owner,w.identity_json,w.launched_at,
    e.kind,e.event_json,e.observed_at,
    EXISTS(SELECT 1 FROM graph_actions WHERE graph_run_id=l.graph_run_id AND generation=l.generation) AS actions,
    EXISTS(SELECT 1 FROM graph_action_admissions WHERE graph_run_id=l.graph_run_id AND generation=l.generation) AS admissions,
    EXISTS(SELECT 1 FROM graph_checkpoint_requests WHERE graph_run_id=l.graph_run_id AND generation=l.generation) AS requests
    FROM graph_worker_leases l JOIN graph_worker_launches w ON w.graph_run_id=l.graph_run_id AND w.generation=l.generation
    LEFT JOIN graph_worker_process_events e ON e.graph_run_id=l.graph_run_id AND e.generation=l.generation
    WHERE l.graph_run_id=? AND l.generation=?`).all(binding2.graphRunId, binding2.generation);
  const row = rows[0];
  if (rows.length !== 1 || !row || row.owner !== binding2.owner || row.launch_owner !== binding2.owner || row.identity_json !== workerCanonical(binding2.identity) || row.kind !== "spawn_failed" || row.actions || row.admissions || row.requests) throw Error("GRAPH_NO_CHILD_PROOF_REQUIRED");
  const parsed = notStarted.safeParse(JSON.parse(row.event_json));
  if (!parsed.success) throw Error("GRAPH_NO_CHILD_PROOF_REQUIRED");
  const event = parsed.data;
  if (event.graphRunId !== binding2.graphRunId || event.generation !== binding2.generation || event.owner !== binding2.owner || row.acquired_at > row.launched_at || row.launched_at > event.confirmedAt || event.confirmedAt > row.observed_at || row.observed_at > now) throw Error("GRAPH_NO_CHILD_PROOF_REQUIRED");
  return {
    kind: "not_started",
    graphRunId: event.graphRunId,
    generation: event.generation,
    owner: event.owner,
    confirmedAt: event.confirmedAt,
    evidenceRef: event.evidenceRef
  };
}
function verifyJournaledGraphWorkerExit(db, value, now = Date.now()) {
  const binding2 = GraphWorkerBinding.parse(value);
  count.parse(now);
  const run = new GraphRunStore(db).get(binding2.scope, binding2.graphRunId);
  if (!run || workerCanonical(run.identity) !== workerCanonical(binding2.identity)) throw Error("GRAPH_WORKER_EXIT_BINDING");
  const rows = db.prepare(`SELECT l.owner,l.acquired_at,w.owner AS launch_owner,w.identity_json,w.launched_at,
    e.sequence,e.kind,e.event_json,e.observed_at
    FROM graph_worker_leases l JOIN graph_worker_launches w
      ON w.graph_run_id=l.graph_run_id AND w.generation=l.generation
    LEFT JOIN graph_worker_process_events e ON e.graph_run_id=l.graph_run_id AND e.generation=l.generation
    WHERE l.graph_run_id=? AND l.generation=? ORDER BY e.sequence`).all(binding2.graphRunId, binding2.generation);
  const first = rows[0];
  if (!first || first.owner !== binding2.owner || first.launch_owner !== binding2.owner || first.identity_json !== workerCanonical(binding2.identity) || first.acquired_at > first.launched_at || rows.length < 2 || rows.length > 3 || rows[0].kind !== "launched" || rows.at(-1).kind !== "exited") throw Error("GRAPH_WORKER_EXIT_UNPROVEN");
  const start = launched.parse(JSON.parse(first.event_json)).launch;
  const last = rows.at(-1);
  const exit = exited.parse(JSON.parse(last.event_json));
  if (start.pid !== start.processIdentity.pid || start.pgid !== start.processIdentity.pgid || exit.pid !== start.pid || exit.graphRunId !== binding2.graphRunId || exit.generation !== binding2.generation || exit.owner !== binding2.owner || exit.code === null === (exit.signal === null) || first.launched_at > start.capturedAt || start.capturedAt > first.observed_at || first.observed_at > exit.confirmedAt || exit.confirmedAt > last.observed_at || last.observed_at > now) throw Error("GRAPH_WORKER_EXIT_UNPROVEN");
  if (rows.length === 3) {
    const middle = rows[1];
    const timeout = unconfirmed.parse(JSON.parse(middle.event_json));
    if (middle.kind !== "exit_unconfirmed" || timeout.pid !== void 0 && timeout.pid !== start.pid || middle.observed_at < first.observed_at || middle.observed_at > exit.confirmedAt) throw Error("GRAPH_WORKER_EXIT_UNPROVEN");
  }
  const evidenceRef = `graph-worker-exit:${createHash("sha256").update(workerCanonical({ binding: binding2, rows })).digest("hex")}`;
  return {
    kind: "stopped",
    graphRunId: binding2.graphRunId,
    generation: binding2.generation,
    owner: binding2.owner,
    confirmedAt: exit.confirmedAt,
    evidenceRef
  };
}

// packages/cli/src/graph-delivery.ts
import { GraphArtifactStore } from "@osstack/core/graph-artifacts";
import { GraphDeliveryEpochStore, GraphVerificationStore as GraphVerificationStore2 } from "@osstack/core/graph-verification";
import { compileGraphSpec } from "@osstack/graph/spec-compiler";
import { deliveryEpoch } from "@osstack/graph/templates/code-delivery-v1";
import { WorkerActionRequest as WorkerActionRequest3, workerCanonical as workerCanonical8, StartGraphRequest as StartGraphRequest2, freezeWorkerData as freezeWorkerData5 } from "@osstack/protocol";

// packages/cli/src/graph-action-broker.ts
import { GraphAdmissionStore } from "@osstack/core/graph-recovery";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  CapabilitySchema,
  GraphActionStore,
  GraphRunStore as GraphRunStore2
} from "@osstack/core";
import {
  GraphContractError as GraphContractError2,
  GraphError as GraphErrorSchema,
  GraphJsonValue,
  GraphResult,
  GraphScope,
  WorkerActionRequest,
  WorkerActionResponse
} from "@osstack/protocol";
import {
  ExecutionPlan,
  executeCandidateImplementation,
  runShellCommand
} from "@osstack/loop";
function assertGraphAdapterSupported(adapter) {
  if (typeof adapter.confirmStopped !== "function") throw new GraphContractError2("EXECUTOR_UNSUPPORTED");
}
var slot = (node, effect) => JSON.stringify([node, effect]);
var reads = /* @__PURE__ */ new Set(["code.review", "review.code", "research.code"]);
var writes = /* @__PURE__ */ new Set(["code.write", "code.refactor", "code.debug", "code.test"]);
function snapshot(value) {
  const copy = structuredClone(value);
  const freeze = (item) => {
    if (item !== null && typeof item === "object") {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
var Denied = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  code;
};
function graphError(code, message) {
  return {
    schemaVersion: 1,
    code,
    message: message.slice(0, 4096) || code,
    retryable: false,
    nextAction: code === "ACTION_OUTCOME_UNKNOWN" || code === "CANCEL_UNCONFIRMED" ? "reconcile" : "stop"
  };
}
function errorCode(error) {
  if (error instanceof Denied) return error.code;
  const message = String(error);
  if (/GRANT_EXPIRED/.test(message)) return "GRANT_EXPIRED";
  if (/STALE_GENERATION|OWNER_MISMATCH|LEASE_EXPIRED/.test(message)) return "STALE_GENERATION";
  if (/PROGRAM_IDENTITY/.test(message)) return "CHECKPOINT_INCOMPATIBLE";
  if (/UNRESOLVED|RETRY_NOT_SAFE/.test(message)) return "ACTION_OUTCOME_UNKNOWN";
  if (/BUDGET|ACCOUNTING/.test(message)) return "BUDGET_EXHAUSTED";
  if (/REVISION_CONFLICT/.test(message)) return "REVISION_CONFLICT";
  return "POLICY_DENIED";
}
var GraphActionBroker = class {
  constructor(db, options) {
    this.db = db;
    this.options = options;
    this.admissions = new GraphAdmissionStore(db);
    this.runs = new GraphRunStore2(db);
    this.actions = new GraphActionStore(db);
  }
  db;
  options;
  connections = /* @__PURE__ */ new WeakMap();
  retired = /* @__PURE__ */ new WeakSet();
  retained = /* @__PURE__ */ new Map();
  admissions;
  runs;
  actions;
  register(connection, input) {
    if (this.retired.has(connection)) throw new Error("worker connection retired");
    if (this.connections.has(connection)) throw new Error("worker connection already registered");
    const binding2 = this.bind(input);
    this.connections.set(connection, binding2);
  }
  bind(input) {
    const { actions, authorize, ...data } = input;
    const fixed = snapshot(data);
    GraphScope.parse(fixed.scope);
    if (typeof authorize !== "function" || !fixed.owner || !isAbsolute(fixed.workspace.workspace_path) || fixed.workspace.workspace_path.includes("\0") || fixed.workspace.workspace_id !== fixed.scope.workspaceId) throw new Error("invalid trusted worker registration");
    const registered = /* @__PURE__ */ new Map();
    for (const item of actions) {
      const { execution, persist, verifyWorkspace, ...actionData } = item;
      const copy = snapshot(actionData);
      const workspace = snapshot(copy.workspace ?? fixed.workspace);
      if (workspace.workspace_id !== fixed.scope.workspaceId || !isAbsolute(workspace.workspace_path) || workspace.workspace_path.includes("\0") || verifyWorkspace !== void 0 && typeof verifyWorkspace !== "function") throw new Error("invalid action workspace");
      WorkerActionRequest.parse({
        schemaVersion: 1,
        kind: "worker_action",
        requestId: "registration",
        scope: fixed.scope,
        graphRunId: fixed.graphRunId,
        specHash: fixed.identity.specHash,
        generation: fixed.generation,
        epoch: fixed.epoch,
        nodeId: copy.nodeId,
        effectSlot: copy.effectSlot,
        action: copy.action
      });
      if (typeof persist !== "function") throw new Error("unsupported graph action");
      if (!Number.isSafeInteger(copy.tokenReservation) || copy.tokenReservation < 0) throw new Error("invalid token reservation");
      let selected;
      let access = "write";
      if (execution.kind === "freeze") {
        if (copy.action.kind !== "freeze" || typeof execution.store?.freeze !== "function") throw new Error("unsupported freeze registration");
        const input2 = snapshot(execution.input);
        if (canonical(input2.scope) !== canonical(fixed.scope) || input2.runId !== fixed.graphRunId || input2.generation !== fixed.generation || input2.owner !== fixed.owner || input2.worktreePath !== workspace.workspace_path || input2.workspaceLeaseRef !== copy.action.workspaceLeaseRef || input2.implementationReceiptRef !== copy.action.receiptRef) throw new Error("freeze registration identity mismatch");
        const { verifyLease, verifyImplementationReceipt, verifyProducersStopped } = execution.authority;
        if ([verifyLease, verifyImplementationReceipt, verifyProducersStopped].some((fn) => typeof fn !== "function")) throw new Error("freeze authority required");
        selected = Object.freeze({
          kind: "freeze",
          input: input2,
          store: Object.freeze({ freeze: execution.store.freeze.bind(execution.store) }),
          authority: Object.freeze({ verifyLease, verifyImplementationReceipt, verifyProducersStopped })
        });
      } else if (execution.kind === "workspace") {
        if (!["workspace_create", "workspace_release"].includes(copy.action.kind) || typeof execution.handler !== "function") throw new Error("unsupported workspace handler");
        selected = Object.freeze({ kind: "workspace", handler: execution.handler });
      } else {
        if (!["implement", "repair", "tests", "review"].includes(copy.action.kind)) throw new Error("unsupported candidate action");
        const plan = snapshot(ExecutionPlan.parse(execution.plan));
        if (plan.worktree_path !== void 0 && plan.worktree_path !== workspace.workspace_path) throw new Error("workspace mismatch");
        if (execution.kind === "contained") {
          if (copy.action.kind !== "tests" || !execution.command.trim() || execution.command.includes("\0") || typeof execution.execute !== "function" || typeof execution.confirmStopped !== "function") throw Error("invalid contained tests registration");
          selected = Object.freeze({ kind: "contained", plan, command: execution.command, execute: execution.execute.bind(execution), confirmStopped: execution.confirmStopped.bind(execution) });
        } else if (execution.kind === "command") {
          if (!execution.command?.trim() || execution.command.includes("\0")) throw new Error("invalid registered command");
          selected = Object.freeze({ kind: "command", plan, command: execution.command });
        } else if (execution.kind === "adapter") {
          const adapter = execution.adapter;
          assertGraphAdapterSupported(adapter);
          const capabilities = snapshot(adapter.capabilities().map((cap2) => CapabilitySchema.parse(cap2)));
          const matches = capabilities.filter((cap2) => cap2.id === execution.capabilityId);
          const cap = matches[0];
          if (matches.length !== 1 || !cap || cap.agent_id !== adapter.id || plan.agent_id !== adapter.id || plan.task.capability !== cap.kind || !reads.has(cap.kind) && !writes.has(cap.kind)) throw new Error("unknown or ambiguous trusted capability");
          if (capabilities.some((capability) => !reads.has(capability.kind) && !writes.has(capability.kind))) throw new Error("unknown adapter capability");
          access = capabilities.every((capability) => reads.has(capability.kind)) ? "read" : "write";
          const bound = Object.freeze({
            id: adapter.id,
            display_name: adapter.display_name,
            cost_tier: adapter.cost_tier,
            capabilities: () => structuredClone(capabilities),
            isAvailable: adapter.isAvailable.bind(adapter),
            invoke: adapter.invoke.bind(adapter),
            ...adapter.confirmStopped ? { confirmStopped: adapter.confirmStopped.bind(adapter) } : {}
          });
          selected = Object.freeze({ kind: "adapter", plan, adapter: bound, capabilityId: execution.capabilityId });
        } else throw new Error("unsupported execution handler");
      }
      const key = slot(copy.nodeId, copy.effectSlot);
      if (registered.has(key)) throw new Error("duplicate compiled action slot");
      registered.set(key, Object.freeze({ ...copy, workspace, execution: selected, persist, access, ...verifyWorkspace ? { verifyWorkspace } : {} }));
    }
    const binding2 = Object.freeze({ ...fixed, authorize, actions: registered });
    this.fence(binding2);
    return binding2;
  }
  /** Host-only append. Existing slots and in-flight binding stay immutable. */
  installActions(connection, actions) {
    const binding2 = this.connections.get(connection);
    if (!binding2 || this.retired.has(connection)) throw Error("UNAUTHENTICATED");
    this.authorize(binding2);
    this.fence(binding2);
    const additions = this.bind({ ...binding2, actions });
    for (const key of additions.actions.keys()) if (binding2.actions.has(key)) throw Error("immutable action registration");
    for (const [key, action] of additions.actions) binding2.actions.set(key, action);
  }
  unregister(connection) {
    this.connections.delete(connection);
    this.retired.add(connection);
  }
  /** Trusted recovery service only. Commit the decision before verifying/releasing;
   * this method deliberately cannot mutate outcomes or allocate another attempt. */
  async releaseReconciled(effectKey, verify) {
    const entry = this.retained.get(effectKey);
    if (!entry) return false;
    if (!entry.lease.releaseAfterReconciliation) throw new Error("lease reconciliation unsupported");
    const verification = await verify(snapshot(entry.context));
    if (verification !== void 0) throw new Error("invalid reconciliation authority");
    await entry.lease.releaseAfterReconciliation(() => verify(snapshot(entry.context)));
    this.admissions.released(effectKey, this.options.now?.() ?? Date.now());
    this.retained.delete(effectKey);
    return true;
  }
  authorize(binding2) {
    const result = binding2.authorize();
    if (result !== void 0) {
      void Promise.resolve(result).catch(() => {
      });
      throw new Denied("POLICY_DENIED", "revocation check must be synchronous");
    }
  }
  fence(binding2) {
    const run = this.runs.get(binding2.scope, binding2.graphRunId);
    if (!run) throw new Denied("RUN_MISMATCH", "registered run not found");
    if (run.generation !== binding2.generation || run.leaseOwner !== binding2.owner) throw new Denied("STALE_GENERATION", "registered worker lease changed");
    if (canonical(run.identity) !== canonical(binding2.identity)) throw new Denied("CHECKPOINT_INCOMPATIBLE", "registered program identity changed");
    const permit = this.db.prepare("SELECT max(epoch) AS epoch FROM graph_delivery_epochs WHERE graph_run_id=?").get(run.graphRunId);
    if (permit.epoch === null && binding2.identity.compilerVersion.startsWith("code-delivery-functional-")) throw new Denied("EPOCH_MISMATCH", "delivery epoch permit required");
    if (permit.epoch !== null && permit.epoch !== binding2.epoch) throw new Denied("EPOCH_MISMATCH", "durable delivery epoch changed");
    const now = this.options.now?.() ?? Date.now();
    if (!run.leaseExpiresAt || run.leaseExpiresAt <= now) throw new Denied("STALE_GENERATION", "registered worker lease expired");
    return {
      scope: binding2.scope,
      graphRunId: binding2.graphRunId,
      identity: binding2.identity,
      expectedGeneration: binding2.generation,
      expectedOwner: binding2.owner,
      expectedRevision: run.revision,
      now
    };
  }
  handle(connection, value, options = {}) {
    return this.executeRequest(connection, value, options);
  }
  /** Trusted host command, never part of worker transport. Only this call owns the
   * freshly ledger-allocated retry intent; ordinary replays cannot claim it. */
  async retryAuthorized(connection, effectKey, authorizeRetry, options = {}) {
    const binding2 = this.connections.get(connection);
    if (!binding2) throw new Error("UNAUTHENTICATED");
    this.authorize(binding2);
    const permitted = authorizeRetry();
    if (permitted !== void 0) {
      void Promise.resolve(permitted).catch(() => {
      });
      throw new Error("invalid synchronous retry authority");
    }
    if (options.signal?.aborted) throw new Error("retry cancelled");
    const prior = this.actions.get(this.fence(binding2), effectKey).action;
    const registered = binding2.actions.get(slot(prior.effect.nodeId, prior.effect.effectSlot));
    if (!registered || prior.effect.epoch !== binding2.epoch || canonical(registered.action) !== canonical(prior.action)) throw new Error("unregistered retry slot");
    const replacement = options.replacement ? this.bind({ ...binding2, actions: [options.replacement] }).actions.get(slot(prior.effect.nodeId, prior.effect.effectSlot)) : void 0;
    if (options.replacement && (!replacement || canonical(replacement.action) !== canonical(prior.action) || replacement.tokenReservation !== prior.reservationTokens)) throw Error("immutable retry payload");
    const next = this.actions.retry(this.fence(binding2), effectKey).action;
    if (replacement) binding2.actions.set(slot(prior.effect.nodeId, prior.effect.effectSlot), replacement);
    return this.executeRequest(connection, {
      schemaVersion: 1,
      kind: "worker_action",
      requestId: `retry:${randomUUID()}`,
      scope: binding2.scope,
      graphRunId: binding2.graphRunId,
      generation: binding2.generation,
      specHash: binding2.identity.specHash,
      epoch: binding2.epoch,
      nodeId: prior.effect.nodeId,
      effectSlot: prior.effect.effectSlot,
      action: registered.action
    }, options, { action: next, binding: binding2 }, authorizeRetry);
  }
  async executeRequest(connection, value, options, retry, authorizeRetry) {
    let request;
    try {
      request = snapshot(WorkerActionRequest.parse(value));
    } catch {
      return { schemaVersion: 1, kind: "worker_action_rejected", requestId: "invalid-request", error: graphError("INPUT_CONTRACT_INVALID", "invalid worker action request") };
    }
    const binding2 = this.connections.get(connection) ?? retry?.binding;
    const retryEffectKey = retry?.action.effectKey;
    const signal = options.signal ?? new AbortController().signal;
    let executionWorkspace;
    let lease;
    let owned = retry?.action;
    let invoked = false;
    let uncertain = false;
    let observedTokens = 0;
    let persistedEvidenceRef;
    const reject = (error) => ({
      schemaVersion: 1,
      kind: "worker_action_rejected",
      requestId: request.requestId,
      error: graphError(errorCode(error), String(error))
    });
    try {
      if (!binding2) throw new Denied("UNAUTHENTICATED", "unregistered worker connection");
      if (canonical(request.scope) !== canonical(binding2.scope)) throw new Denied("SCOPE_MISMATCH", "scope does not match registered connection");
      if (request.graphRunId !== binding2.graphRunId) throw new Denied("RUN_MISMATCH", "run does not match registered connection");
      if (request.generation !== binding2.generation) throw new Denied("STALE_GENERATION", "generation does not match registered connection");
      if (request.specHash !== binding2.identity.specHash) throw new Denied("SPEC_MISMATCH", "spec does not match registered program");
      if (request.epoch !== binding2.epoch) throw new Denied("EPOCH_MISMATCH", "epoch does not match registered program");
      const action = binding2.actions.get(slot(request.nodeId, request.effectSlot));
      if (!action) throw new Denied("POLICY_DENIED", "unregistered compiled action slot");
      executionWorkspace = action.workspace;
      if (canonical(action.action) !== canonical(request.action)) throw new Denied("IDEMPOTENCY_CONFLICT", "action differs from immutable compiled registration");
      const check = () => {
        if (this.connections.get(connection) !== binding2) throw new Denied("UNAUTHENTICATED", "worker connection retired");
        if (signal.aborted) throw new Denied("POLICY_DENIED", "action cancelled before invocation");
        this.authorize(binding2);
        this.fence(binding2);
        if (authorizeRetry) {
          const permitted = authorizeRetry();
          if (permitted !== void 0) {
            void Promise.resolve(permitted).catch(() => {
            });
            throw new Denied("POLICY_DENIED", "retry authority must be synchronous");
          }
        }
      };
      check();
      const intent = this.actions.reserve(this.fence(binding2), {
        epoch: binding2.epoch,
        nodeId: action.nodeId,
        effectSlot: action.effectSlot,
        reservationTokens: action.tokenReservation,
        action: action.action
      });
      if (!intent.created && intent.action.effectKey !== retryEffectKey) return this.response(request, intent.action);
      if (retryEffectKey && (intent.action.state !== "intent" || intent.action.generation !== binding2.generation)) {
        return this.response(request, intent.action);
      }
      owned = intent.action;
      lease = await this.options.acquire({
        kind: action.access,
        runId: `graph-action:${owned.effectKey}`,
        workspacePath: action.workspace.workspace_path,
        signal,
        authorize: async () => {
          check();
          await this.options.authorizePolicy?.(action.workspace.workspace_path);
          check();
        }
      });
      this.admissions.hold(owned.effectKey, this.options.now?.() ?? Date.now());
      check();
      const beforeEffect = (executionRunId) => {
        check();
        let started;
        try {
          started = this.actions.markRunning(this.fence(binding2), owned.effectKey, `graph-execution:${owned.effectKey}:${executionRunId}`);
        } catch (error) {
          if (String(error).includes("EXECUTION_CONFLICT")) invoked = true;
          throw error;
        }
        if (!started.changed) {
          invoked = true;
          throw new Denied("ACTION_OUTCOME_UNKNOWN", "intent already started");
        }
        invoked = true;
        return started.action;
      };
      const evidence2 = await this.execute(binding2, action, signal, beforeEffect, (tokens) => {
        observedTokens = Math.max(observedTokens, tokens);
      }, lease);
      if (!invoked) throw new Denied("POLICY_DENIED", "execution did not start");
      const persisted = snapshot(await action.persist(evidence2, { signal }));
      if (typeof persisted.evidenceRef !== "string" || !persisted.evidenceRef || persisted.evidenceRef.trim() !== persisted.evidenceRef || persisted.evidenceRef.length > 256 || Array.from(persisted.evidenceRef).some((char) => {
        const code = char.charCodeAt(0);
        return code < 32 || code >= 127 && code <= 159;
      })) throw new Error("invalid persisted evidence reference");
      persistedEvidenceRef = persisted.evidenceRef;
      if (persisted.actualTokens !== void 0 && (!Number.isSafeInteger(persisted.actualTokens) || persisted.actualTokens < 0)) throw new Error("invalid usage");
      observedTokens = Math.max(observedTokens, persisted.actualTokens ?? 0);
      const usage = evidence2.candidate?.execution;
      const measured = usage?.tokens_in !== void 0 && usage.tokens_out !== void 0 ? usage.tokens_in + usage.tokens_out : void 0;
      if (measured !== void 0 && !Number.isSafeInteger(measured)) throw new Error("invalid total token usage");
      const actualTokens = Math.max(observedTokens, persisted.actualTokens ?? 0, measured ?? Math.max(action.tokenReservation, usage?.tokens_in ?? 0, usage?.tokens_out ?? 0));
      const verification = action.action.kind === "review" || action.action.kind === "tests";
      const failure = persisted.verificationFailure;
      if (failure && (!verification || evidence2.stopped !== true || signal.aborted && failure.retrySafe !== false || persisted.result !== void 0 || !["OUTPUT_CONTRACT_INVALID", "INTERNAL_ERROR"].includes(failure.code) || typeof failure.retrySafe !== "boolean")) throw new Error("invalid verification failure classification");
      const failureError = failure ? GraphErrorSchema.parse({
        schemaVersion: 1,
        code: failure.code,
        message: failure.message,
        retryable: failure.retrySafe,
        nextAction: failure.retrySafe ? "retry" : "stop"
      }) : void 0;
      const normalTestsExit = action.action.kind === "tests" && evidence2.stopped === true && !signal.aborted && (evidence2.command?.termination?.trigger === "exit" && evidence2.command.termination.stop_confirmed && !evidence2.command.cancellation && !evidence2.command.failure_code || evidence2.contained !== void 0 && !evidence2.contained.result.cancelled);
      const completed = !failure && (evidence2.status === "completed" || normalTestsExit && persisted.result !== void 0);
      let result;
      if (completed) {
        result = GraphResult.parse(persisted.result);
        if (action.action.kind === "freeze" && (!evidence2.frozenCandidate || canonical(result) !== canonical(evidence2.frozenCandidate))) throw new Error("freeze result differs from durable artifact");
        const expected = action.action.kind === "freeze" ? "candidate_ready" : action.action.kind === "implement" || action.action.kind === "repair" ? "implementation_complete" : action.action.kind.startsWith("workspace_") ? "workspace" : action.action.kind;
        if (result.kind !== expected) throw new Error("invalid result kind for registered operation");
        if ("workspaceLeaseRef" in result && "workspaceLeaseRef" in action.action && result.workspaceLeaseRef !== action.action.workspaceLeaseRef) throw new Error("persisted workspace mismatch");
        if ("candidateRevision" in result && "candidateRevision" in action.action && result.candidateRevision !== action.action.candidateRevision) throw new Error("persisted revision mismatch");
      }
      const settled = this.actions.recordOutcome(this.fence(binding2), owned.effectKey, completed ? { state: "confirmed", evidenceRef: persisted.evidenceRef, actualTokens, result } : { state: "failed", evidenceRef: persisted.evidenceRef, actualTokens, retrySafe: failure?.retrySafe ?? false, error: GraphJsonValue.parse(failureError ?? { message: "trusted stopped invocation failed" }) });
      return this.response(request, settled.action);
    } catch (error) {
      if (binding2 && owned) {
        if (invoked) {
          uncertain = true;
          lease?.retain(String(error));
          if (lease) this.retained.set(owned.effectKey, { lease, context: {
            effectKey: owned.effectKey,
            scope: binding2.scope,
            graphRunId: binding2.graphRunId,
            generation: binding2.generation,
            owner: binding2.owner,
            workspacePath: executionWorkspace?.workspace_path ?? binding2.workspace.workspace_path
          } });
          try {
            const unknown = this.actions.markUncertain(this.fence(binding2), owned.effectKey, { state: "unknown", evidenceRef: persistedEvidenceRef ?? `unknown:${randomUUID()}`, observedTokens: Math.max(owned.reservationTokens, observedTokens) });
            return this.response(request, unknown.action);
          } catch {
          }
          return {
            schemaVersion: 1,
            kind: "worker_action_response",
            requestId: request.requestId,
            generation: request.generation,
            effect: owned.effect,
            outcome: { state: "unknown", error: graphError("ACTION_OUTCOME_UNKNOWN", String(error)), reconciliationRef: owned.effectKey }
          };
        }
        try {
          this.actions.recordOutcome(this.fence(binding2), owned.effectKey, {
            state: "failed",
            evidenceRef: `not-started:${randomUUID()}`,
            actualTokens: 0,
            retrySafe: !signal.aborted,
            error: { message: "admission refused before invocation" }
          });
        } catch {
        }
      }
      return reject(error);
    } finally {
      if (lease && !uncertain) await this.releaseAdmission(lease, binding2, owned, executionWorkspace);
    }
  }
  async releaseAdmission(lease, binding2, owned, workspace) {
    let physicallyReleased = false;
    try {
      await lease.release();
      physicallyReleased = true;
      if (owned) this.admissions.released(owned.effectKey, this.options.now?.() ?? Date.now());
    } catch (error) {
      if (!physicallyReleased) lease.retain(String(error));
      if (binding2 && owned) this.retained.set(owned.effectKey, { lease, context: {
        effectKey: owned.effectKey,
        scope: binding2.scope,
        graphRunId: binding2.graphRunId,
        generation: binding2.generation,
        owner: binding2.owner,
        workspacePath: workspace?.workspace_path ?? binding2.workspace.workspace_path
      } });
      throw error;
    }
  }
  response(request, action) {
    const base = {
      schemaVersion: 1,
      kind: "worker_action_response",
      requestId: request.requestId,
      generation: request.generation,
      effect: action.effect
    };
    if (action.state === "confirmed") return WorkerActionResponse.parse({ ...base, outcome: { state: "confirmed", result: action.outcome?.state === "confirmed" ? action.outcome.result : void 0 } });
    if (action.state === "failed") {
      const error = GraphErrorSchema.safeParse(action.outcome?.state === "failed" ? action.outcome.error : void 0);
      return WorkerActionResponse.parse({ ...base, outcome: { state: "failed", error: error.success ? error.data : graphError("POLICY_DENIED", "prior invocation failed; no automatic retry") } });
    }
    return { ...base, outcome: { state: "unknown", error: graphError("ACTION_OUTCOME_UNKNOWN", "existing action requires reconciliation; invocation was not repeated"), reconciliationRef: action.effectKey } };
  }
  async execute(binding2, action, signal, beforeEffect, observeTokens, lease) {
    const execution = action.execution;
    const verifyWorkspace = async () => {
      if (action.verifyWorkspace) {
        const valid = await action.verifyWorkspace();
        if (valid !== void 0) throw new Denied("POLICY_DENIED", "invalid workspace authority");
      }
      if (lease?.assertActive) await lease.assertActive();
    };
    if (execution.kind === "freeze") {
      if (!lease?.assertActive) throw new Error("freeze requires canonical lease verification");
      const check = () => {
        if (signal.aborted) throw new Error("freeze cancelled");
        this.authorize(binding2);
        this.fence(binding2);
      };
      await verifyWorkspace();
      check();
      await this.options.authorizePolicy?.(action.workspace.workspace_path);
      check();
      beforeEffect(`freeze:${randomUUID()}`);
      const frozenCandidate = await execution.store.freeze(execution.input, {
        ...execution.authority,
        lease,
        verifyLease: async (input, actualLease) => {
          if (actualLease !== lease) throw new Error("freeze lease identity mismatch");
          check();
          await lease.assertActive();
          check();
          const decision = await execution.authority.verifyLease(input, actualLease);
          if (decision !== void 0) throw new Error("invalid freeze authority");
          check();
        }
      });
      return { status: "completed", frozenCandidate };
    }
    if (execution.kind === "workspace") {
      await verifyWorkspace();
      await this.options.authorizePolicy?.(action.workspace.workspace_path);
      beforeEffect(`workspace:${randomUUID()}`);
      const result = await execution.handler({ workspace: action.workspace, signal, lease });
      if (result?.stopped !== true || !["completed", "failed"].includes(result.status)) throw new Error("workspace outcome unconfirmed");
      return { status: result.status, stopped: true, workspace: result.evidence };
    }
    const commandTerminationGraceMs = 1e3;
    const commandKillGraceMs = 1e3;
    let contained;
    const authorizeContained = () => {
      if (signal.aborted) throw Error("contained execution cancelled");
      this.authorize(binding2);
      this.fence(binding2);
    };
    let threw = false;
    let command;
    let commandPending;
    let invocationRunId;
    const original = execution.kind === "adapter" ? execution.adapter : void 0;
    const capabilities = execution.kind === "adapter" ? execution.adapter.capabilities().filter((cap) => cap.id === execution.capabilityId) : [CapabilitySchema.parse({ id: "registered-command.write", kind: "code.write", agent_id: "registered-command", description: "Registered command" })];
    const policy = this.options.authorizePolicy;
    const cumulativeUsage = { tokens_in: 0, tokens_out: 0 };
    const wrapper = {
      id: original?.id ?? "registered-command",
      display_name: "Governed graph action",
      cost_tier: "low",
      capabilities: () => capabilities,
      isAvailable: original?.isAvailable ?? (async () => ({ available: true, last_checked_at: 0 })),
      invoke: (task, invocationSignal) => {
        return (async function* () {
          await verifyWorkspace();
          await policy?.(action.workspace.workspace_path);
          if (invocationSignal.aborted) throw new Denied("POLICY_DENIED", "execution cancelled before invocation");
          const effect = beforeEffect(task.run_id);
          invocationRunId = task.run_id;
          try {
            if (original) {
              for await (const event of original.invoke(task, invocationSignal)) {
                const payload = event.type === "usage.updated" || event.type === "usage.final" ? event.payload : event.type === "done" && event.payload && typeof event.payload === "object" ? event.payload.usage : void 0;
                if (payload !== void 0) {
                  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid adapter usage payload");
                  const usage2 = payload;
                  let tokens = 0;
                  for (const field of ["tokens_in", "tokens_out"]) {
                    const amount = usage2[field];
                    if (amount !== void 0) {
                      if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) throw new Error("invalid adapter token usage");
                      cumulativeUsage[field] = Math.max(cumulativeUsage[field], amount);
                    }
                  }
                  tokens = cumulativeUsage["tokens_in"] + cumulativeUsage["tokens_out"];
                  if (!Number.isSafeInteger(tokens)) throw new Error("invalid adapter total usage");
                  observeTokens(tokens);
                  const cost = usage2["cost_usd"];
                  if (cost !== void 0 && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) throw new Error("invalid adapter cost usage");
                }
                yield event;
              }
              return;
            }
            if (execution.kind === "contained") {
              contained = await execution.execute({ scope: binding2.scope, graphRunId: binding2.graphRunId, generation: binding2.generation, effectKey: effect.effectKey, invocationId: task.run_id }, invocationSignal, authorizeContained);
              yield {
                event_id: randomUUID(),
                run_id: task.run_id,
                session_id: task.session_id,
                seq: 1,
                type: "done",
                created_at: Date.now() / 1e3,
                terminal: true,
                payload: { status: contained.result.cancelled ? "cancelled" : contained.result.exitCode === 0 ? "completed" : "failed", last_seq: 0 }
              };
              return;
            }
            if (execution.kind !== "command") throw new Error("invalid execution registration");
            commandPending = runShellCommand(execution.command, {
              cwd: action.workspace.workspace_path,
              timeoutMs: 12e4,
              terminationGraceMs: commandTerminationGraceMs,
              killGraceMs: commandKillGraceMs,
              outputLimit: 16e3,
              ...invocationSignal ? { signal: invocationSignal } : {}
            });
            command = await commandPending;
            yield {
              event_id: randomUUID(),
              run_id: task.run_id,
              session_id: task.session_id,
              seq: 1,
              type: "done",
              created_at: Date.now() / 1e3,
              terminal: true,
              payload: { status: command.exitCode === 0 ? "completed" : "failed", last_seq: 0 }
            };
          } catch (error) {
            threw = true;
            throw error;
          }
        })();
      },
      confirmStopped: async (runId) => {
        if (execution.kind === "contained") return execution.confirmStopped(runId);
        if (original) return original.confirmStopped ? original.confirmStopped(runId) : { stopped: false };
        const stoppedCommand = command ?? await commandPending;
        return { stopped: stoppedCommand?.termination?.stop_confirmed === true, evidence: stoppedCommand?.termination?.evidence ?? "no trusted stop receipt" };
      }
    };
    const candidate = await executeCandidateImplementation({
      plan: { ...execution.plan, agent_id: wrapper.id },
      workspace: action.workspace,
      adapters: [wrapper],
      signal,
      // Command confirmation includes TERM/KILL grace, process-group probes and
      // pipe drainage. The outer adapter must not time out after only 50ms.
      cancellationGraceMs: execution.kind === "contained" ? 3e4 : execution.kind === "command" ? commandTerminationGraceMs + commandKillGraceMs + 500 : 50,
      authorize: async () => {
        this.authorize(binding2);
        this.fence(binding2);
        await policy?.(action.workspace.workspace_path);
        this.authorize(binding2);
        this.fence(binding2);
        return { allow: true };
      }
    });
    if (!invocationRunId) throw new Denied("POLICY_DENIED", candidate.reason ?? "candidate preflight refused");
    if (threw || candidate.status === "execution_unconfirmed" || candidate.execution?.failure_code) throw new Error("adapter result or execution unconfirmed");
    let stopTimer;
    const stopped = await Promise.race([
      wrapper.confirmStopped(invocationRunId),
      new Promise((resolve2) => {
        stopTimer = setTimeout(() => resolve2({ stopped: false }), 1e3);
      })
    ]).finally(() => {
      if (stopTimer) clearTimeout(stopTimer);
    });
    if (stopped.stopped !== true || !stopped.evidence?.trim()) throw new Error("external stop unconfirmed");
    const usage = candidate.execution;
    if ([usage?.tokens_in, usage?.tokens_out].some((value) => value !== void 0 && (!Number.isSafeInteger(value) || value < 0))) throw new Error("invalid adapter usage");
    return { status: candidate.status === "implementation_complete" ? "completed" : "failed", stopped: true, ...["implement", "repair"].includes(action.action.kind) ? { stopEvidenceRef: stopped.evidence } : {}, candidate, ...command ? { command } : {}, ...contained ? { contained } : {} };
  }
};

// packages/cli/src/graph-runtime.ts
import { GraphRunStore as GraphRunStore4 } from "@osstack/core";
import { workerCanonical as workerCanonical5, freezeWorkerData as freezeWorkerData2 } from "@osstack/protocol";

// packages/cli/src/graph-process-journal.ts
import { GraphRunStore as GraphRunStore3 } from "@osstack/core";
import { GraphWorkerBinding as GraphWorkerBinding2, workerCanonical as workerCanonical2 } from "@osstack/protocol";

// packages/cli/src/graph-process-identity.ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
function validPid(pid2) {
  if (!Number.isSafeInteger(pid2) || pid2 < 1) throw new Error("GRAPH_PROCESS_PID");
}
function linuxIdentity(pid2) {
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const stat = readFileSync(`/proc/${pid2}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  const pgid = Number(fields[2]);
  const startTicks = fields[19];
  if (!bootId || !startTicks || !/^\d+$/.test(startTicks) || !Number.isSafeInteger(pgid) || pgid < 1 || Number(stat.slice(0, stat.indexOf(" "))) !== pid2) throw new Error("GRAPH_PROCESS_STAT");
  return { kind: "linux", pid: pid2, pgid, bootId, startTicks };
}
function captureGraphProcessIdentity(pid2) {
  validPid(pid2);
  try {
    if (process.platform === "linux") return linuxIdentity(pid2);
    if (process.platform === "darwin") {
      const detail = execFileSync(
        "/bin/ps",
        ["-p", String(pid2), "-o", "pgid=", "-o", "lstart="],
        { encoding: "utf8", timeout: 1e3, stdio: ["ignore", "pipe", "pipe"], env: { LC_ALL: "C" } }
      ).trim();
      const pgid = Number(detail.split(/\s+/)[0]);
      return {
        kind: "unverifiable",
        pid: pid2,
        pgid: Number.isSafeInteger(pgid) && pgid > 0 ? pgid : null,
        platform: process.platform,
        detail: `coarse_lstart:${detail}`
      };
    }
  } catch {
  }
  return { kind: "unverifiable", pid: pid2, pgid: null, platform: process.platform, detail: "os_identity_unavailable" };
}
function compareGraphProcessIdentity(saved, current) {
  if (saved.kind !== "linux" || current.kind !== "linux") return { state: "unknown", reason: "identity_unverifiable" };
  if (saved.pid !== current.pid || saved.pgid !== current.pgid || saved.bootId !== current.bootId || saved.startTicks !== current.startTicks) {
    return { state: "unknown", reason: "identity_mismatch" };
  }
  return { state: "running", reason: "same_linux_process" };
}
function observeGraphProcessIdentity(saved) {
  try {
    validPid(saved.pid);
  } catch {
    return { state: "unknown", reason: "identity_invalid" };
  }
  if (saved.kind !== "linux" || process.platform !== "linux") return { state: "unknown", reason: "identity_unverifiable" };
  try {
    if (readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== saved.bootId) return { state: "unknown", reason: "boot_identity_mismatch" };
    try {
      return compareGraphProcessIdentity(saved, linuxIdentity(saved.pid));
    } catch (error) {
      if (error.code === "ENOENT") return { state: "absent", reason: "leader_absent_only" };
      throw error;
    }
  } catch {
    return { state: "unknown", reason: "os_identity_unavailable" };
  }
}

// packages/cli/src/graph-process-journal.ts
var GraphProcessJournal = class {
  constructor(db) {
    this.db = db;
  }
  db;
  binding(value) {
    const binding2 = GraphWorkerBinding2.parse(value);
    const run = new GraphRunStore3(this.db).get(binding2.scope, binding2.graphRunId);
    if (!run || workerCanonical2(run.identity) !== workerCanonical2(binding2.identity)) throw new Error("GRAPH_PROCESS_BINDING");
    return binding2;
  }
  intent(binding2) {
    const row = this.db.prepare("SELECT owner, identity_json FROM graph_worker_launches WHERE graph_run_id = ? AND generation = ?").get(binding2.graphRunId, binding2.generation);
    if (!row) return false;
    if (row.owner !== binding2.owner || row.identity_json !== workerCanonical2(binding2.identity)) throw new Error("GRAPH_PROCESS_BINDING");
    return true;
  }
  consume(value) {
    const binding2 = this.binding(value);
    if (this.intent(binding2)) throw new Error("GRAPH_GENERATION_ALREADY_LAUNCHED");
    this.db.prepare("INSERT INTO graph_worker_launches(graph_run_id,generation,owner,identity_json,launched_at) VALUES (?,?,?,?,?)").run(binding2.graphRunId, binding2.generation, binding2.owner, workerCanonical2(binding2.identity), Date.now());
  }
  append(value, event) {
    const binding2 = this.binding(value);
    if (!this.intent(binding2)) throw new Error("GRAPH_PROCESS_INTENT_REQUIRED");
    const eventJson = workerCanonical2(JSON.parse(JSON.stringify(event)));
    this.db.prepare("INSERT INTO graph_worker_process_events(graph_run_id,generation,kind,event_json,observed_at) VALUES (?,?,?,?,?)").run(binding2.graphRunId, binding2.generation, event.kind, eventJson, Date.now());
  }
  launched(binding2, launch) {
    if (!Number.isSafeInteger(launch.pid) || launch.pid < 1 || launch.processIdentity.pid !== launch.pid || launch.pgid !== null && (!Number.isSafeInteger(launch.pgid) || launch.pgid < 1) || launch.processIdentity.pgid !== null && launch.processIdentity.pgid !== launch.pgid) throw new Error("GRAPH_PROCESS_LAUNCH_IDENTITY");
    this.append(binding2, { kind: "launched", launch });
  }
  observed(binding2, evidence2) {
    if (evidence2.kind !== "exit_unconfirmed" && (evidence2.graphRunId !== binding2.graphRunId || evidence2.generation !== binding2.generation || evidence2.owner !== binding2.owner)) throw new Error("GRAPH_PROCESS_BINDING");
    this.append(binding2, evidence2);
  }
  observe(value) {
    const binding2 = this.binding(value);
    const intentRecorded = this.intent(binding2);
    const rows = this.db.prepare("SELECT event_json FROM graph_worker_process_events WHERE graph_run_id = ? AND generation = ? ORDER BY sequence").all(binding2.graphRunId, binding2.generation);
    const events = rows.map((row) => JSON.parse(row.event_json));
    const launch = events.find((event) => event.kind === "launched")?.launch ?? null;
    const observations = events.filter((event) => event.kind !== "launched");
    const leader = launch ? observeGraphProcessIdentity(launch.processIdentity) : observations.some((event) => event.kind === "spawn_failed") ? { state: "absent", reason: "authenticated_no_child" } : { state: "unknown", reason: intentRecorded ? "launch_window_unobserved" : "no_launch_intent" };
    return {
      binding: binding2,
      intentRecorded,
      launch,
      observations,
      leader,
      executors: { state: "unknown", reason: "opaque_adapters_and_descendants_unproven" },
      recovery: "held"
    };
  }
};

// packages/cli/src/graph-reconciler.ts
import { z as z2 } from "zod";
import { GraphJsonValue as GraphJsonValue2 } from "@osstack/protocol";
import {
  GraphRecoveryStore
} from "@osstack/core/graph-recovery";
var ref = z2.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f-\x9f]+$/).refine((s) => s.trim() === s);
var requestSchema = z2.discriminatedUnion("kind", [
  z2.object({ kind: z2.literal("effect"), fence: z2.unknown(), receiptId: ref, effectKey: z2.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z2.object({ kind: z2.literal("project"), fence: z2.unknown(), receiptId: ref, status: z2.enum(["cancel_pending", "cancelled", "waiting_input", "running"]) }).strict(),
  z2.object({ kind: z2.literal("takeover"), fence: z2.unknown(), receiptId: ref, owner: ref, leaseExpiresAt: z2.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict()
]);
function canonical2(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical2).join(",")}]`;
  const r = v;
  return `{${Object.keys(r).sort().map((k) => `${JSON.stringify(k)}:${canonical2(r[k])}`).join(",")}}`;
}
var fail = (code) => {
  throw new Error(code);
};
var authority = (value) => {
  if (value === void 0) return;
  void Promise.resolve(value).catch(() => void 0);
  fail("INVALID_RECOVERY_AUTHORITY");
};
var GraphReconciler = class {
  constructor(db, now = Date.now) {
    this.now = now;
    this.store = new GraphRecoveryStore(db, (snapshot3, proof, decision) => {
      const attestation = this.attestation;
      if (!attestation || canonical2(attestation.snapshot) !== canonical2(snapshot3) || canonical2(attestation.proof) !== canonical2(proof) || canonical2(attestation.decision) !== canonical2(decision)) fail("UNVERIFIED_RECOVERY_PROOF");
      this.check(attestation.connection, attestation.registration, snapshot3);
      authority(attestation.registration.recheck(structuredClone(snapshot3), structuredClone(proof), structuredClone(decision)));
    });
  }
  now;
  registrations = /* @__PURE__ */ new Map();
  store;
  attestation;
  register(connection, registration) {
    if (!connection || typeof connection !== "object" || this.registrations.has(connection)) fail("INVALID_RECOVERY_REGISTRATION");
    for (const name of ["authorize", "stopWorker", "verifyWorker", "verifyQuiescence", "verifyOutcome", "recheck", "release"]) {
      if (typeof registration[name] !== "function") fail("INVALID_RECOVERY_REGISTRATION");
    }
    this.registrations.set(connection, { ...registration, binding: structuredClone(registration.binding) });
  }
  unregister(connection) {
    this.registrations.delete(connection);
  }
  check(connection, registration, snapshot3) {
    if (this.registrations.get(connection) !== registration) fail("RECOVERY_REGISTRATION_REVOKED");
    const run = snapshot3.run;
    if (canonical2(registration.binding) !== canonical2({
      scope: run.scope,
      graphRunId: run.graphRunId,
      generation: run.generation,
      owner: run.leaseOwner,
      identity: run.identity
    })) fail("RECOVERY_BINDING_MISMATCH");
    authority(registration.authorize(structuredClone(snapshot3)));
  }
  async proof(connection, registration, snapshot3) {
    this.check(connection, registration, snapshot3);
    const stop = await registration.stopWorker(structuredClone(snapshot3));
    this.check(connection, registration, snapshot3);
    const worker = structuredClone(await registration.verifyWorker(structuredClone(snapshot3), stop));
    this.check(connection, registration, snapshot3);
    const quiescence = structuredClone(await registration.verifyQuiescence(structuredClone(snapshot3), structuredClone(worker)));
    this.check(connection, registration, snapshot3);
    if (!quiescence || typeof quiescence !== "object" || Array.isArray(quiescence) || Object.keys(quiescence).some((key) => !["executorEvidenceRef", "workspaceEvidenceRef", "effectWorker"].includes(key))) fail("INVALID_QUIESCENCE_PROOF");
    const proof = { ...quiescence, worker, snapshotDigest: snapshot3.digest, verifiedAt: this.now() };
    return proof;
  }
  verified(connection, registration, snapshot3, proof, decision, fn) {
    if (this.attestation) fail("NESTED_RECOVERY");
    this.attestation = { connection, registration, snapshot: structuredClone(snapshot3), proof: structuredClone(proof), decision: structuredClone(decision) };
    try {
      return fn();
    } finally {
      this.attestation = void 0;
    }
  }
  async release(connection, registration, result) {
    const reverify = async (completed = false) => {
      const run = result.run;
      const snapshot3 = this.store.snapshot({
        scope: run.scope,
        graphRunId: run.graphRunId,
        identity: run.identity,
        expectedGeneration: run.generation,
        expectedRevision: run.revision,
        expectedOwner: run.leaseOwner,
        now: this.now()
      }, result.action?.effectKey);
      const proof = await this.proof(connection, registration, snapshot3);
      this.verified(connection, registration, snapshot3, proof, result.record.decision, () => completed ? this.store.completeRelease(snapshot3, result.record.decision.receiptId, proof, this.now()) : this.store.verifyRelease(snapshot3, result.record.decision.receiptId, proof, this.now()));
    };
    await reverify();
    authority(await registration.release(structuredClone(result), () => reverify()));
    await reverify(true);
  }
  async reconcile(connection, value) {
    const request = requestSchema.parse(GraphJsonValue2.parse(value));
    const registration = this.registrations.get(connection) ?? fail("RECOVERY_REGISTRATION_REQUIRED");
    const snapshot3 = this.store.snapshot(request.fence, request.kind === "effect" ? request.effectKey : void 0);
    this.check(connection, registration, snapshot3);
    const prior = this.store.history(request.fence).find((r) => r.decision.receiptId === request.receiptId);
    if (prior && prior.snapshot.action?.effectKey !== snapshot3.action?.effectKey) fail("DECISION_CONFLICT");
    if (prior && prior.snapshot.run.generation !== snapshot3.run.generation) {
      if (request.kind === "takeover" && prior.decision.kind === "takeover") {
        if (request.owner !== prior.decision.owner || request.leaseExpiresAt !== prior.decision.leaseExpiresAt) fail("DECISION_CONFLICT");
        if (snapshot3.run.generation === prior.snapshot.run.generation + 1 && snapshot3.run.leaseOwner === prior.decision.owner) {
          return { exit: "takeover", result: { run: snapshot3.run, action: snapshot3.action, record: prior, changed: false } };
        }
      }
      fail("RECOVERY_GENERATION_CHANGED");
    }
    const proof = await this.proof(connection, registration, snapshot3);
    let decision;
    if (request.kind === "effect") {
      const received = structuredClone(await registration.verifyOutcome(structuredClone(snapshot3)));
      const verdict = received && received.outcome !== "unknown" && (typeof received.actualTokens !== "number" || !Number.isSafeInteger(received.actualTokens) || received.actualTokens < 0) ? { ...received, actualTokens: null } : received;
      this.check(connection, registration, snapshot3);
      decision = { kind: "effect", receiptId: request.receiptId, verdict };
    } else if (request.kind === "project") decision = { kind: "project", receiptId: request.receiptId, status: request.status };
    else decision = { kind: "takeover", receiptId: request.receiptId, owner: request.owner, leaseExpiresAt: request.leaseExpiresAt };
    proof.verifiedAt = this.now();
    let result;
    if (prior) {
      if (canonical2(prior.decision) !== canonical2(decision)) fail("DECISION_CONFLICT");
      result = this.verified(connection, registration, snapshot3, proof, decision, () => this.store.verifyDecision(snapshot3, request.receiptId, proof, this.now()));
    } else result = this.verified(connection, registration, snapshot3, proof, decision, () => this.store.commit(snapshot3, decision, proof, this.now()));
    const exit = decision.kind === "effect" ? decision.verdict.outcome : decision.kind === "project" ? "projected" : "takeover";
    if (exit === "unknown" || decision.kind !== "effect") return { exit, result };
    try {
      await this.release(connection, registration, result);
    } catch (error) {
      return { exit: "release_pending", result, releaseError: error instanceof Error ? error.message : "release failed" };
    }
    return { exit, result };
  }
};

// packages/cli/src/graph-unstarted-recovery.ts
import { GraphRecoveryStore as GraphRecoveryStore2 } from "@osstack/core/graph-recovery";
import { GraphWorkerBinding as GraphWorkerBinding3, workerCanonical as workerCanonical3 } from "@osstack/protocol";
async function recoverUnstartedGraphWorker(db, reconciler, value, authorize) {
  return reconcileUnstarted(db, reconciler, { ...value, kind: "takeover" }, authorize);
}
async function cancelUnstartedGraphWorker(db, reconciler, value, authorize) {
  return reconcileUnstarted(db, reconciler, { ...value, kind: "project", status: "cancelled" }, authorize);
}
async function reconcileUnstarted(db, reconciler, value, authorize) {
  const request = structuredClone(value);
  const binding2 = GraphWorkerBinding3.parse({
    scope: request.fence.scope,
    graphRunId: request.fence.graphRunId,
    identity: request.fence.identity,
    generation: request.fence.expectedGeneration,
    owner: request.fence.expectedOwner
  });
  const store = new GraphRecoveryStore2(db, () => {
    throw Error("GRAPH_NO_CHILD_INSPECTION_ONLY");
  });
  let inventory;
  const verify = (snapshot3) => {
    const deadline = snapshot3.run.spec && snapshot3.run.createdAt + snapshot3.run.spec.limits.deadlineSeconds * 1e3;
    if (request.kind === "takeover" && (!deadline || Date.now() >= deadline || request.leaseExpiresAt > deadline)) throw Error("GRAPH_DEADLINE_EXCEEDED");
    for (const table of ["graph_actions", "graph_action_admissions", "graph_checkpoints", "graph_checkpoint_writes", "graph_checkpoint_requests"]) {
      if (db.prepare(`SELECT 1 FROM ${table} WHERE graph_run_id=? LIMIT 1`).get(binding2.graphRunId)) {
        throw Error("GRAPH_EXECUTOR_ABSENCE_REQUIRED");
      }
    }
    inventory ??= store.inspectExecutors(snapshot3.fence);
    if (db.inTransaction) store.assertExecutorInventory(inventory);
    else if (store.inspectExecutors(snapshot3.fence).digest !== inventory.digest) throw Error("RECOVERY_INVENTORY_CHANGED");
    const proofs = inventory.workers.map((worker) => verifyJournaledGraphWorkerNotStarted(
      db,
      { ...binding2, generation: worker.generation, owner: worker.owner }
    ));
    const current = proofs.at(-1);
    if (!current || current.generation !== binding2.generation || current.owner !== binding2.owner) throw Error("GRAPH_NO_CHILD_PROOF_REQUIRED");
    return current;
  };
  const connection = {};
  reconciler.register(connection, {
    binding: binding2,
    authorize,
    stopWorker: async () => void 0,
    // No signal is necessary or authorized by a no-child proof.
    verifyWorker: async (snapshot3) => verify(snapshot3),
    verifyQuiescence: async (snapshot3) => {
      verify(snapshot3);
      return { executorEvidenceRef: `no-admitted-executor:${inventory.digest}`, workspaceEvidenceRef: `no-admitted-producer:${inventory.digest}` };
    },
    verifyOutcome: async () => {
      throw Error("GRAPH_NO_EFFECT_RECONCILIATION");
    },
    recheck: (snapshot3, proof) => {
      if (workerCanonical3(verify(snapshot3)) !== workerCanonical3(proof.worker)) throw Error("GRAPH_NO_CHILD_PROOF_REQUIRED");
    },
    release: async () => {
      throw Error("GRAPH_NO_RESOURCE_RELEASE");
    }
  });
  try {
    return await reconciler.reconcile(connection, request);
  } finally {
    reconciler.unregister(connection);
  }
}

// packages/cli/src/graph-worker-manager.ts
import { spawn } from "node:child_process";
import { createHash as createHash2, randomUUID as randomUUID2 } from "node:crypto";
import { existsSync, readFileSync as readFileSync2 } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GraphWorkerBinding as GraphWorkerBinding4,
  GraphWorkerMessage,
  GraphWorkerResume,
  GraphJsonValue as GraphJsonValue3,
  StartGraphRequest,
  WorkerActionRequest as WorkerActionRequest2,
  WorkerFramedTransport,
  computeGraphInputDigest,
  parseGraphCheckpointRequest,
  parseGraphCheckpointResponse,
  validateWorkerActionResponse,
  workerCanonical as workerCanonical4,
  freezeWorkerData
} from "@osstack/protocol";
function deferred() {
  let resolve2;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve2 = res;
    reject = rej;
  });
  void promise.catch(() => {
  });
  return { promise, resolve: resolve2, reject };
}
function boundedOption(value, fallback, max) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error("WORKER_OPTION_INVALID");
  return result;
}
function resolveGraphWorkerEntry() {
  try {
    return fileURLToPath(import.meta.resolve("@osstack/graph/worker"));
  } catch {
    const sibling = fileURLToPath(new URL("../../graph/dist/worker-entry.js", import.meta.url));
    if (existsSync(sibling)) return sibling;
    throw new Error("GRAPH_WORKER_NOT_INSTALLED");
  }
}
var GraphWorkerManager = class {
  programs = /* @__PURE__ */ new Map();
  runs = /* @__PURE__ */ new Map();
  options;
  constructor(options) {
    assertGraphPlatform();
    this.options = Object.freeze({ ...options });
    for (const item of options.programs) {
      if (!item.id || item.id.length > 256 || this.programs.has(item.id) || !/^[a-f0-9]{64}$/.test(item.digest)) throw new Error("WORKER_PROGRAM_INVALID");
      const bytes = readFileSync2(item.modulePath);
      if (bytes.length > 131072) throw new Error("WORKER_PROGRAM_LIMIT");
      const source = bytes.toString("utf8");
      if (createHash2("sha256").update(bytes).digest("hex") !== item.digest || !bytes.equals(Buffer.from(source))) throw new Error("PROGRAM_IDENTITY");
      this.programs.set(item.id, Object.freeze({ source, digest: item.digest }));
    }
  }
  start(value) {
    const binding2 = freezeWorkerData(GraphWorkerBinding4.parse(value.binding));
    const input = freezeWorkerData(StartGraphRequest.parse(value.input));
    const resume = value.resume === void 0 ? void 0 : freezeWorkerData(GraphWorkerResume.parse(value.resume));
    const programId = value.programId;
    const program = this.programs.get(programId);
    if (!program || program.digest !== binding2.identity.compiledProgramDigest || binding2.identity.engineVersion !== "1.4.15" || binding2.identity.checkpointVersion !== "1.1.5") throw new Error("PROGRAM_IDENTITY");
    if (computeGraphInputDigest(input) !== binding2.identity.inputDigest || workerCanonical4(input.scope) !== workerCanonical4(binding2.scope) || createHash2("sha256").update(`osstack.graph.spec.v1
${workerCanonical4(input.spec)}`).digest("hex") !== binding2.identity.specHash) throw new Error("INPUT_IDENTITY");
    const previous = this.runs.get(binding2.graphRunId);
    if (previous?.active) throw new Error("WORKER_ALREADY_ACTIVE");
    if (previous && (workerCanonical4(previous.binding.identity) !== workerCanonical4(binding2.identity) || workerCanonical4(previous.binding.scope) !== workerCanonical4(binding2.scope) || previous.programId !== programId || previous.input !== computeGraphInputDigest(input))) throw new Error("PROGRAM_IDENTITY");
    if (previous && previous.binding.generation >= binding2.generation) throw new Error("STALE_GENERATION");
    const authorize = value.authorize;
    const action = value.action;
    const checkpoint = value.checkpoint;
    const checkAuthority = () => {
      const decision = authorize();
      if (decision && typeof decision.then === "function") {
        void Promise.resolve(decision).catch(() => {
        });
        throw new Error("WORKER_AUTHORITY_MUST_BE_SYNC");
      }
      const expiry = decision?.leaseExpiresAt;
      if (typeof expiry !== "number" || !Number.isSafeInteger(expiry) || expiry <= Date.now()) throw new Error("LEASE_EXPIRED");
    };
    checkAuthority();
    const heartbeatMs = boundedOption(this.options.heartbeatTimeoutMs, 5e3, 6e4);
    const startupMs = boundedOption(this.options.startupTimeoutMs, 1e4, 6e4);
    const shutdownMs = boundedOption(this.options.shutdownTimeoutMs, 1e3, 6e4);
    const terminationMs = boundedOption(this.options.terminationTimeoutMs, 1e3, 6e4);
    const maxInFlight = boundedOption(this.options.maxInFlight, 16, 64);
    const maxLogBytes = boundedOption(this.options.maxLogBytes, 16384, 1048576);
    const requestTimeoutMs = boundedOption(this.options.requestTimeoutMs, 3e4, 3e5);
    const entry = this.options.workerEntry ?? resolveGraphWorkerEntry();
    const ready = deferred();
    const result = deferred();
    const exit = deferred();
    const finalExit = deferred();
    const lifecycle = value.lifecycle ? { ...value.lifecycle } : void 0;
    const persist = (callback) => {
      const returned = callback?.();
      if (returned !== void 0) {
        void Promise.resolve(returned).catch(() => {
        });
        throw new Error("WORKER_LIFECYCLE_MUST_BE_SYNC");
      }
    };
    const observe = (evidence2) => {
      try {
        persist(lifecycle ? () => lifecycle.observed(freezeWorkerData(structuredClone(evidence2))) : void 0);
      } catch (error) {
        const journalError = `WORKER_JOURNAL_FAILED: ${String(error)}`;
        ready.reject(new Error(journalError));
        result.reject(new Error(journalError));
        return { ...evidence2, journalError };
      }
      return evidence2;
    };
    const connection = Object.freeze({});
    const abort = new AbortController();
    const record = { binding: binding2, programId, input: computeGraphInputDigest(input), active: true };
    this.runs.set(binding2.graphRunId, record);
    let child;
    let transport;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let registered = false;
    let stopping = false;
    let observedExit = false;
    let didReady = false;
    let didDone = false;
    const startedAt = Date.now();
    let lastHeartbeat = startedAt;
    let lastRequest = 0;
    const pending = /* @__PURE__ */ new Set();
    const timers = [];
    let monitor;
    const clear = () => {
      timers.forEach(clearTimeout);
      if (monitor) clearInterval(monitor);
    };
    const append = (prior, chunk) => chunk.length >= maxLogBytes ? Buffer.from(chunk.subarray(chunk.length - maxLogBytes)) : Buffer.concat([prior.subarray(Math.max(0, prior.length + chunk.length - maxLogBytes)), chunk]);
    const cancel = (reason = "WORKER_CANCELLED") => {
      if (stopping || observedExit) return;
      stopping = true;
      abort.abort();
      ready.reject(new Error(reason));
      result.reject(new Error(reason));
      try {
        transport?.send({ kind: "cancel", binding: binding2, reason: reason.slice(0, 4096) });
      } catch {
      }
      const kill = (signal) => {
        if (!observedExit) {
          try {
            child?.kill(signal);
          } catch {
          }
        }
      };
      timers.push(setTimeout(() => {
        kill("SIGTERM");
        timers.push(setTimeout(() => {
          kill("SIGKILL");
          timers.push(setTimeout(() => {
            if (!observedExit) {
              transport?.close();
              child?.stdout?.destroy();
              child?.stderr?.destroy();
              const evidence2 = { kind: "exit_unconfirmed", pid: child?.pid, error: "WORKER_EXIT_UNCONFIRMED" };
              exit.resolve(observe(evidence2));
              clear();
            }
          }, terminationMs));
        }, terminationMs));
      }, shutdownMs));
    };
    const assertActive = () => {
      if (stopping || observedExit || this.runs.get(binding2.graphRunId) !== record) throw new Error("STALE_GENERATION");
      checkAuthority();
    };
    const processRequest = async (message) => {
      try {
        assertActive();
        let payload;
        if (message.method === "action") {
          const request = WorkerActionRequest2.parse(message.payload);
          if (request.graphRunId !== binding2.graphRunId || request.generation !== binding2.generation || request.specHash !== binding2.identity.specHash || workerCanonical4(request.scope) !== workerCanonical4(binding2.scope)) throw new Error("WORKER_IDENTITY");
          payload = validateWorkerActionResponse(request, await action(connection, request, { signal: abort.signal }));
        } else {
          const request = parseGraphCheckpointRequest(message.payload);
          if (request.threadId !== binding2.graphRunId) throw new Error("WORKER_IDENTITY");
          payload = parseGraphCheckpointResponse(await checkpoint(connection, request));
          if (payload.kind !== request.kind) throw new Error("WORKER_RESPONSE_MISMATCH");
        }
        assertActive();
        transport.send({ kind: "response", binding: binding2, id: message.id, ok: true, payload });
      } catch (error) {
        try {
          assertActive();
          transport.send({ kind: "response", binding: binding2, id: message.id, ok: false, error: String(error).slice(0, 4096) });
        } catch {
          cancel("STALE_GENERATION");
        }
      } finally {
        pending.delete(message.id);
      }
    };
    const receive = (raw) => {
      const message = GraphWorkerMessage.parse(raw);
      if (workerCanonical4(message.binding) !== workerCanonical4(binding2)) throw new Error("WORKER_IDENTITY");
      assertActive();
      if (message.kind === "ready") {
        if (didReady) throw new Error("WORKER_READY_DUPLICATE");
        didReady = true;
        lastHeartbeat = Date.now();
        ready.resolve();
      } else if (message.kind === "heartbeat") {
        lastHeartbeat = Date.now();
      } else if (message.kind === "done") {
        if (didDone || message.ok && (!didReady || pending.size > 0)) throw new Error("WORKER_DONE_UNEXPECTED");
        didDone = true;
        if (message.ok) result.resolve(GraphJsonValue3.parse(message.value));
        else result.reject(new Error(message.error ?? "WORKER_INVOKE_FAILED"));
        cancel(message.ok ? "WORKER_FINISHED" : message.error ?? "WORKER_INVOKE_FAILED");
      } else if (message.kind === "request") {
        if (!didReady || pending.size >= maxInFlight) throw new Error("WORKER_BACKPRESSURE");
        const seq = Number(message.id);
        if (!Number.isSafeInteger(seq) || seq <= lastRequest || String(seq) !== message.id) throw new Error("WORKER_REQUEST_REPLAY");
        lastRequest = seq;
        pending.add(message.id);
        void processRequest(message).catch((error) => cancel(String(error)));
      } else throw new Error("WORKER_MESSAGE_UNEXPECTED");
    };
    const handle = Object.freeze({
      connection,
      binding: binding2,
      ready: ready.promise,
      result: result.promise,
      exit: exit.promise,
      finalExit: finalExit.promise,
      cancel,
      stop: (reason) => {
        cancel(reason);
        return exit.promise;
      },
      logs: () => ({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") })
    });
    const spawnFailed = (error) => {
      if (child?.pid) {
        cancel(String(error));
        return;
      }
      observedExit = true;
      record.active = false;
      abort.abort();
      clear();
      transport?.close();
      ready.reject(error);
      result.reject(error);
      const evidence2 = {
        kind: "spawn_failed",
        graphRunId: binding2.graphRunId,
        generation: binding2.generation,
        owner: binding2.owner,
        confirmedAt: Date.now(),
        evidenceRef: `worker-not-started:${randomUUID2()}`,
        phase: registered ? "spawn" : "registration",
        error: String(error)
      };
      const receipt = observe(evidence2);
      exit.resolve(receipt);
      finalExit.resolve(receipt);
    };
    try {
      const registration = value.register(connection, binding2);
      if (registration !== void 0) {
        void Promise.resolve(registration).catch(() => {
        });
        throw new Error("WORKER_REGISTER_MUST_BE_SYNC");
      }
      registered = true;
      checkAuthority();
      child = spawn(this.options.executable ?? process.execPath, [entry, "--osstack-graph-worker"], {
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        env: { PATH: process.env["PATH"] ?? "", LANG: "C.UTF-8" }
      });
      child.on("error", spawnFailed);
      child.once("exit", (code, signal) => {
        observedExit = true;
        record.active = false;
        abort.abort();
        clear();
        transport?.close();
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        ready.reject(new Error("WORKER_EXITED_BEFORE_READY"));
        result.reject(new Error("WORKER_EXITED_BEFORE_RESULT"));
        const evidence2 = {
          kind: "exited",
          graphRunId: binding2.graphRunId,
          generation: binding2.generation,
          owner: binding2.owner,
          pid: child.pid,
          code,
          signal,
          confirmedAt: Date.now(),
          evidenceRef: `worker-exit:${randomUUID2()}`
        };
        const receipt = observe(evidence2);
        exit.resolve(receipt);
        finalExit.resolve(receipt);
      });
      child.stdout.on("error", (error) => cancel(String(error)));
      child.stderr.on("error", (error) => cancel(String(error)));
      child.stdout.on("data", (chunk) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr = append(stderr, chunk);
      });
      const pipe = child.stdio[3];
      transport = new WorkerFramedTransport(pipe, pipe, receive, (error) => cancel(error.message));
      child.once("spawn", () => {
        try {
          assertActive();
          const processIdentity2 = captureGraphProcessIdentity(child.pid);
          const launch = freezeWorkerData({ pid: child.pid, pgid: processIdentity2.pgid, processIdentity: processIdentity2, capturedAt: Date.now() });
          persist(lifecycle ? () => lifecycle.launched(launch) : void 0);
          assertActive();
          transport.send({
            kind: "init",
            binding: binding2,
            programId,
            source: program.source,
            input,
            ...resume ? { resume } : {},
            heartbeatMs: Math.max(10, Math.floor(heartbeatMs / 3)),
            maxInFlight,
            requestTimeoutMs
          });
        } catch (error) {
          cancel(String(error));
        }
      });
      monitor = setInterval(() => {
        if (stopping || observedExit) return;
        try {
          assertActive();
          if (!didReady && Date.now() - startedAt > startupMs) cancel("WORKER_STARTUP_TIMEOUT");
          else if (didReady && Date.now() - lastHeartbeat > heartbeatMs) cancel("WORKER_HEARTBEAT_EXPIRED");
        } catch (error) {
          cancel(String(error));
        }
      }, Math.max(10, Math.min(100, Math.floor(heartbeatMs / 3))));
    } catch (error) {
      spawnFailed(error instanceof Error ? error : new Error(String(error)));
    }
    return handle;
  }
};

// packages/cli/src/graph-runtime.ts
function synchronous(value) {
  if (value !== void 0) {
    void Promise.resolve(value).catch(() => {
    });
    throw new Error("GRAPH_AUTHORITY_MUST_BE_SYNC");
  }
}
var fence = (run) => ({
  scope: run.scope,
  graphRunId: run.graphRunId,
  identity: run.identity,
  expectedGeneration: run.generation,
  expectedRevision: run.revision,
  expectedOwner: run.leaseOwner,
  now: Date.now()
});
var GraphRuntime = class {
  constructor(options) {
    this.options = options;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 5e3;
    if (!Number.isSafeInteger(this.drainTimeoutMs) || this.drainTimeoutMs < 1 || this.drainTimeoutMs > 6e4) throw new Error("GRAPH_DRAIN_LIMIT");
    this.runs = new GraphRunStore4(options.db);
    this.processJournal = new GraphProcessJournal(options.db);
    this.reconciler = new GraphReconciler(options.db);
    this.workers = new GraphWorkerManager({ ...options.workerOptions, programs: options.programs });
  }
  options;
  reconciler;
  runs;
  workers;
  processJournal;
  connections = /* @__PURE__ */ new Map();
  drainTimeoutMs;
  closed = false;
  open() {
    if (this.closed) throw new Error("GRAPH_RUNTIME_CLOSED");
  }
  prepare(request, version) {
    this.open();
    return this.runs.create(request, version, Date.now());
  }
  claim(run, owner2, leaseExpiresAt) {
    this.open();
    if (run.generation !== 0 || run.leaseOwner !== null) throw new Error("RECOVERY_REQUIRED");
    return this.runs.acquireLease({ ...fence(run), owner: owner2, leaseExpiresAt });
  }
  /** Host-authorized G15 takeover only when durable evidence proves no worker or executor started. */
  recoverUnstartedWorker(request, authorize) {
    return recoverUnstartedGraphWorker(this.options.db, this.reconciler, request, () => {
      this.open();
      synchronous(authorize());
    });
  }
  start(value) {
    this.open();
    const run = freezeWorkerData2(structuredClone(value.run));
    const registration = value.registration;
    const dispatch = value.dispatch;
    const authorizeHost = value.authorize;
    const authorizeRegistration = registration.authorize;
    const duration = value.leaseDurationMs;
    if (duration !== void 0 && (!Number.isSafeInteger(duration) || duration < 100 || duration > 6e4)) throw new Error("GRAPH_LEASE_DURATION");
    const binding2 = { scope: run.scope, graphRunId: run.graphRunId, generation: run.generation, owner: run.leaseOwner, identity: run.identity };
    if (workerCanonical5(binding2) !== workerCanonical5({
      scope: registration.scope,
      graphRunId: registration.graphRunId,
      generation: registration.generation,
      owner: registration.owner,
      identity: registration.identity
    })) throw new Error("GRAPH_REGISTRATION_IDENTITY");
    if (run.generation > 1) {
      const journal = this.options.db.prepare("SELECT decision_json, snapshot_json FROM graph_recovery_decisions WHERE graph_run_id = ?").all(run.graphRunId);
      if (!journal.some((row) => {
        const decision = JSON.parse(row.decision_json);
        const snapshot3 = JSON.parse(row.snapshot_json);
        return decision.kind === "takeover" && decision.owner === run.leaseOwner && snapshot3.run.generation + 1 === run.generation;
      })) throw new Error("RECOVERY_REQUIRED");
    }
    let consumed = false;
    let connection;
    let retired = false;
    const authorize = (renew = true) => {
      this.open();
      if (retired || connection && this.connections.get(connection)?.retired) throw new Error("GRAPH_CONNECTION_RETIRED");
      synchronous(authorizeHost());
      synchronous(authorizeRegistration());
      let current = this.runs.get(binding2.scope, binding2.graphRunId);
      if (!current || workerCanonical5(current.identity) !== workerCanonical5(binding2.identity)) throw new Error("PROGRAM_IDENTITY_MISMATCH");
      if (current.generation !== binding2.generation || current.leaseOwner !== binding2.owner) throw new Error("STALE_GENERATION");
      if (["ready", "failed", "cancelled", "cancel_pending", "waiting_input"].includes(current.status)) throw new Error("GRAPH_RUN_NOT_ACTIVE");
      const now = Date.now();
      if (!current.spec || now - current.createdAt >= current.spec.limits.deadlineSeconds * 1e3) throw new Error("GRAPH_DEADLINE_EXCEEDED");
      if (current.leaseExpiresAt === null || current.leaseExpiresAt <= now || now < current.updatedAt) throw new Error("LEASE_EXPIRED");
      if (renew && duration !== void 0 && current.leaseExpiresAt - now < duration / 2) {
        current = this.runs.renewLease({ ...fence(current), leaseExpiresAt: now + duration });
      }
      return { leaseExpiresAt: current.leaseExpiresAt };
    };
    const pending = /* @__PURE__ */ new Set();
    const track = (promise) => {
      pending.add(promise);
      void promise.then(() => pending.delete(promise), () => pending.delete(promise));
      return promise;
    };
    const retire = () => {
      retired = true;
      if (connection) {
        this.options.broker.unregister(connection);
        this.options.checkpoints.unregister(connection);
        const record2 = this.connections.get(connection);
        if (record2) record2.retired = true;
      }
    };
    authorize();
    let handle;
    try {
      handle = this.workers.start({
        binding: binding2,
        input: value.request,
        programId: value.programId,
        ...value.resume ? { resume: value.resume } : {},
        authorize,
        register: (key, fixed) => {
          connection = key;
          if (this.options.db.inTransaction) throw new Error("GRAPH_LAUNCH_REQUIRES_TRANSACTION");
          this.options.db.transaction(() => {
            authorize(false);
            this.processJournal.consume(fixed);
          }).immediate();
          consumed = true;
          this.options.broker.register(key, { ...registration, authorize: () => {
            authorize();
          } });
          this.options.checkpoints.register(key, { ...fixed, authorize: async () => {
            authorize();
          } });
        },
        lifecycle: {
          launched: (launch) => this.processJournal.launched(binding2, launch),
          observed: (evidence2) => {
            if (consumed) this.processJournal.observed(binding2, evidence2);
          }
        },
        action: (key, request, options) => track(dispatch ? dispatch(key, request, options) : this.options.broker.handle(key, request, options)),
        checkpoint: (key, request) => track(this.options.checkpoints.execute(key, request))
      });
    } catch (error) {
      retire();
      throw error;
    }
    const record = { handle, pending, retired };
    this.connections.set(handle.connection, record);
    void handle.exit.then((exit) => {
      if (!record.exit) record.exit = freezeWorkerData2(structuredClone(exit));
      retire();
    });
    void handle.finalExit.then((exit) => {
      record.exit = freezeWorkerData2(structuredClone(exit));
      retire();
    });
    return Object.freeze({
      ...handle,
      cancel: (reason) => {
        retire();
        handle.cancel(reason);
      },
      stop: (reason) => {
        retire();
        return this.stop(handle.connection, reason);
      }
    });
  }
  /** Trusted host inspection only: no signaling, release, replay or recovery authority. */
  observeWorkerProcess(binding2) {
    this.open();
    return this.processJournal.observe(binding2);
  }
  observedExit(connection) {
    const receipt = this.connections.get(connection)?.exit;
    return receipt === void 0 ? void 0 : structuredClone(receipt);
  }
  async stop(connection, reason = "GRAPH_STOPPED") {
    const record = this.connections.get(connection);
    if (!record) throw new Error("GRAPH_CONNECTION_UNKNOWN");
    record.retired = true;
    this.options.broker.unregister(connection);
    this.options.checkpoints.unregister(connection);
    const worker = record.handle.stop(reason);
    let timer;
    const drained = Promise.allSettled([...record.pending]).then(() => true);
    const bounded = Promise.race([drained, new Promise((resolve2) => {
      timer = setTimeout(() => resolve2(false), this.drainTimeoutMs);
    })]);
    const [exit, actionsSettled] = await Promise.all([worker, bounded]);
    if (timer) clearTimeout(timer);
    return { worker: exit, actionsSettled };
  }
  /** Database lifetime barrier, separate from bounded physical-stop observations.
   * Call after close(): an unresolved producer keeps shutdown pending, never
   * authorizes closing SQLite while broker cleanup or late OS events still use it. */
  async drainDatabaseUsers() {
    if (!this.closed) throw new Error("GRAPH_RUNTIME_MUST_CLOSE_BEFORE_DRAIN");
    await Promise.allSettled([...this.connections.values()].flatMap((record) => [record.handle.finalExit, ...record.pending]));
  }
  async close() {
    this.closed = true;
    await Promise.all([...this.connections.keys()].map((connection) => this.stop(connection, "GRAPH_RUNTIME_CLOSED")));
  }
};

// packages/cli/src/graph-checkpoint-service.ts
import { parseGraphCheckpointRequest as parseGraphCheckpointRequest2 } from "@osstack/protocol";
var GraphCheckpointService = class {
  constructor(options) {
    this.options = options;
    for (const [connection, binding2] of options.bindings) this.register(connection, binding2);
  }
  options;
  bindings = /* @__PURE__ */ new Map();
  closed = false;
  retired = /* @__PURE__ */ new WeakSet();
  register(connection, binding2) {
    this.assertOpen();
    if (this.retired.has(connection)) throw new Error("CONNECTION_RETIRED");
    if (this.bindings.has(connection)) throw new Error("ALREADY_REGISTERED");
    if (typeof binding2.authorize !== "function") throw new Error("UNAUTHENTICATED");
    const { authorize, ...data } = binding2;
    this.bindings.set(connection, { ...structuredClone(data), authorize });
  }
  unregister(connection) {
    this.bindings.delete(connection);
    this.retired.add(connection);
  }
  close() {
    this.closed = true;
  }
  async execute(connection, value) {
    this.assertOpen();
    const binding2 = this.bindings.get(connection);
    if (!binding2) throw new Error("UNAUTHENTICATED");
    const request = parseGraphCheckpointRequest2(value);
    if (request.threadId !== binding2.graphRunId) throw new Error("RUN_MISMATCH");
    const authorize = binding2.authorize;
    const decision = await authorize();
    if (decision !== void 0) throw new Error("POLICY_DENIED: authorization must resolve without a decision payload or throw");
    this.assertOpen();
    if (this.bindings.get(connection) !== binding2) throw new Error("UNAUTHENTICATED");
    const run = this.options.runs.get(binding2.scope, binding2.graphRunId);
    if (!run) throw new Error("RUN_NOT_FOUND");
    const result = this.options.checkpoints.execute({
      scope: binding2.scope,
      graphRunId: binding2.graphRunId,
      expectedGeneration: binding2.generation,
      expectedRevision: run.revision,
      expectedOwner: binding2.owner,
      identity: binding2.identity,
      now: this.options.now?.() ?? Date.now()
    }, request);
    return result.response;
  }
  assertOpen() {
    if (this.closed) throw new Error("CHECKPOINT_SERVICE_CLOSED");
  }
};

// packages/cli/src/graph-contained-tests.ts
import { createHash as createHash3 } from "node:crypto";
import { execFileSync as execFileSync2 } from "node:child_process";
import { createContainedCommandExecutor, prepareContainedImage } from "@osstack/agents";
import { verificationCanonical, verificationObject } from "@osstack/graph/nodes/branch";
var sha = (value) => createHash3("sha256").update(value).digest("hex");
async function prepareGraphContainedImage(options, workspace, revision, authorize) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const git4 = (...args) => execFileSync2("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd: workspace,
    timeout: 1e4,
    maxBuffer: 33 * 1024 * 1024,
    env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" }
  });
  const files = [];
  let size = 0;
  const listing = git4("ls-tree", "-rz", "--full-tree", revision);
  if (!Buffer.from(listing.toString()).equals(listing)) throw Error("CONTAINED_CANDIDATE_UTF8_PATH_REQUIRED");
  for (const row of listing.toString().split("\0").filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(row);
    if (!match) throw Error("CONTAINED_CANDIDATE_REGULAR_FILES_REQUIRED");
    const bytes = git4("cat-file", "blob", match[2]);
    size += bytes.length;
    if (size > 32 * 1024 * 1024 || files.length >= 1e4) throw Error("CONTAINED_CANDIDATE_LIMIT");
    if (createHash3("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== match[2]) throw Error("CONTAINED_CANDIDATE_BLOB_MISMATCH");
    files.push({ path: match[3], mode: match[1], bytes });
  }
  return prepareContainedImage({ socketPath: options.socketPath, daemonId: options.daemonId, baseImageId: options.baseImageId, authorize }, files);
}
function registerContainedTests(options, image, binding2, command) {
  const fixed = structuredClone({ socketPath: options.socketPath, journalRoot: options.journalRoot, image, binding: binding2, command });
  const { authorizeStop, authorizeRead } = options;
  const executors = /* @__PURE__ */ new Map();
  const observed = /* @__PURE__ */ new Map();
  const pending = /* @__PURE__ */ new Map();
  const registration = {
    command,
    execute: (invocation, signal, authorize) => {
      if (pending.has(invocation.invocationId)) return Promise.reject(Error("CONTAINED_INVOCATION_REPEATED"));
      const running = (async () => {
        if (executors.has(invocation.invocationId) || invocation.graphRunId !== fixed.binding.graphRunId || verificationCanonical(invocation.scope) !== verificationCanonical(fixed.binding.scope)) throw Error("CONTAINED_INVOCATION_BINDING");
        const identity = { ...structuredClone(invocation), version: 1, candidateRevision: fixed.binding.candidateRevision, artifactDigest: fixed.binding.artifactDigest, command: fixed.command, image: fixed.image };
        const executor = await createContainedCommandExecutor({
          socketPath: fixed.socketPath,
          daemonId: fixed.image.daemonId,
          journalRoot: fixed.journalRoot,
          imageId: fixed.image.imageId,
          workingDirectory: fixed.image.workingDirectory,
          command: fixed.command,
          bindingRef: sha(verificationCanonical(identity)),
          bindingData: verificationCanonical(identity),
          authorize: (operation) => {
            if (operation === "start") authorize();
            else if (operation === "stop") return authorizeStop();
            else return authorizeRead();
          }
        });
        if (executors.has(invocation.invocationId)) throw Error("CONTAINED_INVOCATION_REPEATED");
        executors.set(invocation.invocationId, executor);
        const result = await executor.execute(invocation.invocationId, signal);
        const evidence2 = { identity, result };
        observed.set(invocation.invocationId, verificationCanonical(evidence2));
        return evidence2;
      })();
      pending.set(invocation.invocationId, running);
      return running;
    },
    confirmStopped: async (id) => {
      await pending.get(id)?.catch(() => {
      });
      return executors.get(id)?.confirmStopped(id) ?? { stopped: false };
    }
  };
  return { registration, verify: (evidence2) => {
    if (observed.get(evidence2.identity.invocationId) !== verificationCanonical(evidence2)) throw Error("CONTAINED_ACTUAL_INVOCATION_REQUIRED");
  } };
}
function validateContainedTestIdentity(value, binding2, effectKey, command, contentDigest) {
  const identity = verificationObject(value, ["scope", "graphRunId", "generation", "effectKey", "invocationId", "version", "candidateRevision", "artifactDigest", "command", "image"]);
  const image = verificationObject(identity.image, ["version", "daemonId", "baseImageId", "imageId", "contentDigest", "archiveDigest", "workingDirectory"]);
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  if (identity.version !== 1 || identity.graphRunId !== binding2.graphRunId || verificationCanonical(identity.scope) !== verificationCanonical(binding2.scope) || identity.effectKey !== effectKey || !Number.isSafeInteger(identity.generation) || identity.generation < 1 || typeof identity.invocationId !== "string" || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(identity.invocationId) || identity.candidateRevision !== binding2.candidateRevision || identity.artifactDigest !== binding2.artifactDigest || identity.command !== command || image.version !== 1 || typeof image.daemonId !== "string" || !image.daemonId || image.contentDigest !== contentDigest || ![image.contentDigest, image.archiveDigest].every((v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)) || ![image.baseImageId, image.imageId].every((v) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v)) || typeof image.workingDirectory !== "string" || !image.workingDirectory.startsWith("/osstack-candidate-") || !uuid.test(image.workingDirectory.slice(19))) throw Error("CONTAINED_EVIDENCE_BINDING");
  return value;
}
function validateContainedTestEvidence(value, binding2, effectKey, command, contentDigest) {
  const v = verificationObject(value, ["identity", "result"]);
  const identity = validateContainedTestIdentity(v.identity, binding2, effectKey, command, contentDigest);
  const image = identity.image;
  const result = verificationObject(v.result, ["exitCode", "output", "cancelled", "evidence", "stopReceipt"]);
  const receipt = verificationObject(result.stopReceipt, ["version", "kind", "launch", "confirmedAt"]);
  const launch = verificationObject(receipt.launch, ["version", "invocationId", "specDigest", "daemonId", "containerId", "nonce"]);
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  const specDigest = sha(JSON.stringify({ image: image.imageId, command, binding: sha(verificationCanonical(identity)), policy: 1, workingDirectory: image.workingDirectory }));
  if (receipt.version !== 1 || receipt.kind !== "docker_removed" || !Number.isSafeInteger(receipt.confirmedAt) || receipt.confirmedAt <= 0 || launch.version !== 1 || launch.invocationId !== identity.invocationId || launch.daemonId !== image.daemonId || launch.specDigest !== specDigest || typeof launch.containerId !== "string" || !/^[a-f0-9]{64}$/.test(launch.containerId) || typeof launch.nonce !== "string" || !uuid.test(launch.nonce) || result.evidence !== `docker-removed:${sha(JSON.stringify({ version: 1, kind: "docker_removed", launch: { version: 1, invocationId: launch.invocationId, specDigest: launch.specDigest, daemonId: launch.daemonId, containerId: launch.containerId, nonce: launch.nonce }, confirmedAt: receipt.confirmedAt }))}` || !Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255 || typeof result.output !== "string" || result.output.length > 16e3 || typeof result.cancelled !== "boolean") throw Error("CONTAINED_STOP_RECEIPT_MISMATCH");
  return value;
}

// packages/cli/src/graph-verification.ts
import { execFileSync as execFileSync3 } from "node:child_process";
import { createHash as createHash5, randomUUID as randomUUID4 } from "node:crypto";
import { existsSync as existsSync2, lstatSync, readdirSync, readFileSync as readFileSync3, readlinkSync, realpathSync } from "node:fs";
import { mkdir as mkdir2, realpath as realpath2 } from "node:fs/promises";
import { dirname as dirname2, isAbsolute as isAbsolute3, join as join2, resolve } from "node:path";
import { GraphResult as GraphResult3 } from "@osstack/protocol";
import { ExecutionPlan as ExecutionPlan2 } from "@osstack/loop";
import { parseVerificationBinding as parseVerificationBinding2, verificationCanonical as verificationCanonical3 } from "@osstack/graph/nodes/branch";
import { createReviewRequest, parseReviewReport as parseReviewReport2 } from "@osstack/graph/nodes/review";
import { createTestsRequest } from "@osstack/graph/nodes/tests";

// packages/cli/src/graph-verification-store.ts
import { createHash as createHash4, randomUUID as randomUUID3 } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute as isAbsolute2, join } from "node:path";
import { GraphEffectIdentity, GraphJsonValue as GraphJsonValue4, GraphResult as GraphResult2, computeGraphEffectKey } from "@osstack/protocol";
import { parseVerificationBinding, verificationCanonical as verificationCanonical2, verificationObject as verificationObject2 } from "@osstack/graph/nodes/branch";
import { parseReviewReport } from "@osstack/graph/nodes/review";
function parseAcceptanceCommand(value) {
  const v = verificationObject2(value, ["ref", "command", "passExitCodes", "failExitCodes"]);
  if (typeof v.ref !== "string" || !v.ref.trim() || v.ref.length > 256 || typeof v.command !== "string" || !v.command.trim() || v.command.includes("\0") || v.command.length > 8192) throw new Error("invalid acceptance command");
  for (const codes of [v.passExitCodes, v.failExitCodes]) if (!Array.isArray(codes) || codes.length > 256 || codes.some((c) => !Number.isInteger(c) || c < 0 || c > 255) || new Set(codes).size !== codes.length) throw new Error("invalid acceptance exit codes");
  const pass = v.passExitCodes;
  const fail2 = v.failExitCodes;
  if (!pass.length || pass.some((code) => fail2.includes(code))) throw new Error("ambiguous acceptance exit codes");
  return structuredClone(value);
}
function validateVerificationEffect(value, binding2, nodeId, effectSlot) {
  const object = verificationObject2(value, ["effect", "effectKey"]);
  const effect = GraphEffectIdentity.parse(object.effect);
  if (effect.graphRunId !== binding2.graphRunId || effect.specHash !== binding2.specHash || effect.epoch !== binding2.epoch || verificationCanonical2(effect.scope) !== verificationCanonical2(binding2.scope) || effect.nodeId !== nodeId || effect.effectSlot !== effectSlot || object.effectKey !== computeGraphEffectKey(effect)) throw new Error("evidence effect binding mismatch");
  return { effect, effectKey: object.effectKey };
}
function validateEnvelope(value, expectedBinding, expectedEffect) {
  const object = verificationObject2(value, ["schemaVersion", "binding", "kind", "nodeId", "effectSlot", "effect", "effectKey", "workspace", "acceptance", "writerIdentity", "reviewerIdentity", "evidence", "report", "verificationFailure", "workspaceLeaseRef", "candidateIdentity", "reviewerInvocation", "outputCaptures"]);
  const binding2 = parseVerificationBinding(object.binding);
  if (verificationCanonical2(binding2) !== verificationCanonical2(parseVerificationBinding(expectedBinding))) throw new Error("evidence binding mismatch");
  if (object.schemaVersion !== 1 || !["review", "tests"].includes(String(object.kind))) throw new Error("invalid evidence kind");
  const effect = validateVerificationEffect({ effect: object.effect, effectKey: object.effectKey }, binding2, String(object.nodeId), String(object.effectSlot));
  if (expectedEffect && verificationCanonical2(effect) !== verificationCanonical2(expectedEffect)) throw new Error("evidence attempt replay");
  const acceptance = parseAcceptanceCommand(object.acceptance);
  if (acceptance.ref !== binding2.acceptanceRef) throw new Error("acceptance binding mismatch");
  const workspace = verificationObject2(object.workspace, ["workspace_id", "workspace_path"]);
  if (workspace.workspace_id !== binding2.scope.workspaceId || typeof workspace.workspace_path !== "string" || !isAbsolute2(workspace.workspace_path)) throw new Error("evidence workspace mismatch");
  if (typeof object.writerIdentity !== "string" || !object.writerIdentity.trim() || typeof object.reviewerIdentity !== "string" || !object.reviewerIdentity.trim() || object.writerIdentity === object.reviewerIdentity) throw new Error("independent identity required");
  const evidence2 = verificationObject2(object.evidence, ["status", "stopped", "candidate", "command", "contained"]);
  if (evidence2.stopped !== true || !["completed", "failed"].includes(String(evidence2.status))) throw new Error("executor stop unconfirmed");
  const envelope = object;
  if (envelope.evidence.candidate?.status === "execution_unconfirmed" || envelope.evidence.candidate?.execution?.failure_code === "cancellation_unconfirmed" || envelope.evidence.command?.failure_code === "process_exit_unconfirmed" || envelope.evidence.command?.failure_code === "surviving_descendants") throw new Error("executor stop evidence contradicts uncertainty");
  if (object.verificationFailure !== void 0) {
    const failure = verificationObject2(object.verificationFailure, ["code", "message", "retrySafe"]);
    if (!["OUTPUT_CONTRACT_INVALID", "INTERNAL_ERROR"].includes(String(failure.code)) || typeof failure.message !== "string" || !failure.message.trim() || failure.message.length > 4096 || typeof failure.retrySafe !== "boolean" || object.report !== void 0) throw new Error("invalid verification failure");
  }
  if (typeof object.workspaceLeaseRef !== "string" || !object.workspaceLeaseRef.trim() || object.workspaceLeaseRef.length > 256) throw new Error("invalid workspace lease receipt");
  const identities = verificationObject2(object.candidateIdentity, ["before", "after"]);
  const validateIdentity = (value2) => {
    const identity = verificationObject2(value2, ["head", "tree", "indexTree", "indexDigest", "trackedDigest", "repositoryDigest", "inventoryDigest", "containedContentDigest"]);
    for (const key of ["head", "tree", "indexTree"]) if (typeof identity[key] !== "string" || !/^[a-f0-9]{40}$/.test(identity[key])) throw new Error("invalid candidate identity");
    for (const key of ["indexDigest", "trackedDigest", "repositoryDigest", ...envelope.kind === "review" ? ["inventoryDigest"] : []]) if (typeof identity[key] !== "string" || !/^[a-f0-9]{64}$/.test(identity[key])) throw new Error("invalid candidate identity digest");
    if (envelope.kind === "tests" && identity.inventoryDigest !== void 0) throw new Error("unexpected tests inventory receipt");
    if (identity.containedContentDigest !== void 0 && (envelope.kind !== "tests" || typeof identity.containedContentDigest !== "string" || !/^[a-f0-9]{64}$/.test(identity.containedContentDigest))) throw Error("invalid contained content digest");
    return identity;
  };
  const before = validateIdentity(identities.before);
  if (before.head !== binding2.candidateRevision || before.tree !== before.indexTree) throw new Error("invalid frozen candidate identity");
  const after = verificationObject2(identities.after, ["head", "tree", "indexTree", "indexDigest", "trackedDigest", "repositoryDigest", "inventoryDigest", "containedContentDigest", "error"]);
  if (after.error !== void 0) {
    if (Object.keys(after).length !== 1 || typeof after.error !== "string" || !after.error.trim() || after.error.length > 4096) throw new Error("invalid candidate observation error");
  } else validateIdentity(after);
  if (verificationCanonical2(before) !== verificationCanonical2(after) && (envelope.verificationFailure?.code !== "INTERNAL_ERROR" || envelope.verificationFailure.retrySafe !== false)) throw new Error("candidate mutation requires non-retryable failure");
  if (envelope.kind === "tests") {
    if (object.reviewerInvocation !== void 0) throw new Error("tests cannot contain reviewer invocation");
    if (envelope.evidence.contained) {
      if (envelope.evidence.command || object.report !== void 0) throw Error("conflicting contained evidence");
      const contained = validateContainedTestEvidence(envelope.evidence.contained, binding2, effect.effectKey, acceptance.command, envelope.candidateIdentity.before.containedContentDigest);
      if (envelope.evidence.candidate?.execution?.run_id !== contained.identity.invocationId) throw Error("contained executor invocation mismatch");
      if (!envelope.verificationFailure && (contained.result.cancelled || ![...acceptance.passExitCodes, ...acceptance.failExitCodes].includes(contained.result.exitCode))) throw Error("invalid contained acceptance outcome");
    } else {
      if (envelope.candidateIdentity.before.containedContentDigest !== void 0) throw Error("missing contained evidence");
      const command = envelope.evidence.command;
      if (!command || command.command !== acceptance.command || !Number.isInteger(command.exitCode) || typeof command.stdout !== "string" || typeof command.stderr !== "string" || !Number.isFinite(command.durationMs) || command.durationMs < 0 || command.termination?.stop_confirmed !== true || !command.termination.evidence.trim()) throw new Error("invalid stopped command evidence");
      if (object.report !== void 0) throw new Error("tests cannot contain model report");
      if (!envelope.verificationFailure && (command.failure_code || command.cancellation || command.termination.scope !== "posix_process_group" || command.termination.trigger !== "exit" || command.termination.leader_exit_code !== command.exitCode || ![...acceptance.passExitCodes, ...acceptance.failExitCodes].includes(command.exitCode))) throw new Error("invalid acceptance outcome");
    }
  } else {
    const candidate = envelope.evidence.candidate;
    if (!candidate?.execution || candidate.execution.agent_id !== envelope.reviewerIdentity || !candidate.execution.run_id || verificationCanonical2(candidate.workspace) !== verificationCanonical2(workspace) || evidence2.command !== void 0 || evidence2.contained !== void 0) throw new Error("review executor identity mismatch");
    const receipt = verificationObject2(object.reviewerInvocation, ["runId", "taskId", "sessionId", "adapterId", "capabilityId", "promptDigest", "contextDigest", "historyPassed", "effectKey"]);
    if (receipt.runId !== candidate.execution.run_id || receipt.taskId !== candidate.execution.task_id || receipt.adapterId !== envelope.reviewerIdentity || typeof receipt.sessionId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(receipt.sessionId) || typeof receipt.capabilityId !== "string" || !receipt.capabilityId.trim() || receipt.historyPassed !== false || receipt.effectKey !== effect.effectKey || typeof receipt.promptDigest !== "string" || !/^[a-f0-9]{64}$/.test(receipt.promptDigest) || receipt.contextDigest !== sha2(verificationCanonical2({ repo_path: workspace.workspace_path }))) throw new Error("invalid reviewer invocation receipt");
    if (!envelope.verificationFailure) {
      const report = parseReviewReport(envelope.report);
      if (candidate.execution.failure_code || candidate.status !== "implementation_complete" || candidate.execution.outcome !== "completed" || verificationCanonical2(parseReviewReport(JSON.parse(candidate.execution.summary ?? "null"))) !== verificationCanonical2(report)) throw new Error("review report evidence mismatch");
    }
  }
  if (envelope.outputCaptures !== void 0) {
    if (!Array.isArray(envelope.outputCaptures) || envelope.outputCaptures.length > 4) throw new Error("invalid output captures");
    const seen = /* @__PURE__ */ new Set();
    for (const value2 of envelope.outputCaptures) {
      const capture = verificationObject2(value2, ["field", "capturedBytes", "capturedSha256", "representation"]);
      if (!["command.stdout", "command.stderr", "candidate.summary", "contained.output"].includes(String(capture.field)) || seen.has(String(capture.field)) || !Number.isSafeInteger(capture.capturedBytes) || capture.capturedBytes < 0 || typeof capture.capturedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(capture.capturedSha256) || !["prefix", "canonical_review"].includes(String(capture.representation))) throw new Error("invalid output capture");
      seen.add(String(capture.field));
      const text2 = capture.field === "command.stdout" ? envelope.evidence.command?.stdout : capture.field === "command.stderr" ? envelope.evidence.command?.stderr : capture.field === "contained.output" ? envelope.evidence.contained?.result.output : envelope.evidence.candidate?.execution?.summary;
      if (typeof text2 !== "string") throw new Error("missing captured output preview");
      if (capture.representation === "prefix" && (Buffer.byteLength(JSON.stringify(text2)) > 2048 || Buffer.byteLength(text2) > capture.capturedBytes)) throw new Error("invalid output preview");
      if (capture.representation === "canonical_review" && (capture.field !== "candidate.summary" || !envelope.report || text2 !== JSON.stringify(envelope.report))) throw new Error("invalid canonical review capture");
    }
  }
  return structuredClone(envelope);
}
function compactVerificationOutput(envelope) {
  const evidence2 = structuredClone(envelope.evidence);
  const captures = [];
  const compact = (field, original, canonicalReview) => {
    let retained = canonicalReview ?? original;
    if (canonicalReview === void 0 && Buffer.byteLength(JSON.stringify(original)) > 2048) {
      let low = 0;
      let high = original.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(JSON.stringify(original.slice(0, mid))) <= 2048) low = mid;
        else high = mid - 1;
      }
      retained = original.slice(0, low);
    }
    if (retained !== original) captures.push({ field, capturedBytes: Buffer.byteLength(original), capturedSha256: sha2(original), representation: canonicalReview === void 0 ? "prefix" : "canonical_review" });
    return retained;
  };
  if (evidence2.contained) evidence2.contained.result.output = compact("contained.output", evidence2.contained.result.output);
  if (evidence2.command) {
    evidence2.command.stdout = compact("command.stdout", evidence2.command.stdout);
    evidence2.command.stderr = compact("command.stderr", evidence2.command.stderr);
  }
  if (evidence2.candidate?.execution?.summary !== void 0) evidence2.candidate.execution.summary = compact("candidate.summary", evidence2.candidate.execution.summary, envelope.report ? JSON.stringify(envelope.report) : void 0);
  envelope.evidence = evidence2;
  if (captures.length) envelope.outputCaptures = captures;
}
var sha2 = (bytes) => createHash4("sha256").update(bytes).digest("hex");
async function directory(root) {
  if (!isAbsolute2(root) || await realpath(root) !== root) throw new Error("host evidence root must be canonical");
  const path2 = join(root, "evidence");
  await mkdir(path2, { mode: 448, recursive: true });
  if (!(await lstat(path2)).isDirectory() || await realpath(path2) !== path2) throw new Error("invalid host evidence directory");
  return path2;
}
async function syncDirectory(path2) {
  const file = await open(path2, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function publishGraphVerificationEvidence(root, value, authorize) {
  const envelope = validateEnvelope(value, value.binding);
  const bytes = verificationCanonical2(envelope);
  if (Buffer.byteLength(bytes, "utf8") > 65536) throw new Error("evidence exceeds 64KiB file size limit");
  GraphJsonValue4.parse(envelope);
  const digest2 = sha2(bytes);
  const checked = async (op) => {
    authorize();
    const result2 = await op();
    authorize();
    return result2;
  };
  const dir = await checked(() => directory(root));
  const temporary = join(dir, `.${randomUUID3()}.json`);
  const final = join(dir, `${digest2}.json`);
  authorize();
  const file = await open(temporary, "wx", 384);
  try {
    authorize();
    await checked(() => file.writeFile(bytes));
    await checked(() => file.sync());
  } finally {
    await file.close();
  }
  await checked(() => chmod(temporary, 256));
  await checked(async () => {
    try {
      await link(temporary, final);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await open(final, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (sha2(await existing.readFile()) !== digest2) throw new Error("evidence digest collision");
      } finally {
        await existing.close();
      }
    }
  });
  await checked(() => syncDirectory(dir));
  await checked(() => syncDirectory(root));
  await checked(() => syncDirectory(dirname(root)));
  await checked(() => unlink(temporary));
  const evidenceRef = `graph-verification:${digest2}`;
  if (envelope.verificationFailure) return { evidenceRef, verificationFailure: envelope.verificationFailure };
  const common = { schemaVersion: 1, candidateRevision: envelope.binding.candidateRevision, evidenceRefs: [evidenceRef], evidenceDigest: digest2 };
  const result = GraphResult2.parse(envelope.kind === "review" ? { ...common, kind: "review", verdict: envelope.report.verdict } : { ...common, kind: "tests", passed: envelope.acceptance.passExitCodes.includes(envelope.evidence.contained?.result.exitCode ?? envelope.evidence.command.exitCode) });
  return { evidenceRef, result };
}
async function loadGraphVerificationEvidence(root, evidenceRef, expectedBinding, expectedEffect) {
  const binding2 = parseVerificationBinding(expectedBinding);
  const effect = expectedEffect ? structuredClone(expectedEffect) : void 0;
  if (!/^graph-verification:[a-f0-9]{64}$/.test(evidenceRef)) throw new Error("invalid evidence reference");
  const digest2 = evidenceRef.slice("graph-verification:".length);
  if (!isAbsolute2(root) || await realpath(root) !== root) throw new Error("invalid host evidence root");
  const dir = join(root, "evidence");
  if (await realpath(dir) !== dir || !(await lstat(dir)).isDirectory()) throw new Error("invalid host evidence directory");
  const file = await open(join(dir, `${digest2}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536) throw new Error("invalid evidence file");
    bytes = await file.readFile();
  } finally {
    await file.close();
  }
  if (bytes.length > 65536) throw new Error("evidence exceeds 64KiB file size limit");
  if (sha2(bytes) !== digest2) throw new Error("evidence digest mismatch");
  return validateEnvelope(JSON.parse(bytes.toString("utf8")), binding2, effect);
}

// packages/cli/src/graph-verification.ts
function snapshot2(value) {
  const copy = structuredClone(value);
  const freeze = (item) => {
    if (item && typeof item === "object") {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}
function checkedAuthority(authorize) {
  return () => {
    const result = authorize();
    if (result !== void 0) {
      void Promise.resolve(result).catch(() => {
      });
      throw new Error("authority must be synchronous");
    }
  };
}
function gitRaw(path2, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return execFileSync3("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd: path2,
    encoding: "utf8",
    timeout: 1e4,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" }
  });
}
function git(path2, ...args) {
  return gitRaw(path2, ...args).trim();
}
function workspaceFingerprint(path2) {
  const hash = createHash5("sha256");
  let count2 = 0;
  const visit = (directory4, prefix) => {
    for (const name of readdirSync(directory4).sort()) {
      if (!prefix && name === ".git") continue;
      if (++count2 > 1e5) throw new Error("workspace inventory limit");
      const relative = `${prefix}${name}`;
      const full = join2(directory4, name);
      const stat = lstatSync(full);
      hash.update(JSON.stringify([relative, stat.mode & 511, stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "link" : "file"]));
      if (stat.isSymbolicLink()) {
        const target = resolve(dirname2(full), readlinkSync(full));
        if (!target.startsWith(`${path2}/`) || existsSync2(target) && !realpathSync(target).startsWith(`${path2}/`)) throw new Error("shared external symlink in candidate workspace");
        hash.update(readlinkSync(full));
      } else if (stat.isDirectory()) visit(full, `${relative}/`);
      else if (stat.isFile() && stat.size <= 256 * 1024 * 1024 && stat.nlink === 1) hash.update(readFileSync3(full));
      else throw new Error("unsupported workspace entry/shared writable hardlink");
    }
  };
  visit(path2, "");
  return hash.digest("hex");
}
function assertExactCandidateFiles(path2, revision) {
  const expected = /* @__PURE__ */ new Set();
  for (const entry of gitRaw(path2, "ls-tree", "-rz", "--full-tree", revision).split("\0").filter(Boolean)) {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error("unsupported candidate tree entry");
    const name = match[3];
    expected.add(name);
    let parent = dirname2(name);
    while (parent !== ".") {
      expected.add(parent);
      parent = dirname2(parent);
    }
    const file = join2(path2, name);
    const stat = lstatSync(file);
    const bytes = match[1] === "120000" && stat.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : match[1] !== "120000" && stat.isFile() ? readFileSync3(file) : void 0;
    if (!bytes || match[1] !== "120000" && (stat.mode & 73) !== 0 !== (match[1] === "100755") || createHash5("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== match[2]) throw new Error("candidate raw tree mismatch");
  }
  const visit = (directory4, prefix) => {
    for (const name of readdirSync(directory4)) {
      if (!prefix && name === ".git") continue;
      const relative = `${prefix}${name}`;
      if (!expected.has(relative)) throw new Error("candidate has unexpected files");
      const full = join2(directory4, name);
      if (lstatSync(full).isDirectory()) visit(full, `${relative}/`);
    }
  };
  visit(path2, "");
}
function repositoryStamp(path2) {
  const gitDir = join2(path2, ".git");
  for (const p of [path2, gitDir, join2(gitDir, "objects")]) if (!lstatSync(p).isDirectory() || realpathSync(p) !== p) throw new Error("workspace repository is not independent");
  if (git(path2, "rev-parse", "--absolute-git-dir") !== gitDir || git(path2, "rev-parse", "--git-common-dir") !== ".git" || existsSync2(join2(gitDir, "objects", "info", "alternates")) || existsSync2(join2(gitDir, "objects", "info", "http-alternates"))) throw new Error("shared repository storage forbidden");
  const inspect = (directory4) => {
    for (const name of readdirSync(directory4)) {
      const p = join2(directory4, name);
      const stat = lstatSync(p);
      if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) throw new Error("shared repository metadata");
      if (stat.isDirectory()) inspect(p);
    }
  };
  inspect(gitDir);
  return verificationCanonical3([path2, gitDir, join2(gitDir, "objects")].map((p) => {
    const stat = lstatSync(p);
    return [p, stat.dev, stat.ino];
  }));
}
async function prepareGraphVerificationBranch(options, kind) {
  return prepareSelection(options, [kind]);
}
async function prepareSelection(options, kinds) {
  const { authorize, authorizeCancel, authorizePolicy, acquire, effectIdentity, verifyReviewer, preparationLease } = options;
  const containedOptions = options.containedTests ? Object.freeze({ ...options.containedTests }) : void 0;
  const check = checkedAuthority(authorize);
  check();
  const data = snapshot2({
    root: options.root,
    binding: parseVerificationBinding2(options.binding),
    candidate: GraphResult3.parse(options.candidate),
    source: options.sourceWorkspace,
    writerIdentity: options.writerIdentity,
    reviewerIdentity: options.reviewer.identity,
    capabilityId: options.reviewer.capabilityId,
    kinds,
    registry: options.acceptanceRegistry.map(parseAcceptanceCommand),
    slots: options.slots ?? {}
  });
  if (!data.kinds.length || new Set(data.kinds).size !== data.kinds.length || data.kinds.some((k) => k !== "review" && k !== "tests")) throw Error("invalid preparation kinds");
  const adapter = options.reviewer.adapter;
  const capabilities = snapshot2(adapter.capabilities());
  const reviewer = Object.freeze({
    id: adapter.id,
    display_name: adapter.display_name,
    cost_tier: adapter.cost_tier,
    capabilities: () => structuredClone(capabilities),
    isAvailable: adapter.isAvailable.bind(adapter),
    invoke: adapter.invoke.bind(adapter),
    ...adapter.confirmStopped ? { confirmStopped: adapter.confirmStopped.bind(adapter) } : {}
  });
  const verifyArtifact = options.artifacts.verify.bind(options.artifacts);
  const restore = options.artifacts.restore.bind(options.artifacts);
  const { binding: binding2 } = data;
  check();
  if (!isAbsolute3(data.root) || data.root.includes("\0") || !isAbsolute3(data.source.workspace_path) || data.source.workspace_id !== binding2.scope.workspaceId) throw new Error("invalid host workspace/root");
  if (data.candidate.kind !== "candidate_ready" || data.candidate.candidateRevision !== binding2.candidateRevision || data.candidate.artifactDigest !== binding2.artifactDigest) throw new Error("candidate binding mismatch");
  if (!data.writerIdentity.trim() || !data.reviewerIdentity.trim() || data.writerIdentity === data.reviewerIdentity || data.reviewerIdentity !== reviewer.id || !reviewer.confirmStopped || typeof verifyReviewer !== "function") throw new Error("independent reviewer identity/stop verifier required");
  const matches = capabilities.filter((cap) => cap.id === data.capabilityId);
  if (matches.length !== 1 || matches[0].agent_id !== reviewer.id || !["review.code", "code.review"].includes(matches[0].kind)) throw new Error("review capability mismatch");
  const acceptanceMatches = data.registry.filter((spec) => spec.ref === binding2.acceptanceRef);
  if (acceptanceMatches.length !== 1) throw new Error("acceptance must resolve unique trusted command");
  const acceptance = acceptanceMatches[0];
  const identities = snapshot2({ writerIdentity: data.writerIdentity, reviewerIdentity: data.reviewerIdentity, adapterId: reviewer.id, capabilityId: data.capabilityId });
  const checked = async (operation) => {
    check();
    const value = await operation();
    check();
    return value;
  };
  const independent = async () => {
    const result = await checked(() => verifyReviewer(identities));
    if (result !== void 0) throw new Error("independent verifier must return void");
    check();
  };
  await independent();
  check();
  const lease = preparationLease ?? await acquire({ kind: "write", runId: `graph-verification-prepare:${randomUUID4()}`, workspacePath: data.source.workspace_path, authorize: async () => {
    check();
  } });
  const preparedCheck = async () => {
    if (!lease.assertActive) throw new Error("canonical G10 preparation lease required");
    await checked(() => lease.assertActive());
  };
  let containedImage;
  let manifest;
  let reviewPath;
  let testsPath;
  let preparationFailure;
  try {
    check();
    await preparedCheck();
    const validateManifest = (value) => {
      if (value.candidateRevision !== binding2.candidateRevision || verificationCanonical3(value.input.scope) !== verificationCanonical3(binding2.scope) || value.input.runId !== binding2.graphRunId || value.input.worktreePath !== data.source.workspace_path) throw new Error("artifact manifest binding mismatch");
    };
    manifest = snapshot2(await checked(() => verifyArtifact(binding2.artifactDigest)));
    validateManifest(manifest);
    await checked(() => realpath2(dirname2(data.root)));
    await checked(() => mkdir2(data.root, { mode: 448, recursive: true }));
    if (await checked(() => realpath2(data.root)) !== data.root || data.root === data.source.workspace_path || data.root.startsWith(`${data.source.workspace_path}/`)) throw new Error("host root must be canonical and outside source workspace");
    const paths = [];
    for (const kind of data.kinds) {
      await preparedCheck();
      const restored = await checked(() => restore(binding2.artifactDigest, { rootPath: data.root, directoryName: `${kind}-${randomUUID4()}` }));
      if (restored.candidateRevision !== binding2.candidateRevision || restored.tree !== manifest.tree || dirname2(restored.worktreePath) !== data.root) throw new Error("restored candidate mismatch");
      if (kind === "tests" && containedOptions) {
        assertExactCandidateFiles(restored.worktreePath, binding2.candidateRevision);
        containedImage = snapshot2(await checked(() => prepareGraphContainedImage(containedOptions, restored.worktreePath, binding2.candidateRevision, check)));
        assertExactCandidateFiles(restored.worktreePath, binding2.candidateRevision);
      }
      paths.push(restored.worktreePath);
      await preparedCheck();
    }
    reviewPath = paths[data.kinds.indexOf("review")];
    testsPath = paths[data.kinds.indexOf("tests")];
    const final = await checked(() => verifyArtifact(binding2.artifactDigest));
    validateManifest(final);
    if (verificationCanonical3(final) !== verificationCanonical3(manifest)) throw new Error("artifact changed during preparation");
    await preparedCheck();
  } catch (error) {
    preparationFailure = { error };
  }
  try {
    if (!preparationLease) await lease.release();
  } catch (error) {
    lease.retain(String(error));
    throw error;
  }
  if (preparationFailure) throw preparationFailure.error;
  check();
  const workspaces = {};
  if (reviewPath) workspaces.review = snapshot2({ workspace_id: binding2.scope.workspaceId, workspace_path: reviewPath });
  if (testsPath) workspaces.tests = snapshot2({ workspace_id: binding2.scope.workspaceId, workspace_path: testsPath });
  const actions = data.kinds.map((kind) => {
    const workspace = workspaces[kind];
    assertExactCandidateFiles(workspace.workspace_path, binding2.candidateRevision);
    const trackedPaths = gitRaw(workspace.workspace_path, "ls-tree", "-rz", "--name-only", binding2.candidateRevision).split("\0").filter(Boolean);
    const trackedFingerprint = () => {
      const hash = createHash5("sha256");
      for (const name of trackedPaths) {
        const file = join2(workspace.workspace_path, name);
        let parent = dirname2(file);
        while (parent !== workspace.workspace_path) {
          if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) throw new Error("candidate tracked parent changed");
          parent = dirname2(parent);
        }
        const stat = lstatSync(file);
        if (!stat.isFile() && !stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024 * 1024) throw new Error("unsupported tracked entry");
        const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync3(file);
        hash.update(JSON.stringify([name, stat.mode, bytes.length, createHash5("sha256").update(bytes).digest("hex")]));
      }
      return hash.digest("hex");
    };
    const candidateIdentity = () => ({
      repositoryDigest: createHash5("sha256").update(repositoryStamp(workspace.workspace_path)).digest("hex"),
      head: git(workspace.workspace_path, "rev-parse", "HEAD"),
      tree: git(workspace.workspace_path, "rev-parse", "HEAD^{tree}"),
      indexTree: git(workspace.workspace_path, "write-tree"),
      indexDigest: createHash5("sha256").update(gitRaw(workspace.workspace_path, "ls-files", "--stage", "-v", "-z")).digest("hex"),
      trackedDigest: trackedFingerprint(),
      ...kind === "tests" && containedImage ? { containedContentDigest: containedImage.contentDigest } : {},
      ...kind === "review" ? { inventoryDigest: workspaceFingerprint(workspace.workspace_path) } : {}
    });
    workspaceFingerprint(workspace.workspace_path);
    const before = snapshot2(candidateIdentity());
    if (before.head !== binding2.candidateRevision || before.tree !== manifest.tree || before.indexTree !== manifest.tree) throw new Error("candidate workspace mutation detected");
    const observe = () => {
      try {
        return candidateIdentity();
      } catch (error) {
        return { error: String(error).slice(0, 4096) };
      }
    };
    const candidateCheck = () => {
      check();
      if (verificationCanonical3(observe()) !== verificationCanonical3(before)) throw new Error("candidate workspace mutation detected");
      check();
    };
    candidateCheck();
    const contained = kind === "tests" && containedOptions && containedImage ? registerContainedTests(containedOptions, containedImage, binding2, acceptance.command) : void 0;
    const invocations = /* @__PURE__ */ new Map();
    const slot2 = data.slots[kind] ?? { nodeId: kind, effectSlot: "invoke", workspaceLeaseRef: `verification:${randomUUID4()}`, tokenReservation: 0 };
    if (!Number.isSafeInteger(slot2.tokenReservation) || slot2.tokenReservation < 0) throw new Error("invalid token reservation");
    const requestInput = { binding: binding2, generation: 1, requestId: "register", ...slot2 };
    const request = kind === "review" ? createReviewRequest(requestInput) : createTestsRequest(requestInput);
    const verifyWorkspace = async () => {
      await independent();
      candidateCheck();
    };
    const persist = async (raw, context) => {
      const evidence2 = snapshot2(raw);
      const settlementCheck = () => {
        if (context?.signal.aborted && evidence2.stopped === true && authorizeCancel) checkedAuthority(authorizeCancel)();
        else check();
      };
      settlementCheck();
      if (evidence2.stopped !== true || evidence2.candidate?.status === "execution_unconfirmed" || evidence2.candidate?.execution?.failure_code === "cancellation_unconfirmed" || evidence2.command?.failure_code === "process_exit_unconfirmed" || evidence2.command?.failure_code === "surviving_descendants") throw new Error("executor stop unconfirmed");
      const effect = snapshot2(validateVerificationEffect(effectIdentity(kind), binding2, slot2.nodeId, slot2.effectSlot));
      settlementCheck();
      const identityCheck = await verifyReviewer(identities);
      if (identityCheck !== void 0) throw new Error("independent verifier must return void");
      settlementCheck();
      if (verificationCanonical3(validateVerificationEffect(effectIdentity(kind), binding2, slot2.nodeId, slot2.effectSlot)) !== verificationCanonical3(effect)) throw new Error("ledger effect changed during verification");
      const envelope = {
        schemaVersion: 1,
        binding: binding2,
        kind,
        nodeId: slot2.nodeId,
        effectSlot: slot2.effectSlot,
        ...effect,
        workspace,
        workspaceLeaseRef: slot2.workspaceLeaseRef,
        candidateIdentity: { before, after: observe() },
        acceptance,
        writerIdentity: data.writerIdentity,
        reviewerIdentity: data.reviewerIdentity,
        evidence: evidence2
      };
      if (context?.signal.aborted) envelope.verificationFailure = { code: "INTERNAL_ERROR", message: "Verification cancelled after confirmed executor stop", retrySafe: false };
      if (verificationCanonical3(envelope.candidateIdentity.after) !== verificationCanonical3(before)) envelope.verificationFailure = { code: "INTERNAL_ERROR", message: "Candidate workspace mutation detected after execution", retrySafe: false };
      if (kind === "review") {
        const receipt = invocations.get(evidence2.candidate?.execution?.run_id ?? "");
        if (!receipt || receipt.effectKey !== effect.effectKey) throw new Error("missing actual reviewer invocation receipt");
        envelope.reviewerInvocation = receipt;
        if (!envelope.verificationFailure) {
          if (evidence2.status !== "completed" || evidence2.candidate?.execution?.failure_code || evidence2.candidate?.status !== "implementation_complete") envelope.verificationFailure = { code: "INTERNAL_ERROR", message: "Review executor failed after stopping", retrySafe: true };
          else {
            try {
              envelope.report = parseReviewReport2(JSON.parse(evidence2.candidate.execution?.summary ?? "null"));
            } catch {
              envelope.verificationFailure = { code: "OUTPUT_CONTRACT_INVALID", message: "Review summary is not a valid structured report", retrySafe: true };
            }
          }
        }
      } else if (contained) {
        if (!evidence2.contained || evidence2.command) throw Error("missing actual contained command evidence");
        contained.verify(evidence2.contained);
        const receipt = validateContainedTestEvidence(evidence2.contained, binding2, effect.effectKey, acceptance.command, before.containedContentDigest);
        if (!envelope.verificationFailure && (receipt.result.cancelled || ![...acceptance.passExitCodes, ...acceptance.failExitCodes].includes(receipt.result.exitCode))) envelope.verificationFailure = { code: "INTERNAL_ERROR", message: "Contained command cancelled or returned unregistered exit code", retrySafe: false };
      } else {
        if (evidence2.contained) throw Error("unexpected contained evidence");
        const command = evidence2.command;
        if (!command || command.command !== acceptance.command || command.termination?.stop_confirmed !== true) throw new Error("missing actual registered command stop evidence");
        if (!envelope.verificationFailure && (command.failure_code || command.cancellation || command.termination.scope !== "posix_process_group" || command.termination.trigger !== "exit" || command.termination.leader_exit_code !== command.exitCode || ![...acceptance.passExitCodes, ...acceptance.failExitCodes].includes(command.exitCode))) envelope.verificationFailure = { code: "INTERNAL_ERROR", message: "Acceptance command infrastructure failure or unregistered exit code", retrySafe: true };
      }
      compactVerificationOutput(envelope);
      return publishGraphVerificationEvidence(data.root, envelope, () => {
        if (verificationCanonical3(observe()) !== verificationCanonical3(envelope.candidateIdentity.after)) throw new Error("candidate changed during persistence");
        settlementCheck();
        if (verificationCanonical3(validateVerificationEffect(effectIdentity(kind), binding2, slot2.nodeId, slot2.effectSlot)) !== verificationCanonical3(effect)) throw new Error("ledger effect changed during persistence");
      });
    };
    const plan = snapshot2(ExecutionPlan2.parse({
      plan_id: `verification:${randomUUID4()}`,
      agent_id: kind === "review" ? reviewer.id : "registered-command",
      max_iterations: 1,
      task: {
        task_id: `verification:${kind}:${randomUUID4()}`,
        capability: kind === "review" ? matches[0].kind : "code.test",
        source: "manual",
        prompt: kind === "review" ? `Independently review frozen candidate ${binding2.candidateRevision} against acceptance ${binding2.acceptanceRef}. Return only JSON {"schemaVersion":1,"verdict":"accept"|"changes_requested","summary":string,"findings":string[]}. Do not modify files.` : `Run registered acceptance ${binding2.acceptanceRef}.`
      },
      stop_condition: { type: kind === "review" ? "review_approved" : "tests_pass" }
    }));
    const invocationReviewer = Object.freeze({
      ...reviewer,
      invoke: (task, signal) => (async function* () {
        const runId = task.run_id;
        const taskId = task.task_id;
        await independent();
        candidateCheck();
        await authorizePolicy?.(workspace.workspace_path);
        check();
        if (signal.aborted) throw new Error("review invocation cancelled");
        if (taskId !== plan.task.task_id || invocations.has(runId)) throw new Error("invalid or repeated reviewer invocation");
        const actual = snapshot2({
          run_id: runId,
          task_id: taskId,
          session_id: randomUUID4(),
          capability_id: data.capabilityId,
          prompt: plan.task.prompt,
          context: { repo_path: workspace.workspace_path }
        });
        const effect = validateVerificationEffect(effectIdentity(kind), binding2, slot2.nodeId, slot2.effectSlot);
        invocations.set(runId, snapshot2({
          runId,
          taskId,
          sessionId: actual.session_id,
          adapterId: reviewer.id,
          capabilityId: actual.capability_id,
          promptDigest: createHash5("sha256").update(actual.prompt).digest("hex"),
          contextDigest: createHash5("sha256").update(verificationCanonical3(actual.context)).digest("hex"),
          historyPassed: false,
          effectKey: effect.effectKey
        }));
        check();
        yield* reviewer.invoke(actual, signal);
      })()
    });
    const action = {
      nodeId: slot2.nodeId,
      effectSlot: slot2.effectSlot,
      action: snapshot2(request.action),
      tokenReservation: slot2.tokenReservation,
      workspace,
      verifyWorkspace,
      persist,
      execution: kind === "review" ? { kind: "adapter", plan, adapter: invocationReviewer, capabilityId: data.capabilityId } : contained ? { kind: "contained", plan, ...contained.registration } : { kind: "command", plan, command: acceptance.command }
    };
    Object.freeze(action.execution);
    return Object.freeze(action);
  });
  return Object.freeze({ binding: binding2, workspaces: Object.freeze(workspaces), actions: Object.freeze(actions) });
}

// packages/cli/src/graph-verification-join.ts
import { GraphVerificationStore } from "@osstack/core/graph-verification";
import { GraphError, GraphResult as GraphResult4, freezeWorkerData as freezeWorkerData3 } from "@osstack/protocol";
import { joinVerificationBranches } from "@osstack/graph/join";
import { routeVerification } from "@osstack/graph/route";
import { parseVerificationBinding as parseVerificationBinding3, verificationCanonical as verificationCanonical4 } from "@osstack/graph/nodes/branch";
var GraphVerificationJoinService = class {
  constructor(db, options) {
    this.db = db;
    this.options = freezeWorkerData3(structuredClone({
      binding: parseVerificationBinding3(options.binding),
      evidenceRoot: options.evidenceRoot,
      slots: options.slots,
      nextCost: options.nextCost
    }));
    this.authorize = options.authorize;
    this.verifyArtifact = options.artifacts.verify.bind(options.artifacts);
  }
  db;
  options;
  authorize;
  verifyArtifact;
  check() {
    const value = this.authorize();
    if (value !== void 0) {
      void Promise.resolve(value).catch(() => {
      });
      throw Error("authority must be synchronous");
    }
  }
  async evaluate(fenceValue, now = Date.now) {
    this.check();
    const fence3 = freezeWorkerData3(structuredClone(fenceValue));
    let attested;
    const store = new GraphVerificationStore(this.db, (snapshot4, value) => {
      this.check();
      if (!attested || snapshot4.digest !== attested.digest || verificationCanonical4(value) !== verificationCanonical4(attested.joined)) throw Error("JOIN_ATTESTATION_MISMATCH");
    });
    const snapshot3 = store.snapshot(fence3);
    const { binding: binding2, slots } = this.options;
    if (binding2.graphRunId !== snapshot3.run.graphRunId || binding2.specHash !== snapshot3.run.identity.specHash || verificationCanonical4(binding2.scope) !== verificationCanonical4(snapshot3.run.scope) || !snapshot3.run.spec || binding2.acceptanceRef !== snapshot3.run.spec.input.acceptanceRef || binding2.epoch >= snapshot3.run.spec.limits.maxEpochs) throw Error("JOIN_BINDING_MISMATCH");
    const manifest = await this.verifyArtifact(binding2.artifactDigest);
    this.check();
    if (manifest.candidateRevision !== binding2.candidateRevision || manifest.input.runId !== binding2.graphRunId || verificationCanonical4(manifest.input.scope) !== verificationCanonical4(binding2.scope)) throw Error("JOIN_ARTIFACT_MISMATCH");
    const latest = (kind) => snapshot3.actions.filter((a) => a.effect.epoch === binding2.epoch && a.effect.nodeId === slots[kind].nodeId && a.effect.effectSlot === slots[kind].effectSlot).sort((a, b) => b.effect.logicalAttempt - a.effect.logicalAttempt)[0];
    const selected = { review: latest("review"), tests: latest("tests") };
    const expected = {
      review: { ...slots.review, logicalAttempt: selected.review?.effect.logicalAttempt ?? 0 },
      tests: { ...slots.tests, logicalAttempt: selected.tests?.effect.logicalAttempt ?? 0 }
    };
    const branches = [];
    for (const kind of ["review", "tests"]) {
      const action = selected[kind];
      if (!action) continue;
      if (action.action.kind !== kind || !("candidateRevision" in action.action) || action.action.candidateRevision !== binding2.candidateRevision || (action.action.kind === "review" ? action.action.acceptanceRef : action.action.kind === "tests" ? action.action.commandSpecRef : "") !== binding2.acceptanceRef) throw Error("JOIN_ACTION_MISMATCH");
      const base = {
        schemaVersion: 1,
        binding: binding2,
        kind,
        nodeId: action.effect.nodeId,
        effectSlot: action.effect.effectSlot,
        logicalAttempt: action.effect.logicalAttempt,
        effectKey: action.effectKey
      };
      if (action.state === "confirmed" || action.state === "failed") {
        const outcome = action.outcome;
        if (!outcome || outcome.state !== action.state) throw Error("JOIN_OUTCOME_MISMATCH");
        if (outcome.state === "failed" && !outcome.evidenceRef.startsWith("graph-verification:")) {
          const parsed = GraphError.safeParse(outcome.error);
          const error = parsed.success && !parsed.data.retryable ? parsed.data : GraphError.parse({
            schemaVersion: 1,
            code: "POLICY_DENIED",
            message: "Stopped action has no attested verification report; host must inspect admission/execution failure",
            retryable: false,
            nextAction: "stop"
          });
          branches.push({ ...base, state: "failed", error });
          continue;
        }
        const envelope = await loadGraphVerificationEvidence(this.options.evidenceRoot, outcome.evidenceRef, binding2, { effect: action.effect, effectKey: action.effectKey });
        this.check();
        if (envelope.kind !== kind || envelope.nodeId !== action.effect.nodeId || envelope.effectSlot !== action.effect.effectSlot || envelope.workspaceLeaseRef !== action.action.workspaceLeaseRef) throw Error("JOIN_EVIDENCE_MISMATCH");
        if (outcome.state === "confirmed") {
          if (envelope.verificationFailure) throw Error("JOIN_FAILED_EVIDENCE");
          const result = GraphResult4.parse({
            schemaVersion: 1,
            kind,
            candidateRevision: binding2.candidateRevision,
            evidenceRefs: [outcome.evidenceRef],
            evidenceDigest: outcome.evidenceRef.slice("graph-verification:".length),
            ...kind === "review" ? { verdict: envelope.report.verdict } : { passed: envelope.acceptance.passExitCodes.includes(envelope.evidence.contained?.result.exitCode ?? envelope.evidence.command.exitCode) }
          });
          if (verificationCanonical4(outcome.result) !== verificationCanonical4(result)) throw Error("JOIN_RESULT_MISMATCH");
          branches.push({ ...base, state: "confirmed", result });
        } else {
          const failure = envelope.verificationFailure;
          const error = failure ? GraphError.parse(outcome.error) : GraphError.parse({
            schemaVersion: 1,
            code: "INTERNAL_ERROR",
            message: "Stopped invocation has no retryable verification classification",
            retryable: false,
            nextAction: "stop"
          });
          if (failure && (error.code !== failure.code || error.message !== failure.message || error.retryable !== failure.retrySafe || outcome.retrySafe !== failure.retrySafe)) throw Error("JOIN_FAILURE_MISMATCH");
          branches.push({ ...base, state: "failed", error });
        }
      } else {
        const cancelling = action.state === "cancel_pending";
        branches.push({ ...base, state: cancelling ? "cancel_pending" : "unknown", error: {
          schemaVersion: 1,
          code: cancelling ? "CANCEL_UNCONFIRMED" : "ACTION_OUTCOME_UNKNOWN",
          message: "Ledger execution requires reconciliation",
          retryable: false,
          nextAction: "reconcile"
        } });
      }
    }
    this.check();
    const time = now();
    const current = store.snapshot({ ...fence3, now: time });
    if (current.digest !== snapshot3.digest) throw Error("VERIFICATION_SNAPSHOT_CHANGED");
    const joined = joinVerificationBranches({ binding: binding2, expected, branches }, (branch) => {
      if (!branches.some((original) => verificationCanonical4(branch) === verificationCanonical4(original))) throw Error("JOIN_BRANCH_MISMATCH");
    });
    const spent = (kind) => selected[kind] ? 1 + snapshot3.actions.filter((a) => a.effect.epoch === binding2.epoch && a.effect.nodeId === slots[kind].nodeId && a.effect.logicalAttempt > 1).length : 0;
    const route = routeVerification(joined, {
      binding: binding2,
      spec: snapshot3.run.spec,
      runStatus: snapshot3.run.status,
      runCreatedAt: snapshot3.run.createdAt,
      now: time,
      ...snapshot3.budget,
      pendingAdmissions: snapshot3.pendingAdmissions,
      unresolvedActions: snapshot3.unresolvedActions,
      branchAttemptsSpent: { review: spent("review"), tests: spent("tests") },
      nextCost: this.options.nextCost
    });
    if (joined.status !== "complete" || snapshot3.unresolvedActions || snapshot3.pendingAdmissions || snapshot3.run.status !== "running") return freezeWorkerData3({ joined, route, snapshot: snapshot3 });
    attested = { digest: snapshot3.digest, joined };
    const committed = store.commit(snapshot3, joined, time);
    return freezeWorkerData3({
      joined,
      route,
      snapshot: store.snapshot({ ...fence3, expectedRevision: committed.run.revision, now: time }),
      publication: { record: committed.record, created: committed.created }
    });
  }
};

// packages/cli/src/graph-delivery-receipts.ts
import { createHash as createHash6, randomUUID as randomUUID5 } from "node:crypto";
import { constants as constants2 } from "node:fs";
import { dirname as dirname3, isAbsolute as isAbsolute4, join as join3 } from "node:path";
import { link as link2, mkdir as mkdir3, open as open2, realpath as realpath3, unlink as unlink2 } from "node:fs/promises";
import { GraphEffectIdentity as GraphEffectIdentity2, GraphJsonValue as GraphJsonValue5, computeGraphEffectKey as computeGraphEffectKey2, freezeWorkerData as freezeWorkerData4, workerCanonical as workerCanonical6 } from "@osstack/protocol";
var limit = 128 * 1024;
var sha3 = (bytes) => createHash6("sha256").update(bytes).digest("hex");
function binding(value) {
  const data = GraphJsonValue5.parse(value);
  const effect = GraphEffectIdentity2.parse(data.effect);
  if (Object.keys(data).sort().join() !== "effect,effectKey,generation,owner,workspacePath" || data.effectKey !== computeGraphEffectKey2(effect) || !Number.isSafeInteger(data.generation) || data.generation < 1 || typeof data.owner !== "string" || !data.owner.trim() || data.owner.length > 256 || typeof data.workspacePath !== "string" || !isAbsolute4(data.workspacePath) || data.workspacePath.includes("\0")) throw Error("DELIVERY_RECEIPT_BINDING");
  return freezeWorkerData4({ ...data, effect });
}
function evidence(value) {
  const data = GraphJsonValue5.parse(value);
  if (!data || typeof data !== "object" || Array.isArray(data) || !["completed", "failed"].includes(String(data.status)) || data.stopped !== void 0 && data.stopped !== true) throw Error("DELIVERY_RECEIPT_EVIDENCE");
  return freezeWorkerData4(data);
}
async function directory2(root, create) {
  if (!isAbsolute4(root) || await realpath3(root) !== root) throw Error("DELIVERY_RECEIPT_ROOT");
  const dir = join3(root, "delivery-receipts");
  if (create) await mkdir3(dir, { recursive: true, mode: 448 });
  if (await realpath3(dir) !== dir) throw Error("DELIVERY_RECEIPT_ROOT");
  return dir;
}
async function syncDirectory2(path2) {
  const file = await open2(path2, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function readBounded(file) {
  const stat = await file.stat();
  if (!stat.isFile() || stat.size > limit) throw Error("DELIVERY_RECEIPT_LIMIT");
  const buffer = Buffer.alloc(limit + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset > limit) throw Error("DELIVERY_RECEIPT_LIMIT");
  return buffer.subarray(0, offset);
}
async function publishDeliveryReceipt(root, identity, value, authorize) {
  const check = () => {
    const result = authorize();
    if (result !== void 0) {
      void Promise.resolve(result).catch(() => {
      });
      throw Error("DELIVERY_RECEIPT_AUTHORITY");
    }
  };
  check();
  const body = { schemaVersion: 1, binding: binding(identity), evidence: evidence(JSON.parse(JSON.stringify(value))) };
  const bytes = Buffer.from(workerCanonical6(body));
  if (bytes.length > limit) throw Error("DELIVERY_RECEIPT_LIMIT");
  const checked = async (fn) => {
    check();
    const result = await fn();
    check();
    return result;
  };
  const dir = await checked(() => directory2(root, true));
  const digest2 = sha3(bytes);
  const temporary = join3(dir, `.${randomUUID5()}`);
  const final = join3(dir, `${digest2}.json`);
  check();
  const file = await open2(temporary, "wx", 384);
  try {
    check();
    await checked(() => file.writeFile(bytes));
    await checked(() => file.sync());
  } finally {
    await file.close();
  }
  try {
    await checked(async () => {
      try {
        await link2(temporary, final);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = await open2(final, constants2.O_RDONLY | constants2.O_NOFOLLOW);
        try {
          if (sha3(await readBounded(existing)) !== digest2) throw Error("DELIVERY_RECEIPT_DIGEST");
        } finally {
          await existing.close();
        }
      }
    });
    await checked(() => syncDirectory2(dir));
    await checked(() => syncDirectory2(root));
    await checked(() => syncDirectory2(dirname3(root)));
  } finally {
    await unlink2(temporary);
  }
  check();
  return `graph-delivery:${digest2}`;
}
async function loadDeliveryReceipt(root, ref3, expected) {
  const target = binding(expected);
  if (!/^graph-delivery:[a-f0-9]{64}$/.test(ref3)) throw Error("DELIVERY_RECEIPT_REF");
  const digest2 = ref3.slice("graph-delivery:".length);
  const dir = await directory2(root, false);
  const file = await open2(join3(dir, `${digest2}.json`), constants2.O_RDONLY | constants2.O_NOFOLLOW);
  let bytes;
  try {
    bytes = await readBounded(file);
  } finally {
    await file.close();
  }
  if (bytes.length > limit || sha3(bytes) !== digest2) throw Error("DELIVERY_RECEIPT_DIGEST");
  const body = GraphJsonValue5.parse(JSON.parse(bytes.toString("utf8")));
  if (!body || typeof body !== "object" || Array.isArray(body) || body.schemaVersion !== 1 || Object.keys(body).sort().join() !== "binding,evidence,schemaVersion" || workerCanonical6(body.binding) !== workerCanonical6(target)) throw Error("DELIVERY_RECEIPT_BINDING");
  return evidence(body.evidence);
}

// packages/cli/src/graph-bounded-recovery-journal.ts
import { createHash as createHash7, randomUUID as randomUUID6 } from "node:crypto";
import { constants as constants3, closeSync, fstatSync, fsyncSync, linkSync, lstatSync as lstatSync2, mkdirSync, openSync, readSync, readdirSync as readdirSync2, realpathSync as realpathSync2, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute as isAbsolute5, join as join4 } from "node:path";
import { z as z3 } from "zod";
import { workerCanonical as workerCanonical7 } from "@osstack/protocol";
import { resolveRepositoryScope } from "@osstack/core";
import { inspectRepoWriteLock } from "@osstack/autonomy";
var digest = z3.string().regex(/^[a-f0-9]{64}$/);
var path = z3.string().min(1).refine((s) => isAbsolute5(s) && !s.includes("\0"));
var owner = z3.object({
  pid: z3.number().int().positive(),
  autonomy_run_id: z3.string().min(1),
  repo_id: z3.string().min(1),
  acquired_at: z3.string().datetime(),
  token: z3.string().uuid(),
  expires_at: z3.string().datetime().optional(),
  recovery_policy: z3.literal("reconcile").optional()
}).strict();
var schema = z3.object({
  version: z3.literal(1),
  effectKey: digest,
  actionDigest: digest,
  executionRef: z3.string().min(1),
  generation: z3.literal(1),
  owner: z3.string().min(1),
  workspacePath: path,
  commonDir: path,
  repoId: z3.string().min(1),
  fingerprint: digest,
  evidenceRef: z3.string().regex(/^graph-delivery:[a-f0-9]{64}$/),
  lockOwner: owner
}).strict();
var sha4 = (value) => createHash7("sha256").update(value).digest("hex");
var boundedActionDigest = (action) => sha4(workerCanonical7({
  effect: action.effect,
  action: action.action,
  generation: action.generation,
  executionRef: action.executionRef,
  businessDigest: action.businessDigest
}));
function read(path2, limit2) {
  const fd = openSync(path2, constants3.O_RDONLY | constants3.O_NOFOLLOW | constants3.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit2) throw Error("BOUNDED_RECOVERY_FILE");
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) break;
      offset += n;
    }
    if (offset !== stat.size) throw Error("BOUNDED_RECOVERY_FILE_CHANGED");
    return bytes.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}
function boundedWorkspaceFingerprint(root) {
  if (!isAbsolute5(root) || realpathSync2(root) !== root) throw Error("BOUNDED_RECOVERY_WORKSPACE");
  const hash = createHash7("sha256");
  let remaining = 32 * 1024 * 1024;
  let count2 = 0;
  const visit = (directory4, prefix) => {
    const directoryStat = lstatSync2(directory4);
    if (!directoryStat.isDirectory() || realpathSync2(directory4) !== directory4) throw Error("BOUNDED_RECOVERY_WORKSPACE");
    for (const name of readdirSync2(directory4).sort()) {
      const relative = `${prefix}${name}`;
      if (relative === ".git/osstack/writer-locks") continue;
      if (++count2 > 1e4) throw Error("BOUNDED_RECOVERY_LIMIT");
      const full = join4(directory4, name);
      const stat = lstatSync2(full);
      hash.update(workerCanonical7([relative, stat.mode, stat.isDirectory() ? "directory" : "file"]));
      if (stat.isDirectory()) visit(full, `${relative}/`);
      else {
        const bytes = read(full, remaining);
        remaining -= bytes.length;
        hash.update(workerCanonical7([bytes.length, sha4(bytes)]));
      }
    }
  };
  visit(root, "");
  return hash.digest("hex");
}
function directory3(root, create = false) {
  if (realpathSync2(root) !== root) throw Error("BOUNDED_RECOVERY_ROOT");
  const dir = join4(root, "bounded-recovery");
  if (create) mkdirSync(dir, { recursive: true, mode: 448 });
  if (realpathSync2(dir) !== dir) throw Error("BOUNDED_RECOVERY_ROOT");
  return dir;
}
function sync(path2) {
  const fd = openSync(path2, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function loadBoundedRecoveryJournal(root, effectKey) {
  digest.parse(effectKey);
  const result = schema.parse(JSON.parse(read(join4(directory3(root), `${effectKey}.json`), 16384).toString("utf8")));
  if (result.effectKey !== effectKey) throw Error("BOUNDED_RECOVERY_BINDING");
  return result;
}
function assertBoundedDeliveryReceipt(root, ref3) {
  if (!/^graph-delivery:[a-f0-9]{64}$/.test(ref3) || realpathSync2(root) !== root) throw Error("BOUNDED_RECOVERY_RECEIPT");
  const dir = join4(root, "delivery-receipts");
  if (realpathSync2(dir) !== dir || sha4(read(join4(dir, `${ref3.slice(15)}.json`), 128 * 1024)) !== ref3.slice(15)) throw Error("BOUNDED_RECOVERY_RECEIPT");
}
async function publishBoundedRecoveryJournal(root, action, workerOwner, workspacePath, evidenceRef, evidence2, authorize) {
  if (action.generation !== 1 || action.effect.epoch !== 0 || action.effect.nodeId !== "e0.implement" || action.action.kind !== "implement" || action.state !== "running" || !action.executionRef || evidence2.status !== "completed" || evidence2.stopped !== true || !/^(anthropic|deepseek)-bounded-v1:/.test(evidence2.stopEvidenceRef ?? "")) return;
  const check = () => {
    const value = authorize();
    if (value !== void 0) {
      void Promise.resolve(value).catch(() => {
      });
      throw Error("BOUNDED_RECOVERY_AUTHORITY");
    }
  };
  check();
  const scope = await resolveRepositoryScope(workspacePath);
  check();
  if (scope.commonDir !== join4(workspacePath, ".git")) return;
  const lockOwner = await inspectRepoWriteLock(join4(scope.commonDir, "osstack", "writer-locks"), scope.repoId);
  check();
  if (!lockOwner?.token || lockOwner.pid !== process.pid || lockOwner.autonomy_run_id !== `graph-action:${action.effectKey}`) return;
  let fingerprint;
  try {
    fingerprint = boundedWorkspaceFingerprint(workspacePath);
  } catch {
    return;
  }
  const body = schema.parse({
    version: 1,
    effectKey: action.effectKey,
    actionDigest: boundedActionDigest(action),
    executionRef: action.executionRef,
    generation: action.generation,
    owner: workerOwner,
    workspacePath,
    commonDir: scope.commonDir,
    repoId: scope.repoId,
    fingerprint,
    evidenceRef,
    lockOwner
  });
  check();
  const dir = directory3(root, true);
  const target = join4(dir, `${action.effectKey}.json`);
  const temporary = `${target}.${randomUUID6()}`;
  const fd = openSync(temporary, "wx", 384);
  try {
    writeFileSync(fd, workerCanonical7(body));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    check();
    linkSync(temporary, target);
    sync(dir);
    sync(root);
  } finally {
    unlinkSync(temporary);
  }
  check();
}

// packages/cli/src/graph-delivery.ts
function assertGraphDeliverySupported(options) {
  assertGraphAdapterSupported(options.writer.adapter);
  assertGraphAdapterSupported(options.reviewer.adapter);
}
function graphDeliveryVersion(compiled) {
  return {
    executionModel: "langgraph-functional-v1",
    durability: "sync",
    engineVersion: "1.4.15",
    checkpointVersion: "1.1.5",
    templateVersion: "4",
    registryVersion: compiled.registryVersion,
    compilerVersion: compiled.compilerVersion,
    schemaVersion: compiled.schemaVersion,
    compiledProgramDigest: compiled.compiledProgramDigest
  };
}
var git2 = (cwd, ...args) => execFileSync4("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
  cwd,
  encoding: "utf8",
  timeout: 3e4,
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
}).trim();
var GraphDelivery = class {
  compiled;
  broker;
  artifacts;
  runs;
  runValue;
  owned;
  runtime;
  epoch = 0;
  installed = /* @__PURE__ */ new Map();
  branches = /* @__PURE__ */ new Map();
  workspaces = /* @__PURE__ */ new Map();
  feedbackRef;
  connection;
  closed = false;
  started = false;
  stopping = false;
  active;
  waiting;
  options;
  constructor(options) {
    assertGraphDeliverySupported(options);
    const adapter = (a) => {
      const capabilities = freezeWorkerData5(structuredClone(a.capabilities()));
      return Object.freeze({
        id: a.id,
        display_name: a.display_name,
        cost_tier: a.cost_tier,
        capabilities: () => structuredClone(capabilities),
        isAvailable: a.isAvailable.bind(a),
        invoke: a.invoke.bind(a),
        ...a.confirmStopped ? { confirmStopped: a.confirmStopped.bind(a) } : {}
      });
    };
    this.options = Object.freeze({
      ...options,
      request: freezeWorkerData5(StartGraphRequest2.parse(options.request)),
      writer: Object.freeze({ ...options.writer, adapter: adapter(options.writer.adapter) }),
      reviewer: Object.freeze({ ...options.reviewer, adapter: adapter(options.reviewer.adapter) }),
      ...options.containedTests ? { containedTests: Object.freeze({ ...options.containedTests }) } : {},
      acceptanceRegistry: freezeWorkerData5(structuredClone(options.acceptanceRegistry))
    });
    options = this.options;
    const capability = options.writer.adapter.capabilities().find((c) => c.id === options.writer.capabilityId);
    if (options.writer.identity !== options.writer.adapter.id || !capability || !["code.write", "code.refactor", "code.debug"].includes(capability.kind)) throw Error("WRITER_IDENTITY_REQUIRED");
    this.compiled = compileGraphSpec(options.request.spec);
    this.runs = new GraphRunStore5(options.db);
    if (options.reservedRun) this.runValue = options.reservedRun;
    this.broker = new GraphActionBroker(options.db, {
      acquire: options.acquire,
      ...options.authorizePolicy ? { authorizePolicy: (workspacePath) => options.authorizePolicy({ policyRoot: options.repositoryPath, workspacePath }) } : {}
    });
    this.artifacts = new GraphArtifactStore(join5(options.root, "artifacts"));
  }
  /** Called by the service after run() completes, before its shared DB closes. */
  async drainDatabaseUsers() {
    if (this.runtime) await this.runtime.drainDatabaseUsers();
  }
  current() {
    return this.runs.get(this.runValue.scope, this.runValue.graphRunId);
  }
  leaseDeadline() {
    const createdAt = this.runValue ? this.current().createdAt : Date.now();
    return Math.min(Date.now() + 3e5, createdAt + this.compiled.spec.limits.deadlineSeconds * 1e3 + 1e3);
  }
  assertOwned() {
    if (!this.owned) return;
    const r = this.current();
    if (r.generation !== this.owned.generation || r.leaseOwner !== this.owned.leaseOwner || workerCanonical8(r.identity) !== workerCanonical8(this.owned.identity)) throw Error("STALE_DELIVERY_OWNER");
  }
  fence(premise = this.current()) {
    this.assertOwned();
    const r = premise;
    return {
      scope: r.scope,
      graphRunId: r.graphRunId,
      identity: r.identity,
      expectedGeneration: r.generation,
      expectedOwner: r.leaseOwner,
      expectedRevision: r.revision,
      now: Date.now()
    };
  }
  check() {
    if (this.closed) throw Error("DELIVERY_CLOSED");
    this.assertOwned();
    const value = this.options.authorize();
    if (value !== void 0) {
      void Promise.resolve(value).catch(() => {
      });
      throw Error("AUTHORITY_MUST_BE_SYNCHRONOUS");
    }
  }
  checkSettlement() {
    if (!this.stopping || this.current().status !== "cancel_pending" || !this.options.authorizeCancel) {
      this.check();
      return;
    }
    this.assertOwned();
    const value = this.options.authorizeCancel();
    if (value !== void 0) {
      void Promise.resolve(value).catch(() => {
      });
      throw Error("AUTHORITY_MUST_BE_SYNCHRONOUS");
    }
  }
  latest(nodeId, effectSlot = "main") {
    const row = this.options.db.prepare("SELECT effect_key FROM graph_actions WHERE graph_run_id=? AND node_id=? AND effect_slot=? ORDER BY logical_attempt DESC LIMIT 1").get(this.current().graphRunId, nodeId, effectSlot);
    return row ? new GraphActionStore2(this.options.db).get(this.fence(), row.effect_key).action : void 0;
  }
  result(nodeId) {
    const a = this.latest(nodeId);
    if (a?.outcome?.state !== "confirmed") throw Error(`PREDECESSOR_NOT_CONFIRMED: ${nodeId}`);
    return a.outcome.result;
  }
  candidate(epoch = this.epoch) {
    const value = this.result(`e${epoch}.freeze`);
    if (value.kind !== "candidate_ready") throw Error("CANDIDATE_REQUIRED");
    return value;
  }
  binding() {
    const r = this.current();
    const c = this.candidate();
    return {
      scope: r.scope,
      graphRunId: r.graphRunId,
      specHash: r.identity.specHash,
      epoch: this.epoch,
      candidateRevision: c.candidateRevision,
      artifactDigest: c.artifactDigest,
      acceptanceRef: r.spec.input.acceptanceRef
    };
  }
  receiptBinding(nodeId, workspacePath, effectSlot = "main") {
    const a = this.latest(nodeId, effectSlot);
    const r = this.current();
    if (!a) throw Error("DELIVERY_EFFECT_REQUIRED");
    const owner2 = this.options.db.prepare("SELECT owner FROM graph_worker_leases WHERE graph_run_id=? AND generation=?").get(r.graphRunId, a.generation);
    if (!owner2) throw Error("DELIVERY_EFFECT_LEASE_REQUIRED");
    return { effect: a.effect, effectKey: a.effectKey, generation: a.generation, owner: owner2.owner, workspacePath };
  }
  async persist(nodeId, workspacePath, evidence2, effectSlot = "main") {
    if (this.latest(nodeId, effectSlot)?.state !== "running") throw Error("RUNNING_EFFECT_REQUIRED");
    const ref3 = await publishDeliveryReceipt(this.options.root, this.receiptBinding(nodeId, workspacePath, effectSlot), evidence2, () => this.checkSettlement());
    const action = this.latest(nodeId, effectSlot);
    await publishBoundedRecoveryJournal(this.options.root, action, this.current().leaseOwner, workspacePath, ref3, evidence2, () => this.checkSettlement());
    return ref3;
  }
  async restoreWorkspaceMappings() {
    for (let epoch = 0; epoch <= this.epoch; epoch++) {
      const nodeId = `e${epoch}.workspace`;
      const a = this.latest(nodeId);
      if (a?.outcome?.state !== "confirmed") continue;
      const receipt = await loadDeliveryReceipt(this.options.root, a.outcome.evidenceRef, this.receiptBinding(nodeId, this.options.repositoryPath));
      const value = receipt.workspace;
      const workspace = value?.workspace;
      if (!workspace || workspace.workspace_id !== this.current().scope.workspaceId || workspace.workspace_path !== join5(this.options.root, `writer-${epoch}`) || await realpath4(workspace.workspace_path) !== workspace.workspace_path) throw Error("WORKSPACE_RECEIPT_MISMATCH");
      this.check();
      this.workspaces.set(epoch, Object.freeze({ ...workspace }));
    }
  }
  workspace(epoch = this.epoch) {
    const w = this.workspaces.get(epoch);
    if (!w) throw Error("WORKSPACE_MAPPING_REQUIRED");
    return w;
  }
  async preparation(kind, attempt) {
    const p = deliveryEpoch(this.compiled, this.epoch);
    const n = p.node(`prepare_${kind}`);
    const candidate = this.candidate();
    const epoch = this.epoch;
    const source = this.workspace();
    const branch = p.node(kind);
    return {
      nodeId: n.id,
      effectSlot: p.preparationSlot(kind, attempt),
      tokenReservation: n.tokenReservation,
      action: { kind: "workspace_create", repositoryRef: this.compiled.spec.input.repositoryRef, baseRevision: candidate.candidateRevision },
      workspace: source,
      execution: { kind: "workspace", handler: async ({ lease }) => {
        const prepared = await prepareGraphVerificationBranch({
          root: join5(this.options.root, "verification"),
          artifacts: this.artifacts,
          candidate,
          binding: this.binding(),
          sourceWorkspace: source,
          authorize: () => this.check(),
          authorizeCancel: () => this.checkSettlement(),
          acquire: this.options.acquire,
          ...this.options.authorizePolicy ? { authorizePolicy: (workspacePath) => this.options.authorizePolicy({ policyRoot: this.options.repositoryPath, workspacePath }) } : {},
          ...this.options.containedTests ? { containedTests: this.options.containedTests } : {},
          preparationLease: lease,
          acceptanceRegistry: this.options.acceptanceRegistry,
          writerIdentity: this.options.writer.identity,
          reviewer: this.options.reviewer,
          verifyReviewer: this.options.verifyReviewer,
          slots: { [kind]: { nodeId: branch.id, effectSlot: branch.effectSlot, workspaceLeaseRef: `e${epoch}.${kind}`, tokenReservation: branch.tokenReservation } },
          effectIdentity: () => {
            const a = this.latest(branch.id);
            if (a?.state !== "running") throw Error("RUNNING_EFFECT_REQUIRED");
            return { effect: a.effect, effectKey: a.effectKey };
          }
        }, kind);
        const action = prepared.actions[0];
        this.branches.set(branch.id, action);
        return { status: "completed", stopped: true, evidence: { workspace: action.workspace, workspaceLeaseRef: `e${epoch}.${kind}` } };
      } },
      persist: async (evidence2) => ({
        evidenceRef: await this.persist(n.id, source.workspace_path, evidence2, p.preparationSlot(kind, attempt)),
        actualTokens: 0,
        result: { schemaVersion: 1, kind: "workspace", workspaceLeaseRef: `e${epoch}.${kind}`, receiptRef: `e${epoch}.prepared.${kind}.${attempt}` }
      })
    };
  }
  async registration(name) {
    const p = deliveryEpoch(this.compiled, this.epoch);
    const n = p.node(name);
    const r = this.current();
    const epoch = this.epoch;
    const common = { nodeId: n.id, effectSlot: n.effectSlot, tokenReservation: n.tokenReservation };
    const workspaceLeaseRef = `e${epoch}.writer`;
    if (name === "workspace") {
      const path2 = join5(this.options.root, `writer-${epoch}`);
      const workspace = { workspace_id: r.scope.workspaceId, workspace_path: path2 };
      const baseRevision = epoch === 0 ? this.compiled.spec.input.baseRevision : this.candidate(epoch - 1).candidateRevision;
      return {
        ...common,
        workspace: { workspace_id: r.scope.workspaceId, workspace_path: this.options.repositoryPath },
        action: { kind: "workspace_create", repositoryRef: this.compiled.spec.input.repositoryRef, baseRevision },
        execution: { kind: "workspace", handler: async () => {
          this.check();
          if (epoch === 0) {
            if (git2(this.options.repositoryPath, "rev-parse", `${baseRevision}^{commit}`) !== baseRevision) throw Error("BASE_REVISION_MISMATCH");
            git2(this.options.root, "clone", "--no-local", "--no-hardlinks", "--", this.options.repositoryPath, path2);
            git2(path2, "checkout", "--detach", baseRevision);
          } else {
            const restored = await this.artifacts.restore(this.candidate(epoch - 1).artifactDigest, { rootPath: this.options.root, directoryName: `writer-${epoch}` });
            if (restored.worktreePath !== path2) throw Error("RESTORE_PATH_MISMATCH");
          }
          this.workspaces.set(epoch, workspace);
          return { status: "completed", stopped: true, evidence: { workspace, baseRevision } };
        } },
        persist: async (evidence2) => ({
          evidenceRef: await this.persist(n.id, this.options.repositoryPath, evidence2),
          actualTokens: 0,
          result: { schemaVersion: 1, kind: "workspace", workspaceLeaseRef, receiptRef: `e${epoch}.workspace` }
        })
      };
    }
    if (name === "implement" || name === "repair") {
      this.result(`e${epoch}.workspace`);
      const workspace = this.workspace();
      const feedback = epoch ? this.options.db.prepare("SELECT bundle_json FROM graph_verification_joins WHERE receipt_ref=? AND graph_run_id=?").get(this.feedbackRef, r.graphRunId) : void 0;
      if (epoch && !feedback) throw Error("IMMUTABLE_FEEDBACK_REQUIRED");
      const action2 = epoch ? {
        kind: "repair",
        inputArtifactRef: this.options.request.inputArtifactRef,
        workspaceLeaseRef,
        candidateRevision: this.candidate(epoch - 1).candidateRevision,
        feedbackRef: this.feedbackRef
      } : { kind: "implement", inputArtifactRef: this.options.request.inputArtifactRef, workspaceLeaseRef };
      const adapter = this.options.writer.adapter;
      const capability = adapter.capabilities().find((c) => c.id === this.options.writer.capabilityId);
      if (!capability) throw Error("WRITER_CAPABILITY_REQUIRED");
      return { ...common, workspace, action: action2, execution: { kind: "adapter", adapter, capabilityId: capability.id, plan: {
        plan_id: `delivery-${r.graphRunId}-${epoch}`,
        agent_id: adapter.id,
        max_iterations: 1,
        task: {
          task_id: `delivery-${epoch}`,
          source: "manual",
          capability: capability.kind,
          priority: 100,
          prompt: `${this.options.task}${feedback ? `
Repair frozen candidate ${action2.kind === "repair" ? action2.candidateRevision : ""}. Complete host quality feedback:
${feedback.bundle_json}` : ""}`
        },
        stop_condition: { type: "tests_pass" }
      } }, persist: async (evidence2) => ({
        evidenceRef: await this.persist(n.id, workspace.workspace_path, evidence2),
        ...evidence2.status === "completed" && evidence2.stopped ? { result: { schemaVersion: 1, kind: "implementation_complete", workspaceLeaseRef, receiptRef: `e${epoch}.implementation` } } : {}
      }) };
    }
    if (name === "freeze") {
      const implementation = this.latest(`e${epoch}.${epoch ? "repair" : "implement"}`);
      if (implementation?.outcome?.state !== "confirmed" || implementation.outcome.result.kind !== "implementation_complete") throw Error("IMPLEMENTATION_REQUIRED");
      const workspace = this.workspace();
      const scope = await resolveRepositoryScope2(workspace.workspace_path);
      const checkProducer = async () => {
        const evidence2 = await loadDeliveryReceipt(
          this.options.root,
          implementation.outcome.evidenceRef,
          this.receiptBinding(implementation.effect.nodeId, workspace.workspace_path)
        );
        if (evidence2.stopped !== true || workerCanonical8(evidence2.candidate?.workspace) !== workerCanonical8(workspace)) throw Error("PRODUCER_STOP_REQUIRED");
        this.check();
      };
      return {
        ...common,
        workspace,
        action: { kind: "freeze", workspaceLeaseRef, receiptRef: implementation.outcome.result.receiptRef },
        execution: {
          kind: "freeze",
          store: this.artifacts,
          input: {
            artifactId: `delivery-${r.graphRunId}-${epoch}`,
            scope: r.scope,
            runId: r.graphRunId,
            generation: r.generation,
            owner: r.leaseOwner,
            workspaceLeaseRef,
            repoId: scope.repoId,
            commonDir: scope.commonDir,
            worktreePath: workspace.workspace_path,
            baseRevision: epoch ? this.candidate(epoch - 1).candidateRevision : this.compiled.spec.input.baseRevision,
            implementationReceiptRef: implementation.outcome.result.receiptRef,
            producerStopEvidenceRef: implementation.outcome.evidenceRef
          },
          authority: { verifyLease: async (_input, lease) => {
            this.check();
            await lease.assertActive();
          }, verifyImplementationReceipt: checkProducer, verifyProducersStopped: checkProducer }
        },
        persist: async (evidence2) => {
          return { evidenceRef: await this.persist(n.id, workspace.workspace_path, evidence2), actualTokens: 0, result: evidence2.frozenCandidate };
        }
      };
    }
    if (name === "prepare_review" || name === "prepare_tests") return this.preparation(name === "prepare_review" ? "review" : "tests", 1);
    const action = this.branches.get(n.id);
    if (!action) throw Error("PREPARATION_REQUIRED");
    return action;
  }
  request(action) {
    const r = this.current();
    return {
      schemaVersion: 1,
      kind: "worker_action",
      requestId: `host:${randomUUID7()}`,
      scope: r.scope,
      graphRunId: r.graphRunId,
      specHash: r.identity.specHash,
      generation: r.generation,
      epoch: this.epoch,
      nodeId: action.nodeId,
      effectSlot: action.effectSlot,
      action: action.action
    };
  }
  async dispatch(connection, value, options) {
    if (this.stopping) throw Error("DELIVERY_STOPPING");
    this.check();
    const request = WorkerActionRequest3.parse(value);
    const r = this.current();
    if (request.epoch !== this.epoch || request.generation !== r.generation || request.graphRunId !== r.graphRunId || request.specHash !== r.identity.specHash || workerCanonical8(request.scope) !== workerCanonical8(r.scope)) throw Error("DELIVERY_IDENTITY_MISMATCH");
    const name = request.nodeId.replace(`e${this.epoch}.`, "");
    const n = deliveryEpoch(this.compiled, this.epoch).node(name);
    if (request.effectSlot !== n.effectSlot) throw Error("DELIVERY_SLOT_MISMATCH");
    if (!this.installed.has(n.id)) this.installed.set(n.id, this.registration(name).then((action) => {
      this.check();
      this.broker.installActions(connection, [action]);
    }));
    await this.installed.get(n.id);
    let response = await this.broker.handle(connection, request, options);
    if (name !== "review" && name !== "tests") return response;
    while (response.kind === "worker_action_response" && response.outcome.state === "failed" && response.outcome.error.retryable) {
      const prior = this.latest(n.id);
      if (prior.effect.logicalAttempt >= n.maxLedgerAttempts) break;
      if (!prior.outcome?.evidenceRef.startsWith("graph-verification:")) break;
      const envelope = await loadGraphVerificationEvidence(join5(this.options.root, "verification"), prior.outcome.evidenceRef, this.binding(), { effect: prior.effect, effectKey: prior.effectKey });
      if (!envelope.verificationFailure?.retrySafe) break;
      const snapshot3 = new GraphVerificationStore2(this.options.db, () => {
      }).snapshot(this.fence());
      const cost = deliveryEpoch(this.compiled, this.epoch).nextCost[name];
      if (snapshot3.budget.accountingBlocked || snapshot3.budget.actionStarts + cost.actions > this.compiled.spec.limits.maxActionStarts || BigInt(snapshot3.budget.chargedTokens) + BigInt(snapshot3.budget.reservedTokens) + BigInt(cost.tokens) > BigInt(this.compiled.spec.limits.tokenReservationLimit)) break;
      const prep = await this.preparation(name, prior.effect.logicalAttempt + 1);
      this.broker.installActions(connection, [prep]);
      const prepared = await this.broker.handle(connection, this.request(prep), options);
      if (prepared.kind !== "worker_action_response" || prepared.outcome.state !== "confirmed") return response;
      response = await this.broker.retryAuthorized(connection, prior.effectKey, () => {
        this.check();
      }, { ...options, replacement: this.branches.get(n.id) });
      if (response.kind === "worker_action_response") response = { ...response, requestId: request.requestId };
    }
    return response;
  }
  async evaluate() {
    const p = deliveryEpoch(this.compiled, this.epoch);
    return new GraphVerificationJoinService(this.options.db, {
      binding: this.binding(),
      artifacts: this.artifacts,
      evidenceRoot: join5(this.options.root, "verification"),
      slots: p.slots,
      nextCost: p.nextCost,
      authorize: () => this.check()
    }).evaluate(this.fence());
  }
  async takeover(handle, stopped) {
    const r = this.current();
    const key = {};
    const inspection = new GraphRecoveryStore3(this.options.db, () => {
      throw Error("INSPECTION_ONLY");
    });
    let inventory;
    const verify = () => {
      const observed = this.runtime.observedExit(handle.connection);
      if (!stopped.actionsSettled || stopped.worker.kind !== "exited" || stopped.worker.journalError || workerCanonical8(observed) !== workerCanonical8(stopped.worker)) throw Error("PHYSICAL_WORKER_STOP_REQUIRED");
      return verifyJournaledGraphWorkerExit(this.options.db, handle.binding);
    };
    this.runtime.reconciler.register(key, {
      binding: { scope: r.scope, graphRunId: r.graphRunId, identity: r.identity, generation: r.generation, owner: r.leaseOwner },
      authorize: () => this.check(),
      stopWorker: async () => stopped,
      verifyWorker: async () => verify(),
      verifyQuiescence: async (snapshot3) => {
        verify();
        const decision = await this.evaluate();
        if (decision.snapshot.pendingAdmissions || decision.snapshot.unresolvedActions) throw Error("QUIESCENCE_REQUIRED");
        inventory = inspection.inspectExecutors(snapshot3.fence);
        if (inventory.requiredEffectKeys.length) throw Error("QUIESCENCE_REQUIRED");
        return { executorEvidenceRef: decision.publication.record.receiptRef, workspaceEvidenceRef: this.candidate().artifactRefs[0] };
      },
      verifyOutcome: async () => {
        throw Error("NO_EFFECT_RECONCILIATION");
      },
      recheck: (_snapshot, proof) => {
        this.check();
        if (workerCanonical8(verify()) !== workerCanonical8(proof.worker) || !inventory) throw Error("QUIESCENCE_REQUIRED");
        inspection.assertExecutorInventory(inventory);
      },
      release: async () => {
      }
    });
    try {
      const takeover = await this.runtime.reconciler.reconcile(key, { kind: "takeover", fence: this.fence(), receiptId: `delivery-takeover-${this.epoch}`, owner: `delivery-${r.generation + 1}`, leaseExpiresAt: this.leaseDeadline() });
      this.owned = takeover.result.run;
    } finally {
      this.runtime.reconciler.unregister(key);
    }
  }
  checkpointDigest() {
    const rows = this.options.db.prepare("SELECT namespace,checkpoint_id,checkpoint FROM graph_checkpoints WHERE graph_run_id=? ORDER BY namespace,checkpoint_id").all(this.current().graphRunId);
    const writes2 = this.options.db.prepare("SELECT namespace,checkpoint_id,task_id,channel,write_index,value FROM graph_checkpoint_writes WHERE graph_run_id=? ORDER BY namespace,checkpoint_id,task_id,write_index").all(this.current().graphRunId);
    if (!rows.length || !writes2.some((row) => row.channel === "__interrupt__")) throw Error("DURABLE_INTERRUPT_REQUIRED");
    return createHash8("sha256").update(workerCanonical8({ rows, writes: writes2 })).digest("hex");
  }
  verifyResume(proof) {
    if (!this.waiting || workerCanonical8(proof) !== workerCanonical8(this.waiting.proof) || this.stopping) throw Error("LIVE_QUIESCENCE_REQUIRED");
    this.waiting.verify();
  }
  resumeQuality(proof) {
    this.verifyResume(proof);
    this.waiting.resolve();
  }
  /** Actual worker and broker signal chain. A drained Promise never clears holds. */
  async cancel() {
    this.stopping = true;
    this.waiting?.reject(Error("DELIVERY_CANCELLED"));
    const handle = this.active;
    if (!handle) return;
    const stopped = await handle.stop("GRAPH_CANCEL_REQUESTED");
    if (!this.owned || stopped.worker.kind !== "exited" || !stopped.actionsSettled) return;
    const r = this.current();
    if (r.status !== "cancel_pending") return;
    const inspection = new GraphRecoveryStore3(this.options.db, () => {
      throw Error("INSPECTION_ONLY");
    });
    let inventory;
    const verify = () => {
      this.assertOwned();
      if (stopped.worker.journalError || workerCanonical8(this.runtime.observedExit(handle.connection)) !== workerCanonical8(stopped.worker)) throw Error("PHYSICAL_WORKER_STOP_REQUIRED");
      return verifyJournaledGraphWorkerExit(this.options.db, handle.binding);
    };
    const key = {};
    this.runtime.reconciler.register(key, {
      binding: { scope: r.scope, graphRunId: r.graphRunId, identity: r.identity, generation: r.generation, owner: r.leaseOwner },
      authorize: () => {
        this.assertOwned();
        const result = (this.options.authorizeCancel ?? this.options.authorize)();
        if (result !== void 0) {
          void Promise.resolve(result).catch(() => {
          });
          throw Error("AUTHORITY_MUST_BE_SYNCHRONOUS");
        }
      },
      stopWorker: async () => stopped,
      verifyWorker: async () => verify(),
      verifyQuiescence: async (snapshot3) => {
        const exit = verify();
        inventory = inspection.inspectExecutors(snapshot3.fence);
        if (inventory.requiredEffectKeys.length) throw Error("QUIESCENCE_REQUIRED");
        return { executorEvidenceRef: `graph-executor-inventory:${inventory.digest}`, workspaceEvidenceRef: exit.evidenceRef };
      },
      verifyOutcome: async () => {
        throw Error("NO_EFFECT_RECONCILIATION");
      },
      recheck: (_snapshot, proof) => {
        if (workerCanonical8(verify()) !== workerCanonical8(proof.worker) || !inventory) throw Error("QUIESCENCE_REQUIRED");
        inspection.assertExecutorInventory(inventory);
      },
      release: async () => {
      }
    });
    try {
      await this.runtime.reconciler.reconcile(key, { kind: "project", status: "cancelled", receiptId: `delivery-cancel-${r.generation}`, fence: this.fence() });
    } finally {
      this.runtime.reconciler.unregister(key);
    }
  }
  async run() {
    if (this.started) throw Error("DELIVERY_ALREADY_STARTED");
    this.started = true;
    this.check();
    await mkdir4(this.options.root, { recursive: true, mode: 448 });
    this.check();
    if (this.options.root === this.options.repositoryPath || this.options.root.startsWith(`${this.options.repositoryPath}/`) || await realpath4(this.options.root) !== this.options.root || await realpath4(this.options.repositoryPath) !== this.options.repositoryPath) throw Error("CANONICAL_HOST_PATHS_REQUIRED");
    this.check();
    const modulePath = join5(this.options.root, "delivery.mjs");
    await writeFile(modulePath, this.compiled.source, { flag: "wx", mode: 384 });
    this.check();
    const version = graphDeliveryVersion(this.compiled);
    this.runtime = new GraphRuntime({
      db: this.options.db,
      broker: this.broker,
      checkpoints: new GraphCheckpointService({ runs: this.runs, checkpoints: new GraphCheckpointStore(this.options.db), bindings: /* @__PURE__ */ new Map() }),
      programs: [{ id: "code-delivery-v1", modulePath, digest: this.compiled.compiledProgramDigest }]
    });
    let resume;
    let lastStopped;
    let durableWorkerStopped = false;
    try {
      this.runValue = this.options.reservedRun ?? this.runtime.prepare(this.options.request, version);
      if (this.stopping || this.current().status === "cancel_pending") return { route: { kind: "stop", epoch: 0, reason: "cancel_requested" } };
      this.runValue = this.runtime.claim(this.runValue, "delivery-1", this.leaseDeadline());
      this.owned = this.runValue;
      this.runs.project({ ...this.fence(), status: "running" });
      new GraphDeliveryEpochStore(this.options.db).activate(this.fence(), 0, deliveryEpoch(this.compiled, 0).cost);
      for (; ; ) {
        durableWorkerStopped = false;
        await this.restoreWorkspaceMappings();
        const r = this.current();
        this.installed.clear();
        const handle = this.runtime.start({
          request: this.options.request,
          run: r,
          programId: "code-delivery-v1",
          leaseDurationMs: 6e4,
          ...resume ? { resume } : {},
          authorize: () => this.check(),
          registration: {
            scope: r.scope,
            graphRunId: r.graphRunId,
            identity: r.identity,
            generation: r.generation,
            owner: r.leaseOwner,
            epoch: this.epoch,
            workspace: { workspace_id: r.scope.workspaceId, workspace_path: this.options.repositoryPath },
            authorize: () => this.check(),
            actions: []
          },
          dispatch: (key, request, options) => this.dispatch(key, request, options)
        });
        this.active = handle;
        this.connection = handle.connection;
        let workerError;
        try {
          await handle.result;
        } catch (error) {
          workerError = error;
        }
        const stopped = await handle.stop();
        lastStopped = stopped;
        if (this.stopping || this.current().status === "cancel_pending") return { route: { kind: "reconcile", epoch: this.epoch, reason: "cancel_requested" } };
        if (!stopped.actionsSettled || stopped.worker.kind !== "exited" || stopped.worker.journalError) throw Error("PHYSICAL_WORKER_STOP_REQUIRED");
        const verifyDurableExit = () => {
          durableWorkerStopped = false;
          const proof = verifyJournaledGraphWorkerExit(this.options.db, handle.binding);
          durableWorkerStopped = true;
          return proof;
        };
        const workerProof = verifyDurableExit();
        const current = this.current();
        this.runs.renewLease({ ...this.fence(), leaseExpiresAt: Math.max(current.leaseExpiresAt, this.leaseDeadline()) });
        if (!this.latest(`e${this.epoch}.freeze`)) throw workerError ?? Error("FREEZE_REQUIRED");
        const decision = await this.evaluate();
        const candidate = this.candidate();
        if (decision.route.kind !== "repair_required") {
          const route = decision.route.kind === "retry_required" ? { kind: "stop", epoch: this.epoch, reason: "retry_dispatch_incomplete" } : decision.route;
          this.check();
          const inspection = new GraphRecoveryStore3(this.options.db, () => {
            throw Error("INSPECTION_ONLY");
          });
          const inventory = inspection.inspectExecutors(this.fence(decision.snapshot.run));
          if (route.kind !== "reconcile" && inventory.requiredEffectKeys.length) throw Error("QUIESCENCE_REQUIRED");
          if (this.current().status !== "cancel_pending") this.options.db.transaction(() => {
            if (workerCanonical8(verifyDurableExit()) !== workerCanonical8(workerProof)) throw Error("PHYSICAL_WORKER_STOP_REQUIRED");
            inspection.assertExecutorInventory(inventory);
            this.runs.project({ ...this.fence(decision.snapshot.run), status: route.kind === "ready" ? "ready" : route.kind === "reconcile" ? "reconciliation_required" : "failed" });
            if (decision.publication) this.options.publish?.(candidate, decision.publication.record.receiptRef);
          }).immediate();
          return { route, candidate, ...decision.publication ? { feedbackRef: decision.publication.record.receiptRef } : {} };
        }
        if (workerError || !decision.publication) throw workerError ?? Error("IMMUTABLE_JOIN_REQUIRED");
        this.check();
        this.feedbackRef = decision.publication.record.receiptRef;
        this.options.publish?.(candidate, this.feedbackRef);
        if (this.options.qualityInterrupt) {
          const proof = {
            interruptId: `quality:${r.graphRunId}:${this.epoch}:${r.generation}`,
            inputDigest: r.identity.inputDigest,
            kind: "quality",
            checkpointDigest: this.checkpointDigest(),
            feedbackRef: this.feedbackRef
          };
          await new Promise((resolve2, reject) => {
            this.waiting = { proof, resolve: resolve2, reject, verify: () => {
              this.check();
              if (workerCanonical8(verifyDurableExit()) !== workerCanonical8(workerProof)) throw Error("PHYSICAL_WORKER_STOP_REQUIRED");
              if (this.checkpointDigest() !== proof.checkpointDigest || workerCanonical8(this.runtime.observedExit(handle.connection)) !== workerCanonical8(stopped.worker) || stopped.worker.kind !== "exited" || !stopped.actionsSettled) throw Error("PHYSICAL_WORKER_STOP_REQUIRED");
              if (!this.options.db.prepare("SELECT 1 FROM graph_verification_joins WHERE graph_run_id=? AND receipt_ref=?").get(r.graphRunId, proof.feedbackRef)) throw Error("IMMUTABLE_JOIN_REQUIRED");
            } };
            this.options.qualityInterrupt(proof);
          });
          this.waiting = void 0;
        }
        await this.takeover(handle, stopped);
        const next = this.epoch + 1;
        new GraphDeliveryEpochStore(this.options.db).activate(this.fence(), next, deliveryEpoch(this.compiled, next).cost, this.feedbackRef);
        resume = { kind: "interrupt", value: { ...decision.route, feedbackRef: this.feedbackRef } };
        this.epoch = next;
      }
    } catch (error) {
      if (!this.owned) throw error;
      const current = this.current();
      let inventoryUnknown = true;
      try {
        inventoryUnknown = new GraphRecoveryStore3(this.options.db, () => {
          throw Error("INSPECTION_ONLY");
        }).inspectExecutors(this.fence(current)).requiredEffectKeys.length > 0;
      } catch {
      }
      const reconcile = inventoryUnknown || !durableWorkerStopped || !lastStopped?.actionsSettled || lastStopped.worker.kind !== "exited";
      try {
        this.check();
        if (!["ready", "failed", "cancelled", "cancel_pending"].includes(current.status) && current.leaseExpiresAt > Date.now()) {
          this.runs.project({ ...this.fence(current), status: reconcile ? "reconciliation_required" : "failed" });
        }
      } catch {
      }
      return { route: { kind: reconcile ? "reconcile" : "stop", epoch: this.epoch, reason: String(error).slice(0, 4096) } };
    } finally {
      this.closed = true;
      await this.runtime.close();
      if (this.connection) this.broker.unregister(this.connection);
    }
  }
};

// packages/cli/src/graph-bounded-recovery.ts
import { join as join6 } from "node:path";
import { GraphRunStore as GraphRunStore6, resolveRepositoryScope as resolveRepositoryScope3 } from "@osstack/core";
import { GraphRecoveryStore as GraphRecoveryStore4 } from "@osstack/core/graph-recovery";
import { inspectRepoWriteLock as inspectRepoWriteLock2, releaseReconciledRepoWriteLock } from "@osstack/autonomy";
import { workerCanonical as workerCanonical9 } from "@osstack/protocol";
import { compileGraphSpec as compileGraphSpec2 } from "@osstack/graph/spec-compiler";
var same = (a, b) => workerCanonical9(a) === workerCanonical9(b);
function dead(pid2) {
  try {
    process.kill(pid2, 0);
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw Error("BOUNDED_RECOVERY_HOST_UNPROVEN");
  }
  throw Error("BOUNDED_RECOVERY_HOST_ALIVE");
}
async function cancelJournaledBoundedWriter(db, root, sourcePath, value, authorize) {
  const input = structuredClone(value);
  const store = new GraphRecoveryStore4(db, () => {
    throw Error("INSPECTION_ONLY");
  });
  const check = () => {
    const value2 = authorize();
    if (value2 !== void 0) {
      void Promise.resolve(value2).catch(() => {
      });
      throw Error("BOUNDED_RECOVERY_AUTHORITY");
    }
  };
  check();
  const initial = store.inspectExecutors(input.fence);
  if (initial.snapshot.run.status !== "cancel_pending" || initial.workers.length !== 1 || initial.entries.length !== 2) throw Error("BOUNDED_RECOVERY_SCOPE");
  const run = initial.snapshot.run;
  if (!run.spec) throw Error("BOUNDED_RECOVERY_PROGRAM");
  const compiled = compileGraphSpec2(run.spec);
  const supported = {
    executionModel: "langgraph-functional-v1",
    durability: "sync",
    engineVersion: "1.4.15",
    checkpointVersion: "1.1.5",
    templateVersion: "4",
    registryVersion: compiled.registryVersion,
    compilerVersion: compiled.compilerVersion,
    schemaVersion: compiled.schemaVersion,
    compiledProgramDigest: compiled.compiledProgramDigest
  };
  if (Object.entries(supported).some(([key, value2]) => run.identity[key] !== value2)) throw Error("BOUNDED_RECOVERY_PROGRAM");
  const writer = initial.entries.find((e) => e.action.effect.nodeId === "e0.implement");
  const workspace = initial.entries.find((e) => e.action.effect.nodeId === "e0.workspace");
  if (!writer || !workspace || writer.action.generation !== 1 || workspace.action.generation !== 1 || writer.action.effect.epoch !== 0 || workspace.action.effect.epoch !== 0 || writer.action.effect.logicalAttempt !== 1 || workspace.action.effect.logicalAttempt !== 1 || writer.action.action.kind !== "implement" || writer.action.action.workspaceLeaseRef !== "e0.writer" || workspace.action.action.kind !== "workspace_create" || !writer.admission || workspace.admission?.releasedAt == null || workspace.action.outcome?.state !== "confirmed" || workspace.action.outcome.result.kind !== "workspace" || workspace.action.outcome.result.workspaceLeaseRef !== "e0.writer") throw Error("BOUNDED_RECOVERY_SCOPE");
  const journal = loadBoundedRecoveryJournal(root, writer.action.effectKey);
  if (journal.actionDigest !== boundedActionDigest(writer.action) || journal.owner !== writer.owner || journal.executionRef !== writer.action.executionRef || journal.workspacePath !== join6(root, "writer-0") || journal.commonDir !== join6(journal.workspacePath, ".git") || journal.lockOwner.repo_id !== journal.repoId || journal.lockOwner.autonomy_run_id !== `graph-action:${writer.action.effectKey}`) throw Error("BOUNDED_RECOVERY_BINDING");
  dead(journal.lockOwner.pid);
  const scope = await resolveRepositoryScope3(journal.workspacePath);
  check();
  if (scope.commonDir !== journal.commonDir || scope.repoId !== journal.repoId) throw Error("BOUNDED_RECOVERY_WORKSPACE");
  const receiptBinding = (entry, workspacePath) => ({
    effect: entry.action.effect,
    effectKey: entry.action.effectKey,
    generation: entry.action.generation,
    owner: entry.owner,
    workspacePath
  });
  const predecessor = await loadDeliveryReceipt(root, workspace.action.outcome.evidenceRef, receiptBinding(workspace, sourcePath));
  check();
  const evidence2 = await loadDeliveryReceipt(root, journal.evidenceRef, receiptBinding(writer, journal.workspacePath));
  check();
  const expectedWorkspace = { workspace_id: input.fence.scope.workspaceId, workspace_path: journal.workspacePath };
  const created = predecessor.workspace;
  if (predecessor.stopped !== true || predecessor.status !== "completed" || !same(created?.workspace, expectedWorkspace) || created?.baseRevision !== initial.snapshot.run.spec?.input.baseRevision || evidence2.stopped !== true || evidence2.status !== "completed" || evidence2.candidate?.status !== "implementation_complete" || !same(evidence2.candidate.workspace, expectedWorkspace) || !/^(anthropic|deepseek)-bounded-v1:/.test(evidence2.stopEvidenceRef ?? "")) throw Error("BOUNDED_RECOVERY_STOP_REQUIRED");
  const execution = evidence2.candidate.execution;
  const tokens = [execution?.tokens_in, execution?.tokens_out];
  if (tokens.some((n) => typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)) throw Error("BOUNDED_RECOVERY_USAGE");
  const actualTokens = tokens[0] + tokens[1];
  if (!Number.isSafeInteger(actualTokens)) throw Error("BOUNDED_RECOVERY_USAGE");
  const verdict = {
    outcome: "applied",
    evidenceRef: journal.evidenceRef,
    actualTokens,
    result: { schemaVersion: 1, kind: "implementation_complete", workspaceLeaseRef: "e0.writer", receiptRef: "e0.implementation" }
  };
  const workerBinding = {
    scope: input.fence.scope,
    graphRunId: input.fence.graphRunId,
    identity: input.fence.identity,
    generation: input.fence.expectedGeneration,
    owner: input.fence.expectedOwner
  };
  const recheck = () => {
    check();
    dead(journal.lockOwner.pid);
    if (!same(loadBoundedRecoveryJournal(root, writer.action.effectKey), journal) || boundedWorkspaceFingerprint(journal.workspacePath) !== journal.fingerprint) throw Error("BOUNDED_RECOVERY_CHANGED");
    assertBoundedDeliveryReceipt(root, journal.evidenceRef);
    assertBoundedDeliveryReceipt(root, workspace.action.outcome.evidenceRef);
    return verifyJournaledGraphWorkerExit(db, workerBinding);
  };
  recheck();
  const reconciler = new GraphReconciler(db);
  const connection = {};
  let inventory;
  reconciler.register(connection, {
    binding: workerBinding,
    authorize: check,
    stopWorker: async () => void 0,
    verifyWorker: async () => recheck(),
    verifyQuiescence: async (snapshot3) => {
      recheck();
      inventory = store.inspectExecutors(snapshot3.fence, snapshot3.action?.effectKey);
      if (inventory.entries.length !== 2 || inventory.workers.length !== 1 || !same(inventory.entries.find((e) => e.action.effectKey === workspace.action.effectKey), workspace) || boundedActionDigest(inventory.entries.find((e) => e.action.effectKey === writer.action.effectKey).action) !== journal.actionDigest) throw Error("BOUNDED_RECOVERY_CHANGED");
      return { executorEvidenceRef: journal.evidenceRef, workspaceEvidenceRef: `bounded-workspace:${journal.fingerprint}` };
    },
    verifyOutcome: async () => verdict,
    recheck: (_snapshot, proof, decision) => {
      if (!same(recheck(), proof.worker) || !inventory) throw Error("BOUNDED_RECOVERY_CHANGED");
      store.assertExecutorInventory(inventory);
      if (decision.kind === "effect" ? !same(decision.verdict, verdict) : decision.kind !== "project" || decision.status !== "cancelled") throw Error("BOUNDED_RECOVERY_DECISION");
    },
    release: async (_result, reverify) => {
      await reverify();
      const lockRoot = join6(journal.commonDir, "osstack", "writer-locks");
      const current = await inspectRepoWriteLock2(lockRoot, journal.repoId);
      if (current) await releaseReconciledRepoWriteLock({
        root_dir: lockRoot,
        repo_id: journal.repoId,
        expectedOwner: journal.lockOwner,
        verifyQuiescent: async () => {
          await reverify();
        }
      });
      await reverify();
    }
  });
  try {
    const result = await reconciler.reconcile(connection, {
      kind: "effect",
      fence: input.fence,
      effectKey: writer.action.effectKey,
      receiptId: `bounded-effect:${writer.action.effectKey}`
    });
    if (result.exit === "release_pending") return result;
    const run2 = new GraphRunStore6(db).get(input.fence.scope, input.fence.graphRunId);
    return await reconciler.reconcile(connection, {
      kind: "project",
      status: "cancelled",
      receiptId: input.receiptId,
      fence: { ...input.fence, expectedRevision: run2.revision, now: Date.now() }
    });
  } finally {
    reconciler.unregister(connection);
  }
}

// packages/cli/src/graph-rpc.ts
var fence2 = (r) => ({
  scope: r.scope,
  graphRunId: r.graphRunId,
  identity: r.identity,
  expectedGeneration: r.generation,
  expectedOwner: r.leaseOwner,
  expectedRevision: r.revision,
  now: Date.now()
});
var same2 = (a, b) => workerCanonical10(a) === workerCanonical10(b);
function synchronous2(value) {
  if (value !== void 0) {
    void Promise.resolve(value).catch(() => {
    });
    throw new GraphContractError3("POLICY_DENIED");
  }
}
function graphRpcError(error) {
  const raw = error instanceof Error ? error.message : "";
  const supplied = error && typeof error === "object" && "code" in error ? String(error.code) : raw;
  const aliases = {
    ENOENT: "UNAUTHENTICATED",
    EACCES: "UNAUTHENTICATED",
    ELOOP: "UNAUTHENTICATED",
    RUN_NOT_FOUND: "RUN_MISMATCH",
    OWNER_MISMATCH: "STALE_GENERATION",
    LEASE_EXPIRED: "GRANT_EXPIRED",
    LIVE_QUIESCENCE_REQUIRED: "ACTION_OUTCOME_UNKNOWN",
    PHYSICAL_WORKER_STOP_REQUIRED: "ACTION_OUTCOME_UNKNOWN",
    PROGRAM_IDENTITY_MISMATCH: "CHECKPOINT_INCOMPATIBLE",
    TERMINAL_RUN: "REVISION_CONFLICT",
    CANCEL_PENDING: "CANCEL_UNCONFIRMED"
  };
  const parsed = GraphErrorCode.safeParse(aliases[supplied] ?? supplied);
  const code = error instanceof z4.ZodError ? "INPUT_CONTRACT_INVALID" : parsed.success ? parsed.data : "INTERNAL_ERROR";
  return { code, message: code };
}
var GraphRpcService = class {
  runs;
  registrations = /* @__PURE__ */ new Map();
  live = /* @__PURE__ */ new Map();
  pendingRequests = /* @__PURE__ */ new Set();
  owner = randomUUID8();
  closed = false;
  closing;
  options;
  constructor(options) {
    assertGraphPlatform();
    this.options = Object.freeze({ ...options, resolveCaller: options.resolveCaller, acquire: options.acquire });
    const snapshotAdapter = (a) => {
      const capabilities = structuredClone(a.capabilities());
      return Object.freeze({
        id: a.id,
        display_name: a.display_name,
        cost_tier: a.cost_tier,
        capabilities: () => structuredClone(capabilities),
        isAvailable: a.isAvailable.bind(a),
        invoke: a.invoke.bind(a),
        ...a.confirmStopped ? { confirmStopped: a.confirmStopped.bind(a) } : {}
      });
    };
    this.runs = new GraphRunStore7(options.db);
    for (const value of options.registrations) {
      if (this.registrations.has(value.id)) throw Error("DUPLICATE_GRAPH_REGISTRATION");
      this.registrations.set(value.id, { ...value, scope: GraphScope2.parse(value.scope), delivery: {
        ...value.delivery,
        writer: { ...value.delivery.writer, adapter: snapshotAdapter(value.delivery.writer.adapter) },
        reviewer: { ...value.delivery.reviewer, adapter: snapshotAdapter(value.delivery.reviewer.adapter) },
        acceptanceRegistry: structuredClone(value.delivery.acceptanceRegistry)
      } });
    }
  }
  caller(connection) {
    if (this.closed) throw Error("GRAPH_SERVICE_CLOSED");
    const id = this.options.resolveCaller(connection);
    const registration = id === null ? void 0 : this.registrations.get(id);
    if (!registration) throw new GraphContractError3("UNAUTHENTICATED");
    return registration;
  }
  row(id) {
    const row = this.options.db.prepare("SELECT * FROM graph_public_delivery WHERE graph_run_id=?").get(id);
    if (!row) throw new GraphContractError3("RUN_MISMATCH");
    return row;
  }
  bound(registration, scope, id) {
    if (!same2(scope, registration.scope)) throw new GraphContractError3("SCOPE_MISMATCH");
    const run = this.runs.get(scope, id);
    if (!run || run.source.product !== registration.product) throw new GraphContractError3("RUN_MISMATCH");
    if (JSON.parse(this.row(id).descriptor_json).registrationId !== registration.id) throw new GraphContractError3("RUN_MISMATCH");
    return run;
  }
  status(run, registration) {
    const row = this.row(run.graphRunId);
    const result = row.result_json ? JSON.parse(row.result_json) : { evidenceRefs: [] };
    const interrupt = row.interrupt_json ? JSON.parse(row.interrupt_json) : void 0;
    const { actions, budget } = readGraphActionState(this.options.db, run.graphRunId);
    const uncertain = ["cancel_pending", "reconciliation_required"].includes(run.status);
    let needsAuthorization = false;
    try {
      synchronous2(registration.authorize("execute"));
    } catch {
      needsAuthorization = true;
    }
    return GraphDelegationStatus.parse({
      schemaVersion: 1,
      scope: run.scope,
      graphRunId: run.graphRunId,
      source: run.source,
      status: run.status,
      revision: run.revision,
      generation: run.generation,
      inputDigest: run.identity.inputDigest,
      specHash: run.identity.specHash,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      publication: "artifact_only",
      phase: actions.find((a) => a.state === "running")?.effect.nodeId ?? run.status,
      budget: { limits: run.spec.limits, ...budget },
      delivery: uncertain ? "delivery_unknown" : run.status === "ready" ? "available" : "pending",
      ...result,
      ...needsAuthorization ? { authorization: { kind: "needs_authorization", scope: run.scope, requestRef: `graph-grant:${run.graphRunId}` } } : {},
      ...interrupt && run.status === "waiting_input" ? { interrupt: { interruptId: interrupt.interruptId, inputDigest: interrupt.inputDigest, kind: interrupt.kind } } : {},
      ...run.status === "failed" ? { error: { schemaVersion: 1, code: "INTERNAL_ERROR", message: "Graph delivery stopped before verified publication", retryable: false, nextAction: "stop" } } : {},
      ...uncertain ? { error: {
        schemaVersion: 1,
        code: run.status === "cancel_pending" ? "CANCEL_UNCONFIRMED" : "ACTION_OUTCOME_UNKNOWN",
        message: "Physical execution requires reconciliation",
        retryable: false,
        nextAction: "reconcile"
      } } : {}
    });
  }
  replay(request) {
    const row = this.options.db.prepare("SELECT graph_run_id,input_digest FROM graph_requests WHERE scope_json=? AND idempotency_key=?").get(workerCanonical10(request.scope), request.idempotencyKey);
    if (!row) return false;
    if (row.graph_run_id !== request.graphRunId || row.input_digest !== computeGraphInputDigest2(request)) throw new GraphContractError3("IDEMPOTENCY_CONFLICT");
    return true;
  }
  async handle(connection, method, params) {
    const pending = this.handleRequest(connection, method, params);
    this.pendingRequests.add(pending);
    try {
      return await pending;
    } catch (error) {
      throw new GraphContractError3(GraphErrorCode.parse(graphRpcError(error).code));
    } finally {
      this.pendingRequests.delete(pending);
    }
  }
  async handleRequest(connection, method, params) {
    const registration = this.caller(connection);
    if (method === "graph.status" || method === "graph.result") {
      synchronous2(registration.authorize("read"));
      const request2 = GraphStatusRequest.parse(params);
      return this.status(this.bound(registration, request2.scope, request2.graphRunId), registration);
    }
    if (method === "graph.validate") return compileGraphSpec3(GraphSpec.parse(params));
    const request = GraphRequest.parse(params);
    if (!same2(request.scope, registration.scope)) throw new GraphContractError3("SCOPE_MISMATCH");
    if ((method === "graph.start" || method === "graph.submit") && request.kind === "start") return this.submit(registration, request);
    const reconcile = method === "graph.reconcile";
    if ((!["graph.cancel", "graph.reconcile"].includes(method) || request.kind !== "cancel") && (method !== "graph.resume" || request.kind !== "resume")) throw new GraphContractError3("INPUT_CONTRACT_INVALID");
    synchronous2(registration.authorize(request.kind === "cancel" ? "cancel" : "resume"));
    const run = this.bound(registration, request.scope, request.graphRunId);
    const replay = this.replay(request);
    if (replay && !(reconcile && run.status === "cancel_pending" && run.revision === request.expectedRevision + 1)) return this.status(run, registration);
    if (!replay && run.revision !== request.expectedRevision) throw new GraphContractError3("REVISION_CONFLICT");
    if (request.kind === "cancel") {
      const pending = replay ? run : this.runs.projectRequest(request, { ...fence2(run), status: "cancel_pending" });
      const entry = this.live.get(run.graphRunId);
      if (entry?.driver) void entry.driver.cancel().catch(() => {
      });
      else if (run.generation === 0) this.runs.project({ ...fence2(pending), status: "cancelled" });
      if (reconcile && run.generation > 0) {
        const receiptId = `public-cancel:${createHash9("sha256").update(workerCanonical10({
          scope: request.scope,
          idempotencyKey: request.idempotencyKey,
          digest: computeGraphInputDigest2(request)
        })).digest("hex")}`;
        let authorizationFailed = false;
        try {
          await cancelUnstartedGraphWorker(
            this.options.db,
            new GraphReconciler(this.options.db),
            { fence: fence2(pending), receiptId },
            () => {
              try {
                synchronous2(registration.authorize("cancel"));
              } catch (error) {
                authorizationFailed = true;
                throw error;
              }
            }
          );
        } catch (error) {
          if (authorizationFailed) throw error;
          synchronous2(registration.authorize("cancel"));
          try {
            const descriptor = JSON.parse(this.row(run.graphRunId).descriptor_json);
            await cancelJournaledBoundedWriter(
              this.options.db,
              descriptor.root,
              registration.delivery.repositoryPath,
              { fence: fence2(pending), receiptId },
              () => {
                try {
                  synchronous2(registration.authorize("cancel"));
                } catch (failure) {
                  authorizationFailed = true;
                  throw failure;
                }
              }
            );
          } catch (failure) {
            if (authorizationFailed) throw failure;
          }
        }
      }
      return this.status(this.runs.get(run.scope, run.graphRunId), registration);
    }
    const row = this.row(run.graphRunId);
    const proof = row.interrupt_json ? JSON.parse(row.interrupt_json) : void 0;
    if (run.status !== "waiting_input" || !proof || proof.interruptId !== request.interruptId) throw new GraphContractError3("REVISION_CONFLICT");
    if (request.input.kind !== "data" || !same2(request.input.value, { inputDigest: run.identity.inputDigest }) || proof.inputDigest !== run.identity.inputDigest) throw new GraphContractError3("INPUT_CONTRACT_INVALID");
    const driver = this.live.get(run.graphRunId)?.driver;
    if (!driver) throw new GraphContractError3("ACTION_OUTCOME_UNKNOWN");
    if (run.leaseExpiresAt === null || run.leaseExpiresAt <= Date.now() || Date.now() >= run.createdAt + run.spec.limits.deadlineSeconds * 1e3) throw new GraphContractError3("GRANT_EXPIRED");
    driver.verifyResume(proof);
    this.runs.projectRequest(request, { ...fence2(run), status: "running" });
    driver.resumeQuality(proof);
    return this.status(this.runs.get(run.scope, run.graphRunId), registration);
  }
  submit(registration, request) {
    if (request.source.product !== registration.product) throw new GraphContractError3("UNAUTHENTICATED");
    const input = request.spec.input;
    if (input.repositoryRef !== registration.repositoryRef || input.taskRef !== registration.taskRef || request.inputArtifactRef !== registration.inputArtifactRef || !registration.delivery.acceptanceRegistry.some((a) => a.ref === input.acceptanceRef)) throw new GraphContractError3("POLICY_DENIED");
    const compiled = compileGraphSpec3(request.spec);
    let created = false;
    const run = this.options.db.transaction(() => {
      synchronous2(registration.authorize());
      const prior = this.options.db.prepare("SELECT graph_run_id FROM graph_requests WHERE scope_json=? AND idempotency_key=?").get(workerCanonical10(request.scope), request.idempotencyKey);
      if (!prior) {
        if (registration.admitNewRuns) {
          const admitted = registration.admitNewRuns();
          if (admitted !== true) {
            void Promise.resolve(admitted).catch(() => {
            });
            throw new GraphContractError3("GRAPH_ADMISSION_DISABLED");
          }
        }
        assertGraphDeliverySupported(registration.delivery);
      }
      const run2 = this.runs.create(request, graphDeliveryVersion(compiled), Date.now());
      if (prior && !this.options.db.prepare("SELECT 1 FROM graph_public_delivery WHERE graph_run_id=?").get(run2.graphRunId)) throw new GraphContractError3("CHECKPOINT_INCOMPATIBLE");
      const descriptor = { registrationId: registration.id, request, root: join7(this.options.root, run2.graphRunId), launchOwner: this.owner };
      created = this.options.db.prepare("INSERT OR IGNORE INTO graph_public_delivery(graph_run_id,descriptor_json) VALUES (?,?)").run(run2.graphRunId, JSON.stringify(descriptor)).changes === 1;
      return this.bound(registration, run2.scope, run2.graphRunId);
    }).immediate();
    if (created) {
      const entry = { done: Promise.resolve() };
      this.live.set(run.graphRunId, entry);
      entry.done = new Promise((resolve2) => setImmediate(resolve2)).then(async () => {
        if (this.closed || this.runs.get(run.scope, run.graphRunId).status === "cancelled") return;
        try {
          const descriptor = JSON.parse(this.row(run.graphRunId).descriptor_json);
          if (descriptor.launchOwner !== this.owner) throw Error("LAUNCH_OWNER_MISMATCH");
          entry.driver = new GraphDelivery({
            ...registration.delivery,
            db: this.options.db,
            root: descriptor.root,
            request: descriptor.request,
            reservedRun: run,
            acquire: this.options.acquire,
            ...this.options.authorizePolicy ? { authorizePolicy: this.options.authorizePolicy } : {},
            authorize: () => {
              synchronous2(registration.authorize());
            },
            authorizeCancel: () => {
              synchronous2(registration.authorize("cancel"));
            },
            publish: (candidate, feedbackRef) => {
              const { candidateRevision, artifactRefs, artifactDigest } = candidate;
              const output = { candidate: { candidateRevision, artifactRefs, artifactDigest }, evidenceRefs: [feedbackRef], resultRef: feedbackRef };
              this.options.db.prepare("UPDATE graph_public_delivery SET result_json=? WHERE graph_run_id=?").run(JSON.stringify(output), run.graphRunId);
            },
            qualityInterrupt: (proof) => {
              const current = this.runs.get(run.scope, run.graphRunId);
              this.options.db.transaction(() => {
                synchronous2(registration.authorize());
                this.options.db.prepare("UPDATE graph_public_delivery SET interrupt_json=? WHERE graph_run_id=?").run(JSON.stringify(proof), run.graphRunId);
                this.runs.project({ ...fence2(current), status: "waiting_input" });
              }).immediate();
            }
          });
          await entry.driver.run();
          const stopped = this.runs.get(run.scope, run.graphRunId);
          if (stopped.generation === 0 && stopped.status === "cancel_pending") this.runs.project({ ...fence2(stopped), status: "cancelled" });
        } catch {
          const current = this.runs.get(run.scope, run.graphRunId);
          if (current.generation === 0 && current.status === "queued") this.runs.project({ ...fence2(current), status: "failed" });
        }
      });
    }
    return this.status(run, registration);
  }
  close() {
    this.closed = true;
    this.closing ??= this.drain();
    return this.closing;
  }
  async drain() {
    const draining = [...this.live.entries()].map(async ([id, entry]) => {
      try {
        const descriptor = JSON.parse(this.row(id).descriptor_json);
        const run = this.runs.get(descriptor.request.scope, id);
        if (!["ready", "failed", "cancelled", "cancel_pending"].includes(run.status)) this.runs.project({ ...fence2(run), status: "cancel_pending" });
        if (run.generation === 0) {
          const current = this.runs.get(run.scope, id);
          if (current.status === "cancel_pending") this.runs.project({ ...fence2(current), status: "cancelled" });
        }
        await entry.driver?.cancel();
      } finally {
        try {
          await entry.done;
        } finally {
          await entry.driver?.drainDatabaseUsers();
        }
      }
    });
    await Promise.allSettled([...draining, ...this.pendingRequests]);
  }
};
var ref2 = z4.string().min(1).max(256);
var hostConfig = z4.object({ schemaVersion: z4.literal(1), admissionEnabled: z4.boolean().optional(), registration: z4.object({
  id: ref2,
  scope: GraphScope2,
  repositoryRef: ref2,
  repositoryPath: z4.string().min(1),
  taskRef: ref2,
  task: z4.string().min(1).max(65536),
  inputArtifactRef: ref2,
  writer: z4.object({ agentId: ref2, capabilityId: ref2 }).strict(),
  reviewer: z4.object({ agentId: ref2, capabilityId: ref2 }).strict(),
  boundedMessages: z4.object({
    provider: z4.enum(["anthropic", "deepseek"]).optional(),
    baseUrl: z4.string().min(1).max(2048).optional(),
    model: ref2,
    files: z4.array(ref2).min(1).max(16),
    acceptance: z4.string().min(1).max(16e3)
  }).strict().optional(),
  acceptanceRegistry: z4.array(z4.object({ ref: ref2, command: z4.string().min(1), passExitCodes: z4.array(z4.number().int()), failExitCodes: z4.array(z4.number().int()) }).strict()).min(1),
  grant: z4.object({ scope: GraphScope2, expiresAt: z4.number().int().positive(), operations: z4.array(z4.enum(["read", "execute", "cancel", "resume"])).min(1) }).strict()
}).strict() }).strict();

// packages/cli/src/governed-execution.ts
import { join as join8 } from "node:path";
import { acquireRepoWriteLock, FifoSemaphore, SemaphoreAcquireAbortedError } from "@osstack/autonomy";
import { resolveRepositoryScope as resolveRepositoryScope4 } from "@osstack/core";
var GovernedExecution = class {
  constructor(options) {
    this.options = options;
  }
  options;
  activeRuns = /* @__PURE__ */ new Set();
  quarantinedRepositories = /* @__PURE__ */ new Map();
  quarantine(repoId, runId) {
    const owners = this.quarantinedRepositories.get(repoId) ?? /* @__PURE__ */ new Set();
    owners.add(runId);
    this.quarantinedRepositories.set(repoId, owners);
  }
  get hasWriters() {
    return this.options.writes.in_use > 0;
  }
  async acquire(input) {
    const check = async () => {
      if (input.signal?.aborted) throw new SemaphoreAcquireAbortedError();
      if (input.kind === "write") await this.options.checkHealth();
      await input.authorize?.();
    };
    await check();
    const scope = input.workspacePath === void 0 ? void 0 : await resolveRepositoryScope4(input.workspacePath, input.repoId === void 0 ? {} : { repoId: input.repoId });
    if (input.kind === "write" && !scope) throw new Error("trusted repository scope required for writes");
    if (input.kind === "write" && scope && this.quarantinedRepositories.has(scope.repoId)) throw new Error("repository external stop unconfirmed; reconciliation required");
    if (this.activeRuns.has(input.runId)) throw new Error("run already admitted or queued");
    this.activeRuns.add(input.runId);
    let local;
    let global;
    let lock;
    let queue;
    const releasePermits = () => {
      global?.release();
      local?.release();
      this.activeRuns.delete(input.runId);
      if (scope && queue?.in_use === 0 && queue.pending === 0) this.options.repositories.delete(scope.repoId);
    };
    try {
      if (input.kind === "write" && scope) {
        queue = this.options.repositories.get(scope.repoId) ?? new FifoSemaphore(1);
        this.options.repositories.set(scope.repoId, queue);
        local = await queue.acquire(input.signal);
      }
      global = await (input.kind === "read" ? this.options.reads : this.options.writes).acquire(input.signal);
      if (input.kind === "write" && scope) {
        lock = await acquireRepoWriteLock({ root_dir: join8(scope.commonDir, "osstack", "writer-locks"), recover_stale: false, repo_id: scope.repoId, autonomy_run_id: input.runId });
      }
      if (input.kind === "write" && scope && this.quarantinedRepositories.has(scope.repoId)) throw new Error("repository external stop unconfirmed; reconciliation required");
      await check();
    } catch (error) {
      try {
        await lock?.release();
      } finally {
        releasePermits();
      }
      throw error;
    }
    let released = false;
    let retained = false;
    let renewing = Promise.resolve();
    const timer = lock === void 0 ? void 0 : setInterval(() => {
      renewing = renewing.then(async () => {
        if (!released) await lock.renew();
      }).catch((error) => {
        retained = true;
        if (scope) this.quarantine(scope.repoId, input.runId);
        process.stderr.write(`repository lease renewal failed; retained ${input.runId}: ${String(error)}
`);
        if (timer) clearInterval(timer);
      });
    }, 2e4);
    timer?.unref();
    let reconciled;
    return {
      assertActive: async () => {
        if (released || retained) throw new Error("execution lease unavailable");
        await lock?.assertActive();
        if (released || retained) throw new Error("execution lease unavailable");
      },
      releaseAfterReconciliation: (verify) => {
        if (released) return Promise.resolve();
        if (reconciled) return reconciled;
        if (typeof verify !== "function") return Promise.reject(new Error("trusted reconciliation verifier required"));
        reconciled = (async () => {
          if (timer) clearInterval(timer);
          await renewing;
          const result = await verify();
          if (result !== void 0) throw new Error("invalid reconciliation authority");
          await lock?.release();
          released = true;
          retained = false;
          if (scope) {
            const owners = this.quarantinedRepositories.get(scope.repoId);
            owners?.delete(input.runId);
            if (owners?.size === 0) this.quarantinedRepositories.delete(scope.repoId);
          }
          releasePermits();
        })().catch((error) => {
          retained = true;
          if (scope) this.quarantine(scope.repoId, input.runId);
          throw error;
        }).finally(() => {
          reconciled = void 0;
        });
        return reconciled;
      },
      retain: (reason) => {
        retained = true;
        if (timer) clearInterval(timer);
        if (scope) this.quarantine(scope.repoId, input.runId);
        process.stderr.write(`osstack: retaining write lease ${input.runId}: ${reason}
`);
      },
      release: async () => {
        if (released) return;
        if (retained) throw new Error("external stop unconfirmed; reconciliation required before release");
        released = true;
        if (timer) clearInterval(timer);
        await renewing;
        if (retained) {
          released = false;
          throw new Error("external stop unconfirmed; reconciliation required before release");
        }
        try {
          await lock?.release();
        } catch (error) {
          released = false;
          retained = true;
          if (scope) this.quarantine(scope.repoId, input.runId);
          process.stderr.write(`repository lock release failed; retained ${input.runId}: ${String(error)}
`);
          throw error;
        }
        releasePermits();
      }
    };
  }
};

// packages/cli/src/graph-test-fixture.ts
var git3 = (cwd, ...args) => execFileSync5("git", args, { cwd, encoding: "utf8" }).trim();
async function graphRpcFixture(mode = "success") {
  const root = await realpath5(await mkdtemp(join9(tmpdir(), "g22-rpc-")));
  const repo = join9(root, "source");
  await mkdir5(repo);
  git3(repo, "init", "-q");
  await writeFile2(join9(repo, "answer"), "0\n");
  git3(repo, "add", ".");
  git3(repo, "-c", "user.name=G22", "-c", "user.email=g22@invalid", "commit", "-qm", "base");
  const db = openDb({ path: join9(root, "control.sqlite") });
  let writes2 = 0;
  let granted = true;
  let abortObserved = false;
  const stopped = /* @__PURE__ */ new Set();
  const writer = {
    id: "writer",
    display_name: "writer",
    cost_tier: "low",
    capabilities: () => [CapabilitySchema2.parse({ id: "write", agent_id: "writer", kind: "code.write", description: "write" })],
    isAvailable: async () => ({ available: true, last_checked_at: 0 }),
    invoke: async function* (task, options2) {
      writes2++;
      if (mode === "cancel") {
        await new Promise((resolve2) => {
          if (options2?.aborted) resolve2();
          else options2?.addEventListener("abort", () => resolve2(), { once: true });
        });
        abortObserved = true;
      } else await writeFile2(join9(String(task.context?.["repo_path"]), "answer"), mode === "repair" && writes2 === 1 ? "0\n" : "1\n");
      if (mode !== "unknown") stopped.add(task.run_id);
      yield {
        event_id: task.run_id,
        run_id: task.run_id,
        session_id: task.session_id,
        seq: 1,
        created_at: Date.now() / 1e3,
        type: "done",
        terminal: true,
        payload: { status: mode === "cancel" ? "failed" : "completed", last_seq: 0, result_summary: "implemented", usage: { tokens_in: 1, tokens_out: 1, duration_ms: 1 } }
      };
    },
    confirmStopped: async (id) => ({ stopped: stopped.has(id), evidence: `finite:${id}` })
  };
  const reviewer = {
    ...writer,
    id: "reviewer",
    capabilities: () => [CapabilitySchema2.parse({ id: "review", agent_id: "reviewer", kind: "review.code", description: "review" })],
    invoke: async function* (task) {
      const good = (await readFile(join9(String(task.context?.["repo_path"]), "answer"), "utf8")).trim() === "1";
      stopped.add(task.run_id);
      yield {
        event_id: task.run_id,
        run_id: task.run_id,
        session_id: task.session_id,
        seq: 1,
        created_at: Date.now() / 1e3,
        type: "done",
        terminal: true,
        payload: { status: "completed", last_seq: 0, result_summary: JSON.stringify({ schemaVersion: 1, verdict: good ? "accept" : "changes_requested", summary: "actual candidate", findings: good ? [] : ["answer must be 1"] }), usage: { tokens_in: 1, tokens_out: 1, duration_ms: 1 } }
      };
    }
  };
  const request = {
    schemaVersion: 1,
    kind: "start",
    scope: { schemaVersion: 1, tenantId: "t", principalId: "p", workspaceId: "w" },
    idempotencyKey: "public-key",
    inputArtifactRef: "input",
    source: { product: "osstack", requestId: "request", parentRunId: "parent" },
    spec: {
      schemaVersion: 1,
      template: "code-delivery-v1",
      publication: "artifact_only",
      input: { taskRef: "task", repositoryRef: "repo", baseRevision: git3(repo, "rev-parse", "HEAD"), acceptanceRef: "acceptance" },
      limits: { maxEpochs: 2, maxBranchAttempts: 1, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 14, tokenReservationLimit: 2e5, deadlineSeconds: 120 }
    }
  };
  const registration = {
    id: "local",
    scope: request.scope,
    product: "osstack",
    repositoryRef: "repo",
    taskRef: "task",
    inputArtifactRef: "input",
    authorize: (operation) => {
      if (!granted && operation !== "read" && operation !== "cancel") throw Error("GRANT_EXPIRED");
    },
    delivery: {
      repositoryPath: repo,
      task: "Set answer to 1",
      writer: { identity: "writer", adapter: writer, capabilityId: "write" },
      reviewer: { identity: "reviewer", adapter: reviewer, capabilityId: "review" },
      verifyReviewer: async (proof) => {
        if (proof.writerIdentity === proof.reviewerIdentity) throw Error("independence");
      },
      acceptanceRegistry: [{ ref: "acceptance", command: 'test "$(cat answer)" = 1', passExitCodes: [0], failExitCodes: [1] }]
    }
  };
  const connection = {};
  const admission = new GovernedExecution({ reads: new FifoSemaphore2(2), writes: new FifoSemaphore2(2), repositories: /* @__PURE__ */ new Map(), checkHealth: async () => {
  } });
  const options = { db, root: join9(root, "delivery"), registrations: [registration], resolveCaller: (key) => key === connection ? "local" : null, acquire: admission.acquire.bind(admission) };
  const service = new GraphRpcService(options);
  const start = async () => GraphDelegationStatus2.parse(await service.handle(connection, "graph.start", request));
  const status = async (id, host = service) => GraphDelegationStatus2.parse(await host.handle(connection, "graph.status", { schemaVersion: 1, scope: request.scope, graphRunId: id }));
  const until = async (id, predicate) => {
    const deadline = Date.now() + 2e4;
    for (; ; ) {
      const value = await status(id);
      if (predicate(value)) return value;
      if (Date.now() > deadline) throw Error(`TIMEOUT: ${JSON.stringify(value)}`);
      await new Promise((resolve2) => setTimeout(resolve2, 15));
    }
  };
  return {
    root,
    db,
    request,
    registration,
    connection,
    service,
    start,
    status,
    until,
    options,
    writer,
    reviewer,
    writes: () => writes2,
    abortObserved: () => abortObserved,
    grant: (value) => {
      granted = value;
    },
    close: async () => {
      await service.close();
      db.close();
    }
  };
}

// ../../../tmp/g30-final/import-proof/entry.ts
var f = await graphRpcFixture();
try {
  const run = await f.start();
  const ready = await f.until(run.graphRunId, (s) => s.status === "ready");
  await writeFile3("/Volumes/AIMATE_WORK/tmp/g30-final/import-proof/result.json", JSON.stringify({ passed: ready.status === "ready", graphRunId: run.graphRunId, hostPid: process.pid, policy: "Host loader rejects every @langchain module; isolated worker runs normally" }, null, 2));
} finally {
  await f.close();
}

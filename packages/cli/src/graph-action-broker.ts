import { GraphAdmissionStore } from "@osstack/core/graph-recovery";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type Database from "better-sqlite3";
import type { GraphArtifactStore, GraphFreezeInput, GraphFreezeAuthority } from "@osstack/core/graph-artifacts";
import { CapabilitySchema, GraphActionStore, GraphRunStore, type GraphRunFence, type GraphProgramIdentity,
  type GraphAction } from "@osstack/core";
import { GraphResult, GraphScope, WorkerActionRequest, WorkerActionResponse,
  type GraphError, type GraphErrorCode } from "@osstack/protocol";
import { ExecutionPlan, executeCandidateImplementation, runShellCommand,
  type CandidateExecutionResult, type CommandResult, type RegisteredCandidateWorkspace } from "@osstack/loop";
import type { AgentAdapter } from "@osstack/agents";
import type { AdmissionInput, ExecutionLease } from "./governed-execution.js";

type Action = WorkerActionRequest["action"];
export interface GraphActionEvidence {
  status: "completed" | "failed";
  candidate?: CandidateExecutionResult;
  command?: CommandResult;
  workspace?: unknown;
  frozenCandidate?: Extract<GraphResult, { kind: "candidate_ready" }>;
}
export interface PersistedGraphActionEvidence {
  evidenceRef: string;
  result?: GraphResult;
  actualTokens?: number;
}
type RegisteredExecution =
  | { kind: "freeze"; store: Pick<GraphArtifactStore, "freeze">; input: GraphFreezeInput; authority: Omit<GraphFreezeAuthority, "lease"> }
  | { kind: "adapter"; plan: ExecutionPlan; adapter: AgentAdapter; capabilityId: string }
  | { kind: "command"; plan: ExecutionPlan; command: string }
  | { kind: "workspace"; handler: (input: { workspace: RegisteredCandidateWorkspace; signal: AbortSignal }) => Promise<{
      status: "completed" | "failed"; stopped: true; evidence: unknown;
    }> };
export interface GraphRegisteredAction {
  nodeId: string;
  effectSlot: string;
  action: Action;
  tokenReservation: number;
  execution: RegisteredExecution;
  /** Trusted persistence boundary. Worker receipts/checkpoints are never passed here. */
  persist: (evidence: GraphActionEvidence) => Promise<PersistedGraphActionEvidence>;
}
export interface GraphWorkerRegistration {
  scope: GraphScope;
  graphRunId: string;
  identity: GraphProgramIdentity;
  generation: number;
  owner: string;
  epoch: number;
  workspace: RegisteredCandidateWorkspace;
  /** Synchronous host revocation check, including immediately before physical effects. */
  authorize: () => void;
  actions: readonly GraphRegisteredAction[];
}
export interface GraphRetainedAction {
  effectKey: string; scope: GraphScope; graphRunId: string; generation: number;
  owner: string; workspacePath: string;
}
export interface GraphActionBrokerOptions {
  acquire: (input: AdmissionInput) => Promise<ExecutionLease>;
  authorizePolicy?: (workspacePath: string) => Promise<void>;
  now?: () => number;
}
type BoundAction = GraphRegisteredAction & { access: "read" | "write" };
type Binding = Omit<GraphWorkerRegistration, "actions"> & { actions: ReadonlyMap<string, BoundAction> };
const slot = (node: string, effect: string) => JSON.stringify([node, effect]);
const reads = new Set(["code.review", "review.code", "research.code"]);
const writes = new Set(["code.write", "code.refactor", "code.debug", "code.test"]);
function snapshot<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item !== null && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); }
  };
  freeze(copy); return copy;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
class Denied extends Error { constructor(readonly code: GraphErrorCode, message: string) { super(message); } }
function graphError(code: GraphErrorCode, message: string): GraphError {
  return { schemaVersion: 1, code, message: message.slice(0, 4096) || code, retryable: false,
    nextAction: code === "ACTION_OUTCOME_UNKNOWN" || code === "CANCEL_UNCONFIRMED" ? "reconcile" : "stop" } as GraphError;
}
function errorCode(error: unknown): GraphErrorCode {
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

/** Trusted in-process action port; no RPC, worker launcher or node scheduler.
 * Ledger granularity is one adapter invocation, registered command or host workspace
 * operation. It does not intercept an agent's internal tools. Admission belongs to
 * each action; callers must NOT hold a whole-run lease around this port. */
export class GraphActionBroker {
  private readonly connections = new WeakMap<object, Binding>();
  private readonly retired = new WeakSet<object>();
  private readonly retained = new Map<string, { lease: ExecutionLease; context: GraphRetainedAction }>();
  private readonly admissions: GraphAdmissionStore;
  private readonly runs: GraphRunStore;
  private readonly actions: GraphActionStore;
  constructor(db: Database.Database, private readonly options: GraphActionBrokerOptions) {
    this.admissions = new GraphAdmissionStore(db);
    this.runs = new GraphRunStore(db); this.actions = new GraphActionStore(db);
  }

  register(connection: object, input: GraphWorkerRegistration): void {
    if (this.retired.has(connection)) throw new Error("worker connection retired");
    if (this.connections.has(connection)) throw new Error("worker connection already registered");
    const { actions, authorize, ...data } = input;
    const fixed = snapshot(data);
    GraphScope.parse(fixed.scope);
    if (typeof authorize !== "function" || !fixed.owner || !isAbsolute(fixed.workspace.workspace_path)
      || fixed.workspace.workspace_path.includes("\0") || fixed.workspace.workspace_id !== fixed.scope.workspaceId) throw new Error("invalid trusted worker registration");
    const registered = new Map<string, BoundAction>();
    for (const item of actions) {
      const { execution, persist, ...actionData } = item;
      const copy = snapshot(actionData);
      // Reuse the strict wire parser to validate exact compiled action/node/slot data.
      WorkerActionRequest.parse({ schemaVersion: 1, kind: "worker_action", requestId: "registration", scope: fixed.scope,
        graphRunId: fixed.graphRunId, specHash: fixed.identity.specHash, generation: fixed.generation, epoch: fixed.epoch,
        nodeId: copy.nodeId, effectSlot: copy.effectSlot, action: copy.action });
      if (typeof persist !== "function") throw new Error("unsupported graph action");
      if (!Number.isSafeInteger(copy.tokenReservation) || copy.tokenReservation < 0) throw new Error("invalid token reservation");
      let selected: RegisteredExecution; let access: "read" | "write" = "write";
      if (execution.kind === "freeze") {
        if (copy.action.kind !== "freeze" || typeof execution.store?.freeze !== "function") throw new Error("unsupported freeze registration");
        const input = snapshot(execution.input);
        if (canonical(input.scope) !== canonical(fixed.scope) || input.runId !== fixed.graphRunId || input.generation !== fixed.generation
          || input.owner !== fixed.owner || input.worktreePath !== fixed.workspace.workspace_path
          || input.workspaceLeaseRef !== copy.action.workspaceLeaseRef || input.implementationReceiptRef !== copy.action.receiptRef) throw new Error("freeze registration identity mismatch");
        const { verifyLease, verifyImplementationReceipt, verifyProducersStopped } = execution.authority;
        if ([verifyLease, verifyImplementationReceipt, verifyProducersStopped].some(fn => typeof fn !== "function")) throw new Error("freeze authority required");
        selected = Object.freeze({ kind: "freeze", input, store: Object.freeze({ freeze: execution.store.freeze.bind(execution.store) }),
          authority: Object.freeze({ verifyLease, verifyImplementationReceipt, verifyProducersStopped }) });
      } else if (execution.kind === "workspace") {
        if (!["workspace_create", "workspace_release"].includes(copy.action.kind) || typeof execution.handler !== "function") throw new Error("unsupported workspace handler");
        selected = Object.freeze({ kind: "workspace", handler: execution.handler });
      } else {
        if (!["implement", "repair", "tests", "review"].includes(copy.action.kind)) throw new Error("unsupported candidate action");
        const plan = snapshot(ExecutionPlan.parse(execution.plan));
        if (plan.worktree_path !== undefined && plan.worktree_path !== fixed.workspace.workspace_path) throw new Error("workspace mismatch");
        if (execution.kind === "command") {
          if (!execution.command?.trim() || execution.command.includes("\0")) throw new Error("invalid registered command");
          selected = Object.freeze({ kind: "command", plan, command: execution.command });
        } else if (execution.kind === "adapter") {
          const adapter = execution.adapter;
          const capabilities = snapshot(adapter.capabilities().map(cap => CapabilitySchema.parse(cap)));
          const matches = capabilities.filter(cap => cap.id === execution.capabilityId);
          const cap = matches[0];
          if (matches.length !== 1 || !cap || cap.agent_id !== adapter.id || plan.agent_id !== adapter.id
            || plan.task.capability !== cap.kind || (!reads.has(cap.kind) && !writes.has(cap.kind))) throw new Error("unknown or ambiguous trusted capability");
          // A multi-capability adapter can internally select a writer. Only entirely
          // read-only registrations may consume a read permit.
          if (capabilities.some(capability => !reads.has(capability.kind) && !writes.has(capability.kind))) throw new Error("unknown adapter capability");
          access = capabilities.every(capability => reads.has(capability.kind)) ? "read" : "write";
          const bound: AgentAdapter = Object.freeze({ id: adapter.id, display_name: adapter.display_name, cost_tier: adapter.cost_tier,
            capabilities: () => structuredClone(capabilities), isAvailable: adapter.isAvailable.bind(adapter), invoke: adapter.invoke.bind(adapter),
            ...(adapter.confirmStopped ? { confirmStopped: adapter.confirmStopped.bind(adapter) } : {}) });
          selected = Object.freeze({ kind: "adapter", plan, adapter: bound, capabilityId: execution.capabilityId });
        } else throw new Error("unsupported execution handler");
      }
      const key = slot(copy.nodeId, copy.effectSlot);
      if (registered.has(key)) throw new Error("duplicate compiled action slot");
      registered.set(key, Object.freeze({ ...copy, execution: selected, persist, access }));
    }
    const binding = Object.freeze({ ...fixed, authorize, actions: registered });
    // Verify full registered identity at installation, then at every ledger access.
    this.fence(binding);
    this.connections.set(connection, binding);
  }

  unregister(connection: object): void {
    this.connections.delete(connection);
    this.retired.add(connection);
  }

  /** Trusted recovery service only. Commit the decision before verifying/releasing;
   * this method deliberately cannot mutate outcomes or allocate another attempt. */
  async releaseReconciled(effectKey: string, verify: (context: GraphRetainedAction) => Promise<void>): Promise<boolean> {
    const entry = this.retained.get(effectKey);
    if (!entry) return false;
    if (!entry.lease.releaseAfterReconciliation) throw new Error("lease reconciliation unsupported");
    const verification: unknown = await verify(snapshot(entry.context));
    if (verification !== undefined) throw new Error("invalid reconciliation authority");
    await entry.lease.releaseAfterReconciliation(() => verify(snapshot(entry.context)));
    this.admissions.released(effectKey, this.options.now?.() ?? Date.now());
    this.retained.delete(effectKey);
    return true;
  }

  private authorize(binding: Binding): void {
    const result: unknown = binding.authorize();
    if (result !== undefined) {
      // TypeScript allows async functions in void positions. Never silently
      // treat a pending/rejected promise as synchronous permission.
      void Promise.resolve(result).catch(() => {});
      throw new Denied("POLICY_DENIED", "revocation check must be synchronous");
    }
  }

  private fence(binding: Binding): GraphRunFence {
    const run = this.runs.get(binding.scope, binding.graphRunId);
    if (!run) throw new Denied("RUN_MISMATCH", "registered run not found");
    if (run.generation !== binding.generation || run.leaseOwner !== binding.owner) throw new Denied("STALE_GENERATION", "registered worker lease changed");
    if (canonical(run.identity) !== canonical(binding.identity)) throw new Denied("CHECKPOINT_INCOMPATIBLE", "registered program identity changed");
    const now = this.options.now?.() ?? Date.now();
    if (!run.leaseExpiresAt || run.leaseExpiresAt <= now) throw new Denied("STALE_GENERATION", "registered worker lease expired");
    return { scope: binding.scope, graphRunId: binding.graphRunId, identity: binding.identity,
      expectedGeneration: binding.generation, expectedOwner: binding.owner, expectedRevision: run.revision, now };
  }

  handle(connection: object, value: unknown, options: { signal?: AbortSignal } = {}): Promise<WorkerActionResponse> {
    return this.executeRequest(connection, value, options);
  }

  /** Trusted host command, never part of worker transport. Only this call owns the
   * freshly ledger-allocated retry intent; ordinary replays cannot claim it. */
  async retryAuthorized(connection: object, effectKey: string, authorizeRetry: () => void,
    options: { signal?: AbortSignal } = {}): Promise<WorkerActionResponse> {
    const binding = this.connections.get(connection);
    if (!binding) throw new Error("UNAUTHENTICATED");
    this.authorize(binding);
    const permitted: unknown = authorizeRetry();
    if (permitted !== undefined) {
      void Promise.resolve(permitted).catch(() => {});
      throw new Error("invalid synchronous retry authority");
    }
    if (options.signal?.aborted) throw new Error("retry cancelled");
    const prior = this.actions.get(this.fence(binding), effectKey).action;
    const registered = binding.actions.get(slot(prior.effect.nodeId, prior.effect.effectSlot));
    if (!registered || prior.effect.epoch !== binding.epoch || canonical(registered.action) !== canonical(prior.action)) throw new Error("unregistered retry slot");
    const next = this.actions.retry(this.fence(binding), effectKey).action;
    return this.executeRequest(connection, { schemaVersion: 1, kind: "worker_action", requestId: `retry:${randomUUID()}`,
      scope: binding.scope, graphRunId: binding.graphRunId, generation: binding.generation, specHash: binding.identity.specHash,
      epoch: binding.epoch, nodeId: prior.effect.nodeId, effectSlot: prior.effect.effectSlot, action: registered.action }, options, next.effectKey, authorizeRetry);
  }

  private async executeRequest(connection: object, value: unknown, options: { signal?: AbortSignal }, retryEffectKey?: string, authorizeRetry?: () => void): Promise<WorkerActionResponse> {
    let request: WorkerActionRequest;
    try { request = snapshot(WorkerActionRequest.parse(value)); }
    catch { return { schemaVersion: 1, kind: "worker_action_rejected", requestId: "invalid-request", error: graphError("INPUT_CONTRACT_INVALID", "invalid worker action request") }; }
    const binding = this.connections.get(connection);
    const signal = options.signal ?? new AbortController().signal;
    let lease: ExecutionLease | undefined; let owned: GraphAction | undefined; let invoked = false; let uncertain = false; let observedTokens = 0; let persistedEvidenceRef: string | undefined;
    const reject = (error: unknown): WorkerActionResponse => ({ schemaVersion: 1, kind: "worker_action_rejected", requestId: request.requestId,
      error: graphError(errorCode(error), String(error)) });
    try {
      if (!binding) throw new Denied("UNAUTHENTICATED", "unregistered worker connection");
      if (canonical(request.scope) !== canonical(binding.scope)) throw new Denied("SCOPE_MISMATCH", "scope does not match registered connection");
      if (request.graphRunId !== binding.graphRunId) throw new Denied("RUN_MISMATCH", "run does not match registered connection");
      if (request.generation !== binding.generation) throw new Denied("STALE_GENERATION", "generation does not match registered connection");
      if (request.specHash !== binding.identity.specHash) throw new Denied("SPEC_MISMATCH", "spec does not match registered program");
      if (request.epoch !== binding.epoch) throw new Denied("EPOCH_MISMATCH", "epoch does not match registered program");
      const action = binding.actions.get(slot(request.nodeId, request.effectSlot));
      if (!action) throw new Denied("POLICY_DENIED", "unregistered compiled action slot");
      if (canonical(action.action) !== canonical(request.action)) throw new Denied("IDEMPOTENCY_CONFLICT", "action differs from immutable compiled registration");
      const check = (): void => { if (this.connections.get(connection) !== binding) throw new Denied("UNAUTHENTICATED", "worker connection retired"); if (signal.aborted) throw new Denied("POLICY_DENIED", "action cancelled before invocation"); this.authorize(binding); this.fence(binding);
        if (authorizeRetry) {
          const permitted: unknown = authorizeRetry();
          if (permitted !== undefined) { void Promise.resolve(permitted).catch(() => {}); throw new Denied("POLICY_DENIED", "retry authority must be synchronous"); }
        }
      };
      check();
      const intent = this.actions.reserve(this.fence(binding), { epoch: binding.epoch, nodeId: action.nodeId, effectSlot: action.effectSlot,
        reservationTokens: action.tokenReservation, action: action.action });
      if (!intent.created && intent.action.effectKey !== retryEffectKey) return this.response(request, intent.action);
      if (retryEffectKey && (intent.action.state !== "intent" || intent.action.generation !== binding.generation)) {
        return this.response(request, intent.action);
      }
      owned = intent.action;
      lease = await this.options.acquire({ kind: action.access, runId: `graph-action:${owned.effectKey}`, workspacePath: binding.workspace.workspace_path,
        signal, authorize: async () => { check(); await this.options.authorizePolicy?.(binding.workspace.workspace_path); check(); } });
      this.admissions.hold(owned.effectKey, this.options.now?.() ?? Date.now());
      check();
      // This synchronous gate runs inside the actual adapter invoke/command/host
      // handler call, after G04's async authorization and availability windows.
      const beforeEffect = (executionRunId: string): void => {
        check();
        let started: ReturnType<GraphActionStore["markRunning"]>;
        try {
          started = this.actions.markRunning(this.fence(binding), owned!.effectKey, `graph-execution:${owned!.effectKey}:${executionRunId}`);
        } catch (error) {
          // A different execution reference also proves somebody already started.
          if (String(error).includes("EXECUTION_CONFLICT")) invoked = true;
          throw error;
        }
        if (!started.changed) {
          // Another trusted caller already started this effect. We cannot prove
          // non-execution, so retain admission and require reconciliation.
          invoked = true;
          throw new Denied("ACTION_OUTCOME_UNKNOWN", "intent already started");
        }
        invoked = true;
      };
      const evidence = await this.execute(binding, action, signal, beforeEffect, tokens => { observedTokens = Math.max(observedTokens, tokens); }, lease);
      if (!invoked) throw new Denied("POLICY_DENIED", "execution did not start");
      const persisted = snapshot(await action.persist(evidence));
      if (typeof persisted.evidenceRef !== "string" || !persisted.evidenceRef || persisted.evidenceRef.trim() !== persisted.evidenceRef
        || persisted.evidenceRef.length > 256 || Array.from(persisted.evidenceRef).some(char => {
          const code = char.charCodeAt(0); return code < 32 || (code >= 127 && code <= 159);
        })) throw new Error("invalid persisted evidence reference");
      persistedEvidenceRef = persisted.evidenceRef;
      if (persisted.actualTokens !== undefined && (!Number.isSafeInteger(persisted.actualTokens) || persisted.actualTokens < 0)) throw new Error("invalid usage");
      observedTokens = Math.max(observedTokens, persisted.actualTokens ?? 0);
      const usage = evidence.candidate?.execution;
      const measured = usage?.tokens_in !== undefined && usage.tokens_out !== undefined ? usage.tokens_in + usage.tokens_out : undefined;
      if (measured !== undefined && !Number.isSafeInteger(measured)) throw new Error("invalid total token usage");
      const actualTokens = Math.max(observedTokens, persisted.actualTokens ?? 0, measured ?? Math.max(action.tokenReservation, usage?.tokens_in ?? 0, usage?.tokens_out ?? 0));
      let result: GraphResult | undefined;
      if (evidence.status === "completed") {
        result = GraphResult.parse(persisted.result);
        if (action.action.kind === "freeze" && (!evidence.frozenCandidate || canonical(result) !== canonical(evidence.frozenCandidate))) throw new Error("freeze result differs from durable artifact");
        const expected = action.action.kind === "freeze" ? "candidate_ready" : action.action.kind === "implement" || action.action.kind === "repair" ? "implementation_complete"
          : action.action.kind.startsWith("workspace_") ? "workspace" : action.action.kind;
        if (result.kind !== expected) throw new Error("invalid result kind for registered operation");
        if ("workspaceLeaseRef" in result && "workspaceLeaseRef" in action.action && result.workspaceLeaseRef !== action.action.workspaceLeaseRef) throw new Error("persisted workspace mismatch");
        if ("candidateRevision" in result && "candidateRevision" in action.action && result.candidateRevision !== action.action.candidateRevision) throw new Error("persisted revision mismatch");
      }
      const settled = this.actions.recordOutcome(this.fence(binding), owned.effectKey, evidence.status === "completed"
        ? { state: "confirmed", evidenceRef: persisted.evidenceRef, actualTokens, result: result! }
        : { state: "failed", evidenceRef: persisted.evidenceRef, actualTokens, retrySafe: false, error: { message: "trusted stopped invocation failed" } });
      return this.response(request, settled.action);
    } catch (error) {
      if (binding && owned) {
        if (invoked) {
          uncertain = true; lease?.retain(String(error));
          if (lease) this.retained.set(owned.effectKey, { lease, context: { effectKey: owned.effectKey,
            scope: binding.scope, graphRunId: binding.graphRunId, generation: binding.generation,
            owner: binding.owner, workspacePath: binding.workspace.workspace_path } });
          try { const unknown = this.actions.markUncertain(this.fence(binding), owned.effectKey, { state: "unknown", evidenceRef: persistedEvidenceRef ?? `unknown:${randomUUID()}`, observedTokens: Math.max(owned.reservationTokens, observedTokens) });
            return this.response(request, unknown.action); } catch { /* Commit/fence failure preserves the original running reservation. */ }
          return { schemaVersion: 1, kind: "worker_action_response", requestId: request.requestId, generation: request.generation,
            effect: owned.effect, outcome: { state: "unknown", error: graphError("ACTION_OUTCOME_UNKNOWN", String(error)), reconciliationRef: owned.effectKey } };
        }
        // No physical invocation: resolve this caller's own intent without calling
        // it unknown. Only a future explicit host retry can use this proof;
        // cancellations remain sealed and worker replay never allocates attempts.
        try { this.actions.recordOutcome(this.fence(binding), owned.effectKey, { state: "failed", evidenceRef: `not-started:${randomUUID()}`,
          actualTokens: 0, retrySafe: !signal.aborted, error: { message: "admission refused before invocation" } }); } catch { /* A stale owner cannot mutate a newer generation. */ }
      }
      return reject(error);
    } finally {
      if (lease && !uncertain) await this.releaseAdmission(lease, binding, owned);
    }
  }

  private async releaseAdmission(lease: ExecutionLease, binding: Binding | undefined, owned: GraphAction | undefined): Promise<void> {
    let physicallyReleased = false;
    try {
      await lease.release(); physicallyReleased = true;
      if (owned) this.admissions.released(owned.effectKey, this.options.now?.() ?? Date.now());
    }
    catch (error) {
      // Release failure deliberately stops the chain without replacing durable
      // effect truth. Keep its exact admission reachable for release-only recovery.
      if (!physicallyReleased) lease.retain(String(error));
      if (binding && owned) this.retained.set(owned.effectKey, { lease, context: {
        effectKey: owned.effectKey, scope: binding.scope, graphRunId: binding.graphRunId,
        generation: binding.generation, owner: binding.owner, workspacePath: binding.workspace.workspace_path,
      } });
      throw error;
    }
  }

  private response(request: WorkerActionRequest, action: GraphAction): WorkerActionResponse {
    const base = { schemaVersion: 1 as const, kind: "worker_action_response" as const, requestId: request.requestId,
      generation: request.generation, effect: action.effect };
    if (action.state === "confirmed") return WorkerActionResponse.parse({ ...base, outcome: { state: "confirmed", result: action.outcome?.state === "confirmed" ? action.outcome.result : undefined } });
    if (action.state === "failed") return WorkerActionResponse.parse({ ...base, outcome: { state: "failed", error: graphError("POLICY_DENIED", "prior invocation failed; no automatic retry") } });
    return { ...base, outcome: { state: "unknown", error: graphError("ACTION_OUTCOME_UNKNOWN", "existing action requires reconciliation; invocation was not repeated"), reconciliationRef: action.effectKey } };
  }

  private async execute(binding: Binding, action: BoundAction, signal: AbortSignal, beforeEffect: (executionRunId: string) => void, observeTokens: (tokens: number) => void, lease?: ExecutionLease): Promise<GraphActionEvidence> {
    const execution = action.execution;
    if (execution.kind === "freeze") {
      if (!lease?.assertActive) throw new Error("freeze requires canonical lease verification");
      const check = (): void => { if (signal.aborted) throw new Error("freeze cancelled"); this.authorize(binding); this.fence(binding); };
      await this.options.authorizePolicy?.(binding.workspace.workspace_path); check();
      await lease.assertActive(); check(); beforeEffect(`freeze:${randomUUID()}`);
      const frozenCandidate = await execution.store.freeze(execution.input, { ...execution.authority, lease,
        verifyLease: async (input, actualLease) => {
          if (actualLease !== lease) throw new Error("freeze lease identity mismatch");
          check(); await lease.assertActive!(); check();
          const decision: unknown = await execution.authority.verifyLease(input, actualLease);
          if (decision !== undefined) throw new Error("invalid freeze authority");
          check();
        } });
      return { status: "completed", frozenCandidate };
    }
    if (execution.kind === "workspace") {
      await this.options.authorizePolicy?.(binding.workspace.workspace_path);
      beforeEffect(`workspace:${randomUUID()}`);
      const result = await execution.handler({ workspace: binding.workspace, signal });
      if (result?.stopped !== true || !["completed", "failed"].includes(result.status)) throw new Error("workspace outcome unconfirmed");
      return { status: result.status, workspace: result.evidence };
    }
    let threw = false; let command: CommandResult | undefined; let invocationRunId: string | undefined;
    const original = execution.kind === "adapter" ? execution.adapter : undefined;
    const capabilities = execution.kind === "adapter" ? execution.adapter.capabilities().filter(cap => cap.id === execution.capabilityId) : [CapabilitySchema.parse({ id: "registered-command.write", kind: "code.write", agent_id: "registered-command", description: "Registered command" })];
    const policy = this.options.authorizePolicy;
    const cumulativeUsage: Record<string, number> = { tokens_in: 0, tokens_out: 0 };
    const wrapper: AgentAdapter = {
      id: original?.id ?? "registered-command", display_name: "Governed graph action", cost_tier: "low",
      capabilities: () => capabilities, isAvailable: original?.isAvailable ?? (async () => ({ available: true, last_checked_at: 0 })),
      invoke: (task, invocationSignal) => {
        return (async function* () {
          await policy?.(binding.workspace.workspace_path);
          if (invocationSignal.aborted) throw new Denied("POLICY_DENIED", "execution cancelled before invocation");
          beforeEffect(task.run_id); invocationRunId = task.run_id;
          try {
            if (original) {
              for await (const event of original.invoke(task, invocationSignal)) {
                const payload: unknown = event.type === "usage.updated" || event.type === "usage.final" ? event.payload
                  : event.type === "done" && event.payload && typeof event.payload === "object" ? (event.payload as { usage?: unknown }).usage : undefined;
                if (payload !== undefined) {
                  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid adapter usage payload");
                  const usage = payload as Record<string, unknown>;
                  let tokens = 0;
                  for (const field of ["tokens_in", "tokens_out"]) {
                    const amount = usage[field];
                    if (amount !== undefined) {
                      if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) throw new Error("invalid adapter token usage");
                      cumulativeUsage[field] = Math.max(cumulativeUsage[field]!, amount);
                    }
                  }
                  // Providers may send input/output counters in separate events.
                  // Retain each cumulative maximum instead of only max(event sum).
                  tokens = cumulativeUsage["tokens_in"]! + cumulativeUsage["tokens_out"]!;
                  if (!Number.isSafeInteger(tokens)) throw new Error("invalid adapter total usage");
                  observeTokens(tokens);
                  const cost = usage["cost_usd"];
                  if (cost !== undefined && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) throw new Error("invalid adapter cost usage");
                }
                yield event;
              }
              return;
            }
            if (execution.kind !== "command") throw new Error("invalid execution registration");
            // runShellCommand starts synchronously before its returned promise; no
            // untrusted await separates the fence above from the actual spawn.
            command = await runShellCommand(execution.command, { cwd: binding.workspace.workspace_path, timeoutMs: 120_000,
              outputLimit: 16_000, ...(invocationSignal ? { signal: invocationSignal } : {}) });
            yield { event_id: randomUUID(), run_id: task.run_id, session_id: task.session_id, seq: 1, type: "done" as const,
              created_at: Date.now() / 1000, terminal: true, payload: { status: command.exitCode === 0 ? "completed" : "failed", last_seq: 0 } };
          } catch (error) { threw = true; throw error; }
        })();
      },
      confirmStopped: async runId => original?.confirmStopped ? original.confirmStopped(runId)
        : { stopped: command?.termination?.stop_confirmed === true, evidence: command?.termination?.evidence ?? "no trusted stop receipt" },
    };
    const candidate = await executeCandidateImplementation({ plan: { ...execution.plan, agent_id: wrapper.id }, workspace: binding.workspace,
      adapters: [wrapper], signal, cancellationGraceMs: 50,
      authorize: async () => { this.authorize(binding); this.fence(binding); return { allow: true }; } });
    if (!invocationRunId) throw new Denied("POLICY_DENIED", candidate.reason ?? "candidate preflight refused");
    if (threw || candidate.status === "execution_unconfirmed" || candidate.execution?.failure_code) throw new Error("adapter result or execution unconfirmed");
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([wrapper.confirmStopped!(invocationRunId),
      new Promise<{ stopped: false }>(resolve => { stopTimer = setTimeout(() => resolve({ stopped: false }), 1000); })])
      .finally(() => { if (stopTimer) clearTimeout(stopTimer); });
    if (stopped.stopped !== true || !stopped.evidence?.trim()) throw new Error("external stop unconfirmed");
    const usage = candidate.execution;
    if ([usage?.tokens_in, usage?.tokens_out].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) throw new Error("invalid adapter usage");
    return { status: candidate.status === "implementation_complete" ? "completed" : "failed", candidate, ...(command ? { command } : {}) };
  }
}

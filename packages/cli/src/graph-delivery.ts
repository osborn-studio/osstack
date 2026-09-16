import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { AgentAdapter } from '@osstack/agents';
import { GraphRunStore, GraphActionStore, GraphCheckpointStore, resolveRepositoryScope, type GraphRun, type GraphRunFence } from '@osstack/core';
import { GraphArtifactStore } from '@osstack/core/graph-artifacts';
import { GraphDeliveryEpochStore, GraphVerificationStore } from '@osstack/core/graph-verification';
import { compileGraphSpec, type CompiledGraphSpec } from '@osstack/graph/spec-compiler';
import { deliveryEpoch } from '@osstack/graph/templates/code-delivery-v1';
import { type GraphResult, WorkerActionRequest, workerCanonical, StartGraphRequest, freezeWorkerData, type WorkerActionResponse, type GraphWorkerResume } from '@osstack/protocol';
import type { RegisteredCandidateWorkspace } from '@osstack/loop';
import { GraphActionBroker, type GraphRegisteredAction, type GraphActionEvidence } from './graph-action-broker.js';
import { GraphRuntime, type GraphRuntimeHandle, type GraphRuntimeStop } from './graph-runtime.js';
import { GraphCheckpointService } from './graph-checkpoint-service.js';
import { prepareGraphVerificationBranch, loadGraphVerificationEvidence, type GraphVerificationOptions } from './graph-verification.js';
import { GraphVerificationJoinService, type GraphVerificationDecision } from './graph-verification-join.js';
import { publishDeliveryReceipt, loadDeliveryReceipt } from './graph-delivery-receipts.js';
import type { AdmissionInput, ExecutionLease } from './governed-execution.js';

export interface GraphDeliveryOptions {
  db: Database.Database; request: StartGraphRequest; root: string; repositoryPath: string;
  task: string; writer: { identity: string; adapter: AgentAdapter; capabilityId: string };
  reviewer: GraphVerificationOptions['reviewer']; verifyReviewer: GraphVerificationOptions['verifyReviewer'];
  acceptanceRegistry: GraphVerificationOptions['acceptanceRegistry'];
  acquire: (input: AdmissionInput) => Promise<ExecutionLease>; authorize: () => void;
  /** Reserved and exclusively selected by the public host before construction. */
  reservedRun?: GraphRun;
  authorizeCancel?: () => void;
  /** Current source authority is distinct from the physical candidate checkout. */
  authorizePolicy?: (input: { policyRoot: string; workspacePath: string }) => Promise<void>;
  qualityInterrupt?: (proof: GraphDeliveryInterrupt) => void;
  publish?: (candidate: Candidate, feedbackRef: string) => void;
}
export interface GraphDeliveryInterrupt {
  interruptId: string; inputDigest: string; kind: 'quality';
  checkpointDigest: string; feedbackRef: string;
}
export function graphDeliveryVersion(compiled: CompiledGraphSpec) {
  return { executionModel: 'langgraph-functional-v1' as const, durability: 'sync' as const,
    engineVersion: '1.4.15', checkpointVersion: '1.1.5', templateVersion: '4', registryVersion: compiled.registryVersion,
    compilerVersion: compiled.compilerVersion, schemaVersion: compiled.schemaVersion, compiledProgramDigest: compiled.compiledProgramDigest };
}
type Candidate = Extract<GraphResult, { kind: 'candidate_ready' }>;
type Kind = 'review' | 'tests';
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', timeout: 30000,
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();

/** Trusted host composition. No worker-selected executors, paths or commands.
 * Functional tasks own replay; effects own invocation; immutable joins own repair. */
export class GraphDelivery {
  readonly compiled: CompiledGraphSpec;
  readonly broker: GraphActionBroker;
  readonly artifacts: GraphArtifactStore;
  private readonly runs: GraphRunStore;
  private runValue!: GraphRun;
  private owned: GraphRun | undefined;
  private runtime!: GraphRuntime;
  private epoch = 0;
  private readonly installed = new Map<string, Promise<void>>();
  private readonly branches = new Map<string, GraphRegisteredAction>();
  private readonly workspaces = new Map<number, RegisteredCandidateWorkspace>();
  private feedbackRef: string | undefined;
  private connection: object | undefined;
  private closed = false;
  private started = false;
  private stopping = false;
  private active: GraphRuntimeHandle | undefined;
  private waiting: { proof: GraphDeliveryInterrupt; verify: () => void; resolve: () => void; reject: (error: Error) => void } | undefined;
  private readonly options: GraphDeliveryOptions;
  constructor(options: GraphDeliveryOptions) {
    const adapter = (a: AgentAdapter): AgentAdapter => {
      const capabilities = freezeWorkerData(structuredClone(a.capabilities()));
      return Object.freeze({ id: a.id, display_name: a.display_name, cost_tier: a.cost_tier,
        capabilities: () => structuredClone(capabilities), isAvailable: a.isAvailable.bind(a), invoke: a.invoke.bind(a),
        ...(a.confirmStopped ? { confirmStopped: a.confirmStopped.bind(a) } : {}) });
    };
    this.options = Object.freeze({ ...options, request: freezeWorkerData(StartGraphRequest.parse(options.request)),
      writer: Object.freeze({ ...options.writer, adapter: adapter(options.writer.adapter) }),
      reviewer: Object.freeze({ ...options.reviewer, adapter: adapter(options.reviewer.adapter) }),
      acceptanceRegistry: freezeWorkerData(structuredClone(options.acceptanceRegistry)) });
    options = this.options;
    const capability = options.writer.adapter.capabilities().find(c => c.id === options.writer.capabilityId);
    if (options.writer.identity !== options.writer.adapter.id || !capability || !['code.write','code.refactor','code.debug'].includes(capability.kind)) throw Error('WRITER_IDENTITY_REQUIRED');
    this.compiled = compileGraphSpec(options.request.spec);
    this.runs = new GraphRunStore(options.db);
    if (options.reservedRun) this.runValue = options.reservedRun;
    this.broker = new GraphActionBroker(options.db, { acquire: options.acquire,
      ...(options.authorizePolicy ? { authorizePolicy: (workspacePath: string) => options.authorizePolicy!({ policyRoot: options.repositoryPath, workspacePath }) } : {}) });
    this.artifacts = new GraphArtifactStore(join(options.root, 'artifacts'));
  }
  /** Called by the service after run() completes, before its shared DB closes. */
  async drainDatabaseUsers(): Promise<void> { if (this.runtime) await this.runtime.drainDatabaseUsers(); }
  current(): GraphRun { return this.runs.get(this.runValue.scope, this.runValue.graphRunId)!; }
  private leaseDeadline(): number {
    const createdAt = this.runValue ? this.current().createdAt : Date.now();
    return Math.min(Date.now() + 300000, createdAt + this.compiled.spec.limits.deadlineSeconds * 1000 + 1000);
  }
  private assertOwned(): void {
    if (!this.owned) return;
    const r = this.current();
    if (r.generation !== this.owned.generation || r.leaseOwner !== this.owned.leaseOwner || workerCanonical(r.identity) !== workerCanonical(this.owned.identity)) throw Error('STALE_DELIVERY_OWNER');
  }
  private fence(premise = this.current()): GraphRunFence { this.assertOwned(); const r = premise; return { scope: r.scope, graphRunId: r.graphRunId, identity: r.identity,
    expectedGeneration: r.generation, expectedOwner: r.leaseOwner, expectedRevision: r.revision, now: Date.now() }; }
  private check(): void {
    if (this.closed) throw Error('DELIVERY_CLOSED');
    this.assertOwned();
    const value: unknown = this.options.authorize();
    if (value !== undefined) { void Promise.resolve(value).catch(() => {}); throw Error('AUTHORITY_MUST_BE_SYNCHRONOUS'); }
  }
  private checkSettlement(): void {
    if (!this.stopping || this.current().status !== 'cancel_pending' || !this.options.authorizeCancel) { this.check(); return; }
    this.assertOwned();
    const value: unknown = this.options.authorizeCancel();
    if (value !== undefined) { void Promise.resolve(value).catch(() => {}); throw Error('AUTHORITY_MUST_BE_SYNCHRONOUS'); }
  }
  private latest(nodeId: string, effectSlot = 'main') {
    const row = this.options.db.prepare('SELECT effect_key FROM graph_actions WHERE graph_run_id=? AND node_id=? AND effect_slot=? ORDER BY logical_attempt DESC LIMIT 1').get(this.current().graphRunId, nodeId, effectSlot) as { effect_key: string } | undefined;
    return row ? new GraphActionStore(this.options.db).get(this.fence(), row.effect_key).action : undefined;
  }
  private result(nodeId: string): GraphResult {
    const a = this.latest(nodeId);
    if (a?.outcome?.state !== 'confirmed') throw Error(`PREDECESSOR_NOT_CONFIRMED: ${nodeId}`);
    return a.outcome.result;
  }
  private candidate(epoch = this.epoch): Candidate {
    const value = this.result(`e${epoch}.freeze`);
    if (value.kind !== 'candidate_ready') throw Error('CANDIDATE_REQUIRED');
    return value;
  }
  private binding() { const r = this.current(); const c = this.candidate(); return { scope: r.scope, graphRunId: r.graphRunId, specHash: r.identity.specHash,
    epoch: this.epoch, candidateRevision: c.candidateRevision, artifactDigest: c.artifactDigest, acceptanceRef: r.spec!.input.acceptanceRef }; }
  private receiptBinding(nodeId: string, workspacePath: string, effectSlot = 'main') {
    const a = this.latest(nodeId, effectSlot); const r = this.current();
    if (!a) throw Error('DELIVERY_EFFECT_REQUIRED');
    const owner = this.options.db.prepare('SELECT owner FROM graph_worker_leases WHERE graph_run_id=? AND generation=?').get(r.graphRunId, a.generation) as { owner: string } | undefined;
    if (!owner) throw Error('DELIVERY_EFFECT_LEASE_REQUIRED');
    return { effect: a.effect, effectKey: a.effectKey, generation: a.generation, owner: owner.owner, workspacePath };
  }
  private async persist(nodeId: string, workspacePath: string, evidence: GraphActionEvidence, effectSlot = 'main'): Promise<string> {
    if (this.latest(nodeId, effectSlot)?.state !== 'running') throw Error('RUNNING_EFFECT_REQUIRED');
    return publishDeliveryReceipt(this.options.root, this.receiptBinding(nodeId, workspacePath, effectSlot), evidence, () => this.checkSettlement());
  }
  private async restoreWorkspaceMappings(): Promise<void> {
    // Functional replay may skip cached workspace callbacks. Recover mappings
    // from exact content-addressed ledger receipts, never from worker RETURNs.
    for (let epoch = 0; epoch <= this.epoch; epoch++) {
      const nodeId = `e${epoch}.workspace`; const a = this.latest(nodeId);
      if (a?.outcome?.state !== 'confirmed') continue;
      const receipt = await loadDeliveryReceipt(this.options.root, a.outcome.evidenceRef, this.receiptBinding(nodeId, this.options.repositoryPath));
      const value = receipt.workspace as { workspace?: RegisteredCandidateWorkspace } | undefined;
      const workspace = value?.workspace;
      if (!workspace || workspace.workspace_id !== this.current().scope.workspaceId || workspace.workspace_path !== join(this.options.root, `writer-${epoch}`)
        || await realpath(workspace.workspace_path) !== workspace.workspace_path) throw Error('WORKSPACE_RECEIPT_MISMATCH');
      this.check(); this.workspaces.set(epoch, Object.freeze({ ...workspace }));
    }
  }
  private workspace(epoch = this.epoch): RegisteredCandidateWorkspace {
    const w = this.workspaces.get(epoch); if (!w) throw Error('WORKSPACE_MAPPING_REQUIRED'); return w;
  }
  private async preparation(kind: Kind, attempt: number): Promise<GraphRegisteredAction> {
    const p = deliveryEpoch(this.compiled, this.epoch); const n = p.node(`prepare_${kind}`); const candidate = this.candidate();
    const epoch = this.epoch; const source = this.workspace(); const branch = p.node(kind);
    return { nodeId: n.id, effectSlot: p.preparationSlot(kind, attempt), tokenReservation: n.tokenReservation,
      action: { kind: 'workspace_create', repositoryRef: this.compiled.spec.input.repositoryRef, baseRevision: candidate.candidateRevision }, workspace: source,
      execution: { kind: 'workspace', handler: async ({ lease }) => {
        const prepared = await prepareGraphVerificationBranch({ root: join(this.options.root, 'verification'), artifacts: this.artifacts, candidate,
          binding: this.binding(), sourceWorkspace: source, authorize: () => this.check(), authorizeCancel: () => this.checkSettlement(), acquire: this.options.acquire,
          ...(this.options.authorizePolicy ? { authorizePolicy: (workspacePath: string) => this.options.authorizePolicy!({ policyRoot: this.options.repositoryPath, workspacePath }) } : {}),
          preparationLease: lease, acceptanceRegistry: this.options.acceptanceRegistry, writerIdentity: this.options.writer.identity,
          reviewer: this.options.reviewer, verifyReviewer: this.options.verifyReviewer,
          slots: { [kind]: { nodeId: branch.id, effectSlot: branch.effectSlot, workspaceLeaseRef: `e${epoch}.${kind}`, tokenReservation: branch.tokenReservation } },
          effectIdentity: () => { const a = this.latest(branch.id); if (a?.state !== 'running') throw Error('RUNNING_EFFECT_REQUIRED'); return { effect: a.effect, effectKey: a.effectKey }; },
        }, kind);
        const action = prepared.actions[0]!; this.branches.set(branch.id, action);
        return { status: 'completed', stopped: true, evidence: { workspace: action.workspace, workspaceLeaseRef: `e${epoch}.${kind}` } };
      } }, persist: async evidence => ({ evidenceRef: await this.persist(n.id, source.workspace_path, evidence, p.preparationSlot(kind, attempt)), actualTokens: 0,
        result: { schemaVersion: 1, kind: 'workspace', workspaceLeaseRef: `e${epoch}.${kind}`, receiptRef: `e${epoch}.prepared.${kind}.${attempt}` } }) };
  }
  private async registration(name: string): Promise<GraphRegisteredAction> {
    const p = deliveryEpoch(this.compiled, this.epoch); const n = p.node(name); const r = this.current(); const epoch = this.epoch;
    const common = { nodeId: n.id, effectSlot: n.effectSlot, tokenReservation: n.tokenReservation };
    const workspaceLeaseRef = `e${epoch}.writer`;
    if (name === 'workspace') {
      const path = join(this.options.root, `writer-${epoch}`); const workspace = { workspace_id: r.scope.workspaceId, workspace_path: path };
      const baseRevision = epoch === 0 ? this.compiled.spec.input.baseRevision : this.candidate(epoch - 1).candidateRevision;
      return { ...common, workspace: { workspace_id: r.scope.workspaceId, workspace_path: this.options.repositoryPath },
        action: { kind: 'workspace_create', repositoryRef: this.compiled.spec.input.repositoryRef, baseRevision },
        execution: { kind: 'workspace', handler: async () => {
          this.check();
          if (epoch === 0) { if (git(this.options.repositoryPath, 'rev-parse', `${baseRevision}^{commit}`) !== baseRevision) throw Error('BASE_REVISION_MISMATCH'); git(this.options.root, 'clone', '--no-local', '--no-hardlinks', '--', this.options.repositoryPath, path); git(path, 'checkout', '--detach', baseRevision); }
          else { const restored = await this.artifacts.restore(this.candidate(epoch - 1).artifactDigest, { rootPath: this.options.root, directoryName: `writer-${epoch}` }); if (restored.worktreePath !== path) throw Error('RESTORE_PATH_MISMATCH'); }
          this.workspaces.set(epoch, workspace);
          return { status: 'completed', stopped: true, evidence: { workspace, baseRevision } };
        } }, persist: async evidence => ({ evidenceRef: await this.persist(n.id, this.options.repositoryPath, evidence), actualTokens: 0,
          result: { schemaVersion: 1, kind: 'workspace', workspaceLeaseRef, receiptRef: `e${epoch}.workspace` } }) };
    }
    if (name === 'implement' || name === 'repair') {
      this.result(`e${epoch}.workspace`); const workspace = this.workspace();
      const feedback = epoch ? this.options.db.prepare('SELECT bundle_json FROM graph_verification_joins WHERE receipt_ref=? AND graph_run_id=?').get(this.feedbackRef, r.graphRunId) as { bundle_json: string } | undefined : undefined;
      if (epoch && !feedback) throw Error('IMMUTABLE_FEEDBACK_REQUIRED');
      const action = epoch ? { kind: 'repair' as const, inputArtifactRef: this.options.request.inputArtifactRef, workspaceLeaseRef,
        candidateRevision: this.candidate(epoch - 1).candidateRevision, feedbackRef: this.feedbackRef! } : { kind: 'implement' as const, inputArtifactRef: this.options.request.inputArtifactRef, workspaceLeaseRef };
      const adapter = this.options.writer.adapter;
      const capability = adapter.capabilities().find(c => c.id === this.options.writer.capabilityId); if (!capability) throw Error('WRITER_CAPABILITY_REQUIRED');
      return { ...common, workspace, action, execution: { kind: 'adapter', adapter, capabilityId: capability.id, plan: {
        plan_id: `delivery-${r.graphRunId}-${epoch}`, agent_id: adapter.id, max_iterations: 1,
        task: { task_id: `delivery-${epoch}`, source: 'manual', capability: capability.kind, priority: 100,
          prompt: `${this.options.task}${feedback ? `\nRepair frozen candidate ${action.kind === 'repair' ? action.candidateRevision : ''}. Complete host quality feedback:\n${feedback.bundle_json}` : ''}` },
        stop_condition: { type: 'tests_pass' },
      } }, persist: async evidence => ({ evidenceRef: await this.persist(n.id, workspace.workspace_path, evidence),
        ...(evidence.status === 'completed' && evidence.stopped ? { result: { schemaVersion: 1 as const, kind: 'implementation_complete' as const, workspaceLeaseRef, receiptRef: `e${epoch}.implementation` } } : {}) }) };
    }
    if (name === 'freeze') {
      const implementation = this.latest(`e${epoch}.${epoch ? 'repair' : 'implement'}`);
      if (implementation?.outcome?.state !== 'confirmed' || implementation.outcome.result.kind !== 'implementation_complete') throw Error('IMPLEMENTATION_REQUIRED');
      const workspace = this.workspace(); const scope = await resolveRepositoryScope(workspace.workspace_path);
      const checkProducer = async () => { const evidence = await loadDeliveryReceipt(this.options.root, implementation.outcome!.evidenceRef,
        this.receiptBinding(implementation.effect.nodeId, workspace.workspace_path));
        if (evidence.stopped !== true || workerCanonical(evidence.candidate?.workspace) !== workerCanonical(workspace)) throw Error('PRODUCER_STOP_REQUIRED'); this.check(); };
      return { ...common, workspace, action: { kind: 'freeze', workspaceLeaseRef, receiptRef: implementation.outcome.result.receiptRef },
        execution: { kind: 'freeze', store: this.artifacts, input: { artifactId: `delivery-${r.graphRunId}-${epoch}`, scope: r.scope, runId: r.graphRunId,
          generation: r.generation, owner: r.leaseOwner!, workspaceLeaseRef, repoId: scope.repoId, commonDir: scope.commonDir, worktreePath: workspace.workspace_path,
          baseRevision: epoch ? this.candidate(epoch - 1).candidateRevision : this.compiled.spec.input.baseRevision,
          implementationReceiptRef: implementation.outcome.result.receiptRef, producerStopEvidenceRef: implementation.outcome.evidenceRef },
        authority: { verifyLease: async (_input, lease) => { this.check(); await (lease as ExecutionLease).assertActive!(); }, verifyImplementationReceipt: checkProducer, verifyProducersStopped: checkProducer } },
        persist: async evidence => { return { evidenceRef: await this.persist(n.id, workspace.workspace_path, evidence), actualTokens: 0, result: evidence.frozenCandidate! }; } };
    }
    if (name === 'prepare_review' || name === 'prepare_tests') return this.preparation(name === 'prepare_review' ? 'review' : 'tests', 1);
    const action = this.branches.get(n.id); if (!action) throw Error('PREPARATION_REQUIRED'); return action;
  }
  private request(action: GraphRegisteredAction) { const r = this.current(); return { schemaVersion: 1 as const, kind: 'worker_action' as const, requestId: `host:${randomUUID()}`,
    scope: r.scope, graphRunId: r.graphRunId, specHash: r.identity.specHash, generation: r.generation, epoch: this.epoch,
    nodeId: action.nodeId, effectSlot: action.effectSlot, action: action.action }; }
  private async dispatch(connection: object, value: WorkerActionRequest, options: { signal?: AbortSignal }): Promise<WorkerActionResponse> {
    if (this.stopping) throw Error('DELIVERY_STOPPING');
    this.check(); const request = WorkerActionRequest.parse(value); const r = this.current();
    if (request.epoch !== this.epoch || request.generation !== r.generation || request.graphRunId !== r.graphRunId || request.specHash !== r.identity.specHash || workerCanonical(request.scope) !== workerCanonical(r.scope)) throw Error('DELIVERY_IDENTITY_MISMATCH');
    const name = request.nodeId.replace(`e${this.epoch}.`, ''); const n = deliveryEpoch(this.compiled, this.epoch).node(name);
    if (request.effectSlot !== n.effectSlot) throw Error('DELIVERY_SLOT_MISMATCH');
    if (!this.installed.has(n.id)) this.installed.set(n.id, this.registration(name).then(action => { this.check(); this.broker.installActions(connection, [action]); }));
    await this.installed.get(n.id);
    let response = await this.broker.handle(connection, request, options);
    if (name !== 'review' && name !== 'tests') return response;
    // The host inspects the actual attested failure. The task never caches failed RETURN.
    while (response.kind === 'worker_action_response' && response.outcome.state === 'failed' && response.outcome.error.retryable) {
      const prior = this.latest(n.id)!;
      if (prior.effect.logicalAttempt >= n.maxLedgerAttempts) break;
      if (!prior.outcome?.evidenceRef.startsWith('graph-verification:')) break;
      const envelope = await loadGraphVerificationEvidence(join(this.options.root, 'verification'), prior.outcome!.evidenceRef, this.binding(), { effect: prior.effect, effectKey: prior.effectKey });
      if (!envelope.verificationFailure?.retrySafe) break;
      const snapshot = new GraphVerificationStore(this.options.db, () => {}).snapshot(this.fence());
      const cost = deliveryEpoch(this.compiled, this.epoch).nextCost[name];
      if (snapshot.budget.accountingBlocked || snapshot.budget.actionStarts + cost.actions > this.compiled.spec.limits.maxActionStarts
        || BigInt(snapshot.budget.chargedTokens) + BigInt(snapshot.budget.reservedTokens) + BigInt(cost.tokens) > BigInt(this.compiled.spec.limits.tokenReservationLimit)) break;
      const prep = await this.preparation(name, prior.effect.logicalAttempt + 1);
      this.broker.installActions(connection, [prep]);
      const prepared = await this.broker.handle(connection, this.request(prep), options);
      if (prepared.kind !== 'worker_action_response' || prepared.outcome.state !== 'confirmed') return response;
      response = await this.broker.retryAuthorized(connection, prior.effectKey, () => { this.check(); }, { ...options, replacement: this.branches.get(n.id)! });
      if (response.kind === 'worker_action_response') response = { ...response, requestId: request.requestId };
    }
    return response;
  }
  private async evaluate(): Promise<GraphVerificationDecision> {
    const p = deliveryEpoch(this.compiled, this.epoch);
    return new GraphVerificationJoinService(this.options.db, { binding: this.binding(), artifacts: this.artifacts, evidenceRoot: join(this.options.root, 'verification'),
      slots: p.slots, nextCost: p.nextCost, authorize: () => this.check() }).evaluate(this.fence());
  }
  private async takeover(handle: GraphRuntimeHandle, stopped: GraphRuntimeStop): Promise<void> {
    const r = this.current(); const key = {};
    const verify = () => { const observed = this.runtime.observedExit(handle.connection);
      if (!stopped.actionsSettled || stopped.worker.kind !== 'exited' || workerCanonical(observed) !== workerCanonical(stopped.worker)) throw Error('PHYSICAL_WORKER_STOP_REQUIRED');
      return stopped.worker;
    };
    this.runtime.reconciler.register(key, { binding: { scope: r.scope, graphRunId: r.graphRunId, identity: r.identity, generation: r.generation, owner: r.leaseOwner },
      authorize: () => this.check(), stopWorker: async () => stopped,
      verifyWorker: async () => { const exit = verify(); return { kind: 'stopped', graphRunId: exit.graphRunId, generation: exit.generation, owner: exit.owner, confirmedAt: exit.confirmedAt, evidenceRef: exit.evidenceRef }; },
      verifyQuiescence: async () => { verify(); const decision = await this.evaluate(); if (decision.snapshot.pendingAdmissions || decision.snapshot.unresolvedActions) throw Error('QUIESCENCE_REQUIRED');
        return { executorEvidenceRef: decision.publication!.record.receiptRef, workspaceEvidenceRef: this.candidate().artifactRefs[0]! }; },
      verifyOutcome: async () => { throw Error('NO_EFFECT_RECONCILIATION'); }, recheck: () => { this.check(); verify(); }, release: async () => {},
    });
    try { const takeover = await this.runtime.reconciler.reconcile(key, { kind: 'takeover', fence: this.fence(), receiptId: `delivery-takeover-${this.epoch}`, owner: `delivery-${r.generation + 1}`, leaseExpiresAt: this.leaseDeadline() }); this.owned = takeover.result.run; }
    finally { this.runtime.reconciler.unregister(key); }
  }
  private checkpointDigest(): string {
    const rows = this.options.db.prepare('SELECT namespace,checkpoint_id,checkpoint FROM graph_checkpoints WHERE graph_run_id=? ORDER BY namespace,checkpoint_id').all(this.current().graphRunId);
    const writes = this.options.db.prepare("SELECT namespace,checkpoint_id,task_id,channel,write_index,value FROM graph_checkpoint_writes WHERE graph_run_id=? ORDER BY namespace,checkpoint_id,task_id,write_index").all(this.current().graphRunId);
    if (!rows.length || !writes.some(row => (row as { channel: string }).channel === '__interrupt__')) throw Error('DURABLE_INTERRUPT_REQUIRED');
    return createHash('sha256').update(workerCanonical({ rows, writes })).digest('hex');
  }
  verifyResume(proof: GraphDeliveryInterrupt): void {
    if (!this.waiting || workerCanonical(proof) !== workerCanonical(this.waiting.proof) || this.stopping) throw Error('LIVE_QUIESCENCE_REQUIRED');
    this.waiting.verify();
  }
  resumeQuality(proof: GraphDeliveryInterrupt): void { this.verifyResume(proof); this.waiting!.resolve(); }
  /** Actual worker and broker signal chain. A drained Promise never clears holds. */
  async cancel(): Promise<void> {
    this.stopping = true; this.waiting?.reject(Error('DELIVERY_CANCELLED'));
    const handle = this.active;
    if (!handle) return;
    const stopped = await handle.stop('GRAPH_CANCEL_REQUESTED');
    if (!this.owned || stopped.worker.kind !== 'exited' || !stopped.actionsSettled) return;
    const r = this.current(); if (r.status !== 'cancel_pending') return;
    const verify = () => {
      this.assertOwned();
      if (workerCanonical(this.runtime.observedExit(handle.connection)) !== workerCanonical(stopped.worker)) throw Error('PHYSICAL_WORKER_STOP_REQUIRED');
      if (this.options.db.prepare("SELECT 1 FROM graph_actions WHERE graph_run_id=? AND state IN ('intent','running','unknown','cancel_pending')").get(r.graphRunId)
        || this.options.db.prepare('SELECT 1 FROM graph_action_admissions WHERE graph_run_id=? AND released_at IS NULL').get(r.graphRunId)) throw Error('QUIESCENCE_REQUIRED');
    };
    const key = {}; const exit = stopped.worker;
    this.runtime.reconciler.register(key, { binding: { scope: r.scope, graphRunId: r.graphRunId, identity: r.identity, generation: r.generation, owner: r.leaseOwner },
      authorize: () => { this.assertOwned(); const result: unknown = (this.options.authorizeCancel ?? this.options.authorize)();
        if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw Error('AUTHORITY_MUST_BE_SYNCHRONOUS'); } }, stopWorker: async () => stopped,
      verifyWorker: async () => { verify(); return { kind: 'stopped', graphRunId: r.graphRunId, generation: r.generation, owner: r.leaseOwner!, confirmedAt: exit.confirmedAt, evidenceRef: exit.evidenceRef }; },
      verifyQuiescence: async () => { verify(); return { executorEvidenceRef: exit.evidenceRef, workspaceEvidenceRef: exit.evidenceRef }; },
      verifyOutcome: async () => { throw Error('NO_EFFECT_RECONCILIATION'); }, recheck: verify, release: async () => {},
    });
    try { await this.runtime.reconciler.reconcile(key, { kind: 'project', status: 'cancelled', receiptId: `delivery-cancel-${r.generation}`, fence: this.fence() }); }
    finally { this.runtime.reconciler.unregister(key); }
  }
  async run(): Promise<{ route: GraphVerificationDecision['route']; candidate?: Candidate; feedbackRef?: string }> {
    if (this.started) throw Error('DELIVERY_ALREADY_STARTED'); this.started = true;
    this.check(); await mkdir(this.options.root, { recursive: true, mode: 0o700 }); this.check();
    if (this.options.root === this.options.repositoryPath || this.options.root.startsWith(`${this.options.repositoryPath}/`) || await realpath(this.options.root) !== this.options.root || await realpath(this.options.repositoryPath) !== this.options.repositoryPath) throw Error('CANONICAL_HOST_PATHS_REQUIRED');
    this.check();
    const modulePath = join(this.options.root, 'delivery.mjs'); await writeFile(modulePath, this.compiled.source, { flag: 'wx', mode: 0o600 }); this.check();
    const version = graphDeliveryVersion(this.compiled);
    this.runtime = new GraphRuntime({ db: this.options.db, broker: this.broker,
      checkpoints: new GraphCheckpointService({ runs: this.runs, checkpoints: new GraphCheckpointStore(this.options.db), bindings: new Map() }),
      programs: [{ id: 'code-delivery-v1', modulePath, digest: this.compiled.compiledProgramDigest }] });
    let resume: GraphWorkerResume | undefined;
    let lastStopped: GraphRuntimeStop | undefined;
    try {
      this.runValue = this.options.reservedRun ?? this.runtime.prepare(this.options.request, version);
      if (this.stopping || this.current().status === 'cancel_pending') return { route: { kind: 'stop', epoch: 0, reason: 'cancel_requested' } };
      this.runValue = this.runtime.claim(this.runValue, 'delivery-1', this.leaseDeadline()); this.owned = this.runValue;
      this.runs.project({ ...this.fence(), status: 'running' });
      new GraphDeliveryEpochStore(this.options.db).activate(this.fence(), 0, deliveryEpoch(this.compiled, 0).cost);
      for (;;) {
        await this.restoreWorkspaceMappings();
        const r = this.current(); this.installed.clear();
        const handle = this.runtime.start({ request: this.options.request, run: r, programId: 'code-delivery-v1', leaseDurationMs: 60000, ...(resume ? { resume } : {}),
          authorize: () => this.check(), registration: { scope: r.scope, graphRunId: r.graphRunId, identity: r.identity, generation: r.generation, owner: r.leaseOwner!, epoch: this.epoch,
            workspace: { workspace_id: r.scope.workspaceId, workspace_path: this.options.repositoryPath }, authorize: () => this.check(), actions: [] },
          dispatch: (key, request, options) => this.dispatch(key, request, options) });
        this.active = handle; this.connection = handle.connection;
        let workerError: unknown;
        try { await handle.result; } catch (error) { workerError = error; }
        const stopped = await handle.stop(); lastStopped = stopped;
        if (this.stopping || this.current().status === 'cancel_pending') return { route: { kind: 'reconcile', epoch: this.epoch, reason: 'cancel_requested' } };
        if (!stopped.actionsSettled || stopped.worker.kind !== 'exited') throw Error('PHYSICAL_WORKER_STOP_REQUIRED');
        // No heartbeat now. Extend only the live lease, then capture a fresh immutable premise.
        const current = this.current(); this.runs.renewLease({ ...this.fence(), leaseExpiresAt: Math.max(current.leaseExpiresAt!, this.leaseDeadline()) });
        if (!this.latest(`e${this.epoch}.freeze`)) throw workerError ?? Error('FREEZE_REQUIRED');
        const decision = await this.evaluate(); const candidate = this.candidate();
        if (decision.route.kind !== 'repair_required') {
          // Dispatch already exhausted or could not admit the explicit retry.
          // A sealed failure must never advertise a retry that cannot be resumed.
          const route = decision.route.kind === 'retry_required'
            ? { kind: 'stop' as const, epoch: this.epoch, reason: 'retry_dispatch_incomplete' } : decision.route;
          this.check();
          if (this.current().status !== 'cancel_pending') this.options.db.transaction(() => {
            this.runs.project({ ...this.fence(decision.snapshot.run), status: route.kind === 'ready' ? 'ready' : route.kind === 'reconcile' ? 'reconciliation_required' : 'failed' });
            if (decision.publication) this.options.publish?.(candidate, decision.publication.record.receiptRef);
          }).immediate();
          return { route, candidate, ...(decision.publication ? { feedbackRef: decision.publication.record.receiptRef } : {}) };
        }
        if (workerError || !decision.publication) throw workerError ?? Error('IMMUTABLE_JOIN_REQUIRED');
        this.check();
        this.feedbackRef = decision.publication.record.receiptRef;
        this.options.publish?.(candidate, this.feedbackRef);
        if (this.options.qualityInterrupt) {
          const proof: GraphDeliveryInterrupt = { interruptId: `quality:${r.graphRunId}:${this.epoch}:${r.generation}`, inputDigest: r.identity.inputDigest,
            kind: 'quality', checkpointDigest: this.checkpointDigest(), feedbackRef: this.feedbackRef };
          await new Promise<void>((resolve, reject) => {
            this.waiting = { proof, resolve, reject, verify: () => {
              this.check();
              if (this.checkpointDigest() !== proof.checkpointDigest || workerCanonical(this.runtime.observedExit(handle.connection)) !== workerCanonical(stopped.worker)
                || stopped.worker.kind !== 'exited' || !stopped.actionsSettled) throw Error('PHYSICAL_WORKER_STOP_REQUIRED');
              if (!this.options.db.prepare('SELECT 1 FROM graph_verification_joins WHERE graph_run_id=? AND receipt_ref=?').get(r.graphRunId, proof.feedbackRef)) throw Error('IMMUTABLE_JOIN_REQUIRED');
            } };
            this.options.qualityInterrupt!(proof);
          });
          this.waiting = undefined;
        }
        await this.takeover(handle, stopped);
        const next = this.epoch + 1;
        new GraphDeliveryEpochStore(this.options.db).activate(this.fence(), next, deliveryEpoch(this.compiled, next).cost, this.feedbackRef);
        resume = { kind: 'interrupt', value: { ...decision.route, feedbackRef: this.feedbackRef } };
        this.epoch = next;
      }
    } catch (error) {
      // An idempotent prepare may find another owner's run. Failed acquisition
      // grants no authority to project that run's status.
      if (!this.owned) throw error;
      const current = this.current();
      const held = this.options.db.prepare('SELECT 1 FROM graph_action_admissions WHERE graph_run_id=? AND released_at IS NULL').get(current.graphRunId);
      const unresolved = this.options.db.prepare("SELECT 1 FROM graph_actions WHERE graph_run_id=? AND state IN ('intent','running','unknown','cancel_pending')").get(current.graphRunId);
      const reconcile = !!held || !!unresolved || !lastStopped?.actionsSettled || lastStopped.worker.kind !== 'exited';
      try {
        this.check();
        if (!['ready','failed','cancelled','cancel_pending'].includes(current.status) && current.leaseExpiresAt! > Date.now()) {
          this.runs.project({ ...this.fence(current), status: reconcile ? 'reconciliation_required' : 'failed' });
        }
      } catch { /* Revoked/stale hosts cannot project replacement or cancellation state. */ }
      return { route: { kind: reconcile ? 'reconcile' : 'stop', epoch: this.epoch, reason: String(error).slice(0, 4096) } };
    } finally { this.closed = true; await this.runtime.close(); if (this.connection) this.broker.unregister(this.connection); }
  }
}

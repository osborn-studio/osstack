import { assertGraphPlatform } from './graph-platform.js';
import { randomUUID, createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { AgentAdapter } from '@osstack/agents';
import { z } from 'zod';
import { GraphRunStore, type GraphRun } from '@osstack/core';
import { readGraphActionState } from '@osstack/core/graph-verification';
import { DeliveryContractV2, GraphErrorCode, GraphStatusRequest, GraphDelegationStatus, GraphScope, GraphRequest, type StartGraphRequest, GraphSpec, computeGraphInputDigest, workerCanonical, GraphContractError } from '@osstack/protocol';
import { freezeDeliveryContract } from '@osstack/core';
import { compileGraphSpec } from '@osstack/graph/spec-compiler';
import { GraphDelivery, assertGraphDeliverySupported, graphDeliveryVersion, type GraphDeliveryOptions, type GraphDeliveryInterrupt } from './graph-delivery.js';
import { GraphReconciler } from './graph-reconciler.js';
import { cancelUnstartedGraphWorker } from './graph-unstarted-recovery.js';
import { cancelJournaledBoundedWriter } from './graph-bounded-recovery.js';
import { cancelUnstartedGraphPreparation } from './graph-preparation-recovery.js';
import { bindGraphDeliveryContract, graphContractInputRef, parseGraphContractRegistration, type GraphContractHostEnvelope, type GraphContractHostPolicy } from './graph-delivery-contract.js';
import { loadGraphContractCompletion } from './graph-contract-receipt.js';
import { snapshotGraphExecutionContext, type GraphExecutionContextRegistration } from './graph-execution-context.js';

export interface GraphHostRegistration {
  id: string;
  scope: GraphScope;
  product: StartGraphRequest['source']['product'];
  repositoryRef: string;
  taskRef: string;
  inputArtifactRef: string;
  delivery: Pick<GraphDeliveryOptions, 'repositoryPath' | 'task' | 'writer' | 'reviewer' | 'verifyReviewer' | 'acceptanceRegistry' | 'deliveryContract' | 'executionContext'>;
  /** Current scope-specific grant, called on reads, mutations and each effect. */
  authorize: (operation?: 'read' | 'execute' | 'cancel' | 'resume') => void;
  /** Synchronous admission switch. Only new reservations; existing work keeps its grants. */
  admitNewRuns?: () => boolean;
}
export interface GraphRpcOptions {
  db: Database.Database;
  root: string;
  registrations: readonly GraphHostRegistration[];
  /** Host-authenticated connection capability -> registration ID. Never receives request JSON. */
  resolveCaller: (connection: object) => string | null;
  acquire: GraphDeliveryOptions['acquire'];
  authorizePolicy?: GraphDeliveryOptions['authorizePolicy'];
}
interface Descriptor { registrationId: string; request: StartGraphRequest; root: string; launchOwner: string; contractEnvelope?: GraphContractHostEnvelope }
interface StoredResult {
  candidate?: { candidateRevision: string; artifactRefs: string[]; artifactDigest: string };
  evidenceRefs: string[]; resultRef?: string;
}
interface PublicRow { descriptor_json: string; result_json: string | null; interrupt_json: string | null }
const fence = (r: GraphRun) => ({ scope: r.scope, graphRunId: r.graphRunId, identity: r.identity,
  expectedGeneration: r.generation, expectedOwner: r.leaseOwner, expectedRevision: r.revision, now: Date.now() });
const same = (a: unknown, b: unknown) => workerCanonical(a) === workerCanonical(b);
function synchronous(value: unknown): void {
  if (value !== undefined) { void Promise.resolve(value).catch(() => {}); throw new GraphContractError('POLICY_DENIED'); }
}

/** Stable public errors never disclose host paths, commands, or raw adapter text. */
export function graphRpcError(error: unknown): { code: string; message: string } {
  const raw = error instanceof Error ? error.message : '';
  const supplied = error && typeof error === 'object' && 'code' in error ? String(error.code) : raw;
  const aliases: Record<string, string> = { ENOENT: 'UNAUTHENTICATED', EACCES: 'UNAUTHENTICATED', ELOOP: 'UNAUTHENTICATED',
    RUN_NOT_FOUND: 'RUN_MISMATCH', OWNER_MISMATCH: 'STALE_GENERATION', LEASE_EXPIRED: 'GRANT_EXPIRED',
    LIVE_QUIESCENCE_REQUIRED: 'ACTION_OUTCOME_UNKNOWN', PHYSICAL_WORKER_STOP_REQUIRED: 'ACTION_OUTCOME_UNKNOWN',
    PROGRAM_IDENTITY_MISMATCH: 'CHECKPOINT_INCOMPATIBLE', TERMINAL_RUN: 'REVISION_CONFLICT', CANCEL_PENDING: 'CANCEL_UNCONFIRMED' };
  const parsed = GraphErrorCode.safeParse(aliases[supplied] ?? (supplied.startsWith('GRAPH_CONTRACT_') || supplied.startsWith('GRAPH_CONTEXT_') || supplied.startsWith('delivery_') ? 'POLICY_DENIED' : supplied));
  const code = error instanceof z.ZodError ? 'INPUT_CONTRACT_INVALID' : parsed.success ? parsed.data : 'INTERNAL_ERROR';
  return { code, message: code };
}

/** Public durable admission. Process maps hold actual supervisors, never public state. */
export class GraphRpcService {
  private readonly runs: GraphRunStore;
  private readonly registrations = new Map<string, GraphHostRegistration>();
  private readonly live = new Map<string, { driver?: GraphDelivery; done: Promise<void> }>();
  private readonly pendingRequests = new Set<Promise<unknown>>();
  private readonly owner = randomUUID();
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly options: GraphRpcOptions;
  constructor(options: GraphRpcOptions) {
    assertGraphPlatform();
    this.options = Object.freeze({ ...options, resolveCaller: options.resolveCaller, acquire: options.acquire });
    const snapshotAdapter = (a: AgentAdapter): AgentAdapter => {
      const capabilities = structuredClone(a.capabilities());
      return Object.freeze({ id: a.id, display_name: a.display_name, cost_tier: a.cost_tier,
        capabilities: () => structuredClone(capabilities), isAvailable: a.isAvailable.bind(a), invoke: a.invoke.bind(a),
        ...(a.confirmStopped ? { confirmStopped: a.confirmStopped.bind(a) } : {}) });
    };
    this.runs = new GraphRunStore(options.db);
    for (const value of options.registrations) {
      if (this.registrations.has(value.id)) throw Error('DUPLICATE_GRAPH_REGISTRATION');
      if (value.delivery.executionContext && !value.delivery.deliveryContract) throw Error('GRAPH_CONTEXT_CONTRACT_REQUIRED');
      this.registrations.set(value.id, { ...value, scope: GraphScope.parse(value.scope), delivery: { ...value.delivery,
        ...(value.delivery.deliveryContract ? { deliveryContract: parseGraphContractRegistration(value.delivery.deliveryContract) } : {}),
        ...(value.delivery.executionContext ? { executionContext: snapshotGraphExecutionContext(value.delivery.executionContext) } : {}),
        writer: { ...value.delivery.writer, adapter: snapshotAdapter(value.delivery.writer.adapter) }, reviewer: { ...value.delivery.reviewer, adapter: snapshotAdapter(value.delivery.reviewer.adapter) }, acceptanceRegistry: structuredClone(value.delivery.acceptanceRegistry) } });
    }
  }
  private caller(connection: object): GraphHostRegistration {
    if (this.closed) throw Error('GRAPH_SERVICE_CLOSED');
    const id = this.options.resolveCaller(connection);
    const registration = id === null ? undefined : this.registrations.get(id);
    if (!registration) throw new GraphContractError('UNAUTHENTICATED');
    return registration;
  }
  private row(id: string): PublicRow {
    const row = this.options.db.prepare('SELECT * FROM graph_public_delivery WHERE graph_run_id=?').get(id) as PublicRow | undefined;
    if (!row) throw new GraphContractError('RUN_MISMATCH');
    return row;
  }
  private bound(registration: GraphHostRegistration, scope: GraphScope, id: string): GraphRun {
    if (!same(scope, registration.scope)) throw new GraphContractError('SCOPE_MISMATCH');
    const run = this.runs.get(scope, id);
    if (!run || run.source.product !== registration.product) throw new GraphContractError('RUN_MISMATCH');
    const descriptor = JSON.parse(this.row(id).descriptor_json) as Descriptor;
    if (descriptor.registrationId !== registration.id) throw new GraphContractError('RUN_MISMATCH');
    if (descriptor.contractEnvelope && (graphContractInputRef(descriptor.contractEnvelope) !== descriptor.request.inputArtifactRef
      || computeGraphInputDigest(descriptor.request) !== run.identity.inputDigest)) throw new GraphContractError('CHECKPOINT_INCOMPATIBLE');
    return run;
  }
  private status(run: GraphRun, registration: GraphHostRegistration) {
    const row = this.row(run.graphRunId);
    const descriptor = JSON.parse(row.descriptor_json) as Descriptor;
    const contract = descriptor.contractEnvelope;
    if (contract && computeGraphInputDigest(descriptor.request) !== run.identity.inputDigest) throw new GraphContractError('CHECKPOINT_INCOMPATIBLE');
    const result = row.result_json ? JSON.parse(row.result_json) as StoredResult : { evidenceRefs: [] };
    const interrupt = row.interrupt_json ? JSON.parse(row.interrupt_json) as GraphDeliveryInterrupt : undefined;
    const { actions, budget } = readGraphActionState(this.options.db, run.graphRunId);
    const uncertain = ['cancel_pending', 'reconciliation_required'].includes(run.status);
    let needsAuthorization = false;
    try { synchronous(registration.authorize('execute')); } catch { needsAuthorization = true; }
    return GraphDelegationStatus.parse({ schemaVersion: 1 as const, scope: run.scope, graphRunId: run.graphRunId, source: run.source, status: run.status,
      revision: run.revision, generation: run.generation, inputDigest: run.identity.inputDigest, specHash: run.identity.specHash,
      ...(contract ? { admissionBinding: { requestInputDigest: computeGraphInputDigest({ ...descriptor.request, inputArtifactRef: contract.sourceInputArtifactRef }),
        hostInputDigest: run.identity.inputDigest, contractDigest: contract.frozen.digest, policyDigest: contract.policy.policyDigest } } : {}),
      createdAt: run.createdAt, updatedAt: run.updatedAt, publication: 'artifact_only' as const,
      phase: actions.find(a => a.state === 'running')?.effect.nodeId ?? run.status,
      budget: { limits: run.spec!.limits, ...budget },
      delivery: uncertain ? 'delivery_unknown' as const : run.status === 'ready' ? 'available' as const : 'pending' as const,
      ...result,
      ...(needsAuthorization ? { authorization: { kind: 'needs_authorization' as const, scope: run.scope, requestRef: `graph-grant:${run.graphRunId}` } } : {}),
      ...(interrupt && run.status === 'waiting_input' ? { interrupt: { interruptId: interrupt.interruptId, inputDigest: interrupt.inputDigest, kind: interrupt.kind } } : {}),
      ...(run.status === 'failed' ? { error: { schemaVersion: 1 as const, code: 'INTERNAL_ERROR' as const, message: 'Graph delivery stopped before verified publication', retryable: false as const, nextAction: 'stop' as const } } : {}),
      ...(uncertain ? { error: { schemaVersion: 1 as const, code: run.status === 'cancel_pending' ? 'CANCEL_UNCONFIRMED' as const : 'ACTION_OUTCOME_UNKNOWN' as const,
        message: 'Physical execution requires reconciliation', retryable: false as const, nextAction: 'reconcile' as const } } : {}),
    });
  }
  private replay(request: Exclude<GraphRequest, StartGraphRequest>): boolean {
    const row = this.options.db.prepare('SELECT graph_run_id,input_digest FROM graph_requests WHERE scope_json=? AND idempotency_key=?')
      .get(workerCanonical(request.scope), request.idempotencyKey) as { graph_run_id: string; input_digest: string } | undefined;
    if (!row) return false;
    if (row.graph_run_id !== request.graphRunId || row.input_digest !== computeGraphInputDigest(request)) throw new GraphContractError('IDEMPOTENCY_CONFLICT');
    return true;
  }
  async handle(connection: object, method: string, params: unknown): Promise<unknown> {
    const pending = this.handleRequest(connection, method, params);
    this.pendingRequests.add(pending);
    try { return await pending; }
    catch (error) { throw new GraphContractError(GraphErrorCode.parse(graphRpcError(error).code)); }
    finally { this.pendingRequests.delete(pending); }
  }
  private async handleRequest(connection: object, method: string, params: unknown): Promise<unknown> {
    const registration = this.caller(connection);
    if (method === 'graph.contract') {
      synchronous(registration.authorize('read'));
      const request = GraphStatusRequest.parse(params); const run = this.bound(registration, request.scope, request.graphRunId);
      const row = this.row(run.graphRunId); const descriptor = JSON.parse(row.descriptor_json) as Descriptor;
      const result = row.result_json ? JSON.parse(row.result_json) as StoredResult : undefined;
      const refs = result?.evidenceRefs.filter(ref => ref.startsWith('graph-contract:')) ?? [];
      if (!descriptor.contractEnvelope || !result?.candidate || !result.resultRef || refs.length !== 1) throw Error('GRAPH_CONTRACT_RECEIPT_UNPUBLISHED');
      const receipt = await loadGraphContractCompletion(descriptor.root, refs[0]!, { run, envelope: descriptor.contractEnvelope,
        joinRef: result.resultRef, candidateRevision: result.candidate.candidateRevision, artifactDigest: result.candidate.artifactDigest });
      synchronous(registration.authorize('read'));
      if (this.closed || workerCanonical(this.bound(registration, request.scope, request.graphRunId)) !== workerCanonical(run)) throw Error('GRAPH_CONTRACT_SNAPSHOT_CHANGED');
      return receipt;
    }
    if (method === 'graph.status' || method === 'graph.result') {
      synchronous(registration.authorize('read'));
      const request = GraphStatusRequest.parse(params);
      return this.status(this.bound(registration, request.scope, request.graphRunId), registration);
    }
    if (method === 'graph.validate') return compileGraphSpec(GraphSpec.parse(params));
    const request = GraphRequest.parse(params);
    if (!same(request.scope, registration.scope)) throw new GraphContractError('SCOPE_MISMATCH');
    if ((method === 'graph.start' || method === 'graph.submit') && request.kind === 'start') return this.submit(registration, request);
    const reconcile = method === 'graph.reconcile';
    if ((!['graph.cancel', 'graph.reconcile'].includes(method) || request.kind !== 'cancel') && (method !== 'graph.resume' || request.kind !== 'resume')) throw new GraphContractError('INPUT_CONTRACT_INVALID');
    synchronous(registration.authorize(request.kind === 'cancel' ? 'cancel' : 'resume'));
    const run = this.bound(registration, request.scope, request.graphRunId);
    const replay = this.replay(request);
    // Only the unchanged cancellation intent can be retried as reconciliation.
    // Later revisions/generations are a lookup, never authority to stop a new owner.
    if (replay && !(reconcile && run.status === 'cancel_pending' && run.revision === request.expectedRevision + 1)) return this.status(run, registration);
    if (!replay && run.revision !== request.expectedRevision) throw new GraphContractError('REVISION_CONFLICT');
    if (request.kind === 'cancel') {
      const pending = replay ? run : this.runs.projectRequest(request, { ...fence(run), status: 'cancel_pending' });
      const entry = this.live.get(run.graphRunId);
      if (entry?.driver) void entry.driver.cancel().catch(() => {});
      else if (run.generation === 0) this.runs.project({ ...fence(pending), status: 'cancelled' });
      if (reconcile && run.generation > 0) {
        const receiptId = `public-cancel:${createHash('sha256').update(workerCanonical({ scope: request.scope,
          idempotencyKey: request.idempotencyKey, digest: computeGraphInputDigest(request) })).digest('hex')}`;
        let authorizationFailed = false;
        try {
          await cancelUnstartedGraphWorker(this.options.db, new GraphReconciler(this.options.db), { fence: fence(pending), receiptId },
            () => {
              try { synchronous(registration.authorize('cancel')); }
              catch (error) { authorizationFailed = true; throw error; }
            });
        } catch (error) {
          if (authorizationFailed) throw error;
          synchronous(registration.authorize('cancel'));
          // A finite bounded writer may have durable stopped/output evidence even
          // when the ledger ACK was lost. Recovery never dispatches it again.
          try {
            const descriptor = JSON.parse(this.row(run.graphRunId).descriptor_json) as Descriptor;
            await cancelJournaledBoundedWriter(this.options.db, descriptor.root, registration.delivery.repositoryPath,
              { fence: fence(pending), receiptId }, () => {
                try { synchronous(registration.authorize('cancel')); }
                catch (failure) { authorizationFailed = true; throw failure; }
              });
          } catch (failure) {
            if (authorizationFailed) throw failure;
            try {
              const descriptor = JSON.parse(this.row(run.graphRunId).descriptor_json) as Descriptor;
              await cancelUnstartedGraphPreparation(this.options.db, descriptor.root, registration.delivery.repositoryPath,
                { fence: fence(pending), receiptId }, () => {
                  try { synchronous(registration.authorize('cancel')); }
                  catch (denied) { authorizationFailed = true; throw denied; }
                });
            } catch (denied) {
              if (authorizationFailed) throw denied;
              // Operator diagnostics remain local. Never print raw filesystem,
              // adapter or SQLite error text into either RPC or daemon logs.
              const reasons = new Set(['SCOPE', 'PROGRAM', 'PREDECESSORS', 'NOT_STARTED', 'CANDIDATE',
                'NOT_CANCELLING', 'CHANGED', 'ADMISSION', 'WORKSPACE', 'LOCK_PRESENT', 'DECISION']);
              const reason = denied instanceof Error ? denied.message.replace(/^PREPARATION_RECOVERY_/, '') : '';
              console.error(JSON.stringify({ event: 'graph_recovery_blocked', graphRunId: run.graphRunId,
                stage: 'unstarted_preparation', code: reasons.has(reason) ? `PREPARATION_RECOVERY_${reason}` : graphRpcError(denied).code }));
            }
          }
          // Intent is already durable. Missing/conflicting evidence cannot undo
          // its acknowledgement; return current state without settling or releasing.
        }
        // Successful G15 commit rechecked the grant in its final transaction.
        // Later expiry cannot turn that completed operation into a rejected request.
      }
      return this.status(this.runs.get(run.scope, run.graphRunId)!, registration);
    }
    const row = this.row(run.graphRunId);
    const proof = row.interrupt_json ? JSON.parse(row.interrupt_json) as GraphDeliveryInterrupt : undefined;
    if (run.status !== 'waiting_input' || !proof || proof.interruptId !== request.interruptId) throw new GraphContractError('REVISION_CONFLICT');
    if (request.input.kind !== 'data' || !same(request.input.value, { inputDigest: run.identity.inputDigest }) || proof.inputDigest !== run.identity.inputDigest) throw new GraphContractError('INPUT_CONTRACT_INVALID');
    const driver = this.live.get(run.graphRunId)?.driver;
    if (!driver) throw new GraphContractError('ACTION_OUTCOME_UNKNOWN');
    if (run.leaseExpiresAt === null || run.leaseExpiresAt <= Date.now() || Date.now() >= run.createdAt + run.spec!.limits.deadlineSeconds * 1000) throw new GraphContractError('GRANT_EXPIRED');
    driver.verifyResume(proof);
    this.runs.projectRequest(request, { ...fence(run), status: 'running' });
    driver.resumeQuality(proof);
    return this.status(this.runs.get(run.scope, run.graphRunId)!, registration);
  }
  private submit(registration: GraphHostRegistration, request: StartGraphRequest) {
    if (request.source.product !== registration.product) throw new GraphContractError('UNAUTHENTICATED');
    const input = request.spec.input;
    if (input.repositoryRef !== registration.repositoryRef || input.taskRef !== registration.taskRef || request.inputArtifactRef !== registration.inputArtifactRef
      || !registration.delivery.acceptanceRegistry.some(a => a.ref === input.acceptanceRef)) throw new GraphContractError('POLICY_DENIED');
    const boundContract = registration.delivery.deliveryContract ? bindGraphDeliveryContract(request,
      { ...registration.delivery, deliveryContract: registration.delivery.deliveryContract }) : undefined;
    request = boundContract?.request ?? request;
    const compiled = compileGraphSpec(request.spec);
    let created = false;
    const run = this.options.db.transaction(() => {
      synchronous(registration.authorize());
      const prior = this.options.db.prepare('SELECT graph_run_id FROM graph_requests WHERE scope_json=? AND idempotency_key=?')
        .get(workerCanonical(request.scope), request.idempotencyKey) as { graph_run_id: string } | undefined;
      if (!prior) {
        if (registration.admitNewRuns) {
          const admitted: unknown = registration.admitNewRuns();
          if (admitted !== true) {
            void Promise.resolve(admitted).catch(() => {});
            throw new GraphContractError('GRAPH_ADMISSION_DISABLED');
          }
        }
        assertGraphDeliverySupported(registration.delivery);
      }
      const run = this.runs.create(request, graphDeliveryVersion(compiled), Date.now());
      if (prior && !this.options.db.prepare('SELECT 1 FROM graph_public_delivery WHERE graph_run_id=?').get(run.graphRunId)) throw new GraphContractError('CHECKPOINT_INCOMPATIBLE');
      const descriptor: Descriptor = { registrationId: registration.id, request, root: join(this.options.root, run.graphRunId), launchOwner: this.owner,
        ...(boundContract ? { contractEnvelope: boundContract.envelope } : {}) };
      created = this.options.db.prepare('INSERT OR IGNORE INTO graph_public_delivery(graph_run_id,descriptor_json) VALUES (?,?)').run(run.graphRunId, JSON.stringify(descriptor)).changes === 1;
      return this.bound(registration, run.scope, run.graphRunId);
    }).immediate();
    if (created) {
      // Only the durable reservation winner schedules; even construction is deferred.
      const entry: { driver?: GraphDelivery; done: Promise<void> } = { done: Promise.resolve() };
      this.live.set(run.graphRunId, entry);
      entry.done = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
        if (this.closed || this.runs.get(run.scope, run.graphRunId)!.status === 'cancelled') return;
        try {
          const descriptor = JSON.parse(this.row(run.graphRunId).descriptor_json) as Descriptor;
          if (descriptor.launchOwner !== this.owner) throw Error('LAUNCH_OWNER_MISMATCH');
          entry.driver = new GraphDelivery({ ...registration.delivery, db: this.options.db, root: descriptor.root, request: descriptor.request, reservedRun: run,
            ...(descriptor.contractEnvelope ? { contractEnvelope: descriptor.contractEnvelope } : {}),
            acquire: this.options.acquire, ...(this.options.authorizePolicy ? { authorizePolicy: this.options.authorizePolicy } : {}), authorize: () => { synchronous(registration.authorize()); },
            authorizeCancel: () => { synchronous(registration.authorize('cancel')); },
            publish: (candidate, feedbackRef, contractReceiptRef) => {
              const { candidateRevision, artifactRefs, artifactDigest } = candidate;
              const output: StoredResult = { candidate: { candidateRevision, artifactRefs, artifactDigest }, evidenceRefs: [feedbackRef, ...(contractReceiptRef ? [contractReceiptRef] : [])], resultRef: feedbackRef };
              this.options.db.prepare('UPDATE graph_public_delivery SET result_json=? WHERE graph_run_id=?').run(JSON.stringify(output), run.graphRunId);
            },
            qualityInterrupt: proof => {
              const current = this.runs.get(run.scope, run.graphRunId)!;
              this.options.db.transaction(() => {
                synchronous(registration.authorize());
                this.options.db.prepare('UPDATE graph_public_delivery SET interrupt_json=? WHERE graph_run_id=?').run(JSON.stringify(proof), run.graphRunId);
                this.runs.project({ ...fence(current), status: 'waiting_input' });
              }).immediate();
            } });
          await entry.driver.run();
          const stopped = this.runs.get(run.scope, run.graphRunId)!;
          if (stopped.generation === 0 && stopped.status === 'cancel_pending') this.runs.project({ ...fence(stopped), status: 'cancelled' });
        } catch {
          const current = this.runs.get(run.scope, run.graphRunId)!;
          // Before a worker exists, failure has no ambiguous external effects.
          if (current.generation === 0 && current.status === 'queued') this.runs.project({ ...fence(current), status: 'failed' });
        }
      });
    }
    return this.status(run, registration);
  }
  close(): Promise<void> {
    this.closed = true;
    this.closing ??= this.drain();
    return this.closing;
  }
  private async drain(): Promise<void> {
    const draining = [...this.live.entries()].map(async ([id, entry]) => {
      try {
        const descriptor = JSON.parse(this.row(id).descriptor_json) as Descriptor;
        const run = this.runs.get(descriptor.request.scope, id)!;
        if (!['ready', 'failed', 'cancelled', 'cancel_pending'].includes(run.status)) this.runs.project({ ...fence(run), status: 'cancel_pending' });
        if (run.generation === 0) {
          const current = this.runs.get(run.scope, id)!;
          if (current.status === 'cancel_pending') this.runs.project({ ...fence(current), status: 'cancelled' });
        }
        await entry.driver?.cancel();
      } finally {
        // run() may still be preparing the module, and a bounded worker stop
        // may leave action persistence/release pending. Neither is DB quiescence.
        try { await entry.done; } finally { await entry.driver?.drainDatabaseUsers(); }
      }
    });
    // A deadline cannot prove database users are gone. Forced process recovery
    // keeps its existing durable uncertainty; graceful shutdown waits for I/O.
    await Promise.allSettled([...draining, ...this.pendingRequests]);
  }
}

// Explicit local owner trust: owner-only config plus a private Unix socket, never
// a scope/principal taken from RPC JSON. Remote identities require resolveCaller.
const ref = z.string().min(1).max(256);
const hostConfig = z.object({ schemaVersion: z.literal(1), admissionEnabled: z.boolean().optional(), registration: z.object({ id: ref, scope: GraphScope,
  repositoryRef: ref, repositoryPath: z.string().min(1), taskRef: ref, task: z.string().min(1).max(65536), inputArtifactRef: ref,
  deliveryContract: DeliveryContractV2.optional(),
  executionContextPath: z.string().min(1).max(4096).optional(),
  writer: z.object({ agentId: ref, capabilityId: ref }).strict(), reviewer: z.object({ agentId: ref, capabilityId: ref }).strict(),
  boundedMessages: z.object({ provider: z.enum(['anthropic', 'deepseek']).optional(), baseUrl: z.string().min(1).max(2048).optional(),
    model: ref, files: z.array(ref).min(1).max(16), acceptance: z.string().min(1).max(16000) }).strict().optional(),
  acceptanceRegistry: z.array(z.object({ ref, command: z.string().min(1), passExitCodes: z.array(z.number().int()), failExitCodes: z.array(z.number().int()) }).strict()).min(1),
  grant: z.object({ scope: GraphScope, expiresAt: z.number().int().positive(), operations: z.array(z.enum(['read', 'execute', 'cancel', 'resume'])).min(1) }).strict(),
}).strict() }).strict();
function trustedConfig(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 131072 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw Error('GRAPH_CONFIG_OWNER_REQUIRED');
    const bytes = Buffer.alloc(131073); let offset = 0;
    for (;;) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count;
      if (offset === bytes.length) throw Error('GRAPH_CONFIG_LIMIT'); }
    return hostConfig.parse(JSON.parse(bytes.subarray(0, offset).toString('utf8')));
  } finally { closeSync(fd); }
}
export interface LocalGraphRegistrationOptions {
  resolveDeliveryContractPolicy?: (input: { repositoryPath: string; scope: GraphScope; contract: DeliveryContractV2 }) => Promise<{
    policy: GraphContractHostPolicy;
    /** Synchronous live policy binding; not an async best-effort recheck. */
    assertCurrent: () => void;
  }>;
  resolveExecutionContext?: (input: { configPath: string; repositoryPath: string; scope: GraphScope;
    frozen: NonNullable<GraphDeliveryOptions['deliveryContract']>['frozen'] }) => Promise<GraphExecutionContextRegistration>;
}
export async function loadLocalGraphRegistration(path: string, adapters: ReadonlyMap<string, AgentAdapter>, options: LocalGraphRegistrationOptions = {}): Promise<GraphHostRegistration> {
  const config = trustedConfig(path).registration;
  const bindingDigest = (value: typeof config) => { const { grant: _grant, ...binding } = value; return createHash('sha256').update(workerCanonical(binding)).digest('hex'); };
  const digest = bindingDigest(config);
  let policyAuthority: (() => void) | undefined;
  let executionContext: GraphExecutionContextRegistration | undefined;
  const authorize = (operation: 'read' | 'execute' | 'cancel' | 'resume' = 'execute') => {
    const fresh = trustedConfig(path).registration;
    if (bindingDigest(fresh) !== digest || !same(fresh.grant.scope, config.scope)
      || !fresh.grant.operations.includes(operation) || ((operation === 'execute' || operation === 'resume') && fresh.grant.expiresAt <= Date.now()))
      throw new GraphContractError('GRANT_EXPIRED');
    if (operation === 'execute' || operation === 'resume') synchronous(policyAuthority?.());
    if (operation === 'execute' || operation === 'resume') synchronous(executionContext?.assertCurrent());
  };
  authorize('read');
  let deliveryContract: GraphDeliveryOptions['deliveryContract'];
  if (config.deliveryContract) {
    if (!options.resolveDeliveryContractPolicy) throw Error('GRAPH_CONTRACT_POLICY_REQUIRED');
    const resolved = await options.resolveDeliveryContractPolicy({ repositoryPath: config.repositoryPath, scope: config.scope, contract: config.deliveryContract });
    if (typeof resolved.assertCurrent !== 'function') throw Error('GRAPH_CONTRACT_POLICY_REQUIRED');
    policyAuthority = resolved.assertCurrent;
    deliveryContract = parseGraphContractRegistration({ frozen: freezeDeliveryContract(config.deliveryContract), policy: resolved.policy });
    authorize('execute');
  }
  if (config.executionContextPath) {
    if (!deliveryContract || !options.resolveExecutionContext) throw Error('GRAPH_CONTEXT_REGISTRATION_REQUIRED');
    if (config.scope.tenantId !== 'default') throw Error('GRAPH_CONTEXT_SCOPE_UNSUPPORTED');
    executionContext = snapshotGraphExecutionContext(await options.resolveExecutionContext({ configPath: config.executionContextPath,
      repositoryPath: config.repositoryPath, scope: config.scope, frozen: deliveryContract.frozen }));
    authorize('execute');
  }
  let writer = adapters.get(config.writer.agentId); let reviewer = adapters.get(config.reviewer.agentId);
  if (config.boundedMessages) {
    const provider = config.boundedMessages.provider ?? 'anthropic';
    if (config.writer.agentId !== `${provider}-bounded-writer` || config.writer.capabilityId !== `${provider}-bounded-writer.writer`
      || config.reviewer.agentId !== `${provider}-bounded-reviewer` || config.reviewer.capabilityId !== `${provider}-bounded-reviewer.reviewer`) throw Error('GRAPH_BOUNDED_IDENTITIES_REQUIRED');
    const { createBoundedMessagesAdapter } = await import('@osstack/agents');
    const apiKey = process.env[provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'ANTHROPIC_API_KEY'];
    const { model, files, acceptance, baseUrl } = config.boundedMessages;
    const common = { provider, model, files, acceptance, ...(baseUrl === undefined ? {} : { baseUrl }), ...(apiKey ? { apiKey } : {}),
      authorize: () => authorize('execute') };
    writer = await createBoundedMessagesAdapter({ ...common, role: 'writer' });
    reviewer = await createBoundedMessagesAdapter({ ...common, role: 'reviewer' });
    authorize('read');
  }
  if (!writer || !reviewer || writer.id === reviewer.id) throw Error('GRAPH_REGISTERED_AGENTS_REQUIRED');
  const writerId = writer.id; const reviewerId = reviewer.id;
  return { id: config.id, scope: config.scope, product: 'osstack', repositoryRef: config.repositoryRef, taskRef: config.taskRef, inputArtifactRef: config.inputArtifactRef,
    authorize, admitNewRuns: () => trustedConfig(path).admissionEnabled !== false, delivery: { repositoryPath: config.repositoryPath, task: config.task,
      ...(deliveryContract ? { deliveryContract } : {}),
      ...(executionContext ? { executionContext } : {}),
      writer: { identity: writer.id, adapter: writer, capabilityId: config.writer.capabilityId },
      reviewer: { identity: reviewer.id, adapter: reviewer, capabilityId: config.reviewer.capabilityId },
      verifyReviewer: async proof => { authorize('read'); if (proof.writerIdentity !== writerId || proof.reviewerIdentity !== reviewerId || writerId === reviewerId) throw Error('INDEPENDENT_REVIEWER_REQUIRED'); },
      acceptanceRegistry: config.acceptanceRegistry } };
}

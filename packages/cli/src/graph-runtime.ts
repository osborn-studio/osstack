import type { WorkerActionRequest, WorkerActionResponse } from '@osstack/protocol';
import type Database from 'better-sqlite3';
import { GraphRunStore, type GraphRun, type GraphProgramVersion } from '@osstack/core';
import { workerCanonical, freezeWorkerData, type StartGraphRequest, type GraphWorkerResume, type GraphWorkerBinding } from '@osstack/protocol';
import type { GraphActionBroker, GraphWorkerRegistration } from './graph-action-broker.js';
import type { GraphCheckpointService } from './graph-checkpoint-service.js';
import { GraphProcessJournal, type GraphWorkerProcessReport } from './graph-process-journal.js';
import { GraphReconciler } from './graph-reconciler.js';
import { GraphWorkerManager, type GraphWorkerManagerOptions, type GraphWorkerHandle, type GraphWorkerExitEvidence } from './graph-worker-manager.js';

export interface GraphRuntimeOptions {
  db: Database.Database;
  broker: GraphActionBroker;
  checkpoints: GraphCheckpointService;
  programs: GraphWorkerManagerOptions['programs'];
  workerOptions?: Omit<GraphWorkerManagerOptions, 'programs'>;
  drainTimeoutMs?: number;
}
export type GraphRuntimeConfiguration = Pick<GraphRuntimeOptions, 'programs' | 'workerOptions' | 'drainTimeoutMs'>;
export interface GraphRuntimeStart {
  request: StartGraphRequest;
  run: GraphRun;
  programId: string;
  registration: GraphWorkerRegistration;
  authorize: () => void;
  resume?: GraphWorkerResume;
  /** Trusted host compilation/lifecycle port; never selected by worker data. */
  dispatch?: (connection: object, request: WorkerActionRequest, options: { signal?: AbortSignal }) => Promise<WorkerActionResponse>;
  /** Optional live renewal only; never acquires a replacement generation. */
  leaseDurationMs?: number;
}
export interface GraphRuntimeStop {
  worker: GraphWorkerExitEvidence;
  /** Promise drainage only. Unknown physical outcomes still need independent proof. */
  actionsSettled: boolean;
}
export type GraphRuntimeHandle = Omit<GraphWorkerHandle, 'stop'> & { stop(reason?: string): Promise<GraphRuntimeStop> };
type Connection = { handle: GraphWorkerHandle; pending: Set<Promise<unknown>>; retired: boolean; exit?: GraphWorkerExitEvidence };
function synchronous(value: unknown): void {
  if (value !== undefined) {
    void Promise.resolve(value).catch(() => {});
    throw new Error('GRAPH_AUTHORITY_MUST_BE_SYNC');
  }
}
const fence = (run: GraphRun) => ({ scope: run.scope, graphRunId: run.graphRunId, identity: run.identity,
  expectedGeneration: run.generation, expectedRevision: run.revision, expectedOwner: run.leaseOwner, now: Date.now() });

/** Explicit trusted in-process experimental assembly. No SDK import or public admission.
 * Checkpoints schedule tasks, the broker owns effects, G15 alone authorizes recovery. */
export class GraphRuntime {
  readonly reconciler: GraphReconciler;
  private readonly runs: GraphRunStore;
  private readonly workers: GraphWorkerManager;
  private readonly processJournal: GraphProcessJournal;
  private readonly connections = new Map<object, Connection>();
  private readonly drainTimeoutMs: number;
  private closed = false;
  constructor(private readonly options: GraphRuntimeOptions) {
    this.drainTimeoutMs = options.drainTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(this.drainTimeoutMs) || this.drainTimeoutMs < 1 || this.drainTimeoutMs > 60000) throw new Error('GRAPH_DRAIN_LIMIT');
    this.runs = new GraphRunStore(options.db);
    this.processJournal = new GraphProcessJournal(options.db);
    this.reconciler = new GraphReconciler(options.db);
    this.workers = new GraphWorkerManager({ ...options.workerOptions, programs: options.programs });
  }
  private open(): void { if (this.closed) throw new Error('GRAPH_RUNTIME_CLOSED'); }
  prepare(request: StartGraphRequest, version: GraphProgramVersion): GraphRun {
    this.open(); return this.runs.create(request, version, Date.now());
  }
  claim(run: GraphRun, owner: string, leaseExpiresAt: number): GraphRun {
    this.open();
    if (run.generation !== 0 || run.leaseOwner !== null) throw new Error('RECOVERY_REQUIRED');
    return this.runs.acquireLease({ ...fence(run), owner, leaseExpiresAt });
  }
  start(value: GraphRuntimeStart): GraphRuntimeHandle {
    this.open();
    const run = freezeWorkerData(structuredClone(value.run));
    const registration = value.registration;
    const dispatch = value.dispatch;
    const authorizeHost = value.authorize; const authorizeRegistration = registration.authorize;
    const duration = value.leaseDurationMs;
    if (duration !== undefined && (!Number.isSafeInteger(duration) || duration < 100 || duration > 60000)) throw new Error('GRAPH_LEASE_DURATION');
    const binding = { scope: run.scope, graphRunId: run.graphRunId, generation: run.generation, owner: run.leaseOwner!, identity: run.identity };
    if (workerCanonical(binding) !== workerCanonical({ scope: registration.scope, graphRunId: registration.graphRunId,
      generation: registration.generation, owner: registration.owner, identity: registration.identity })) throw new Error('GRAPH_REGISTRATION_IDENTITY');
    // A caller cannot use GraphRunStore.acquireLease as an alternate recovery route.
    if (run.generation > 1) {
      const journal = this.options.db.prepare('SELECT decision_json, snapshot_json FROM graph_recovery_decisions WHERE graph_run_id = ?').all(run.graphRunId) as { decision_json: string; snapshot_json: string }[];
      if (!journal.some(row => { const decision = JSON.parse(row.decision_json); const snapshot = JSON.parse(row.snapshot_json);
        return decision.kind === 'takeover' && decision.owner === run.leaseOwner && snapshot.run.generation + 1 === run.generation;
      })) throw new Error('RECOVERY_REQUIRED');
    }
    let consumed = false;
    let connection: object | undefined;
    let retired = false;
    const authorize = (renew = true) => {
      this.open(); if (retired || (connection && this.connections.get(connection)?.retired)) throw new Error('GRAPH_CONNECTION_RETIRED');
      synchronous(authorizeHost()); synchronous(authorizeRegistration());
      let current = this.runs.get(binding.scope, binding.graphRunId);
      if (!current || workerCanonical(current.identity) !== workerCanonical(binding.identity)) throw new Error('PROGRAM_IDENTITY_MISMATCH');
      if (current.generation !== binding.generation || current.leaseOwner !== binding.owner) throw new Error('STALE_GENERATION');
      if (['ready', 'failed', 'cancelled', 'cancel_pending', 'waiting_input'].includes(current.status)) throw new Error('GRAPH_RUN_NOT_ACTIVE');
      const now = Date.now();
      if (!current.spec || now - current.createdAt >= current.spec.limits.deadlineSeconds * 1000) throw new Error('GRAPH_DEADLINE_EXCEEDED');
      if (current.leaseExpiresAt === null || current.leaseExpiresAt <= now || now < current.updatedAt) throw new Error('LEASE_EXPIRED');
      // No await between fresh read and CAS renewal. Stopping disables this closure
      // before G15 captures its exact snapshot; recovery never refreshes a revision.
      if (renew && duration !== undefined && current.leaseExpiresAt - now < duration / 2) {
        current = this.runs.renewLease({ ...fence(current), leaseExpiresAt: now + duration });
      }
      return { leaseExpiresAt: current.leaseExpiresAt! };
    };
    const pending = new Set<Promise<unknown>>();
    const track = <T>(promise: Promise<T>): Promise<T> => {
      pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise;
    };
    const retire = () => {
      retired = true;
      if (connection) { this.options.broker.unregister(connection); this.options.checkpoints.unregister(connection);
        const record = this.connections.get(connection); if (record) record.retired = true; }
    };
    authorize();
    let handle: GraphWorkerHandle;
    try {
      handle = this.workers.start({ binding, input: value.request, programId: value.programId, ...(value.resume ? { resume: value.resume } : {}), authorize,
        register: (key, fixed) => {
          connection = key;
          // Consume this durable generation once, even if spawn subsequently fails.
          // Validation has already happened in manager.start. A fresh daemon cannot
          // reuse the same generation merely because its process map is empty.
          if (this.options.db.inTransaction) throw new Error('GRAPH_LAUNCH_REQUIRES_TRANSACTION');
          this.options.db.transaction(() => {
            authorize(false);
            this.processJournal.consume(fixed);
          }).immediate();
          consumed = true;
          this.options.broker.register(key, { ...registration, authorize: () => { authorize(); } });
          this.options.checkpoints.register(key, { ...fixed, authorize: async () => { authorize(); } });
        },
        lifecycle: {
          launched: launch => this.processJournal.launched(binding, launch),
          observed: evidence => { if (consumed) this.processJournal.observed(binding, evidence); },
        },
        action: (key, request, options) => track(dispatch ? dispatch(key, request, options) : this.options.broker.handle(key, request, options)),
        checkpoint: (key, request) => track(this.options.checkpoints.execute(key, request)),
      });
    } catch (error) { retire(); throw error; }
    const record: Connection = { handle, pending, retired };
    this.connections.set(handle.connection, record);
    void handle.exit.then(exit => {
      if (!record.exit) record.exit = freezeWorkerData(structuredClone(exit));
      retire();
    });
    // The bounded stop result stays immutable; a later actual OS event is a new
    // observation available to the trusted recovery verifier, never a timeout proof.
    void handle.finalExit.then(exit => { record.exit = freezeWorkerData(structuredClone(exit)); retire(); });
    return Object.freeze({ ...handle, cancel: (reason?: string) => { retire(); handle.cancel(reason); },
      stop: (reason?: string) => { retire(); return this.stop(handle.connection, reason); } });
  }
  /** Trusted host inspection only: no signaling, release, replay or recovery authority. */
  observeWorkerProcess(binding: GraphWorkerBinding): GraphWorkerProcessReport {
    this.open(); return this.processJournal.observe(binding);
  }
  observedExit(connection: object): GraphWorkerExitEvidence | undefined {
    const receipt = this.connections.get(connection)?.exit;
    return receipt === undefined ? undefined : structuredClone(receipt);
  }
  async stop(connection: object, reason = 'GRAPH_STOPPED'): Promise<GraphRuntimeStop> {
    const record = this.connections.get(connection); if (!record) throw new Error('GRAPH_CONNECTION_UNKNOWN');
    record.retired = true;
    this.options.broker.unregister(connection); this.options.checkpoints.unregister(connection);
    // cancel synchronously aborts the same signal passed to each actual broker call.
    const worker = record.handle.stop(reason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = Promise.allSettled([...record.pending]).then(() => true);
    const bounded = Promise.race([drained, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), this.drainTimeoutMs); })]);
    const [exit, actionsSettled] = await Promise.all([worker, bounded]);
    if (timer) clearTimeout(timer);
    return { worker: exit, actionsSettled };
  }
  /** Database lifetime barrier, separate from bounded physical-stop observations.
   * Call after close(): an unresolved producer keeps shutdown pending, never
   * authorizes closing SQLite while broker cleanup or late OS events still use it. */
  async drainDatabaseUsers(): Promise<void> {
    if (!this.closed) throw new Error('GRAPH_RUNTIME_MUST_CLOSE_BEFORE_DRAIN');
    await Promise.allSettled([...this.connections.values()].flatMap(record => [record.handle.finalExit, ...record.pending]));
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.connections.keys()].map(connection => this.stop(connection, 'GRAPH_RUNTIME_CLOSED')));
  }
}

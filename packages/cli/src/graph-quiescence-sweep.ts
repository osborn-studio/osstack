import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { GraphRunFence } from '@osstack/core';
import { GraphRecoveryStore } from '@osstack/core/graph-recovery';
import { workerCanonical } from '@osstack/protocol';
import { reopenGraphContainedTests, type ReopenContainedTests } from './graph-contained-recovery.js';
import type { GraphContainedTestOptions } from './graph-contained-tests.js';
import { verifyJournaledGraphWorkerExit, verifyJournaledGraphWorkerNotStarted } from './graph-worker-exit-proof.js';

type Registration = Omit<ReopenContainedTests, 'fence'>;
export interface GraphQuiescenceSweepOptions {
  /** Current host grant over this exact run; never supplied by a worker message. */
  authorize: () => void;
  contained?: { options: GraphContainedTestOptions; registrations: Registration[] };
}
export interface GraphQuiescenceSweepRequest { fence: GraphRunFence; mode: 'inspect' | 'stop_contained' }
interface ExecutorObservation {
  effectKey: string; generation: number; owner: string;
  status: 'stopped' | 'unproven'; evidenceRef?: string; reason?: string;
}
const reason = (error: unknown) => String(error).slice(0, 2048);
function authorize(grant: () => void): void {
  const value: unknown = grant();
  if (value !== undefined) { void Promise.resolve(value).catch(() => {}); throw Error('QUIESCENCE_AUTHORITY_MUST_BE_SYNC'); }
}

/** Host-only bounded inspection/cleanup. Every action, including released and
 * historical actions, needs independent evidence. Results are diagnostics, NOT a
 * G15 attestation or authority to settle/release/replay/take over. Workspace and
 * opaque-adapter proofs are intentionally not inferred from database flags. */
export async function sweepGraphQuiescence(db: Database.Database, options: GraphQuiescenceSweepOptions, request: GraphQuiescenceSweepRequest) {
  const input = structuredClone(request); const grant = options.authorize;
  if (!['inspect', 'stop_contained'].includes(input.mode)) throw Error('QUIESCENCE_MODE');
  const contained = options.contained ? { options: { ...options.contained.options }, registrations: structuredClone(options.contained.registrations) } : undefined;
  authorize(grant);
  const store = new GraphRecoveryStore(db, () => { throw Error('QUIESCENCE_SWEEP_NOT_RECOVERY_AUTHORITY'); });
  const inventory = store.inspectExecutors(input.fence);
  const registrations = new Map(contained?.registrations.map(r => [r.effectKey, r]));
  if (registrations.size !== (contained?.registrations.length ?? 0)
    || [...registrations.keys()].some(key => !inventory.entries.some(e => e.action.effectKey === key))) throw Error('QUIESCENCE_REGISTRATION_SET');
  const observeWorkers = () => inventory.workers.map(({ generation, owner }) => {
    const binding = { scope: input.fence.scope, graphRunId: input.fence.graphRunId, identity: input.fence.identity, generation, owner };
    try { return { generation, owner, status: 'stopped' as const, proof: verifyJournaledGraphWorkerExit(db, binding) }; }
    catch (error) {
      try { return { generation, owner, status: 'not_started' as const, proof: verifyJournaledGraphWorkerNotStarted(db, binding) }; }
      catch { return { generation, owner, status: 'unproven' as const, reason: reason(error) }; }
    }
  });
  const workers = observeWorkers();
  const workersStopped = workers.length > 0 && workers.every(w => w.status !== 'unproven');
  const guard = () => {
    authorize(grant);
    if (store.inspectExecutors(input.fence).digest !== inventory.digest || workerCanonical(observeWorkers()) !== workerCanonical(workers)) throw Error('QUIESCENCE_SWEEP_CHANGED');
  };
  const observations: ExecutorObservation[] = [];
  for (const entry of inventory.entries) {
    guard();
    const observation: ExecutorObservation = { effectKey: entry.action.effectKey, generation: entry.action.generation, owner: entry.owner, status: 'unproven' };
    const registration = registrations.get(entry.action.effectKey);
    if (!workersStopped) observation.reason = 'WORKER_EXIT_UNPROVEN';
    else if (!entry.admission) observation.reason = 'ADMISSION_MISSING';
    else if (entry.action.action.kind !== 'tests' || !registration || !contained) observation.reason = 'EXECUTOR_VERIFIER_UNAVAILABLE';
    else {
      try {
        // Wrap each executor's own asynchronous boundary as well as this loop's.
        const executorOptions = { ...contained.options,
          authorizeRead: () => { guard(); authorize(contained.options.authorizeRead); },
          authorizeStop: () => { guard(); authorize(contained.options.authorizeStop); } };
        const mayStop = input.mode === 'stop_contained' && entry.admission.releasedAt === null;
        const opened = await reopenGraphContainedTests(db, executorOptions, { ...registration, fence: input.fence }, mayStop ? 'held' : 'read_only');
        guard(); let result = await opened.confirmStopped(); guard();
        if (!result.stopped && mayStop) { result = await opened.stop(); guard(); }
        if (result.stopped) { observation.status = 'stopped'; observation.evidenceRef = result.evidence; }
        else observation.reason = 'CONTAINED_STOP_UNPROVEN';
      } catch (error) { guard(); observation.reason = reason(error); }
    }
    observations.push(observation);
  }
  guard();
  const body = { version: 1 as const, scope: input.fence.scope, graphRunId: input.fence.graphRunId, inventoryDigest: inventory.digest,
    mode: input.mode, workers, executors: observations,
    allInventoriedExecutorsStopped: workersStopped && observations.every(e => e.status === 'stopped'),
    recoveryAuthorized: false as const, workerDescendantsStatus: 'unproven' as const, workspaceStatus: 'unproven' as const };
  return { ...body, evidenceRef: `graph-quiescence-sweep:${createHash('sha256').update(workerCanonical(body)).digest('hex')}` };
}

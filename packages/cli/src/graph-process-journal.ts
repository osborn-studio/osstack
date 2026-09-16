import type Database from 'better-sqlite3';
import { GraphRunStore } from '@osstack/core';
import { GraphWorkerBinding, workerCanonical } from '@osstack/protocol';
import { observeGraphProcessIdentity, type GraphProcessObservation } from './graph-process-identity.js';
import type { GraphWorkerLaunch, GraphWorkerExitEvidence } from './graph-worker-manager.js';

type ProcessEvent = { kind: 'launched'; launch: GraphWorkerLaunch } | GraphWorkerExitEvidence;
export interface GraphWorkerProcessReport {
  binding: GraphWorkerBinding;
  intentRecorded: boolean;
  launch: GraphWorkerLaunch | null;
  observations: GraphWorkerExitEvidence[];
  leader: GraphProcessObservation;
  executors: { state: 'unknown'; reason: 'opaque_adapters_and_descendants_unproven' };
  recovery: 'held';
}
/** Append-only host observations, not recovery attestations. */
export class GraphProcessJournal {
  constructor(private readonly db: Database.Database) {}
  private binding(value: GraphWorkerBinding): GraphWorkerBinding {
    const binding = GraphWorkerBinding.parse(value);
    const run = new GraphRunStore(this.db).get(binding.scope, binding.graphRunId);
    if (!run || workerCanonical(run.identity) !== workerCanonical(binding.identity)) throw new Error('GRAPH_PROCESS_BINDING');
    return binding;
  }
  private intent(binding: GraphWorkerBinding): boolean {
    const row = this.db.prepare('SELECT owner, identity_json FROM graph_worker_launches WHERE graph_run_id = ? AND generation = ?')
      .get(binding.graphRunId, binding.generation) as { owner: string; identity_json: string } | undefined;
    if (!row) return false;
    if (row.owner !== binding.owner || row.identity_json !== workerCanonical(binding.identity)) throw new Error('GRAPH_PROCESS_BINDING');
    return true;
  }
  consume(value: GraphWorkerBinding): void {
    const binding = this.binding(value);
    if (this.intent(binding)) throw new Error('GRAPH_GENERATION_ALREADY_LAUNCHED');
    this.db.prepare('INSERT INTO graph_worker_launches(graph_run_id,generation,owner,identity_json,launched_at) VALUES (?,?,?,?,?)')
      .run(binding.graphRunId, binding.generation, binding.owner, workerCanonical(binding.identity), Date.now());
  }
  private append(value: GraphWorkerBinding, event: ProcessEvent): void {
    const binding = this.binding(value);
    if (!this.intent(binding)) throw new Error('GRAPH_PROCESS_INTENT_REQUIRED');
    // Optional host fields may be undefined; canonicalize their JSON representation.
    const eventJson = workerCanonical(JSON.parse(JSON.stringify(event)));
    this.db.prepare('INSERT INTO graph_worker_process_events(graph_run_id,generation,kind,event_json,observed_at) VALUES (?,?,?,?,?)')
      .run(binding.graphRunId, binding.generation, event.kind, eventJson, Date.now());
  }
  launched(binding: GraphWorkerBinding, launch: GraphWorkerLaunch): void {
    if (!Number.isSafeInteger(launch.pid) || launch.pid < 1 || launch.processIdentity.pid !== launch.pid
      || (launch.pgid !== null && (!Number.isSafeInteger(launch.pgid) || launch.pgid < 1))
      || (launch.processIdentity.pgid !== null && launch.processIdentity.pgid !== launch.pgid)) throw new Error('GRAPH_PROCESS_LAUNCH_IDENTITY');
    this.append(binding, { kind: 'launched', launch });
  }
  observed(binding: GraphWorkerBinding, evidence: GraphWorkerExitEvidence): void {
    if (evidence.kind !== 'exit_unconfirmed' && (evidence.graphRunId !== binding.graphRunId
      || evidence.generation !== binding.generation || evidence.owner !== binding.owner)) throw new Error('GRAPH_PROCESS_BINDING');
    this.append(binding, evidence);
  }
  observe(value: GraphWorkerBinding): GraphWorkerProcessReport {
    const binding = this.binding(value); const intentRecorded = this.intent(binding);
    const rows = this.db.prepare('SELECT event_json FROM graph_worker_process_events WHERE graph_run_id = ? AND generation = ? ORDER BY sequence')
      .all(binding.graphRunId, binding.generation) as { event_json: string }[];
    const events = rows.map(row => JSON.parse(row.event_json) as ProcessEvent);
    const launch = events.find((event): event is Extract<ProcessEvent, { kind: 'launched' }> => event.kind === 'launched')?.launch ?? null;
    const observations = events.filter((event): event is GraphWorkerExitEvidence => event.kind !== 'launched');
    const leader: GraphProcessObservation = launch ? observeGraphProcessIdentity(launch.processIdentity)
      : observations.some(event => event.kind === 'spawn_failed') ? { state: 'absent', reason: 'authenticated_no_child' }
      : { state: 'unknown', reason: intentRecorded ? 'launch_window_unobserved' : 'no_launch_intent' };
    return { binding, intentRecorded, launch, observations, leader,
      executors: { state: 'unknown', reason: 'opaque_adapters_and_descendants_unproven' }, recovery: 'held' };
  }
}

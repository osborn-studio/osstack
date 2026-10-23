import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { GraphRunStore } from '@osstack/core';
import type { GraphRecoveryProof } from '@osstack/core/graph-recovery';
import { GraphWorkerBinding, workerCanonical } from '@osstack/protocol';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pid = count.min(1);
const text = z.string().min(1).max(8192);
const processIdentity = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('linux'), pid, pgid: pid, bootId: text, startTicks: z.string().regex(/^\d+$/) }).strict(),
  z.object({ kind: z.literal('unverifiable'), pid, pgid: pid.nullable(), platform: text, detail: text }).strict(),
]);
const launched = z.object({ kind: z.literal('launched'), launch: z.object({ pid, pgid: pid.nullable(), processIdentity, capturedAt: count }).strict() }).strict();
const exited = z.object({ kind: z.literal('exited'), graphRunId: text, generation: pid, owner: text, pid,
  code: count.nullable(), signal: z.string().regex(/^SIG[A-Z0-9]+$/).nullable(), confirmedAt: count,
  evidenceRef: z.string().regex(/^worker-exit:[a-f0-9-]{36}$/) }).strict();
const unconfirmed = z.object({ kind: z.literal('exit_unconfirmed'), pid: pid.optional(), error: text }).strict();
const notStarted = z.object({ kind: z.literal('spawn_failed'), graphRunId: text, generation: pid, owner: text,
  confirmedAt: count, evidenceRef: z.string().regex(/^worker-not-started:[a-f0-9-]{36}$/),
  phase: z.enum(['registration', 'spawn']), error: z.string() }).strict();

/** A consumed launch plus one authenticated no-child observation. Missing intent,
 * an expired lease, or absence of an OS process is never a no-start proof.
 * This proves only this generation; callers must inventory all other workers and
 * independently verify executor/workspace obligations. Safe inside G15 recheck. */
export function verifyJournaledGraphWorkerNotStarted(db: Database.Database, value: GraphWorkerBinding, now = Date.now()): Extract<GraphRecoveryProof['worker'], { kind: 'not_started' }> {
  const binding = GraphWorkerBinding.parse(value); count.parse(now);
  const run = new GraphRunStore(db).get(binding.scope, binding.graphRunId);
  if (!run || workerCanonical(run.identity) !== workerCanonical(binding.identity)) throw Error('GRAPH_NO_CHILD_PROOF_REQUIRED');
  const rows = db.prepare(`SELECT l.owner,l.acquired_at,w.owner AS launch_owner,w.identity_json,w.launched_at,
    e.kind,e.event_json,e.observed_at,
    EXISTS(SELECT 1 FROM graph_actions WHERE graph_run_id=l.graph_run_id AND generation=l.generation) AS actions,
    EXISTS(SELECT 1 FROM graph_action_admissions WHERE graph_run_id=l.graph_run_id AND generation=l.generation) AS admissions,
    EXISTS(SELECT 1 FROM graph_checkpoint_requests WHERE graph_run_id=l.graph_run_id AND generation=l.generation) AS requests
    FROM graph_worker_leases l JOIN graph_worker_launches w ON w.graph_run_id=l.graph_run_id AND w.generation=l.generation
    LEFT JOIN graph_worker_process_events e ON e.graph_run_id=l.graph_run_id AND e.generation=l.generation
    WHERE l.graph_run_id=? AND l.generation=?`).all(binding.graphRunId, binding.generation) as Array<{
      owner: string; acquired_at: number; launch_owner: string; identity_json: string; launched_at: number;
      kind: string | null; event_json: string | null; observed_at: number | null; actions: number; admissions: number; requests: number;
    }>;
  const row = rows[0];
  if (rows.length !== 1 || !row || row.owner !== binding.owner || row.launch_owner !== binding.owner
    || row.identity_json !== workerCanonical(binding.identity) || row.kind !== 'spawn_failed'
    || row.actions || row.admissions || row.requests) throw Error('GRAPH_NO_CHILD_PROOF_REQUIRED');
  const parsed = notStarted.safeParse(JSON.parse(row.event_json!));
  if (!parsed.success) throw Error('GRAPH_NO_CHILD_PROOF_REQUIRED');
  const event = parsed.data;
  if (event.graphRunId !== binding.graphRunId || event.generation !== binding.generation || event.owner !== binding.owner
    || row.acquired_at > row.launched_at || row.launched_at > event.confirmedAt
    || event.confirmedAt > row.observed_at! || row.observed_at! > now) throw Error('GRAPH_NO_CHILD_PROOF_REQUIRED');
  return { kind: 'not_started', graphRunId: event.graphRunId, generation: event.generation, owner: event.owner,
    confirmedAt: event.confirmedAt, evidenceRef: event.evidenceRef };
}

/** Trusted host journal only. Proves the direct child's observed exit, not the
 * termination of its descendants/executors, workspace safety, or recovery authority.
 * No current PID lookup or signals: PID reuse cannot retarget this historical proof.
 * Synchronous reads also work inside G15's final BEGIN IMMEDIATE recheck. */
export function verifyJournaledGraphWorkerExit(db: Database.Database, value: GraphWorkerBinding, now = Date.now()): Extract<GraphRecoveryProof['worker'], { kind: 'stopped' }> {
  const binding = GraphWorkerBinding.parse(value); count.parse(now);
  const run = new GraphRunStore(db).get(binding.scope, binding.graphRunId);
  if (!run || workerCanonical(run.identity) !== workerCanonical(binding.identity)) throw Error('GRAPH_WORKER_EXIT_BINDING');
  // One statement observes lease, consumed launch and every immutable event.
  const rows = db.prepare(`SELECT l.owner,l.acquired_at,w.owner AS launch_owner,w.identity_json,w.launched_at,
    e.sequence,e.kind,e.event_json,e.observed_at
    FROM graph_worker_leases l JOIN graph_worker_launches w
      ON w.graph_run_id=l.graph_run_id AND w.generation=l.generation
    LEFT JOIN graph_worker_process_events e ON e.graph_run_id=l.graph_run_id AND e.generation=l.generation
    WHERE l.graph_run_id=? AND l.generation=? ORDER BY e.sequence`).all(binding.graphRunId, binding.generation) as Array<{
      owner: string; acquired_at: number; launch_owner: string; identity_json: string; launched_at: number;
      sequence: number | null; kind: string | null; event_json: string | null; observed_at: number | null;
    }>;
  const first = rows[0];
  if (!first || first.owner !== binding.owner || first.launch_owner !== binding.owner
    || first.identity_json !== workerCanonical(binding.identity) || first.acquired_at > first.launched_at
    || rows.length < 2 || rows.length > 3 || rows[0]!.kind !== 'launched' || rows.at(-1)!.kind !== 'exited') throw Error('GRAPH_WORKER_EXIT_UNPROVEN');
  const start = launched.parse(JSON.parse(first.event_json!)).launch;
  const last = rows.at(-1)!; const exit = exited.parse(JSON.parse(last.event_json!));
  if (start.pid !== start.processIdentity.pid || start.pgid !== start.processIdentity.pgid
    || exit.pid !== start.pid || exit.graphRunId !== binding.graphRunId || exit.generation !== binding.generation || exit.owner !== binding.owner
    || (exit.code === null) === (exit.signal === null)
    || first.launched_at > start.capturedAt || start.capturedAt > first.observed_at!
    || first.observed_at! > exit.confirmedAt || exit.confirmedAt > last.observed_at! || last.observed_at! > now) throw Error('GRAPH_WORKER_EXIT_UNPROVEN');
  if (rows.length === 3) {
    const middle = rows[1]!;
    const timeout = unconfirmed.parse(JSON.parse(middle.event_json!));
    if (middle.kind !== 'exit_unconfirmed' || (timeout.pid !== undefined && timeout.pid !== start.pid)
      || middle.observed_at! < first.observed_at! || middle.observed_at! > exit.confirmedAt) throw Error('GRAPH_WORKER_EXIT_UNPROVEN');
  }
  const evidenceRef = `graph-worker-exit:${createHash('sha256').update(workerCanonical({ binding, rows })).digest('hex')}`;
  return { kind: 'stopped', graphRunId: binding.graphRunId, generation: binding.generation, owner: binding.owner,
    confirmedAt: exit.confirmedAt, evidenceRef };
}

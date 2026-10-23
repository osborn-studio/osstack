import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { GraphRunStore, GraphActionStore, GraphCheckpointStore, openDb, type GraphRun } from '@osstack/core';
import { GraphActionBroker } from './graph-action-broker.js';
import { GraphCheckpointService } from './graph-checkpoint-service.js';
import { GraphRuntime } from './graph-runtime.js';
import { GraphProcessJournal } from './graph-process-journal.js';
import { processFixture } from './graph-process-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'g25-unstarted-')); const f = processFixture(root);
  cleanup.push(async () => { await f.runtime.close(); await f.runtime.drainDatabaseUsers(); if (f.db.open) f.db.close(); rmSync(root, { recursive: true, force: true }); });
  const request = () => ({ fence: { scope: f.run.scope, graphRunId: f.run.graphRunId, identity: f.run.identity,
    expectedGeneration: f.run.generation, expectedRevision: f.run.revision, expectedOwner: f.run.leaseOwner, now: Date.now() },
    receiptId: 'unstarted-recovery', owner: 'replacement', leaseExpiresAt: Date.now() + 30000 });
  const failRegistration = async () => {
    const register = vi.spyOn(f.broker, 'register').mockImplementation(() => { throw Error('registration failure'); });
    try { expect(await f.runtime.start(f.start).finalExit).toMatchObject({ kind: 'spawn_failed' }); } finally { register.mockRestore(); }
  };
  return { ...f, request, failRegistration };
}
it('takes over a durable no-child run through G15 and starts one replacement worker', async () => {
  const f = fixture(); await f.failRegistration(); const fresh = new GraphRuntime(f.options);
  try {
    const recovered = await fresh.recoverUnstartedWorker(f.request(), () => {});
    expect(recovered.exit).toBe('takeover'); expect(recovered.result.record.proof.worker.kind).toBe('not_started');
    expect(recovered.result.run).toMatchObject({ generation: 2, leaseOwner: 'replacement', createdAt: f.run.createdAt });
    const run = recovered.result.run;
    const h = fresh.start({ ...f.start, run, registration: { ...f.start.registration, generation: run.generation, owner: run.leaseOwner! } });
    expect(await h.result).toBe(42); await h.finalExit;
    await expect(fresh.recoverUnstartedWorker(f.request(), () => {})).rejects.toThrow();
    expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 1 });
  } finally { await fresh.close(); await fresh.drainDatabaseUsers(); }
});
it('refuses an intent-only launch window even after lease expiry', async () => {
  const f = fixture(); new GraphProcessJournal(f.db).consume(f.binding);
  const now = vi.spyOn(Date, 'now').mockReturnValue(f.run.leaseExpiresAt! + 1);
  try { await expect(f.runtime.recoverUnstartedWorker(f.request(), () => {})).rejects.toThrow('GRAPH_NO_CHILD_PROOF_REQUIRED'); }
  finally { now.mockRestore(); }
  expect(new GraphRunStore(f.db).get(f.run.scope, f.run.graphRunId)!.generation).toBe(1);
});
it('refuses a launched worker even after its confirmed exit', async () => {
  const f = fixture(); await f.runtime.start(f.start).finalExit;
  const request = f.request(); request.fence.expectedRevision = new GraphRunStore(f.db).get(f.run.scope, f.run.graphRunId)!.revision;
  await expect(f.runtime.recoverUnstartedWorker(request, () => {})).rejects.toThrow(/GRAPH_(NO_CHILD_PROOF|EXECUTOR_ABSENCE)_REQUIRED/);
});
it.each(['graph_checkpoints', 'graph_checkpoint_writes', 'graph_checkpoint_requests'])('refuses persisted scheduling evidence in %s', async table => {
  const f = fixture(); await f.failRegistration(); const id = f.run.graphRunId;
  if (table === 'graph_checkpoints') f.db.prepare('INSERT INTO graph_checkpoints VALUES (?,?,?,?,?,?,?)').run(id, '', 'cp', null, '{}', '{}', '{}');
  else if (table === 'graph_checkpoint_writes') f.db.prepare('INSERT INTO graph_checkpoint_writes VALUES (?,?,?,?,?,?,?)').run(id, '', 'cp', 'task', 0, 'value', '1');
  else f.db.prepare('INSERT INTO graph_checkpoint_requests VALUES (?,?,?,?,?)').run(id, 'request', 'a'.repeat(64), '{}', 1);
  await expect(f.runtime.recoverUnstartedWorker(f.request(), () => {})).rejects.toThrow('GRAPH_EXECUTOR_ABSENCE_REQUIRED');
});
it.each(['revoked', 'async', 'commit-revoked'])('requires synchronous current authority including the final transaction: %s', async mode => {
  const f = fixture(); await f.failRegistration();
  const authorize = mode === 'async' ? async () => {} : () => {
    if (mode === 'revoked' || f.db.inTransaction) throw Error('REVOKED');
  };
  await expect(f.runtime.recoverUnstartedWorker(f.request(), authorize)).rejects.toThrow(mode === 'async' ? 'GRAPH_AUTHORITY_MUST_BE_SYNC' : 'REVOKED');
  expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 0 });
  expect(new GraphRunStore(f.db).get(f.run.scope, f.run.graphRunId)!.generation).toBe(1);
});
it('rechecks executor absence inside the commit transaction', async () => {
  const f = fixture(); await f.failRegistration();
  await expect(f.runtime.recoverUnstartedWorker(f.request(), () => {
    if (f.db.inTransaction) f.db.prepare('INSERT INTO graph_checkpoint_writes VALUES (?,?,?,?,?,?,?)').run(f.run.graphRunId, '', 'cp', 'task', 0, 'value', '1');
  })).rejects.toThrow('GRAPH_EXECUTOR_ABSENCE_REQUIRED');
  expect(new GraphRunStore(f.db).get(f.run.scope, f.run.graphRunId)!.generation).toBe(1);
});
it('allows one competing takeover while the failed original host remains alive', async () => {
  const f = fixture(); await f.failRegistration(); const peer = new GraphRuntime(f.options);
  try {
    const request = f.request(); const outcomes = await Promise.allSettled([
      f.runtime.recoverUnstartedWorker(request, () => {}), peer.recoverUnstartedWorker({ ...request, receiptId: 'competitor', owner: 'competitor' }, () => {}),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(() => f.runtime.start(f.start)).toThrow();
    expect(f.db.prepare('SELECT count(*) n FROM graph_worker_process_events WHERE kind=\'launched\'').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 1 });
  } finally { await peer.close(); await peer.drainDatabaseUsers(); }
});
it.each(['owner', 'program', 'deadline'])('rejects changed recovery premise: %s', async mode => {
  const f = fixture(); await f.failRegistration(); const request = f.request();
  if (mode === 'owner') request.fence.expectedOwner = 'impostor';
  if (mode === 'program') request.fence.identity = { ...request.fence.identity, compiledProgramDigest: 'f'.repeat(64) };
  if (mode === 'deadline') request.leaseExpiresAt = f.run.createdAt + 301000;
  await expect(f.runtime.recoverUnstartedWorker(request, () => {})).rejects.toThrow();
  expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 0 });
});
it('refuses recovery if any executor action was admitted', async () => {
  const f = fixture(); await f.failRegistration();
  const value = new GraphActionStore(f.db).reserve(f.request().fence, { epoch: 0, nodeId: 'prepare', effectSlot: 'workspace', reservationTokens: 0,
    action: { kind: 'workspace_create', repositoryRef: 'repo', baseRevision: 'a'.repeat(40) } });
  const request = f.request(); request.fence.expectedRevision = value.run.revision;
  await expect(f.runtime.recoverUnstartedWorker(request, () => {})).rejects.toThrow('GRAPH_EXECUTOR_ABSENCE_REQUIRED');
});

it('recovers repeated real no-child failures after restart and starts exactly one third-generation worker', async () => {
  const f = fixture(); await f.failRegistration();
  const second = (await f.runtime.recoverUnstartedWorker(f.request(), () => {})).result.run;
  const register = vi.spyOn(f.broker, 'register').mockImplementation(() => { throw Error('second registration failure'); });
  try {
    expect((await f.runtime.start({ ...f.start, run: second, registration: { ...f.start.registration, generation: 2, owner: second.leaseOwner! } }).finalExit).kind).toBe('spawn_failed');
  } finally { register.mockRestore(); }
  await f.runtime.close(); await f.runtime.drainDatabaseUsers();
  // Close and reopen SQLite and all host services; no old handles are reused.
  const path = f.db.name; f.db.close(); const db = openDb({ path });
  const broker = new GraphActionBroker(db, { acquire: async () => { throw Error('no executor'); } });
  const checkpoints = new GraphCheckpointService({ runs: new GraphRunStore(db), checkpoints: new GraphCheckpointStore(db), bindings: new Map() });
  const fresh = new GraphRuntime({ ...f.options, db, broker, checkpoints });
  try {
    const request = { ...f.request(), receiptId: 'second-failure', owner: 'third-owner', fence: {
      ...f.request().fence, expectedGeneration: 2, expectedOwner: second.leaseOwner, expectedRevision: second.revision } };
    const third = (await fresh.recoverUnstartedWorker(request, () => {})).result.run;
    expect(third.generation).toBe(3);
    const h = fresh.start({ ...f.start, run: third, registration: { ...f.start.registration, generation: 3, owner: third.leaseOwner! } });
    expect(await h.result).toBe(42); await h.finalExit;
    expect(db.prepare("SELECT count(*) n FROM graph_worker_process_events WHERE kind='launched'").get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 2 });
    expect(() => fresh.start({ ...f.start, run: third, registration: { ...f.start.registration, generation: 3, owner: third.leaseOwner! } })).toThrow();
  } finally { await fresh.close(); await fresh.drainDatabaseUsers(); db.close(); }
});

it.each(['intent-only', 'exited', 'commit-drift', 'grant'])('does not ignore an empty historical generation: %s', async mode => {
  const f = fixture();
  if (mode === 'intent-only') new GraphProcessJournal(f.db).consume(f.binding);
  else if (mode === 'exited') await f.runtime.start(f.start).finalExit;
  else await f.failRegistration();
  // Seed the otherwise unreachable historical obligation. The recovery under test
  // must not trust this administrative fixture's stopped_worker_json.
  const now = Date.now();
  f.db.prepare('INSERT INTO graph_worker_leases VALUES(?,2,?,?,?,?)').run(f.run.graphRunId, 'second', now, now + 30000, '{}');
  f.db.prepare('UPDATE graph_runs SET generation=2,lease_owner=?,revision=revision+1 WHERE graph_run_id=?').run('second', f.run.graphRunId);
  const second: GraphRun = new GraphRunStore(f.db).get(f.run.scope, f.run.graphRunId)!;
  const binding = { ...f.binding, generation: 2, owner: 'second' }; const journal = new GraphProcessJournal(f.db);
  journal.consume(binding); journal.observed(binding, { kind: 'spawn_failed', graphRunId: f.run.graphRunId, generation: 2, owner: 'second',
    confirmedAt: Date.now(), evidenceRef: 'worker-not-started:00000000-0000-0000-0000-000000000000', phase: 'registration', error: 'failed' });
  const request = { ...f.request(), receiptId: 'retry', owner: 'third', fence: { ...f.request().fence, expectedGeneration: 2, expectedOwner: 'second', expectedRevision: second.revision } };
  await expect(f.runtime.recoverUnstartedWorker(request, () => {
    if (f.db.inTransaction && mode === 'grant') throw Error('REVOKED');
    if (f.db.inTransaction && mode === 'commit-drift') journal.observed(f.binding, { kind: 'exit_unconfirmed', pid: undefined, error: 'late contradiction' });
  })).rejects.toThrow(mode === 'grant' ? /REVOKED/ : /GRAPH_(NO_CHILD_PROOF|EXECUTOR_ABSENCE)_REQUIRED/);
  expect(new GraphRunStore(f.db).get(f.run.scope, f.run.graphRunId)!.generation).toBe(2);
  expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 0 });
});

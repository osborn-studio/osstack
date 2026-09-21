import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChildProcess } from 'node:child_process';
import { openDb } from '@osstack/core';
import { afterEach, expect, it, vi } from 'vitest';
import { processFixture } from './graph-process-fixture.js';
import { GraphRuntime } from './graph-runtime.js';
import { GraphProcessJournal } from './graph-process-journal.js';
import { GraphRecoveryStore } from '@osstack/core/graph-recovery';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(source?: string) {
  const root = mkdtempSync(join(tmpdir(), 'g25-journal-')); const f = processFixture(root, source);
  cleanup.push(async () => { await f.runtime.close(); await f.runtime.drainDatabaseUsers(); if (f.db.open) f.db.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}
it('passes an actual runtime no-child journal through the G15 canonical identity gate', async () => {
  const f = fixture();
  vi.spyOn(f.broker, 'register').mockImplementation(() => { throw Error('registration unavailable'); });
  const evidence = await f.runtime.start(f.start).finalExit;
  if (evidence.kind !== 'spawn_failed') throw Error('expected authenticated no-child');
  const store = new GraphRecoveryStore(f.db, () => {}); const now = Date.now(); const r = f.run;
  const snapshot = store.snapshot({ scope: r.scope, graphRunId: r.graphRunId, identity: r.identity,
    expectedGeneration: r.generation, expectedRevision: r.revision, expectedOwner: r.leaseOwner, now });
  const proof = { snapshotDigest: snapshot.digest, verifiedAt: now,
    worker: { kind: 'not_started' as const, graphRunId: evidence.graphRunId, generation: evidence.generation,
      owner: evidence.owner, confirmedAt: evidence.confirmedAt, evidenceRef: evidence.evidenceRef },
    executorEvidenceRef: 'registration-failed-before-executors', workspaceEvidenceRef: 'no-actions-admitted' };
  expect(store.commit(snapshot, { kind: 'takeover', receiptId: 'actual-no-child', owner: 'replacement', leaseExpiresAt: now + 30000 }, proof, now).run.generation).toBe(2);
});
it('persists intent before registration and no-child registration failure after consuming generation', async () => {
  const f = fixture();
  const register = vi.spyOn(f.broker, 'register').mockImplementation(() => {
    expect(f.runtime.observeWorkerProcess(f.binding)).toMatchObject({ intentRecorded: true, launch: null, leader: { state: 'unknown' } });
    throw new Error('consumed registration failure');
  });
  const handle = f.runtime.start(f.start);
  expect(f.runtime.observeWorkerProcess(f.binding).observations).toEqual([expect.objectContaining({ kind: 'spawn_failed', phase: 'registration' })]);
  expect(await handle.finalExit).toMatchObject({ kind: 'spawn_failed' }); register.mockRestore();
  const fresh = new GraphRuntime(f.options);
  try {
    const retry = fresh.start(f.start); expect(await retry.finalExit).toMatchObject({ kind: 'spawn_failed', error: expect.stringContaining('ALREADY_LAUNCHED') });
    expect(fresh.observeWorkerProcess(f.binding).observations).toHaveLength(1);
  } finally { await fresh.close(); await fresh.drainDatabaseUsers(); }
});
it('journals an actual failed OS spawn and never launches an already consumed generation', async () => {
  const f = fixture(); const runtime = new GraphRuntime({ ...f.options, workerOptions: { executable: '/g25-missing-executable' } });
  try {
    expect(await runtime.start(f.start).finalExit).toMatchObject({ kind: 'spawn_failed', phase: 'spawn' });
    expect(runtime.observeWorkerProcess(f.binding)).toMatchObject({ launch: null, leader: { state: 'absent', reason: 'authenticated_no_child' }, recovery: 'held' });
  } finally { await runtime.close(); await runtime.drainDatabaseUsers(); }
});
it('retains launch and true exit, rejects changed identity and protects immutable observations', async () => {
  const f = fixture(); const h = f.runtime.start(f.start); expect(await h.result).toBe(42); await h.finalExit;
  const report = new GraphRuntime(f.options).observeWorkerProcess(f.binding);
  expect(report.launch).toMatchObject({ pid: expect.any(Number) });
  const pgid = report.launch!.pgid;
  expect(pgid === null || (Number.isSafeInteger(pgid) && pgid > 0)).toBe(true);
  expect(report.observations).toEqual([expect.objectContaining({ kind: 'exited' })]);
  expect(report).toMatchObject({ executors: { state: 'unknown' }, recovery: 'held' });
  expect(() => f.runtime.observeWorkerProcess({ ...f.binding, identity: { ...f.binding.identity, compiledProgramDigest: 'f'.repeat(64) } })).toThrow('GRAPH_PROCESS_BINDING');
  expect(() => f.runtime.observeWorkerProcess({ ...f.binding, owner: 'impostor' })).toThrow('GRAPH_PROCESS_BINDING');
  expect(() => f.db.prepare('UPDATE graph_worker_process_events SET event_json = ?').run('{}')).toThrow('immutable');
  expect(() => f.db.prepare('DELETE FROM graph_worker_process_events').run()).toThrow('immutable');
});
it('keeps the pre-spawn crash window unknown and does not derive stop from lease expiry', () => {
  const f = fixture(); const journal = new GraphProcessJournal(f.db); journal.consume(f.binding);
  const now = vi.spyOn(Date, 'now').mockReturnValue(f.run.leaseExpiresAt! + 1);
  try {
  expect(f.runtime.observeWorkerProcess(f.binding)).toMatchObject({ intentRecorded: true, launch: null, leader: { state: 'unknown', reason: 'launch_window_unobserved' }, recovery: 'held' });
  } finally { now.mockRestore(); }
});
it('round-trips an unconfirmed observation without an assigned PID as valid JSON', () => {
  const f = fixture(); const journal = new GraphProcessJournal(f.db); journal.consume(f.binding);
  journal.observed(f.binding, { kind: 'exit_unconfirmed', pid: undefined, error: 'spawn observation unavailable' });
  const report = new GraphProcessJournal(f.db).observe(f.binding);
  expect(report.observations).toEqual([{ kind: 'exit_unconfirmed', error: 'spawn observation unavailable' }]);
  expect(report).toMatchObject({ leader: { state: 'unknown' }, executors: { state: 'unknown' }, recovery: 'held' });
});
it('persists timeout separately from actual late exit and keeps DB drainage pending', async () => {
  const f = fixture('export async function run(){process.on("SIGTERM",()=>{});console.log("running");while(true){}}');
  const handle = f.runtime.start(f.start); await handle.ready;
  await expect.poll(() => handle.logs().stdout).toContain('running');
  const ignoredKill = vi.spyOn(ChildProcess.prototype, 'kill').mockReturnValue(true);
  let pid: number | undefined;
  try {
    const bounded = await handle.stop(); expect(bounded.worker.kind).toBe('exit_unconfirmed');
    const report = f.runtime.observeWorkerProcess(f.binding); pid = report.launch!.pid;
    expect(report.observations.map(event => event.kind)).toEqual(['exit_unconfirmed']);
    await f.runtime.close(); let drained = false; const drainage = f.runtime.drainDatabaseUsers().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(drained).toBe(false);
    process.kill(pid, 'SIGKILL'); await handle.finalExit; await drainage;
    expect(new GraphProcessJournal(f.db).observe(f.binding).observations.map(event => event.kind)).toEqual(['exit_unconfirmed', 'exited']);
  } finally { ignoredKill.mockRestore(); if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
});

it('reopens consumed registration failure from SQLite without inferring that an intent-only launch stopped', async () => {
  const f = fixture(); const register = vi.spyOn(f.checkpoints, 'register').mockImplementation(() => { throw new Error('checkpoint registration failed'); });
  const handle = f.runtime.start(f.start); const exit = await handle.finalExit;
  register.mockRestore(); await f.runtime.close(); await f.runtime.drainDatabaseUsers();
  const path = f.db.name; f.db.close(); const reopened = openDb({ path });
  try {
    const report = new GraphProcessJournal(reopened).observe(f.binding);
    expect(report).toMatchObject({ intentRecorded: true, launch: null, leader: { state: 'absent', reason: 'authenticated_no_child' }, recovery: 'held' });
    expect(report.observations).toEqual([exit]);
  } finally { reopened.close(); }
});
it('refuses changed compiled program bytes on a fresh runtime before launching', async () => {
  const f = fixture(); const handle = f.runtime.start(f.start); await handle.finalExit;
  const fresh = new GraphRuntime(f.options);
  try {
    const identity = { ...f.run.identity, compiledProgramDigest: 'f'.repeat(64) };
    expect(() => fresh.start({ ...f.start, run: { ...f.run, identity }, registration: { ...f.start.registration, identity } })).toThrow('PROGRAM_IDENTITY_MISMATCH');
    expect(fresh.observeWorkerProcess(f.binding).observations).toHaveLength(1);
  } finally { await fresh.close(); await fresh.drainDatabaseUsers(); }
});

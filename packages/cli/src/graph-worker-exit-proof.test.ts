import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { ChildProcess, execFileSync } from 'node:child_process';
import { GraphRunStore, openDb } from '@osstack/core';
import { workerCanonical } from '@osstack/protocol';
import { GraphRecoveryStore } from '@osstack/core/graph-recovery';
import { GraphProcessJournal } from './graph-process-journal.js';
import { processFixture } from './graph-process-fixture.js';
import { GraphRuntime } from './graph-runtime.js';
import { verifyJournaledGraphWorkerExit, verifyJournaledGraphWorkerNotStarted } from './graph-worker-exit-proof.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'g25-exit-')); const f = processFixture(root);
  cleanup.push(async () => { await f.runtime.close(); await f.runtime.drainDatabaseUsers(); if (f.db.open) f.db.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}
function synthetic(mutate: (events: Array<Record<string, unknown>>, start: number) => void = () => {}) {
  const f = fixture(); const journal = new GraphProcessJournal(f.db); journal.consume(f.binding); const start = Date.now();
  const events: Array<Record<string, unknown>> = [
    { kind: 'launched', launch: { pid: 42, pgid: 42, capturedAt: start, processIdentity: { kind: 'linux', pid: 42, pgid: 42, bootId: 'old-boot', startTicks: '123' } } },
    { kind: 'exited', graphRunId: f.run.graphRunId, generation: 1, owner: f.binding.owner, pid: 42, code: 0, signal: null, confirmedAt: start + 1, evidenceRef: `worker-exit:${randomUUID()}` },
  ];
  mutate(events, start);
  for (let i = 0; i < events.length; i++) f.db.prepare('INSERT INTO graph_worker_process_events(graph_run_id,generation,kind,event_json,observed_at) VALUES(?,?,?,?,?)')
    .run(f.run.graphRunId, 1, events[i]!.kind, workerCanonical(events[i]), start + i);
  return { ...f, now: start + 10, verify: () => verifyJournaledGraphWorkerExit(f.db, f.binding, start + 10) };
}
it('verifies a real parent-observed exit after reopening SQLite, including inside the G15 final transaction', async () => {
  const f = fixture(); const handle = f.runtime.start(f.start); expect(await handle.result).toBe(42); const exit = await handle.finalExit;
  expect(exit.kind).toBe('exited'); await f.runtime.close(); await f.runtime.drainDatabaseUsers();
  const path = f.db.name; f.db.close(); const db = openDb({ path });
  try {
    const worker = verifyJournaledGraphWorkerExit(db, f.binding);
    if (process.env['G25_EXIT_CHILD']) {
      const input = join(path, '..', 'exit-proof-input.json'); writeFileSync(input, JSON.stringify({ dbPath: path, binding: f.binding }));
      const child = execFileSync(process.execPath, [process.env['G25_EXIT_CHILD'], input], { encoding: 'utf8', timeout: 10000 });
      expect(JSON.parse(child)).toEqual(worker);
    }
    expect(worker).toMatchObject({ kind: 'stopped', generation: 1, owner: f.binding.owner });
    const store = new GraphRecoveryStore(db, (_s, proof) => { expect(db.inTransaction).toBe(true); expect(verifyJournaledGraphWorkerExit(db, f.binding)).toEqual(proof.worker); });
    const r = new GraphRunStore(db).get(f.run.scope, f.run.graphRunId)!; const fence = { scope: r.scope, graphRunId: r.graphRunId, identity: r.identity, expectedGeneration: r.generation, expectedRevision: r.revision, expectedOwner: r.leaseOwner, now: Date.now() };
    const snapshot = store.snapshot(fence); const inventory = store.inspectExecutors(fence); expect(inventory.requiredEffectKeys).toEqual([]);
    const proof = { worker, snapshotDigest: snapshot.digest, verifiedAt: Date.now(), executorEvidenceRef: 'no-admitted-effects', workspaceEvidenceRef: 'fixture-read-only-program' };
    expect(store.commit(snapshot, { kind: 'project', receiptId: 'journaled-exit', status: 'cancelled' }, proof, Date.now()).run.status).toBe('cancelled');
    // Historical evidence remains tied to the original generation; it cannot prove another one.
    expect(verifyJournaledGraphWorkerExit(db, f.binding)).toEqual(worker);
    expect(() => verifyJournaledGraphWorkerExit(db, { ...f.binding, generation: 2, owner: 'replacement' })).toThrow();
  } finally { db.close(); }
});
it('requires real exit even when a program result succeeded or lease expired', async () => {
  const f = fixture(); const ignoreKill = vi.spyOn(ChildProcess.prototype, 'kill').mockReturnValue(true);
  // Block the durable exit write; OS absence never fills the missing event.
  const observed = vi.spyOn(GraphProcessJournal.prototype, 'observed').mockImplementation(() => { throw Error('disk lost'); });
  try {
    const h = f.runtime.start(f.start); expect(await h.result).toBe(42);
    ignoreKill.mockRestore(); const exit = await h.finalExit; expect(exit.journalError).toContain('JOURNAL_FAILED');
    expect(() => verifyJournaledGraphWorkerExit(f.db, f.binding, Date.now() + 60000)).toThrow('UNPROVEN');
  } finally { ignoreKill.mockRestore(); observed.mockRestore(); }
});
it('does not promote an authenticated no-child event to an exited-worker proof', async () => {
  const f = fixture(); vi.spyOn(f.broker, 'register').mockImplementation(() => { throw Error('registration failure'); });
  expect((await f.runtime.start(f.start).finalExit).kind).toBe('spawn_failed');
  expect(() => verifyJournaledGraphWorkerExit(f.db, f.binding)).toThrow('UNPROVEN');
});
it.each(['pid', 'scope', 'owner', 'generation', 'journal-error', 'no-exit-status', 'two-exit-statuses', 'before-launch', 'unknown-field'])('rejects malformed durable exit %s', mode => {
  const f = synthetic((events, start) => {
    const exit = events[1]!;
    if (mode === 'pid') exit.pid = 99;
    else if (mode === 'scope') exit.graphRunId = 'other';
    else if (mode === 'owner') exit.owner = 'other';
    else if (mode === 'generation') exit.generation = 2;
    else if (mode === 'journal-error') exit.journalError = 'failed';
    else if (mode === 'no-exit-status') exit.code = null;
    else if (mode === 'two-exit-statuses') exit.signal = 'SIGTERM';
    else if (mode === 'before-launch') exit.confirmedAt = start - 1;
    else exit.workerSaysStopped = true;
  });
  expect(f.verify).toThrow();
});
it.each(['pid', 'pgid', 'captured-at', 'identity'])('rejects contradictory launch %s', mode => {
  const f = synthetic((events, start) => {
    const launch = events[0]!.launch as { pid: number; pgid: number; capturedAt: number; processIdentity: { startTicks: string; pid: number } };
    if (mode === 'pid') launch.processIdentity.pid = 99;
    else if (mode === 'pgid') launch.pgid = 99;
    else if (mode === 'captured-at') launch.capturedAt = start + 1;
    else launch.processIdentity.startTicks = 'not-ticks';
  }); expect(f.verify).toThrow();
});
it.each(['owner', 'scope', 'identity', 'future'])('rejects wrong binding or observation time %s', mode => {
  const f = synthetic(); const binding = structuredClone(f.binding); let now = f.now;
  if (mode === 'owner') binding.owner = 'other';
  else if (mode === 'scope') binding.scope.tenantId = 'other';
  else if (mode === 'identity') binding.identity.compiledProgramDigest = 'f'.repeat(64);
  else now -= 1000;
  expect(() => verifyJournaledGraphWorkerExit(f.db, binding, now)).toThrow();
});
it('accepts timeout followed by actual exit, and rejects timeout alone', () => {
  const f = synthetic((events, start) => { events[1]!.confirmedAt = start + 2; events.splice(1, 0, { kind: 'exit_unconfirmed', pid: 42, error: 'bounded timeout' }); });
  expect(f.verify()).toMatchObject({ kind: 'stopped' });
  const only = synthetic(events => { events[1] = { kind: 'exit_unconfirmed', pid: 42, error: 'timeout' }; }); expect(only.verify).toThrow('UNPROVEN');
});
it.each(['wrong-pid', 'after-exit', 'spawn-failed'])('rejects conflicting %s observation', mode => {
  const f = synthetic((events, start) => {
    events[1]!.confirmedAt = start + 2;
    const extra = mode === 'spawn-failed' ? { kind: 'spawn_failed', error: 'contradictory' } : { kind: 'exit_unconfirmed', pid: mode === 'wrong-pid' ? 99 : 42, error: 'timeout' };
    events.splice(mode === 'after-exit' ? 2 : 1, 0, extra);
  }); expect(f.verify).toThrow();
});
it('retains the original worker instance even when the same PID may be reused, without signals or OS queries', () => {
  const f = synthetic(); const kill = vi.spyOn(process, 'kill'); const first = f.verify();
  expect(f.verify()).toEqual(first); expect(kill).not.toHaveBeenCalled();
  expect(first.evidenceRef).toMatch(/^graph-worker-exit:[a-f0-9]{64}$/);
});

it.each(['registration', 'spawn'])('verifies a real %s failure after SQLite reopen and within a transaction without proving exit', async phase => {
  const f = fixture();
  if (phase === 'registration') vi.spyOn(f.broker, 'register').mockImplementation(() => { throw Error('registration failure'); });
  const runtime = phase === 'registration' ? f.runtime : new GraphRuntime({ ...f.options,
    workerOptions: { ...f.options.workerOptions, executable: join(f.db.name, '..', 'missing-executable') } });
  const event = await runtime.start(f.start).finalExit; expect(event).toMatchObject({ kind: 'spawn_failed', phase });
  await runtime.close(); await runtime.drainDatabaseUsers();
  await f.runtime.close(); await f.runtime.drainDatabaseUsers(); const path = f.db.name; f.db.close(); const db = openDb({ path });
  try {
    const proof = verifyJournaledGraphWorkerNotStarted(db, f.binding);
    expect(proof).toMatchObject({ kind: 'not_started', graphRunId: f.run.graphRunId, generation: 1, owner: f.binding.owner });
    if (event.kind === 'spawn_failed') expect(proof.evidenceRef).toBe(event.evidenceRef);
    for (const binding of [{ ...f.binding, owner: 'wrong' }, { ...f.binding, scope: { ...f.binding.scope, tenantId: 'wrong' } },
      { ...f.binding, identity: { ...f.binding.identity, compiledProgramDigest: 'f'.repeat(64) } }]) {
      expect(() => verifyJournaledGraphWorkerNotStarted(db, binding)).toThrow('GRAPH_NO_CHILD_PROOF_REQUIRED');
    }
    expect(db.transaction(() => verifyJournaledGraphWorkerNotStarted(db, f.binding)).immediate()).toEqual(proof);
    expect(() => verifyJournaledGraphWorkerExit(db, f.binding)).toThrow('UNPROVEN');
  } finally { db.close(); }
});
it.each(['owner', 'generation', 'run', 'phase', 'ref', 'journal-error', 'before-intent', 'future', 'extra-event', 'intent-only', 'no-intent'])('rejects invalid no-child evidence: %s', mode => {
  const f = fixture(); const now = Date.now(); const journal = new GraphProcessJournal(f.db);
  if (mode !== 'no-intent') journal.consume(f.binding);
  const event: Record<string, unknown> = { kind: 'spawn_failed', graphRunId: f.run.graphRunId, generation: 1, owner: f.binding.owner,
    confirmedAt: now + 1, evidenceRef: `worker-not-started:${randomUUID()}`, phase: 'spawn', error: 'ENOENT' };
  if (mode === 'owner') event.owner = 'other';
  else if (mode === 'generation') event.generation = 2;
  else if (mode === 'run') event.graphRunId = 'other';
  else if (mode === 'phase') event.phase = 'execute';
  else if (mode === 'ref') event.evidenceRef = 'worker-return-stopped';
  else if (mode === 'journal-error') event.journalError = 'disk failed';
  else if (mode === 'before-intent') event.confirmedAt = now - 100;
  else if (mode === 'future') event.confirmedAt = now + 10;
  if (!['intent-only', 'no-intent'].includes(mode)) {
    f.db.prepare('INSERT INTO graph_worker_process_events(graph_run_id,generation,kind,event_json,observed_at) VALUES(?,?,?,?,?)')
      .run(f.run.graphRunId, 1, 'spawn_failed', workerCanonical(event), now + 2);
    if (mode === 'extra-event') journal.observed(f.binding, { kind: 'exit_unconfirmed', pid: undefined, error: 'conflict' });
  }
  expect(() => verifyJournaledGraphWorkerNotStarted(f.db, f.binding, now + 3)).toThrow('GRAPH_NO_CHILD_PROOF_REQUIRED');
});

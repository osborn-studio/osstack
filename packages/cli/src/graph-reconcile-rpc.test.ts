import { expect, it, vi } from 'vitest';
import { GraphDelegationStatus } from '@osstack/protocol';
import { GraphRunStore, openDb } from '@osstack/core';
import { GraphActionBroker } from './graph-action-broker.js';
import { GraphProcessJournal } from './graph-process-journal.js';
import { GraphRpcService } from './graph-rpc.js';
import { graphRpcFixture } from './graph-test-fixture.js';

async function failedLaunch(missingJournal = false) {
  const f = await graphRpcFixture();
  const fail = vi.spyOn(GraphActionBroker.prototype, 'register').mockImplementation(() => { throw Error('injected registration failure'); });
  const journal = missingJournal ? vi.spyOn(GraphProcessJournal.prototype, 'observed').mockImplementation(() => { throw Error('injected journal failure'); }) : undefined;
  try {
    const started = await f.start();
    await f.until(started.graphRunId, s => s.status === 'reconciliation_required');
    await f.service.close();
    return { ...f, id: started.graphRunId };
  } catch (error) { await f.close(); throw error; }
  finally { fail.mockRestore(); journal?.mockRestore(); }
}
const cancel = (scope: unknown, graphRunId: string, expectedRevision: number, idempotencyKey = 'reconcile') =>
  ({ schemaVersion: 1, kind: 'cancel', scope, graphRunId, expectedRevision, idempotencyKey });

it('reconciles an actual registration failure from a fresh SQLite connection with admission disabled and unsupported adapters', async () => {
  const f = await failedLaunch(); const db = openDb({ path: f.db.name });
  delete f.writer.confirmStopped; delete f.reviewer.confirmStopped;
  const host = new GraphRpcService({ ...f.options, db, registrations: [{ ...f.registration, admitNewRuns: () => false }] });
  try {
    const before = await f.status(f.id, host); const request = cancel(f.request.scope, f.id, before.revision);
    const replies = await Promise.all([host.handle(f.connection, 'graph.reconcile', request), host.handle(f.connection, 'graph.reconcile', request)]);
    expect(replies.every(r => GraphDelegationStatus.parse(r).status === 'cancelled')).toBe(true);
    expect(await host.handle(f.connection, 'graph.reconcile', request)).toEqual(replies[0]);
    expect(await host.handle(f.connection, 'graph.cancel', request)).toEqual(replies[0]);
    expect(db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 1 });
    const row = db.prepare('SELECT proof_json,decision_json FROM graph_recovery_decisions').get() as { proof_json: string; decision_json: string };
    expect(JSON.parse(row.proof_json).worker.kind).toBe('not_started'); expect(JSON.parse(row.decision_json)).toMatchObject({ kind: 'project', status: 'cancelled' });
    expect(db.prepare("SELECT count(*) n FROM graph_worker_process_events WHERE kind='launched'").get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) n FROM graph_actions').get()).toEqual({ n: 0 }); expect(f.writes()).toBe(0);
    await expect(host.handle(f.connection, 'graph.reconcile', { ...request, expectedRevision: before.revision + 1 })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  } finally { await host.close(); db.close(); await f.close(); }
});

it('retries a previously acknowledged cancellation intent once no-child proof can be checked', async () => {
  const f = await failedLaunch(); const host = new GraphRpcService(f.options);
  try {
    const before = await f.status(f.id, host); const request = cancel(f.request.scope, f.id, before.revision);
    expect(await host.handle(f.connection, 'graph.cancel', request)).toMatchObject({ status: 'cancel_pending' });
    expect(await host.handle(f.connection, 'graph.cancel', request)).toMatchObject({ status: 'cancel_pending' });
    expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 0 });
    expect(await host.handle(f.connection, 'graph.reconcile', request)).toMatchObject({ status: 'cancelled' });
  } finally { await host.close(); await f.close(); }
});

it('drains an in-flight reconciliation before closing its database', async () => {
  const f = await failedLaunch(); const db = openDb({ path: f.db.name }); const host = new GraphRpcService({ ...f.options, db });
  try {
    const before = await f.status(f.id, host);
    const response = host.handle(f.connection, 'graph.reconcile', cancel(f.request.scope, f.id, before.revision));
    await host.close(); db.close();
    expect(await response).toMatchObject({ status: 'cancelled' });
    expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 1 });
  } finally { await host.close(); if (db.open) db.close(); await f.close(); }
});

it.each(['connection', 'scope', 'revision', 'forged-proof'])('rejects %s before cancellation admission', async mode => {
  const f = await failedLaunch(); const host = new GraphRpcService(f.options);
  try {
    const before = await f.status(f.id, host); const request = cancel(f.request.scope, f.id, before.revision);
    const input = mode === 'scope' ? { ...request, scope: { ...f.request.scope, tenantId: 'other' } }
      : mode === 'revision' ? { ...request, expectedRevision: before.revision + 1 }
        : mode === 'forged-proof' ? { ...request, evidenceRefs: ['not-authority'] } : request;
    await expect(host.handle(mode === 'connection' ? {} : f.connection, 'graph.reconcile', input)).rejects.toThrow();
    expect(await f.status(f.id, host)).toEqual(before);
    expect(f.db.prepare("SELECT count(*) n FROM graph_requests WHERE idempotency_key='reconcile'").get()).toEqual({ n: 0 });
  } finally { await host.close(); await f.close(); }
});

it.each(['missing-journal', 'checkpoint', 'unobserved-generation'])('retains uncertainty when %s prevents all-generation absence proof', async mode => {
  const f = await failedLaunch(mode === 'missing-journal'); const host = new GraphRpcService(f.options);
  try {
    if (mode === 'checkpoint') f.db.prepare('INSERT INTO graph_checkpoint_writes VALUES (?,?,?,?,?,?,?)').run(f.id, '', 'cp', 'task', 0, 'value', '1');
    if (mode === 'unobserved-generation') {
      // A previous no-child journal cannot stand in for an unobserved generation.
      f.db.prepare('UPDATE graph_runs SET generation=2,revision=revision+1 WHERE graph_run_id=?').run(f.id);
      f.db.prepare("INSERT INTO graph_worker_leases SELECT graph_run_id,2,owner,acquired_at,expires_at,'{}' FROM graph_worker_leases WHERE graph_run_id=? AND generation=1").run(f.id);
    }
    const before = await f.status(f.id, host); const request = cancel(f.request.scope, f.id, before.revision);
    expect(await host.handle(f.connection, 'graph.reconcile', request)).toMatchObject({ status: 'cancel_pending', delivery: 'delivery_unknown' });
    expect(await host.handle(f.connection, 'graph.reconcile', request)).toMatchObject({ status: 'cancel_pending' });
    expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 0 });
    expect(f.writes()).toBe(0);
  } finally { await host.close(); await f.close(); }
});

it('keeps actual unknown external work and its admission held on a fresh host', async () => {
  const f = await graphRpcFixture('unknown'); let host: GraphRpcService | undefined;
  try {
    const start = await f.start(); await f.until(start.graphRunId, s => s.status === 'reconciliation_required'); await f.service.close();
    host = new GraphRpcService(f.options); const before = await f.status(start.graphRunId, host);
    expect(await host.handle(f.connection, 'graph.reconcile', cancel(f.request.scope, start.graphRunId, before.revision))).toMatchObject({ status: 'cancel_pending', delivery: 'delivery_unknown' });
    expect(f.db.prepare('SELECT count(*) n FROM graph_action_admissions WHERE released_at IS NULL').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 0 }); expect(f.writes()).toBe(1);
  } finally { await host?.close(); await f.close(); }
}, 30000);

it('does not use an old cancellation key to reconcile a later run revision', async () => {
  const f = await failedLaunch(); const host = new GraphRpcService(f.options);
  try {
    const before = await f.status(f.id, host); const request = cancel(f.request.scope, f.id, before.revision);
    await host.handle(f.connection, 'graph.cancel', request);
    f.db.prepare('UPDATE graph_runs SET revision=revision+1 WHERE graph_run_id=?').run(f.id);
    expect(await host.handle(f.connection, 'graph.reconcile', request)).toMatchObject({ status: 'cancel_pending' });
    expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 0 });
    const current = await f.status(f.id, host);
    expect(await host.handle(f.connection, 'graph.reconcile', cancel(f.request.scope, f.id, current.revision, 'current'))).toMatchObject({ status: 'cancelled' });
  } finally { await host.close(); await f.close(); }
});

it.each(['denied', 'commit-revoked', 'expired-deadline'])('enforces current cancel permission and final transaction while handling %s', async mode => {
  const f = await failedLaunch();
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  const host = new GraphRpcService({ ...f.options, registrations: [{ ...f.registration, authorize: operation => {
    if (operation === 'cancel' && (mode === 'denied' || (mode === 'commit-revoked' && f.db.inTransaction))) throw Error('GRANT_EXPIRED');
  } }] });
  try {
    if (mode === 'expired-deadline') clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300000);
    if (mode === 'expired-deadline') expect(new GraphRunStore(f.db).get(f.request.scope, f.id)!.leaseExpiresAt!).toBeLessThan(Date.now());
    const before = await f.status(f.id, host); const request = cancel(f.request.scope, f.id, before.revision);
    if (mode === 'expired-deadline') expect(await host.handle(f.connection, 'graph.reconcile', request)).toMatchObject({ status: 'cancelled' });
    else { await expect(host.handle(f.connection, 'graph.reconcile', request)).rejects.toThrow('GRANT_EXPIRED');
      expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 0 }); }
    expect(new GraphRunStore(f.db).get(f.request.scope, f.id)!.generation).toBe(1);
  } finally { clock?.mockRestore(); await host.close(); await f.close(); }
});

it.each(['graph.cancel', 'graph.reconcile'])('acknowledges durable intent when concurrent %s advances the proof snapshot', async competingMethod => {
  const f = await failedLaunch(); const host = new GraphRpcService(f.options);
  try {
    const before = await f.status(f.id, host);
    const first = host.handle(f.connection, 'graph.reconcile', cancel(f.request.scope, f.id, before.revision, 'first'));
    const intervening = await f.status(f.id, host);
    const second = host.handle(f.connection, competingMethod, cancel(f.request.scope, f.id, intervening.revision, 'second'));
    const results = await Promise.all([first, second]);
    expect(results.every(r => ['cancel_pending', 'cancelled'].includes(GraphDelegationStatus.parse(r).status))).toBe(true);
    if (competingMethod === 'graph.cancel') {
      expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 0 });
      const current = await f.status(f.id, host);
      await host.handle(f.connection, 'graph.reconcile', cancel(f.request.scope, f.id, current.revision, 'third'));
    }
    expect(await f.status(f.id, host)).toMatchObject({ status: 'cancelled' });
    expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 1 });
  } finally { await host.close(); await f.close(); }
});

it('reconcile signals the actual live writer and leaves settlement to its supervisor', async () => {
  const f = await graphRpcFixture('cancel');
  try {
    const started = await f.start(); await f.until(started.graphRunId, () => f.writes() === 1);
    const before = await f.status(started.graphRunId);
    expect(await f.service.handle(f.connection, 'graph.reconcile', cancel(f.request.scope, started.graphRunId, before.revision))).toMatchObject({ status: 'cancel_pending' });
    expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 0 });
    await f.until(started.graphRunId, s => s.status === 'cancelled'); expect(f.abortObserved()).toBe(true);
    expect(f.db.prepare('SELECT count(*) n FROM graph_action_admissions WHERE released_at IS NULL').get()).toEqual({ n: 0 });
  } finally { await f.close(); }
}, 30000);

it('recovers a persisted preworker cancellation intent without creating a worker or a G15 decision', async () => {
  const f = await graphRpcFixture(); const host = new GraphRpcService(f.options);
  try {
    const started = await f.start(); const request = cancel(f.request.scope, started.graphRunId, started.revision);
    const runs = new GraphRunStore(f.db); const run = runs.get(f.request.scope, started.graphRunId)!;
    // Emulate host loss between durable intent and generation-0 final projection.
    runs.projectRequest({ ...request, kind: 'cancel' as const, schemaVersion: 1 as const, scope: f.request.scope }, { scope: run.scope, graphRunId: run.graphRunId,
      identity: run.identity, expectedGeneration: 0, expectedOwner: null, expectedRevision: run.revision, now: Date.now(), status: 'cancel_pending' });
    expect(await host.handle(f.connection, 'graph.reconcile', request)).toMatchObject({ status: 'cancelled', generation: 0 });
    expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 0 });
    await new Promise(resolve => setImmediate(resolve)); expect(f.writes()).toBe(0);
  } finally { await host.close(); await f.close(); }
});

it('returns successful cancellation after a grant expires strictly after the final G15 commit', async () => {
  const f = await failedLaunch();
  const host = new GraphRpcService({ ...f.options, registrations: [{ ...f.registration, authorize: operation => {
    if (operation === 'cancel' && f.db.prepare('SELECT 1 FROM graph_recovery_decisions').get()) throw Error('GRANT_EXPIRED');
  } }] });
  try {
    const before = await f.status(f.id, host);
    expect(await host.handle(f.connection, 'graph.reconcile', cancel(f.request.scope, f.id, before.revision))).toMatchObject({ status: 'cancelled' });
  } finally { await host.close(); await f.close(); }
});

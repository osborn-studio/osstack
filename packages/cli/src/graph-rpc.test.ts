import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { GraphRpcService, loadLocalGraphRegistration } from './graph-rpc.js';
import { graphRpcFixture as fixture } from './graph-test-fixture.js';
it('durably reserves before launch; concurrent replay and fresh service replay never launch twice; ready is atomic v1 evidence', async () => {
  const f = await fixture();
  try {
    const responses = await Promise.all([f.start(), f.start(), f.start()]); const first = responses[0]!;
    expect(new Set(responses.map(r => r.graphRunId)).size).toBe(1); expect(first.status).toBe('queued'); expect(f.writes()).toBe(0);
    await expect(f.service.handle(f.connection, 'graph.submit', { ...f.request, inputArtifactRef: 'other' })).rejects.toThrow();
    const ready = await f.until(first.graphRunId, s => s.status === 'ready'); expect(ready.candidate).toBeDefined(); expect(ready.resultRef).toMatch(/^graph-join:/);
    expect(ready.source).toEqual(f.request.source); expect(ready.budget.actionStarts).toBe(7); expect(f.writes()).toBe(1);
    const second = new GraphRpcService(f.options);
    expect(await second.handle(f.connection, 'graph.submit', f.request)).toEqual(ready);
    expect(await second.handle(f.connection, 'graph.result', { schemaVersion: 1, scope: f.request.scope, graphRunId: ready.graphRunId })).toEqual(ready);
    await second.close(); expect(f.db.prepare('SELECT count(*) n FROM graph_worker_launches').get()).toEqual({ n: 1 });
    expect(await readFile(join(f.root, 'source', 'answer'), 'utf8')).toBe('0\n');
  } finally { await f.close(); }
}, 30000);
it('authenticates host capabilities and rejects scope/source/client command injection before reservation', async () => {
  const f = await fixture();
  try {
    await expect(f.service.handle({}, 'graph.start', f.request)).rejects.toThrow('UNAUTHENTICATED');
    await expect(f.service.handle(f.connection, 'graph.start', { ...f.request, source: { product: 'osbot', requestId: 'other' } })).rejects.toThrow('UNAUTHENTICATED');
    await expect(f.service.handle(f.connection, 'graph.start', { ...f.request, scope: { ...f.request.scope, tenantId: 'other' } })).rejects.toThrow('SCOPE_MISMATCH');
    await expect(f.service.handle(f.connection, 'graph.start', { ...f.request, command: 'touch /tmp/no' })).rejects.toThrow();
    expect(f.db.prepare('SELECT count(*) n FROM graph_runs').get()).toEqual({ n: 0 });
  } finally { await f.close(); }
});
it('cancel before construction is durable, replayable and never launches', async () => {
  const f = await fixture();
  try { const queued = await f.start(); const cancel = { schemaVersion: 1, kind: 'cancel', scope: f.request.scope, idempotencyKey: 'cancel', graphRunId: queued.graphRunId, expectedRevision: queued.revision };
    expect(await f.service.handle(f.connection, 'graph.cancel', cancel)).toMatchObject({ status: 'cancelled' });
    expect(await f.service.handle(f.connection, 'graph.cancel', cancel)).toMatchObject({ status: 'cancelled' });
    await new Promise(resolve => setImmediate(resolve)); expect(f.writes()).toBe(0);
  } finally { await f.close(); }
});
it('persisted cancel intent drives actual worker/executor abort and confirmed stop through G15', async () => {
  const f = await fixture('cancel');
  try { const run = await f.start(); await f.until(run.graphRunId, () => f.writes() === 1);
    f.grant(false); // Execute is revoked; current cancel permission still stops finite work.
    const before = await f.status(run.graphRunId);
    const requested = await f.service.handle(f.connection, 'graph.cancel', { schemaVersion: 1, kind: 'cancel', scope: f.request.scope, idempotencyKey: 'cancel', graphRunId: run.graphRunId, expectedRevision: before.revision });
    expect(requested).toMatchObject({ status: 'cancel_pending', delivery: 'delivery_unknown' });
    await f.until(run.graphRunId, s => s.status === 'cancelled'); expect(f.abortObserved()).toBe(true);
    expect(f.db.prepare('SELECT count(*) n FROM graph_action_admissions WHERE released_at IS NULL').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 1 });
  } finally { await f.close(); }
}, 30000);
it('quality interrupt binds input/revision/current grants and resumes actual checkpoint through G15', async () => {
  const f = await fixture('repair');
  try { const first = await f.start(); const waiting = await f.until(first.graphRunId, s => s.status === 'waiting_input');
    expect(waiting.interrupt?.kind).toBe('quality'); expect(waiting.candidate).toBeDefined(); expect(f.writes()).toBe(1);
    const resume = { schemaVersion: 1, kind: 'resume', scope: f.request.scope, idempotencyKey: 'resume', graphRunId: first.graphRunId, expectedRevision: waiting.revision,
      interruptId: waiting.interrupt!.interruptId, input: { kind: 'data', value: { inputDigest: waiting.inputDigest } } };
    await expect(f.service.handle(f.connection, 'graph.resume', { ...resume, input: { kind: 'data', value: true } })).rejects.toThrow('INPUT_CONTRACT_INVALID');
    await expect(f.service.handle(f.connection, 'graph.resume', { ...resume, interruptId: 'stale' })).rejects.toThrow('REVISION_CONFLICT');
    f.grant(false); expect(await f.status(first.graphRunId)).toMatchObject({ authorization: { kind: 'needs_authorization', scope: f.request.scope } });
    await expect(f.service.handle(f.connection, 'graph.resume', resume)).rejects.toThrow('GRANT_EXPIRED');
    f.grant(true); await f.service.handle(f.connection, 'graph.resume', resume);
    await f.service.handle(f.connection, 'graph.resume', resume);
    const ready = await f.until(first.graphRunId, s => s.status === 'ready'); expect(ready.createdAt).toBe(first.createdAt); expect(ready.generation).toBe(2); expect(f.writes()).toBe(2);
    expect(ready.budget.actionStarts).toBe(14); expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 1 });
  } finally { await f.close(); }
}, 45000);
it('lost supervisor cannot resume durable waiting evidence or mint a new launch', async () => {
  const f = await fixture('repair');
  try { const first = await f.start(); const waiting = await f.until(first.graphRunId, s => s.status === 'waiting_input');
    const replacement = new GraphRpcService(f.options);
    expect(await f.status(first.graphRunId, replacement)).toEqual(waiting);
    await expect(replacement.handle(f.connection, 'graph.resume', { schemaVersion: 1, kind: 'resume', scope: f.request.scope, idempotencyKey: 'resume', graphRunId: first.graphRunId,
      expectedRevision: waiting.revision, interruptId: waiting.interrupt!.interruptId, input: { kind: 'data', value: { inputDigest: waiting.inputDigest } } })).rejects.toThrow('ACTION_OUTCOME_UNKNOWN');
    await replacement.close(); expect(f.writes()).toBe(1);
  } finally { await f.close(); }
}, 30000);
it('unknown external stop retains holds and cannot become cancelled from Promise drainage', async () => {
  const f = await fixture('unknown');
  try { const first = await f.start(); const unknown = await f.until(first.graphRunId, s => s.status === 'reconciliation_required');
    expect(unknown.delivery).toBe('delivery_unknown');
    expect(f.db.prepare('SELECT count(*) n FROM graph_action_admissions WHERE released_at IS NULL').get()).toEqual({ n: 1 });
    await f.service.handle(f.connection, 'graph.cancel', { schemaVersion: 1, kind: 'cancel', scope: f.request.scope, idempotencyKey: 'cancel', graphRunId: first.graphRunId, expectedRevision: unknown.revision });
    await f.service.close(); expect((await new GraphRpcService(f.options).handle(f.connection, 'graph.status', { schemaVersion: 1, scope: f.request.scope, graphRunId: first.graphRunId }))).toMatchObject({ status: 'cancel_pending', delivery: 'delivery_unknown' });
    expect(f.db.prepare('SELECT count(*) n FROM graph_action_admissions WHERE released_at IS NULL').get()).toEqual({ n: 1 });
  } finally { await f.close(); }
}, 30000);
it('close persists cancellation and drains a live executor before returning', async () => {
  const f = await fixture('cancel');
  try { const first = await f.start(); await f.until(first.graphRunId, () => f.writes() === 1);
    await f.service.close(); expect(f.abortObserved()).toBe(true);
    const replacement = new GraphRpcService(f.options); expect(await f.status(first.graphRunId, replacement)).toMatchObject({ status: 'cancelled' }); await replacement.close();
  } finally { await f.close(); }
}, 30000);
it('expired waiting lease refuses resume before acknowledging or spending a new budget', async () => {
  const f = await fixture('repair');
  try { const first = await f.start(); const waiting = await f.until(first.graphRunId, s => s.status === 'waiting_input');
    f.db.prepare('UPDATE graph_runs SET lease_expires_at=? WHERE graph_run_id=?').run(Date.now() - 1, first.graphRunId);
    await expect(f.service.handle(f.connection, 'graph.resume', { schemaVersion: 1, kind: 'resume', scope: f.request.scope, idempotencyKey: 'resume', graphRunId: first.graphRunId,
      expectedRevision: waiting.revision, interruptId: waiting.interrupt!.interruptId, input: { kind: 'data', value: { inputDigest: waiting.inputDigest } } })).rejects.toThrow('GRANT_EXPIRED');
    expect(f.db.prepare("SELECT count(*) n FROM graph_requests WHERE kind='resume'").get()).toEqual({ n: 0 }); expect(f.writes()).toBe(1);
  } finally { await f.close(); }
}, 30000);
it('trusted local configuration renews only grants while preserving immutable host bindings', async () => {
  const f = await fixture();
  try {
    const path = join(f.root, 'graph-host.json');
    const registration = { id: 'local', scope: f.request.scope, repositoryRef: 'repo', repositoryPath: join(f.root, 'source'), taskRef: 'task', task: 'Set answer to 1', inputArtifactRef: 'input',
      writer: { agentId: 'writer', capabilityId: 'write' }, reviewer: { agentId: 'reviewer', capabilityId: 'review' }, acceptanceRegistry: f.registration.delivery.acceptanceRegistry,
      grant: { scope: f.request.scope, expiresAt: Date.now() + 60000, operations: ['read', 'execute', 'cancel', 'resume'] } };
    const save = () => writeFile(path, JSON.stringify({ schemaVersion: 1, registration }), { mode: 0o600 }); await save();
    const trusted = await loadLocalGraphRegistration(path, new Map([['writer', f.writer], ['reviewer', f.reviewer]]));
    registration.grant.expiresAt = 1; await save(); expect(() => trusted.authorize()).toThrow('GRANT_EXPIRED'); expect(() => trusted.authorize('read')).not.toThrow();
    registration.grant.expiresAt = Date.now() + 60000; await save(); expect(() => trusted.authorize()).not.toThrow();
    registration.task = 'different host task'; await save(); expect(() => trusted.authorize()).toThrow('GRANT_EXPIRED');
  } finally { await f.close(); }
});

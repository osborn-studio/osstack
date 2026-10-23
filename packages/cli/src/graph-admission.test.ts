import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { GraphDelegationStatus } from '@osstack/protocol';
import { GraphDelivery } from './graph-delivery.js';
import { GraphRpcService, loadLocalGraphRegistration } from './graph-rpc.js';
import { graphRpcFixture as fixture } from './graph-test-fixture.js';

it.each(['writer', 'reviewer'] as const)('refuses unsupported %s before reservation or direct delivery construction', async role => {
  const f = await fixture(); expect(f.registration.delivery[role].adapter).toBe(f[role]); delete f[role].confirmStopped;
  const service = new GraphRpcService(f.options);
  try {
    await expect(service.handle(f.connection, 'graph.start', f.request)).rejects.toThrow('EXECUTOR_UNSUPPORTED');
    expect(() => new GraphDelivery({ ...f.registration.delivery, db: f.db, root: f.options.root, request: f.request,
      acquire: f.options.acquire, authorize: f.registration.authorize })).toThrow('EXECUTOR_UNSUPPORTED');
    for (const table of ['graph_runs', 'graph_requests', 'graph_actions', 'graph_action_admissions', 'graph_worker_launches']) {
      expect(f.db.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(existsSync(f.options.root)).toBe(false); expect(f.writes()).toBe(0);
  } finally { await service.close(); await f.close(); }
});

it('disables new admission while retaining reads, exact replay and cancellation of admitted live work', async () => {
  const f = await fixture('cancel'); let enabled = true;
  const service = new GraphRpcService({ ...f.options, registrations: [{ ...f.registration, admitNewRuns: () => enabled }] });
  try {
    const run = GraphDelegationStatus.parse(await service.handle(f.connection, 'graph.start', f.request));
    // A reservation is the cutoff: disabling while queued must not strand admitted work.
    enabled = false;
    await expect.poll(f.writes, { timeout: 15000 }).toBe(1);
    await expect(service.handle(f.connection, 'graph.start', { ...f.request, idempotencyKey: 'new' })).rejects.toThrow('GRAPH_ADMISSION_DISABLED');
    expect(await service.handle(f.connection, 'graph.submit', f.request)).toMatchObject({ graphRunId: run.graphRunId });
    await expect(service.handle(f.connection, 'graph.submit', { ...f.request, source: { ...f.request.source, requestId: 'changed' } })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    const current = await f.status(run.graphRunId, service);
    expect(await service.handle(f.connection, 'graph.result', { schemaVersion: 1, scope: f.request.scope, graphRunId: run.graphRunId })).toEqual(current);
    await service.handle(f.connection, 'graph.cancel', { schemaVersion: 1, kind: 'cancel', scope: f.request.scope, graphRunId: run.graphRunId,
      expectedRevision: current.revision, idempotencyKey: 'cancel' });
    await expect.poll(async () => (await f.status(run.graphRunId, service)).status, { timeout: 15000 }).toBe('cancelled');
    expect(f.abortObserved()).toBe(true);
    expect(f.db.prepare('SELECT count(*) n FROM graph_runs').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT count(*) n FROM graph_worker_launches').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT count(*) n FROM graph_action_admissions WHERE released_at IS NULL').get()).toEqual({ n: 0 });
  } finally { await service.close(); await f.close(); }
}, 30000);

it('fresh hosts retain queued run replay and cancellation even when the adapter is now unsupported', async () => {
  const f = await fixture(); let replacement: GraphRpcService | undefined;
  try {
    const run = await f.start(); delete f.writer.confirmStopped;
    replacement = new GraphRpcService({ ...f.options, registrations: [{ ...f.registration, admitNewRuns: () => false }] });
    expect(await replacement.handle(f.connection, 'graph.start', f.request)).toMatchObject({ graphRunId: run.graphRunId });
    expect(await f.status(run.graphRunId, replacement)).toMatchObject({ status: 'queued' });
    await replacement.handle(f.connection, 'graph.cancel', { schemaVersion: 1, kind: 'cancel', scope: f.request.scope, graphRunId: run.graphRunId,
      expectedRevision: run.revision, idempotencyKey: 'cancel' });
    expect(await f.status(run.graphRunId, replacement)).toMatchObject({ status: 'cancelled' });
    await new Promise(resolve => setImmediate(resolve)); expect(f.writes()).toBe(0);
  } finally { await replacement?.close(); await f.close(); }
});

it('admission disabled still permits an authorized live quality resume of the existing run', async () => {
  // Two real Git preparation pipelines: use the fixture's standard 20s
  // observation bound. This does not change worker/lease/deadline limits.
  const f = await fixture('repair'); let enabled = true;
  const service = new GraphRpcService({ ...f.options, registrations: [{ ...f.registration, admitNewRuns: () => enabled }] });
  try {
    const run = GraphDelegationStatus.parse(await service.handle(f.connection, 'graph.start', f.request)); enabled = false;
    await expect.poll(async () => (await f.status(run.graphRunId, service)).status, { timeout: 20000 }).toBe('waiting_input');
    const waiting = await f.status(run.graphRunId, service);
    await service.handle(f.connection, 'graph.resume', { schemaVersion: 1, kind: 'resume', scope: f.request.scope, graphRunId: run.graphRunId,
      expectedRevision: waiting.revision, idempotencyKey: 'resume', interruptId: waiting.interrupt!.interruptId,
      input: { kind: 'data', value: { inputDigest: waiting.inputDigest } } });
    await expect.poll(async () => (await f.status(run.graphRunId, service)).status, { timeout: 20000 }).toBe('ready');
    expect(f.writes()).toBe(2); expect(f.db.prepare('SELECT count(*) n FROM graph_runs').get()).toEqual({ n: 1 });
  } finally { await service.close(); await f.close(); }
}, 45000);

it.each(['async', 'number', 'string', 'undefined'])('rejects %s admission results without reserving or treating truthiness as permission', async kind => {
  const f = await fixture();
  const gate = () => kind === 'async' ? Promise.reject(Error('async gate')) : kind === 'number' ? 1 : kind === 'string' ? 'true' : undefined;
  const service = new GraphRpcService({ ...f.options, registrations: [{ ...f.registration,
    admitNewRuns: gate as unknown as () => boolean }] });
  try {
    await expect(service.handle(f.connection, 'graph.start', f.request)).rejects.toThrow('GRAPH_ADMISSION_DISABLED');
    expect(f.db.prepare('SELECT count(*) n FROM graph_runs').get()).toEqual({ n: 0 });
  } finally { await service.close(); await f.close(); }
});

it('reloads the owner-only admission switch without changing immutable bindings or read/cancel grants', async () => {
  const f = await fixture(); let service: GraphRpcService | undefined;
  try {
    const path = join(f.root, 'graph-host.json');
    const config = { schemaVersion: 1, admissionEnabled: false, registration: { id: 'local', scope: f.request.scope,
      repositoryRef: 'repo', repositoryPath: join(f.root, 'source'), taskRef: 'task', task: 'Set answer to 1', inputArtifactRef: 'input',
      writer: { agentId: 'writer', capabilityId: 'write' }, reviewer: { agentId: 'reviewer', capabilityId: 'review' },
      acceptanceRegistry: f.registration.delivery.acceptanceRegistry,
      grant: { scope: f.request.scope, expiresAt: Date.now() + 60000, operations: ['read', 'execute', 'cancel', 'resume'] } } };
    const save = () => writeFile(path, JSON.stringify(config), { mode: 0o600 }); await save();
    const registration = await loadLocalGraphRegistration(path, new Map([['writer', f.writer], ['reviewer', f.reviewer]]));
    const { admissionEnabled: _disabled, ...legacy } = config;
    await writeFile(path, JSON.stringify(legacy), { mode: 0o600 }); expect(registration.admitNewRuns!()).toBe(true);
    await save();
    service = new GraphRpcService({ ...f.options, registrations: [registration] });
    await expect(service.handle(f.connection, 'graph.start', f.request)).rejects.toThrow('GRAPH_ADMISSION_DISABLED');
    config.admissionEnabled = true; await save();
    const run = GraphDelegationStatus.parse(await service.handle(f.connection, 'graph.start', f.request));
    // Cancel synchronously before the deferred launch; a config write would yield to it.
    await service.handle(f.connection, 'graph.cancel', { schemaVersion: 1, kind: 'cancel', scope: f.request.scope, graphRunId: run.graphRunId,
      expectedRevision: run.revision, idempotencyKey: 'cancel' });
    config.admissionEnabled = false; await save();
    expect(await service.handle(f.connection, 'graph.submit', f.request)).toMatchObject({ status: 'cancelled' });
    expect(() => registration.authorize('read')).not.toThrow(); expect(() => registration.authorize('cancel')).not.toThrow();
    expect(f.db.prepare('SELECT count(*) n FROM graph_runs').get()).toEqual({ n: 1 }); expect(f.writes()).toBe(0);
  } finally { await service?.close(); await f.close(); }
});

import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { openDb, CapabilitySchema } from '@osstack/core';
import type { AgentAdapter } from '@osstack/agents';
import { GraphRpcService } from './graph-rpc.js';
import type { StartGraphRequest } from '@osstack/protocol';
const gate = vi.hoisted(() => ({ path: '', entered: false, wait: Promise.resolve() }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, mkdir: async (...args: Parameters<typeof original.mkdir>) => {
    if (String(args[0]).startsWith(gate.path) && gate.path) { gate.entered = true; await gate.wait; }
    return original.mkdir(...args);
  } };
});
afterEach(() => { gate.path = ''; gate.entered = false; vi.useRealTimers(); });
it('graceful close waits beyond the former timeout for prelaunch I/O before allowing SQLite close', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-shutdown-')));
  const repository = join(root, 'repo'); await mkdir(repository);
  const db = openDb({ path: join(root, 'state.sqlite') }); let release = () => {};
  const connection = {};
  const writer: AgentAdapter = { id: 'writer', display_name: 'writer', cost_tier: 'low',
    capabilities: () => [CapabilitySchema.parse({ id: 'write', agent_id: 'writer', kind: 'code.write', description: 'write' })],
    isAvailable: async () => ({ available: true, last_checked_at: 0 }), invoke: () => { throw Error('NO_EXECUTION_EXPECTED'); } };
  const scope = { schemaVersion: 1 as const, tenantId: 'local', principalId: 'owner', workspaceId: 'repo' };
  const service = new GraphRpcService({ db, root: join(root, 'delivery'), registrations: [{ id: 'owner', scope, product: 'osstack', repositoryRef: 'repo', taskRef: 'task', inputArtifactRef: 'input', authorize: () => {},
    delivery: { repositoryPath: repository, task: 'task', writer: { identity: 'writer', adapter: writer, capabilityId: 'write' }, reviewer: { identity: 'reviewer', adapter: { ...writer, id: 'reviewer' }, capabilityId: 'review' },
      acceptanceRegistry: [{ ref: 'tests', command: 'true', passExitCodes: [0], failExitCodes: [1] }], verifyReviewer: async () => {} } }],
    resolveCaller: key => key === connection ? 'owner' : null, acquire: async () => { throw Error('NO_ADMISSION_EXPECTED'); } });
  const request: StartGraphRequest = { schemaVersion: 1, kind: 'start', scope, idempotencyKey: 'one', inputArtifactRef: 'input', source: { product: 'osstack', requestId: 'source' },
    spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only', input: { repositoryRef: 'repo', taskRef: 'task', baseRevision: 'a'.repeat(40), acceptanceRef: 'tests' },
      limits: { maxEpochs: 1, maxBranchAttempts: 1, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 7, deadlineSeconds: 60, tokenReservationLimit: 49152 } } };
  gate.path = join(root, 'delivery'); gate.wait = new Promise<void>(resolve => { release = resolve; });
  try {
    await service.handle(connection, 'graph.start', request);
    await expect.poll(() => gate.entered).toBe(true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let finished = false; const closing = service.close().then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(16000);
    expect(finished).toBe(false); expect(db.open).toBe(true);
    release(); await closing;
    expect(db.prepare('SELECT generation,status FROM graph_runs').get()).toEqual({ generation: 0, status: 'cancelled' });
    db.close(); expect(finished).toBe(true);
  } finally { release(); vi.useRealTimers(); await service.close(); if (db.open) db.close(); await rm(root, { recursive: true, force: true }); }
});

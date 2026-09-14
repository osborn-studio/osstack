import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { GraphRunStore, openDb, type GraphProgramVersion, type GraphRun } from '@osstack/core';
import type { StartGraphRequest } from '@osstack/protocol';
import { startDaemon, type DaemonHandles } from './daemon.js';

const roots: string[] = []; const handles: DaemonHandles[] = [];
const previousHome = process.env['OSSTACK_HOME'];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
  if (previousHome === undefined) delete process.env['OSSTACK_HOME']; else process.env['OSSTACK_HOME'] = previousHome;
  await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true })));
});
it('owns checkpoint transactions in the real daemon and refuses unregistered channels and closed services', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cpd-')); roots.push(root);
  process.env['OSSTACK_HOME'] = root;
  const db = openDb({ path: join(root, 'state.db') });
  const scope = { schemaVersion: 1 as const, tenantId: 'tenant', principalId: 'principal', workspaceId: 'workspace' };
  const program: GraphProgramVersion = { executionModel: 'langgraph-functional-v1', durability: 'sync', engineVersion: '1.4.15', checkpointVersion: '1.1.5', templateVersion: '1', registryVersion: '1', compilerVersion: '1', schemaVersion: '1', compiledProgramDigest: 'b'.repeat(64) };
  const request: StartGraphRequest = { schemaVersion: 1, kind: 'start', scope, idempotencyKey: 'start', inputArtifactRef: 'input', source: { product: 'osstack', requestId: 'request' }, spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only', input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: 'a'.repeat(40), acceptanceRef: 'acceptance' }, limits: { maxEpochs: 1, maxBranchAttempts: 2, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 10, deadlineSeconds: 60, tokenReservationLimit: 100 } } };
  let run: GraphRun;
  try {
    const runs = new GraphRunStore(db); const initial = runs.create(request, program, Date.now());
    run = runs.acquireLease({ scope, graphRunId: initial.graphRunId, identity: initial.identity, expectedGeneration: 0, expectedRevision: 0, expectedOwner: null, now: Date.now(), owner: 'worker', leaseExpiresAt: Date.now() + 60_000 });
  } finally { db.close(); }
  const connection = {};
  const daemon = await startDaemon({ socketPath: join(root, 'daemon.sock'), adapters: [],
    graphCheckpointBindings: new Map([[connection, { scope, graphRunId: run.graphRunId, generation: run.generation, owner: 'worker', identity: run.identity, authorize: async () => {} }]]),
  }); handles.push(daemon);
  const value = { kind: 'put', requestId: 'request1', threadId: run.graphRunId, namespace: '', checkpointId: 'checkpoint1', checkpoint: '["osstack-checkpoint",1,null]', metadata: '["osstack-checkpoint",1,null]', newVersions: '["osstack-checkpoint",1,null]' };
  await expect(daemon.executeGraphCheckpoint({}, value)).rejects.toThrow('UNAUTHENTICATED');
  await expect(daemon.executeGraphCheckpoint(connection, value)).resolves.toEqual({ kind: 'put', checkpointId: 'checkpoint1' });
  const committed = openDb({ path: daemon.dbPath });
  try { expect(new GraphRunStore(committed).get(scope, run.graphRunId)?.revision).toBeGreaterThan(run.revision); } finally { committed.close(); }
  await expect(daemon.executeGraphCheckpoint(connection, value)).resolves.toEqual({ kind: 'put', checkpointId: 'checkpoint1' });
  await daemon.close(); handles.splice(handles.indexOf(daemon), 1);
  await expect(daemon.executeGraphCheckpoint(connection, value)).rejects.toThrow('CHECKPOINT_SERVICE_CLOSED');
});

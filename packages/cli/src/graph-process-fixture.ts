import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, GraphRunStore, GraphCheckpointStore, type GraphProgramVersion, type GraphRun } from '@osstack/core';
import type { StartGraphRequest, GraphWorkerBinding } from '@osstack/protocol';
import { GraphRuntime, type GraphRuntimeStart, type GraphRuntimeOptions } from './graph-runtime.js';
import { GraphActionBroker } from './graph-action-broker.js';
import { GraphCheckpointService } from './graph-checkpoint-service.js';

interface ProcessFixture {
  db: Database.Database;
  runtime: GraphRuntime;
  broker: GraphActionBroker;
  checkpoints: GraphCheckpointService;
  options: GraphRuntimeOptions;
  run: GraphRun;
  binding: GraphWorkerBinding;
  start: GraphRuntimeStart;
}
export function processFixture(root: string, source = 'export async function run() { return 42; }'): ProcessFixture {
  const db: Database.Database = openDb({ path: join(root, 'state.db') });
  const modulePath = join(root, 'program.mjs'); writeFileSync(modulePath, source);
  const programs = [{ id: 'process', modulePath, digest: createHash('sha256').update(source).digest('hex') }];
  const version: GraphProgramVersion = { executionModel: 'langgraph-functional-v1', durability: 'sync', engineVersion: '1.4.15', checkpointVersion: '1.1.5', templateVersion: '1', registryVersion: '1', compilerVersion: '1', schemaVersion: '1', compiledProgramDigest: programs[0]!.digest };
  const request: StartGraphRequest = { schemaVersion: 1, kind: 'start', scope: { schemaVersion: 1, tenantId: 't', principalId: 'p', workspaceId: 'w' }, idempotencyKey: 'process', inputArtifactRef: 'input', source: { product: 'osstack', requestId: 'process' },
    spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only', input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: 'a'.repeat(40), acceptanceRef: 'accept' }, limits: { maxEpochs: 1, maxBranchAttempts: 2, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 10, deadlineSeconds: 300, tokenReservationLimit: 100 } } };
  const broker = new GraphActionBroker(db, { acquire: async () => { throw new Error('no executor'); } });
  const checkpoints = new GraphCheckpointService({ runs: new GraphRunStore(db), checkpoints: new GraphCheckpointStore(db), bindings: new Map() });
  const options = { db, broker, checkpoints, programs, workerOptions: { shutdownTimeoutMs: 30, terminationTimeoutMs: 30, heartbeatTimeoutMs: 60000 } };
  const runtime = new GraphRuntime(options);
  const prepared = runtime.prepare(request, version);
  const run = prepared.generation === 0 ? runtime.claim(prepared, 'owner', Date.now() + 30000) : prepared;
  const binding: GraphWorkerBinding = { scope: run.scope, graphRunId: run.graphRunId, identity: run.identity, generation: run.generation, owner: run.leaseOwner! };
  const start: GraphRuntimeStart = { request, run, programId: 'process', authorize: () => {}, registration: { ...binding, epoch: 0,
    workspace: { workspace_id: 'w', workspace_path: root }, authorize: () => {}, actions: [] } };
  return { db, runtime, broker, checkpoints, options, run, binding, start };
}

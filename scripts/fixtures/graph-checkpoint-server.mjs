// Test-only asynchronous IPC server. Production graph source never imports core.
import { openDb } from '../../packages/core/dist/state/db.js';
import { GraphRunStore } from '../../packages/core/dist/state/graph-runs.js';
import { GraphCheckpointStore } from '../../packages/core/dist/state/graph-checkpoints.js';
import { GRAPH_CHECKPOINT_MAX_FRAME_BYTES, parseGraphCheckpointRequest } from '../../packages/protocol/dist/index.js';
const db = openDb({ path: process.argv[2] });
const runs = new GraphRunStore(db);
const store = new GraphCheckpointStore(db);
const scope = { schemaVersion: 1, tenantId: 'tenant', principalId: 'principal', workspaceId: 'workspace' };
const request = {
  schemaVersion: 1, kind: 'start', scope, idempotencyKey: 'checkpoint-fixture', inputArtifactRef: 'input',
  source: { product: 'osstack', requestId: 'request', parentRunId: 'parent' },
  spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only',
    input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: 'a'.repeat(40), acceptanceRef: 'acceptance' },
    limits: { maxEpochs: 1, maxBranchAttempts: 1, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1,
      maxActionStarts: 10, deadlineSeconds: 60, tokenReservationLimit: 100 } },
};
const program = { executionModel: 'langgraph-functional-v1', durability: 'sync', engineVersion: '1.4.15',
  checkpointVersion: '1.1.5', templateVersion: '1', registryVersion: '1', compilerVersion: '1',
  schemaVersion: '1', compiledProgramDigest: 'b'.repeat(64) };
let run = runs.create(request, program, Date.now());
const fence = () => ({ scope, graphRunId: run.graphRunId, identity: run.identity, expectedOwner: run.leaseOwner,
  expectedGeneration: run.generation, expectedRevision: run.revision, now: Date.now() });
if (!run.generation) run = runs.acquireLease({ ...fence(), owner: 'fixture-worker', leaseExpiresAt: Date.now() + 3_600_000 });
const send = (message) => new Promise((resolve, reject) => process.send(message, (error) => error ? reject(error) : resolve()));
let queue = Promise.resolve();
let fault;
let faultId;
db.function('checkpoint_test_pause', () => {
  process.send({ event: 'before-commit', id: faultId });
  // Pause inside the real SQLite transaction after data rows, before the replay
  // record/COMMIT. SIGKILL must discard every uncommitted row on reopen.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  return 0;
});
process.on('message', (message) => {
  queue = queue.then(async () => {
    const { id } = message;
    try {
      if (Buffer.byteLength(JSON.stringify(message)) > GRAPH_CHECKPOINT_MAX_FRAME_BYTES) throw new Error('FRAME_LIMIT');
      if (message.control) { fault = message.control; await send({ id, result: 'armed' }); return; }
      const req = parseGraphCheckpointRequest(message.request);
      const mutation = req.kind === 'put' || req.kind === 'writes';
      const matches = mutation && fault && (!fault.kind || req.kind === fault.kind)
        && (!fault.channel || (req.kind === 'writes' && req.writes.some((w) => w.channel === fault.channel)))
        && (!fault.batch || (req.kind === 'writes' && req.writes.length > 1));
      const active = matches ? fault : undefined;
      if (matches) fault = undefined;
      // Real event-loop delay before any transaction and before every ACK.
      await new Promise((resolve) => setTimeout(resolve, 3));
      if (active?.phase === 'fail') throw new Error('injected transport failure');
      if (active?.phase === 'before') {
        faultId = id;
        db.exec(`CREATE TEMP TRIGGER checkpoint_test_crash BEFORE INSERT ON graph_checkpoint_requests
          BEGIN SELECT checkpoint_test_pause(); END`);
      }
      const result = store.execute(fence(), req);
      run = result.run;
      if (active?.phase === 'after') {
        await send({ event: 'after-commit', id });
        await new Promise(() => {}); // committed, but parent never receives ACK
      }
      await new Promise((resolve) => setTimeout(resolve, active?.delayMs ?? 3));
      await send({ id, result: result.response });
    } catch (error) { await send({ id, error: String(error) }); }
  }).catch((error) => { console.error(error); process.exit(1); });
});
process.on('disconnect', () => { db.close(); process.exit(0); });
await send({ event: 'ready', threadId: run.graphRunId });

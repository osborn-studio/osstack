// Dedicated C5 trusted test host. Bundle with esbuild; never shipped as CLI/RPC.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { FifoSemaphore, inspectRepoWriteLock, releaseReconciledRepoWriteLock } from '@osstack/autonomy';
import { openDb, GraphRunStore, GraphCheckpointStore, GraphActionStore, resolveRepositoryScope } from '@osstack/core';
import { GraphArtifactStore } from '@osstack/core/graph-artifacts';
import { createWorktree, quarantineGraphWorktree, type WorktreeHandle } from '@osstack/agents';
import { ExecutionPlan } from '@osstack/loop';
import { startDaemon } from '../../packages/cli/src/daemon.js';
import { GraphRuntime } from '../../packages/cli/src/graph-runtime.js';
import { GraphCheckpointService } from '../../packages/cli/src/graph-checkpoint-service.js';
import type { StartGraphRequest } from '@osstack/protocol';
import { GraphActionBroker, type GraphActionEvidence, type GraphWorkerRegistration } from '../../packages/cli/src/graph-action-broker.js';
import { GovernedExecution } from '../../packages/cli/src/governed-execution.js';
import { healthyAutonomyHealth } from '../../packages/cli/src/test-healthy-autonomy.js';

const root = resolve(process.argv[2]!);
const assemblyOnly = process.argv[3] === 'assembly';
const home = process.env['OSSTACK_HOME'];
if (!home || !isAbsolute(home) || home === join(homedir(), '.osstack')) throw new Error('G17_EXPLICIT_TEST_HOME_REQUIRED');
const repo = join(root, 'repo'); const external = join(root, 'external.log'); const reentries = join(root, 'reentries.log');
const durable = (path: string, value: unknown) => { writeFileSync(path, JSON.stringify(value)); const fd = openSync(path, 'r'); fsyncSync(fd); closeSync(fd); };
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
if (!existsSync(repo)) {
  execFileSync('git', ['init', '-q', repo]); mkdirSync(join(repo, '.osstack'));
  writeFileSync(join(repo, '.osstack/policy.yaml'), 'schema_version: 1\nmode: execute\n');
  writeFileSync(join(repo, 'file.txt'), 'before\n'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base');
}
const base = git('rev-parse', 'HEAD'); const canonical = await resolveRepositoryScope(repo);
const source = `
export async function run(context) {
  process.on('SIGTERM', () => {});
  process.on('unhandledRejection', () => {});
  setInterval(() => {}, 1000);
  const fs = await import('node:fs');
  const invoke = async (nodeId, action) => {
    fs.appendFileSync(${JSON.stringify(reentries)}, nodeId + ':' + context.binding.generation + '\\n');
    const b = context.binding;
    const response = await context.action({schemaVersion:1,kind:'worker_action',requestId:nodeId+':'+b.generation,
      scope:b.scope,graphRunId:b.graphRunId,specHash:b.identity.specHash,generation:b.generation,epoch:0,nodeId,effectSlot:'invoke',action});
    if(response.kind !== 'worker_action_response' || response.outcome.state !== 'confirmed') throw new Error(JSON.stringify(response));
    return response.outcome.result;
  };
  await context.task('implement', async () => invoke('implement', {kind:'implement',inputArtifactRef:'input',workspaceLeaseRef:'workspace'}))();
  return await context.task('freeze', async () => invoke('freeze', {kind:'freeze',workspaceLeaseRef:'workspace',receiptRef:'implementation-receipt'}))();
}`;
const modulePath = join(root, 'program.mjs'); writeFileSync(modulePath, source);
const programs = [{ id: 'c5-chain', modulePath, digest: createHash('sha256').update(source).digest('hex') }];
const version = { executionModel: 'langgraph-functional-v1' as const, durability: 'sync' as const, engineVersion: '1.4.15', checkpointVersion: '1.1.5', templateVersion: '1', registryVersion: '1', compilerVersion: '1', schemaVersion: '1', compiledProgramDigest: programs[0]!.digest };
const request: StartGraphRequest = { schemaVersion: 1 as const, kind: 'start' as const, scope: { schemaVersion: 1 as const, tenantId: 'tenant', principalId: 'principal', workspaceId: 'workspace' }, idempotencyKey: `c5:${root}`, inputArtifactRef: 'input', source: { product: 'osstack' as const, requestId: 'request' }, spec: { schemaVersion: 1 as const, template: 'code-delivery-v1' as const, publication: 'artifact_only' as const, input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: base, acceptanceRef: 'acceptance' }, limits: { maxEpochs: 1, maxBranchAttempts: 3, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 5, deadlineSeconds: Number(process.argv[4] ?? 120), tokenReservationLimit: 100 } } };
const send = (value: unknown) => { process.send?.(value); };
let fault = ''; let held: (() => void) | undefined;
const checkpointExecute = GraphCheckpointService.prototype.execute;
// Test-only wrapper at the actual durable service boundary, no alternate saver.
GraphCheckpointService.prototype.execute = async function(connection, value) {
  const wire = value as { kind: string; writes?: Array<{channel: string; value: string}>; checkpoint?: string };
  appendFileSync(join(root, 'checkpoint-trace.jsonl'), JSON.stringify(value) + '\n');
  const boundary = ['before-final', 'after-final'].includes(fault) && wire.kind === 'put' && wire.checkpoint?.includes('candidate_ready');
  if (!boundary) return checkpointExecute.call(this, connection, value);
  const point = fault; fault = '';
  const committed = point === 'after-final' ? await checkpointExecute.call(this, connection, value) : undefined;
  await new Promise<void>(done => { held = done; send({ event: 'boundary', point }); });
  if (committed) return committed;
  return checkpointExecute.call(this, connection, value);
};
const brokerHandle = GraphActionBroker.prototype.handle;
GraphActionBroker.prototype.handle = async function(connection, value, options) {
  const response = await brokerHandle.call(this, connection, value, options);
  if (fault === 'before-return' && response.kind === 'worker_action_response' && response.outcome.state === 'confirmed'
    && response.outcome.result.kind === 'implementation_complete') {
    fault = ''; await new Promise<void>(done => { held = done; send({ event: 'boundary', point: 'before-return' }); });
  }
  return response;
};
const daemon = assemblyOnly ? undefined : await startDaemon({ socketPath: join(root, 'daemon.sock'), adapters: [], autonomyHealth: async () => healthyAutonomyHealth() });
const db = openDb({ path: daemon?.dbPath ?? join(root, 'state.db') });
const runs = new GraphRunStore(db); const artifacts = new GraphArtifactStore(join(root, 'artifacts'));
const admission = new GovernedExecution({ reads: new FifoSemaphore(2), writes: new FifoSemaphore(1), repositories: new Map(), checkHealth: async () => {} });
const broker = daemon ? await daemon.graphActionBroker() : new GraphActionBroker(db, { acquire: admission.acquire.bind(admission) });
const configuration = { programs, workerOptions: { workerEntry: resolve('packages/graph/dist/worker-entry.js'), shutdownTimeoutMs: 30, terminationTimeoutMs: 30 }, drainTimeoutMs: 1000 };
const runtime = daemon ? await daemon.graphRuntime(configuration) : new GraphRuntime({ ...configuration, db, broker,
  checkpoints: new GraphCheckpointService({ runs, checkpoints: new GraphCheckpointStore(db), bindings: new Map() }) });
let run = runtime.prepare(request, version);
const worktreeFile = join(root, 'worktree.json');
const worktree: WorktreeHandle = existsSync(worktreeFile) ? JSON.parse(readFileSync(worktreeFile, 'utf8')) : await createWorktree({
  repoPath: repo, runId: run.graphRunId, rootPath: join(root, 'worktrees'), baseRef: base,
  graphRetention: { runId: run.graphRunId, scopeKey: createHash('sha256').update(JSON.stringify(run.scope)).digest('hex'), generation: 1, workspaceLeaseRef: 'workspace' },
});
durable(worktreeFile, worktree);
const workspace = worktree.worktreePath;
let handle: ReturnType<GraphRuntime['start']> | undefined;
let stopped: Awaited<ReturnType<ReturnType<GraphRuntime['start']>['stop']>> | undefined;
let verdictMode = 'applied'; let releaseFails = false;
const receiptPath = join(root, 'implementation.json');
const receipt = (): GraphActionEvidence => JSON.parse(readFileSync(receiptPath, 'utf8'));
const assertProducer = () => {
  const r = receipt();
  if (!r.command?.termination?.stop_confirmed || !Number.isInteger(r.command.termination.pgid)) throw new Error('G04_STOP_UNPROVEN');
  const row = db.prepare("SELECT execution_ref FROM graph_actions WHERE graph_run_id = ? AND node_id = 'implement'").get(run.graphRunId) as { execution_ref: string } | undefined;
  if (!r.candidate?.execution?.run_id || !row?.execution_ref?.endsWith(':' + r.candidate.execution.run_id)
    || r.candidate.workspace.workspace_path !== workspace || r.candidate.workspace.workspace_id !== run.scope.workspaceId) throw new Error('G04_RECEIPT_IDENTITY');
  return r;
};
const registration = (): GraphWorkerRegistration => ({ scope: run.scope, graphRunId: run.graphRunId, identity: run.identity, generation: run.generation, owner: run.leaseOwner!, epoch: 0,
  workspace: { workspace_id: 'workspace', workspace_path: workspace }, authorize: () => {}, actions: [
    { nodeId: 'implement', effectSlot: 'invoke', tokenReservation: 0, action: { kind: 'implement' as const, inputArtifactRef: 'input', workspaceLeaseRef: 'workspace' },
      execution: { kind: 'command' as const, command: fault === 'unknown-not-applied' ? 'true' : fault.startsWith('cancel') ? `node -e 'const fs=require("fs");fs.appendFileSync(${JSON.stringify(external)},"started\\n");fs.writeFileSync(${JSON.stringify(join(root, 'command.pid'))},String(process.pid));${fault === 'cancel-stubborn' ? 'process.on("SIGTERM",()=>{});' : ''}setInterval(()=>{},1000)'` : `node -e 'const fs=require("fs");fs.appendFileSync(${JSON.stringify(external)},"once\\n");fs.writeFileSync("file.txt","after\\n")'`,
        plan: ExecutionPlan.parse({ plan_id: 'plan', agent_id: 'local-command', task: { task_id: 'task', capability: 'code.write', prompt: 'change', source: 'manual' }, stop_condition: { type: 'tests_pass' } }) },
      persist: async (evidence: GraphActionEvidence) => { durable(receiptPath, evidence); if (fault === 'hold-persist') { fault = ''; await new Promise<void>(done => { held = done; send({ event: 'boundary', point: 'persist' }); }); } if (fault.startsWith('unknown')) throw new Error('TEST_LOST_PERSIST_RESULT');
        return { evidenceRef: 'implementation-receipt', actualTokens: 0, result: { schemaVersion: 1 as const, kind: 'implementation_complete' as const, workspaceLeaseRef: 'workspace', receiptRef: 'implementation-receipt' } }; } },
    { nodeId: 'freeze', effectSlot: 'invoke', tokenReservation: 0, action: { kind: 'freeze' as const, workspaceLeaseRef: 'workspace', receiptRef: 'implementation-receipt' },
      execution: { kind: 'freeze' as const, store: artifacts, input: { artifactId: `candidate:${run.graphRunId}`, scope: run.scope, runId: run.graphRunId, generation: run.generation, owner: run.leaseOwner!, workspaceLeaseRef: 'workspace', repoId: canonical.repoId, commonDir: canonical.commonDir, worktreePath: workspace, baseRevision: base, implementationReceiptRef: 'implementation-receipt', producerStopEvidenceRef: 'g04-stopped' },
        authority: { verifyLease: async (_input, lease) => { if (!('assertActive' in lease) || typeof lease.assertActive !== 'function') throw new Error('LEASE_REQUIRED'); await lease.assertActive(); },
          verifyImplementationReceipt: async () => { assertProducer(); const row = db.prepare("SELECT state, execution_ref FROM graph_actions WHERE graph_run_id = ? AND node_id = 'implement'").get(run.graphRunId) as { state: string; execution_ref: string } | undefined;
            if (row?.state !== 'confirmed' || !assertProducer().candidate?.execution?.run_id || !row.execution_ref?.endsWith(':' + assertProducer().candidate!.execution!.run_id)) throw new Error('IMPLEMENTATION_RECEIPT_MISMATCH'); },
          verifyProducersStopped: async () => { assertProducer(); } } },
      persist: async (evidence: GraphActionEvidence) => ({ evidenceRef: 'frozen-receipt', actualTokens: 0, result: evidence.frozenCandidate! }) },
  ] });
const current = () => runs.get(run.scope, run.graphRunId)!;
const fence = () => { const r = current(); return { scope: r.scope, graphRunId: r.graphRunId, identity: r.identity, expectedGeneration: r.generation, expectedRevision: r.revision, expectedOwner: r.leaseOwner, now: Date.now() }; };
const inspect = async () => ({ run: current(), actions: db.prepare('SELECT node_id,state,execution_ref,outcome_json FROM graph_actions WHERE graph_run_id = ? ORDER BY created_at').all(run.graphRunId),
  budget: (() => { const row = db.prepare('SELECT effect_key FROM graph_actions WHERE graph_run_id = ? LIMIT 1').get(run.graphRunId) as { effect_key: string } | undefined; return row ? new GraphActionStore(db).get(fence(), row.effect_key).budget : { actionStarts: 0 }; })(),
  external: existsSync(external) ? readFileSync(external, 'utf8') : '', reentries: existsSync(reentries) ? readFileSync(reentries, 'utf8') : '',
  finalCheckpoints: db.prepare("SELECT count(*) AS n FROM graph_checkpoints WHERE graph_run_id = ? AND checkpoint LIKE '%candidate_ready%'").get(run.graphRunId),
  checkpoints: db.prepare('SELECT count(*) AS n FROM graph_checkpoints WHERE graph_run_id = ?').get(run.graphRunId),
  writes: db.prepare('SELECT channel,value FROM graph_checkpoint_writes WHERE graph_run_id = ?').all(run.graphRunId),
  lock: await inspectRepoWriteLock(join(canonical.commonDir, 'osstack/writer-locks'), canonical.repoId), stopped });
function recovery() {
  const key = {}; const fixed = current();
  const verifyWorker = async () => {
    const exit = stopped?.worker;
    if (!exit || exit.kind !== 'exited' || !stopped?.actionsSettled || exit.graphRunId !== fixed.graphRunId || exit.generation !== fixed.generation || exit.owner !== fixed.leaseOwner) throw new Error('NO_OBSERVED_EXIT');
    // Same daemon uses its supervisor receipt; restart uses durable host receipt
    // produced only after the prior daemon supervisor actually observed OS exit.
    if (handle && JSON.stringify(runtime.observedExit(handle.connection)) !== JSON.stringify(exit)) throw new Error('EXIT_RECEIPT_MISMATCH');
    return { kind: 'stopped' as const, graphRunId: exit.graphRunId, generation: exit.generation, owner: exit.owner, confirmedAt: exit.confirmedAt, evidenceRef: exit.evidenceRef };
  };
  runtime.reconciler.register(key, { binding: { scope: fixed.scope, graphRunId: fixed.graphRunId, identity: fixed.identity, generation: fixed.generation, owner: fixed.leaseOwner }, authorize: () => {},
    stopWorker: async () => stopped, verifyWorker,
    verifyQuiescence: async () => { assertProducer(); await quarantineGraphWorktree(worktree, 'C5 recovery: preserve original producer workspace'); durable(join(root, 'quarantine.json'), { repo: canonical.repoId, runId: fixed.graphRunId, workspace, retained: true });
      return { executorEvidenceRef: 'g04-stopped', workspaceEvidenceRef: 'retained-test-workspace' }; },
    verifyOutcome: async () => { if (verdictMode === 'not_applied' && (existsSync(external) || readFileSync(join(workspace, 'file.txt'), 'utf8') !== 'before\n')) throw new Error('ABSENCE_UNPROVEN');
      if (verdictMode === 'applied' && (!existsSync(external) || readFileSync(external, 'utf8') !== 'once\n')) throw new Error('APPLIED_UNPROVEN');
      return verdictMode === 'unknown' ? { outcome: 'unknown', evidenceRef: 'still-unknown', observedTokens: 0 }
      : verdictMode === 'not_applied' ? { outcome: 'not_applied', evidenceRef: 'verified-absent', actualTokens: 0, error: null }
      : { outcome: 'applied', evidenceRef: 'implementation-receipt', actualTokens: 0, result: { schemaVersion: 1, kind: 'implementation_complete', workspaceLeaseRef: 'workspace', receiptRef: 'implementation-receipt' } }; },
    recheck: () => { assertProducer(); if (!stopped?.actionsSettled || stopped.worker.kind !== 'exited') throw new Error('NOT_QUIESCENT'); },
    release: async (result, reverify) => { if (releaseFails) throw new Error('TEST_RELEASE_FAILURE');
      if (result.action) {
        const effectKey = result.action.effectKey;
        const released = await broker.releaseReconciled(effectKey, reverify);
        if (!released) {
          const rootDir = join(canonical.commonDir, 'osstack/writer-locks');
          const owner = await inspectRepoWriteLock(rootDir, canonical.repoId);
          if (owner) {
            if (owner.autonomy_run_id !== `graph-action:${effectKey}`) throw new Error('RETAINED_LOCK_IDENTITY');
            await releaseReconciledRepoWriteLock({ root_dir: rootDir, repo_id: canonical.repoId, expectedOwner: owner,
              verifyQuiescent: async () => { await reverify(); } });
          }
        }
      } },
  }); return key;
}
if (existsSync(join(root, 'stopped.json'))) {
  const prior = JSON.parse(readFileSync(join(root, 'stopped.json'), 'utf8'));
  if (JSON.stringify(prior.scope) !== JSON.stringify(run.scope) || JSON.stringify(prior.identity) !== JSON.stringify(run.identity)) throw new Error('PRIOR_HOST_RECEIPT_IDENTITY');
  try { process.kill(prior.daemonPid, 0); throw new Error('PRIOR_DAEMON_STILL_ALIVE'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  stopped = { worker: prior.worker, actionsSettled: prior.actionsSettled };
}
send({ event: 'ready', pid: process.pid, run, dbPath: db.name });
process.on('message', async (message: any) => {
  try {
    let value: unknown;
    if (message.op === 'start') {
      fault = message.fault ?? ''; if (run.generation === 0) run = runtime.claim(run, `owner:${process.pid}`, Date.now() + 60_000);
      handle = runtime.start({ request, run, programId: 'c5-chain', registration: registration(), authorize: () => {}, ...(run.generation > 1 ? { resume: { kind: 'continue' as const } } : {}) });
      void handle.result.then(result => send({ event: 'result', result }), error => send({ event: 'result-error', error: String(error), logs: handle?.logs() }));
      await handle.ready; value = { run };
    } else if (message.op === 'stop') {
      const stopPromise = handle!.stop(); if (message.releaseHold !== false) { held?.(); held = undefined; } stopped = await stopPromise; durable(join(root, 'stopped.json'), { ...stopped, daemonPid: process.pid, scope: run.scope, identity: run.identity }); value = { ...stopped, logs: handle!.logs() };
    } else if (message.op === 'release-hold') { held?.(); held = undefined; value = true; }
    else if (message.op === 'inspect') value = await inspect();
    else if (message.op === 'singleton') { if (!daemon) throw new Error('daemon required'); value = await daemon.graphRuntime(configuration); }
    else if (message.op === 'old-action') { value = await broker.handle(handle!.connection, { schemaVersion: 1, kind: 'worker_action', requestId: 'old', scope: run.scope, graphRunId: run.graphRunId, specHash: run.identity.specHash, generation: handle!.binding.generation, epoch: 0, nodeId: 'implement', effectSlot: 'invoke', action: { kind: 'implement', inputArtifactRef: 'input', workspaceLeaseRef: 'workspace' } }); }
    else if (message.op === 'takeover') { const result = await runtime.reconciler.reconcile(recovery(), { kind: 'takeover', fence: fence(), receiptId: `takeover:${run.generation}`, owner: `owner:${process.pid}:${run.generation + 1}`, leaseExpiresAt: Date.now() + 60_000 }); run = result.result.run; value = result; }
    else if (message.op === 'reconcile') { verdictMode = message.verdict; releaseFails = message.releaseFails ?? false;
      const action = db.prepare("SELECT effect_key FROM graph_actions WHERE graph_run_id = ? AND node_id = 'implement'").get(run.graphRunId) as { effect_key: string };
      value = await runtime.reconciler.reconcile(recovery(), { kind: 'effect', fence: fence(), receiptId: message.receiptId, effectKey: action.effect_key }); }
    else if (message.op === 'verify') { const row = db.prepare("SELECT outcome_json FROM graph_actions WHERE graph_run_id = ? AND node_id = 'freeze'").get(run.graphRunId) as { outcome_json: string };
      const result = JSON.parse(row.outcome_json).result; const manifest = await artifacts.verify(result.artifactDigest); const restored = await artifacts.restore(result.artifactDigest, { rootPath: root, directoryName: `restored-${Date.now()}` });
      value = { manifest, restored, content: readFileSync(join(restored.worktreePath, 'file.txt'), 'utf8') }; }
    else if (message.op === 'close') { await runtime.close(); if (daemon) await daemon.close(); db.close(); send({ id: message.id, value: true }); process.exit(0); }
    else throw new Error('unknown fixture command');
    send({ id: message.id, value });
  } catch (error) { send({ id: message.id, error: String(error), stack: (error as Error).stack }); }
});

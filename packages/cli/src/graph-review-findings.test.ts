import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDb, CapabilitySchema } from '@osstack/core';
import { GraphDelegationStatus, type StartGraphRequest } from '@osstack/protocol';
import { FifoSemaphore } from '@osstack/autonomy';
import { GraphRpcService, type GraphHostRegistration } from './graph-rpc.js';
import { GraphDelivery } from './graph-delivery.js';
import { makeRepositoryPolicyGate } from './repository-policy.js';
import { GovernedExecution } from './governed-execution.js';
import type { AgentAdapter } from '@osstack/agents';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
async function fixture(mode: 'success' | 'review' | 'tests' | 'unknown' = 'success') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'g22-rpc-'))); const repo = join(root, 'source'); await mkdir(repo);
  git(repo, 'init', '-q'); await writeFile(join(repo, 'answer'), '0\n'); git(repo, 'add', '.'); git(repo, '-c', 'user.name=G22', '-c', 'user.email=g22@invalid', 'commit', '-qm', 'base');
  const db = openDb({ path: join(root, 'control.sqlite') }); let writes = 0; let reviewStarted = false; let granted = true; let abortObserved = false;
  const stopped = new Set<string>();
  const writer: AgentAdapter = { id: 'writer', display_name: 'writer', cost_tier: 'low',
    capabilities: () => [CapabilitySchema.parse({ id: 'write', agent_id: 'writer', kind: 'code.write', description: 'write' })],
    isAvailable: async () => ({ available: true, last_checked_at: 0 }),
    invoke: async function* (task) {
      writes++;
      await writeFile(join(String(task.context?.['repo_path']), 'answer'), '1\n');
      stopped.add(task.run_id);
      yield { event_id: task.run_id, run_id: task.run_id, session_id: task.session_id, seq: 1, created_at: Date.now() / 1000, type: 'done', terminal: true,
        payload: { status: 'completed', last_seq: 0, result_summary: 'implemented', usage: { tokens_in: 1, tokens_out: 1, duration_ms: 1 } } };
    }, confirmStopped: async id => ({ stopped: stopped.has(id), evidence: `finite:${id}` }) };
  const reviewer: AgentAdapter = { ...writer, id: 'reviewer', capabilities: () => [CapabilitySchema.parse({ id: 'review', agent_id: 'reviewer', kind: 'review.code', description: 'review' })],
    invoke: async function* (task, signal) {
      const good = (await readFile(join(String(task.context?.['repo_path']), 'answer'), 'utf8')).trim() === '1';
      reviewStarted = true;
      if (mode === 'review' || mode === 'unknown') {
        await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
        abortObserved = true;
      }
      if (mode !== 'unknown') stopped.add(task.run_id);
      yield { event_id: task.run_id, run_id: task.run_id, session_id: task.session_id, seq: 1, created_at: Date.now() / 1000, type: 'done', terminal: true,
        payload: { status: signal.aborted ? 'failed' : 'completed', last_seq: 0, result_summary: JSON.stringify({ schemaVersion: 1, verdict: good ? 'accept' : 'changes_requested', summary: 'actual candidate', findings: good ? [] : ['answer must be 1'] }), usage: { tokens_in: 1, tokens_out: 1, duration_ms: 1 } } };
    } };
  const request: StartGraphRequest = { schemaVersion: 1, kind: 'start', scope: { schemaVersion: 1, tenantId: 't', principalId: 'p', workspaceId: 'w' },
    idempotencyKey: 'public-key', inputArtifactRef: 'input', source: { product: 'osstack', requestId: 'request', parentRunId: 'parent' },
    spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only', input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: git(repo, 'rev-parse', 'HEAD'), acceptanceRef: 'acceptance' },
      limits: { maxEpochs: 2, maxBranchAttempts: 1, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 14, tokenReservationLimit: 200000, deadlineSeconds: 120 } } };
  const registration: GraphHostRegistration = { id: 'local', scope: request.scope, product: 'osstack', repositoryRef: 'repo', taskRef: 'task', inputArtifactRef: 'input',
    authorize: operation => { if (!granted && operation !== 'read' && operation !== 'cancel') throw Error('GRANT_EXPIRED'); },
    delivery: { repositoryPath: repo, task: 'Set answer to 1', writer: { identity: 'writer', adapter: writer, capabilityId: 'write' }, reviewer: { identity: 'reviewer', adapter: reviewer, capabilityId: 'review' },
      verifyReviewer: async proof => { if (proof.writerIdentity === proof.reviewerIdentity) throw Error('independence'); },
      acceptanceRegistry: [{ ref: 'acceptance', command: mode === 'tests' ? `touch '${join(root, 'command-started')}'; exec sleep 60` : 'test "$(cat answer)" = 1', passExitCodes: [0], failExitCodes: [1] }] } };
  const connection = {};
  const admission = new GovernedExecution({ reads: new FifoSemaphore(2), writes: new FifoSemaphore(2), repositories: new Map(), checkHealth: async () => {} });
  const options = { db, root: join(root, 'delivery'), registrations: [registration], resolveCaller: (key: object) => key === connection ? 'local' : null, acquire: admission.acquire.bind(admission) };
  const service = new GraphRpcService(options);
  const start = async () => GraphDelegationStatus.parse(await service.handle(connection, 'graph.start', request));
  const status = async (id: string, host = service) => GraphDelegationStatus.parse(await host.handle(connection, 'graph.status', { schemaVersion: 1, scope: request.scope, graphRunId: id }));
  const until = async (id: string, predicate: (s: ReturnType<typeof GraphDelegationStatus.parse>) => boolean) => {
    const deadline = Date.now() + 20000;
    for (;;) { const value = await status(id); if (predicate(value)) return value;
      if (Date.now() > deadline) throw Error(`TIMEOUT: ${JSON.stringify(value)}`); await new Promise(resolve => setTimeout(resolve, 15)); }
  };
  return { root, db, request, registration, connection, service, start, status, until, options, writer, reviewer,
    writes: () => writes, reviewStarted: () => reviewStarted, abortObserved: () => abortObserved, grant: (value: boolean) => { granted = value; },
    close: async () => { await service.close(); db.close(); } };
}

it.each(['review', 'tests', 'unknown'] as const)('settles stopped %s cancellation with revoked execute, holding only unproven stop', async mode => {
  const f = await fixture(mode);
  try {
    const run = await f.start();
    if (mode === 'tests') {
      const deadline = Date.now() + 15000;
      for (;;) { try { await readFile(join(f.root, 'command-started')); break; } catch { if (Date.now() > deadline) throw Error('command did not start'); await new Promise(resolve => setTimeout(resolve, 15)); } }
    } else await f.until(run.graphRunId, () => f.reviewStarted());
    f.grant(false);
    const before = await f.status(run.graphRunId);
    await f.service.handle(f.connection, 'graph.cancel', { schemaVersion: 1, kind: 'cancel', scope: f.request.scope, idempotencyKey: 'cancel', graphRunId: run.graphRunId, expectedRevision: before.revision });
    await f.service.close();
    const branch = mode === 'tests' ? 'tests' : 'review';
    const row = f.db.prepare('SELECT state, outcome_json FROM graph_actions WHERE node_id=?').get(`e0.${branch}`) as { state: string; outcome_json: string };
    expect(row.state).toBe(mode === 'unknown' ? 'unknown' : 'failed');
    expect(f.db.prepare('SELECT status FROM graph_runs').get()).toEqual({ status: mode === 'unknown' ? 'cancel_pending' : 'cancelled' });
    expect(f.db.prepare('SELECT count(*) n FROM graph_action_admissions WHERE released_at IS NULL').get()).toEqual({ n: mode === 'unknown' ? 1 : 0 });
    if (mode !== 'unknown') {
      const outcome = JSON.parse(row.outcome_json);
      expect(outcome).toMatchObject({ state: 'failed', retrySafe: false, evidenceRef: expect.stringMatching(/^graph-verification:/) });
      const evidence = JSON.parse(await readFile(join(f.root, 'delivery', run.graphRunId, 'verification', 'evidence', outcome.evidenceRef.slice('graph-verification:'.length) + '.json'), 'utf8'));
      expect(evidence.verificationFailure).toMatchObject({ retrySafe: false });
      expect(evidence.report).toBeUndefined();
      expect(evidence.evidence.stopped).toBe(true);
      expect(f.db.prepare('SELECT count(*) n FROM graph_verification_joins').get()).toEqual({ n: 0 });
    }
  } finally { await f.close(); }
}, 30000);

it.each(['revoked', 'untracked', 'newer'] as const)('uses current source policy (%s) beyond workspace creation and writer availability', async mode => {
  const f = await fixture(); const repo = f.registration.delivery.repositoryPath;
  const policy = join(repo, '.osstack', 'policy.yaml'); await mkdir(join(repo, '.osstack'));
  const setPolicy = (value: string) => writeFile(policy, `schema_version: 1\nmode: ${value}\n`);
  await setPolicy('execute');
  if (mode === 'revoked') { git(repo, 'add', '.osstack/policy.yaml'); git(repo, '-c', 'user.name=test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'policy'); f.request.spec.input.baseRevision = git(repo, 'rev-parse', 'HEAD'); }
  if (mode === 'newer') { git(repo, 'add', '.osstack/policy.yaml'); git(repo, '-c', 'user.name=test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'newer policy'); }
  let release!: () => void; let available!: () => void;
  const waiting = new Promise<void>(resolve => { available = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.writer.isAvailable = async () => { available(); await barrier; return { available: true, last_checked_at: 0 }; };
  const checked: string[] = [];
  const host = new GraphDelivery({ ...f.registration.delivery, db: f.db, root: join(f.root, 'direct'), request: f.request, acquire: f.options.acquire, authorize: () => f.registration.authorize(),
    authorizePolicy: async ({ policyRoot, workspacePath }: { policyRoot: string; workspacePath: string }) => {
      expect(policyRoot).toBe(repo); checked.push(workspacePath);
      const source = await makeRepositoryPolicyGate(policyRoot, true)({ workspacePath: policyRoot });
      const workspace = await makeRepositoryPolicyGate(workspacePath, false)({ workspacePath });
      if (!source.allow || !workspace.allow) throw Error('POLICY_DENIED');
    } });
  try {
    const pending = host.run();
    await waiting;
    expect(f.db.prepare("SELECT state FROM graph_actions WHERE node_id='e0.workspace'").get()).toEqual({ state: 'confirmed' });
    if (mode === 'revoked') await setPolicy('observe');
    release(); await pending;
    expect(f.writes()).toBe(mode === 'revoked' ? 0 : 1);
    expect(host.current().status).toBe(mode === 'revoked' ? 'failed' : 'ready');
    expect(checked).toContain(join(f.root, 'direct', 'writer-0'));
    expect(f.db.prepare('SELECT count(*) n FROM graph_action_admissions WHERE released_at IS NULL').get()).toEqual({ n: 0 });
  } finally { release(); await f.close(); }
}, 30000);

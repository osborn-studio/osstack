import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath, chmod, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { CapabilitySchema, GraphRunStore, GraphActionStore, GraphCheckpointStore, openDb, resolveRepositoryScope } from '@osstack/core';
import type { GraphAction, GraphRunFence } from '@osstack/core';
import { GraphArtifactStore } from '@osstack/core/graph-artifacts';
import { FifoSemaphore } from '@osstack/autonomy';
import type { StartGraphRequest } from '@osstack/protocol';
import { GraphActionBroker, type GraphRegisteredAction } from './graph-action-broker.js';
import { GovernedExecution } from './governed-execution.js';
import { prepareGraphVerification, loadGraphVerificationEvidence } from './graph-verification.js';
import { GraphVerificationJoinService } from './graph-verification-join.js';
import { GraphRuntime, type GraphRuntimeHandle } from './graph-runtime.js';
import { GraphCheckpointService } from './graph-checkpoint-service.js';

// Deliberately preserve candidate repositories, SQLite journals and failure evidence.
const priorHome = process.env['OSSTACK_HOME'];
// Optional explicit evidence-launcher home; ordinary runs keep the suite's hermetic home.
if (process.env['G20_TEST_HOME']) process.env['OSSTACK_HOME'] = process.env['G20_TEST_HOME'];
afterAll(() => { if (priorHome === undefined) delete process.env['OSSTACK_HOME']; else process.env['OSSTACK_HOME'] = priorHome; });
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const report = JSON.stringify({ schemaVersion: 1, verdict: 'changes_requested', summary: 'Expected assertion fails', findings: ['Repair the candidate'] });
const slots = { review: { nodeId: 'review', effectSlot: 'invoke' }, tests: { nodeId: 'tests', effectSlot: 'invoke' } };
const nextCost = { repair: { actions: 1, tokens: 1 }, review: { actions: 1, tokens: 1 }, tests: { actions: 1, tokens: 1 } };
type Kind = 'review' | 'tests';

async function fixture(options: { source?: string; limits?: Partial<StartGraphRequest['spec']['limits']>; command?: string } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'g20-')));
  const repo = join(root, 'source'); await mkdir(repo);
  git(repo, 'init', '-q'); await writeFile(join(repo, 'file'), 'candidate\n'); git(repo, 'add', '.');
  git(repo, '-c', 'user.name=G20', '-c', 'user.email=g20@invalid', 'commit', '-qm', 'candidate base');
  const base = git(repo, 'rev-parse', 'HEAD'); const canonical = await resolveRepositoryScope(repo);
  // Hash the static program before creating the run; candidate SHA comes from freeze RPC.
  const source = options.source ?? 'export async function run() { throw new Error("host-only fixture"); }';
  const modulePath = join(root, 'program.mjs'); await writeFile(modulePath, source);
  const version = { executionModel: 'langgraph-functional-v1' as const, durability: 'sync' as const, engineVersion: '1.4.15', checkpointVersion: '1.1.5', templateVersion: '1', registryVersion: '1', compilerVersion: '1', schemaVersion: '1', compiledProgramDigest: createHash('sha256').update(source).digest('hex') };
  const request: StartGraphRequest = { schemaVersion: 1, kind: 'start', scope: { schemaVersion: 1, tenantId: 't', principalId: 'p', workspaceId: 'w' }, idempotencyKey: 'g20', inputArtifactRef: 'input', source: { product: 'osstack', requestId: 'g20' }, spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only', input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: base, acceptanceRef: 'acceptance' }, limits: { maxEpochs: 2, maxBranchAttempts: 2, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 8, deadlineSeconds: 120, tokenReservationLimit: 100, ...options.limits } } };
  const db = openDb({ path: join(root, 'control.sqlite') }); cleanup.push(() => { db.close(); });
  const runs = new GraphRunStore(db);
  const created = runs.create(request, version, Date.now());
  const leased = runs.acquireLease({ scope: created.scope, graphRunId: created.graphRunId, identity: created.identity, expectedGeneration: 0, expectedOwner: null, expectedRevision: 0, now: Date.now(), owner: 'g20-worker', leaseExpiresAt: Date.now() + 300_000 });
  const current = () => runs.get(leased.scope, leased.graphRunId)!;
  const fence = (now = Date.now()): GraphRunFence => { const r = current(); return { scope: r.scope, graphRunId: r.graphRunId, identity: r.identity, expectedGeneration: r.generation, expectedOwner: r.leaseOwner, expectedRevision: r.revision, now }; };
  runs.project({ ...fence(), status: 'running' });
  const state = { summary: report, stopConfirmed: true, activeReviewers: 0, reviewCalls: 0, revoked: false, holdRelease: false };
  const authorize = () => { if (state.revoked) throw new Error('G20_AUTHORITY_REVOKED'); };
  const admission = new GovernedExecution({ reads: new FifoSemaphore(2), writes: new FifoSemaphore(2), repositories: new Map(), checkHealth: async () => {} });
  const acquire: GovernedExecution['acquire'] = async input => {
    const lease = await admission.acquire(input);
    return { ...lease, release: async () => { if (state.holdRelease) throw new Error('G20_RELEASE_HELD'); await lease.release(); } };
  };
  const artifacts = new GraphArtifactStore(join(root, 'artifacts'));
  const freezeInput = { artifactId: 'g20-candidate', scope: leased.scope, runId: leased.graphRunId, generation: leased.generation, owner: leased.leaseOwner!, workspaceLeaseRef: 'source', repoId: canonical.repoId, commonDir: canonical.commonDir, worktreePath: repo, baseRevision: base, implementationReceiptRef: 'fixture-base', producerStopEvidenceRef: 'fixture-base-no-producers' };
  // The candidate is a synchronously committed, known base, with no implementation worker.
  const authority = { verifyLease: async (_input: unknown, lease: unknown) => { authorize(); if (!lease || typeof lease !== 'object' || !('assertActive' in lease) || typeof lease.assertActive !== 'function') throw new Error('G20_LEASE_REQUIRED'); await lease.assertActive(); }, verifyImplementationReceipt: async () => { expect(git(repo, 'rev-parse', 'HEAD')).toBe(base); }, verifyProducersStopped: async () => { expect(state.activeReviewers).toBe(0); } };
  const sourceLease = await acquire({ kind: 'write', runId: 'g20-source-freeze', workspacePath: repo });
  const candidate = await artifacts.freeze(freezeInput, { ...authority, lease: sourceLease }).finally(() => sourceLease.release());
  const binding = { scope: leased.scope, graphRunId: leased.graphRunId, specHash: leased.identity.specHash, epoch: 0, candidateRevision: candidate.candidateRevision, artifactDigest: candidate.artifactDigest, acceptanceRef: 'acceptance' };
  const evidenceRoot = join(root, 'verification');
  const prepared = await prepareGraphVerification({ root: evidenceRoot, artifacts, candidate, binding, sourceWorkspace: { workspace_id: 'w', workspace_path: repo }, authorize, acquire,
    acceptanceRegistry: [{ ref: 'acceptance', command: options.command?.replaceAll('%ROOT%', root) ?? 'exit 1', passExitCodes: [0], failExitCodes: [1] }], writerIdentity: 'fixture-writer',
    reviewer: { identity: 'g20-reviewer', capabilityId: 'review', adapter: {
      id: 'g20-reviewer', display_name: 'Finite local structured reviewer', cost_tier: 'low',
      capabilities: () => [CapabilitySchema.parse({ id: 'review', kind: 'review.code', agent_id: 'g20-reviewer', description: 'Review frozen candidate' })],
      isAvailable: async () => ({ available: true, last_checked_at: 0 }),
      invoke: async function* (task) {
        state.activeReviewers++; state.reviewCalls++;
        try { yield { event_id: 'done', run_id: task.run_id, session_id: task.session_id, seq: 1, created_at: Date.now() / 1000, terminal: true, type: 'done', payload: { status: 'completed', last_seq: 0, result_summary: state.summary } }; }
        finally { state.activeReviewers--; }
      },
      confirmStopped: async () => ({ stopped: state.stopConfirmed && state.activeReviewers === 0, evidence: `finite fixture adapter: active=${state.activeReviewers}` }),
    } },
    verifyReviewer: async pair => { expect(pair.reviewerIdentity).not.toBe(pair.writerIdentity); },
    slots: { review: { ...slots.review, workspaceLeaseRef: 'review-workspace', tokenReservation: 1 }, tests: { ...slots.tests, workspaceLeaseRef: 'tests-workspace', tokenReservation: 1 } },
    effectIdentity: kind => {
      const row = db.prepare('SELECT logical_attempt,effect_key FROM graph_actions WHERE graph_run_id=? AND node_id=? AND state=? ORDER BY logical_attempt DESC').get(binding.graphRunId, kind, 'running') as { logical_attempt: number; effect_key: string } | undefined;
      if (!row) throw new Error('G20_NO_RUNNING_EFFECT');
      return { effect: { schemaVersion: 1, scope: binding.scope, graphRunId: binding.graphRunId, specHash: binding.specHash, epoch: 0, ...slots[kind], logicalAttempt: row.logical_attempt }, effectKey: row.effect_key };
    },
  });
  const freezeAction: GraphRegisteredAction = { nodeId: 'freeze', effectSlot: 'invoke', tokenReservation: 0, action: { kind: 'freeze', workspaceLeaseRef: 'source', receiptRef: 'fixture-base' }, execution: { kind: 'freeze', store: artifacts, input: freezeInput, authority }, persist: async evidence => ({ evidenceRef: 'fixture-freeze', actualTokens: 0, result: evidence.frozenCandidate! }) };
  const broker = new GraphActionBroker(db, { acquire });
  const registration = () => { const r = current(); return { scope: r.scope, graphRunId: r.graphRunId, identity: r.identity, generation: r.generation, owner: r.leaseOwner!, epoch: 0, workspace: { workspace_id: 'w', workspace_path: repo }, authorize, actions: [{ ...freezeAction, execution: { kind: 'freeze' as const, store: artifacts, input: { ...freezeInput, generation: r.generation, owner: r.leaseOwner! }, authority } }, ...prepared.actions] }; };
  const connection = {}; broker.register(connection, registration()); cleanup.push(() => broker.unregister(connection));
  const invoke = (kind: Kind) => { const r = current(); const action = prepared.actions.find(a => a.nodeId === kind)!; return broker.handle(connection, { schemaVersion: 1, kind: 'worker_action', requestId: kind, scope: r.scope, graphRunId: r.graphRunId, specHash: r.identity.specHash, generation: r.generation, epoch: 0, nodeId: kind, effectSlot: 'invoke', action: action.action }); };
  const coordinator = () => new GraphVerificationJoinService(db, { binding, artifacts, evidenceRoot, slots, nextCost, authorize });
  const service = coordinator();
  const evaluate = () => service.evaluate(fence());
  const actions = (): GraphAction[] => (db.prepare('SELECT effect_key FROM graph_actions ORDER BY node_id,logical_attempt').all() as { effect_key: string }[]).map(row => new GraphActionStore(db).get(fence(), row.effect_key).action);
  const rows = () => db.prepare('SELECT * FROM graph_verification_joins').all();
  return { root, db, runs, request, version, modulePath, current, fence, state, artifacts, candidate, binding, evidenceRoot, prepared, broker, connection, registration, invoke, coordinator, evaluate, actions, rows, authorize };
}

it.each([['review', 'tests'], ['tests', 'review']] as const)('joins real negative outcomes in %s then %s order and publishes one immutable row', async (first, second) => {
  const f = await fixture();
  for (const workspace of [f.prepared.reviewWorkspace, f.prepared.testsWorkspace]) expect(git(workspace.workspace_path, 'rev-parse', 'HEAD')).toBe(f.candidate.candidateRevision);
  expect(f.prepared.reviewWorkspace.workspace_path).not.toBe(f.prepared.testsWorkspace.workspace_path);
  expect(await f.invoke(first)).toMatchObject({ outcome: { state: 'confirmed' } });
  const missing = await f.evaluate(); expect(missing).toMatchObject({ joined: { status: 'blocked', missing: [second] }, route: { kind: 'stop', reason: 'missing_predecessor' } }); expect(f.rows()).toHaveLength(0);
  expect(await f.invoke(second)).toMatchObject({ outcome: { state: 'confirmed' } });
  const before = f.current(); const complete = await f.evaluate();
  expect(complete).toMatchObject({ joined: { status: 'complete', missing: [] }, route: { kind: 'repair_required', epoch: 0, nextEpoch: 1 }, publication: { created: true } });
  expect(complete.joined.branches.map(b => b.kind)).toEqual(['review', 'tests']);
  expect(complete.joined.branches.map(b => b.result)).toMatchObject([{ verdict: 'changes_requested' }, { passed: false }]);
  const row = f.rows(); const replay = await f.evaluate();
  expect(replay.joined).toEqual(complete.joined); expect(replay.publication).toEqual({ record: complete.publication!.record, created: false });
  expect(f.rows()).toEqual(row); expect(f.rows()).toHaveLength(1);
  expect(replay.snapshot.budget).toMatchObject({ actionStarts: 2, chargedTokens: '2', reservedTokens: '0' });
  expect(f.current().createdAt).toBe(before.createdAt); expect(f.current().spec).toEqual(before.spec);
}, 20_000);

it('unknown reviewer remains reconciliation-only on repeated evaluation and cannot allocate retry', async () => {
  const f = await fixture(); f.state.stopConfirmed = false;
  expect(await f.invoke('review')).toMatchObject({ outcome: { state: 'unknown' } });
  await f.invoke('tests');
  for (let i = 0; i < 2; i++) { const result = await f.evaluate(); expect(result).toMatchObject({ joined: { status: 'blocked' }, route: { kind: 'reconcile' } }); expect(result.publication).toBeUndefined(); }
  await expect(f.broker.retryAuthorized(f.connection, f.actions().find(a => a.state === 'unknown')!.effectKey, f.authorize)).rejects.toThrow();
  expect(f.state.reviewCalls).toBe(1); expect(f.rows()).toHaveLength(0);
}, 20_000);

it('host retry allocates attempt two and recomputes latest durable evidence instead of replaying failed RETURN', async () => {
  const f = await fixture(); f.state.summary = 'malformed reviewer JSON';
  const oldReturn = await f.invoke('review'); await f.invoke('tests');
  expect(oldReturn).toMatchObject({ outcome: { state: 'failed', error: { code: 'OUTPUT_CONTRACT_INVALID', retryable: true } } });
  expect(f.actions()[0]!.outcome).toMatchObject({ retrySafe: true });
  expect(await f.evaluate()).toMatchObject({ route: { kind: 'retry_required', branches: ['review'] } }); expect(f.rows()).toHaveLength(0);
  const original = f.current(); f.state.summary = report;
  expect(await f.broker.retryAuthorized(f.connection, f.actions()[0]!.effectKey, f.authorize)).toMatchObject({ effect: { logicalAttempt: 2 }, outcome: { state: 'confirmed' } });
  const joined = await f.evaluate(); expect(joined).toMatchObject({ joined: { status: 'complete', expected: { review: { logicalAttempt: 2 } } }, route: { kind: 'repair_required' } });
  expect(oldReturn).toMatchObject({ outcome: { state: 'failed' } });
  expect(joined.snapshot.budget).toMatchObject({ actionStarts: 3, chargedTokens: '3' });
  expect(f.current().createdAt).toBe(original.createdAt); expect(f.current().spec).toEqual(original.spec);
  const review = joined.snapshot.actions.filter(a => a.action.kind === 'review');
  const latest = review.find(a => a.effect.logicalAttempt === 2)!;
  const oldEvidence = review.find(a => a.effect.logicalAttempt === 1)!.outcome!.evidenceRef;
  await expect(loadGraphVerificationEvidence(f.evidenceRoot, oldEvidence, f.binding, { effect: latest.effect, effectKey: latest.effectKey })).rejects.toThrow(/replay|identity|attempt/);
  // SQLite itself rejects substituting the real old envelope into attempt 2.
  // Keep that protection intact instead of disabling triggers for the test.
  const published = f.rows();
  expect(() => f.db.prepare('UPDATE graph_actions SET outcome_json=? WHERE effect_key=?')
    .run(JSON.stringify({ ...latest.outcome, evidenceRef: oldEvidence }), latest.effectKey)).toThrow(/immutable/);
  expect((await f.evaluate()).joined).toEqual(joined.joined); expect(f.rows()).toEqual(published);
}, 20_000);

it('rejects a stale fence and revoked authority across asynchronous artifact evidence verification', async () => {
  const f = await fixture(); await f.invoke('review'); await f.invoke('tests');
  const stale = f.fence(); await f.evaluate(); await expect(f.coordinator().evaluate(stale)).rejects.toThrow();
  const saved = f.rows(); const verify = f.artifacts.verify.bind(f.artifacts);
  let entered!: () => void; let release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.artifacts, 'verify').mockImplementation(async digest => { const result = await verify(digest); entered(); await gate; return result; });
  const pending = f.coordinator().evaluate(f.fence()); const rejected = expect(pending).rejects.toThrow('G20_AUTHORITY_REVOKED');
  await waiting; f.state.revoked = true; release(); await rejected; expect(f.rows()).toEqual(saved);
}, 20_000);

it('held real admission release prevents publication even when both branches are confirmed', async () => {
  const f = await fixture(); f.state.holdRelease = true;
  await expect(f.invoke('review')).rejects.toThrow('G20_RELEASE_HELD'); await expect(f.invoke('tests')).rejects.toThrow('G20_RELEASE_HELD');
  const result = await f.evaluate(); expect(result).toMatchObject({ joined: { status: 'complete' }, route: { kind: 'reconcile', reason: 'resource_release_pending' } });
  expect(result.snapshot.pendingAdmissions).toBe(2); expect(result.publication).toBeUndefined(); expect(f.rows()).toHaveLength(0);
}, 20_000);

it('revalidates durable evidence bytes after a successful publication instead of trusting a cached join', async () => {
  const f = await fixture(); await f.invoke('review'); await f.invoke('tests'); const decision = await f.evaluate(); const saved = f.rows();
  const review = decision.joined.branches[0]!.result!; if (review.kind !== 'review') throw new Error('expected review');
  const evidence = review.evidenceRefs[0]!;
  const path = join(f.evidenceRoot, 'evidence', evidence.slice('graph-verification:'.length) + '.json');
  await chmod(path, 0o600); await writeFile(path, (await readFile(path, 'utf8')) + ' ');
  await expect(f.evaluate()).rejects.toThrow(/digest/); expect(f.rows()).toEqual(saved);
}, 20_000);

it.each([
  { maxActionStarts: 2 }, { tokenReservationLimit: 2 }, { maxEpochs: 1 },
])('retains original repair limits %j after actual branch execution', async limits => {
  const f = await fixture({ limits }); await f.invoke('review'); await f.invoke('tests');
  expect(await f.evaluate()).toMatchObject({ joined: { status: 'complete' }, route: { kind: 'stop', reason: limits.maxEpochs ? 'epoch_budget' : 'action_or_token_budget' } });
  expect(f.current().spec!.limits).toEqual(f.request.spec.limits);
}, 20_000);

it('retains original branch-attempt limit on malformed output and original elapsed deadline', async () => {
  const f = await fixture({ limits: { maxBranchAttempts: 1 } }); f.state.summary = 'invalid'; await f.invoke('review'); await f.invoke('tests');
  expect(await f.evaluate()).toMatchObject({ route: { kind: 'stop', reason: 'branch_budget' } });
  await expect(f.broker.retryAuthorized(f.connection, f.actions()[0]!.effectKey, f.authorize)).rejects.toThrow();
  const atDeadline = f.current().createdAt + f.request.spec.limits.deadlineSeconds * 1000;
  expect(await f.coordinator().evaluate(f.fence(atDeadline), () => atDeadline)).toMatchObject({ route: { kind: 'stop', reason: 'deadline_budget' } });
  expect(f.rows()).toHaveLength(0); expect(f.state.reviewCalls).toBe(1);
}, 20_000);

const verificationPhase = `
export async function run(ctx) {
  process.on('SIGTERM', () => {});
  process.on('unhandledRejection', () => {});
  setInterval(() => {}, 1000);
  const call = async (nodeId, action) => {
    const b = ctx.binding;
    console.log('task-enter:' + nodeId + ':' + b.generation);
    const response = await ctx.action({schemaVersion:1,kind:'worker_action',requestId:nodeId+':'+b.generation,
      scope:b.scope,graphRunId:b.graphRunId,specHash:b.identity.specHash,generation:b.generation,
      epoch:0,nodeId,effectSlot:'invoke',action});
    if (response.kind !== 'worker_action_response' || response.outcome.state === 'unknown') { console.error('verification-rejected:' + JSON.stringify(response)); throw new Error(JSON.stringify(response)); }
    return response;
  };
  const frozen = await ctx.task('freeze', async () => {
    const response = await call('freeze', {kind:'freeze',workspaceLeaseRef:'source',receiptRef:'fixture-base'});
    if(response.outcome.state !== 'confirmed') throw new Error(JSON.stringify(response));
    return response.outcome.result;
  })();
  const branches = await Promise.all([
    ctx.task('review', async () => call('review', {kind:'review',workspaceLeaseRef:'review-workspace',candidateRevision:frozen.candidateRevision,acceptanceRef:'acceptance'}))(),
    ctx.task('tests', async () => call('tests', {kind:'tests',workspaceLeaseRef:'tests-workspace',candidateRevision:frozen.candidateRevision,commandSpecRef:'acceptance'}))(),
  ]);
  // This is only a worker proposal. The host independently recomputes the ledger join.
  return {phase:'verification',claimedPass:true,branches};
}`;

function workerRuntime(f: Awaited<ReturnType<typeof fixture>>) {
  const checkpoints = new GraphCheckpointService({ runs: f.runs, checkpoints: new GraphCheckpointStore(f.db), bindings: new Map() });
  const runtime = new GraphRuntime({ db: f.db, broker: f.broker, checkpoints,
    programs: [{ id: 'verification-phase', modulePath: f.modulePath, digest: f.version.compiledProgramDigest }],
    workerOptions: { shutdownTimeoutMs: 30, terminationTimeoutMs: 30 }, drainTimeoutMs: 2000 });
  cleanup.push(() => runtime.close());
  const start = (resume = false) => runtime.start({ request: f.request, run: f.current(), programId: 'verification-phase', registration: f.registration(), authorize: f.authorize, ...(resume ? { resume: { kind: 'continue' as const } } : {}) });
  return { runtime, checkpoints, start };
}

it('real worker partial RETURN survives stop/drain and G15 takeover; host retry supersedes cached malformed review', async () => {
  const f = await fixture({ source: verificationPhase, command: "printf 'run\\n' >> '%ROOT%/command-starts'; exit 1" });
  f.state.summary = 'malformed'; const w = workerRuntime(f);
  const actualHandle = f.broker.handle.bind(f.broker);
  let release!: () => void; let boundary!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = new Promise<void>(resolve => { boundary = resolve; });
  let intercepted = false;
  vi.spyOn(f.broker, 'handle').mockImplementation(async (...args) => {
    const result = await actualHandle(...args);
    // Real G04 command, evidence persistence and ledger commit already finished.
    // Only its IPC response is delayed so review's task RETURN can commit first.
    if (!intercepted && result.kind === 'worker_action_response' && result.effect.nodeId === 'tests') {
      intercepted = true; boundary(); await gate;
    }
    return result;
  });
  let first: GraphRuntimeHandle | undefined;
  try {
    first = w.start(); void first.result.catch(() => {}); await first.ready; await held;
    const returns = () => f.db.prepare("SELECT value FROM graph_checkpoint_writes WHERE channel='__return__'").all() as { value: string }[];
    await expect.poll(() => returns().filter(row => row.value.includes('OUTPUT_CONTRACT_INVALID')).length, { timeout: 5000 }).toBe(1);
    expect(returns().filter(row => row.value.includes('"kind":"tests"'))).toHaveLength(0);
    const before = f.current();
    expect(await f.evaluate()).toMatchObject({ route: { kind: 'retry_required', branches: ['review'] } });
    // Stop the actual child and drain the actual held broker promise before G15.
    const stopping = first.stop(); release(); const stopped = await stopping;
    expect(stopped).toMatchObject({ actionsSettled: true, worker: { kind: 'exited', signal: 'SIGKILL' } });
    expect(w.runtime.observedExit(first.connection)).toEqual(stopped.worker);
    await writeFile(join(f.root, 'actual-worker-stop.json'), JSON.stringify(stopped));
    const oldConnection = first.connection; const oldBinding = first.binding;
    const key = {}; const fixed = f.current();
    const verifyStopped = () => {
      const observed = w.runtime.observedExit(oldConnection);
      if (!stopped.actionsSettled || stopped.worker.kind !== 'exited' || JSON.stringify(observed) !== JSON.stringify(stopped.worker)) throw new Error('G20_NO_OBSERVED_DRAINED_EXIT');
      if (stopped.worker.generation !== fixed.generation || stopped.worker.owner !== fixed.leaseOwner) throw new Error('G20_EXIT_IDENTITY');
      return stopped.worker;
    };
    w.runtime.reconciler.register(key, {
      binding: { scope: fixed.scope, graphRunId: fixed.graphRunId, identity: fixed.identity, generation: fixed.generation, owner: fixed.leaseOwner },
      authorize: f.authorize,
      stopWorker: async () => stopped,
      verifyWorker: async () => { const exit = verifyStopped(); return { kind: 'stopped', graphRunId: exit.graphRunId, generation: exit.generation, owner: exit.owner, confirmedAt: exit.confirmedAt, evidenceRef: exit.evidenceRef }; },
      verifyQuiescence: async () => {
        verifyStopped(); expect(f.state.activeReviewers).toBe(0);
        const evidenceRefs: string[] = [];
        for (const action of f.actions().filter(a => a.action.kind === 'review' || a.action.kind === 'tests')) {
          if (!action.outcome) throw new Error('G20_UNSETTLED_EXECUTOR');
          const envelope = await loadGraphVerificationEvidence(f.evidenceRoot, action.outcome.evidenceRef, f.binding, { effect: action.effect, effectKey: action.effectKey });
          expect(envelope.evidence.stopped).toBe(true);
          if (envelope.kind === 'tests') expect(envelope.evidence.command!.termination).toMatchObject({ stop_confirmed: true, trigger: 'exit' });
          evidenceRefs.push(action.outcome.evidenceRef);
        }
        await f.artifacts.verify(f.candidate.artifactDigest);
        for (const workspace of [f.prepared.reviewWorkspace, f.prepared.testsWorkspace]) expect(git(workspace.workspace_path, 'rev-parse', 'HEAD')).toBe(f.candidate.candidateRevision);
        // Preserve both restored repositories and their actual evidence for recovery.
        await writeFile(join(f.root, 'quiescence.json'), JSON.stringify({ evidenceRefs, workspaces: [f.prepared.reviewWorkspace, f.prepared.testsWorkspace], retained: true }));
        return { executorEvidenceRef: evidenceRefs[0]!, workspaceEvidenceRef: f.candidate.artifactRefs[0]! };
      },
      verifyOutcome: async () => { throw new Error('takeover must not reconcile or fabricate an effect outcome'); },
      recheck: () => { verifyStopped(); f.authorize(); expect(f.state.activeReviewers).toBe(0); },
      release: async (_result, reverify) => { await reverify(); },
    });
    const takeover = await w.runtime.reconciler.reconcile(key, { kind: 'takeover', fence: f.fence(), receiptId: 'actual-verification-worker-exit', owner: 'g20-worker-2', leaseExpiresAt: Date.now() + 120_000 });
    expect(takeover.exit).toBe('takeover'); expect(f.current().generation).toBe(oldBinding.generation + 1);
    expect(await f.broker.handle(oldConnection, { schemaVersion: 1, kind: 'worker_action', requestId: 'retired', scope: oldBinding.scope, graphRunId: oldBinding.graphRunId, specHash: oldBinding.identity.specHash, generation: oldBinding.generation, epoch: 0, nodeId: 'review', effectSlot: 'invoke', action: f.prepared.actions[0]!.action })).toMatchObject({ kind: 'worker_action_rejected', error: { code: 'UNAUTHENTICATED' } });
    // Allocate a retry through a fresh host-authorized registration, before resume.
    f.broker.unregister(f.connection); const recoveryConnection = {}; f.broker.register(recoveryConnection, f.registration());
    cleanup.push(() => f.broker.unregister(recoveryConnection));
    const review = f.actions().find(a => a.action.kind === 'review')!; f.state.summary = report;
    expect(await f.broker.retryAuthorized(recoveryConnection, review.effectKey, f.authorize)).toMatchObject({ effect: { logicalAttempt: 2 }, outcome: { state: 'confirmed' } });
    const latest = await f.evaluate(); expect(latest).toMatchObject({ joined: { status: 'complete', expected: { review: { logicalAttempt: 2 } } }, route: { kind: 'repair_required' }, publication: { created: true } });
    const second = w.start(true); void second.result.catch(() => {});
    const proposal = await second.result;
    expect(proposal).toMatchObject({ phase: 'verification', claimedPass: true, branches: [{ effect: { logicalAttempt: 1 }, outcome: { state: 'failed' } }, { outcome: { state: 'confirmed', result: { passed: false } } }] });
    const secondStop = await second.stop(); expect(secondStop).toMatchObject({ actionsSettled: true, worker: { kind: 'exited' } });
    expect(second.logs().stdout).toContain('task-enter:tests:2');
    expect(second.logs().stdout).not.toContain('task-enter:review:2'); expect(second.logs().stdout).not.toContain('task-enter:freeze:2');
    const final = await f.evaluate(); expect(final.joined).toEqual(latest.joined); expect(final.publication?.created).toBe(false); expect(f.rows()).toHaveLength(1);
    expect(final.snapshot.budget).toMatchObject({ actionStarts: 4, chargedTokens: '3', reservedTokens: '0' });
    expect(f.state.reviewCalls).toBe(2); expect(await readFile(join(f.root, 'command-starts'), 'utf8')).toBe('run\n');
    expect(f.current().spec).toEqual(before.spec); expect(f.current().createdAt).toBe(before.createdAt);
    expect(f.db.prepare('SELECT count(*) AS n FROM graph_recovery_decisions').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT count(*) AS n FROM graph_checkpoints').get()).toMatchObject({ n: expect.any(Number) });
  } finally { release(); if (first) await first.stop(); }
}, 35_000);

it('actual Functional task throws for unknown verification outcome and host refuses worker pass proposal', async () => {
  const f = await fixture({ source: verificationPhase }); f.state.stopConfirmed = false;
  const w = workerRuntime(f); const handle = w.start();
  await expect(handle.result).rejects.toThrow();
  expect(handle.logs().stderr).toContain('ACTION_OUTCOME_UNKNOWN');
  const stopped = await handle.stop(); expect(stopped).toMatchObject({ actionsSettled: true, worker: { kind: 'exited' } });
  const decision = await f.evaluate(); expect(decision).toMatchObject({ joined: { status: 'blocked' }, route: { kind: 'reconcile' } }); expect(decision.publication).toBeUndefined();
  expect(f.rows()).toHaveLength(0); expect(f.state.reviewCalls).toBe(1);
  const taskReturns = f.db.prepare("SELECT value FROM graph_checkpoint_writes WHERE channel='__return__'").all() as { value: string }[];
  expect(taskReturns.some(row => row.value.includes('claimedPass'))).toBe(false);
  expect(f.actions().find(a => a.action.kind === 'review')?.state).toBe('unknown');
}, 25_000);

it.each(['revoke', 'fence', 'renewal', 'admission-release'] as const)('rejects %s changing during the actual durable envelope read', async change => {
  const f = await fixture();
  if (change === 'admission-release') {
    f.state.holdRelease = true;
    await expect(f.invoke('review')).rejects.toThrow('G20_RELEASE_HELD');
    await expect(f.invoke('tests')).rejects.toThrow('G20_RELEASE_HELD');
  } else { await f.invoke('review'); await f.invoke('tests'); }
  const action = f.actions().find(a => a.action.kind === 'review')!;
  const evidenceRef = action.outcome!.evidenceRef;
  const path = join(f.evidenceRoot, 'evidence', evidenceRef.slice('graph-verification:'.length) + '.json');
  const probe = await open(path, 'r'); const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const originalRead = prototype.readFile; await probe.close();
  let enter!: () => void; let release!: () => void; let intercepted = false;
  const entered = new Promise<void>(resolve => { enter = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  // Delay only real bytes from this host envelope; no receipt, ledger or saver is mocked.
  vi.spyOn(prototype, 'readFile').mockImplementation(async function(this: FileHandle, ...args) {
    const bytes = await originalRead.apply(this, args);
    if (!intercepted && bytes.toString().includes(action.effectKey)) { intercepted = true; enter(); await gate; }
    return bytes;
  });
  const revision = f.current().revision;
  const pending = f.evaluate(); const rejected = expect(pending).rejects.toThrow(change === 'revoke' ? 'G20_AUTHORITY_REVOKED' : change === 'admission-release' ? 'VERIFICATION_SNAPSHOT_CHANGED' : /REVISION|revision/);
  try {
    await entered;
    if (change === 'revoke') f.state.revoked = true;
    else if (change === 'fence') f.runs.project({ ...f.fence(), status: 'running' });
    else if (change === 'renewal') f.runs.renewLease({ ...f.fence(), leaseExpiresAt: f.current().leaseExpiresAt! + 1000 });
    else {
      f.state.holdRelease = false;
      expect(await f.broker.releaseReconciled(action.effectKey, async () => {
        const envelope = await loadGraphVerificationEvidence(f.evidenceRoot, evidenceRef, f.binding, { effect: action.effect, effectKey: action.effectKey });
        expect(envelope.evidence.stopped).toBe(true); expect(f.state.activeReviewers).toBe(0);
      })).toBe(true);
      expect(f.current().revision).toBe(revision); // admission releases deliberately have no run CAS revision
    }
  } finally { release(); }
  await rejected; expect(f.rows()).toHaveLength(0);
}, 20_000);

it('a new actual unknown action invalidates routing from an already published join', async () => {
  const f = await fixture(); await f.invoke('review'); await f.invoke('tests'); await f.evaluate(); const published = f.rows();
  const connection = {};
  const action: GraphRegisteredAction = { ...f.prepared.actions[1]!, nodeId: 'postjoin-probe', persist: async () => { throw new Error('G20_LOST_PERSIST_ACK'); } };
  f.broker.register(connection, { ...f.registration(), actions: [action] }); cleanup.push(() => f.broker.unregister(connection));
  const r = f.current();
  expect(await f.broker.handle(connection, { schemaVersion: 1, kind: 'worker_action', requestId: 'postjoin', scope: r.scope, graphRunId: r.graphRunId, specHash: r.identity.specHash, generation: r.generation, epoch: 0, nodeId: action.nodeId, effectSlot: action.effectSlot, action: action.action })).toMatchObject({ outcome: { state: 'unknown' } });
  for (let i = 0; i < 2; i++) {
    const result = await f.evaluate(); expect(result.route.kind).toBe('reconcile'); expect(result.publication).toBeUndefined();
    expect(result.snapshot.unresolvedActions).toBe(1); expect(f.rows()).toEqual(published);
  }
  const unknown = f.actions().find(a => a.state === 'unknown')!;
  await expect(f.broker.retryAuthorized(connection, unknown.effectKey, f.authorize)).rejects.toThrow();
}, 20_000);

it('publishes an actual passing candidate at exact action and token limits', async () => {
  const f = await fixture({ command: 'exit 0', limits: { maxActionStarts: 2, tokenReservationLimit: 2, maxEpochs: 1 } });
  f.state.summary = JSON.stringify({ schemaVersion: 1, verdict: 'accept', summary: 'Accepted', findings: [] });
  await f.invoke('review'); await f.invoke('tests');
  expect(await f.evaluate()).toMatchObject({ route: { kind: 'ready' }, publication: { created: true }, snapshot: { budget: { actionStarts: 2, chargedTokens: '2' } } });
}, 15000);
it('routes a legacy pre-invocation failure to stop without requiring a GraphError or report', async () => {
  const f = await fixture(); await writeFile(join(f.prepared.reviewWorkspace.workspace_path, 'untracked'), 'changed');
  expect(await f.invoke('review')).toMatchObject({ kind: 'worker_action_rejected' }); await f.invoke('tests');
  expect(f.state.reviewCalls).toBe(0);
  expect(f.actions().find(a => a.action.kind === 'review')?.outcome).toMatchObject({ state: 'failed', retrySafe: true, error: { message: 'admission refused before invocation' } });
  expect(await f.evaluate()).toMatchObject({ route: { kind: 'stop', reason: 'branch_failure' } }); expect(f.rows()).toHaveLength(0);
}, 15000);
it('preserves a failed ledger settlement with a valid unclassified verification receipt', async () => {
  const f = await fixture(); await f.invoke('review'); const controller = new AbortController(); const connection = {};
  const registered = f.registration();
  f.broker.register(connection, { ...registered, actions: registered.actions.map(action => action.action.kind !== 'tests' ? action : { ...action,
    persist: async evidence => { const saved = await action.persist(evidence); controller.abort(); return saved; } }) });
  cleanup.push(() => f.broker.unregister(connection));
  const action = f.prepared.actions[1]!; const r = f.current();
  expect(await f.broker.handle(connection, { schemaVersion: 1, kind: 'worker_action', requestId: 'cancel-after-persist', scope: r.scope, graphRunId: r.graphRunId,
    generation: r.generation, specHash: r.identity.specHash, epoch: 0, nodeId: 'tests', effectSlot: 'invoke', action: action.action }, { signal: controller.signal })).toMatchObject({ outcome: { state: 'failed' } });
  expect(await f.evaluate()).toMatchObject({ route: { kind: 'stop', reason: 'branch_failure' } }); expect(f.rows()).toHaveLength(0);
}, 15000);

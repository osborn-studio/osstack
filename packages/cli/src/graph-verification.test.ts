import { createHash } from 'node:crypto';
import type { AgentTask } from '@osstack/agents';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { GraphArtifactStore } from '@osstack/core/graph-artifacts';
import { resolveRepositoryScope, CapabilitySchema, openDb, GraphRunStore } from '@osstack/core';
import { FifoSemaphore } from '@osstack/autonomy';
import { executeCandidateImplementation } from '@osstack/loop';
import { GraphActionBroker, type GraphRegisteredAction } from './graph-action-broker.js';
import { GovernedExecution } from './governed-execution.js';
async function invokeReview(action: GraphRegisteredAction) {
  if (action.execution.kind !== 'adapter' || !action.workspace) throw new Error('expected reviewer');
  const candidate = await executeCandidateImplementation({ plan: { ...action.execution.plan, task: { ...action.execution.plan.task, context: { history: ['writer secret'], native_session_id: 'writer-session' } } }, workspace: action.workspace, adapters: [action.execution.adapter], authorize: () => ({ allow: true }) });
  return { status: 'completed' as const, stopped: true as const, candidate };
}
function reviewAdapter(summary: () => string): GraphVerificationOptions['reviewer']['adapter']['invoke'] {
  return async function* (task) {
    yield { event_id: 'done', run_id: task.run_id, session_id: task.session_id, seq: 1, created_at: Date.now() / 1000, terminal: true, type: 'done', payload: { status: 'completed', last_seq: 0, result_summary: summary() } };
  };
}
const close: Array<() => void> = [];
afterEach(() => { for (const fn of close.splice(0)) fn(); });
import { computeGraphEffectKey } from '@osstack/protocol';
import { prepareGraphVerification, loadGraphVerificationEvidence, type GraphVerificationOptions } from './graph-verification.js';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'g19-'))); const repo = join(root, 'source'); await mkdir(repo);
  git(repo, 'init', '-q'); await writeFile(join(repo, 'file'), 'candidate'); git(repo, 'add', '.'); git(repo, '-c', 'user.name=test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'base');
  const scope = { schemaVersion: 1 as const, tenantId: 't', principalId: 'p', workspaceId: 'w' };
  const db = openDb({ path: join(root, 'control.sqlite') }); close.push(() => db.close()); const runs = new GraphRunStore(db);
  const created = runs.create({ schemaVersion: 1, kind: 'start', scope, idempotencyKey: 'verification', inputArtifactRef: 'input', source: { product: 'osstack', requestId: 'request' }, spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only', input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: git(repo, 'rev-parse', 'HEAD'), acceptanceRef: 'acceptance' }, limits: { maxEpochs: 1, maxBranchAttempts: 2, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 8, deadlineSeconds: 120, tokenReservationLimit: 100 } } }, { executionModel: 'langgraph-functional-v1', durability: 'sync', engineVersion: '1.4.15', checkpointVersion: '1.1.5', templateVersion: '1', registryVersion: '1', compilerVersion: '1', schemaVersion: '1', compiledProgramDigest: 'b'.repeat(64) }, Date.now());
  const run = runs.acquireLease({ scope, graphRunId: created.graphRunId, identity: created.identity, expectedGeneration: 0, expectedRevision: 0, expectedOwner: null, now: Date.now(), owner: 'worker', leaseExpiresAt: Date.now() + 120000 });
  const canonical = await resolveRepositoryScope(repo); const artifacts = new GraphArtifactStore(join(root, 'artifacts'));
  const candidate = await artifacts.freeze({ artifactId: 'candidate', scope, runId: run.graphRunId, generation: 1, owner: 'owner', workspaceLeaseRef: 'source-lease', repoId: canonical.repoId, commonDir: canonical.commonDir, worktreePath: repo, baseRevision: git(repo, 'rev-parse', 'HEAD'), implementationReceiptRef: 'receipt', producerStopEvidenceRef: 'stop' }, { lease: {}, verifyLease: () => {}, verifyImplementationReceipt: () => {}, verifyProducersStopped: () => {} });
  const binding = { scope, graphRunId: run.graphRunId, specHash: run.identity.specHash, epoch: 0, candidateRevision: candidate.candidateRevision, artifactDigest: candidate.artifactDigest, acceptanceRef: 'acceptance' };
  const effectIdentity = (kind: 'review' | 'tests') => { const effect = { schemaVersion: 1 as const, scope, graphRunId: run.graphRunId, specHash: binding.specHash, epoch: 0, nodeId: kind, effectSlot: 'invoke', logicalAttempt: 1 }; return { effect, effectKey: computeGraphEffectKey(effect) }; };
  let admitted = false; const authorize = vi.fn(() => {});
  const options: GraphVerificationOptions = { root: join(root, 'verification'), artifacts, candidate, binding, sourceWorkspace: { workspace_id: 'w', workspace_path: repo }, authorize,
    acquire: async () => { admitted = true; return { release: async () => { admitted = false; }, retain: () => {}, assertActive: async () => { if (!admitted) throw new Error('inactive'); } }; },
    acceptanceRegistry: [{ ref: 'acceptance', command: 'exit 1', passExitCodes: [0], failExitCodes: [1] }], writerIdentity: 'writer',
    reviewer: { identity: 'reviewer', capabilityId: 'review', adapter: { id: 'reviewer', display_name: 'Independent reviewer', cost_tier: 'low', capabilities: () => [CapabilitySchema.parse({ id: 'review', kind: 'review.code', agent_id: 'reviewer', description: 'Review' })], isAvailable: async () => ({ available: true, last_checked_at: 0 }), invoke: async function* () {}, confirmStopped: async () => ({ stopped: true, evidence: 'executor stopped' }) } },
    verifyReviewer: async pair => { expect(pair.writerIdentity).not.toBe(pair.reviewerIdentity); }, effectIdentity };
  return { root, db, run, options, binding, candidate, authorize, admitted: () => admitted };
}
it('restores the exact verified candidate into independent repositories and rejects reviewer writes', async () => {
  const f = await fixture(); const prepared = await prepareGraphVerification(f.options);
  expect(f.admitted()).toBe(false);
  expect(prepared.reviewWorkspace.workspace_path).not.toBe(prepared.testsWorkspace.workspace_path);
  for (const workspace of [prepared.reviewWorkspace, prepared.testsWorkspace]) expect(git(workspace.workspace_path, 'rev-parse', 'HEAD')).toBe(f.candidate.candidateRevision);
  expect(git(prepared.reviewWorkspace.workspace_path, 'rev-parse', '--absolute-git-dir')).not.toBe(git(prepared.testsWorkspace.workspace_path, 'rev-parse', '--absolute-git-dir'));
  await writeFile(join(prepared.reviewWorkspace.workspace_path, 'untracked'), 'mutation');
  await expect(prepared.actions[0]!.verifyWorkspace!()).rejects.toThrow(/mutat|candidate/);
  await writeFile(join(prepared.testsWorkspace.workspace_path, 'file'), 'changed before test invocation');
  await expect(prepared.actions[1]!.verifyWorkspace!()).rejects.toThrow(/mutat|candidate/);
}, 15000);
it('rejects wrong manifest and reviewer identity before restoring or invoking', async () => {
  const f = await fixture();
  await expect(prepareGraphVerification({ ...f.options, writerIdentity: 'reviewer' })).rejects.toThrow(/independen|identity/);
  await expect(prepareGraphVerification({ ...f.options, binding: { ...f.binding, graphRunId: 'other' } })).rejects.toThrow(/manifest|binding/);
  await expect(prepareGraphVerification({ ...f.options, sourceWorkspace: { workspace_id: 'wrong', workspace_path: f.options.sourceWorkspace.workspace_path } })).rejects.toThrow(/workspace/);
}, 15000);
it('persists actual stopped exit evidence and rejects tampering/replay', async () => {
  const f = await fixture(); const p = await prepareGraphVerification(f.options); const tests = p.actions[1]!;
  const saved = await tests.persist({ status: 'failed', stopped: true, command: { command: 'exit 1', exitCode: 1, stdout: '', stderr: '', durationMs: 1, termination: { scope: 'posix_process_group', trigger: 'exit', leader_exit_code: 1, stop_confirmed: true, signals: [], evidence: 'group gone' } } });
  expect(saved.result).toMatchObject({ kind: 'tests', passed: false });
  const envelope = await loadGraphVerificationEvidence(f.options.root, saved.evidenceRef, f.binding, f.options.effectIdentity('tests'));
  expect(envelope.effect.logicalAttempt).toBe(1);
  await expect(loadGraphVerificationEvidence(f.options.root, saved.evidenceRef, { ...f.binding, epoch: 1 })).rejects.toThrow();
  const path = join(f.options.root, 'evidence', saved.evidenceRef.slice('graph-verification:'.length) + '.json');
  const bytes = await readFile(path, 'utf8'); await import('node:fs/promises').then(fs => fs.chmod(path, 0o600)); await writeFile(path, bytes.replace('group gone', 'forged'));
  await expect(loadGraphVerificationEvidence(f.options.root, saved.evidenceRef, f.binding)).rejects.toThrow(/digest/);
}, 15000);
it('keeps unknown stop separate from stopped malformed review and valid changes_requested', async () => {
  const f = await fixture(); let summary = 'garbage';
  f.options.reviewer.adapter.invoke = reviewAdapter(() => summary);
  const p = await prepareGraphVerification(f.options); const review = p.actions[0]!;
  await expect(review.persist({ status: 'completed' })).rejects.toThrow(/stop/);
  const raw = await invokeReview(review);
  const malformed = await review.persist(raw);
  expect(malformed.verificationFailure?.code).toBe('OUTPUT_CONTRACT_INVALID'); expect(malformed.result).toBeUndefined();
  summary = JSON.stringify({ schemaVersion: 1, verdict: 'changes_requested', summary: 'Fix bounds', findings: ['Overflow'] });
  const valid = await review.persist(await invokeReview(review));
  expect(valid.result).toMatchObject({ kind: 'review', verdict: 'changes_requested' });
}, 15000);
async function brokerFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const admission = new GovernedExecution({ reads: new FifoSemaphore(2), writes: new FifoSemaphore(2), repositories: new Map(), checkHealth: async () => {} });
  f.options.acquire = admission.acquire.bind(admission);
  // Read exact running identity from the actual G12 ledger, not a predicted attempt.
  f.options.effectIdentity = kind => {
    const row = f.db.prepare('SELECT logical_attempt, effect_key FROM graph_actions WHERE node_id = ? AND state = ? ORDER BY logical_attempt DESC').get(kind, 'running') as { logical_attempt: number; effect_key: string };
    if (!row) throw new Error('no running ledger effect');
    return { effect: { schemaVersion: 1, scope: f.binding.scope, graphRunId: f.binding.graphRunId, specHash: f.binding.specHash, epoch: 0, nodeId: kind, effectSlot: 'invoke', logicalAttempt: row.logical_attempt }, effectKey: row.effect_key };
  };
  const prepared = await prepareGraphVerification(f.options);
  const broker = new GraphActionBroker(f.db, { acquire: admission.acquire.bind(admission) }); const connection = {};
  broker.register(connection, { scope: f.binding.scope, graphRunId: f.run.graphRunId, identity: f.run.identity, generation: f.run.generation, owner: 'worker', epoch: 0, workspace: f.options.sourceWorkspace, authorize: f.options.authorize, actions: prepared.actions });
  const invoke = (kind: 'review' | 'tests') => { const action = prepared.actions[kind === 'review' ? 0 : 1]!; return broker.handle(connection, { schemaVersion: 1, kind: 'worker_action', requestId: kind, generation: f.run.generation, scope: f.binding.scope, graphRunId: f.binding.graphRunId, specHash: f.binding.specHash, epoch: 0, nodeId: action.nodeId, effectSlot: action.effectSlot, action: action.action }); };
  return { prepared, invoke, broker, connection };
}
it('runs real registered command and independent G04 review concurrently with an observable two-way barrier', async () => {
  const f = await fixture(); const commandStarted = join(f.root, 'command-started'); const reviewStarted = join(f.root, 'review-started');
  // Trusted fixture command exchanges only barrier receipts outside both candidate
  // directories; each branch must observe the other before it can complete.
  f.options.acceptanceRegistry = [{ ref: 'acceptance', command: `touch '${commandStarted}'; for i in $(seq 1 100); do if test -f '${reviewStarted}'; then mkdir build; printf output > build/log; exit 1; fi; sleep 0.02; done; exit 99`, passExitCodes: [0], failExitCodes: [1] }];
  const observed: string[] = [];
  f.options.reviewer.adapter.invoke = async function* (task) {
    observed.push(String(task.context?.repo_path));
    expect(task.context).not.toHaveProperty('history');
    await writeFile(reviewStarted, 'review');
    let seen = false;
    for (let i = 0; i < 100; i++) { try { await readFile(commandStarted); seen = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
    expect(seen).toBe(true);
    yield { event_id: 'done', run_id: task.run_id, session_id: task.session_id, seq: 1, created_at: Date.now() / 1000, terminal: true, type: 'done', payload: { status: 'completed', last_seq: 0, result_summary: JSON.stringify({ schemaVersion: 1, verdict: 'changes_requested', summary: 'Fix expected failure', findings: ['Assertion fails'] }) } };
  };
  const f2 = await brokerFixture(f);
  const results = await Promise.all([f2.invoke('review'), f2.invoke('tests')]);
  expect(results[0]).toMatchObject({ outcome: { state: 'confirmed', result: { kind: 'review', verdict: 'changes_requested' } } });
  expect(results[1]).toMatchObject({ outcome: { state: 'confirmed', result: { kind: 'tests', passed: false } } });
  expect(observed).toEqual([f2.prepared.reviewWorkspace.workspace_path]);
  await expect(readFile(join(f2.prepared.reviewWorkspace.workspace_path, 'build/log'))).rejects.toThrow();
  expect(f.db.prepare('SELECT state, logical_attempt FROM graph_actions ORDER BY node_id').all()).toEqual([{ state: 'confirmed', logical_attempt: 1 }, { state: 'confirmed', logical_attempt: 1 }]);
}, 15000);
it.each(['revoke', 'mutate'] as const)('rejects %s during adapter availability before actual invocation', async mode => {
  const f = await fixture(); let revoked = false; let reviewPath = ''; const invoked = vi.fn();
  f.options.authorize = () => { if (revoked) throw new Error('revoked'); };
  f.options.reviewer.adapter.isAvailable = async () => { if (mode === 'revoke') revoked = true; else await writeFile(join(reviewPath, 'file'), 'changed'); return { available: true, last_checked_at: 0 }; };
  f.options.reviewer.adapter.invoke = async function* () { invoked(); yield* []; };
  const f2 = await brokerFixture(f); reviewPath = f2.prepared.reviewWorkspace.workspace_path;
  expect(await f2.invoke('review')).toMatchObject({ kind: 'worker_action_rejected' }); expect(invoked).not.toHaveBeenCalled();
}, 15000);
it('snapshots callback/data replacement and rejects live revocation after preparation awaits', async () => {
  const f = await fixture(); const originalCommand = f.options.acceptanceRegistry[0]!.command;
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  f.options.verifyReviewer = async () => { await barrier; };
  const pending = prepareGraphVerification(f.options);
  f.options.acceptanceRegistry = [{ ref: 'acceptance', command: 'malicious', passExitCodes: [0], failExitCodes: [] }];
  f.options.reviewer.adapter.invoke = async function* () { yield* []; throw new Error('replacement'); };
  f.options.verifyReviewer = async () => { throw new Error('replacement callback'); };
  release(); const p = await pending;
  expect(p.actions[1]!.execution).toMatchObject({ command: originalCommand });
  const f2 = await fixture(); let revoked = false;
  f2.options.authorize = () => { if (revoked) throw new Error('revoked after await'); };
  f2.options.verifyReviewer = async () => { revoked = true; };
  await expect(prepareGraphVerification(f2.options)).rejects.toThrow('revoked after await');
}, 15000);
it('rejects mutation during restore before accepting any workspace baseline', async () => {
  const f = await fixture(); const restore = f.options.artifacts.restore.bind(f.options.artifacts);
  f.options.artifacts.restore = async (...args) => { const restored = await restore(...args); await writeFile(join(restored.worktreePath, 'file'), 'silently replaced'); return restored; };
  await expect(prepareGraphVerification(f.options)).rejects.toThrow(/candidate|tree/);
}, 15000);
it('releases preparation lease if authority is revoked while acquiring it', async () => {
  const f = await fixture(); let revoked = false; const release = vi.fn(async () => {});
  f.options.authorize = () => { if (revoked) throw new Error('revoked'); };
  f.options.acquire = async () => { revoked = true; return { release, retain: () => {}, assertActive: async () => {} }; };
  await expect(prepareGraphVerification(f.options)).rejects.toThrow('revoked'); expect(release).toHaveBeenCalledOnce();
}, 15000);
it('uses exact allowlisted exits, refusing model pass claims and unregistered commands', async () => {
  const f = await fixture();
  f.options.acceptanceRegistry = [{ ref: 'acceptance', command: 'exit 7', passExitCodes: [7], failExitCodes: [1] }];
  const p = await prepareGraphVerification(f.options); const tests = p.actions[1]!;
  const evidence = (exitCode: number) => ({ status: 'failed' as const, stopped: true as const, command: { command: 'exit 7', exitCode, stdout: 'MODEL CLAIMS PASS', stderr: '', durationMs: 1, termination: { scope: 'posix_process_group' as const, trigger: 'exit' as const, leader_exit_code: exitCode, stop_confirmed: true, signals: [], evidence: 'group stopped' } } });
  expect((await tests.persist(evidence(7))).result).toMatchObject({ passed: true });
  await expect(tests.persist({ ...evidence(7), command: { ...evidence(7).command, failure_code: 'surviving_descendants' } })).rejects.toThrow(/stop unconfirmed/);
  expect((await tests.persist(evidence(1))).result).toMatchObject({ passed: false });
  const invalid = await tests.persist(evidence(2)); expect(invalid.verificationFailure?.code).toBe('INTERNAL_ERROR'); expect(invalid.result).toBeUndefined();
  await expect(tests.persist({ ...evidence(7), command: { ...evidence(7).command, command: 'unregistered' } })).rejects.toThrow();
  const saved = await tests.persist(evidence(7)); const effect = f.options.effectIdentity('tests'); effect.effect.logicalAttempt = 2; effect.effectKey = computeGraphEffectKey(effect.effect);
  await expect(loadGraphVerificationEvidence(f.options.root, saved.evidenceRef, f.binding, effect)).rejects.toThrow(/replay/);
}, 15000);
it('does not accept review done as executor stop proof through the actual broker', async () => {
  const f = await fixture();
  f.options.reviewer.adapter.invoke = async function* (task) {
    yield { event_id: 'done', run_id: task.run_id, session_id: task.session_id, seq: 1, created_at: Date.now() / 1000, terminal: true, type: 'done', payload: { status: 'completed', last_seq: 0, result_summary: JSON.stringify({ schemaVersion: 1, verdict: 'accept', summary: 'Claimed good', findings: [] }) } };
  };
  f.options.reviewer.adapter.confirmStopped = async () => ({ stopped: false, evidence: 'still running' });
  const b = await brokerFixture(f); const result = await b.invoke('review');
  expect(result).toMatchObject({ outcome: { state: 'unknown' } });
  expect(f.db.prepare('SELECT state FROM graph_actions WHERE node_id = ?').get('review')).toEqual({ state: 'unknown' });
}, 15000);
it('classifies stopped malformed output and reviewer filesystem mutation without a code-failure result', async () => {
  const f = await fixture(); let mutate = false;
  f.options.reviewer.adapter.invoke = async function* (task) {
    if (mutate) await writeFile(join(String(task.context?.repo_path), 'ignored-or-untracked'), 'mutation');
    yield { event_id: 'done', run_id: task.run_id, session_id: task.session_id, seq: 1, created_at: Date.now() / 1000, terminal: true, type: 'done', payload: { status: 'completed', last_seq: 0, result_summary: 'not JSON' } };
  };
  const b = await brokerFixture(f); const result = await b.invoke('review');
  expect(result).toMatchObject({ outcome: { state: 'failed', error: { code: 'OUTPUT_CONTRACT_INVALID', retryable: true } } });
  mutate = true;
  const g = await fixture(); g.options.reviewer.adapter.invoke = f.options.reviewer.adapter.invoke;
  const c = await brokerFixture(g);
  expect(await c.invoke('review')).toMatchObject({ outcome: { state: 'failed', error: { code: 'INTERNAL_ERROR', retryable: false } } });
}, 15000);
it('rejects manifest scope/SHA mismatch and independent identity verifier rejection before invocation', async () => {
  const f = await fixture(); const invoked = vi.fn(); f.options.reviewer.adapter.invoke = async function* () { invoked(); yield* []; };
  await expect(prepareGraphVerification({ ...f.options, candidate: { ...f.candidate, candidateRevision: 'f'.repeat(40) } })).rejects.toThrow(/binding/);
  await expect(prepareGraphVerification({ ...f.options, binding: { ...f.binding, scope: { ...f.binding.scope, tenantId: 'other' } } })).rejects.toThrow(/manifest/);
  await expect(prepareGraphVerification({ ...f.options, verifyReviewer: async () => { throw new Error('identity rejected independently'); } })).rejects.toThrow(/independently/);
  await expect(prepareGraphVerification({ ...f.options, acceptanceRegistry: [] })).rejects.toThrow(/acceptance/);
  expect(invoked).not.toHaveBeenCalled();
}, 15000);
it('snapshots executor evidence before asynchronous verification and rechecks authority afterward', async () => {
  const f = await fixture(); let pause = false; let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.options.verifyReviewer = async () => { if (pause) await barrier; };
  f.options.reviewer.adapter.invoke = reviewAdapter(() => JSON.stringify({ schemaVersion: 1, verdict: 'accept', summary: 'Verified initial bytes', findings: [] }));
  const p = await prepareGraphVerification(f.options);
  const raw = await invokeReview(p.actions[0]!); pause = true;
  const pending = p.actions[0]!.persist(raw);
  raw.candidate.execution!.summary = 'replacement while awaiting'; release();
  const result = await pending; expect(result.result).toMatchObject({ verdict: 'accept' });
  const loaded = await loadGraphVerificationEvidence(f.options.root, result.evidenceRef, f.binding);
  expect(loaded.evidence.candidate?.execution?.summary).toContain('Verified initial bytes');
  let revoked = false; const g = await fixture();
  g.options.authorize = () => { if (revoked) throw new Error('live revocation'); };
  let revokeOnVerify = false; g.options.verifyReviewer = async () => { if (revokeOnVerify) revoked = true; };
  const q = await prepareGraphVerification(g.options); revokeOnVerify = true;
  await expect(q.actions[0]!.persist({ ...raw, candidate: { ...raw.candidate, workspace: q.reviewWorkspace } })).rejects.toThrow('live revocation');
}, 15000);

it.each([
  "printf malicious > file",
  "git update-index --assume-unchanged file; printf malicious > file",
  "chmod +x file",
  "chmod 600 file",
  "git update-index --assume-unchanged file",
  "printf staged > file; git add file; printf candidate > file",
  "git -c user.name=test -c user.email=test@invalid commit --allow-empty -qm malicious",
])('rejects actual successful command that mutates candidate: %s', async command => {
  const f = await fixture();
  f.options.acceptanceRegistry = [{ ref: 'acceptance', command, passExitCodes: [0], failExitCodes: [1] }];
  const b = await brokerFixture(f);
  expect(await b.invoke('tests')).toMatchObject({ outcome: { state: 'failed', error: { code: 'INTERNAL_ERROR', retryable: false } } });
  const row = f.db.prepare("SELECT json_extract(outcome_json, '$.evidenceRef') AS evidence_ref FROM graph_actions WHERE node_id = 'tests'").get() as { evidence_ref: string };
  const envelope = await loadGraphVerificationEvidence(f.options.root, row.evidence_ref, f.binding);
  expect(envelope).toHaveProperty('workspaceLeaseRef');
  expect(envelope).toHaveProperty('candidateIdentity.before');
  expect(envelope).toHaveProperty('candidateIdentity.after');
  expect(envelope.verificationFailure?.retrySafe).toBe(false);
}, 15000);
it('allocates distinct actual review sessions on explicit retry and persists prompt receipts', async () => {
  const f = await fixture(); const seen: AgentTask[] = [];
  f.options.reviewer.adapter.invoke = async function* (task) {
    seen.push(structuredClone(task));
    yield { event_id: 'done', run_id: task.run_id, session_id: task.session_id, seq: 1, created_at: Date.now() / 1000, terminal: true, type: 'done', payload: { status: 'completed', last_seq: 0, result_summary: 'malformed' } };
  };
  const b = await brokerFixture(f); await b.invoke('review');
  const first = f.db.prepare("SELECT effect_key FROM graph_actions WHERE node_id = 'review'").get() as { effect_key: string };
  await b.broker.retryAuthorized(b.connection, first.effect_key, () => {});
  expect(seen).toHaveLength(2);
  expect(seen[0]!.session_id).not.toBe(seen[1]!.session_id);
  for (const task of seen) {
    expect(task.session_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(task.context).toEqual({ repo_path: b.prepared.reviewWorkspace.workspace_path });
  }
  const rows = f.db.prepare("SELECT json_extract(outcome_json, '$.evidenceRef') AS evidence_ref FROM graph_actions WHERE node_id = 'review' ORDER BY logical_attempt").all() as { evidence_ref: string }[];
  for (const [i, row] of rows.entries()) {
    const envelope = await loadGraphVerificationEvidence(f.options.root, row.evidence_ref, f.binding);
    expect(envelope).toHaveProperty('reviewerInvocation', expect.objectContaining({ sessionId: seen[i]!.session_id, runId: seen[i]!.run_id, historyPassed: false, promptDigest: createHash('sha256').update(seen[i]!.prompt).digest('hex') }));
  }
}, 15000);
it('rejects oversized evidence before publishing any envelope', async () => {
  const f = await fixture(); const p = await prepareGraphVerification(f.options);
  await expect(p.actions[1]!.persist({ status: 'failed', stopped: true, command: { command: 'exit 1', exitCode: 1, stdout: '界'.repeat(24000), stderr: '', durationMs: 1, termination: { scope: 'posix_process_group', trigger: 'exit', leader_exit_code: 1, stop_confirmed: true, signals: [], evidence: 'stopped' } } })).rejects.toThrow(/bounded|size|64|limit/);
  expect(await readdir(join(f.options.root, 'evidence')).catch(() => [])).toEqual([]);
}, 15000);

it('requires an actual invocation receipt and strips supplied writer context on every invocation', async () => {
  const f = await fixture(); const seen: AgentTask[] = [];
  f.options.reviewer.adapter.invoke = async function* (task, signal) { seen.push(structuredClone(task)); yield* reviewAdapter(() => 'bad')(task, signal); };
  const p = await prepareGraphVerification(f.options); const action = p.actions[0]!;
  const raw = await invokeReview(action);
  expect(seen[0]!.context).toEqual({ repo_path: p.reviewWorkspace.workspace_path });
  await expect(action.persist({ ...raw, candidate: { ...raw.candidate, execution: { ...raw.candidate.execution!, run_id: 'never-invoked' } } })).rejects.toThrow(/invocation receipt/);
  await expect(action.persist(raw)).resolves.toHaveProperty('verificationFailure');
}, 15000);

it('validates all new receipts when loading digest-consistent evidence', async () => {
  const f = await fixture();
  f.options.reviewer.adapter.invoke = reviewAdapter(() => JSON.stringify({ schemaVersion: 1, verdict: 'accept', summary: 'Good', findings: [] }));
  const p = await prepareGraphVerification(f.options);
  const saved = await p.actions[0]!.persist(await invokeReview(p.actions[0]!));
  const envelope = await loadGraphVerificationEvidence(f.options.root, saved.evidenceRef, f.binding);
  const invalid = [
    { ...envelope, workspaceLeaseRef: undefined },
    { ...envelope, candidateIdentity: undefined },
    { ...envelope, candidateIdentity: { ...envelope.candidateIdentity, after: { ...envelope.candidateIdentity.before, trackedDigest: 'f'.repeat(64) } } },
    { ...envelope, reviewerInvocation: undefined },
    ...['sessionId', 'runId', 'taskId', 'adapterId', 'capabilityId', 'promptDigest', 'contextDigest', 'effectKey'].map(key => ({ ...envelope, reviewerInvocation: { ...envelope.reviewerInvocation, [key]: '' } })),
    { ...envelope, reviewerInvocation: { ...envelope.reviewerInvocation, historyPassed: true } },
  ];
  for (const value of invalid) {
    const bytes = JSON.stringify(value); const digest = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(f.options.root, 'evidence', `${digest}.json`), bytes);
    await expect(loadGraphVerificationEvidence(f.options.root, `graph-verification:${digest}`, f.binding)).rejects.toThrow();
  }
}, 15000);
it('allows untracked build outputs from successful actual acceptance execution', async () => {
  const f = await fixture();
  f.options.acceptanceRegistry = [{ ref: 'acceptance', command: 'mkdir build; printf built > build/output', passExitCodes: [0], failExitCodes: [1] }];
  const b = await brokerFixture(f);
  expect(await b.invoke('tests')).toMatchObject({ outcome: { state: 'confirmed', result: { passed: true } } });
  await expect(b.prepared.actions[1]!.verifyWorkspace!()).resolves.toBeUndefined();
}, 15000);
it('confirms ordinary failing tests with escape-heavy and multibyte captured output', async () => {
  const f = await fixture(); const command = `node -e 'process.stdout.write("\\x1b".repeat(16000)); process.stderr.write("界".repeat(16000)); process.exitCode=1'`;
  f.options.acceptanceRegistry = [{ ref: 'acceptance', command, passExitCodes: [0], failExitCodes: [1] }];
  const host = await brokerFixture(f); const response = await host.invoke('tests');
  expect(response).toMatchObject({ outcome: { state: 'confirmed', result: { passed: false } } });
  if (response.kind !== 'worker_action_response' || response.outcome.state !== 'confirmed' || response.outcome.result.kind !== 'tests') throw Error('missing settled tests');
  const envelope = await loadGraphVerificationEvidence(f.options.root, response.outcome.result.evidenceRefs[0]!, f.binding, { effect: response.effect, effectKey: computeGraphEffectKey(response.effect) });
  expect(envelope.outputCaptures?.map(c => c.field)).toEqual(['command.stdout', 'command.stderr']);
  expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThan(65536);
  expect(envelope.evidence.command?.termination).toMatchObject({ trigger: 'exit', stop_confirmed: true, leader_exit_code: 1 });
}, 15000);
it('settles an oversized structured review as a bounded contract failure instead of unknown', async () => {
  const f = await fixture();
  f.options.reviewer.adapter.invoke = async function* (task) { yield { event_id: 'done', run_id: task.run_id, session_id: task.session_id, seq: 1,
    created_at: 0, terminal: true, type: 'done', payload: { status: 'completed', last_seq: 0,
      result_summary: JSON.stringify({ schemaVersion: 1, verdict: 'accept', summary: '界'.repeat(8000), findings: [] }) } }; };
  const host = await brokerFixture(f);
  expect(await host.invoke('review')).toMatchObject({ outcome: { state: 'failed', error: { code: 'OUTPUT_CONTRACT_INVALID', retryable: true } } });
}, 15000);

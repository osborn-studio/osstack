import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { HostProcessStore, SAME_CHILD_RESUMABLE, AttentionStore, ContainedMissionStore, RevisionChainStore, openDb, createScratchDirSync } from '@osstack/core';
import { runHardenedGit } from '@osstack/agents';
import { describe, expect, it, vi } from 'vitest';
import { H, T0, changesRequested, dispatched, setup } from './contained-mission-revision.testkit.js';
import { oid } from './contained-mission-bridge-shadow.testkit.js';
import { assertRevisionPublishable, createRevisionPublicationPort, compareRevisionRange, confirmRevisionPublication, publishRevision, publishRevisionCheck, readRevisionPr, reconcileReceipt, recoverRevision, createRevisionReceiptRecovery, refuseRevisionPublication, REVISION_SAME_CHILD_RESUMABLE, type RevisionPublicationDeps, type RevisionRefusalCode } from './contained-mission-revision-publication.js';
import { createRevisionCheckRetryScheduler } from './contained-mission-revision-check-retry.js';
import { parseContainedMissionSpec } from './contained-mission-runner.js';
import { ContainedMissionHost } from './contained-mission-host.js';
import { HostProcessKit } from './contained-mission-host-process.js';
import type { ContainedMissionHostPorts } from './contained-mission-ports.js';
import { createReceiptReadAdapters } from './contained-mission-bridge-receipt-adapter.js';

const old = '1'.repeat(40);
const next = '2'.repeat(40);
const chainsCheckPending = (deps: RevisionPublicationDeps, chainId: string) => deps.chains.intents(chainId).some(i => i.kind === 'check' && i.state === 'pending');
const restartedRow = (db: ReturnType<typeof openDb>, intentId: string) => db.prepare('SELECT * FROM engineering_host_processes WHERE intent_id=?').get(intentId);

it('reads a PR by number and a bounded compare range through read-only GitHub calls', async () => {
  const pr = await readRevisionPr('o/r', 7, async (query, variables) => {
    expect(query).toContain('pullRequest(number: $number)');
    expect(variables).toEqual({ owner: 'o', name: 'r', number: 7 });
    return { data: { repository: { pullRequest: { state: 'OPEN', headRepository: { nameWithOwner: 'o/r' }, headRefName: 'topic', headRefOid: old,
      baseRefName: 'main', baseRefOid: 'a'.repeat(40), url: 'https://example.invalid/pull/7' } } } };
  });
  expect(pr).toMatchObject({ state: 'OPEN', headRefOid: old, repository: 'o/r' });
  expect(await compareRevisionRange('o/r', old, next, async args => {
    expect(args[0]).toBe('api');
    expect(args[1]).toContain(`compare/${old}...${next}`);
    return { stdout: JSON.stringify({ total_commits: 1, commits: [{ sha: next }] }), stderr: '', exitCode: 0 };
  })).toEqual([next]);
});

async function fixture(options: { oldHead?: string; newHead?: string; intent?: boolean; expiresIn?: number; rounds?: 1 | 2; journalStopped?: boolean } = {}) {
  const previousHead = options.oldHead ?? old; const candidateHead = options.newHead ?? next;
  const f = setup({ head: previousHead, ...(options.expiresIn ? { expiresIn: options.expiresIn } : {}), ...(options.rounds ? { rounds: options.rounds } : {}) });
  const out = await dispatched(f);
  const id = out.child_mission_id;
  const missions = f.rig.missions;
  let m = missions.get(id);
  const step = (to: Parameters<typeof missions.transition>[1]['to'], extra: Record<string, unknown> = {}) => {
    m = missions.transition(id, { if_revision: m.revision, to, event: { kind: `to_${to}`, payload: {} }, ...extra }, ++f.clock.now);
  };
  step('workspace_ready');
  step('executing', { expected_head: previousHead });
  m = missions.recordStopEvidence(id, m.revision, { stop_proof: 'test' }, ++f.clock.now);
  step('candidate_ready', { candidate: { head: candidateHead, tree: '3'.repeat(40), diff_digest: '4'.repeat(64) } });
  step('verifying');
  m = missions.recordStopEvidence(id, m.revision, { stop_proof: 'test' }, ++f.clock.now);
  missions.record(id, 'verify_receipt', { candidate: candidateHead, exit_code: 0, evidence: 'verified', cancelled: false }, ++f.clock.now);
  missions.record(id, 'candidate_committed', { head_commit: candidateHead, tier: 'T0', chain_tier: 'T0' }, ++f.clock.now);
  step('verified'); step('revalidating'); step('delivering');
  const chain = f.rig.chains.get(f.chain.chain_id);
  if (options.intent === false) return { f, id, mission: m, chain, journal: new HostProcessStore(f.rig.attention, f.rig.owner, { clock: () => ++f.clock.now }) };
  const intent = f.rig.chains.recordIntent(chain.chain_id, chain.revision, { kind: 'push', branch: chain.branch,
    expected_old_head: previousHead, new_head: candidateHead, expected_base_sha: chain.published_base, child_mission_id: id }, ++f.clock.now).intent;
  f.rig.chains.appendEvent(chain.chain_id, 'push_range', { intent_id: intent.intent_id, commits: [candidateHead] }, ++f.clock.now);
  const journal = new HostProcessStore(f.rig.attention, f.rig.owner, { clock: () => ++f.clock.now });
  const opId = 'hp_publishrevision';
  journal.launching({ op_id: opId, mission_id: id, kind: 'git_push', remote_target: 'o/r#refs/heads/topic', local_target: '/tmp/repo#refs/heads/topic',
    intent_id: intent.intent_id, argv_digest: '5'.repeat(64), boot_id: 'test', marker: { path: '/tmp/marker', dev: '1', ino: '1' } });
  journal.registered(opId, { pid: 12345, pgid: 12345, leader_start: 'test' });
  journal.release(opId, () => {});
  if (options.journalStopped !== false) journal.stopped(opId, { proof: 'group_empty+marker_unheld', detail: {}, exit_code: 0 });
  const deps: RevisionPublicationDeps = {
    chains: f.rig.chains, missions, host: { recordForIntent: intentId => intentId === intent.intent_id ? journal.get(opId) : undefined },
    runner: { gated: true, run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) }, now: () => ++f.clock.now,
    readPr: async () => ({ state: 'OPEN', repository: 'o/r', headRefName: 'topic', headRefOid: candidateHead, baseRefName: 'main', baseRefOid: 'a'.repeat(40), url: 'https://example.invalid/pull/7' }),
    localGit: async () => ({ stdout: '', exitCode: 0 }), remoteHead: async () => candidateHead, compare: async () => [candidateHead], preflight: async () => {}, checkEnabled: true,
    cancelChild: async () => {},
  };
  const input = { chain_id: chain.chain_id, intent_id: intent.intent_id, child_mission_id: id, permit_revision: m.revision,
    evidence: { evidence_digest: '6'.repeat(64), head: candidateHead, repository: 'o/r' }, pr: { number: 7, url: 'https://example.invalid/pull/7', reused: true as const }, range_sha256: '7'.repeat(64) };
  return { f, deps, input, id, intent, journal };
}
async function fullFixture(options: { rounds?: 1 | 2; oldHead?: string; newHead?: string; journalStopped?: boolean } = {}) {
  const result = await fixture(options);
  if (!result.deps || !result.input || !result.intent) throw Error('fixture_incomplete');
  return { ...result, deps: result.deps, input: result.input, intent: result.intent };
}

it.each(['matching', 'missing', 'error'] as const)('ignores a stale explicit receipt reconciliation after concurrent confirmation: %s', async result => {
  const f = await fullFixture();
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  let release!: (head: string | null) => void; let fail!: (error: Error) => void;
  const remote = new Promise<string | null>((resolve, reject) => { release = resolve; fail = reject; });
  const slow = reconcileReceipt({ ...f.deps, remoteHead: async () => { enter(); return remote; } },
    f.intent.intent_id, 'route_changed', { cwd: '/tmp/repo', remote: 'origin' });
  const noFailure = expect(slow).resolves.toBeUndefined();
  await entered;
  await createRevisionReceiptRecovery(f.deps).recoverPendingReceipts();
  const before = f.deps.chains.db.serialize();
  if (result === 'error') fail(Error('late_network_error')); else release(result === 'matching' ? next : null);
  await noFailure;
  expect(f.deps.chains.db.serialize()).toEqual(before);
  expect(f.deps.chains.getIntent(f.intent.intent_id).state).toBe('confirmed');
  expect(f.deps.chains.get(f.intent.chain_id).state).toBe('awaiting_review');
  expect(f.deps.missions.get(f.id).state).toBe('pr_opened');
});

it('ignores a stale publication refusal after the receipt and child are confirmed', async () => {
  const f = await fullFixture();
  confirmRevisionPublication(f.deps, f.input);
  const before = f.deps.chains.db.serialize();
  refuseRevisionPublication(f.deps, f.intent.chain_id, f.id, f.intent.intent_id, 'push_rejected');
  expect(f.deps.chains.db.serialize()).toEqual(before);
});

it.each(['matching', 'missing', 'error'] as const)('ignores a stale manual uncertain receipt result after concurrent settlement: %s', async result => {
  const f = await fullFixture();
  f.deps.chains.settleIntent(f.intent.intent_id, 'uncertain', f.deps.now());
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  let release!: (head: string | null) => void; let fail!: (error: Error) => void;
  const remote = new Promise<string | null>((resolve, reject) => { release = resolve; fail = reject; });
  const slow = createRevisionReceiptRecovery({ ...f.deps, remoteHead: async () => { enter(); return remote; } }).reconcileUncertain({ chain_id: f.intent.chain_id });
  const noFailure = expect(slow).resolves.toEqual({ settled: false });
  await entered;
  expect(await createRevisionReceiptRecovery(f.deps).reconcileUncertain({ chain_id: f.intent.chain_id })).toEqual({ settled: true });
  const before = f.deps.chains.db.serialize();
  if (result === 'error') fail(Error('late_network_error')); else release(result === 'matching' ? next : null);
  await noFailure;
  expect(f.deps.chains.db.serialize()).toEqual(before);
});

it('recovers a published range when a later remote descendant is absent from the local object database', async () => {
  const root = createScratchDirSync('tests', 'receipt-missing-descendant');
  const source = join(root, 'source'); const local = join(root, 'local');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    execFileSync('git', ['init', '-q', '-b', 'topic', source]);
    git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.invalid');
    git(source, 'commit', '-q', '--allow-empty', '-m', 'base'); const base = git(source, 'rev-parse', 'HEAD');
    git(source, 'commit', '-q', '--allow-empty', '-m', 'revision'); const head = git(source, 'rev-parse', 'HEAD');
    execFileSync('git', ['clone', '-q', '--no-local', source, local]);
    git(source, 'commit', '-q', '--allow-empty', '-m', 'external descendant'); const remote = git(source, 'rev-parse', 'HEAD');
    expect(spawnSync('git', ['cat-file', '-e', remote], { cwd: local }).status).not.toBe(0);
    const f = await fullFixture({ oldHead: base, newHead: head });
    f.deps.remoteHead = async () => remote;
    f.deps.localGit = async (_cwd, args) => {
      const result = await runHardenedGit(args, { cwd: local, okExitCodes: [0, 1] });
      return { stdout: result.stdout.toString('utf8'), exitCode: result.exitCode };
    };
    f.deps.compare = async (_repository, oldHead, newHead) => git(source, 'rev-list', '--reverse', `${oldHead}..${newHead}`).split('\n');
    const read = await createReceiptReadAdapters({ signal: new AbortController().signal, exec: async args => {
      expect(args).toEqual(['api', `repos/o/r/compare/${head}...${remote}?per_page=1`]);
      return { exitCode: 0, stderr: '', stdout: JSON.stringify({ status: 'ahead', merge_base_commit: { sha: git(source, 'merge-base', head, remote) } }) };
    } });
    f.deps.remoteIsDescendant = read.remoteIsDescendant!;
    await reconcileReceipt(f.deps, f.intent.intent_id, 'route_changed', { cwd: local, remote: 'origin' });
    expect(f.deps.chains.getIntent(f.intent.intent_id).state).toBe('confirmed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('startup receipt recovery is bounded and stops before writes on transient reads', async () => {
  const { deps, intent } = await fullFixture();
  const recover = createRevisionReceiptRecovery(deps);
  deps.remoteHead = async () => { throw Error('503'); };
  await expect(recover.recoverPendingReceipts({ limit: 1 })).rejects.toThrow('RECEIPT_READ_RETRYABLE');
  expect(deps.chains.getIntent(intent.intent_id).state).toBe('pending');
  await expect(recover.recoverPendingReceipts({ limit: 101 })).rejects.toThrow('invalid_limit');
});
it('startup recovery confirms stopped pending receipts without a second push', async () => {
  const { deps, intent, id } = await fullFixture();
  expect(await createRevisionReceiptRecovery(deps).recoverPendingReceipts({ limit: 1 })).toMatchObject({ visited: 1 });
  expect(deps.chains.getIntent(intent.intent_id).state).toBe('confirmed');
  expect(deps.missions.get(id).state).toBe('pr_opened');
  expect(await createRevisionReceiptRecovery(deps).recoverPendingReceipts()).toMatchObject({ visited: 0, complete: true });
});

it.each(['closed', 'stopped', 'stop_unknown'] as const)('startup recovery preserves the %s human route while confirming the receipt', async route => {
  const { deps, id, intent } = await fullFixture();
  const chain = deps.chains.get(intent.chain_id);
  if (route === 'closed') deps.chains.closeLive(chain.chain_id, chain.revision, 'pr_closed', deps.now());
  if (route === 'stopped') deps.chains.stopLive(chain.chain_id, chain.revision, 'child_halted', deps.now());
  if (route === 'stop_unknown') {
    const child = deps.missions.get(id);
    deps.missions.transition(id, { if_revision: child.revision, to: 'stop_unknown', event: { kind: 'halted', payload: { reason: 'host_process_unproven', route: 'delivering' } } }, deps.now());
  }
  await createRevisionReceiptRecovery(deps).recoverPendingReceipts();
  expect(deps.chains.getIntent(intent.intent_id).state).toBe('confirmed');
  expect(deps.chains.get(intent.chain_id).state).toBe(route === 'closed' ? 'closed' : 'awaiting_decision');
  expect(deps.missions.get(id).state).toBe(route === 'stop_unknown' ? 'stop_unknown' : 'awaiting_decision');
});
it('startup recovery excludes uncertain receipts; explicit reconcile records facts and preserves the stop', async () => {
  const { deps, intent } = await fullFixture();
  deps.chains.settleIntent(intent.intent_id, 'uncertain', deps.now());
  const read = vi.spyOn(deps, 'remoteHead');
  const recovery = createRevisionReceiptRecovery(deps);
  expect(await recovery.recoverPendingReceipts()).toEqual({ visited: 0, complete: true });
  expect(read).not.toHaveBeenCalled();
  expect(await recovery.reconcileUncertain({ chain_id: intent.chain_id })).toEqual({ settled: true });
  expect(deps.chains.getIntent(intent.intent_id).state).toBe('confirmed');
  expect(deps.chains.get(intent.chain_id).state).toBe('awaiting_decision');
});
it('startup recovery aborts between readback and commit without changing a receipt', async () => {
  const { deps, intent } = await fullFixture();
  const controller = new AbortController();
  const readPr = deps.readPr;
  deps.readPr = async (...args) => { const result = await readPr(...args); controller.abort(Error('recovery_stopped')); return result; };
  await expect(createRevisionReceiptRecovery(deps).recoverPendingReceipts({ signal: controller.signal })).rejects.toThrow('recovery_stopped');
  expect(deps.chains.getIntent(intent.intent_id).state).toBe('pending');
});
it('startup recovery propagates owner loss before commit with no partial ledger write', async () => {
  const { deps, intent } = await fullFixture();
  const before = deps.missions.events(intent.child_mission_id!, 0, 500).length;
  const readPr = deps.readPr;
  deps.readPr = async (...args) => { const result = await readPr(...args); vi.spyOn(deps.chains.attention, 'assertOwner').mockImplementation(() => { throw Error('stale_owner'); }); return result; };
  try { await expect(createRevisionReceiptRecovery(deps).recoverPendingReceipts()).rejects.toThrow('stale_owner'); }
  finally { vi.restoreAllMocks(); }
  expect(deps.chains.getIntent(intent.intent_id).state).toBe('pending');
  expect(deps.missions.events(intent.child_mission_id!, 0, 500)).toHaveLength(before);
});

describe('revision receipt step 0', () => {
  const recoveryInput = (deps: RevisionPublicationDeps, childId: string) => {
    const mission = deps.missions.get(childId);
    return { mission, spec: parseContainedMissionSpec(mission.spec_json), permit: { mission_id: childId, revision: mission.revision,
      head: mission.candidate_head!, tree: mission.candidate_tree!, spec_digest: mission.spec_digest },
    beforeRemoteMutation: () => { throw Error('unexpected_push'); }, signal: new AbortController().signal };
  };
  it('recovers a stopped push whose head is reachable below an outsider commit', async () => {
    const { deps, id, intent } = await fullFixture();
    const outsider = '9'.repeat(40);
    deps.remoteHead = async () => outsider;
    deps.compare = async (_repo, _old, head) => head === outsider ? [next, outsider] : [next];
    deps.readPr = async () => ({ state: 'OPEN', repository: 'o/r', headRefName: 'topic', headRefOid: outsider,
      baseRefName: 'main', baseRefOid: 'a'.repeat(40), url: 'https://example.invalid/pull/7' });
    const result = await recoverRevision(deps, recoveryInput(deps, id));
    expect(result).toMatchObject({ intent_id: intent.intent_id, pushed_commit: next, push_range: [next] });
    expect(deps.chains.getIntent(intent.intent_id).state).toBe('pending');
  });
  it.each(['remoteHead', 'compare', 'readPr'] as const)('retries a transient %s failure without ledger writes or an attempt', async failedRead => {
    const { deps, id, intent } = await fullFixture();
    if (failedRead === 'remoteHead') deps.remoteHead = async () => { throw Error('offline'); };
    if (failedRead === 'compare') deps.compare = async () => { throw Error('HTTP 503'); };
    if (failedRead === 'readPr') deps.readPr = async () => { throw Error('timeout'); };
    const before = deps.missions.events(id, 0, 500).length;
    await expect(recoverRevision(deps, recoveryInput(deps, id))).rejects.toThrow('RECEIPT_READ_RETRYABLE');
    expect(deps.chains.getIntent(intent.intent_id).state).toBe('pending');
    expect(deps.chains.get(intent.chain_id).state).toBe('publishing');
    expect(deps.missions.get(id).state).toBe('delivering');
    expect(deps.missions.events(id, 0, 500)).toHaveLength(before);
  });
  it('halts a delivering child when its intent is already uncertain', async () => {
    const { deps, id, intent } = await fullFixture();
    deps.chains.settleIntent(intent.intent_id, 'uncertain', deps.now(), 'readback_mismatch');
    expect(await recoverRevision(deps, recoveryInput(deps, id))).toBe('blocked');
    expect(deps.missions.get(id).state).toBe('awaiting_decision');
    const halt = deps.missions.events(id, 0, 500).filter(e => e.kind === 'halted').at(-1)!;
    expect(JSON.parse(halt.payload_json).reason).toBe('publication_failed:intent_uncertain');
  });
  it('finds a landed receipt after more than 500 chain events and reconciles it', async () => {
    const { deps, id, input } = await fullFixture();
    for (let n = 0; n < 501; n++) deps.chains.appendEvent(input.chain_id, 'test_history', { n }, deps.now());
    const recovered = await recoverRevision(deps, recoveryInput(deps, id));
    expect(recovered).toMatchObject({ intent_id: input.intent_id, push_range: [next] });
    await reconcileReceipt(deps, input.intent_id, 'route_changed', { cwd: '/tmp/repo', remote: 'origin' });
    expect(deps.chains.getIntent(input.intent_id).state).toBe('confirmed');
    expect(deps.chains.get(input.chain_id).published_head).toBe(next);
  });
  it('blocks a released push without stop proof and leaves its intent pending', async () => {
    const { deps, id, input } = await fullFixture({ journalStopped: false });
    expect(await recoverRevision(deps, recoveryInput(deps, id))).toBe('blocked');
    expect(deps.chains.getIntent(input.intent_id).state).toBe('pending');
    expect(deps.chains.get(input.chain_id)).toMatchObject({ state: 'awaiting_decision', stop_reason: 'intent_uncertain' });
    expect(deps.missions.get(id)).toMatchObject({ state: 'stop_unknown', stop_obligation: 1 });
  });
  it('settles an intent with no released journal row as never_released', async () => {
    const { deps, id, intent } = await fullFixture();
    deps.host = { recordForIntent: () => undefined };
    expect(await recoverRevision(deps, recoveryInput(deps, id))).toBe('blocked');
    expect(deps.chains.getIntent(intent.intent_id)).toMatchObject({ state: 'failed', detail: 'never_released' });
    expect(deps.missions.get(id).state).toBe('awaiting_decision');
  });
  it('keeps a stopped released push uncertain when the remote is still at the old head', async () => {
    const { deps, id, intent } = await fullFixture();
    deps.remoteHead = async () => old;
    deps.compare = async (_repo, _old, head) => head === old ? [] : [next];
    expect(await recoverRevision(deps, recoveryInput(deps, id))).toBe('blocked');
    expect(deps.chains.getIntent(intent.intent_id).state).toBe('uncertain');
  });
  it('requires remote proof before a route-changed receipt can be confirmed', async () => {
    const { deps, input } = await fullFixture();
    deps.remoteHead = async () => { throw Error('offline'); };
    await expect(reconcileReceipt(deps, input.intent_id, 'route_changed', { cwd: '/tmp/repo', remote: 'origin' })).rejects.toThrow('offline');
    expect(deps.chains.getIntent(input.intent_id).state).toBe('pending');
  });
  it('routes an already confirmed receipt to landed confirmation without a new push', async () => {
    const { deps, input, id } = await fullFixture();
    const chain = deps.chains.get(input.chain_id);
    deps.chains.stopLive(chain.chain_id, chain.revision, 'intent_uncertain', T0 + H);
    await reconcileReceipt(deps, input.intent_id, 'route_changed', { cwd: '/tmp/repo', remote: 'origin' });
    expect(deps.chains.get(input.chain_id)).toMatchObject({ state: 'awaiting_decision', published_head: next });
    let child = deps.missions.get(id);
    child = deps.missions.transition(id, { if_revision: child.revision, to: 'revalidating', event: { kind: 'decision_approve_publication', payload: {} } }, T0 + H + 2);
    child = deps.missions.transition(id, { if_revision: child.revision, to: 'delivering', event: { kind: 'revalidated', payload: {} } }, T0 + H + 3);
    const recovered = await recoverRevision(deps, recoveryInput(deps, id));
    expect(recovered).toMatchObject({ landed: true, intent_id: input.intent_id });
    if (typeof recovered === 'string') throw Error('recovery_blocked');
    expect(confirmRevisionPublication(deps, { ...input, permit_revision: child.revision, variant: 'landed' }).state).toBe('pr_opened');
    expect(deps.chains.get(input.chain_id).state).toBe('awaiting_review');
    expect(deps.chains.intents(input.chain_id).filter(i => i.kind === 'push')).toHaveLength(1);
  });
  it('stops a confirmed child when fresh remote proof contradicts the landed receipt', async () => {
    const { deps, input, id } = await fullFixture();
    const chain = deps.chains.get(input.chain_id);
    deps.chains.stopLive(chain.chain_id, chain.revision, 'intent_uncertain', T0 + H);
    deps.chains.settleIntent(input.intent_id, 'confirmed', T0 + H + 1);
    deps.remoteHead = async () => old;
    deps.localGit = async () => ({ stdout: '', exitCode: 1 });
    expect(await recoverRevision(deps, recoveryInput(deps, id))).toBe('blocked');
    expect(deps.chains.getIntent(input.intent_id).state).toBe('confirmed');
    expect(deps.chains.get(input.chain_id)).toMatchObject({ state: 'awaiting_decision', stop_reason: 'intent_uncertain' });
    expect(deps.missions.get(id).state).toBe('awaiting_decision');
  });
  it('requires ancestry even if compare reports the journaled prefix', async () => {
    const { deps, id, input } = await fullFixture();
    deps.remoteHead = async () => '9'.repeat(40);
    deps.compare = async (_repository, _old, head) => head === next ? [next] : [next, '9'.repeat(40)];
    deps.localGit = async () => ({ stdout: '', exitCode: 1 });
    expect(await recoverRevision(deps, recoveryInput(deps, id))).toBe('blocked');
    expect(deps.chains.getIntent(input.intent_id).state).toBe('uncertain');
  });
});

it('uses the core same-child resumable reasons in CLI publication policy', () => {
  expect(REVISION_SAME_CHILD_RESUMABLE).toBe(SAME_CHILD_RESUMABLE);
  expect(REVISION_SAME_CHILD_RESUMABLE.has('publish_refused:never_released')).toBe(true);
});

async function publishFixture(runPush?: (intentId: string, journal: HostProcessStore, fence: () => void) => Promise<{ stdout: string; stderr: string; exitCode: number; opId?: string }>,
  options: { localGit?: RevisionPublicationDeps['localGit']; readPr?: RevisionPublicationDeps['readPr']; expiresIn?: number } = {}) {
  const base = await fixture({ intent: false, ...(options.expiresIn ? { expiresIn: options.expiresIn } : {}) });
  const { f, id, mission, chain, journal } = base;
  if (!mission || !chain || !journal) throw Error('fixture_incomplete');
  const pr = { state: 'OPEN' as const, repository: 'o/r', headRefName: 'topic', headRefOid: old, baseRefName: 'main', baseRefOid: 'a'.repeat(40), url: 'https://example.invalid/pull/7' };
  const deps: RevisionPublicationDeps = {
    chains: f.rig.chains, missions: f.rig.missions, now: () => ++f.clock.now,
    host: { recordForIntent: intentId => f.rig.db.prepare('SELECT * FROM engineering_host_processes WHERE intent_id=?').get(intentId) as ReturnType<typeof journal.get> | undefined },
    runner: { gated: true, run: async (_command, args, options) => {
      if (args.includes('get-url')) return { stdout: 'https://github.com/o/r.git\n', stderr: '', exitCode: 0 };
      if (!args.includes('push') || !options.intentId || !options.gate || !runPush) throw Error('unexpected_push');
      return runPush(options.intentId, journal, options.gate.fence);
    } },
    readPr: options.readPr ?? (async () => pr), localGit: options.localGit ?? (async (_cwd, args) => ({ stdout: args[0] === 'rev-list' ? next : '', exitCode: 0 })),
    remoteHead: async () => old, compare: async () => [next], preflight: async () => {}, checkEnabled: true, cancelChild: async () => {},
    fenceAuthority: () => ({ access: f.deps.access, keys: f.deps.keys(), now: f.clock.now, enabled: f.flags.enabled }),
  };
  const spec = f.childSpec(id);
  const permit = { mission_id: id, revision: mission.revision, head: next, tree: '3'.repeat(40), spec_digest: mission.spec_digest };
  const call = () => publishRevision(deps, { mission, spec, permit, beforeRemoteMutation: () => {}, signal: new AbortController().signal });
  return { f, id, chain, journal, deps, spec, call };
}

function releasePush(journal: HostProcessStore, intentId: string, missionId: string, fence: () => void, stopped: boolean): string {
  const opId = `hp_${Math.random().toString(36).slice(2)}`;
  journal.launching({ op_id: opId, mission_id: missionId, kind: 'git_push', remote_target: 'o/r#refs/heads/topic', local_target: '/tmp/repo#refs/heads/topic',
    intent_id: intentId, argv_digest: '8'.repeat(64), boot_id: 'test', marker: { path: '/tmp/marker', dev: '1', ino: '1' } });
  journal.registered(opId, { pid: 12345, pgid: 12345, leader_start: 'test' });
  journal.release(opId, fence);
  if (stopped) journal.stopped(opId, { proof: 'group_empty+marker_unheld', detail: {}, exit_code: 0 });
  return opId;
}

it.each([
  ['bridge_live_disabled', (f: Awaited<ReturnType<typeof publishFixture>>) => { f.f.flags.enabled = false; }],
  ['grant_expired', (f: Awaited<ReturnType<typeof publishFixture>>) => { f.f.clock.now = T0 + 24 * H; }],
  ['grant_invalid', (f: Awaited<ReturnType<typeof publishFixture>>) => { f.f.flags.access = false; }],
  ['budget_exhausted', (f: Awaited<ReturnType<typeof publishFixture>>) => { f.f.clock.now = T0 + 48 * H; }],
] as const)('release fence refuses %s after intent and before git', async (expected, mutate) => {
  let fixture!: Awaited<ReturnType<typeof publishFixture>>;
  let gitRan = false;
  fixture = await publishFixture(async (intentId, journal, fence) => {
    const opId = 'hp_releasefence';
    journal.launching({ op_id: opId, mission_id: fixture.id, kind: 'git_push', remote_target: 'o/r#refs/heads/topic', local_target: '/tmp/repo#refs/heads/topic',
      intent_id: intentId, argv_digest: '8'.repeat(64), boot_id: 'test', marker: { path: '/tmp/marker', dev: '1', ino: '1' } });
    journal.registered(opId, { pid: 12345, pgid: 12345, leader_start: 'test' });
    mutate(fixture);
    try { journal.release(opId, fence); gitRan = true; }
    catch (error) { journal.stopped(opId, { proof: 'never_released', detail: {} }); throw error; }
    return { stdout: '', stderr: '', exitCode: 0, opId };
  }, expected === 'budget_exhausted' ? { expiresIn: 72 * H } : {});
  await expect(fixture.call()).rejects.toThrow(`CONTAINED_REVISION_REFUSED:${expected}`);
  expect(gitRan).toBe(false);
  const intent = fixture.deps.chains.intents(fixture.chain.chain_id).at(-1)!;
  expect(intent).toMatchObject({ state: 'failed', detail: expected });
  expect(fixture.deps.host.recordForIntent(intent.intent_id)).toMatchObject({ state: 'stopped', released_at: null });
  expect(fixture.deps.chains.get(fixture.chain.chain_id).stop_reason).toBe(expected === 'bridge_live_disabled' ? 'publish_refused:bridge_live_disabled' : expected);
  expect(fixture.deps.missions.events(fixture.id, 0, 500).filter(e => e.kind === 'halted').at(-1)?.payload_json).toContain(`publication_failed:${expected}`);
});

it('the release fence refuses a missing authority even when the caller callback is empty', async () => {
  const f = await publishFixture();
  const intent = f.deps.chains.recordIntent(f.chain.chain_id, f.chain.revision, { kind: 'push', branch: f.chain.branch,
    expected_old_head: old, new_head: next, expected_base_sha: f.chain.published_base, child_mission_id: f.id }, ++f.f.clock.now).intent;
  delete f.deps.fenceAuthority;
  expect(() => assertRevisionPublishable(f.deps, { mission: f.deps.missions.get(f.id), spec: f.spec,
    permit: { mission_id: f.id, revision: f.deps.missions.get(f.id).revision, head: next, tree: '3'.repeat(40), spec_digest: f.deps.missions.get(f.id).spec_digest },
    beforeRemoteMutation: () => {}, signal: new AbortController().signal }, intent.intent_id)).toThrow('CONTAINED_REVISION_FENCE:bridge_live_disabled');
});

it('leaves a pending intent for recovery when W13 loses the owner before release', async () => {
  let fixture!: Awaited<ReturnType<typeof publishFixture>>;
  let gitRan = false;
  fixture = await publishFixture(async (intentId, journal, fence) => {
    const opId = 'hp_ownerchange';
    journal.launching({ op_id: opId, mission_id: fixture.id, kind: 'git_push', remote_target: 'o/r#refs/heads/topic', local_target: '/tmp/repo#refs/heads/topic',
      intent_id: intentId, argv_digest: '8'.repeat(64), boot_id: 'test', marker: { path: '/tmp/marker', dev: '1', ino: '1' } });
    journal.registered(opId, { pid: 12345, pgid: 12345, leader_start: 'test' });
    vi.spyOn(fixture.deps.chains.attention, 'assertOwner').mockImplementationOnce(() => { throw Error('stale_owner'); });
    try { journal.release(opId, fence); gitRan = true; }
    catch (error) { journal.stopped(opId, { proof: 'never_released', detail: {} }); throw error; }
    return { stdout: '', stderr: '', exitCode: 0, opId };
  });
  await expect(fixture.call()).rejects.toThrow('stale_owner');
  expect(gitRan).toBe(false);
  const intent = fixture.deps.chains.intents(fixture.chain.chain_id).at(-1)!;
  expect(intent.state).toBe('pending');
  expect(fixture.deps.chains.get(fixture.chain.chain_id).state).toBe('publishing');
  vi.restoreAllMocks();
});

it.each(['exhausted', 'HTTP 503', 'HTTP 429'] as const)('keeps %s readback uncertain after one stopped push', async failure => {
  let f!: Awaited<ReturnType<typeof publishFixture>>;
  let pushes = 0;
  f = await publishFixture(async (intentId, journal, fence) => {
    const opId = releasePush(journal, intentId, f.id, fence, true);
    pushes++;
    return { stdout: '', stderr: '', exitCode: 0, opId };
  });
  const initialRead = f.deps.readPr;
  let reads = 0;
  f.deps.readPr = async (...args) => {
    reads++;
    if (pushes && failure !== 'exhausted') throw Error(failure);
    // A lagging read keeps returning the old head through every bounded retry.
    return initialRead(...args);
  };
  f.deps.remoteHead = async () => pushes ? next : old;
  const sleep = vi.fn(async () => {}); f.deps.sleep = sleep;
  await expect(f.call()).rejects.toThrow('CONTAINED_REVISION_READBACK_MISMATCH');
  expect(pushes).toBe(1);
  expect(reads).toBe(failure === 'exhausted' ? 6 : 2);
  expect(sleep).toHaveBeenCalledTimes(failure === 'exhausted' ? 4 : 0);
  expect(f.deps.chains.intents(f.chain.chain_id).filter(i => i.kind === 'push')).toMatchObject([{ state: 'uncertain' }]);
  expect(f.deps.chains.get(f.chain.chain_id)).toMatchObject({ state: 'awaiting_decision', stop_reason: 'intent_uncertain' });
});

it('a second daemon owner claim fences an in-flight publisher before remote release', async () => {
  let f!: Awaited<ReturnType<typeof publishFixture>>;
  let second: ReturnType<typeof openDb> | undefined;
  let gitRan = false;
  f = await publishFixture(async (intentId, journal, fence) => {
    const opId = 'hp_twoowners';
    journal.launching({ op_id: opId, mission_id: f.id, kind: 'git_push', remote_target: 'o/r#refs/heads/topic', local_target: '/tmp/repo#refs/heads/topic',
      intent_id: intentId, argv_digest: '8'.repeat(64), boot_id: 'test', marker: { path: '/tmp/marker', dev: '1', ino: '1' } });
    journal.registered(opId, { pid: 12345, pgid: 12345, leader_start: 'test' });
    // Separate SQLite connection and real epoch replacement, rather than a mocked fence failure.
    second = openDb({ path: f.f.rig.path });
    const attention = new AttentionStore(second, f.f.rig.path);
    attention.claimOwner('second-daemon');
    journal.release(opId, fence);
    gitRan = true;
    return { stdout: '', stderr: '', exitCode: 0, opId };
  });
  try {
    await expect(f.call()).rejects.toThrow(/owner/i);
    expect(gitRan).toBe(false);
    expect(f.deps.chains.intents(f.chain.chain_id).filter(i => i.kind === 'push')).toMatchObject([{ state: 'pending' }]);
    expect(f.deps.chains.get(f.chain.chain_id).state).toBe('publishing');
    expect(second!.prepare("SELECT state,released_at FROM engineering_host_processes WHERE op_id='hp_twoowners'").get())
      .toMatchObject({ state: 'registered', released_at: null });
  } finally { second?.close(); }
});

it.each(['pr_closed', 'pr_merged', 'pr_head_ref_changed', 'base_changed', 'external_write', 'head_regressed'] as const)(
  'requests host cancellation for %s', async expected => {
    const f = await publishFixture();
    const cancel = vi.fn(async () => {});
    f.deps.cancelChild = cancel;
    f.deps.readPr = async () => ({ state: expected === 'pr_closed' ? 'CLOSED' : expected === 'pr_merged' ? 'MERGED' : 'OPEN',
      repository: 'o/r', headRefName: expected === 'pr_head_ref_changed' ? 'other' : 'topic',
      headRefOid: expected === 'external_write' || expected === 'head_regressed' ? oid('f') : old,
      baseRefName: 'main', baseRefOid: expected === 'base_changed' ? oid('f') : oid('a'), url: 'https://example.invalid/pull/7' });
    f.deps.localGit = async (_cwd, args) => ({ stdout: args[0] === 'rev-list' ? next : '',
      exitCode: expected === 'head_regressed' && args[0] === 'merge-base' && args[3] === oid('f') ? 1 : 0 });
    await expect(f.call()).rejects.toThrow(`CONTAINED_REVISION_REFUSED:${expected}`);
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith(f.id);
    expect(f.deps.chains.get(f.chain.chain_id).state).toBe(expected === 'pr_closed' || expected === 'pr_merged' ? 'closed' : 'awaiting_decision');
  });

it.each([
  ['chain_state', 'fence_chain_state', (f: Awaited<ReturnType<typeof publishFixture>>) => {
    const chain = f.deps.chains.get(f.chain.chain_id);
    f.deps.chains.stopLive(chain.chain_id, chain.revision, 'child_halted', ++f.f.clock.now);
  }],
  ['child_cancelled', 'child_cancelled', (f: Awaited<ReturnType<typeof publishFixture>>) => {
    const child = f.deps.missions.get(f.id);
    f.deps.missions.transition(f.id, { if_revision: child.revision, to: 'cancel_requested', event: { kind: 'cancel_requested', payload: {} } }, ++f.f.clock.now);
  }],
] as const)('release fence detects %s before git runs', async (_name, expected, mutate) => {
  let f!: Awaited<ReturnType<typeof publishFixture>>;
  let gitRan = false;
  f = await publishFixture(async (intentId, journal, fence) => {
    const opId = 'hp_releasemutated';
    journal.launching({ op_id: opId, mission_id: f.id, kind: 'git_push', remote_target: 'o/r#refs/heads/topic', local_target: '/tmp/repo#refs/heads/topic',
      intent_id: intentId, argv_digest: '8'.repeat(64), boot_id: 'test', marker: { path: '/tmp/marker', dev: '1', ino: '1' } });
    journal.registered(opId, { pid: 12345, pgid: 12345, leader_start: 'test' });
    mutate(f);
    try { journal.release(opId, fence); } catch (error) { journal.stopped(opId, { proof: 'never_released', detail: {} }); throw error; }
    gitRan = true;
    throw Error('git_ran');
  });
  await expect(f.call()).rejects.toThrow(`CONTAINED_REVISION_REFUSED:${expected}`);
  expect(gitRan).toBe(false);
  expect(f.deps.chains.intents(f.chain.chain_id).at(-1)).toMatchObject({ state: 'failed', detail: expected });
});

it('release fence checks the intent head, current child, and reservation binding', async () => {
  const f = await fullFixture();
  const mission = f.deps.missions.get(f.id);
  const input = { mission, spec: f.f.childSpec(f.id), permit: { mission_id: f.id, revision: mission.revision,
    head: next, tree: '3'.repeat(40), spec_digest: mission.spec_digest }, beforeRemoteMutation: () => {}, signal: new AbortController().signal };
  expect(() => assertRevisionPublishable(f.deps, { ...input, permit: { ...input.permit, head: '9'.repeat(40) } }, f.intent.intent_id))
    .toThrow('CONTAINED_REVISION_FENCE:intent_moved');
  expect(() => assertRevisionPublishable(f.deps, { ...input, mission: { ...mission, mission_id: f.f.rootId } }, f.intent.intent_id))
    .toThrow('CONTAINED_REVISION_FENCE:not_current_child');
  f.f.rig.db.prepare("UPDATE engineering_revision_reservations SET state='void',settled_reason='test' WHERE chain_id=?").run(f.input.chain_id);
  expect(() => assertRevisionPublishable(f.deps, input, f.intent.intent_id)).toThrow('CONTAINED_REVISION_FENCE:intent_moved');
});

it('release fence rejects a stale owner without changing any ledger', async () => {
  const f = await fullFixture();
  const mission = f.deps.missions.get(f.id);
  const input = { mission, spec: f.f.childSpec(f.id), permit: { mission_id: f.id, revision: mission.revision,
    head: next, tree: '3'.repeat(40), spec_digest: mission.spec_digest }, beforeRemoteMutation: () => {}, signal: new AbortController().signal };
  const chainBefore = f.deps.chains.get(f.input.chain_id);
  const owner = vi.spyOn(f.deps.chains.attention, 'assertOwner').mockImplementationOnce(() => { throw Error('stale_owner'); });
  expect(() => assertRevisionPublishable(f.deps, input, f.intent.intent_id)).toThrow('CONTAINED_REVISION_FENCE:stale_owner');
  owner.mockRestore();
  expect(f.deps.chains.get(f.input.chain_id)).toEqual(chainBefore);
  expect(f.deps.chains.getIntent(f.intent.intent_id).state).toBe('pending');
});

it.each(['pr_read', 'remote_head', 'merge_base'] as const)('leaves no ledger writes when %s fails before intent creation', async failure => {
  const f = await publishFixture();
  const chainBefore = f.deps.chains.get(f.chain.chain_id);
  const eventsBefore = f.deps.chains.events(f.chain.chain_id, 0, 500).length;
  const childEventsBefore = f.deps.missions.events(f.id, 0, 500).length;
  if (failure === 'pr_read') f.deps.readPr = async () => { throw Error('HTTP 502'); };
  if (failure === 'remote_head') f.deps.remoteHead = async () => { throw Error('ls-remote timeout'); };
  if (failure === 'merge_base') {
    f.deps.remoteHead = async () => '3'.repeat(40);
    f.deps.localGit = async (_cwd, args) => { if (args[0] === 'merge-base' && args[3] === '3'.repeat(40)) throw Error('spawn failed');
      return { stdout: args[0] === 'rev-list' ? next : '', exitCode: 0 }; };
  }
  await expect(f.call()).rejects.toThrow(`CONTAINED_REVISION_PREFLIGHT_RETRYABLE:${failure}`);
  expect(f.deps.chains.get(f.chain.chain_id)).toMatchObject({ state: chainBefore.state, revision: chainBefore.revision });
  expect(f.deps.chains.intents(f.chain.chain_id)).toHaveLength(0);
  expect(f.deps.chains.events(f.chain.chain_id, 0, 500)).toHaveLength(eventsBefore);
  expect(f.deps.missions.get(f.id).state).toBe('delivering');
  expect(f.deps.missions.events(f.id, 0, 500)).toHaveLength(childEventsBefore);
});

it.each(['not_descendant', 'range_too_large', 'start_mismatch', 'intent_binding_mismatch'] as const)(
  'publishRevision derives %s and stops the child before intent creation', async code => {
    const readPr = vi.fn(async () => { throw Error('unexpected_pr_read'); });
    const localGit: RevisionPublicationDeps['localGit'] = async (_cwd, args) => {
      if (args[0] === 'rev-list') return { stdout: code === 'range_too_large'
        ? Array.from({ length: 65 }, (_, i) => (i + 1).toString(16).padStart(40, '0')).join('\n') : next, exitCode: 0 };
      return { stdout: '', exitCode: code === 'not_descendant' ? 1 : 0 };
    };
    const f = await publishFixture(undefined, { localGit, readPr });
    if (code === 'start_mismatch') f.spec.start_commit = '9'.repeat(40);
    if (code === 'intent_binding_mismatch') f.spec.publish_target = { ...f.spec.publish_target!, pr: 8 };

    await expect(f.call()).rejects.toThrow(`CONTAINED_REVISION_REFUSED:${code}`);
    expect(f.deps.chains.intents(f.chain.chain_id).filter(i => i.kind === 'push')).toHaveLength(0);
    expect(f.deps.chains.get(f.chain.chain_id)).toMatchObject({ state: 'awaiting_decision', stop_reason: `publish_refused:${code}` });
    expect(f.deps.missions.get(f.id).state).toBe('awaiting_decision');
    const halted = f.deps.missions.events(f.id, 0, 500).filter(e => e.kind === 'halted').at(-1);
    expect(JSON.parse(halted!.payload_json).reason).toBe(`publication_failed:${code}`);
    expect(readPr).not.toHaveBeenCalled();
  },
);

it.each(['runner_throws', 'stop_unproven'] as const)('%s stops chain and child atomically', async mode => {
  let id = '';
  const f = await publishFixture(async (intentId, journal, fence) => {
    releasePush(journal, intentId, id, fence, mode === 'stop_unproven');
    if (mode === 'runner_throws') throw Error('runner_crashed');
    return { stdout: '', stderr: '', exitCode: 0, opId: 'wrong_op_id' };
  });
  id = f.id;
  const transition = vi.spyOn(f.deps.missions, 'transition').mockImplementation(() => { throw Error('child_write_failed'); });
  await expect(f.call()).rejects.toThrow('child_write_failed');
  transition.mockRestore();
  expect(f.deps.chains.get(f.chain.chain_id).state).toBe('publishing');
  expect(f.deps.missions.get(f.id).state).toBe('delivering');
  expect(f.deps.chains.intents(f.chain.chain_id).at(-1)?.state).toBe('pending');
});

it('moves a child to stop_unknown when the runner throws with unproven stop', async () => {
  let id = '';
  const f = await publishFixture(async (intentId, journal, fence) => {
    releasePush(journal, intentId, id, fence, false);
    throw Error('runner_crashed');
  });
  id = f.id;
  await expect(f.call()).rejects.toThrow('runner_crashed');
  expect(f.deps.chains.get(f.chain.chain_id)).toMatchObject({ state: 'awaiting_decision', stop_reason: 'intent_uncertain' });
  expect(f.deps.missions.get(f.id)).toMatchObject({ state: 'stop_unknown', stop_obligation: 1 });
  expect(f.deps.chains.intents(f.chain.chain_id).at(-1)?.state).toBe('pending');
});

it('moves a child to stop_unknown when STOP_UNPROVEN is detected', async () => {
  let id = '';
  const f = await publishFixture(async (intentId, journal, fence) => {
    releasePush(journal, intentId, id, fence, true);
    return { stdout: '', stderr: '', exitCode: 0, opId: 'wrong_op_id' };
  });
  id = f.id;
  await expect(f.call()).rejects.toThrow('CONTAINED_REVISION_STOP_UNPROVEN');
  expect(f.deps.chains.get(f.chain.chain_id)).toMatchObject({ state: 'awaiting_decision', stop_reason: 'intent_uncertain' });
  expect(f.deps.missions.get(f.id)).toMatchObject({ state: 'stop_unknown', stop_obligation: 1 });
  const halt = f.deps.missions.events(f.id, 0, 500).filter(e => e.kind === 'halted').at(-1);
  expect(JSON.parse(halt!.payload_json).route).toBe('delivering');
});

it.each([
  ['CONTAINED_REMOTE_BRANCH_BUSY', 'push_in_flight'], ['CONTAINED_BRIDGE_TRANSPORT_UNSUPPORTED', 'transport_unsupported'],
  ['CONTAINED_REVISION_FENCE:grant_expired', 'grant_expired'], ['CONTAINED_REVISION_FENCE:base_changed', 'base_changed'],
  ['CONTAINED_REVISION_FENCE:external_write', 'external_write'], ['CONTAINED_REVISION_FENCE:head_regressed', 'head_regressed'],
  ['CONTAINED_REVISION_FENCE:bridge_live_disabled', 'bridge_live_disabled'], ['CONTAINED_REVISION_FENCE:intent_moved', 'fence_intent_moved'],
  ['CONTAINED_REVISION_FENCE:not_current_child', 'fence_not_current_child'], ['TOKEN_REVOKED', 'token_unavailable'],
  ['CONTAINED_REVISION_FENCE:chain_state', 'fence_chain_state'], ['CONTAINED_PUBLICATION_DESTINATION', 'push_url_invalid'],
] as const)('maps runner error %s to refusal %s', async (error, expected) => {
  const f = await publishFixture(async () => { throw Error(error); });
  await expect(f.call()).rejects.toThrow(`CONTAINED_REVISION_REFUSED:${expected}`);
  expect(f.deps.chains.intents(f.chain.chain_id).at(-1)).toMatchObject({ state: 'failed', detail: expected });
  expect(f.deps.chains.get(f.chain.chain_id)).toMatchObject({ state: 'awaiting_decision',
    stop_reason: ['grant_expired', 'base_changed', 'external_write', 'head_regressed'].includes(expected) ? expected : `publish_refused:${expected}` });
  expect(f.deps.missions.get(f.id).state).toBe('awaiting_decision');
  const halted = f.deps.missions.events(f.id, 0, 500).filter(e => e.kind === 'halted').at(-1);
  expect(JSON.parse(halted!.payload_json).reason).toBe(`publication_failed:${expected}`);
});

it('keeps a stopped auth failure uncertain without structured pre-update proof', async () => {
  let id = '';
  const f = await publishFixture(async (intentId, journal, fence) => {
    const opId = releasePush(journal, intentId, id, fence, true);
    return { stdout: '', stderr: "fatal: Authentication failed for 'https://github.com/o/r.git/'", exitCode: 128, opId };
  });
  id = f.id;
  await expect(f.call()).rejects.toThrow('CONTAINED_REVISION_READBACK_MISMATCH');
  expect(f.deps.chains.intents(f.chain.chain_id).at(-1)).toMatchObject({ state: 'uncertain', detail: 'readback_mismatch' });
});

describe('revision confirmation D10', () => {
  it.each(['settle', 'deadline', 'void', 'evidence', 'pr_opened', 'check_intent', 'event'] as const)('rolls back every write after %s', async at => {
    const { f, deps, input, id, intent } = await fullFixture();
    expect(() => confirmRevisionPublication(deps, { ...input, fault: step => { if (step === at) throw Error('crash'); } })).toThrow('crash');
    expect(deps.chains.getIntent(intent.intent_id).state).toBe('pending');
    expect(deps.chains.get(input.chain_id).state).toBe('publishing');
    expect(deps.chains.reservations(input.chain_id)[0]?.state).toBe('dispatched');
    expect(deps.missions.get(id).state).toBe('delivering');
    expect(deps.missions.events(id, 0, 500).some(e => e.kind === 'delivery_evidence')).toBe(false);
    expect(deps.chains.events(input.chain_id, 0, 500).some(e => e.kind === 'round_published')).toBe(false);
    const push = vi.spyOn(deps.runner, 'run');
    expect((await reconcileReceipt(deps, input, { cwd: '/tmp/repo', remote: 'origin' }))?.state).toBe('pr_opened');
    expect(push).not.toHaveBeenCalled();
    expect(deps.chains.getIntent(intent.intent_id).state).toBe('confirmed');
    expect(deps.chains.get(input.chain_id)).toMatchObject({ state: 'awaiting_review', published_head: next });
    expect(deps.chains.reservations(input.chain_id)[0]).toMatchObject({ state: 'void', settled_reason: 'published' });
    expect(deps.chains.intents(input.chain_id).some(i => i.kind === 'check' && i.state === 'pending')).toBe(true);
    expect(f.clock.now).toBeGreaterThan(T0);
  });

  it('refuses confirmation when the route changed after read-back', async () => {
    const { deps, input } = await fullFixture();
    const chain = deps.chains.get(input.chain_id);
    deps.chains.stopLive(chain.chain_id, chain.revision, 'base_changed', T0 + H);
    expect(() => confirmRevisionPublication(deps, input)).toThrow('confirm_route_changed');
    expect(deps.chains.getIntent(input.intent_id).state).toBe('pending');
    await reconcileReceipt(deps, input.intent_id, 'route_changed', { cwd: '/tmp/repo', remote: 'origin' });
    expect(deps.chains.getIntent(input.intent_id).state).toBe('confirmed');
    expect(deps.chains.get(input.chain_id)).toMatchObject({ state: 'awaiting_decision', stop_reason: 'base_changed' });
  });

  it('confirms the remote fact after cancellation without creating a check intent', async () => {
    const { deps, input, id } = await fullFixture();
    const child = deps.missions.get(id);
    deps.missions.transition(id, { if_revision: child.revision, to: 'cancel_requested', event: { kind: 'cancel_requested', payload: {} } }, T0 + H);
    expect(confirmRevisionPublication(deps, { ...input, variant: 'cancelled' }).state).toBe('cancelled');
    expect(deps.chains.getIntent(input.intent_id).state).toBe('confirmed');
    expect(deps.chains.get(input.chain_id)).toMatchObject({ state: 'awaiting_decision', stop_reason: 'child_cancelled', published_head: next });
    expect(deps.chains.intents(input.chain_id).filter(i => i.kind === 'check')).toHaveLength(0);
  });
  it.each(['success', 'failure'] as const)('shares concurrent check delivery and preserves terminal intents after %s', async outcome => {
    const { deps, input, id } = await fullFixture();
    confirmRevisionPublication(deps, input);
    const port = createRevisionPublicationPort(deps);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const failure = Error('check_unavailable');
    const send = vi.fn(async () => {
      await barrier;
      if (outcome === 'failure') throw failure;
      return { check_run_id: 51, created: true };
    });
    const first = port.publishCheck(id, send);
    // The second caller must join the first attempt, even with a different sender.
    const secondSend = vi.fn(async () => ({ check_run_id: 52, created: true }));
    const second = port.publishCheck(id, secondSend);
    release();
    const results = await Promise.allSettled([first, second]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(secondSend).not.toHaveBeenCalled();
    const checks = () => deps.chains.intents(input.chain_id).filter(i => i.kind === 'check');
    if (outcome === 'success') {
      expect(results).toEqual([{ status: 'fulfilled', value: { check_run_id: 51, created: true } }, { status: 'fulfilled', value: { check_run_id: 51, created: true } }]);
      expect(await port.publishCheck(id, secondSend)).toEqual({ check_run_id: 51, created: false });
      expect(secondSend).not.toHaveBeenCalled();
      expect(checks().map(i => i.state)).toEqual(['confirmed']);
    } else {
      expect(results).toEqual([{ status: 'rejected', reason: failure }, { status: 'rejected', reason: failure }]);
      expect(checks().map(i => i.state)).toEqual(['failed']);
      expect(await port.publishCheck(id, secondSend)).toEqual({ check_run_id: 52, created: true });
      expect(checks().map(i => i.state)).toEqual(['failed', 'confirmed']);
    }
    expect(deps.chains.get(input.chain_id)).toMatchObject({ state: 'awaiting_review', published_head: next, current_mission_id: id });
  });

  it('registers check delivery before a sender can synchronously reenter the port', async () => {
    const { deps, input, id } = await fullFixture();
    confirmRevisionPublication(deps, input);
    const port = createRevisionPublicationPort(deps);
    const secondSend = vi.fn(async () => ({ check_run_id: 56, created: true }));
    let reentered: ReturnType<typeof port.publishCheck> | undefined;
    const first = port.publishCheck(id, async () => {
      reentered = port.publishCheck(id, secondSend);
      return { check_run_id: 55, created: true };
    });
    await Promise.allSettled([first]);
    expect(reentered).toBe(first);
    expect(await first).toEqual({ check_run_id: 55, created: true });
    expect(secondSend).not.toHaveBeenCalled();
  });

  it('does not start another check when the chain closes during an in-flight delivery', async () => {
    const { deps, input, id } = await fullFixture();
    confirmRevisionPublication(deps, input);
    const port = createRevisionPublicationPort(deps);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const first = port.publishCheck(id, async () => { await barrier; return { check_run_id: 53, created: true }; });
    await Promise.resolve(); // The first sender has started and is waiting on its remote receipt.
    const chain = deps.chains.get(input.chain_id);
    deps.chains.closeLive(chain.chain_id, chain.revision, 'pr_closed', deps.now());
    const send = vi.fn(async () => ({ check_run_id: 54, created: true }));
    const second = port.publishCheck(id, send);
    release();
    expect(await Promise.all([first, second])).toEqual([{ check_run_id: 53, created: true }, { check_run_id: 53, created: true }]);
    expect(send).not.toHaveBeenCalled();
    expect(deps.chains.intents(input.chain_id).filter(i => i.kind === 'check')).toMatchObject([{ state: 'confirmed', detail: '53' }]);
    expect(deps.chains.get(input.chain_id).state).toBe('closed');
  });

  it('settles the App B check intent and permits a new intent after a failed check', async () => {
    const { deps, input, id } = await fullFixture();
    confirmRevisionPublication(deps, input);
    await expect(publishRevisionCheck(deps, id, async () => { throw Error('check_unavailable'); })).rejects.toThrow('check_unavailable');
    expect(deps.chains.intents(input.chain_id).filter(i => i.kind === 'check').map(i => i.state)).toEqual(['failed']);
    expect(await publishRevisionCheck(deps, id, async () => ({ check_run_id: 19, created: true }))).toEqual({ check_run_id: 19, created: true });
    expect(deps.chains.intents(input.chain_id).filter(i => i.kind === 'check').map(i => i.state)).toEqual(['failed', 'confirmed']);
    expect(await publishRevisionCheck(deps, id, async () => { throw Error('must_not_send_again'); })).toEqual({ check_run_id: 19, created: false });
    expect(deps.chains.get(input.chain_id).state).toBe('awaiting_review');
  });

  it.each(['stopped', 'closed'] as const)('routes the confirmed child check on a %s live chain', async state => {
    const { deps, input, id } = await fullFixture();
    confirmRevisionPublication(deps, input);
    await expect(publishRevisionCheck(deps, id, async () => { throw Error('check_unavailable'); })).rejects.toThrow('check_unavailable');
    const chain = deps.chains.get(input.chain_id);
    if (state === 'closed') deps.chains.closeLive(chain.chain_id, chain.revision, 'pr_closed', T0 + H);
    else deps.chains.stopLive(chain.chain_id, chain.revision, 'base_changed', T0 + H);
    const send = vi.fn(async () => ({ check_run_id: 29, created: true }));
    expect(await publishRevisionCheck(deps, id, send)).toEqual(state === 'closed'
      ? { check_run_id: 0, created: false, skipped: true } : { check_run_id: 29, created: true });
    expect(send).toHaveBeenCalledTimes(state === 'closed' ? 0 : 1);
    expect(deps.chains.intents(input.chain_id).filter(i => i.kind === 'check').map(i => i.state)).toEqual(state === 'closed' ? ['failed'] : ['failed', 'confirmed']);
    if (state === 'closed') expect(deps.chains.events(input.chain_id, 0, 500).map(e => e.kind)).toContain('check_skipped');
    expect(deps.chains.get(input.chain_id).state).toBe(state === 'closed' ? 'closed' : 'awaiting_decision');
  });

  it('uses the confirmed push chain after current_mission_id moves to another child', async () => {
    const { deps, input, id, f } = await fullFixture({ rounds: 2 });
    confirmRevisionPublication(deps, input);
    const confirmed = deps.chains.get(input.chain_id);
    deps.chains.clearCurrentMission(input.chain_id, confirmed.revision, ++f.clock.now);
    f.pr.head = next;
    f.pr.reviews = [changesRequested(78, next)];
    expect((await dispatched(f)).child_mission_id).not.toBe(id);
    expect(await publishRevisionCheck(deps, id, async () => ({ check_run_id: 31, created: true }))).toEqual({ check_run_id: 31, created: true });
    expect(deps.chains.intents(input.chain_id).filter(i => i.kind === 'check').map(i => i.state)).toEqual(['confirmed']);
  });
});

describe('revision refusal D4', () => {
  it.each(['rejects', 'throws'] as const)('records child_cancel_failed when pre-push cancellation %s', async mode => {
    const p = await publishFixture(undefined, { readPr: async () => ({ state: 'CLOSED', repository: 'o/r', headRefName: 'topic', headRefOid: old,
      baseRefName: 'main', baseRefOid: 'a'.repeat(40), url: 'https://example.invalid/pull/7' }) });
    p.deps.cancelChild = mode === 'throws' ? (() => { throw Error('cancel_conflict:revision'); }) : (async () => { throw Error('cancel_conflict:revision'); });
    await expect(p.call()).rejects.toThrow('CONTAINED_REVISION_REFUSED:pr_closed');
    await vi.waitFor(() => expect(p.deps.chains.events(p.chain.chain_id, 0, 500).filter(e => e.kind === 'child_cancel_failed').map(e => JSON.parse(e.payload_json)))
      .toEqual([{ child: p.id, code: 'cancel_conflict' }]));
  });

  it('records child_cancel_failed after a pushed revision when cancellation rejects', async () => {
    let remote = old;
    const p = await publishFixture(async (intentId, journal, fence) => {
      const opId = releasePush(journal, intentId, p.id, fence, true);
      remote = next;
      return { stdout: '', stderr: '', exitCode: 0, opId };
    });
    p.deps.remoteHead = async () => remote;
    p.deps.readPr = async () => ({ state: remote === next ? 'CLOSED' : 'OPEN', repository: 'o/r', headRefName: 'topic', headRefOid: remote,
      baseRefName: 'main', baseRefOid: 'a'.repeat(40), url: 'https://example.invalid/pull/7' });
    p.deps.cancelChild = async () => { throw Error('cancel_conflict:revision'); };
    await expect(p.call()).rejects.toThrow('CONTAINED_REVISION_PR_CHANGED_AFTER_PUSH');
    expect(p.deps.chains.events(p.chain.chain_id, 0, 500).filter(e => e.kind === 'child_cancel_failed').map(e => JSON.parse(e.payload_json)))
      .toEqual([{ child: p.id, code: 'cancel_conflict' }]);
  });

  const codes: RevisionRefusalCode[] = ['repo_config_changed', 'local_head_mismatch', 'push_url_invalid', 'transport_unsupported',
    'start_mismatch', 'publisher_unavailable', 'intent_binding_mismatch', 'grant_expired', 'chain_state',
    'pr_closed', 'pr_merged', 'pr_head_ref_changed', 'base_changed', 'external_write', 'head_regressed',
    'not_descendant', 'range_too_large', 'token_unavailable', 'push_in_flight', 'bridge_live_disabled',
    'fence_chain_state', 'fence_intent_moved', 'fence_not_current_child', 'push_rejected', 'never_released'];
  it.each(codes)('%s settles intent and halts the child with a specific reason', async code => {
    const { deps, input, id } = await fullFixture();
    refuseRevisionPublication(deps, input.chain_id, id, input.intent_id, code);
    expect(deps.chains.getIntent(input.intent_id).state).toBe('failed');
    const chain = deps.chains.get(input.chain_id);
    expect(chain.state).toBe(code === 'pr_closed' || code === 'pr_merged' ? 'closed' : 'awaiting_decision');
    if (chain.state !== 'closed') expect(chain.stop_reason).toBe(['base_changed', 'external_write', 'head_regressed', 'grant_expired'].includes(code) ? code : `publish_refused:${code}`);
    expect(deps.missions.get(id).state).toBe('awaiting_decision');
    const halted = deps.missions.events(id, 0, 500).filter(e => e.kind === 'halted').at(-1);
    expect(JSON.parse(halted!.payload_json).reason).toBe(`publication_failed:${code}`);
    expect(deps.chains.events(input.chain_id, 0, 500).filter(e => e.kind === 'transition').at(-1)).toBeDefined();
  });
  it('stops a preflight failure without writing a push intent', async () => {
    const base = await fixture({ intent: false });
    refuseRevisionPublication({ chains: base.f.rig.chains, missions: base.f.rig.missions, now: () => ++base.f.clock.now },
      base.chain!.chain_id, base.id, undefined, 'repo_config_changed');
    expect(base.f.rig.chains.intents(base.chain!.chain_id)).toHaveLength(0);
    expect(base.f.rig.chains.get(base.chain!.chain_id).stop_reason).toBe('publish_refused:repo_config_changed');
    expect(base.f.rig.missions.get(base.id).state).toBe('awaiting_decision');
  });
  it('rolls back the chain stop and failed settlement if the child halt fails', async () => {
    const { deps, input, id } = await fullFixture();
    const before = deps.chains.get(input.chain_id);
    const transition = vi.spyOn(deps.missions, 'transition').mockImplementation(() => { throw Error('halt_failed'); });
    expect(() => refuseRevisionPublication(deps, input.chain_id, id, input.intent_id, 'base_changed')).toThrow('halt_failed');
    transition.mockRestore();
    expect(deps.chains.get(input.chain_id)).toMatchObject({ state: before.state, revision: before.revision });
    expect(deps.chains.getIntent(input.intent_id).state).toBe('pending');
    expect(deps.missions.get(id).state).toBe('delivering');
  });
});

it.each(['success', 'success_three_commits', 'lease_ancestor', 'stale', 'lease_rejected', 'readback_mismatch', 'base_changed', 'pr_closed', 'base_changed_before_release'] as const)('%s: local lease push with W13 binding', async scenario => {
  const root = mkdtempSync(join(tmpdir(), 'revision-push-'));
  const repo = join(root, 'repo'); const bare = join(root, 'bare.git');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    execFileSync('git', ['init', '-q', '-b', 'topic', repo]);
    git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'ancestor'); const ancestor = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'base'); const first = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'revision'); const second = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'outsider'); const third = git(repo, 'rev-parse', 'HEAD');
    const threeCommits = scenario === 'success_three_commits';
    if (threeCommits) git(repo, 'commit', '-q', '--allow-empty', '-m', 'third revision');
    const candidate = threeCommits ? git(repo, 'rev-parse', 'HEAD') : second;
    execFileSync('git', ['init', '-q', '--bare', bare]);
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'push', '-q', 'origin', `${first}:refs/heads/topic`);
    const base = await fixture({ oldHead: first, newHead: candidate, intent: false });
    const { f, id, mission, chain, journal } = base;
    if (!mission || !chain || !journal) throw Error('fixture_incomplete');
    let pushes = 0; let attempts = 0; let baseChanged = false;
    const cancel = vi.fn(async () => {});
    const remoteHead = () => git(repo, 'ls-remote', 'origin', 'refs/heads/topic').split(/\s/)[0]!;
    const deps: RevisionPublicationDeps = {
      chains: f.rig.chains, missions: f.rig.missions, now: () => ++f.clock.now,
      host: { recordForIntent: intentId => f.rig.db.prepare('SELECT * FROM engineering_host_processes WHERE intent_id=?').get(intentId) as ReturnType<typeof journal.get> | undefined },
      runner: { gated: true, run: async (command, args, options) => {
        if (command !== 'git') throw Error('unexpected_command');
        if (args.includes('get-url')) return { stdout: 'https://github.com/o/r.git\n', stderr: '', exitCode: 0 };
        if (!args.includes('push') || !options.gate) throw Error('unexpected_command');
        attempts++;
        const opId = `hp_realpush${attempts}`;
        journal.launching({ op_id: opId, mission_id: id, kind: 'git_push', remote_target: options.gate.remoteTarget,
          local_target: options.gate.localTarget, ...(options.gate.intentId ? { intent_id: options.gate.intentId } : {}), argv_digest: '8'.repeat(64), boot_id: 'test', marker: { path: join(root, 'marker'), dev: '1', ino: '1' } });
        journal.registered(opId, { pid: 12345, pgid: 12345, leader_start: 'test' });
        if (scenario === 'base_changed_before_release') baseChanged = true;
        try { journal.release(opId, options.gate.fence); }
        catch (error) { journal.stopped(opId, { proof: 'never_released', detail: {} }); throw error; }
        pushes++;
        if (scenario === 'stale' || scenario === 'lease_rejected') git(repo, 'push', '-q', 'origin', `${third}:refs/heads/topic`);
        // An ordinary push accepts this ancestor reset. Only the exact old-head
        // lease detects the intervening write and leaves the branch untouched.
        if (scenario === 'lease_ancestor') git(repo, 'push', '-q', '--force', 'origin', `${ancestor}:refs/heads/topic`);
        let stdout = ''; let stderr = ''; let exitCode = 0;
        try { stdout = git(repo, ...args.slice(args.indexOf('push'))); } catch (error) {
          const failure = error as { status: number; stdout: Buffer; stderr: Buffer };
          exitCode = failure.status; stdout = String(failure.stdout); stderr = String(failure.stderr);
        }
        if (scenario === 'lease_rejected') git(repo, 'push', '-q', '--force', 'origin', `${first}:refs/heads/topic`);
        journal.stopped(opId, { proof: 'group_empty+marker_unheld', detail: {}, exit_code: exitCode });
        return { stdout, stderr, exitCode, opId };
      } },
      readPr: async () => ({ state: scenario === 'pr_closed' && remoteHead() === candidate ? 'CLOSED' : 'OPEN', repository: 'o/r', headRefName: 'topic', headRefOid: remoteHead(), baseRefName: 'main',
        baseRefOid: baseChanged || scenario === 'base_changed' && remoteHead() === candidate ? 'b'.repeat(40) : 'a'.repeat(40), url: 'https://example.invalid/pull/7' }),
      localGit: async (cwd, args) => { try { return { stdout: git(cwd, ...args), exitCode: 0 }; } catch { return { stdout: '', exitCode: 1 }; } },
      remoteHead: async () => remoteHead(), compare: async (repository, oldHead, newHead) => threeCommits
        ? compareRevisionRange(repository, oldHead, newHead, async () => ({ stdout: JSON.stringify({ total_commits: 3,
          commits: [second, third, candidate].map(sha => ({ sha })) }), stderr: '', exitCode: 0 }))
        : scenario === 'readback_mismatch' ? [] : [second], preflight: async () => {}, checkEnabled: true, sleep: async () => {}, cancelChild: cancel,
      fenceAuthority: () => ({ access: f.deps.access, keys: f.deps.keys(), now: f.clock.now, enabled: f.flags.enabled }),
    };
    const spec = { ...f.childSpec(id), worktree_path: repo, repo_path: repo };
    const permit = { mission_id: id, revision: mission.revision, head: candidate, tree: '3'.repeat(40), spec_digest: mission.spec_digest };
    const call = () => publishRevision(deps, { mission, spec, permit, beforeRemoteMutation: () => {
      if (scenario === 'base_changed_before_release' && baseChanged) throw Error('CONTAINED_REVISION_FENCE:base_changed');
    }, signal: new AbortController().signal });
    if (scenario === 'success' || threeCommits) {
      const result = await call();
      expect(result).toMatchObject({ pushed_commit: candidate, push_range: threeCommits ? [second, third, candidate] : [second], pr: { reused: true } });
      expect(deps.host.recordForIntent(result.intent_id)).toMatchObject({ op_id: result.op_id, state: 'stopped', intent_id: result.intent_id });
      expect(deps.chains.get(chain.chain_id).state).toBe('publishing');
      if (scenario === 'success') {
        git(repo, 'push', '-q', 'origin', `${third}:refs/heads/topic`);
        deps.compare = async (_repository, oldHead, newHead) => git(repo, 'rev-list', '--reverse', `${oldHead}..${newHead}`).split('\n');
        const recovered = await recoverRevision(deps, { mission: deps.missions.get(id), spec, permit, beforeRemoteMutation: () => { throw Error('unexpected_push'); }, signal: new AbortController().signal });
        expect(recovered).toMatchObject({ intent_id: result.intent_id, pushed_commit: candidate, push_range: [second] });
        expect(pushes).toBe(1);
      }
      if (threeCommits) {
        const child = confirmRevisionPublication(deps, { chain_id: chain.chain_id, intent_id: result.intent_id, child_mission_id: id,
          permit_revision: permit.revision, evidence: { evidence_digest: '6'.repeat(64), head: candidate, repository: 'o/r' },
          pr: { ...result.pr, reused: true }, range_sha256: result.range_sha256 });
        expect(child.state).toBe('pr_opened');
        expect(deps.chains.getIntent(result.intent_id).state).toBe('confirmed');
        expect(deps.chains.get(chain.chain_id)).toMatchObject({ state: 'awaiting_review', published_head: candidate });
      }
    } else {
      await expect(call()).rejects.toThrow(scenario === 'stale' || scenario === 'lease_ancestor' || scenario === 'readback_mismatch' ? 'READBACK_MISMATCH' : scenario === 'lease_rejected' ? 'push_rejected'
        : scenario === 'base_changed_before_release' ? 'base_changed' : 'PR_CHANGED_AFTER_PUSH');
      const intent = deps.chains.intents(chain.chain_id).filter(i => i.kind === 'push').at(-1)!;
      expect(intent.state).toBe(scenario === 'readback_mismatch' || scenario === 'stale' || scenario === 'lease_ancestor' ? 'uncertain' : scenario === 'lease_rejected' || scenario === 'base_changed_before_release' ? 'failed' : 'confirmed');
      if (scenario === 'lease_rejected') expect(intent.detail).toBe('push_rejected');
      expect(deps.missions.get(id).state).toBe('awaiting_decision');
      if (scenario === 'base_changed' || scenario === 'pr_closed') expect(cancel).toHaveBeenCalledWith(id);
    }
    expect(remoteHead()).toBe(scenario === 'lease_ancestor' ? ancestor : scenario === 'stale' || scenario === 'success' ? third : scenario === 'lease_rejected' || scenario === 'base_changed_before_release' ? first : candidate);
    expect(pushes).toBe(scenario === 'base_changed_before_release' ? 0 : 1);
    expect(attempts).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe('K1–K6 crash recovery against a bare remote', () => {
  it('K1 leaves a released push pending when host recovery cannot prove the child stopped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'revision-k1-unproven-'));
    let reopened: ReturnType<typeof openDb> | undefined;
    try {
      const { f, deps, input, id } = await fullFixture({ journalStopped: false });
      const crashed = spawnSync(process.execPath, ['-e',
        "const Database=require('better-sqlite3'); const db=new Database(process.argv[1]); db.exec('BEGIN IMMEDIATE'); db.prepare('SELECT 1').get(); process.exit(74)",
        f.rig.path], { cwd: process.cwd(), encoding: 'utf8' });
      expect(crashed.status, crashed.stderr).toBe(74);
      reopened = openDb({ path: f.rig.path });
      reopened.pragma('synchronous=FULL');
      const attention = new AttentionStore(reopened, f.rig.path);
      attention.assertOwner(f.rig.owner);
      const chains = new RevisionChainStore(attention, f.rig.owner);
      const missions = new ContainedMissionStore(attention, f.rig.owner);
      expect(missions.listOutstanding().map(row => row.mission_id)).toContain(id);
      const kit = new HostProcessKit(missions, { markerDir: root, probe: { bootSession: () => null, groupPresent: () => false,
        leader: () => ({ pgid: 12345, start: 'test' }), markerIdentity: () => 'ok', markerHeld: () => true } }, () => ++f.clock.now);
      expect(kit.hp.open(id)).toHaveLength(1);
      const host = new ContainedMissionHost({ ports: { store: missions, hostProcesses: kit, now: () => ++f.clock.now } as unknown as ContainedMissionHostPorts,
        worktreesRoot: root, processGroupEmpty: () => false, processesForWorktree: () => [], hostProcessWaitMs: 0 });
      await host.recover();
      expect(restartedRow(reopened, input.intent_id)).toMatchObject({ state: 'released' });
      expect(chains.getIntent(input.intent_id).state).toBe('pending');
      expect(missions.get(id)).toMatchObject({ state: 'stop_unknown', stop_obligation: 1 });
      const halt = missions.events(id, 0, 500).filter(e => e.kind === 'halted').at(-1)!;
      expect(JSON.parse(halt.payload_json).route).toBe('delivering');
      const recoveryDeps = { ...deps, chains, missions,
        host: { recordForIntent: (intentId: string) => restartedRow(reopened!, intentId) as ReturnType<typeof kit.hp.get> } };
      const mission = missions.get(id);
      const spec = parseContainedMissionSpec(mission.spec_json);
      expect(await recoverRevision(recoveryDeps, { mission, spec, permit: { mission_id: id, revision: mission.revision,
        head: mission.candidate_head!, tree: mission.candidate_tree!, spec_digest: mission.spec_digest },
        beforeRemoteMutation: () => { throw Error('duplicate_push'); }, signal: new AbortController().signal })).toBe('blocked');
      expect(chains.get(input.chain_id)).toMatchObject({ state: 'awaiting_decision', stop_reason: 'intent_uncertain' });
      expect(chains.getIntent(input.intent_id).state).toBe('pending');
    } finally { reopened?.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it('keeps a released stopped push uncertain when the bare remote remains at the old head', async () => {
    const root = mkdtempSync(join(tmpdir(), 'revision-old-'));
    const repo = join(root, 'repo'); const bare = join(root, 'bare.git');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    try {
      execFileSync('git', ['init', '-q', '-b', 'topic', repo]);
      git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'base'); const first = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'revision'); const second = git(repo, 'rev-parse', 'HEAD');
      execFileSync('git', ['init', '-q', '--bare', bare]); git(repo, 'remote', 'add', 'origin', bare);
      git(repo, 'push', '-q', 'origin', `${first}:refs/heads/topic`);
      const { deps, input, id, f } = await fullFixture({ oldHead: first, newHead: second });
      deps.remoteHead = async () => git(repo, 'ls-remote', 'origin', 'refs/heads/topic').split(/\s/)[0]!;
      deps.localGit = async (cwd, args) => { try { return { stdout: git(cwd, ...args), exitCode: 0 }; } catch { return { stdout: '', exitCode: 1 }; } };
      deps.compare = async (_repository, oldHead, newHead) => git(repo, 'rev-list', '--reverse', `${oldHead}..${newHead}`).split('\n').filter(Boolean);
      const mission = deps.missions.get(id);
      expect(await recoverRevision(deps, { mission, spec: { ...f.childSpec(id), worktree_path: repo },
        permit: { mission_id: id, revision: mission.revision, head: second, tree: '3'.repeat(40), spec_digest: mission.spec_digest },
        beforeRemoteMutation: () => { throw Error('duplicate_push'); }, signal: new AbortController().signal })).toBe('blocked');
      expect(deps.chains.getIntent(input.intent_id).state).toBe('uncertain');
      expect(deps.chains.get(input.chain_id)).toMatchObject({ state: 'awaiting_decision', stop_reason: 'intent_uncertain' });
      expect(deps.missions.get(id).state).toBe('awaiting_decision');
      expect(git(repo, 'ls-remote', 'origin', 'refs/heads/topic').split(/\s/)[0]).toBe(first);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['K1 released before stop proof', 'K2 stopped before readback', 'K3 confirmation rollback then process crash',
    'K4 committed before check', 'K5 check sent before settlement', 'K6 settled before claim release'] as const)('%s', async point => {
    const root = mkdtempSync(join(tmpdir(), 'revision-crash-'));
    const repo = join(root, 'repo'); const bare = join(root, 'bare.git');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    let reopened: ReturnType<typeof openDb> | undefined;
    try {
      execFileSync('git', ['init', '-q', '-b', 'topic', repo]);
      git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'base'); const first = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'revision'); const second = git(repo, 'rev-parse', 'HEAD');
      execFileSync('git', ['init', '-q', '--bare', bare]); git(repo, 'remote', 'add', 'origin', bare);
      git(repo, 'push', '-q', 'origin', `${first}:refs/heads/topic`);
      const pointNumber = Number(point.slice(1, 2));
      const { f, deps, input, id, journal } = await fullFixture({ oldHead: first, newHead: second, journalStopped: pointNumber > 2 });
      if (!journal) throw Error('journal_missing');
      if (pointNumber > 2) git(repo, 'push', '-q', 'origin', `${second}:refs/heads/topic`);
      const checkFile = join(root, 'check-receipt');
      const configPath = join(root, 'crash.json');
      const harness = join(root, 'crash.mjs');
      buildSync({ entryPoints: [fileURLToPath(new URL('./contained-mission-revision-crash.fixture.ts', import.meta.url))],
        outfile: harness, bundle: true, platform: 'node', format: 'esm', external: ['better-sqlite3'], banner: { js: `import { createRequire as fixtureRequire } from 'node:module'; const require = fixtureRequire(${JSON.stringify(import.meta.url)});` } });
      writeFileSync(configPath, JSON.stringify({ path: f.rig.path, owner: f.rig.owner, input, point: pointNumber,
        repo, head: second, checkFile, now: f.clock.now }));
      // Package imports in the scratch harness resolve through the worktree, never an installed default home.
      const crashed = spawnSync(process.execPath, ['--experimental-loader', 'data:text/javascript,' + encodeURIComponent(
        `import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';const require=createRequire(${JSON.stringify(import.meta.url)});export async function resolve(s,c,n){if(s.startsWith('@osstack/')||s==='better-sqlite3'||s==='zod'||s==='yaml')return {url:pathToFileURL(require.resolve(s)).href,shortCircuit:true};return n(s,c)}`), harness, configPath],
        { cwd: process.cwd(), encoding: 'utf8' });
      expect(crashed.status, crashed.stderr).toBe(74);
      if (pointNumber === 3) expect(deps.chains.getIntent(input.intent_id).state).toBe('pending');
      let createdChecks = existsSync(checkFile) ? 1 : 0;
      const send = vi.fn(async () => { const created = !existsSync(checkFile); if (created) { createdChecks++; writeFileSync(checkFile, '42'); } return { check_run_id: 42, created }; });
      reopened = openDb({ path: f.rig.path });
      reopened.pragma('synchronous=FULL');
      const attention = new AttentionStore(reopened, f.rig.path);
      const chains = new RevisionChainStore(attention, f.rig.owner);
      const missions = new ContainedMissionStore(attention, f.rig.owner);
      if (point.startsWith('K1')) {
        expect(restartedRow(reopened, input.intent_id)).toMatchObject({ state: 'released' });
        const kit = new HostProcessKit(missions, { markerDir: root, probe: { bootSession: () => null, groupPresent: () => false,
          leader: () => null, markerIdentity: () => 'ok', markerHeld: () => false } }, () => ++f.clock.now);
        const host = new ContainedMissionHost({ ports: { store: missions, hostProcesses: kit, now: () => ++f.clock.now } as unknown as ContainedMissionHostPorts,
          worktreesRoot: root, processGroupEmpty: () => true, processesForWorktree: () => [], hostProcessWaitMs: 0 });
        await host.recover();
        expect(restartedRow(reopened, input.intent_id)).toMatchObject({ state: 'stopped' });
      }
      const restarted: RevisionPublicationDeps = { ...deps, chains, missions,
        host: { recordForIntent: intentId => reopened!.prepare('SELECT * FROM engineering_host_processes WHERE intent_id=?').get(intentId) as ReturnType<typeof journal.get> | undefined },
        remoteHead: async () => git(repo, 'ls-remote', 'origin', 'refs/heads/topic').split(/\s/)[0]!,
        compare: async (_repository, oldHead, newHead) => git(repo, 'rev-list', '--reverse', `${oldHead}..${newHead}`).split('\n').filter(Boolean),
        localGit: async (cwd, args) => { try { return { stdout: git(cwd, ...args), exitCode: 0 }; } catch { return { stdout: '', exitCode: 1 }; } },
        readPr: async () => ({ state: 'OPEN', repository: 'o/r', headRefName: 'topic', headRefOid: git(repo, 'ls-remote', 'origin', 'refs/heads/topic').split(/\s/)[0]!,
          baseRefName: 'main', baseRefOid: 'a'.repeat(40), url: 'https://example.invalid/pull/7' }) };
      const recoveryInput = () => { const mission = missions.get(id); return { mission, spec: { ...f.childSpec(id), worktree_path: repo },
        permit: { mission_id: id, revision: mission.revision, head: second, tree: '3'.repeat(40), spec_digest: mission.spec_digest },
        beforeRemoteMutation: () => { throw Error('duplicate_push'); }, signal: new AbortController().signal }; };
      if (point.startsWith('K1') || point.startsWith('K2') || point.startsWith('K3')) {
        const recovered = await recoverRevision(restarted, recoveryInput());
        expect(recovered).toMatchObject({ intent_id: input.intent_id, pushed_commit: second });
        if (typeof recovered === 'string') throw Error('unexpected_block');
        confirmRevisionPublication(restarted, { ...input, evidence: { ...input.evidence, head: second }, range_sha256: recovered.range_sha256 });
      }
      if (point.startsWith('K4') || point.startsWith('K5')) {
        expect(chainsCheckPending(restarted, input.chain_id)).toBe(true);
        await publishRevisionCheck(restarted, id, send);
        await publishRevisionCheck(restarted, id, send);
        expect(send).toHaveBeenCalledTimes(1);
        expect(createdChecks).toBe(1);
      }
      if (point.startsWith('K6')) {
        expect(missions.claim(id).state).toBe('active');
        missions.releaseClaim(id, 'revision_settled', ++f.clock.now);
        expect(missions.claim(id).state).toBe('released');
      }
      expect(git(repo, 'rev-list', '--count', `${first}..refs/remotes/origin/topic`)).toBe('1');
      expect(chains.getIntent(input.intent_id).state).toBe('confirmed');
      expect(chains.get(input.chain_id)).toMatchObject({ state: 'awaiting_review', published_head: second });
      expect(missions.get(id).state).toBe('pr_opened');
      expect(chains.intents(input.chain_id).filter(i => i.kind === 'push')).toHaveLength(1);
      expect(await recoverRevision(restarted, recoveryInput())).toMatchObject({ landed: true, intent_id: input.intent_id });
      expect(git(repo, 'rev-list', '--count', `${first}..refs/remotes/origin/topic`)).toBe('1');
    } finally { reopened?.close(); rmSync(root, { recursive: true, force: true }); }
  });
});


describe('automatic pending check retry', () => {
  it('recovers a confirmed child pending check once across scheduler restarts', async () => {
    const { deps, input, id } = await fullFixture();
    confirmRevisionPublication(deps, input);
    const send = vi.fn(async () => ({ check_run_id: 72, created: true }));
    const port = createRevisionPublicationPort(deps);
    const options = { ...deps, enabled: () => true, publishCheck: (child: string) => port.publishCheck(child, send) };
    await createRevisionCheckRetryScheduler(options).tick({ limit: 1 });
    await createRevisionCheckRetryScheduler(options).tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toEqual([deps.missions.get(id)]);
    expect(deps.chains.intents(input.chain_id).filter(i => i.kind === 'check')).toMatchObject([{ state: 'confirmed' }]);
  });
  it('does no ledger or remote writes while disabled and settles a closed chain without POST', async () => {
    const { deps, input } = await fullFixture();
    confirmRevisionPublication(deps, input);
    const chain = deps.chains.get(input.chain_id);
    deps.chains.closeLive(chain.chain_id, chain.revision, 'abandon', deps.now());
    const check = deps.chains.intents(chain.chain_id).find(i => i.kind === 'check')!;
    const send = vi.fn(async () => ({ check_run_id: 73, created: true }));
    let enabled = false;
    const scheduler = createRevisionCheckRetryScheduler({ ...deps, enabled: () => enabled,
      publishCheck: child => createRevisionPublicationPort(deps).publishCheck(child, send) });
    await scheduler.tick();
    expect(deps.chains.getIntent(check.intent_id).state).toBe('pending');
    enabled = true; await scheduler.tick();
    expect(deps.chains.getIntent(check.intent_id).state).toBe('failed');
    expect(send).not.toHaveBeenCalled();
  });
  it('backs off retained pending work, honors cancellation, and deduplicates concurrent scans', async () => {
    const { deps, input } = await fullFixture();
    confirmRevisionPublication(deps, input);
    const send = vi.fn(async () => { throw Error('transient_before_send'); });
    const scheduler = createRevisionCheckRetryScheduler({ ...deps, enabled: () => true, publishCheck: send });
    await Promise.all([scheduler.tick(), scheduler.tick()]);
    expect(send).toHaveBeenCalledTimes(1);
    await scheduler.tick(); expect(send).toHaveBeenCalledTimes(1);
    deps.now = () => T0 + H;
    const signal = AbortSignal.abort();
    await expect(scheduler.tick({ signal })).rejects.toThrow();
    await scheduler.stop(); await scheduler.tick(); expect(send).toHaveBeenCalledTimes(1);
  });
});

it('check registration deduplicates pending and permits evidence retry for an earlier confirmed head', async () => {
  const { deps, input, id } = await fullFixture();
  confirmRevisionPublication(deps, input);
  const check = deps.chains.intents(input.chain_id).find(i => i.kind === 'check')!;
  expect(deps.chains.recordCheckIntent(input.chain_id, id, next, deps.now()).intent_id).toBe(check.intent_id);
  deps.chains.settleIntent(check.intent_id, 'failed', deps.now());
  // A later round may become current before a user retries the earlier check.
  deps.chains.clearCurrentMission(input.chain_id, deps.chains.get(input.chain_id).revision, deps.now());
  const retry = deps.chains.recordCheckIntent(input.chain_id, id, next, deps.now());
  expect(retry.intent_id).not.toBe(check.intent_id);
  expect(retry.state).toBe('pending');
});

it('automatic check retry leaves uncertain evidence for manual action and refuses stale owners', async () => {
  const { deps, input, f } = await fullFixture();
  confirmRevisionPublication(deps, input);
  const check = deps.chains.intents(input.chain_id).find(i => i.kind === 'check')!;
  deps.chains.settleIntent(check.intent_id, 'uncertain', deps.now(), 'transport_unknown');
  const send = vi.fn(async () => undefined);
  const scheduler = createRevisionCheckRetryScheduler({ ...deps, enabled: () => true, publishCheck: send });
  await scheduler.tick();
  expect(send).not.toHaveBeenCalled();
  expect(deps.chains.getIntent(check.intent_id).state).toBe('uncertain');
  f.rig.attention.claimOwner('replacement');
  await expect(scheduler.tick()).rejects.toThrow('stale_owner');
  expect(send).not.toHaveBeenCalled();
});

it('bounded check retry advances past backoff work and settles closed uncertain evidence', async () => {
  const { deps, input, id } = await fullFixture();
  confirmRevisionPublication(deps, input);
  const first = deps.chains.intents(input.chain_id).find(i => i.kind === 'check')!;
  const second = deps.chains.recordIntent(input.chain_id, deps.chains.get(input.chain_id).revision,
    { kind: 'check', branch: 'topic', child_mission_id: id, new_head: next, binding: { external_id: id } }, deps.now()).intent;
  const ordered = [first, second].sort((a, b) => a.intent_id.localeCompare(b.intent_id));
  const visits: string[] = [];
  const scheduler = createRevisionCheckRetryScheduler({ ...deps, enabled: () => true, publishCheck: async () => {
    visits.push('send'); throw Error('retryable_before_delivery');
  } });
  await scheduler.tick({ limit: 1 });
  await scheduler.tick({ limit: 1 });
  expect(visits).toHaveLength(2);
  expect(deps.chains.unsettledCheckIntents('', 1).map(i => i.intent_id)).toEqual([ordered[0]!.intent_id]);
  expect(deps.chains.unsettledCheckIntents(ordered[0]!.intent_id, 1).map(i => i.intent_id)).toEqual([ordered[1]!.intent_id]);
  expect(() => deps.chains.unsettledCheckIntents('', 101)).toThrow('invalid_limit');
  deps.chains.settleIntent(first.intent_id, 'uncertain', deps.now());
  const chain = deps.chains.get(input.chain_id);
  deps.chains.closeLive(chain.chain_id, chain.revision, 'abandon', deps.now());
  await scheduler.tick(); // finish the keyset pass
  await scheduler.tick();
  expect(deps.chains.getIntent(first.intent_id).state).toBe('failed');
  expect(deps.chains.getIntent(second.intent_id).state).toBe('failed');
  expect(visits).toHaveLength(2);
});


it.each([
  ['timeout without ref status', '', 'fatal: the remote end hung up unexpectedly', 'uncertain'],
  ['HTTP response lost', '', 'error: RPC failed; HTTP 502', 'uncertain'],
  ['HTTP authorization status without phase proof', '', 'HTTP 403: token revoked', 'uncertain'],
  ['incomplete rejection output', '!', 'error: failed to push some refs', 'uncertain'],
  ['another ref rejected', '!\tother:refs/heads/other\t[remote rejected] (hook declined)', '', 'uncertain'],
  ['explicit target rejected', `!\t${next}:refs/heads/topic\t[rejected] (stale info)`, '', 'failed'],
] as const)('keeps stopped push %s conservative with an unchanged remote', async (_label, stdout, stderr, state) => {
  let id = '';
  const f = await publishFixture(async (intentId, journal, fence) => {
    const opId = releasePush(journal, intentId, id, fence, true);
    return { stdout, stderr, exitCode: 128, opId };
  });
  id = f.id;
  await expect(f.call()).rejects.toThrow(state === 'failed' ? 'CONTAINED_REVISION_REFUSED:push_rejected' : 'CONTAINED_REVISION_READBACK_MISMATCH');
  const intent = f.deps.chains.intents(f.chain.chain_id).find(i => i.kind === 'push')!;
  expect(f.deps.host.recordForIntent(intent.intent_id)).toMatchObject({ state: 'stopped' });
  expect(intent.state).toBe(state);
  expect(f.deps.chains.get(f.chain.chain_id).state).toBe('awaiting_decision');
  if (_label === 'timeout without ref status') {
    f.deps.remoteHead = async () => next;
    expect(await createRevisionReceiptRecovery(f.deps).reconcileUncertain(f.chain)).toEqual({ settled: true });
    expect(f.deps.chains.getIntent(intent.intent_id).state).toBe('confirmed');
    expect(f.deps.chains.get(f.chain.chain_id).state).toBe('awaiting_decision');
  }
});

it('check retry contains throwing diagnostics and never logs sender error text', async () => {
  const { deps, input } = await fullFixture();
  confirmRevisionPublication(deps, input);
  const logged: string[] = [];
  const scheduler = createRevisionCheckRetryScheduler({ ...deps, enabled: () => true,
    publishCheck: async () => { throw Error('sensitive remote response and token'); },
    log: message => { logged.push(message); throw Error('diagnostic_sink_failed'); } });
  await expect(scheduler.tick()).resolves.toBeUndefined();
  expect(logged).toEqual(['revision_check_retry_failed']);
});

it('registers a retry scan before a check publisher can synchronously reenter it', async () => {
  const { deps, input } = await fullFixture();
  confirmRevisionPublication(deps, input);
  let calls = 0;
  let nested: Promise<void> | undefined;
  const scheduler = createRevisionCheckRetryScheduler({ ...deps, enabled: () => true, publishCheck: async () => {
    calls++;
    if (calls === 1) nested = scheduler.tick();
  } });
  await scheduler.tick(); await nested;
  expect(calls).toBe(1);
});

it('scheduled check retry survives a throwing scan diagnostic during owner loss', async () => {
  const { deps, input, f } = await fullFixture();
  confirmRevisionPublication(deps, input);
  const logged: string[] = [];
  const scheduler = createRevisionCheckRetryScheduler({ ...deps, intervalMs: 1, enabled: () => true,
    publishCheck: async () => { throw Error('must_not_send'); },
    log: message => { logged.push(message); throw Error('sink_failed'); } });
  f.rig.attention.claimOwner('replacement');
  vi.useFakeTimers();
  try {
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    await scheduler.stop();
    expect(logged).toEqual(['revision_check_retry_scan_failed']);
  } finally { vi.useRealTimers(); }
});

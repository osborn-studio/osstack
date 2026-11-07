import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostProcessStore } from '@osstack/core';
import { describe, expect, it, vi } from 'vitest';
import { H, T0, changesRequested, dispatched, setup } from './contained-mission-revision.testkit.js';
import { oid } from './contained-mission-bridge-shadow.testkit.js';
import { assertRevisionPublishable, createRevisionPublicationPort, compareRevisionRange, confirmRevisionPublication, publishRevision, publishRevisionCheck, readRevisionPr, reconcileReceipt, refuseRevisionPublication, type RevisionPublicationDeps, type RevisionRefusalCode } from './contained-mission-revision-publication.js';

const old = '1'.repeat(40);
const next = '2'.repeat(40);

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

async function fixture(options: { oldHead?: string; newHead?: string; intent?: boolean; expiresIn?: number; rounds?: 1 | 2 } = {}) {
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
  step('verified'); step('revalidating'); step('delivering');
  const chain = f.rig.chains.get(f.chain.chain_id);
  if (options.intent === false) return { f, id, mission: m, chain, journal: new HostProcessStore(f.rig.attention, f.rig.owner, { clock: () => ++f.clock.now }) };
  const intent = f.rig.chains.recordIntent(chain.chain_id, chain.revision, { kind: 'push', branch: chain.branch,
    expected_old_head: previousHead, new_head: candidateHead, expected_base_sha: chain.published_base, child_mission_id: id }, ++f.clock.now).intent;
  const journal = new HostProcessStore(f.rig.attention, f.rig.owner, { clock: () => ++f.clock.now });
  const opId = 'hp_publishrevision';
  journal.launching({ op_id: opId, mission_id: id, kind: 'git_push', remote_target: 'o/r#refs/heads/topic', local_target: '/tmp/repo#refs/heads/topic',
    intent_id: intent.intent_id, argv_digest: '5'.repeat(64), boot_id: 'test', marker: { path: '/tmp/marker', dev: '1', ino: '1' } });
  journal.registered(opId, { pid: 12345, pgid: 12345, leader_start: 'test' });
  journal.release(opId, () => {});
  journal.stopped(opId, { proof: 'group_empty+marker_unheld', detail: {}, exit_code: 0 });
  const deps: RevisionPublicationDeps = {
    chains: f.rig.chains, missions, host: { recordForIntent: intentId => intentId === intent.intent_id ? journal.get(opId) : undefined },
    runner: { gated: true, run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) }, now: () => ++f.clock.now,
    readPr: async () => ({ state: 'OPEN', repository: 'o/r', headRefName: 'topic', headRefOid: candidateHead, baseRefName: 'main', baseRefOid: 'a'.repeat(40), url: 'https://example.invalid/pull/7' }),
    localGit: async () => ({ stdout: '', exitCode: 0 }), remoteHead: async () => candidateHead, compare: async () => [candidateHead], preflight: async () => {}, checkEnabled: true,
    cancelChild: async () => {},
  };
  const input = { chain_id: chain.chain_id, intent_id: intent.intent_id, child_mission_id: id, permit_revision: m.revision,
    evidence: { evidence_digest: '6'.repeat(64), head: candidateHead, repository: 'o/r' }, pr: { number: 7, url: 'https://example.invalid/pull/7', reused: true as const }, range_sha256: '7'.repeat(64) };
  return { f, deps, input, id, intent };
}
async function fullFixture(options: { rounds?: 1 | 2 } = {}) {
  const result = await fixture(options);
  if (!result.deps || !result.input || !result.intent) throw Error('fixture_incomplete');
  return { ...result, deps: result.deps, input: result.input, intent: result.intent };
}

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

it('classifies a stopped auth failure with unchanged remote as failed push_rejected', async () => {
  let id = '';
  const f = await publishFixture(async (intentId, journal, fence) => {
    const opId = releasePush(journal, intentId, id, fence, true);
    return { stdout: '', stderr: 'HTTP 403: token revoked', exitCode: 128, opId };
  });
  id = f.id;
  await expect(f.call()).rejects.toThrow('CONTAINED_REVISION_REFUSED:push_rejected');
  expect(f.deps.chains.intents(f.chain.chain_id).at(-1)).toMatchObject({ state: 'failed', detail: 'push_rejected' });
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
    expect(reconcileReceipt(deps, input).state).toBe('pr_opened');
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
    reconcileReceipt(deps, input.intent_id, 'route_changed');
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

it.each(['success', 'success_three_commits', 'stale', 'lease_rejected', 'readback_mismatch', 'base_changed', 'pr_closed', 'base_changed_before_release'] as const)('%s: local lease push with W13 binding', async scenario => {
  const root = mkdtempSync(join(tmpdir(), 'revision-push-'));
  const repo = join(root, 'repo'); const bare = join(root, 'bare.git');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    execFileSync('git', ['init', '-q', '-b', 'topic', repo]);
    git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
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
      if (threeCommits) {
        const child = confirmRevisionPublication(deps, { chain_id: chain.chain_id, intent_id: result.intent_id, child_mission_id: id,
          permit_revision: permit.revision, evidence: { evidence_digest: '6'.repeat(64), head: candidate, repository: 'o/r' },
          pr: { ...result.pr, reused: true }, range_sha256: result.range_sha256 });
        expect(child.state).toBe('pr_opened');
        expect(deps.chains.getIntent(result.intent_id).state).toBe('confirmed');
        expect(deps.chains.get(chain.chain_id)).toMatchObject({ state: 'awaiting_review', published_head: candidate });
      }
    } else {
      await expect(call()).rejects.toThrow(scenario === 'stale' || scenario === 'readback_mismatch' ? 'READBACK_MISMATCH' : scenario === 'lease_rejected' ? 'push_rejected'
        : scenario === 'base_changed_before_release' ? 'base_changed' : 'PR_CHANGED_AFTER_PUSH');
      const intent = deps.chains.intents(chain.chain_id).filter(i => i.kind === 'push').at(-1)!;
      expect(intent.state).toBe(scenario === 'readback_mismatch' || scenario === 'stale' ? 'uncertain' : scenario === 'lease_rejected' || scenario === 'base_changed_before_release' ? 'failed' : 'confirmed');
      if (scenario === 'lease_rejected') expect(intent.detail).toBe('push_rejected');
      expect(deps.missions.get(id).state).toBe('awaiting_decision');
      if (scenario === 'base_changed' || scenario === 'pr_closed') expect(cancel).toHaveBeenCalledWith(id);
    }
    expect(remoteHead()).toBe(scenario === 'stale' ? third : scenario === 'lease_rejected' || scenario === 'base_changed_before_release' ? first : candidate);
    expect(pushes).toBe(scenario === 'base_changed_before_release' ? 0 : 1);
    expect(attempts).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

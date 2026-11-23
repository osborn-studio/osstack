import { createHash } from 'node:crypto';
import { ContainedMissionStore, HostProcessStore, RevisionChainStore } from '@osstack/core';
import { dispatchedRepair } from '@osstack/core/dist/state/local-failure-recheck.testkit.js';
import { describe, expect, it, vi } from 'vitest';
import { recoverBridgeLedgers, verifyBridgeLedger } from './contained-mission-bridge-ledger.js';

const start = '0'.repeat(40), prior = '1'.repeat(40), other = 'f'.repeat(40);
const intentId = 'vrp_00000000-0000-4000-8000-000000000001';
const chainEvent = 'local_repair_push_confirmed';
const approvalKind = 'verify_repair_approval', intentKind = 'verify_repair_push_intent', confirmedKind = 'verify_repair_push_confirmed';
const binding = (commits: string[]) => ({ commit_count: commits.length, range_sha256: createHash('sha256').update(JSON.stringify(commits)).digest('hex') });

function fixture(baselineCommits?: string[]) {
  const d = dispatchedRepair({ derive: (store, root, actor) => store.authorize(actor, {
    scope_id: root.scope_id, spec: { ...JSON.parse(root.spec_json), start_commit: start },
    claim: { repo_identity: 'ledger', branch: 'root', worktree_identity: 'root' },
  }, root.created_at) });
  const { db, attention, owner } = d.f;
  const chains = new RevisionChainStore(attention, owner), missions = new ContainedMissionStore(attention, owner);
  const c = d.chain(), child = d.dispatch.child_mission_id, now = d.f.facts.now;
  const intent = { ...d.payload, intent_id: intentId, pr: c.pr_number };
  const { candidate, previous, branch, base, pr } = intent;
  const approval = { candidate, old: previous, branch, base, pr, dispatch_id: d.dispatch.dispatch_id };
  const step = { old_head: previous, new_head: candidate, dispatch_id: d.dispatch.dispatch_id, child_mission_id: child };
  const commits = baselineCommits ?? [previous], tip = commits.at(-1)!;
  const baseline = chains.recordIntent(c.chain_id, c.revision, { kind: 'open_pr', branch, expected_old_head: start,
    expected_base_sha: base, new_head: tip, binding: binding(commits) }, now).intent;
  chains.appendEvent(c.chain_id, 'push_range', { intent_id: baseline.intent_id, commits }, now);
  chains.settleIntent(baseline.intent_id, 'confirmed', now);
  const record = (kind: string, data: unknown) => missions.record(child, kind, data, now);
  const prepare = () => { record(approvalKind, approval); record(intentKind, intent); };
  const proof = { ...intent, op_id: 'hp_repair' };
  const confirm = () => db.transaction(() => { record(confirmedKind, proof); d.confirm(); }).immediate();
  const host = (state: 'registered' | 'released' | 'stopped' = 'stopped', mission = child, kind: 'git_push' | 'gh_pr_create' = 'git_push') => {
    const journal = new HostProcessStore(attention, owner, { clock: () => now });
    journal.launching({ op_id: proof.op_id, mission_id: mission, kind, remote_target: c.repository + '#refs/heads/' + branch,
      local_target: '/isolated/repo', intent_id: intentId, argv_digest: 'a'.repeat(64), boot_id: 'fixture',
      marker: { path: '/isolated/marker', dev: '1', ino: '1' } });
    journal.registered(proof.op_id, { pid: 12345, pgid: 12345, leader_start: 'fixture' });
    if (state !== 'registered') journal.release(proof.op_id, () => {});
    if (state === 'stopped') journal.stopped(proof.op_id, { proof: 'group_empty+marker_unheld', detail: {} });
  };
  const moveHead = (head: string) => db.prepare('UPDATE engineering_revision_chains SET published_head=?,revision=revision+1 WHERE chain_id=?').run(head, c.chain_id);
  const revision = (old: string, head: string) => {
    // Replay a settled revision receipt without starting a second child and obtaining its dispatched reservation.
    db.exec('DROP TRIGGER engineering_intent_push_binding');
    db.prepare(`INSERT INTO engineering_publication_intents(intent_id,chain_id,kind,repository,pr_number,branch,
      expected_old_head,new_head,expected_base_sha,binding_json,state,created_at,updated_at)
      VALUES('pi_revision',?,'push',?,?,?,?,?,?,?,'pending',?,?)`).run(c.chain_id, c.repository, pr, branch, old, head, base, JSON.stringify(binding([head])), now, now);
    chains.appendEvent(c.chain_id, 'push_range', { intent_id: 'pi_revision', commits: [head] }, now);
    chains.settleIntent('pi_revision', 'confirmed', now);
    moveHead(head);
  };
  // Reproduce a snapshot that confirmLocalRepairPush would refuse or would update atomically.
  const replay = (data: unknown = step) => chains.appendEvent(c.chain_id, chainEvent, data, now);
  const remoteHead = vi.fn(async () => candidate), compare = vi.fn(async () => [...commits, candidate]);
  const deps = { chains, missions, remoteHead, compare, now: () => now, cancelChild: vi.fn(async () => {}) };
  const signal = new AbortController().signal;
  const verify = () => verifyBridgeLedger(deps, d.chain(), signal);
  return { ...d, db, c, child, candidate, previous, tip, proof, intent, approval, step, confirm, record, prepare, host,
    revision, replay, moveHead, verify, deps, signal, remoteHead, compare };
}

describe('confirmed local repair coverage', () => {
  it('requires exactly the repair commit after the baseline and the exact remote tip', async () => {
    const f = fixture(); f.prepare(); f.host(); f.confirm();
    expect(await f.verify()).toBe('matched');
    f.compare.mockResolvedValueOnce([f.previous, other, f.candidate]);
    expect(await f.verify()).toBe('external_write');
    f.compare.mockResolvedValueOnce([f.previous, other]); expect(await f.verify()).toBe('external_write');
    f.remoteHead.mockResolvedValueOnce(other); expect(await f.verify()).toBe('external_write');
  });
  it('walks a revision push after a repair', async () => {
    const f = fixture(); f.prepare(); f.host(); f.confirm(); f.revision(f.candidate, other);
    f.compare.mockResolvedValue([f.tip, f.candidate, other]); f.remoteHead.mockResolvedValue(other);
    expect(await f.verify()).toBe('matched');
  });
  it('walks a repair after a revision push', async () => {
    const f = fixture([prior]); f.revision(prior, f.previous); f.prepare(); f.host(); f.confirm();
    f.compare.mockResolvedValue([prior, f.previous, f.candidate]);
    expect(await f.verify()).toBe('matched');
  });
  it.each(['gap', 'earlier head', 'fork', 'published head behind'])('rejects a disconnected history: %s', async scenario => {
    const f = fixture(scenario === 'gap' ? [prior] : scenario === 'earlier head' ? ['a'.repeat(40), other] : undefined);
    f.prepare(); f.host(); f.confirm();
    if (scenario === 'fork') f.revision(f.previous, other);
    if (scenario === 'published head behind') f.moveHead(f.previous);
    expect(await f.verify()).toBe('external_write'); expect(f.compare).not.toHaveBeenCalled();
  });
  it.each(['identical', 'different'])('rejects a second chain event: %s', async scenario => {
    const f = fixture(); f.prepare(); f.host(); f.confirm(); f.replay(scenario === 'identical' ? f.step : { ...f.step, new_head: other });
    expect(await f.verify()).toBe('external_write');
  });
  it.each(['missing dispatch', 'other chain', 'different child', 'extra key', 'invalid SHA', 'same head'])('rejects chain event: %s', async scenario => {
    const f = fixture(); f.prepare(); f.host(); f.record(confirmedKind, f.proof);
    const step = { ...f.step };
    if (scenario === 'missing dispatch') step.dispatch_id += '_absent';
    if (scenario === 'other chain') {
      const shadow = f.deps.chains.createShadowChain(f.c, f.deps.now());
      // The dispatch_no_update trigger binds the dispatch to its original live chain.
      f.db.exec('DROP TRIGGER engineering_local_failure_dispatch_no_update');
      f.db.prepare('UPDATE engineering_local_failure_dispatches SET chain_id=? WHERE dispatch_id=?').run(shadow.chain_id, step.dispatch_id);
    }
    if (scenario === 'different child') step.child_mission_id = f.c.root_mission_id;
    if (scenario === 'invalid SHA') step.old_head = 'bad';
    if (scenario === 'same head') step.old_head = step.new_head;
    f.replay(scenario === 'extra key' ? { ...step, extra: true } : step); f.moveHead(f.candidate);
    expect(await f.verify()).toBe('external_write');
  });
  it.each(['missing approval', 'wrong approval', 'late approval', 'duplicate approval', 'duplicate intent', 'missing confirmation',
    'candidate', 'branch', 'base', 'pr', 'early confirmation', 'conflicting confirmations', 'broken JSON'])('rejects child evidence: %s', async scenario => {
    const f = fixture(); f.host();
    if (scenario === 'early confirmation') f.record(confirmedKind, f.proof);
    if (!['missing approval', 'late approval'].includes(scenario)) f.record(approvalKind, scenario === 'wrong approval' ? { ...f.approval, candidate: other } : f.approval);
    f.record(intentKind, f.intent);
    if (['late approval', 'duplicate approval'].includes(scenario)) f.record(approvalKind, f.approval);
    if (scenario === 'duplicate intent') f.record(intentKind, f.intent);
    if (!['early confirmation', 'missing confirmation'].includes(scenario)) {
      f.record(confirmedKind, ['candidate', 'branch', 'base', 'pr'].includes(scenario) ? { ...f.proof, [scenario]: scenario === 'pr' ? 8 : other } : f.proof);
    }
    if (scenario === 'conflicting confirmations') f.record(confirmedKind, { ...f.proof, op_id: 'hp_other' });
    if (scenario === 'broken JSON') {
      // The Mission store serializes payloads and contained_events_append_only prevents later damage.
      f.db.exec('DROP TRIGGER engineering_contained_events_append_only');
      f.db.prepare('UPDATE engineering_contained_events SET payload_json=? WHERE mission_id=? AND kind=?').run('{', f.child, approvalKind);
    }
    f.replay(); f.moveHead(f.candidate);
    expect(await f.verify()).toBe('external_write');
  });
  it.each(['missing', 'never released', 'other mission', 'wrong kind', 'running'])('rejects host evidence: %s', async scenario => {
    const f = fixture(); f.prepare(); f.confirm();
    if (scenario !== 'missing') f.host(scenario === 'running' ? 'released' : scenario === 'never released' ? 'registered' : 'stopped',
      scenario === 'other mission' ? f.c.root_mission_id : f.child, scenario === 'wrong kind' ? 'gh_pr_create' : 'git_push');
    expect(await f.verify()).toBe('external_write');
  });
});

describe('released local repair before confirmation', () => {
  it('defers only at the candidate and recovers before the publisher confirms', async () => {
    const f = fixture(); f.prepare(); f.host(); const before = f.chain();
    f.compare.mockResolvedValue([f.tip]);
    f.remoteHead.mockResolvedValueOnce(f.previous); expect(await f.verify()).toBe('matched');
    f.remoteHead.mockResolvedValueOnce(other); expect(await f.verify()).toBe('external_write');
    expect(await f.verify()).toBe('reconciliation_incomplete');
    await recoverBridgeLedgers(f.deps, f.signal);
    expect(f.deps.cancelChild).not.toHaveBeenCalled(); expect(f.chain()).toEqual(before);
    f.confirm(); f.compare.mockResolvedValue([f.tip, f.candidate]); expect(await f.verify()).toBe('matched');
  });
  it.each(['never released', 'previous', 'branch', 'base', 'pr', 'intent_id', 'missing approval', 'wrong approval'])('requires released, bound evidence: %s', async scenario => {
    const f = fixture(); f.host(scenario === 'never released' ? 'registered' : 'released');
    if (scenario !== 'missing approval') f.record(approvalKind, scenario === 'wrong approval' ? { ...f.approval, candidate: other } : f.approval);
    f.record(intentKind, ['previous', 'branch', 'base', 'pr', 'intent_id'].includes(scenario) ? { ...f.intent, [scenario]: scenario === 'pr' ? '7' : other } : f.intent);
    expect(await f.verify()).toBe('external_write'); expect(f.remoteHead).toHaveBeenCalledOnce();
  });
  it('reports an external write when only the child has a confirmation', async () => {
    const f = fixture();
    f.prepare();
    f.host('released');
    f.record(confirmedKind, f.proof);
    expect(await f.verify()).toBe('external_write');
  });
  it('defers a released process that is still running', async () => {
    const f = fixture(); f.prepare(); f.host('released'); expect(await f.verify()).toBe('reconciliation_incomplete');
    expect(f.remoteHead).toHaveBeenCalledOnce();
  });
  it('returns stale when confirmation lands during the remote head read', async () => {
    const f = fixture(); f.prepare(); f.host();
    f.remoteHead.mockImplementationOnce(async () => { f.confirm(); return f.candidate; });
    expect(await f.verify()).toBe('stale');
  });
  it('returns stale when confirmation lands during compare', async () => {
    const f = fixture(); f.prepare(); f.host(); f.remoteHead.mockResolvedValue(f.previous);
    f.compare.mockImplementationOnce(async () => { f.confirm(); return [f.tip]; });
    expect(await f.verify()).toBe('stale');
  });
  it('fingerprints a chain event even without a revision change', async () => {
    const f = fixture(); f.prepare(); f.host(); f.confirm();
    f.compare.mockImplementationOnce(async () => { f.replay(); return [f.tip, f.candidate]; });
    expect(await f.verify()).toBe('stale');
  });
});

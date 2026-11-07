import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS_TOTAL_CAP, STATUS_EVENTS, chainEventsView, safeEventPayload } from './bridge-chain-events.js';
import { createRig, oid, type Rig } from './contained-mission-bridge-shadow.testkit.js';

const rigs: Rig[] = [];
afterEach(() => { rigs.splice(0).forEach((r) => { r.close(); }); });
function chainRig() {
  const rig = createRig(); rigs.push(rig);
  const root = rig.seedMission({ pr_number: 1, head: oid('1'), base_head: oid('a') });
  const chain = rig.chains.createShadowChain({ root_mission_id: root, repository: 'o/r', pr_number: 1, branch: 'osstack/mission/x', base_ref: 'main', published_head: oid('1'), published_base: oid('a'), trace_id: 'tr' }, 10);
  return { rig, chain };
}

describe('safeEventPayload', () => {
  it('keeps codes, object ids and counts and drops everything else', () => {
    const p = safeEventPayload('observation_cycle', JSON.stringify({
      observed_at: 5, pr_state: 'OPEN', head: oid('1'), base: oid('a'), reviews: 2, decision: 'none', reason: 'no_news',
      body: 'SECRET-BODY', login: 'alice', url: 'https://x.invalid/?token=t', discards: ['9:unregistered_reviewer', 'evil text', '8:head_mismatch'],
    }));
    expect(p).toEqual({ observed_at: 5, pr_state: 'OPEN', head: oid('1'), base: oid('a'), reviews: 2, decision: 'none', reason: 'no_news',
      discards: [{ review_id: 9, reason: 'unregistered_reviewer' }, { review_id: 8, reason: 'head_mismatch' }] });
    expect(JSON.stringify(p)).not.toMatch(/SECRET|alice|token|evil/u);
  });
  it('rejects values of the wrong shape, unknown kinds and broken JSON', () => {
    expect(safeEventPayload('read_failed', JSON.stringify({ code: 'Bearer abc def' }))).toEqual({});
    expect(safeEventPayload('read_failed', JSON.stringify({ code: 'ghp_secret123', extra: 'x' }))).toEqual({});
    expect(safeEventPayload('read_failed', JSON.stringify({ code: 'page_cap', extra: 'x' }))).toEqual({ code: 'page_cap' });
    expect(safeEventPayload('observation_cycle', JSON.stringify({ pr_state: 'alice', decision: 'alice', action: 'bob', to: 'carol' }))).toEqual({});
    expect(safeEventPayload('transition', JSON.stringify({ head: 'zzz', from: 'a/b' }))).toEqual({});
    expect(safeEventPayload('mystery', JSON.stringify({ code: 'x' }))).toEqual({});
    expect(safeEventPayload('read_failed', '{broken')).toEqual({});
    expect(safeEventPayload('read_failed', '[1]')).toEqual({});
  });
  it('caps discards and review ids', () => {
    const many = Array.from({ length: 50 }, (_, i) => `${i}:head_mismatch`);
    const p = safeEventPayload('observation_cycle', JSON.stringify({ discards: many, review_ids: Array.from({ length: 50 }, (_, i) => i) }));
    expect((p['discards'] as unknown[]).length).toBe(10);
    expect((p['review_ids'] as unknown[]).length).toBe(10);
  });
});

describe('chainEventsView', () => {
  it('reports the chain_created event of a new chain and nothing else', () => {
    const { rig, chain } = chainRig();
    const v = chainEventsView(rig.db, chain.chain_id);
    expect(v.total).toBe(1);
    expect(v.latest.map((e) => e.kind)).toEqual(['chain_created']);
    expect(v.latest[0]!.payload).toEqual({ pr_number: 1, head: oid('1'), base: oid('a') });
  });
  it('is empty for an unknown chain', () => {
    const { rig } = chainRig();
    expect(chainEventsView(rig.db, 'rc_missing')).toEqual({ total: 0, total_capped: false, latest: [] });
  });
  it('returns only the latest N, oldest first, however many events exist', () => {
    const { rig, chain } = chainRig();
    for (let i = 0; i < 300; i += 1) rig.chains.appendEvent(chain.chain_id, i % 2 ? 'read_failed' : 'observation_cycle', i % 2 ? { code: 'page_cap' } : { decision: 'none', body: 'x'.repeat(2000) }, 100 + i);
    const v = chainEventsView(rig.db, chain.chain_id);
    expect(v.total).toBe(301);
    expect(v.total_capped).toBe(false);
    expect(v.latest).toHaveLength(STATUS_EVENTS);
    expect(v.latest.map((e) => e.created_at)).toEqual(Array.from({ length: 10 }, (_, i) => 390 + i));
    expect(JSON.stringify(v).length).toBeLessThan(4000);
    expect(JSON.stringify(v)).not.toContain('xxxx');
  });
  it('caps the total count', () => {
    const { rig, chain } = chainRig();
    const ins = rig.db.prepare('INSERT INTO engineering_revision_chain_events(chain_id,kind,payload_json,created_at) VALUES(?,?,?,?)');
    rig.db.transaction(() => { for (let i = 0; i < EVENTS_TOTAL_CAP + 5; i += 1) ins.run(chain.chain_id, 'read_failed', '{}', i); })();
    const v = chainEventsView(rig.db, chain.chain_id);
    expect(v).toMatchObject({ total: EVENTS_TOTAL_CAP, total_capped: true });
    expect(v.latest).toHaveLength(STATUS_EVENTS);
  });
  it('does not write', () => {
    const { rig, chain } = chainRig();
    const before = rig.db.prepare('SELECT COUNT(*) AS n FROM engineering_revision_chain_events').get();
    chainEventsView(rig.db, chain.chain_id);
    expect(rig.db.prepare('SELECT COUNT(*) AS n FROM engineering_revision_chain_events').get()).toEqual(before);
  });
});

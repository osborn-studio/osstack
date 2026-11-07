import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { BRIDGE_EVENT_SCAN_CAP, BRIDGE_WINDOW_MS, computeBridgeStats } from './bridge-stats.js';
import { createRig, oid, type Rig } from './contained-mission-bridge-shadow.testkit.js';

const rigs: Rig[] = [];
afterEach(() => { rigs.splice(0).forEach((r) => { r.close(); }); });
const NOW = 2_000_000_000_000;
function setup() { const rig = createRig(); rigs.push(rig); return rig; }
let pr = 0;
function chain(rig: Rig, created = NOW - 1000) {
  pr += 1;
  const root = rig.seedMission({ pr_number: pr, head: oid('1'), base_head: oid('a') });
  return rig.chains.createShadowChain({ root_mission_id: root, repository: 'o/r', pr_number: pr, branch: `osstack/mission/b${pr}`, base_ref: 'main', published_head: oid('1'), published_base: oid('a'), trace_id: 'tr' }, created);
}

describe('computeBridgeStats', () => {
  it('is all zero or empty on migrated tables without bridge activity', () => {
    const rig = setup();
    const s = computeBridgeStats(rig.db, NOW);
    expect(s.available).toBe(true);
    expect(s.chains).toEqual({ total: 0, by_mode_state: [], awaiting_decision_by_reason: [], open_past_deadline: 0, rounds_over_grant: 0 });
    expect(s.shadow_decisions).toEqual({ total_by_action: [], window_by_action: [] });
    expect(s.reconciliation).toMatchObject({ window_observation_cycles: 0, window_read_failed: 0, window_read_failed_ratio: null, read_failed_by_code: [], last_event_at_ms: null, window_truncated: false });
    expect(s.live).toEqual({ reservations_by_state: [], intents_by_kind_state: [] });
  });

  it('reports unavailable, not an error, on a database without the chain tables', () => {
    const db = new Database(':memory:');
    try {
      const s = computeBridgeStats(db, NOW);
      expect(s.available).toBe(false);
      expect(Object.keys(s.deferred).length).toBeGreaterThan(0);
    } finally { db.close(); }
  });

  it('counts chains by mode and state, stop reasons, decisions, read failures and window membership', () => {
    const rig = setup();
    const a = chain(rig); const b = chain(rig); chain(rig);
    // b stops for a human with a reason; a records a would_reserve inside the window and one outside.
    rig.chains.applyDecision(b.chain_id, 1, { kind: 'stop', to: 'awaiting_decision', reason: 'attribution_unknown', from_head: oid('1'), from_base: oid('a'), head: oid('2'), base: oid('a'), discards: [], review_ids: [], shadow_action: 'would_stop' }, NOW - 500);
    rig.db.prepare("INSERT INTO engineering_shadow_decisions(chain_id,head_sha,base_sha,action,reason,review_ids_json,observed_at,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(a.chain_id, oid('3'), oid('a'), 'would_reserve', 'changes_requested', '[1]', NOW - 10, NOW - 10);
    rig.db.prepare("INSERT INTO engineering_shadow_decisions(chain_id,head_sha,base_sha,action,reason,review_ids_json,observed_at,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(a.chain_id, oid('4'), oid('a'), 'would_reserve', 'changes_requested', '[2]', NOW - BRIDGE_WINDOW_MS - 5, NOW - BRIDGE_WINDOW_MS - 5);
    rig.chains.appendEvent(a.chain_id, 'observation_cycle', { observed_at: NOW - 100, decision: 'none' }, NOW - 100);
    rig.chains.appendEvent(a.chain_id, 'observation_cycle', { observed_at: NOW - 90, decision: 'none' }, NOW - 90);
    // A would_reserve cycle writes a second, observed_at-less event from the store; it must not count as another cycle.
    rig.chains.appendEvent(a.chain_id, 'observation_cycle', { action: 'would_reserve', head: oid('3') }, NOW - 95);
    rig.chains.appendEvent(a.chain_id, 'read_failed', { code: 'page_cap' }, NOW - 80);
    rig.chains.appendEvent(a.chain_id, 'read_failed', { code: 'page_cap' }, NOW - 70);
    rig.chains.appendEvent(a.chain_id, 'read_failed', { code: 'page_cap' }, NOW - BRIDGE_WINDOW_MS - 1);

    const s = computeBridgeStats(rig.db, NOW);
    expect(s.chains.total).toBe(3);
    expect(s.chains.by_mode_state).toEqual([{ mode: 'shadow', state: 'awaiting_decision', count: 1 }, { mode: 'shadow', state: 'awaiting_review', count: 2 }]);
    expect(s.chains.awaiting_decision_by_reason).toEqual([{ mode: 'shadow', reason: 'attribution_unknown', count: 1 }]);
    expect(s.shadow_decisions.total_by_action).toEqual([{ action: 'would_reserve', count: 2 }, { action: 'would_stop', count: 1 }]);
    expect(s.shadow_decisions.window_by_action).toEqual([{ action: 'would_reserve', count: 1 }, { action: 'would_stop', count: 1 }]);
    expect(s.reconciliation.window_observation_cycles).toBe(2);
    expect(s.reconciliation.window_read_failed).toBe(2);
    expect(s.reconciliation.window_read_failed_ratio).toBe(0.5);
    expect(s.reconciliation.read_failed_by_code).toEqual([{ code: 'page_cap', count: 2 }]);
    expect(s.reconciliation.last_event_at_ms).toBe(NOW - 70);
    expect(s.chains.rounds_over_grant).toBe(0);
  });

  it('lists the metrics it cannot compute as null with a reason', () => {
    const s = computeBridgeStats(setup().db, NOW);
    for (const k of ['cycle_duration_ms', 'revision_round_duration_ms', 'changes_requested_to_push_median_ms', 'first_round_pass_rate', 'ledger_branch_mismatch_after_reconcile']) {
      expect(s.deferred[k]).toEqual({ value: null, reason: expect.stringMatching(/^(needs_phase_5|not_recorded)/u) });
    }
  });

  it('keeps output bounded with many events and many odd codes, and never echoes free text', () => {
    const rig = setup();
    const c = chain(rig);
    const ins = rig.db.prepare('INSERT INTO engineering_revision_chain_events(chain_id,kind,payload_json,created_at) VALUES(?,?,?,?)');
    rig.db.transaction(() => {
      for (let i = 0; i < BRIDGE_EVENT_SCAN_CAP + 500; i += 1) {
        if (i % 3 === 0) ins.run(c.chain_id, 'observation_cycle', '{}', NOW - 1000 + (i % 900));
        else ins.run(c.chain_id, 'read_failed', JSON.stringify({ code: i % 7 === 0 ? `Bearer ghp_SECRET${i}` : i % 5 === 0 ? `alice${i}` : 'page_cap' }), NOW - 1000 + (i % 900));
      }
    })();
    const s = computeBridgeStats(rig.db, NOW);
    expect(s.reconciliation.window_truncated).toBe(true);
    expect(s.reconciliation.window_observation_cycles + s.reconciliation.window_read_failed).toBeLessThanOrEqual(BRIDGE_EVENT_SCAN_CAP);
    expect(s.reconciliation.read_failed_by_code.length).toBeLessThanOrEqual(50);
    const text = JSON.stringify(s);
    expect(text).not.toMatch(/SECRET|ghp_|Bearer|alice/u);
    expect(s.reconciliation.read_failed_by_code.some((r) => r.code === 'other')).toBe(true);
    expect(s.reconciliation.read_failed_by_code.map((r) => r.code).sort()).toEqual(['other', 'page_cap']);
    expect(text.length).toBeLessThan(8000);
  });

  it('does not let unknown codes crowd known ones out of the group cap, and truncates only when excluded rows are in the window', () => {
    const rig = setup();
    const c = chain(rig);
    const ins = rig.db.prepare('INSERT INTO engineering_revision_chain_events(chain_id,kind,payload_json,created_at) VALUES(?,?,?,?)');
    rig.db.transaction(() => {
      for (let i = 0; i < 60; i += 1) for (let j = 0; j < 2; j += 1) ins.run(c.chain_id, 'read_failed', JSON.stringify({ code: `unknown${i}` }), NOW - 10);
      ins.run(c.chain_id, 'read_failed', '{"code":"page_cap"}', NOW - 10);
    })();
    const r = computeBridgeStats(rig.db, NOW).reconciliation;
    expect(r.read_failed_by_code).toEqual([{ code: 'other', count: 120 }, { code: 'page_cap', count: 1 }]);
    expect(r.window_read_failed).toBe(121);
    // One expired row followed by exactly the cap of current rows: nothing in the window was left out.
    const rig2 = setup();
    const c2 = chain(rig2);
    const ins2 = rig2.db.prepare('INSERT INTO engineering_revision_chain_events(chain_id,kind,payload_json,created_at) VALUES(?,?,?,?)');
    rig2.db.transaction(() => { for (let i = 0; i < BRIDGE_EVENT_SCAN_CAP; i += 1) ins2.run(c2.chain_id, 'read_failed', '{"code":"page_cap"}', NOW - 10); })();
    // chain_created (seq 1) is outside the scan; it is older than the window.
    expect(rig2.db.prepare('SELECT created_at FROM engineering_revision_chain_events WHERE seq=1').get()).toEqual({ created_at: NOW - 1000 });
    expect(computeBridgeStats(rig2.db, NOW, 500).reconciliation).toMatchObject({ window_read_failed: BRIDGE_EVENT_SCAN_CAP, window_truncated: false });
    // With a window that reaches back to the excluded row, the cut is reported.
    expect(computeBridgeStats(rig2.db, NOW, 5000).reconciliation.window_truncated).toBe(true);
  });

  it('works on a read-only connection and writes nothing', () => {
    const rig = setup();
    const c = chain(rig);
    rig.chains.appendEvent(c.chain_id, 'read_failed', { code: 'page_cap' }, NOW - 5);
    rig.db.pragma('wal_checkpoint(TRUNCATE)');
    const ro = new Database(rig.path, { readonly: true });
    try {
      const s = computeBridgeStats(ro, NOW);
      expect(s.chains.total).toBe(1);
      expect(s.reconciliation.window_read_failed).toBe(1);
    } finally { ro.close(); }
  });

  it('counts live reservations and intents without touching shadow data', () => {
    const rig = setup();
    chain(rig);
    expect(computeBridgeStats(rig.db, NOW).live).toEqual({ reservations_by_state: [], intents_by_kind_state: [] });
  });
});

import Database from 'better-sqlite3';
import { computeCiChainStats } from './contained-mission-ci-chain-read.js';
import { describe, expect, it } from 'vitest';
import { createRig, oid } from './contained-mission-bridge-shadow.testkit.js';
import { createCiScanHealth, readCiScanHealth, shouldRecordCiScanFailure } from './contained-mission-ci-scan-health.js';

const facts = { reason: 'network' as const, step: 'pr_read' as const, pr: 7, head: oid('a') };
function fixture() {
  const rig = createRig();
  const id = rig.seedMission({ pr_number: 7, head: facts.head, base_head: oid('b') });
  let clock = 5000;
  const health = () => createCiScanHealth(rig.missions, () => clock++);
  const events = () => (rig.db.prepare("SELECT kind,payload_json FROM engineering_contained_events WHERE mission_id=? AND kind IN ('ci_scan_failed','ci_scan_recovered') ORDER BY seq")
    .all(id) as { kind: string; payload_json: string }[]).map(e => ({ kind: e.kind, payload: JSON.parse(e.payload_json) }));
  return { rig, id, health, events };
}
describe('CI scan health ledger', () => {
  it('has no failing scans without the Mission table', () => {
    const db = new Database(':memory:');
    try { expect(computeCiChainStats(db)).toMatchObject({ ci_chain_scan_failing: 0, ci_chain_scan_failing_by_reason: [] }); }
    finally { db.close(); }
  });
  it('compares categories against the last recorded failure', () => {
    const previous = { reason: 'network' as const, step: 'pr_read' as const };
    expect(shouldRecordCiScanFailure(previous, { ...previous, consecutive: 3 })).toBe(false);
    expect(shouldRecordCiScanFailure(previous, { ...previous, consecutive: 4 })).toBe(true);
    expect(shouldRecordCiScanFailure(previous, { ...previous, reason: 'auth', consecutive: 3 })).toBe(true);
    expect(shouldRecordCiScanFailure(previous, { ...previous, step: 'scan', consecutive: 3 })).toBe(true);
  });
  it.each([20, 200])('throttles %i ticks and recovers with the true count', ticks => {
    const f = fixture();
    try {
      const health = f.health();
      health.succeeded(f.id, facts);
      for (let i = 0; i < ticks; i++) health.failed(f.id, facts);
      expect(f.events().map(e => e.payload.consecutive)).toEqual(ticks === 20 ? [1,2,4,8,16] : [1,2,4,8,16,32,64,120]);
      expect(readCiScanHealth(f.rig.db, f.id)).toMatchObject({ failing: true, since: 5000, reason: 'network' });
      health.succeeded(f.id, facts);
      health.succeeded(f.id, facts);
      expect(f.events().at(-1)).toEqual({ kind: 'ci_scan_recovered', payload: { failed_since: 5000, consecutive: ticks, pr: 7, head: facts.head } });
      expect(readCiScanHealth(f.rig.db, f.id)).toBeNull();
      for (const { kind, payload } of f.events()) {
        expect(Object.keys(payload).sort()).toEqual((kind === 'ci_scan_failed'
          ? ['reason','step','consecutive','since','pr','head'] : ['failed_since','consecutive','pr','head']).sort());
        if (kind === 'ci_scan_failed') {
          expect(['network','auth','rate_limited','incomplete_read','unexpected_response']).toContain(payload.reason);
          expect(['pr_read','held_push_ref_read','ci_jobs_read','merge_readback','scan']).toContain(payload.step);
        }
        expect(JSON.stringify(payload)).not.toMatch(/\/|http|token|gh[pousr]_|Bearer/);
      }
    } finally { f.rig.close(); }
  });
  it.each([{ reason: 'auth' as const }, { step: 'ci_jobs_read' as const }])('records a changed category without resetting the streak: %j', change => {
    const f = fixture();
    try {
      const h = f.health();
      for (let i = 1; i <= 20; i++) h.failed(f.id, { ...facts, ...(i >= 6 ? change : {}) });
      expect(f.events().map(e => e.payload.consecutive)).toEqual([1,2,4,6,8,16]);
      expect(f.events().every(e => e.payload.since === 5000)).toBe(true);
    } finally { f.rig.close(); }
  });
  it('resumes from the last recorded lower bound after restart', () => {
    const f = fixture();
    try {
      const first = f.health();
      for (let i = 0; i < 20; i++) first.failed(f.id, facts);
      const restarted = f.health();
      restarted.failed(f.id, facts);
      expect(f.events()).toHaveLength(5);
      restarted.succeeded(f.id, facts);
      expect(f.events().at(-1)?.payload).toMatchObject({ failed_since: 5000, consecutive: 17 });
    } finally { f.rig.close(); }
  });
  it('rejects malformed latest payloads', () => {
    const f = fixture();
    try {
      f.rig.missions.record(f.id, 'ci_scan_failed', { reason: 'arbitrary' }, 6000);
      expect(readCiScanHealth(f.rig.db, f.id)).toBeNull();
    } finally { f.rig.close(); }
  });
});

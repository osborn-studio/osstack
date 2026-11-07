import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MergerShadowStore } from '@osstack/core';
import { REPORT_CATEGORIES, buildMergerReport, type ReportDb } from './contained-mission-merger-report.js';
import { BASE, HEAD, MIN, REPO, T0, createRigged, ledgerDump, seedMergerMission, type Rigged } from './contained-mission-merger-shadow.testkit.js';

const open: Rigged[] = [];
afterEach(() => { open.splice(0).forEach((r) => { r.close(); }); });
const OTHER = 'b'.repeat(40);
const DAY = 86_400_000;

/** Writes shadow rows straight through the store, the way a reconciler would, at a chosen local time. */
class Script {
  readonly rigged: Rigged; private readonly store: MergerShadowStore; private readonly mission: string;
  constructor(r: Rigged, readonly pr: number, private t: number) {
    this.rigged = r; this.store = r.store;
    this.mission = seedMergerMission(r.rig, pr, `osstack/mission/p${pr}`).missionId;
  }
  /** One scan at the current time: a decision (or none) and a cycle row listing it. */
  scan(verdict: 'would_merge' | 'refused' | 'unevaluated' | null, head = HEAD, listed = true): this {
    const seq = this.store.beginObservation(REPO, this.pr, this.t);
    const entries: Array<[string, number, number, string, 'would_merge' | 'refused' | 'unevaluated']> = [];
    if (verdict) {
      this.store.recordDecision({
        repository: REPO, pr_number: this.pr, mission_id: this.mission, head_sha: head, base_sha: BASE, verdict,
        codes: verdict === 'would_merge' ? [] : verdict === 'refused' ? ['G6.approval_stale_head'] : ['U.read_failed:graphql_request'],
        gates: { second_read: false, start_is_base: false }, merge_request: verdict === 'would_merge' ? { sha: head, merge_method: 'squash' } : null, evidence_digest: 'e'.repeat(64), observed_at: this.t,
      }, seq, this.t);
      if (listed) entries.push([REPO, this.pr, seq, head, verdict]);
    }
    this.store.recordCycle(this.t, this.t + 1000, entries, this.t + 1000);
    this.t += 5 * MIN;
    return this;
  }
  /** An outcome observed in its own scan (the cycle row is written after it, as the reconciler does). */
  outcome(outcome: 'merged' | 'closed_unmerged' | 'observation_expired' | 'reopened', over: { head?: string; published?: string; reopenUnobserved?: boolean; by?: [number, 'User' | 'Bot'] } = {}): this {
    const seq = this.store.beginObservation(REPO, this.pr, this.t);
    const cycleAfter = (this.rigged.rig.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM engineering_merger_shadow_cycles').get() as { n: number }).n;
    const m = outcome === 'merged';
    this.store.recordOutcome({
      repository: REPO, pr_number: this.pr, mission_id: this.mission, outcome, head_at_close: over.head ?? HEAD, observed_at: this.t,
      ...(m ? { merged_at: new Date(this.t + 1000).toISOString(), merge_commit: 'f'.repeat(40), merged_by_actor_id: over.by?.[0] ?? 269, merged_by_type: over.by?.[1] ?? 'User', owner_approved_head: null } : {}),
      facts: { published_head: over.published ?? HEAD, cycle_after: cycleAfter, ...(m ? { merged_by_class: 'owner' } : {}), ...(over.reopenUnobserved ? { reopen_unobserved: true } : {}) },
    }, seq, this.t + 500);
    this.store.recordCycle(this.t, this.t + 1000, [], this.t + 1000);
    this.t += 5 * MIN;
    return this;
  }
  skip(minutes: number): this { this.t += minutes * MIN; return this; }
}

function report() {
  const r = createRigged();
  open.push(r);
  const at = (k: number, pr: number) => new Script(r, pr, T0 + k * DAY);
  return { r, at, run: () => buildMergerReport(r.rig.db, T0) };
}
const category = (rep: ReturnType<typeof buildMergerReport>, pr: number) => rep.prs.find((p) => p.pr_number === pr)?.category;

describe('comparison report categories (design §4.3)', () => {
  it('classifies one PR per category, in the order of the table', () => {
    const { at, run } = report();
    at(1, 1).scan('would_merge').outcome('merged', { head: OTHER });                                              // merged_other_head
    at(2, 2).outcome('merged');                                                                                    // merged_unobserved (no cycles before)
    at(3, 3).scan('would_merge').scan('would_merge').scan('would_merge').outcome('merged');                        // agree_merge
    at(4, 4).scan('would_merge').scan('refused').scan('refused').outcome('merged');                                // merged_while_refused (ever_would_merge)
    at(5, 5).scan('refused').scan('refused').scan('unevaluated').outcome('merged');                                // merged_unevaluated
    at(6, 6).scan('refused').outcome('closed_unmerged').skip(0).outcome('observation_expired');                    // closed_expired
    at(7, 7).skip(0).outcome('closed_unmerged');                                                                   // closed_unobserved (no decision)
    at(8, 8).scan('would_merge').outcome('closed_unmerged');                                                       // would_merge_closed
    at(9, 9).scan('unevaluated').outcome('closed_unmerged');                                                       // closed_unevaluated
    at(10, 10).scan('refused').outcome('closed_unmerged');                                                         // agree_no_merge
    at(11, 11).scan('refused');                                                                                    // open
    at(12, 12).scan('refused').outcome('closed_unmerged').outcome('reopened');                                     // open (reopened)
    const rep = run();
    expect(Object.fromEntries(rep.prs.map((p) => [p.pr_number, p.category]))).toEqual({
      1: 'merged_other_head', 2: 'merged_unobserved', 3: 'agree_merge', 4: 'merged_while_refused', 5: 'merged_unevaluated', 6: 'closed_expired',
      7: 'closed_unobserved', 8: 'would_merge_closed', 9: 'closed_unevaluated', 10: 'agree_no_merge',
    });
    expect(rep.open.map((o) => [o.pr_number, o.reopened])).toEqual([[11, false], [12, true]]);
    expect(rep.counts).toEqual({ ...Object.fromEntries(REPORT_CATEGORIES.map((c) => [c, 1])), open: 2 });
    expect(rep.prs.find((p) => p.pr_number === 4)).toMatchObject({ ever_would_merge: true, last_decision: { verdict: 'refused', codes: ['G6.approval_stale_head'] } });
    expect(rep.prs.find((p) => p.pr_number === 10)!.ever_would_merge).toBe(false);
    expect(rep.ever_would_merge).toBe(4);
    expect(rep.totals.outcomes).toBeGreaterThan(8);
  });

  it('a missed reopen, a gap in the scans before the merge, and a merge on a head without a decision are not agreement', () => {
    const { at, run } = report();
    at(1, 1).scan('would_merge').scan('would_merge').scan('would_merge').outcome('merged', { reopenUnobserved: true });
    at(2, 2).scan('would_merge').scan('would_merge').scan('would_merge').skip(120).outcome('merged');        // service was down
    at(3, 3).scan('would_merge', OTHER).scan('would_merge', OTHER).scan('would_merge', OTHER).outcome('merged');   // decisions are for another head
    const rep = run();
    expect(category(rep, 1)).toBe('merged_unobserved');
    expect(category(rep, 2)).toBe('merged_unobserved');
    expect(category(rep, 3)).toBe('merged_unevaluated');
  });

  it('picks the decision and the scans by number even when the local clock steps back', () => {
    const { at, r, run } = report();
    const s = at(1, 1);
    s.scan('would_merge').scan('would_merge').scan('would_merge');
    s.skip(-60).outcome('merged'); // observed_at is earlier than the decisions'; the fence and the cycle numbers still order them
    expect(r.store.decisionBeforeMerge(REPO, 1)?.verdict).toBe('would_merge');
    expect(category(run(), 1)).toBe('agree_merge');
  });

  it('a PR listed in only one of the three scans before the merge (rotation over more than ten PRs) was observed', () => {
    const { at, run } = report();
    at(1, 1).scan('would_merge').scan(null).scan(null).outcome('merged');
    at(2, 2).scan(null).scan('refused', HEAD, false).scan(null).outcome('merged');
    at(3, 3).scan(null).scan(null).scan(null).outcome('merged');
    const rep = run();
    expect(category(rep, 1)).toBe('agree_merge');
    expect(category(rep, 2)).toBe('merged_unobserved'); // decided in a scan but not listed in any cycle row
    expect(category(rep, 3)).toBe('merged_unobserved');
  });

  it('classifies the merger by numeric id and reports the time from would_merge to merge for reference only', () => {
    const { at, run } = report();
    at(1, 1).scan('would_merge').scan('would_merge').scan('would_merge').outcome('merged', { by: [1005, 'Bot'] });
    const p = run().prs[0]!;
    expect(p).toMatchObject({ category: 'agree_merge', merged_by_actor_id: 1005, owner_approved_head: null });
    expect(typeof p.would_merge_to_merged_ms).toBe('number');
  });
});

describe('report is read-only and leaks nothing', () => {
  it('runs only SELECT statements and leaves every table unchanged', () => {
    const { at, r } = report();
    at(1, 1).scan('would_merge').scan('would_merge').scan('would_merge').outcome('merged');
    const seen: string[] = [];
    const spy: ReportDb = { prepare: (sql) => { seen.push(sql); return r.rig.db.prepare(sql) as never; } };
    const dump = () => JSON.stringify([ledgerDump(r.rig), r.rig.db.prepare('SELECT * FROM engineering_merger_shadow_decisions').all(), r.rig.db.prepare('SELECT * FROM engineering_merger_shadow_watermarks').all(),
      r.rig.db.prepare('SELECT * FROM engineering_merger_shadow_outcomes').all(), r.rig.db.prepare('SELECT * FROM engineering_merger_shadow_cycles').all()]);
    const before = dump();
    buildMergerReport(spy, T0);
    expect(seen.length).toBeGreaterThan(5);
    for (const sql of seen) expect(sql).toMatch(/^\s*SELECT\b/iu);
    expect(dump()).toBe(before);
    expect(() => buildMergerReport({ prepare: (sql) => { if (!/^SELECT/u.test(sql)) throw new Error('x'); return spy.prepare(sql); } }, T0)).not.toThrow();
  });

  it('a caller only sees the Mission rows of its own scopes, even on a PR shared with another scope', () => {
    const { at, r } = report();
    at(1, 7).scan('would_merge');
    const otherRoot = join(r.rig.root, 'other');
    mkdirSync(otherRoot);
    const other = r.rig.attention.registerScope(r.rig.owner, 't', otherRoot);
    const principal = { ...r.rig.principal, read_scopes: [other.scope_id], write_scopes: [other.scope_id] };
    const m = r.rig.missions.authorize(principal, { scope_id: other.scope_id, spec: { goal: 'x', branch: 'osstack/mission/x', publication: { remote: 'origin', repository: REPO, base: 'main', draft: true } },
      claim: { repo_identity: 'rx', branch: 'osstack/mission/x', worktree_identity: 'wx' } }, T0);
    const seq = r.store.beginObservation(REPO, 7, T0);
    r.store.recordDecision({ repository: REPO, pr_number: 7, mission_id: m.mission_id, head_sha: OTHER, base_sha: BASE, verdict: 'refused', codes: ['G2.secret_mission_code'],
      gates: { second_read: false, start_is_base: false }, evidence_digest: 'e'.repeat(64), observed_at: T0 }, seq, T0);
    const visible = buildMergerReport(r.rig.db, T0, [r.rig.scope.scope_id]);
    expect(visible.totals.decisions).toBe(1);
    expect(JSON.stringify(visible)).not.toContain(m.mission_id);
    expect(JSON.stringify(visible)).not.toContain('G2.secret_mission_code');
    expect(buildMergerReport(r.rig.db, T0).totals.decisions).toBe(2);
    expect(buildMergerReport(r.rig.db, T0, [other.scope_id]).open.map((o) => o.mission_id)).toEqual([m.mission_id]);
  });

  it('output carries ids, hashes, counts and fixed codes only: no login, URL, body, token or path', async () => {
    const { r, run } = report();
    const rec = r.reconciler();
    await rec.scan();
    r.world.reviews = [];
    r.clock.now += 5 * MIN + 1;
    await rec.scan();
    const text = JSON.stringify(run());
    for (const needle of ['SECRET-BODY-TOKEN', 'https://', 'http://', 'ghp_', 'github_pat', '.pem', 'apps.json', 'rulesets.json', 'Bearer', 'password']) expect(text).not.toContain(needle);
    expect(JSON.parse(text)).toMatchObject({ schema_version: 1, counts: { open: 1 } });
    expect(text).not.toMatch(/recommend(ed)? (to )?enable|safe to enable|ready to merge/iu);
  });
});

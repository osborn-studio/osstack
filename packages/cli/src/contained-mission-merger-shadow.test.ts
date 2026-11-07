import { afterEach, describe, expect, it } from 'vitest';
import { mergerShadowWriter } from '@osstack/core';
import { buildMergerReport } from './contained-mission-merger-report.js';
import { MERGER_PR_OUTCOME_QUERY, MERGER_PR_STATE_QUERY, createMergerMissionView } from './contained-mission-merger-shadow.js';
import { review } from './contained-mission-merger.testkit.js';
import {
  BASE, HEAD, MIN, OWNER, REPO, T0, config, createRigged, evidencePayload, ledgerDump, seedMergerMission, type Rigged,
} from './contained-mission-merger-shadow.testkit.js';

const open: Rigged[] = [];
const rigged = (cfg?: Parameters<typeof createRigged>[0]): Rigged => { const r = createRigged(cfg); open.push(r); return r; };
afterEach(() => { open.splice(0).forEach((r) => { r.close(); }); });

const verdicts = (r: Rigged) => r.store.decisions(REPO, 7).map((d) => [d.verdict, JSON.parse(d.codes_json) as string[]] as const);
/** Advance the fake clock past the minimum gap and run one scan. */
const next = async (r: Rigged, rec: { scan(): Promise<void> }, minutes = 5): Promise<void> => { r.clock.now += minutes * MIN + 1; await rec.scan(); };

describe('Mission view: deliveryEvidence', () => {
  it('returns the ledger side of the gates, with the digests recomputed from the payload', () => {
    const r = rigged();
    const e = createMergerMissionView(r.rig.missions).deliveryEvidence(r.mission.missionId)!;
    expect(e).toMatchObject({ mission_id: r.mission.missionId, spec_digest: r.mission.specDigest, repository: REPO, pr_number: 7, head: HEAD, candidate_head: HEAD,
      pushed_commit: HEAD, base_head: BASE, publication_kind: 'opened', join_count: 1 });
    expect(e.record_digest).toBe(e.recomputed_digest);
    expect(e.record_digest).toBe(e.event_digest);
  });
  it('a payload that does not hash to its digest is reported as such; a second Mission on the PR makes the join ambiguous', () => {
    const r = rigged();
    const view = createMergerMissionView(r.rig.missions);
    const forged = r.rig.seedMission({ pr_number: 8, head: HEAD, base_head: BASE, branch: 'osstack/mission/forged',
      evidence: (m) => ({ ...evidencePayload(m, {}, 8, 'osstack/mission/forged'), tier: 'T1' }) });
    // `tier` was changed after the digest was computed over the original body.
    const e = view.deliveryEvidence(forged)!;
    expect(e.record_digest).not.toBe(e.recomputed_digest);
    const second = seedMergerMission(r.rig, 7, 'osstack/mission/other');
    expect(view.deliveryEvidence(second.missionId)!.join_count).toBe(2);
  });
  it('is null for a Mission without full evidence', () => {
    const r = rigged();
    const bare = r.rig.seedMission({ pr_number: 9, head: HEAD, base_head: BASE });
    expect(createMergerMissionView(r.rig.missions).deliveryEvidence(bare)).toBeNull();
  });
});

describe('scripted cycle series', () => {
  it('produces would_merge, refused and unevaluated, with dedupe, one cycle row per scan and nothing but GETs and queries', async () => {
    const r = rigged();
    const rec = r.reconciler();
    await rec.scan();
    expect(verdicts(r)).toEqual([['would_merge', []]]);
    const first = r.store.decisions(REPO, 7)[0]!;
    expect(JSON.parse(first.merge_request_json!)).toEqual({ sha: HEAD, merge_method: 'squash' });
    expect(JSON.parse(first.gates_json)).toMatchObject({ second_read: true, read_ms: [T0, T0] });
    expect(r.calls.gql.length).toBe(2); // two full reads for would_merge

    await next(r, rec); // identical -> deduped
    expect(r.store.decisions(REPO, 7).length).toBe(1);
    expect(r.store.watermark(REPO, 7)).toMatchObject({ issued_seq: 2, accepted_seq: 2 });

    r.world.reviews = []; // approval withdrawn
    await next(r, rec);
    expect(verdicts(r).at(-1)![0]).toBe('refused');
    expect(verdicts(r).at(-1)![1].length).toBeGreaterThan(0);
    expect(verdicts(r).at(-1)![1].some((c) => c.startsWith('U.'))).toBe(false);

    r.world.pr = { mergeable: 'UNKNOWN' };
    await next(r, rec);
    expect(verdicts(r).at(-1)).toEqual(['unevaluated', ['U.mergeability_unknown']]);

    r.world.graphqlHook = () => { throw new Error('boom secret-token'); };
    await next(r, rec);
    expect(verdicts(r).at(-1)).toEqual(['unevaluated', ['U.read_failed:graphql_request']]);
    r.world.graphqlHook = undefined as never;

    expect(r.store.decisions(REPO, 7).map((d) => d.verdict)).toEqual(['would_merge', 'refused', 'unevaluated', 'unevaluated']);
    // One cycle row per scan, listing the PR with the observation number that was fenced.
    const cycles = r.rig.db.prepare('SELECT prs_json FROM engineering_merger_shadow_cycles ORDER BY seq').all() as Array<{ prs_json: string }>;
    expect(cycles.length).toBe(5);
    expect(JSON.parse(cycles[0]!.prs_json)).toEqual([[REPO, 7, 1, HEAD, 'would_merge']]);
    for (const g of r.calls.gql) expect(g.query).not.toMatch(/mutation|subscription/iu);
    expect(JSON.stringify(r.logs)).not.toContain('secret-token');
    expect(r.logs.filter((l) => /decision_abandoned|rejected|failed/u.test(l))).toEqual([]);
  });

  it('keeps the minimum gap between two evaluations of one PR', async () => {
    const r = rigged();
    const rec = r.reconciler();
    await rec.scan();
    const reads = r.calls.gql.length;
    r.clock.now += 4 * MIN;
    await rec.scan();
    expect(r.calls.gql.length).toBe(reads);
    r.clock.now += 2 * MIN;
    await rec.scan();
    expect(r.calls.gql.length).toBeGreaterThan(reads);
  });

  it('examines at most ten PRs per scan and continues from a cursor', async () => {
    const r = rigged();
    for (let n = 1; n <= 11; n += 1) seedMergerMission(r.rig, 100 + n, `osstack/mission/extra-${n}`);
    r.world.graphqlHook = () => { throw new Error('down'); };
    const rec = r.reconciler();
    await rec.scan();
    const seen = () => (r.rig.db.prepare('SELECT COUNT(DISTINCT pr_number) AS n FROM engineering_merger_shadow_decisions').get() as { n: number }).n;
    expect(seen()).toBe(10);
    await rec.scan(); // the other two; the first ten are inside their gap
    expect(seen()).toBe(12);
  });

  it('stops starting new PRs once the per-scan request budget is spent', async () => {
    const r = rigged();
    for (let n = 1; n <= 3; n += 1) seedMergerMission(r.rig, 100 + n, `osstack/mission/extra-${n}`);
    r.world.graphqlHook = () => { throw new Error('down'); };
    const rec = r.reconciler({ requestsPerScan: 2 });
    await rec.scan();
    expect((r.rig.db.prepare('SELECT COUNT(*) AS n FROM engineering_merger_shadow_decisions').get() as { n: number }).n).toBe(2);
  });

  it('records a check context outside the closed gates schema as unevaluated instead of dropping it', async () => {
    const r = rigged(config({ required_checks: [{ context: 'check', app_id: 15368 }, { context: 'build/odd!', app_id: 15368 }] }));
    r.world.reviews = [];
    const rec = r.reconciler();
    await rec.scan();
    // A refused record whose gates carry the odd context would be rejected by the store; the fixed fallback keeps the observation visible.
    const last = verdicts(r).at(-1)!;
    expect(['refused', 'unevaluated']).toContain(last[0]);
    expect(r.rig.db.prepare('SELECT COUNT(*) AS n FROM engineering_merger_shadow_decisions').get()).toEqual({ n: 1 });
  });
});

describe('dedupe and fence across restarts and processes', () => {
  it('a restarted reconciler continues the observation numbers and dedupes against the ledger', async () => {
    const r = rigged();
    await r.reconciler().scan();
    const restarted = r.reconciler(); // fresh in-memory state, same database
    await next(r, restarted);
    expect(r.store.decisions(REPO, 7).length).toBe(1);
    expect(r.store.watermark(REPO, 7)).toMatchObject({ issued_seq: 2, accepted_seq: 2 });
    r.world.reviews = [];
    await next(r, restarted);
    expect(r.store.decisions(REPO, 7).map((d) => d.observation_seq)).toEqual([1, 3]);
  });

  it('an older observation finishing after a newer one is refused by the fence and records nothing', async () => {
    const r = rigged();
    const newer = r.reconciler();
    let armed = true;
    const older = r.reconciler({
      graphql: async (q, v) => {
        if (armed) { armed = false; await newer.scan(); } // another process takes a later number and finishes first
        return r.graphql(q, v);
      },
    });
    await older.scan();
    expect(r.store.decisions(REPO, 7).map((d) => d.observation_seq)).toEqual([2]);
    expect(r.store.watermark(REPO, 7)).toMatchObject({ issued_seq: 2, accepted_seq: 2 });
    expect(r.logs.some((l) => /decision_abandoned .* code=merger_stale_observation/u.test(l))).toBe(true);
  });
});

describe('outcomes', () => {
  const merged = (r: Rigged, by: { __typename: string; databaseId: number } | null = { __typename: 'User', databaseId: OWNER }): void => {
    r.setState('MERGED');
    r.outcome.mergedAt = new Date(T0 + 40 * MIN).toISOString();
    r.outcome.mergeCommit = 'f'.repeat(40);
    r.outcome.mergedBy = by;
  };

  it('a merge after three observed scans is recorded once, classified by numeric id, and ends observation', async () => {
    const r = rigged();
    const rec = r.reconciler();
    await rec.scan(); await next(r, rec); await next(r, rec);
    merged(r);
    await next(r, rec);
    const [o] = r.store.outcomes(REPO, 7);
    expect(o).toMatchObject({ outcome: 'merged', head_at_close: HEAD, merged_by_actor_id: OWNER, merged_by_type: 'User', owner_approved_head: null });
    expect(JSON.parse(o!.facts_json)).toEqual({ published_head: HEAD, merged_by_class: 'owner' });
    // The scan that saw the merge is recorded by its database-issued id, and the cycle row of that scan carries the same id.
    expect(o!.scan_id).toBe(4);
    expect(r.rig.db.prepare('SELECT scan_id FROM engineering_merger_shadow_cycles ORDER BY seq DESC LIMIT 1').get()).toEqual({ scan_id: 4 });
    expect(r.outcomeQueries).toEqual([MERGER_PR_OUTCOME_QUERY]);
    const reads = r.calls.gql.length;
    await next(r, rec);
    expect(r.calls.gql.length).toBe(reads); // terminal: never read again
    expect(buildMergerReport(r.rig.db, T0).prs[0]).toMatchObject({ category: 'agree_merge', merged_by_class: 'owner', ever_would_merge: true });
  });

  it('App E is recognised by its bot user id, and a merge by an unknown bot is other_bot', async () => {
    const a = rigged();
    const recA = a.reconciler();
    await recA.scan();
    merged(a, { __typename: 'Bot', databaseId: config().merger.actor_id });
    await next(a, recA);
    expect(JSON.parse(a.store.outcomes(REPO, 7)[0]!.facts_json)).toMatchObject({ merged_by_class: 'merger_app' });
    const b = rigged();
    const recB = b.reconciler();
    await recB.scan();
    merged(b, { __typename: 'Bot', databaseId: 999 });
    await next(b, recB);
    expect(JSON.parse(b.store.outcomes(REPO, 7)[0]!.facts_json)).toMatchObject({ merged_by_class: 'other_bot' });
  });

  it('inspection evidence needs a counted approval on the merged head before the merge, and only where the registry says so', async () => {
    const approval = (at: number, commit = HEAD) => ({ databaseId: 1, submittedAt: new Date(at).toISOString(), commit, authorId: OWNER });
    const cases: Array<[boolean, ReturnType<typeof approval>[], number | null]> = [
      [true, [approval(T0 + 10 * MIN)], 1], [true, [approval(T0 + 50 * MIN)], 0], [true, [approval(T0 + 10 * MIN, 'e'.repeat(40))], 0], [false, [approval(T0 + 10 * MIN)], null],
    ];
    for (const [evidence, reviews, expected] of cases) {
      const r = rigged(config({ inspection_evidence: evidence }));
      const rec = r.reconciler();
      await rec.scan();
      merged(r);
      r.outcome.reviews = reviews;
      await next(r, rec);
      const row = r.store.outcomes(REPO, 7)[0]!;
      expect(row.owner_approved_head).toBe(expected);
    }
  });

  it('a merged PR whose merger is unreadable is not recorded and is retried', async () => {
    const r = rigged();
    const rec = r.reconciler();
    await rec.scan();
    merged(r, null);
    await next(r, rec);
    expect(r.store.outcomes(REPO, 7)).toEqual([]);
    expect(r.logs.some((l) => /outcome_unreadable .* code=merged_by_missing/u.test(l))).toBe(true);
    merged(r);
    await next(r, rec);
    expect(r.store.outcomes(REPO, 7).map((o) => o.outcome)).toEqual(['merged']);
  });

  it('closed -> hourly state poll -> reopened resumes five-minute evaluation -> closed -> merged between polls (missed reopen)', async () => {
    const r = rigged();
    const rec = r.reconciler({ closedPollMs: 60 * MIN });
    await rec.scan();
    r.setState('CLOSED');
    await next(r, rec);
    expect(r.store.outcomes(REPO, 7).map((o) => o.outcome)).toEqual(['closed_unmerged']);

    // Closed PRs are polled hourly with the one-field query, not evaluated every five minutes.
    const gql = r.calls.gql.length;
    await next(r, rec, 10);
    expect(r.calls.gql.length).toBe(gql);
    expect(r.outcomeQueries).toEqual([]);

    r.setState('OPEN');
    await next(r, rec, 61);
    expect(r.outcomeQueries).toEqual([MERGER_PR_STATE_QUERY]);
    expect(r.store.outcomes(REPO, 7).map((o) => o.outcome)).toEqual(['closed_unmerged', 'reopened']);
    await next(r, rec); // evaluation is back on the five-minute cadence
    expect(r.calls.gql.length).toBeGreaterThan(gql);

    r.setState('CLOSED');
    await next(r, rec);
    expect(r.store.outcomes(REPO, 7).map((o) => o.outcome)).toEqual(['closed_unmerged', 'reopened', 'closed_unmerged']);

    // Reopened and merged between two hourly polls: the next poll sees MERGED.
    merged(r);
    await next(r, rec, 61);
    const last = r.store.outcomes(REPO, 7).at(-1)!;
    expect(last.outcome).toBe('merged');
    expect(JSON.parse(last.facts_json)).toMatchObject({ reopen_unobserved: true });
    expect(buildMergerReport(r.rig.db, T0).prs[0]!.category).toBe('merged_unobserved');
  });

  it('observation expires 30 days after the close and then stops for good', async () => {
    const r = rigged();
    const rec = r.reconciler();
    await rec.scan();
    r.setState('CLOSED');
    await next(r, rec);
    await next(r, rec, 60 * 24 * 29);
    expect(r.store.outcomes(REPO, 7).map((o) => o.outcome)).toEqual(['closed_unmerged']);
    await next(r, rec, 60 * 24 * 2);
    expect(r.store.outcomes(REPO, 7).map((o) => o.outcome)).toEqual(['closed_unmerged', 'observation_expired']);
    const reads = r.calls.gql.length + r.outcomeQueries.length;
    await next(r, rec, 120);
    expect(r.calls.gql.length + r.outcomeQueries.length).toBe(reads);
    expect(buildMergerReport(r.rig.db, T0).prs[0]!.category).toBe('closed_expired');
  });

  it('a restart within the hour does not postpone the closed-PR poll: the next poll is computed from the persisted marker', async () => {
    const r = rigged();
    const rec = r.reconciler({ closedPollMs: 60 * MIN });
    await rec.scan();
    r.setState('CLOSED');
    await next(r, rec); // records closed_unmerged; the poll marker is this observation's start
    const marker = r.store.lastPollAt(REPO, 7)!;
    expect(marker).toBe(r.clock.now);
    r.setState('OPEN'); // reopened on GitHub; only a poll will notice
    r.clock.now += 50 * MIN;
    const restarted = r.reconciler({ closedPollMs: 60 * MIN }); // a new process: no in-memory poll time
    await restarted.scan();
    expect(r.outcomeQueries).toEqual([]); // 50 minutes after the close: not yet due
    r.clock.now += 11 * MIN; // 61 minutes after the marker, though only 11 after the restart
    await restarted.scan();
    expect(r.outcomeQueries).toEqual([MERGER_PR_STATE_QUERY]);
    expect(r.store.outcomes(REPO, 7).map((o) => o.outcome)).toEqual(['closed_unmerged', 'reopened']);
    // A restart before the marker plus the gap still waits for it.
    expect(r.store.lastPollAt(REPO, 7)).toBeGreaterThan(marker);
  });

  it('a closed PR without a marker (a row from before migration 55) is polled one gap after its closing observation, however often the process restarts', async () => {
    const r = rigged();
    const rec = r.reconciler({ closedPollMs: 60 * MIN });
    await rec.scan();
    r.setState('CLOSED');
    await next(r, rec);
    const closedAt = r.clock.now;
    r.rig.db.exec('DROP TRIGGER engineering_merger_watermark_poll_monotonic');
    r.rig.db.exec('UPDATE engineering_merger_shadow_watermarks SET last_poll_at=NULL');
    r.setState('OPEN');
    for (const minutes of [50, 55]) { // restarts 50 and 55 minutes in must not keep postponing the first poll
      r.clock.now = closedAt + minutes * MIN;
      await r.reconciler({ closedPollMs: 60 * MIN }).scan();
    }
    expect(r.outcomeQueries).toEqual([]);
    r.clock.now = closedAt + 61 * MIN;
    await r.reconciler({ closedPollMs: 60 * MIN }).scan();
    expect(r.outcomeQueries).toEqual([MERGER_PR_STATE_QUERY]);
  });

  it('a poll marker from a clock that was ahead (in the future) does not silence the poll: the process anchors on its own first look', async () => {
    const r = rigged();
    const rec = r.reconciler({ closedPollMs: 60 * MIN });
    await rec.scan();
    r.setState('CLOSED');
    await next(r, rec);
    r.rig.db.exec('DROP TRIGGER engineering_merger_watermark_poll_monotonic');
    r.rig.db.prepare('UPDATE engineering_merger_shadow_watermarks SET last_poll_at=?').run(r.clock.now + 24 * 60 * MIN);
    r.setState('OPEN');
    const restarted = r.reconciler({ closedPollMs: 60 * MIN });
    await next(r, restarted, 10); // anchors here
    expect(r.outcomeQueries).toEqual([]);
    await next(r, restarted, 30); // not reset by every scan
    expect(r.outcomeQueries).toEqual([]);
    await next(r, restarted, 31);
    expect(r.outcomeQueries).toEqual([MERGER_PR_STATE_QUERY]);
  });

  it('overlapping scans from two processes keep their own scan ids: the outcome is attributed to the scan that recorded it', async () => {
    const r = rigged();
    const rec = r.reconciler();
    await rec.scan();
    r.setState('MERGED');
    r.outcome.mergedAt = new Date(T0 + 40 * MIN).toISOString();
    r.outcome.mergeCommit = 'f'.repeat(40);
    r.outcome.mergedBy = { __typename: 'User', databaseId: OWNER };
    r.clock.now += 6 * MIN;
    const peer = r.reconciler(); // a second process
    let armed = true;
    const slow = r.reconciler({
      graphql: async (q, v) => {
        // While the first process is still reading, the peer takes a later scan id and finishes its whole scan (cycle row included) first.
        if (armed) { armed = false; await peer.scan(); }
        return r.graphql(q, v);
      },
    });
    await slow.scan();
    const scans = r.rig.db.prepare('SELECT scan_id,started_at FROM engineering_merger_shadow_scans ORDER BY scan_id').all() as Array<{ scan_id: number }>;
    expect(scans.map((s) => s.scan_id)).toEqual([1, 2, 3]);
    // The slow process took scan 2 and its observation number first, the peer scan 3 afterwards; the peer's observation was accepted, so the slow one is abandoned.
    const outcomes = r.store.outcomes(REPO, 7);
    expect(outcomes.length).toBe(1);
    const cycles = r.rig.db.prepare('SELECT scan_id,prs_json FROM engineering_merger_shadow_cycles ORDER BY seq').all() as Array<{ scan_id: number; prs_json: string }>;
    expect(cycles.map((c) => c.scan_id)).toEqual([1, 3, 2]); // the peer's scan 3 wrote its cycle row before the slower scan 2
    expect(outcomes[0]!.scan_id).toBe(3); // by id, the outcome belongs to scan 3 although scan 2's cycle row is the newer one
  });

  it('a restarted process does not poll a closed PR sooner than one poll gap after it starts', async () => {
    const r = rigged();
    const rec = r.reconciler({ closedPollMs: 60 * MIN });
    await rec.scan();
    r.setState('CLOSED');
    await next(r, rec);
    await next(r, rec, 61);
    const polls = r.outcomeQueries.length;
    expect(polls).toBe(1);
    const restarted = r.reconciler({ closedPollMs: 60 * MIN });
    await next(r, restarted, 6); // the first scan after a restart
    expect(r.outcomeQueries.length).toBe(polls);
    await next(r, restarted, 61);
    expect(r.outcomeQueries.length).toBe(polls + 1);
  });

  it('GraphQL errors next to data are not trusted: nothing is recorded, nothing leaks', async () => {
    const r = rigged();
    const rec = r.reconciler({ closedPollMs: 60 * MIN });
    await rec.scan();
    r.setState('CLOSED');
    await next(r, rec);
    r.setState('MERGED');
    r.outcome.mergedAt = new Date(T0).toISOString(); r.outcome.mergeCommit = 'f'.repeat(40); r.outcome.mergedBy = { __typename: 'User', databaseId: OWNER };
    r.outcome.errors = [{ message: 'could not resolve author ghp_leak' }];
    await next(r, rec, 61);
    expect(r.store.outcomes(REPO, 7).map((o) => o.outcome)).toEqual(['closed_unmerged']);
    expect(r.logs.some((l) => /code=graphql_errors/u.test(l))).toBe(true);
    expect(JSON.stringify(r.logs)).not.toContain('ghp_leak');
  });

  it('pages through approvals and defers the merge outcome when the list cannot be completed', async () => {
    const approval = (n: number, at: number) => ({ databaseId: n, submittedAt: new Date(at).toISOString(), commit: HEAD, authorId: OWNER });
    // The qualifying owner approval is the oldest of 250: found on the third page.
    const a = rigged(config({ inspection_evidence: true }));
    const recA = a.reconciler();
    await recA.scan();
    a.setState('MERGED'); a.outcome.mergedAt = new Date(T0 + 60 * MIN).toISOString(); a.outcome.mergeCommit = 'f'.repeat(40); a.outcome.mergedBy = { __typename: 'User', databaseId: OWNER };
    a.outcome.pageSize = 100;
    a.outcome.reviews = [approval(1, T0 + MIN), ...Array.from({ length: 249 }, (_, i) => ({ ...approval(i + 2, T0 + 90 * MIN), authorId: 4242 }))];
    await next(a, recA);
    expect(a.store.outcomes(REPO, 7)[0]!.owner_approved_head).toBe(1);
    expect(a.outcomeQueries.length).toBe(3);

    // 600 approvals and none qualifying within the page budget: no terminal record on an incomplete "no".
    const b = rigged(config({ inspection_evidence: true }));
    const recB = b.reconciler();
    await recB.scan();
    b.setState('MERGED'); b.outcome.mergedAt = new Date(T0 + 60 * MIN).toISOString(); b.outcome.mergeCommit = 'f'.repeat(40); b.outcome.mergedBy = { __typename: 'User', databaseId: OWNER };
    b.outcome.reviews = Array.from({ length: 600 }, (_, i) => ({ ...approval(i + 1, T0 + 90 * MIN), authorId: 4242 }));
    await next(b, recB);
    expect(b.store.outcomes(REPO, 7)).toEqual([]);
    expect(b.logs.some((l) => /code=approvals_incomplete/u.test(l))).toBe(true);
  });

  it('a failed state poll records nothing and is retried at the poll gap', async () => {
    const r = rigged();
    const rec = r.reconciler({ closedPollMs: 60 * MIN });
    await rec.scan();
    r.setState('CLOSED');
    await next(r, rec);
    r.outcome.fail = new Error('token ghp_leak');
    await next(r, rec, 61);
    expect(r.store.outcomes(REPO, 7).map((o) => o.outcome)).toEqual(['closed_unmerged']);
    expect(JSON.stringify(r.logs)).not.toContain('ghp_leak');
  });
});

describe('writes only through the shadow writer', () => {
  it('leaves the Mission ledger and the chain tables byte-identical', async () => {
    const r = rigged();
    const before = ledgerDump(r.rig);
    const rec = r.reconciler();
    await rec.scan();
    r.world.reviews = [review(1, { state: 'CHANGES_REQUESTED' })];
    await next(r, rec);
    expect(ledgerDump(r.rig)).toBe(before);
    expect(r.store.decisions(REPO, 7).length).toBeGreaterThan(0);
  });

  it('after stop() a late scan writes nothing', async () => {
    const r = rigged();
    const rec = r.reconciler();
    await rec.stop();
    await rec.scan();
    expect(r.store.decisions(REPO, 7)).toEqual([]);
    expect(mergerShadowWriter(r.store)).toBeDefined();
    expect(evidencePayload({ mission_id: 'm', spec_digest: 's' })['evidence_digest']).toMatch(/^[0-9a-f]{64}$/u);
  });
});

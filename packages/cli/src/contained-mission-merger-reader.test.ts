import { evaluateMergeGates } from '@osstack/core';
import { describe, expect, it } from 'vitest';
import {
  MERGER_PULL_REQUEST_QUERY,
  assertRestArgv,
  assertRestPathAllowed,
  ghRestGetTransport,
  readMergeGateInput,
  readMergeSnapshot,
  restArgv,
  type RestScope,
} from './contained-mission-merger-reader.js';
import { APP, BASE, BOT, BRANCH, HEAD, IDS, MISSION, OWNER, REPO, evidence, makeWorld, registry, review, run, serve, type World } from './contained-mission-merger.testkit.js';

const scope: RestScope = { repository: REPO, rulesetIds: [IDS.quality, IDS.update, IDS.writers, IDS.history] };

async function snap(w: World, limits?: { maxRequests?: number; maxPages?: number; filesMaxPages?: number }) {
  const s = serve(w);
  const r = await readMergeSnapshot({ graphql: s.graphql, rest: s.rest, ...(limits ? { limits } : {}) }, evidence, registry);
  if (!r.ok) throw new Error(`read failed ${r.codes.join()}`);
  return { snapshot: r.snapshot, calls: s.calls, issues: r.issues };
}
async function verdict(w: World) {
  const s = serve(w);
  const r = await readMergeGateInput({ graphql: s.graphql, rest: s.rest }, evidence, registry);
  if (!r.ok) return { read: r, calls: s.calls };
  return { read: r, calls: s.calls, verdict: evaluateMergeGates(r.input) };
}

describe('end to end with the M-A gates', () => {
  it('a fully valid PR reaches would_merge after two identical full reads', async () => {
    const { verdict: v, calls, read } = await verdict(makeWorld());
    expect(v).toMatchObject({ verdict: 'would_merge', request: { sha: HEAD, merge_method: 'squash' } });
    expect(read.ok && read.input.second).not.toBeNull();
    expect(calls.gql.length).toBe(2);
    expect(calls.rest.length % 2).toBe(0);
    expect(calls.rest.slice(0, calls.rest.length / 2)).toEqual(calls.rest.slice(calls.rest.length / 2));
  });

  it('every REST request is an allowlisted GET path; commits/{head}/check-runs is never used; no mutation in any document', async () => {
    const { calls } = await verdict(makeWorld());
    for (const p of calls.rest) expect(() => assertRestPathAllowed(p, scope)).not.toThrow();
    expect(calls.rest.some((p) => /commits\/[0-9a-f]+\/check-runs/u.test(p))).toBe(false);
    expect(calls.rest.some((p) => p.includes(`commits/${HEAD}/check-suites?app_id=${APP.evidence}`))).toBe(true);
    for (const g of calls.gql) expect(g.query).not.toMatch(/mutation|subscription/iu);
    expect(MERGER_PULL_REQUEST_QUERY).not.toContain('baseRefOid');
  });

  it('a refused first read does not perform the second read', async () => {
    const w = makeWorld();
    w.reviews = [];
    const { read, verdict: v, calls } = await verdict(w);
    expect(v?.verdict).toBe('refused');
    expect(read.ok && read.input.second).toBeNull();
    expect(calls.gql.length).toBe(1);
  });
});

describe('two full reads must be identical (TOCTOU)', () => {
  const moves: Array<[string, (w: World) => void, string]> = [
    ['head moves', (w) => { w.pr = { headRefOid: 'f'.repeat(40) }; }, 'pr'],
    ['base tip moves', (w) => { w.pr = { baseRef: { target: { oid: 'e'.repeat(40) } } }; w.crossTip = 'e'.repeat(40); }, 'pr'],
    ['marker body edited', (w) => { w.body = w.body.replace(`start=${'c'.repeat(40)}`, `start=${'d'.repeat(40)}`); }, 'marker'],
    ['new review', (w) => { w.reviews = [...w.reviews, review(2, { state: 'CHANGES_REQUESTED', author: { __typename: 'User', databaseId: 5 } })]; }, 'reviews'],
    ['thread reopened', (w) => { w.threads = [{ id: 'T', isResolved: false }]; }, 'threads'],
    ['check rerun fails', (w) => { w.runs[1] = [run(11, 'check', APP.actions), run(12, 'build', APP.actions, { conclusion: 'failure' })]; }, 'required_runs'],
    ['ruleset bypass added', (w) => { (w.rulesets[IDS.quality] as { bypass_actors: unknown[] }).bypass_actors = [{ actor_id: 9, actor_type: 'Team', bypass_mode: 'always' }]; }, 'rulesets'],
    ['force push', (w) => { w.timeline = ['HeadRefForcePushedEvent']; }, 'timeline'],
  ];
  for (const [name, mutate, field] of moves) {
    it(`${name} between the reads -> unevaluated U.snapshot_moved:${field}`, async () => {
      const w = makeWorld();
      w.onPass = (n) => { if (n === 2) mutate(w); };
      const { verdict: v, read } = await verdict(w);
      // The timeline is compared by the reader itself (the snapshot keeps only a count): ok:false, still unevaluated.
      expect(v?.verdict ?? 'unevaluated').toBe('unevaluated');
      expect(v?.codes ?? (read.ok ? [] : read.codes)).toContain(`U.snapshot_moved:${field}`);
    });
  }

  it('close/reopen and retarget churn that nets out to the same facts is still a moved timeline', async () => {
    for (const events of [['ClosedEvent', 'ReopenedEvent'], ['BaseRefChangedEvent', 'BaseRefChangedEvent']]) {
      const w = makeWorld();
      w.onPass = (n) => { if (n === 2) w.timeline = events; };
      expect((await verdict(w)).read).toEqual({ ok: false, codes: ['U.snapshot_moved:timeline'] });
    }
  });

  it('a second read that cannot be completed is ok:false, never compared partially', async () => {
    const w = makeWorld();
    w.onPass = (n) => { if (n === 2) w.failRest.push({ match: /check-suites\?app_id=12/u, result: { ok: false, status: 500, branchNotProtected: false } }); };
    const { read } = await verdict(w);
    expect(read).toEqual({ ok: false, codes: ['U.read_incomplete:second'] });
    const w2 = makeWorld();
    w2.onPass = (n) => { if (n === 2) w2.graphqlHook = () => { throw new Error('boom'); }; };
    expect((await verdict(w2)).read).toEqual({ ok: false, codes: ['U.second.read_failed:graphql_request'] });
  });

  it('the request budget is shared by both reads', async () => {
    const s = serve(makeWorld());
    const one = await readMergeSnapshot({ graphql: s.graphql, rest: s.rest }, evidence, registry);
    expect(one.ok).toBe(true);
    const per = s.calls.gql.length + s.calls.rest.length;
    const s2 = serve(makeWorld());
    const r = await readMergeGateInput({ graphql: s2.graphql, rest: s2.rest, limits: { maxRequests: per + 3 } }, evidence, registry);
    expect(r).toEqual({ ok: false, codes: ['U.read_incomplete:second'] });
    expect(s2.calls.gql.length + s2.calls.rest.length).toBeLessThanOrEqual(per + 3);
  });
});

describe('snapshot facts', () => {
  it('maps the PR scalars and takes the base tip from baseRef.target.oid with the repository ref as cross-check', async () => {
    const w = makeWorld();
    w.crossTip = 'd'.repeat(40);
    const { snapshot } = await snap(w);
    expect(snapshot.pr).toMatchObject({
      number: 7, state: 'OPEN', is_draft: false, mergeable: 'MERGEABLE', merge_state_status: 'CLEAN', review_decision: 'APPROVED', base_repository: REPO, head_repository: REPO,
      is_cross_repository: false, head_ref_name: BRANCH, base_ref_name: 'main', head_oid: HEAD, base_tip_oid: BASE, base_tip_crosscheck_oid: 'd'.repeat(40),
      author: { type: 'Bot', database_id: BOT.publisher },
    });
    expect(evaluateMergeGates({ evidence, snapshot, second: null, registry }).codes).toContain('G5.base_tip_inconsistent');
  });

  it('an unreadable base ref is null, not the PR record', async () => {
    const w = makeWorld();
    w.pr = { baseRef: null };
    w.crossTip = null;
    const { snapshot } = await snap(w);
    expect(snapshot.pr.base_tip_oid).toBeNull();
    expect(snapshot.pr.base_tip_crosscheck_oid).toBeNull();
  });

  it('keeps the marker facts and drops the body', async () => {
    const { snapshot } = await snap(makeWorld());
    expect(snapshot.marker).toMatchObject({ candidates: 1, malformed: 0, first_line_id: MISSION, marker: { id: MISSION, head: HEAD } });
    expect(JSON.stringify(snapshot)).not.toContain('SECRET-BODY-TOKEN');
    const w = makeWorld();
    w.body = 'no marker here';
    const m = (await snap(w)).snapshot.marker;
    expect(m).toEqual({ marker: null, candidates: 0, malformed: 0, first_line_id: null });
  });

  it('a ghost PR author is null; a non-bot author keeps its type', async () => {
    const w = makeWorld();
    w.pr = { author: null };
    expect((await snap(w)).snapshot.pr.author).toBeNull();
    w.pr = { author: { __typename: 'User', databaseId: 3 } };
    expect((await snap(w)).snapshot.pr.author).toEqual({ type: 'User', database_id: 3 });
  });

  it('reviews: pages, skips PENDING, ghosts keep a null id, unknown states and missing timestamps are incomplete', async () => {
    const w = makeWorld();
    w.reviews = Array.from({ length: 230 }, (_, i) => review(i + 1, { state: 'COMMENTED' }));
    const { snapshot, calls } = await snap(w);
    expect(snapshot.reviews).toMatchObject({ complete: true });
    expect(snapshot.reviews.items).toHaveLength(230);
    expect(calls.gql).toHaveLength(3);
    expect(calls.gql[2]!.variables).toMatchObject({ reviews: true, threads: false, timeline: false, files: false, reviewsAfter: '200' });

    w.reviews = [review(1, { state: 'PENDING', submittedAt: null }), review(2, { author: null, authorCanPushToRepository: null, commit: null })];
    const s2 = (await snap(w)).snapshot.reviews;
    expect(s2.complete).toBe(true);
    expect(s2.items).toEqual([{ review_id: 2, state: 'APPROVED', submitted_at_ms: expect.any(Number), commit_oid: null, author_type: 'Other', author_id: null, author_can_push: false }]);

    w.reviews = [review(1, { state: 'WEIRD' })];
    expect((await snap(w)).snapshot.reviews.complete).toBe(false);
    w.reviews = [review(1, { submittedAt: null })];
    expect((await snap(w)).snapshot.reviews.complete).toBe(false);
  });

  it('a review whose databaseId no longer fits 32 bits is read through fullDatabaseId; an unusable id is incomplete, not a failed read', async () => {
    const w = makeWorld();
    w.reviews = [review(1, { databaseId: null, fullDatabaseId: '5000000001' })];
    expect((await snap(w)).snapshot.reviews).toMatchObject({ complete: true, items: [{ review_id: 5000000001 }] });
    w.reviews = [review(1, { databaseId: null, fullDatabaseId: null }), review(2)];
    const s = (await snap(w)).snapshot.reviews;
    expect(s.complete).toBe(false);
    w.reviews = [review(1, { state: 'PENDING', submittedAt: null, databaseId: null })];
    expect((await snap(w)).snapshot.reviews.complete).toBe(true);
  });

  it('a Bot reviewer keeps its type and id', async () => {
    const w = makeWorld();
    w.reviews = [review(1, { author: { __typename: 'Bot', databaseId: 77 } })];
    expect((await snap(w)).snapshot.reviews.items[0]).toMatchObject({ author_type: 'Bot', author_id: 77, author_can_push: true });
  });

  it('threads: unresolved count includes outdated threads; paging past 100', async () => {
    const w = makeWorld();
    w.threads = [{ id: 'a', isResolved: true }, { id: 'b', isResolved: false, isOutdated: true }, ...Array.from({ length: 120 }, (_, i) => ({ id: `t${i}`, isResolved: true }))];
    const { snapshot } = await snap(w);
    expect(snapshot.threads).toEqual({ complete: true, unresolved: 1 });
    expect(evaluateMergeGates({ evidence, snapshot, second: null, registry }).codes).toContain('G6.unresolved_threads');
  });

  it('timeline: counts head force pushes only; request is limited to the five event types', async () => {
    const w = makeWorld();
    w.timeline = ['HeadRefForcePushedEvent', 'ClosedEvent', 'HeadRefForcePushedEvent', 'ReopenedEvent'];
    const { snapshot, calls } = await snap(w);
    expect(snapshot.timeline).toEqual({ complete: true, force_push_events: 2 });
    expect(calls.gql[0]!.query).toContain('HEAD_REF_FORCE_PUSHED_EVENT, BASE_REF_CHANGED_EVENT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT');
  });

  it('null connection nodes make that connection incomplete', async () => {
    const w = makeWorld();
    w.graphqlHook = (_q, v) => ({
      data: { repository: { defaultBranchRef: { name: 'main' }, ref: { target: { oid: BASE } }, pullRequest: {
        number: 7, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', body: '', baseRepository: { nameWithOwner: REPO },
        headRepository: { nameWithOwner: REPO }, isCrossRepository: false, headRefName: BRANCH, baseRefName: 'main', headRefOid: HEAD, changedFiles: 0, baseRef: { target: { oid: BASE } },
        ...(v['reviews'] ? { reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [null] } } : {}),
        ...(v['threads'] ? { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [null] } } : {}),
        ...(v['timeline'] ? { timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [null] } } : {}),
        ...(v['files'] ? { files: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [null] } } : {}),
      } } },
    });
    const { snapshot } = await snap(w);
    expect(snapshot.reviews.complete).toBe(false);
    expect(snapshot.threads.complete).toBe(false);
    expect(snapshot.timeline.complete).toBe(false);
    expect(snapshot.files.complete).toBe(false);
  });

  it('files: workflow and action paths (any case) set the flag; short lists and the page cap are incomplete', async () => {
    const w = makeWorld();
    expect((await snap(w)).snapshot.files).toEqual({ complete: true, workflow_paths_changed: false });
    w.files = ['a', '.github/workflows/ci.yml'];
    expect((await snap(w)).snapshot.files.workflow_paths_changed).toBe(true);
    w.files = ['.github/actions/x/action.yml'];
    expect((await snap(w)).snapshot.files.workflow_paths_changed).toBe(true);
    w.files = ['.GitHub/Workflows/ci.yml'];
    expect((await snap(w)).snapshot.files.workflow_paths_changed).toBe(true);
    w.files = ['.github/workflowsx/ci.yml', 'docs/.github/workflows/a'];
    expect((await snap(w)).snapshot.files.workflow_paths_changed).toBe(false);
    w.files = ['archive/ci.yml'];
    w.renamed = ['archive/ci.yml'];
    expect((await snap(w)).snapshot.files.workflow_paths_changed).toBe(true);
    w.renamed = undefined;
    w.files = ['a'];
    w.changedFiles = 3001;
    expect((await snap(w)).snapshot.files.complete).toBe(false);
    w.files = Array.from({ length: 3100 }, (_, i) => `f${i}`);
    w.changedFiles = undefined;
    const capped = await snap(w);
    expect(capped.snapshot.files.complete).toBe(false);
    expect(capped.issues).toContain('page_cap:files');
    expect(capped.calls.gql.length).toBe(30);
  });

  it('G4b end to end: a workflow path is refused', async () => {
    const w = makeWorld();
    w.files = ['.github/workflows/ci.yml'];
    expect((await verdict(w)).verdict?.codes).toContain('G4.workflow_paths_changed');
  });
});

describe('check suites and runs (G3 / G4)', () => {
  it('lists App B suites and runs per suite, with check_name; pages runs beyond 100 within a suite; several suites', async () => {
    const w = makeWorld();
    w.suites[APP.evidence] = [1201, 1202];
    w.runs[1201] = Array.from({ length: 150 }, (_, i) => run(6000 + i, i === 120 ? 'osstack/verify' : `other-${i}`, APP.evidence, { external_id: `${MISSION}:${HEAD}` }));
    w.runs[1202] = [run(5001, 'osstack/verify', APP.evidence, { external_id: `${MISSION}:${HEAD}` })];
    const { snapshot, calls } = await snap(w);
    // check_name filters server side; the model honours it, so only verify runs come back
    expect(snapshot.verify.runs.map((r) => r.id)).toEqual([5001, 6120]);
    expect(snapshot.verify.complete).toBe(true);
    expect(calls.rest.some((p) => p.includes('check-suites/1201/check-runs?check_name=osstack%2Fverify&filter=all&per_page=100&page=1'))).toBe(true);
    expect(calls.rest.some((p) => p.includes('check-suites/1202/check-runs'))).toBe(true);
  });

  it('pages the run list of a producer suite beyond 100 runs and the suite list itself', async () => {
    const w = makeWorld();
    w.suites[APP.actions] = Array.from({ length: 130 }, (_, i) => 100 + i);
    for (let i = 0; i < 130; i += 1) w.runs[100 + i] = [];
    w.runs[100] = Array.from({ length: 120 }, (_, i) => run(7000 + i, `n${i}`, APP.actions));
    w.runs[101] = [run(8000, 'check', APP.actions), run(8001, 'build', APP.actions)];
    const { snapshot, calls } = await snap(w);
    expect(calls.rest.some((p) => p.includes('app_id=15368&per_page=100&page=2'))).toBe(true);
    expect(calls.rest.some((p) => p.includes('check-suites/100/check-runs?filter=all&per_page=100&page=2'))).toBe(true);
    expect(snapshot.required_runs.runs.map((r) => r.name).sort()).toEqual(['build', 'check']);
  });

  it('a suite list that is full at the page cap is incomplete', async () => {
    const w = makeWorld();
    w.suites[APP.evidence] = Array.from({ length: 1000 }, (_, i) => 100 + i);
    for (const id of w.suites[APP.evidence]!) w.runs[id] = [];
    const { snapshot } = await snap(w, { maxPages: 10, maxRequests: 500 });
    expect(snapshot.verify.complete).toBe(false);
    expect(evaluateMergeGates({ evidence, snapshot, second: null, registry }).codes).toContain('U.read_incomplete:G3');
  });

  it('a failing suite request is incomplete (no stderr, no throw)', async () => {
    const w = makeWorld();
    w.failRest.push({ match: /check-suites\?app_id=12/u, result: { ok: false, status: 502, branchNotProtected: false } });
    const { snapshot } = await snap(w);
    expect(snapshot.verify.complete).toBe(false);
    const w2 = makeWorld();
    w2.runs[1] = [{ id: 'bad' }] as never;
    expect((await snap(w2)).snapshot.required_runs.complete).toBe(false);
  });

  it('foreign-app osstack/verify and wrong external ids surface through the M-A gates', async () => {
    const w = makeWorld();
    w.runs[1201] = [run(5001, 'osstack/verify', APP.evidence, { external_id: 'cm_other:x' })];
    expect((await verdict(w)).verdict?.codes).toContain('G3.missing');
    const w2 = makeWorld();
    w2.runs[1201] = [run(5001, 'osstack/verify', APP.evidence, { external_id: `${MISSION}:${HEAD}`, conclusion: 'failure' }), run(5002, 'osstack/verify', APP.evidence, { external_id: `${MISSION}:${HEAD}` })];
    expect((await verdict(w2)).verdict?.codes).toContain('G3.not_success:failure');
  });

  it('required runs: latest id decides; missing and non-success are refused', async () => {
    const w = makeWorld();
    w.runs[1] = [run(11, 'check', APP.actions, { conclusion: 'failure' }), run(13, 'check', APP.actions), run(12, 'build', APP.actions, { conclusion: 'skipped' })];
    const codes = (await verdict(w)).verdict?.codes ?? [];
    expect(codes).toContain('G4.not_success:build:skipped');
    expect(codes).not.toContain('G4.not_success:check:failure');
    w.runs[1] = [run(11, 'check', APP.actions)];
    expect((await verdict(w)).verdict?.codes).toContain('G4.missing:build');
  });
});

describe('rules, protection and rulesets', () => {
  it('required checks and the pull_request rule come from rules/branches/<base>, with their ruleset ids', async () => {
    const { snapshot } = await snap(makeWorld());
    expect(snapshot.base_rules.complete).toBe(true);
    expect(snapshot.base_rules.status_checks).toEqual([
      { context: 'check', integration_id: APP.actions, ruleset_id: IDS.quality },
      { context: 'build', integration_id: APP.actions, ruleset_id: IDS.quality },
    ]);
    expect(snapshot.base_rules.pull_request).toEqual({ ruleset_id: IDS.quality, required_approving_review_count: 1, require_last_push_approval: true, required_review_thread_resolution: true, dismiss_stale_reviews_on_push: true });
  });

  it('a required check without an integration id is null; a duplicate from another ruleset is kept for G4.checks_bypassable', async () => {
    const w = makeWorld();
    w.baseRules.push({ type: 'required_status_checks', ruleset_id: 999, parameters: { required_status_checks: [{ context: 'check' }] } });
    const { snapshot } = await snap(w);
    expect(snapshot.base_rules.status_checks).toContainEqual({ context: 'check', integration_id: null, ruleset_id: 999 });
    const codes = evaluateMergeGates({ evidence, snapshot, second: null, registry }).codes;
    expect(codes).toContain('G4.checks_bypassable');
  });

  it('a pull_request rule from another ruleset only is not the quality one', async () => {
    const w = makeWorld();
    w.baseRules = w.baseRules.filter((r) => r['type'] !== 'pull_request').concat([{ type: 'pull_request', ruleset_id: 999, parameters: { required_approving_review_count: 2 } }]);
    const { snapshot } = await snap(w);
    expect(snapshot.base_rules.pull_request?.ruleset_id).toBe(999);
    expect((await verdict(w)).verdict?.codes).toContain('G6.platform_rules_missing');
  });

  it('malformed rule parameters make the base rules incomplete', async () => {
    const w = makeWorld();
    w.baseRules.push({ type: 'required_status_checks', ruleset_id: IDS.quality, parameters: { nope: 1 } });
    expect((await snap(w)).snapshot.base_rules.complete).toBe(false);
  });

  it('rules pages beyond 100', async () => {
    const w = makeWorld();
    w.baseRules = [...Array.from({ length: 120 }, () => ({ type: 'deletion', ruleset_id: IDS.quality })), ...w.baseRules];
    const { snapshot, calls } = await snap(w);
    expect(snapshot.base_rules.complete).toBe(true);
    expect(calls.rest.some((p) => p.includes('rules/branches/main?per_page=100&page=2'))).toBe(true);
  });

  it('classic protection: any 404 = none; 403, 500 and malformed = failed', async () => {
    const w = makeWorld();
    expect((await snap(w)).snapshot.base_rules.legacy).toEqual({ read: 'not_protected', checks: [], contexts: [] });
    w.protection = { ok: false, status: 404, branchNotProtected: false };
    expect((await snap(w)).snapshot.base_rules.legacy.read).toBe('not_protected');
    for (const result of [{ ok: false, status: 403, branchNotProtected: false }, { ok: false, status: 500, branchNotProtected: false }, { ok: false, status: null, branchNotProtected: false }] as const) {
      w.protection = result;
      const { snapshot } = await snap(w);
      expect(snapshot.base_rules.legacy.read).toBe('failed');
      expect(evaluateMergeGates({ evidence, snapshot, second: null, registry }).codes).toContain('U.read_failed:G4.protection');
    }
    w.protection = { required_status_checks: 7 };
    expect((await snap(w)).snapshot.base_rules.legacy.read).toBe('failed');
  });

  it('classic protection with checks: app ids normalised, contexts without an App binding are reported', async () => {
    const w = makeWorld();
    w.protection = { required_status_checks: { contexts: ['check', 'legacy-status'], checks: [{ context: 'check', app_id: 15368 }, { context: 'free', app_id: -1 }, { context: 'none', app_id: null }] } };
    const { legacy } = (await snap(w)).snapshot.base_rules;
    expect(legacy).toEqual({ read: 'ok', checks: [{ context: 'check', app_id: 15368 }, { context: 'free', app_id: null }, { context: 'none', app_id: null }], contexts: ['legacy-status'] });
    w.protection = {};
    expect((await snap(w)).snapshot.base_rules.legacy).toEqual({ read: 'ok', checks: [], contexts: [] });
  });

  it('mission rules come from the ledger branch, with ids and types; a rule without a ruleset id is incomplete', async () => {
    const w = makeWorld();
    w.pr = { headRefName: 'main' }; // a hostile PR head name is never used for a path
    const { snapshot, calls } = await snap(w);
    expect(snapshot.mission_rules).toEqual({ complete: true, ruleset_ids: [IDS.writers, IDS.history].sort((a, b) => a - b), rule_types: ['creation', 'deletion', 'non_fast_forward', 'update'] });
    expect(calls.rest.some((p) => p.includes(`rules/branches/osstack%2Fmission%2F${MISSION}`))).toBe(true);
    w.missionRules.push({ type: 'deletion' });
    expect((await snap(w)).snapshot.mission_rules.complete).toBe(false);
  });

  it('an invalid ledger branch is never put in a path', async () => {
    const w = makeWorld();
    const s = serve(w);
    const r = await readMergeSnapshot({ graphql: s.graphql, rest: s.rest }, { ...evidence, branch: '../../x' }, registry);
    expect(r.ok && r.snapshot.mission_rules.complete).toBe(false);
    expect(s.calls.rest.some((p) => p.includes('..'))).toBe(false);
  });

  it('rulesets: bypass lists, coverage and enforcement are normalised; a missing bypass_actors field is null, not empty', async () => {
    const w = makeWorld();
    (w.rulesets[IDS.history] as Record<string, unknown>)['bypass_actors'] = undefined;
    delete (w.rulesets[IDS.history] as Record<string, unknown>)['bypass_actors'];
    const { snapshot } = await snap(w);
    expect(snapshot.rulesets[String(IDS.history)]?.bypass_actors).toBeNull();
    expect(snapshot.rulesets[String(IDS.writers)]).toEqual({
      enforcement: 'active', covers_mission_refs: true, covers_base_ref: false, rule_types: ['creation', 'update'],
      bypass_actors: [{ actor_type: 'Integration', actor_id: APP.publisher, bypass_mode: 'always' }],
    });
    expect(snapshot.rulesets[String(IDS.update)]).toMatchObject({ covers_base_ref: true, bypass_actors: [{ actor_type: 'Integration', actor_id: APP.merger, bypass_mode: 'pull_request' }] });
    expect(snapshot.rulesets[String(IDS.quality)]).toMatchObject({ covers_base_ref: true, covers_mission_refs: false, bypass_actors: [] });
    expect(evaluateMergeGates({ evidence, snapshot, second: null, registry }).codes).toContain('G6.last_push_unprovable:bypass');
  });

  it('~DEFAULT_BRANCH covers the base only when the default branch is the base', async () => {
    const w = makeWorld();
    w.defaultBranch = 'develop';
    expect((await snap(w)).snapshot.rulesets[String(IDS.update)]?.covers_base_ref).toBe(false);
    w.defaultBranch = null;
    expect((await snap(w)).snapshot.rulesets[String(IDS.update)]?.covers_base_ref).toBe(false);
  });

  it('coverage is strict: narrow globs and excludes do not cover the Mission refs', async () => {
    const w = makeWorld();
    const set = (include: string[], exclude: string[] = []) => { (w.rulesets[IDS.writers] as { conditions: unknown }).conditions = { ref_name: { include, exclude } }; };
    const covers = async () => (await snap(w)).snapshot.rulesets[String(IDS.writers)]?.covers_mission_refs;
    set(['refs/heads/osstack/mission/a*']);
    expect(await covers()).toBe(false);
    set(['refs/heads/osstack/mission/**'], ['refs/heads/osstack/mission/cm_x']);
    expect(await covers()).toBe(false);
    set(['refs/heads/osstack/*']);
    expect(await covers()).toBe(false);
    set(['refs/heads/**']); // a bare ** is not read as crossing directories in an include
    expect(await covers()).toBe(false);
    for (const ok of ['~ALL', 'refs/heads/**/*', 'refs/heads/osstack/**/*', 'refs/heads/osstack/mission/**', 'refs/heads/osstack/mission/*']) {
      set([ok]);
      expect(await covers()).toBe(true);
    }
    (w.rulesets[IDS.writers] as { target: string }).target = 'tag';
    expect(await covers()).toBe(false);
  });

  it('fnmatch details: **/ matches zero directories; classes and braces in an exclude fail closed, in an include never match', async () => {
    const w = makeWorld();
    const base = async (include: string[], exclude: string[]) => {
      (w.rulesets[IDS.update] as { conditions: unknown }).conditions = { ref_name: { include, exclude } };
      return (await snap(w)).snapshot.rulesets[String(IDS.update)]?.covers_base_ref;
    };
    expect(await base(['~ALL'], ['refs/heads/**/main'])).toBe(false);
    expect(await base(['~ALL'], ['refs/heads/m[ai]*'])).toBe(false);
    expect(await base(['~ALL'], ['refs/heads/{main,x}'])).toBe(false);
    expect(await base(['~ALL'], ['refs/heads/release/**'])).toBe(true);
    expect(await base(['~ALL'], ['refs/**'])).toBe(false); // an exclude's bare ** is read as crossing, so it excludes
    expect(await base(['refs/**'], [])).toBe(false);
    expect(await base(['refs/heads/m[ai]*'], [])).toBe(false);
    expect(await base(['refs/heads/**/main'], [])).toBe(true);
    expect(await base(['refs/heads/ma?n'], [])).toBe(true);
    expect(await base(['refs/heads/*'], [])).toBe(true);
    expect(await base(['refs/tags/**'], [])).toBe(false);
  });

  it('G8 end to end: App E listed for pull_request mode passes; App A listed or wrong mode fails', async () => {
    const w = makeWorld();
    expect((await verdict(w)).verdict?.verdict).toBe('would_merge');
    (w.rulesets[IDS.update] as { bypass_actors: unknown[] }).bypass_actors = [{ actor_id: APP.merger, actor_type: 'Integration', bypass_mode: 'always' }, { actor_id: APP.publisher, actor_type: 'Integration', bypass_mode: 'pull_request' }];
    const codes = (await verdict(w)).verdict?.codes;
    expect(codes).toEqual(expect.arrayContaining(['G8.merger_not_allowed', 'G8.publisher_allowed']));
  });

  it('ruleset 404 is an absent ruleset (M-A refuses); 403 and other failures make the dependent sections incomplete', async () => {
    const w = makeWorld();
    delete w.rulesets[IDS.update];
    const a = await snap(w);
    expect(a.snapshot.rulesets[String(IDS.update)]).toBeUndefined();
    expect(a.snapshot.base_rules.complete).toBe(true);
    expect(evaluateMergeGates({ evidence, snapshot: a.snapshot, second: null, registry }).codes).toContain('G8.ruleset_unverifiable');
    const w2 = makeWorld();
    w2.rulesets[IDS.update] = { ok: false, status: 403, branchNotProtected: false };
    expect((await snap(w2)).snapshot.base_rules.complete).toBe(false);
    expect((await verdict(w2)).verdict?.verdict).toBe('unevaluated');
    const w3 = makeWorld();
    w3.rulesets[IDS.update] = { ok: false, status: 500, branchNotProtected: false };
    expect((await snap(w3)).snapshot.base_rules.complete).toBe(false);
    const w4 = makeWorld();
    w4.rulesets[IDS.writers] = { enforcement: 7 };
    expect((await snap(w4)).snapshot.mission_rules.complete).toBe(false);
  });
});

describe('failures are fixed codes and never throw', () => {
  it('transport errors, GraphQL errors (even beside data), malformed pages and a missing PR', async () => {
    const base = async (hook: World['graphqlHook']) => {
      const w = makeWorld();
      if (hook) w.graphqlHook = hook;
      const s = serve(w);
      return readMergeSnapshot({ graphql: s.graphql, rest: s.rest }, evidence, registry);
    };
    expect(await base(() => { throw new Error('ghp_secret stderr'); })).toEqual({ ok: false, codes: ['U.read_failed:graphql_request'] });
    expect(await base(() => ({ data: {}, errors: [{ message: 'x' }] }))).toEqual({ ok: false, codes: ['U.read_failed:graphql_errors'] });
    expect(await base(() => ({ nope: 1 }))).toEqual({ ok: false, codes: ['U.read_failed:graphql_malformed'] });
    expect(await base(() => ({ data: { repository: { defaultBranchRef: null, ref: null, pullRequest: null } } }))).toEqual({ ok: false, codes: ['U.read_failed:pull_request_not_found'] });
  });

  it('a PR that moves between pages is U.snapshot_moved', async () => {
    const w = makeWorld();
    w.reviews = Array.from({ length: 150 }, (_, i) => review(i + 1, { state: 'COMMENTED' }));
    w.onPass = () => {};
    const s = serve(w);
    let n = 0;
    const inner = s.graphql;
    const r = await readMergeSnapshot({ graphql: async (q, v) => { n += 1; if (n === 2) w.pr = { headRefOid: 'f'.repeat(40) }; return inner(q, v); }, rest: s.rest }, evidence, registry);
    expect(r).toEqual({ ok: false, codes: ['U.snapshot_moved:graphql_pages'] });
  });

  it('the request cap: none left for GraphQL is a failed read; a cap during REST leaves sections incomplete', async () => {
    const w = makeWorld();
    expect(await readMergeSnapshot({ ...serve(w), limits: { maxRequests: 0 } }, evidence, registry)).toEqual({ ok: false, codes: ['U.read_failed:request_cap'] });
    const s = serve(w);
    const r = await readMergeSnapshot({ graphql: s.graphql, rest: s.rest, limits: { maxRequests: 4 } }, evidence, registry);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.issues).toContain('request_cap');
      expect(r.snapshot.required_runs.complete).toBe(false);
      expect(r.snapshot.base_rules.legacy.read).toBe('failed');
    }
  });

  it('a REST function that throws is an unreadable section, not an exception', async () => {
    const s = serve(makeWorld());
    const r = await readMergeSnapshot({ graphql: s.graphql, rest: async () => { throw new Error('boom'); } }, evidence, registry);
    expect(r.ok && r.snapshot.verify.complete).toBe(false);
  });
});

describe('REST method and path allowlist', () => {
  it('allows exactly the listed GET paths for the registered repository and rulesets', () => {
    const ok = [
      `repos/${REPO}/commits/${HEAD}/check-suites?app_id=12&per_page=100&page=1`,
      `repos/${REPO}/check-suites/12/check-runs?check_name=osstack%2Fverify&filter=all&per_page=100`,
      `repos/${REPO}/rules/branches/main?per_page=100&page=1`,
      `repos/${REPO}/rules/branches/osstack%2Fmission%2Fcm_x`,
      `repos/${REPO}/branches/main/protection`,
      `repos/${REPO}/rulesets/${IDS.quality}`,
    ];
    for (const p of ok) expect(() => assertRestPathAllowed(p, scope)).not.toThrow();
  });

  it('refuses every other path', () => {
    const bad = [
      `repos/other/r/commits/${HEAD}/check-suites`, `repos/${REPO}x/rulesets/${IDS.quality}`, `repos/${REPO}/rulesets/999`, `repos/${REPO}/rulesets`,
      `repos/${REPO}/commits/${HEAD}/check-runs`, `repos/${REPO}/pulls/7/merge`, `repos/${REPO}/pulls/7/reviews`, `repos/${REPO}/git/refs/heads/main`,
      `repos/${REPO}/issues/7/comments`, `repos/${REPO}/rules/branches/../../x`, `repos/${REPO}/rules/branches/a/../b`, `repos/${REPO}/rules/branches/a%2F..%2Fb`,
      `repos/${REPO}/branches/main/protection/enforce_admins`, `repos/${REPO}/rulesets/${IDS.quality}/x`, `/repos/${REPO}/rulesets/${IDS.quality}`,
      `https://api.github.com/repos/${REPO}/rulesets/${IDS.quality}`, `repos/${REPO}/commits/${HEAD}/check-suites?x=1#frag`, `repos/${REPO}/commits/${HEAD}/check-suites?a b`,
      `repos/${REPO}/commits/zzz/check-suites`, `user`, `graphql`, '',
    ];
    for (const p of bad) expect(() => assertRestPathAllowed(p, scope), p).toThrow('MERGER_READ_DENIED');
  });

  it('the argv is fixed: --method GET, no -f/-F/--input/-X', () => {
    const path = `repos/${REPO}/rulesets/${IDS.quality}`;
    const argv = restArgv(path);
    expect(argv).toEqual(['api', '--method', 'GET', path, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28']);
    expect(() => assertRestArgv(argv, scope)).not.toThrow();
    for (const flag of ['-f', '-F', '--input', '-X', '--field', '--raw-field']) expect(argv).not.toContain(flag);
  });

  it('refuses POST, PATCH, DELETE, -f/-F/--input and reordered or extended argv', () => {
    const path = `repos/${REPO}/rulesets/${IDS.quality}`;
    const good = restArgv(path);
    const variants: string[][] = [
      ['api', '--method', 'POST', path, '-H', good[5]!, '-H', good[7]!],
      ['api', '--method', 'PATCH', path, '-H', good[5]!, '-H', good[7]!],
      ['api', '--method', 'DELETE', path, '-H', good[5]!, '-H', good[7]!],
      ['api', '-X', 'PUT', path],
      [...good, '-f', 'a=b'], [...good, '-F', 'a=b'], [...good, '--input', 'x.json'], [...good, '-X', 'POST'],
      ['api', path], ['api', 'graphql', '-f', 'query={x}'], [], ['api', '--method', 'GET'],
      ['api', '--method', 'get', path, '-H', good[5]!, '-H', good[7]!],
    ];
    for (const v of variants) expect(() => assertRestArgv(v, scope), v.join(' ')).toThrow('MERGER_READ_DENIED');
  });

  it('ghRestGetTransport: runs only the fixed argv, refuses before exec, maps failures without gh stderr', async () => {
    const seen: string[][] = [];
    const path = `repos/${REPO}/rulesets/${IDS.quality}`;
    const exec = (out: { stdout: string; stderr: string; exitCode: number }) => async (args: readonly string[]) => { seen.push([...args]); return out; };
    expect(await ghRestGetTransport(scope, exec({ stdout: '{"a":1}', stderr: '', exitCode: 0 }))(path)).toEqual({ ok: true, body: { a: 1 } });
    expect(seen).toEqual([restArgv(path)]);
    expect(await ghRestGetTransport(scope, exec({ stdout: 'not json', stderr: '', exitCode: 0 }))(path)).toEqual({ ok: false, status: null, branchNotProtected: false });
    const prot = `repos/${REPO}/branches/main/protection`;
    expect(await ghRestGetTransport(scope, exec({ stdout: '{"message":"Branch not protected","status":"404"}', stderr: 'gh: Branch not protected (HTTP 404)', exitCode: 1 }))(prot)).toEqual({ ok: false, status: 404, branchNotProtected: true });
    expect(await ghRestGetTransport(scope, exec({ stdout: '', stderr: 'gh: Branch not protected (HTTP 404)', exitCode: 1 }))(prot)).toEqual({ ok: false, status: 404, branchNotProtected: true });
    const forbidden = await ghRestGetTransport(scope, exec({ stdout: '{"message":"Forbidden ghp_abc","status":403}', stderr: 'ghp_SECRET (HTTP 403)', exitCode: 1 }))(path);
    expect(forbidden).toEqual({ ok: false, status: 403, branchNotProtected: false });
    expect(JSON.stringify(forbidden)).not.toContain('ghp_');
    expect(await ghRestGetTransport(scope, exec({ stdout: '', stderr: 'gh: Not Found (HTTP 404)', exitCode: 1 }))(prot)).toEqual({ ok: false, status: 404, branchNotProtected: false });
    seen.length = 0;
    await expect(ghRestGetTransport(scope, exec({ stdout: '{}', stderr: '', exitCode: 0 }))(`repos/${REPO}/pulls/7/merge`)).rejects.toThrow('MERGER_READ_DENIED');
    expect(seen).toEqual([]);
  });

  it('the reader hands only allowlisted paths to an injected transport and turns a denial into a failed read', async () => {
    const s = serve(makeWorld());
    const r = await readMergeSnapshot({ graphql: s.graphql, rest: s.rest }, evidence, { ...registry, mission_ruleset_ids: [IDS.writers, IDS.history] });
    expect(r.ok).toBe(true);
    const evil = await readMergeSnapshot({ graphql: s.graphql, rest: s.rest }, evidence, { ...registry, base_ref: 'main/../x' });
    expect(evil).toEqual({ ok: false, codes: ['U.read_failed:base_ref'] });
    expect(OWNER).toBe(269);
  });
});

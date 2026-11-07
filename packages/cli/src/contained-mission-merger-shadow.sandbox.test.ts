// Sandbox merger corpus (merger design 5.4, M-D): a real time series recorded by scripts/sandbox-merger-scenario.mjs from a Mission PR published
// in the sandbox through the phase 3 publication path. One MergeSnapshot per scenario step, read right after the step with the shadow merger's
// own reader, then de-identified (contained-mission-merger-sandbox-fixture.ts). Replayed two ways: straight through evaluateMergeGates, and
// through the real MergerShadowReconciler (reader + store) over a synthetic GitHub rebuilt from the snapshot.
//
// What is NOT in the recording, and why (also listed in each fixture as `not_recorded`):
//   * would_merge control: it needs the counted human approval and thread resolution as the owner account. OWNER DECISION 5 (design section 8)
//     is open, so the scenario never acts as that account. Those cases are SYNTHETIC here: a recorded snapshot edited so that its only open
//     gaps are the ones the owner would close (owner approval on the live head, ready for review, CLEAN). Each such test says so.
//   * base moved and the workflow-file variant: the sandbox refuses both for the scenario Apps; synthetic mutations of a recorded snapshot.
// Expected values below come from the recorded facts (review authors, heads, thread counts), never from the decision code, which is only observed.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MergerShadowStore, evaluateMergeGates, mergerShadowWriter, type MergeSnapshot, type MergeVerdict, type MissionMergeEvidence } from '@osstack/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createRig, type Rig } from './contained-mission-bridge-shadow.testkit.js';
import type { MergerConfig } from './contained-mission-merger-config.js';
import { MergerShadowReconciler, MERGER_PR_OUTCOME_QUERY, MERGER_PR_STATE_QUERY, createMergerLedgerView, createMergerMissionView } from './contained-mission-merger-shadow.js';
import { assertMergerFixtureFile, FIXTURE_EPOCH_MS, type MergerFixtureFile, type MergerFixtureStep } from './contained-mission-merger-sandbox-fixture.js';
import type { GraphqlTransport, RestGet, RestResult } from './contained-mission-merger-reader.js';
import { evidencePayload } from './contained-mission-merger-shadow.testkit.js';

const MIN = 60_000;
const dirUrl = new URL('./__fixtures__/bridge/merger-sandbox/', import.meta.url);
const names = readdirSync(fileURLToPath(dirUrl)).filter((f) => f.endsWith('.json')).sort();
const loaded = names.map((name) => ({ name, pr: Number(/-(\d+)\.json$/u.exec(name)?.[1]), text: readFileSync(new URL(name, dirUrl), 'utf8') }));
const scriptText = readFileSync(new URL('../../../scripts/sandbox-merger-scenario.mjs', import.meta.url), 'utf8');

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach((fn) => { fn(); }); });

type Snapshot = MergeSnapshot;
const snapOf = (step: MergerFixtureStep): Snapshot => step.snapshot as unknown as Snapshot;
const evidenceOf = (file: MergerFixtureFile): MissionMergeEvidence => file.evidence as MissionMergeEvidence;

/** Expected outcome of each recorded step, derived from the recorded facts (see the fact checks in the test) and fixed here. */
const EXPECTED: Record<string, { verdict: 'refused'; codes: string[] }> = {
  // no review at all: draft PR, blocked, review required
  a_opened: { verdict: 'refused', codes: ['G6.no_counted_approval', 'G7.draft', 'G7.merge_state:BLOCKED', 'G7.review_decision:REVIEW_REQUIRED'] },
  // the test-reviewer App APPROVED the live head: an App approval never counts (P-5)
  b_app_approval: { verdict: 'refused', codes: ['G6.approval_by_app', 'G7.draft', 'G7.merge_state:BLOCKED', 'G7.review_decision:REVIEW_REQUIRED'] },
  // a COMMENT review with an inline comment: one unresolved thread, no change request
  c_thread_unresolved: { verdict: 'refused', codes: ['G6.approval_by_app', 'G6.unresolved_threads', 'G7.draft', 'G7.merge_state:BLOCKED', 'G7.review_decision:NONE'] },
  // the same App then requested changes
  d_changes_requested: { verdict: 'refused', codes: ['G6.approval_by_app', 'G6.changes_requested', 'G6.unresolved_threads', 'G7.draft', 'G7.merge_state:BLOCKED', 'G7.review_decision:NONE'] },
  // App A fast-forwarded the Mission branch: the live head is no longer the published one, and App B has no check on it
  e_head_moved: { verdict: 'refused', codes: ['G2.head_mismatch:candidate', 'G2.head_mismatch:evidence', 'G2.head_mismatch:marker', 'G2.head_mismatch:pushed', 'G3.missing',
    'G6.approval_by_app', 'G6.changes_requested', 'G6.unresolved_threads', 'G7.draft', 'G7.merge_state:BLOCKED', 'G7.review_decision:NONE'] },
  // closed, never merged
  g_closed: { verdict: 'refused', codes: ['G2.head_mismatch:candidate', 'G2.head_mismatch:evidence', 'G2.head_mismatch:marker', 'G2.head_mismatch:pushed', 'G3.missing',
    'G6.approval_by_app', 'G6.changes_requested', 'G6.unresolved_threads', 'G7.not_open'] },
};

const evaluate = (file: MergerFixtureFile, snapshot: Snapshot, second: Snapshot | null = null): MergeVerdict =>
  evaluateMergeGates({ evidence: evidenceOf(file), snapshot, second, registry: file.registry }) as MergeVerdict;

// ---- a synthetic GitHub rebuilt from a MergeSnapshot (the inverse of the reader), for the reconciler replay

function serveSnapshot(file: MergerFixtureFile, snapshot: Snapshot, mission: { id: string; spec: string }): { graphql: GraphqlTransport; rest: RestGet } {
  const S = snapshot;
  const rename = (v: string): string => v.split(file.evidence.mission_id).join(mission.id);
  const repoPath = `repos/${file.registry.repository}/`;
  const body = [`Contained Mission \`${rename(S.marker.first_line_id ?? 'none')}\`, opened by OSStack. Review before merging; OSStack never merges.`, '',
    ...(S.marker.marker ? [`<!-- osstack:mission v=1 id=${mission.id} spec_digest=${mission.spec} head=${S.marker.marker.head} start=${S.marker.marker.start} -->`] : [])].join('\n');
  const runs = [...new Map([...S.verify.runs, ...S.required_runs.runs].map((r) => [r.id, r])).values()];
  const files = S.files.workflow_paths_changed ? [{ path: '.github/workflows/x.yml', changeType: 'ADDED' }] : [{ path: 'scenario/x.md', changeType: 'ADDED' }];
  const conn = (nodes: unknown[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
  const actor = (type: string, id: number | null) => ({ __typename: type, databaseId: id });
  const graphql: GraphqlTransport = async (query, variables) => {
    if (query === MERGER_PR_STATE_QUERY) return { data: { repository: { pullRequest: { number: S.pr.number, state: S.pr.state, headRefOid: S.pr.head_oid } } } };
    if (query === MERGER_PR_OUTCOME_QUERY) {
      return { data: { repository: { pullRequest: { number: S.pr.number, state: S.pr.state, headRefOid: S.pr.head_oid, mergedAt: null, mergeCommit: null, mergedBy: null,
        reviews: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] } } } } };
    }
    const pr: Record<string, unknown> = {
      number: S.pr.number, state: S.pr.state, isDraft: S.pr.is_draft, mergeable: S.pr.mergeable, mergeStateStatus: S.pr.merge_state_status, reviewDecision: S.pr.review_decision, body,
      baseRepository: { nameWithOwner: S.pr.base_repository }, headRepository: { nameWithOwner: S.pr.head_repository }, isCrossRepository: S.pr.is_cross_repository,
      headRefName: S.pr.head_ref_name, baseRefName: S.pr.base_ref_name, headRefOid: S.pr.head_oid, changedFiles: files.length,
      author: S.pr.author ? actor(S.pr.author.type, S.pr.author.database_id) : null, baseRef: { target: S.pr.base_tip_oid ? { oid: S.pr.base_tip_oid } : null },
    };
    if (variables['reviews']) {
      pr['reviews'] = conn(S.reviews.items.map((r) => ({ databaseId: r.review_id, fullDatabaseId: null, state: r.state, submittedAt: new Date(r.submitted_at_ms).toISOString(),
        authorCanPushToRepository: r.author_can_push, commit: r.commit_oid ? { oid: r.commit_oid } : null, author: actor(r.author_type, r.author_id) })));
    }
    if (variables['threads']) pr['reviewThreads'] = conn(Array.from({ length: S.threads.unresolved }, (_, i) => ({ id: `t${i}`, isResolved: false })));
    if (variables['timeline']) pr['timelineItems'] = conn(file.steps.find((st) => snapOf(st) === S)?.timeline_events.map((__typename) => ({ __typename })) ?? Array.from({ length: S.timeline.force_push_events }, () => ({ __typename: 'HeadRefForcePushedEvent' })));
    if (variables['files']) pr['files'] = conn(files);
    return { data: { repository: { defaultBranchRef: { name: 'main' }, ref: { target: S.pr.base_tip_crosscheck_oid ? { oid: S.pr.base_tip_crosscheck_oid } : null }, pullRequest: pr } } };
  };
  const ok = (b: unknown): RestResult => ({ ok: true, body: b });
  const rulesetBody = (id: number): RestResult => {
    const r = S.rulesets[String(id)];
    if (!r) return { ok: false, status: 404, branchNotProtected: false };
    return ok({
      enforcement: r.enforcement, target: 'branch',
      conditions: { ref_name: { include: [...(r.covers_mission_refs ? ['refs/heads/osstack/mission/**'] : []), ...(r.covers_base_ref ? ['~DEFAULT_BRANCH'] : [])], exclude: [] } },
      rules: r.rule_types.map((type) => ({ type })), ...(r.bypass_actors === null ? {} : { bypass_actors: r.bypass_actors.map((b) => ({ actor_id: b.actor_id, actor_type: b.actor_type, bypass_mode: b.bypass_mode })) }),
    });
  };
  const rest: RestGet = async (path) => {
    const url = new URL(`https://x/${path}`);
    const p = decodeURIComponent(url.pathname.slice(1)).replace(repoPath, '');
    const q = url.searchParams;
    const suites = /^commits\/([0-9a-f]+)\/check-suites$/u.exec(p);
    const suiteRuns = /^check-suites\/(\d+)\/check-runs$/u.exec(p);
    const one = /^rulesets\/(\d+)$/u.exec(p);
    const page = Number(q.get('page') ?? 1);
    if (suites) return page > 1 || suites[1] !== S.pr.head_oid ? ok({ check_suites: [] }) : ok({ check_suites: [{ id: Number(q.get('app_id')) + 5000, app: { id: Number(q.get('app_id')) } }] });
    if (suiteRuns) {
      const app = Number(suiteRuns[1]) - 5000;
      const name = q.get('check_name');
      return ok({ check_runs: page > 1 ? [] : runs.filter((r) => r.app_id === app && (name === null || r.name === name)).map((r) => ({ id: r.id, name: r.name, app: { id: r.app_id }, external_id: r.external_id === null ? null : rename(r.external_id), head_sha: r.head_sha, status: r.status, conclusion: r.conclusion })) });
    }
    if (p === `rules/branches/${file.registry.base_ref}`) {
      const byRuleset = new Map<number | null, Array<{ context: string; integration_id: number | null }>>();
      for (const c of S.base_rules.status_checks) byRuleset.set(c.ruleset_id, [...(byRuleset.get(c.ruleset_id) ?? []), { context: c.context, integration_id: c.integration_id }]);
      return ok([
        ...[...byRuleset].map(([ruleset_id, list]) => ({ type: 'required_status_checks', ruleset_id, parameters: { required_status_checks: list } })),
        ...(S.base_rules.pull_request ? [{ type: 'pull_request', ruleset_id: S.base_rules.pull_request.ruleset_id, parameters: { ...S.base_rules.pull_request, ruleset_id: undefined } }] : []),
      ]);
    }
    if (p === `rules/branches/${file.evidence.branch}`) {
      return ok(S.mission_rules.ruleset_ids.flatMap((id) => (S.rulesets[String(id)]?.rule_types ?? []).filter((t) => S.mission_rules.rule_types.includes(t)).map((type) => ({ type, ruleset_id: id }))));
    }
    if (p === `branches/${file.registry.base_ref}/protection`) {
      const l = S.base_rules.legacy;
      return l.read === 'not_protected' ? { ok: false, status: 404, branchNotProtected: true } : l.read === 'failed' ? { ok: false, status: 403, branchNotProtected: false }
        : ok({ required_status_checks: { checks: l.checks, contexts: l.contexts } });
    }
    if (one) return rulesetBody(Number(one[1]));
    return { ok: false, status: 404, branchNotProtected: false };
  };
  return { graphql, rest };
}

interface Replay { store: MergerShadowStore; rig: Rig; scan(snapshot: Snapshot): Promise<void>; decisions(): Array<readonly [string, string[]]>; outcomes(): string[]; logs: string[]; mutating: string[] }

function startReplay(file: MergerFixtureFile): Replay {
  const rig = createRig();
  cleanup.push(() => { rig.close(); });
  const store = new MergerShadowStore(rig.attention, rig.owner);
  const e = file.evidence;
  let spec = '';
  const missionId = rig.seedMission({ pr_number: e.pr_number, head: e.head, base_head: e.base_head, branch: e.branch, evidence: (m) => { spec = m.spec_digest; return evidencePayload(m, { head: e.head, base_head: e.base_head, start_commit: e.start_commit }, e.pr_number, e.branch); } });
  const r = file.registry;
  const config: MergerConfig = { ...r, inspection_evidence: false, owner_reviewer_id: r.counted_approvers[0]!.actor_id, producers: [...new Set(r.required_checks.map((c) => c.app_id))].sort((a, b) => a - b) };
  const clock = { now: 1_800_000_000_000 };
  const logs: string[] = [];
  const mutating: string[] = [];
  let current: ReturnType<typeof serveSnapshot> | undefined;
  const graphql: GraphqlTransport = async (q, v) => { if (/mutation/iu.test(q)) mutating.push(q); return current!.graphql(q, v); };
  const rest: RestGet = async (p) => { if (/merge/iu.test(p)) mutating.push(p); return current!.rest(p); };
  const reconciler = new MergerShadowReconciler({ missions: createMergerMissionView(rig.missions), ledger: createMergerLedgerView(store), writer: mergerShadowWriter(store), graphql, rest, config,
    now: () => clock.now, log: (line) => { logs.push(line); } });
  const repo = r.repository;
  return {
    store, rig, logs, mutating,
    scan: async (snapshot) => { current = serveSnapshot(file, snapshot, { id: missionId, spec }); clock.now += 6 * MIN; await reconciler.scan(); },
    decisions: () => store.decisions(repo, e.pr_number).map((d) => [d.verdict, JSON.parse(d.codes_json) as string[]] as const),
    outcomes: () => store.outcomes(repo, e.pr_number).map((o) => o.outcome),
  };
}

// ---- synthetic would_merge: a recorded snapshot edited to what the owner's approval would add (REQUIRES OWNER DECISION 5 to be real)

function ownerApprovalCase(file: MergerFixtureFile): Snapshot {
  const base = structuredClone(snapOf(file.steps[0]!)) as Snapshot;
  const owner = file.registry.counted_approvers[0]!.actor_id;
  return {
    ...base,
    pr: { ...base.pr, is_draft: false, merge_state_status: 'CLEAN', review_decision: 'APPROVED' },
    reviews: { complete: true, items: [{ review_id: 90, state: 'APPROVED', submitted_at_ms: file.steps[0]!.observed_at + MIN, commit_oid: base.pr.head_oid, author_type: 'User', author_id: owner, author_can_push: true }] },
  };
}

describe('sandbox merger corpus', () => {
  it('has at least one recorded scenario, named after the sandbox repository', () => {
    expect(loaded.length).toBeGreaterThan(0);
    for (const l of loaded) expect(l.name).toMatch(/^osborn-studio-osstack-bridge-sandbox-\d+\.json$/u);
  });

  describe.each(loaded)('$name', ({ pr, text }) => {
    const file = assertMergerFixtureFile(JSON.parse(text));
    const steps = file.steps;
    const by = (label: string): MergerFixtureStep => steps.find((s) => s.label === label)!;

    // ---- the recording itself

    it('is a privacy-clean, allow-listed time series of the expected scenario', () => {
      expect(text).not.toMatch(/http|@/iu);
      expect(text).not.toMatch(/osstack-publisher|osstack-evidence|osstack-merger|sandbox-test-reviewer|gilosbornhello|osborn-studio|bridge-sandbox/iu);
      expect([...text.matchAll(/\b\d{4,}\b/gu)].map((m) => Number(m[0])).filter((n) => n < FIXTURE_EPOCH_MS)).toEqual([]); // no real id survives
      expect(file.evidence.pr_number).toBe(pr);
      expect(file.registry.repository).toBe('o/r');
      expect(steps.map((s) => s.label)).toEqual(['a_opened', 'b_app_approval', 'c_thread_unresolved', 'd_changes_requested', 'e_head_moved', 'g_closed']);
      expect(file.not_recorded.map((n) => n.label)).toEqual(['would_merge_control', 'base_moved', 'workflow_touched']);
      for (let i = 1; i < steps.length; i += 1) {
        expect(steps[i]!.observed_at).toBeGreaterThan(steps[i - 1]!.observed_at);
        // reviews are never edited or removed: every snapshot extends the previous one
        expect(snapOf(steps[i]!).reviews.items.slice(0, snapOf(steps[i - 1]!).reviews.items.length)).toEqual(snapOf(steps[i - 1]!).reviews.items);
      }
    });

    it('records the facts each step stands for', () => {
      const [a, b, c, d, e, g] = steps.map(snapOf) as [Snapshot, Snapshot, Snapshot, Snapshot, Snapshot, Snapshot];
      const head1 = a.pr.head_oid;
      expect(head1).toBe(file.evidence.head);
      expect(a).toMatchObject({ pr: { state: 'OPEN', is_draft: true, head_oid: head1 }, reviews: { items: [] }, threads: { unresolved: 0 } });
      expect(a.verify.runs).toHaveLength(1);
      expect(b.reviews.items.map((r) => [r.state, r.author_type, r.commit_oid])).toEqual([['APPROVED', 'Bot', head1]]);
      expect(c.reviews.items.map((r) => r.state)).toEqual(['APPROVED', 'COMMENTED']);
      expect(c.threads.unresolved).toBe(1);
      expect(d.reviews.items.map((r) => r.state)).toEqual(['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED']);
      expect(new Set(d.reviews.items.map((r) => r.author_id)).size).toBe(1); // one App did all of it
      expect(file.registry.counted_approvers.map((x) => x.actor_id)).not.toContain(d.reviews.items[0]!.author_id);
      expect(e.pr.head_oid).not.toBe(head1);
      expect(e.verify.runs).toHaveLength(0); // App B never posted on the new head
      expect(e.marker.marker?.head).toBe(head1);
      expect(g.pr.state).toBe('CLOSED');
      expect(by('g_closed').timeline_events).toEqual(['ClosedEvent']);
      expect(new Set(steps.map((s) => snapOf(s).pr.base_tip_oid)).size).toBe(1); // the base never moved
      expect(a.base_rules.pull_request).toMatchObject({ required_approving_review_count: 1, require_last_push_approval: true, required_review_thread_resolution: true, dismiss_stale_reviews_on_push: true });
    });

    // ---- replay through the pure gates

    it.each(Object.entries(EXPECTED))('step %s: the gates give the expected verdict and exactly the expected codes', (label, want) => {
      const v = evaluate(file, snapOf(by(label)));
      expect(v.verdict).toBe(want.verdict);
      expect(v.codes).toEqual(want.codes);
      expect(v.codes.some((c) => c.startsWith('U.') || c.startsWith('G4.') || c.startsWith('G5.') || c.startsWith('G8.') || c.startsWith('G1.'))).toBe(false);
    });

    it('never reaches would_merge on a recorded step: the sandbox cannot supply the counted human approval', () => {
      for (const s of steps) {
        const v = evaluate(file, snapOf(s), snapOf(s));
        expect(v.verdict).toBe('refused');
        expect(v.codes.some((c) => c.startsWith('G6.no_counted_approval') || c.startsWith('G6.approval_by_app') || c === 'G7.not_open')).toBe(true);
      }
    });

    it('recorded steps are cumulative: each adds the gate its step introduces and none adds a gate from another family before the head moves', () => {
      const codes = (label: string) => new Set(evaluate(file, snapOf(by(label))).codes);
      expect(codes('a_opened').has('G6.approval_by_app')).toBe(false);
      expect(codes('b_app_approval').has('G6.no_counted_approval')).toBe(false); // an App approval is explained, not "missing"
      expect(codes('c_thread_unresolved').has('G6.changes_requested')).toBe(false); // a thread alone, no change request yet
      expect(codes('d_changes_requested').has('G6.changes_requested')).toBe(true);
      for (const label of ['a_opened', 'b_app_approval', 'c_thread_unresolved', 'd_changes_requested']) expect([...codes(label)].some((c) => c.startsWith('G2.'))).toBe(false); // bound to the published head until step e
    });

    // ---- replay through the real reconciler (reader + store) over a synthetic GitHub rebuilt from each snapshot

    it('replays through the reconciler: the same verdicts and codes are recorded, the close becomes an outcome, and nothing mutating is ever sent', async () => {
      const rp = startReplay(file);
      const seen: Array<readonly [string, string[]]> = [];
      for (const label of Object.keys(EXPECTED).filter((l) => l !== 'g_closed')) {
        await rp.scan(snapOf(by(label)));
        const last = rp.decisions().at(-1)!;
        expect(last).toEqual([EXPECTED[label]!.verdict, EXPECTED[label]!.codes]);
        seen.push(last);
      }
      expect(rp.decisions().map((d) => d[0])).toEqual(['refused', 'refused', 'refused', 'refused', 'refused']); // five different code sets, no dedupe
      await rp.scan(snapOf(by('g_closed')));
      expect(rp.decisions()).toHaveLength(5); // a closed PR gets an outcome, not a decision
      expect(rp.outcomes()).toEqual(['closed_unmerged']);
      expect(rp.mutating).toEqual([]);
      expect(rp.logs.filter((l) => /scan_failed|decision_abandoned|outcome_rejected|unreadable/u.test(l))).toEqual([]);
      expect(seen).toHaveLength(5);
    });

    // ---- the cases the sandbox cannot produce: SYNTHETIC mutations of a recorded snapshot

    describe('synthetic (requires owner decision 5, or rights the scenario does not have)', () => {
      it('control: a recorded snapshot plus the owner approval on the live head is would_merge, bound to that head, and replays through the reconciler', async () => {
        const control = ownerApprovalCase(file);
        const v = evaluate(file, control, control);
        expect(v).toMatchObject({ verdict: 'would_merge', codes: [], request: { sha: control.pr.head_oid, merge_method: 'squash' } });
        expect(evaluate(file, control).codes).toEqual(['U.second_read_missing']); // without the second read it is not evaluable, never would_merge
        const rp = startReplay(file);
        await rp.scan(control);
        expect(rp.decisions()).toEqual([['would_merge', []]]);
        const row = rp.store.decisions(file.registry.repository, file.evidence.pr_number)[0]!;
        expect(JSON.parse(row.merge_request_json!)).toEqual({ sha: control.pr.head_oid, merge_method: 'squash' });
        expect(rp.mutating).toEqual([]);
      });

      const mutate = (edit: (s: Snapshot, file: MergerFixtureFile) => void): Snapshot => { const s = ownerApprovalCase(file); edit(s, file); return s; };
      const OTHER = 'f'.repeat(40);
      const cases: Array<[string, (s: Snapshot, f: MergerFixtureFile) => void, string[]]> = [
        ['base moved after publication', (s) => { s.pr.base_tip_oid = OTHER; s.pr.base_tip_crosscheck_oid = OTHER; }, ['G5.base_moved']],
        ['the PR touches a workflow file', (s) => { s.files.workflow_paths_changed = true; }, ['G4.workflow_paths_changed']],
        ['owner approval is on an older head', (s) => { s.reviews.items = s.reviews.items.map((r) => ({ ...r, commit_oid: OTHER })); }, ['G6.approval_stale_head']],
        ['an App approval only', (s) => { s.reviews.items = s.reviews.items.map((r) => ({ ...r, author_type: 'Bot' as const, author_id: 999 })); }, ['G6.approval_by_app']],
        ['an unresolved thread', (s) => { s.threads.unresolved = 1; }, ['G6.unresolved_threads']],
        ['a change request from an App stays in force', (s, f) => { s.reviews.items = [...s.reviews.items, { review_id: 91, state: 'CHANGES_REQUESTED', submitted_at_ms: f.steps[0]!.observed_at + 2 * MIN, commit_oid: s.pr.head_oid, author_type: 'Bot', author_id: 999, author_can_push: true }]; }, ['G6.changes_requested']],
        ['the owner withdraws the approval with a change request', (s, f) => { s.reviews.items = [...s.reviews.items, { ...s.reviews.items[0]!, review_id: 91, state: 'CHANGES_REQUESTED', submitted_at_ms: f.steps[0]!.observed_at + 2 * MIN }]; }, ['G6.changes_requested', 'G6.approval_superseded']],
        ['a required check is failing', (s) => { const r = s.required_runs.runs[0]!; s.required_runs.runs = [{ ...r, conclusion: 'failure' }, ...s.required_runs.runs.slice(1)]; }, [`G4.not_success:${'CTX'}:failure`]],
        ['still a draft', (s) => { s.pr.is_draft = true; }, ['G7.draft']],
        ['head drift: the live head is not the published one, so every head-bound party disagrees', (s) => { s.pr.head_oid = OTHER; },
          ['G2.head_mismatch:pushed', 'G2.head_mismatch:candidate', 'G2.head_mismatch:evidence', 'G2.head_mismatch:marker', 'G3.missing', 'G4.missing:*', 'G6.approval_stale_head']],
      ];
      it.each(cases)('%s -> refused with exactly the expected codes (the control has no other open gate)', (_name, edit, want) => {
        const s = mutate(edit);
        const v = evaluate(file, s, s);
        expect(v.verdict).toBe('refused');
        const context = s.required_runs.runs[0]!.name;
        const expand = (c: string): string[] => (c === 'G4.missing:*' ? file.registry.required_checks.map((r) => `G4.missing:${r.context}`) : [c.replace('CTX', context)]);
        expect(v.codes).toEqual(want.flatMap(expand).sort());
      });

      it('the second read must be identical: a thread that opens between the two reads is unevaluated, not would_merge', () => {
        const first = ownerApprovalCase(file);
        const second = structuredClone(first);
        second.threads.unresolved = 1;
        const v = evaluate(file, first, second);
        expect(v.verdict).toBe('unevaluated');
        expect(v.codes).toEqual(['U.snapshot_moved:threads']);
      });

      it('and a review that appears between the two reads is unevaluated too', () => {
        const first = ownerApprovalCase(file);
        const second = structuredClone(first);
        second.reviews.items = [...second.reviews.items, { review_id: 92, state: 'CHANGES_REQUESTED', submitted_at_ms: file.steps[0]!.observed_at + 3 * MIN, commit_oid: first.pr.head_oid, author_type: 'Bot', author_id: 999, author_can_push: true }];
        const v = evaluate(file, first, second);
        expect(v.verdict).toBe('unevaluated');
        expect(v.codes).toEqual(['U.snapshot_moved:reviews']);
      });
    });

    // ---- the scenario script itself

    it('the scenario script has no merge call, never mints or reads for App E, and never acts as the owner account', () => {
      expect(scriptText).not.toMatch(/pulls\/[^\s'"`]*merge|\bPUT\b|merge_method|[Aa]utoMerge|mergePullRequest/u);
      expect(scriptText.match(/const WRITES = \[[\s\S]*?\n\];/u)?.[0]).not.toMatch(/merge/iu);
      expect(scriptText).not.toMatch(/osstack-merger\.pem|appOf\(['"]osstack-merger|createInstallationTokenSource\(\s*merger/u);
      expect([...scriptText.matchAll(/appOf\('([a-z-]+)'\)/gu)].map((m) => m[1]).sort()).toEqual(['osstack-evidence', 'osstack-publisher', 'osstack-sandbox-test-reviewer']);
      expect(scriptText).not.toMatch(/gh['"],\s*\[\s*['"](?:pr|api)['"],\s*['"](?:review|merge)/u);
      expect(scriptText).not.toMatch(/resolveReviewThread|unresolveReviewThread|gh pr review|--approve/u);
      expect(scriptText).toMatch(/1446327922/u);
    });
  });
});

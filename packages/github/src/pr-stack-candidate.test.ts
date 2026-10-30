import { describe, expect, it } from 'vitest';
import type { DeliveryCommandRunner } from './delivery.js';
import { inspectPrStackCandidate, validatePrStackCandidateInput } from './pr-stack-candidate.js';

const oid = (pr: number) => pr.toString(16).padStart(40, '0');
const plan = { schema_version: 1 as const, repo: 'owner/repo', target_base: 'main', prs: [{ pr: 20, requiredChecks: ['test'] }, { pr: 7, requiredChecks: ['test'] }] };
interface Scenario { state?: string; finalState?: string; base?: string; finalHead?: string; conclusion?: string | null; unavailable?: boolean; review?: string | null; threads?: boolean; pages?: boolean }
function fixture(scenarios: Record<number, Scenario> = {}, advance?: () => void) {
  const calls: { command: string; args: readonly string[]; timeoutMs: number }[] = [];
  const seen = new Map<number, number>();
  const runner: DeliveryCommandRunner = { async run(command, args, options) {
    calls.push({ command, args, timeoutMs: options.timeoutMs });
    const get = (prefix: string) => args.find(a => a.startsWith(prefix))?.slice(prefix.length);
    const query = get('query=') ?? '';
    const pr = Number(get('number=') ?? Number.parseInt(get('oid=') ?? '0', 16));
    const s = scenarios[pr] ?? {};
    if (s.unavailable) return { stdout: '', stderr: 'offline unavailable', exitCode: 1 };
    let repository: unknown;
    const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: s.pages === true, endCursor: s.pages ? `cursor-${calls.length}` : null } });
    if (query.includes('CandidateFacts')) {
      const count = seen.get(pr) ?? 0; seen.set(pr, count + 1);
      repository = { nameWithOwner: 'owner/repo', pullRequest: { number: pr, url: `https://github.com/owner/repo/pull/${pr}`, state: count ? s.finalState ?? s.state ?? 'OPEN' : s.state ?? 'OPEN', isDraft: false,
        headRefOid: count ? s.finalHead ?? oid(pr) : oid(pr), baseRefOid: 'b'.repeat(40), headRefName: `branch-${pr}`, baseRefName: s.base ?? (pr === 7 ? 'branch-20' : 'main'),
        mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: s.review === undefined ? 'APPROVED' : s.review } };
    } else if (query.includes('CandidateChecks')) repository = { nameWithOwner: 'owner/repo', object: { oid: oid(pr), statusCheckRollup: { contexts: page([{ __typename: 'CheckRun', id: `check-${calls.length}`, name: 'test', status: 'COMPLETED', conclusion: s.conclusion === undefined ? 'SUCCESS' : s.conclusion, detailsUrl: null }]) } } };
    else repository = { nameWithOwner: 'owner/repo', pullRequest: { number: pr, reviewThreads: page(s.threads ? [{ id: `thread-${calls.length}`, isResolved: false, isOutdated: false, path: 'x.ts', line: 1 }] : []) } };
    advance?.();
    return { stdout: JSON.stringify({ data: { repository } }), stderr: '', exitCode: 0 };
  } };
  return { runner, calls };
}

describe('declared stack observations, not a Ready verdict', () => {
  it('preserves nonnumeric caller order and keeps lower failed PR ahead of upper green', async () => {
    const f = fixture({ 20: { conclusion: 'FAILURE' } });
    const result = await inspectPrStackCandidate(plan, f.runner);
    expect(result.report.order).toEqual([20, 7]); expect(result.report.frontier_pr).toBe(20);
    expect(result.report.status).toBe('frontier_observed'); expect(result.report.merge_authorized).toBe(false);
    expect(result.report.rows[0]?.blockers).toContain('check_failure');
    expect(result.report.rows[1]?.role).toBe('upstack');
    expect(result.report.rows[1]?.relation.status).toBe('parent_matches');
    expect(result.observations[1]?.observation?.snapshot.summary).toBe('no_observed_blocker');
    expect(f.calls).toHaveLength(8);
    expect(f.calls.every(c => c.command === 'gh' && c.args[0] === 'api' && c.args[1] === 'graphql')).toBe(true);
    expect(f.calls.flatMap(c => c.args).join(' ')).not.toMatch(/mutation|--watch|mergePullRequest/);
  });
  it.each(['main', 'branch-20'])('only skips a stable merged prefix; frontier base is %s', async base => {
    const f = fixture({ 20: { state: 'MERGED' }, 7: { base } });
    const { report } = await inspectPrStackCandidate(plan, f.runner);
    expect(report.frontier_pr).toBe(7); expect(report.rows[0]?.role).toBe('merged_prefix');
    expect(report.rows[1]?.relation.status).toBe(base === 'main' ? 'target_matches' : 'retarget_review_needed');
  });
  it.each([{ unavailable: true }, { finalHead: 'c'.repeat(40) }, { finalState: 'MERGED' }, { state: 'MERGED', finalState: 'OPEN' }, { state: 'FUTURE' }])('does not skip an uncertain lower candidate %j', async scenario => {
    const { report, observations } = await inspectPrStackCandidate(plan, fixture({ 20: scenario }).runner);
    expect(report.frontier_pr).toBe(20); expect(report.status).toBe('frontier_unknown');
    expect(report.rows[1]?.role).toBe('upstack'); expect(observations[1]?.observation).not.toBeNull();
    expect(report.rows[1]?.relation.status).toBe('unconfirmed');
  });
  it('closed without merge is a stop, not a merged prefix', async () => {
    const { report } = await inspectPrStackCandidate(plan, fixture({ 20: { state: 'CLOSED' } }).runner);
    expect(report.status).toBe('closed_unmerged'); expect(report.frontier_pr).toBe(20);
  });
  it('all stable merged observations complete only the observed list', async () => {
    const { report } = await inspectPrStackCandidate(plan, fixture({ 20: { state: 'MERGED' }, 7: { state: 'MERGED' } }).runner);
    expect(report.status).toBe('observed_all_merged'); expect(report.frontier_pr).toBeNull(); expect(report.merge_authorized).toBe(false);
  });
  it('branch mismatch is distinct from candidate summary and does not rewrite it', async () => {
    const { report, observations } = await inspectPrStackCandidate(plan, fixture({ 7: { base: 'unrelated' } }).runner);
    expect(report.rows[1]?.relation.status).toBe('inconsistent');
    expect(observations[1]?.observation?.snapshot.summary).toBe('no_observed_blocker');
  });
  it('keeps blockers, waiting and unknown axes together', async () => {
    const { report } = await inspectPrStackCandidate({ ...plan, prs: [{ pr: 20, requiredChecks: ['missing'] }] }, fixture({ 20: { conclusion: 'SKIPPED', review: 'REVIEW_REQUIRED', threads: true } }).runner);
    expect(report.rows[0]?.blockers).toContain('unresolved_threads'); expect(report.rows[0]?.waiting).toContain('review_required');
    expect(report.rows[0]?.unknowns).toEqual(expect.arrayContaining(['required_checks_missing', 'checks_not_success']));
  });
  it('expected pin mismatch cannot promote an observed merged lower PR', async () => {
    const { report } = await inspectPrStackCandidate({ ...plan, prs: [{ pr: 20, expectedHead: oid(999), expectedBase: 'b'.repeat(40) }, { pr: 7 }] }, fixture({ 20: { state: 'MERGED' } }).runner);
    expect(report.status).toBe('frontier_unknown'); expect(report.frontier_pr).toBe(20);
  });
  it('caps all three full paginated collectors at 24 actual requests', async () => {
    const f = fixture({ 20: { pages: true }, 7: { pages: true }, 9: { pages: true } });
    const { report, observations } = await inspectPrStackCandidate({ ...plan, prs: [...plan.prs, { pr: 9 }] }, f.runner);
    expect(f.calls).toHaveLength(24); expect(report.requests).toBe(24);
    expect(observations.every(o => o.observation?.snapshot.checks.complete === false)).toBe(true);
    expect(report.rows[0]?.unknowns).toContain('checks_incomplete');
  });
  it('total budget retains earlier rows and never drives later unobserved rows', async () => {
    let time = 0;
    const f = fixture({}, () => { time += 100000; });
    const { report, observations } = await inspectPrStackCandidate({ ...plan, prs: [...plan.prs, { pr: 9 }] }, f.runner, () => time);
    expect(f.calls).toHaveLength(3); expect(report.requests).toBe(3);
    expect(observations[0]?.observation?.raw).toHaveLength(1);
    expect(observations[2]?.observation).not.toBeNull(); // Third call used the remaining global budget.
    expect(report.status).toBe('frontier_unknown');
  });
  it('marks an unstarted row explicitly when global deadline is consumed', async () => {
    let time = 0;
    const f = fixture({}, () => { time = 270000; });
    const { observations, report } = await inspectPrStackCandidate(plan, f.runner, () => time);
    expect(f.calls).toHaveLength(1); expect(observations[1]).toEqual({ pr: 7, observation: null, issue: 'stack_budget_exhausted' });
    expect(report.rows[1]?.observation_status).toBe('not_observed');
  });
  it('uses only remaining global time for a later request', async () => {
    let time = 0;
    const f = fixture({}, () => { if (time === 0) time = 269995; });
    const result = await inspectPrStackCandidate(plan, f.runner, () => time);
    expect(result.dispatches.map(d => d.timeout_ms)).toEqual(f.calls.map(c => c.timeoutMs));
    expect(result.dispatches.every(d => d.pr === 20 || d.pr === 7)).toBe(true);
    expect(f.calls[0]?.timeoutMs).toBe(10000);
    expect(f.calls.slice(1).every(c => c.timeoutMs <= 5)).toBe(true);
  });
});

for (const bad of [
  { ...plan, schema_version: 2 }, { ...plan, extra: true }, { ...plan, prs: [] },
  { ...plan, prs: [{ pr: 1 }, { pr: 2 }, { pr: 3 }, { pr: 4 }] }, { ...plan, prs: [{ pr: 7 }, { pr: 7 }] },
  { ...plan, prs: [{ pr: 7, repo: 'other/repo' }] }, { ...plan, prs: [{ pr: 7, expectedHead: oid(7) }] },
  { ...plan, prs: [{ pr: 7, requiredChecks: ['x', 'x'] }] }, { ...plan, target_base: '' },
  { ...plan, target_base: 'main\nforged' }, { ...plan, target_base: 'a'.repeat(257) },
]) it(`rejects invalid plan before calls: ${JSON.stringify(bad)}`, async () => {
  const f = fixture();
  expect(() => validatePrStackCandidateInput(bad)).toThrow('invalid_stack_input');
  await expect(inspectPrStackCandidate(bad as typeof plan, f.runner)).rejects.toThrow('invalid_stack_input');
  expect(f.calls).toHaveLength(0);
});

it('a result arriving beyond the stack deadline cannot supply a stable frontier', async () => {
  let time = 0, count = 0;
  const f = fixture({}, () => { count += 1; if (count === 1) time = 200000; if (count === 5) time = 275000; });
  const { report, observations } = await inspectPrStackCandidate(plan, f.runner, () => time);
  expect(observations[1]?.observation?.raw).toHaveLength(4);
  expect(observations[1]?.issue).toBe('stack_budget_exhausted');
  expect(report.rows[1]?.unknowns).toContain('stack_budget_exhausted');
  expect(report.rows[1]?.relation.status).toBe('unconfirmed');
});

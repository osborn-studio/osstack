import { describe, expect, it } from 'vitest';
import { inspectPrCandidate, validatePrCandidateInput } from './pr-candidate-snapshot.js';
import type { DeliveryCommandRunner, DeliveryCommandResult } from './delivery.js';

const H = 'a'.repeat(40), B = 'b'.repeat(40);
const input = { repo: 'owner/repo', pr: 7, requiredChecks: ['test'] };
const facts = (overrides = {}) => ({ data: { repository: { nameWithOwner: 'owner/repo', pullRequest: {
  number: 7, url: 'https://github.com/owner/repo/pull/7', state: 'OPEN', isDraft: false,
  headRefOid: H, baseRefOid: B, headRefName: 'feature', baseRefName: 'main',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', ...overrides,
} } } });
const check = (overrides = {}) => ({ __typename: 'CheckRun', id: 'check-1', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: null, ...overrides });
const page = (nodes: unknown[], cursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } });
const checks = (nodes: unknown[] = [check()], cursor: string | null = null, oid = H) => ({ data: { repository: {
  nameWithOwner: 'owner/repo', object: { oid, statusCheckRollup: { contexts: page(nodes, cursor) } },
} } });
const threads = (nodes: unknown[] = [], cursor: string | null = null) => ({ data: { repository: {
  nameWithOwner: 'owner/repo', pullRequest: { number: 7, reviewThreads: page(nodes, cursor) },
} } });
function scripted(responses: unknown[]) {
  const calls: { command: string; args: readonly string[]; timeoutMs: number }[] = [];
  const runner: DeliveryCommandRunner = { async run(command, args, options) {
    calls.push({ command, args, timeoutMs: options.timeoutMs });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error('unexpected call');
    if (typeof response === 'object' && response !== null && 'commandResult' in response) return response.commandResult as DeliveryCommandResult;
    return { stdout: JSON.stringify(response), stderr: '', exitCode: 0 };
  } };
  return { runner, calls };
}
const stable = () => [facts(), checks(), threads(), facts()];

describe('required check names', () => {
  it('rejects every ASCII C0 control and DEL without contacting the forge', () => {
    const controls = Array.from({ length: 32 }, (_, code) => code).concat(127);
    for (const code of controls) {
      expect(() => validatePrCandidateInput({ ...input, requiredChecks: [`test${String.fromCharCode(code)}name`] })).toThrow('invalid_input');
    }
  });
  it('preserves spaces, printable ASCII and non-ASCII names under the existing contract', () => {
    const names = ['test name / suite', '~printable', '检查 🚦', `C1${String.fromCharCode(128)}`];
    expect(validatePrCandidateInput({ ...input, requiredChecks: names }).requiredChecks).toEqual(names);
  });
});

describe('one bounded candidate observation', () => {
  it('reports a stable observed clear candidate without granting authority', async () => {
    const { runner, calls } = scripted(stable());
    const { snapshot, queries, raw } = await inspectPrCandidate(input, runner);
    expect(snapshot.summary).toBe('no_observed_blocker');
    expect(snapshot.merge_authorized).toBe(false);
    expect(snapshot.binding.status).toBe('stable');
    expect(snapshot.forge_policy_coverage).toBe('not_collected');
    expect(queries).toHaveLength(4); expect(raw).toHaveLength(4);
    expect(calls.every(c => c.command === 'gh' && c.args[0] === 'api' && c.args[1] === 'graphql' && c.timeoutMs <= 10000)).toBe(true);
    expect(calls.flatMap(c => c.args).join(' ')).not.toMatch(/mutation|--watch|comments\(/);
  });
  it.each([{ headRefOid: 'c'.repeat(40) }, { baseRefOid: 'c'.repeat(40) }, { headRefName: 'renamed' }])('does not apply old green after identity changes %j', async change => {
    const { runner } = scripted([facts(), checks(), threads(), facts(change)]);
    expect((await inspectPrCandidate(input, runner)).snapshot.summary).toBe('candidate_changed');
  });
  it('rejects expected pins but retains actual observations', async () => {
    const { runner } = scripted(stable());
    expect((await inspectPrCandidate({ ...input, expectedHead: 'd'.repeat(40), expectedBase: B }, runner)).snapshot.summary).toBe('candidate_changed');
  });
  it('preserves conflict, failed check and unresolved outdated thread together', async () => {
    const { runner } = scripted([facts(), checks([check({ conclusion: 'FAILURE' })]), threads([{ id: 't1', isResolved: false, isOutdated: true, path: 'x.ts', line: 1 }]), facts({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', reviewDecision: 'CHANGES_REQUESTED' })]);
    const { snapshot } = await inspectPrCandidate(input, runner);
    expect(snapshot.summary).toBe('blocked');
    expect(snapshot.blockers).toEqual(expect.arrayContaining(['check_failure', 'unresolved_threads', 'changes_requested', 'merge_conflict']));
  });
  it.each(['SKIPPED', 'NEUTRAL', null, 'FUTURE_VALUE'])('does not call %s a successful required check', async conclusion => {
    const { runner } = scripted([facts(), checks([check({ conclusion })]), threads(), facts()]);
    expect((await inspectPrCandidate(input, runner)).snapshot.summary).toBe('unknown');
  });
  it('keeps a failed check visible beside a missing required name', async () => {
    const { runner } = scripted([facts(), checks([check({ conclusion: 'FAILURE' })]), threads(), facts()]);
    const { snapshot } = await inspectPrCandidate({ ...input, requiredChecks: ['test', 'missing'] }, runner);
    expect(snapshot.summary).toBe('blocked'); expect(snapshot.checks.missing_required).toEqual(['missing']);
  });
  it('does not infer policy from an unspecified required list', async () => {
    const { runner } = scripted(stable());
    expect((await inspectPrCandidate({ repo: input.repo, pr: 7 }, runner)).snapshot.summary).toBe('unknown');
  });
  it('rejects duplicate names as ambiguous even when both are green', async () => {
    const { runner } = scripted([facts(), checks([check(), check({ id: 'check-2' })]), threads(), facts()]);
    const { snapshot } = await inspectPrCandidate(input, runner);
    expect(snapshot.checks.ambiguous_required).toEqual(['test']);
    expect(snapshot.summary).toBe('unknown');
    expect(snapshot.unknowns).toContain('required_checks_ambiguous');
  });
  it('reads the unresolved thread on page two', async () => {
    const { runner } = scripted([facts(), checks(), threads([{ id: 'resolved', isResolved: true, isOutdated: false, path: 'a', line: null }], 'next'), threads([{ id: 'late', isResolved: false, isOutdated: false, path: 'b', line: 4 }]), facts()]);
    const { snapshot } = await inspectPrCandidate(input, runner);
    expect(snapshot.review.unresolved.map(t => t.id)).toEqual(['late']); expect(snapshot.summary).toBe('blocked');
  });
  it('caps three pages and retains partial rows without claiming completeness', async () => {
    const { runner, calls } = scripted([facts(), checks([check()], 'a'), checks([], 'b'), checks([], 'c'), threads(), facts()]);
    const { snapshot } = await inspectPrCandidate(input, runner);
    expect(snapshot.checks.complete).toBe(false); expect(snapshot.checks.issue).toBe('page_limit');
    expect(snapshot.summary).toBe('unknown'); expect(calls).toHaveLength(6);
  });
  it('detects a repeated cursor', async () => {
    const { runner } = scripted([facts(), checks([check()], 'a'), checks([], 'a'), threads(), facts()]);
    expect((await inspectPrCandidate(input, runner)).snapshot.checks.issue).toBe('cursor_progress');
  });
  it('does not use check rows from another commit', async () => {
    const { runner } = scripted([facts(), checks([check()], null, 'c'.repeat(40)), threads(), facts()]);
    const { snapshot } = await inspectPrCandidate(input, runner);
    expect(snapshot.checks.rows).toEqual([]); expect(snapshot.summary).toBe('unknown');
  });
  it('uses the latest review decision with stable candidate identity', async () => {
    const { runner } = scripted([facts(), checks(), threads(), facts({ reviewDecision: 'REVIEW_REQUIRED' })]);
    expect((await inspectPrCandidate(input, runner)).snapshot.summary).toBe('waiting');
  });
  it.each([null, { errors: [{ message: 'denied' }], ...facts() }, { data: { repository: null } }])('initial unavailable data is not a clear report %j', async response => {
    const { runner, calls } = scripted([response]);
    const { snapshot } = await inspectPrCandidate(input, runner);
    expect(snapshot.initial).toBe(null); expect(snapshot.summary).toBe('unknown'); expect(calls).toHaveLength(1);
  });
  it('final transport failure keeps initial scoped data but binding unknown', async () => {
    const { runner } = scripted([facts(), checks(), threads(), new Error('transport')]);
    const { snapshot } = await inspectPrCandidate(input, runner);
    expect(snapshot.binding.status).toBe('unknown'); expect(snapshot.summary).toBe('unknown');
    expect(snapshot.checks.rows).toHaveLength(1);
  });
  it('the whole budget stops calls while retaining prior observations', async () => {
    const { runner, calls } = scripted([facts()]);
    const times = [0, 1, 2, 3];
    const { snapshot, queries, raw } = await inspectPrCandidate(input, runner, () => times.shift() ?? 90000);
    expect(snapshot.summary).toBe('unknown'); expect(calls).toHaveLength(1);
    expect(snapshot.initial).toEqual(facts().data.repository.pullRequest);
    expect(snapshot.final).toBe(null); expect(snapshot.binding.status).toBe('unknown');
    expect(snapshot.checks.issue).toBe('budget_exhausted');
    expect(snapshot.review.threads.issue).toBe('budget_exhausted');
    expect(snapshot.unknowns).toContain('final_identity_unavailable');
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ label: 'initial', exit_code: 0, issue: null });
    expect(raw).toEqual([{ label: 'initial', stdout: JSON.stringify(facts()), stderr: '' }]);
  });

  it.each([
    ['SUCCESS', 'success', 'no_observed_blocker'], ['FAILURE', 'failure', 'blocked'],
    ['ERROR', 'failure', 'blocked'], ['PENDING', 'pending', 'waiting'], ['EXPECTED', 'unknown', 'unknown'],
  ] as const)('maps StatusContext %s independently of CheckRun fields', async (state, expectedState, summary) => {
    const context = { __typename: 'StatusContext', id: 'status-1', context: 'test', state, targetUrl: null };
    const { runner } = scripted([facts(), checks([context]), threads(), facts()]);
    const { snapshot } = await inspectPrCandidate(input, runner);
    expect(snapshot.checks.rows[0]).toMatchObject({ name: 'test', state: expectedState, raw: context });
    expect(snapshot.checks.missing_required).toEqual([]);
    expect(snapshot.summary).toBe(summary);
    if (state === 'PENDING') expect(snapshot.waiting).toContain('checks_pending');
  });
  it('reports a queued CheckRun with no conclusion as waiting', async () => {
    const { runner } = scripted([facts(), checks([check({ status: 'QUEUED', conclusion: null })]), threads(), facts()]);
    const { snapshot } = await inspectPrCandidate(input, runner);
    expect(snapshot.checks.rows[0]?.state).toBe('pending');
    expect(snapshot.waiting).toContain('checks_pending'); expect(snapshot.summary).toBe('waiting');
  });
  it('a missing required check alone cannot clear a stable candidate', async () => {
    const { runner } = scripted([facts(), checks([]), threads(), facts()]);
    const { snapshot } = await inspectPrCandidate(input, runner);
    expect(snapshot.checks.complete).toBe(true); expect(snapshot.checks.missing_required).toEqual(['test']);
    expect(snapshot.blockers).toEqual([]); expect(snapshot.summary).toBe('unknown');
  });
  it('matching expected head and base retain a stable observed result', async () => {
    const { runner } = scripted(stable());
    const { snapshot } = await inspectPrCandidate({ ...input, expectedHead: H, expectedBase: B }, runner);
    expect(snapshot.binding).toMatchObject({ status: 'stable', head: H, base: B, expected_head: H, expected_base: B });
    expect(snapshot.summary).toBe('no_observed_blocker'); expect(snapshot.merge_authorized).toBe(false);
  });
  it.each([
    { issue: 'command_failed', stdout: 'fixture failure', stderr: 'denied', exitCode: 1 },
    { issue: 'response_size', stdout: 'x'.repeat(1048577), stderr: '', exitCode: 0 },
    { issue: 'invalid_json', stdout: 'not JSON', stderr: '', exitCode: 0 },
    { issue: 'repository_mismatch', stdout: JSON.stringify({ data: { repository: { nameWithOwner: 'other/repo' } } }), stderr: '', exitCode: 0 },
  ])('retains raw $issue response but cannot use it as checks', async ({ issue, ...commandResult }) => {
    const { runner } = scripted([facts(), { commandResult }, threads(), facts()]);
    const { snapshot, queries, raw } = await inspectPrCandidate(input, runner);
    expect(snapshot.checks.complete).toBe(false); expect(snapshot.checks.issue).toBe(issue);
    expect(snapshot.checks.rows).toEqual([]); expect(snapshot.summary).toBe('unknown');
    expect(queries[1]).toMatchObject({ label: 'checks-1', issue, exit_code: commandResult.exitCode });
    expect(raw[1]).toEqual({ label: 'checks-1', stdout: commandResult.stdout, stderr: commandResult.stderr });
    expect(snapshot.initial?.headRefOid).toBe(H); expect(snapshot.final?.headRefOid).toBe(H);
  });
  it('duplicate check IDs across pages keep the first row but invalidate completeness', async () => {
    const { runner } = scripted([facts(), checks([check()], 'next'), checks([check()]), threads(), facts()]);
    const { snapshot } = await inspectPrCandidate(input, runner);
    expect(snapshot.checks.issue).toBe('duplicate_id'); expect(snapshot.checks.rows).toHaveLength(1);
    expect(snapshot.checks.complete).toBe(false); expect(snapshot.summary).toBe('unknown');
  });
  it('thread pages from the wrong PR cannot establish zero unresolved threads', async () => {
    const wrong = threads(); wrong.data.repository.pullRequest.number = 8;
    const { runner } = scripted([facts(), checks(), wrong, facts()]);
    const { snapshot } = await inspectPrCandidate(input, runner);
    expect(snapshot.review.threads.issue).toBe('pr_mismatch'); expect(snapshot.review.threads.complete).toBe(false);
    expect(snapshot.summary).toBe('unknown');
  });
  it('hasNextPage without a cursor preserves rows but cannot establish completeness', async () => {
    const wrong = checks(); wrong.data.repository.object.statusCheckRollup.contexts.pageInfo.hasNextPage = true;
    const { runner, calls } = scripted([facts(), wrong, threads(), facts()]);
    const { snapshot } = await inspectPrCandidate(input, runner);
    expect(snapshot.checks.issue).toBe('cursor_progress'); expect(snapshot.checks.rows).toHaveLength(1);
    expect(snapshot.checks.complete).toBe(false); expect(snapshot.summary).toBe('unknown'); expect(calls).toHaveLength(4);
  });
  it.each(['MERGED', 'CLOSED'])('observes terminal %s without erasing independent blockers or authorizing an action', async state => {
    const { runner } = scripted([facts(), checks([check({ conclusion: 'FAILURE' })]), threads(), facts({ state })]);
    const { snapshot } = await inspectPrCandidate(input, runner);
    expect(snapshot.summary).toBe(state.toLowerCase()); expect(snapshot.blockers).toContain('check_failure');
    expect(snapshot.merge_authorized).toBe(false);
  });
  it('null review decision is unknown even with successful checks', async () => {
    const { runner } = scripted([facts(), checks(), threads(), facts({ reviewDecision: null })]);
    const { snapshot } = await inspectPrCandidate(input, runner);
    expect(snapshot.unknowns).toContain('review_decision_unknown'); expect(snapshot.summary).toBe('unknown');
  });
  it.each([{ repo: '-bad/repo' }, { pr: 0 }, { expectedHead: H }, { requiredChecks: ['test', 'test'] }])('invalid input never invokes forge %j', async change => {
    const { runner, calls } = scripted([]);
    await expect(inspectPrCandidate({ ...input, ...change }, runner)).rejects.toThrow('invalid_input');
    expect(calls).toHaveLength(0);
  });
});

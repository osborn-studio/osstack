import { describe, expect, it } from 'vitest';
import { createActionsCiFailureReadDeps } from './contained-mission-local-failure-reader-transport.js';

const head = 'a'.repeat(40);
const repo = 'fixture/project';
const query = { repository: repo, pr: 7, head, app_id: 42, name: 'unit' };
const options = () => ({ signal: new AbortController().signal, maxPages: 3, maxRequests: 30 });
const run = (changes: Record<string, unknown> = {}) => ({ id: 90, workflow_id: 12, run_number: 3, run_attempt: 1,
  check_suite_id: 11, head_sha: head, repository: { full_name: repo }, head_repository: { full_name: repo }, ...changes });
const job = (changes: Record<string, unknown> = {}) => ({ id: 20, run_id: 90, run_attempt: 1, head_sha: head, name: 'unit',
  status: 'completed', conclusion: 'failure', check_run_url: `https://api.github.com/repos/${repo}/check-runs/101`, ...changes });
function world() {
  const rows = new Map<string, unknown>([
    [`repos/${repo}/actions/runs?head_sha=${head}&per_page=100&page=1`, { total_count: 1, workflow_runs: [run()] }],
    [`repos/${repo}/actions/runs/90/attempts/1/jobs?per_page=100&page=1`, { total_count: 1, jobs: [job()] }],
    [`repos/${repo}/check-runs/101`, { id: 101, name: 'unit', app: { id: 42 }, head_sha: head,
      check_suite: { id: 11 }, status: 'completed', conclusion: 'failure' }],
  ]);
  const calls: string[] = [];
  const deps = createActionsCiFailureReadDeps({ actionsAppId: 42, rest: async (path, { signal }) => {
    signal.throwIfAborted(); calls.push(path);
    return rows.has(path) ? { ok: true, body: rows.get(path) } : { ok: false };
  } });
  return { rows, calls, deps };
}

describe('authenticated Actions latest attempt transport', () => {
  it('returns workflow, matrix and runner facts only for the bound PR and protected workflow', async () => {
    const w = world();
    const base = 'b'.repeat(40);
    const runPath = `repos/${repo}/actions/runs?head_sha=${head}&per_page=100&page=1`;
    const attemptPath = `repos/${repo}/actions/runs/90/attempts/1/jobs?per_page=100&page=1`;
    w.rows.set(runPath, { total_count: 1, workflow_runs: [run({ event: 'pull_request', path: '.github/workflows/ci.yml', status: 'completed',
      pull_requests: [{ number: 7, head: { sha: head, ref: 'mission/1', repo: { id: 99 } }, base: { sha: base, ref: 'main', repo: { id: 99 } } }],
    })] });
    w.rows.set(attemptPath, { total_count: 1, jobs: [job({ labels: ['ubuntu-latest'],
      steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run tests', conclusion: 'failure' }],
    })] });
    const binding = { repositoryId: 99, base, baseRef: 'main', headRef: 'mission/1', workflowId: 12,
      workflowPath: '.github/workflows/ci.yml', runnerLabels: ['ubuntu-latest'], matrix: { node: '22' }, failureStep: 'Run tests' };
    await expect(w.deps.observeLatestJob(query, binding, options())).resolves.toMatchObject({
      outcome: 'failure', run_id: 90, workflow_id: 12, attempt: 1, check_run_id: 101,
      runner_labels: ['ubuntu-latest'], matrix: { node: '22' }, job_name: 'unit',
    });
    await expect(w.deps.observeLatestJob(query, { ...binding, base: head }, options())).resolves.toBeNull();
    await expect(w.deps.observeLatestJob(query, { ...binding, runnerLabels: ['macos-latest'] }, options())).resolves.toBeNull();
    await expect(w.deps.observeLatestJob(query, { ...binding, failureStep: 'Run a different job' }, options())).resolves.toMatchObject({ outcome: 'infrastructure_failure' });
  });
  it('rechecks an exact pre-merge success when GitHub clears the PR association', async () => {
    const w = world();
    const base = 'b'.repeat(40);
    const binding = { repositoryId: 99, base, baseRef: 'main', headRef: 'mission/1', workflowId: 12,
      workflowPath: '.github/workflows/ci.yml', runnerLabels: ['ubuntu-latest'], matrix: {}, failureStep: 'Run tests' };
    const workflow = { event: 'pull_request', path: binding.workflowPath, status: 'completed' };
    const association = { number: 7, head: { sha: head, ref: 'mission/1', repo: { id: 99 } },
      base: { sha: base, ref: 'main', repo: { id: 99 } } };
    const runPath = `repos/${repo}/actions/runs?head_sha=${head}&per_page=100&page=1`;
    w.rows.set(runPath, { total_count: 1, workflow_runs: [run({ ...workflow, pull_requests: [association] })] });
    w.rows.set(`repos/${repo}/actions/runs/90/attempts/1/jobs?per_page=100&page=1`, { total_count: 1, jobs: [job({
      conclusion: 'success', labels: ['ubuntu-latest'], steps: [{ name: 'Run tests', conclusion: 'success' }],
    })] });
    w.rows.set(`repos/${repo}/check-runs/101`, { id: 101, name: 'unit', app: { id: 42 }, head_sha: head,
      check_suite: { id: 11 }, status: 'completed', conclusion: 'success' });
    const observed = await w.deps.observeLatestJob(query, binding, options());
    expect(observed?.outcome).toBe('success');
    const preMerge = observed!;
    w.rows.set(runPath, { total_count: 1, workflow_runs: [run({ ...workflow, pull_requests: [] })] });
    await expect(w.deps.observeLatestJob(query, binding, options())).resolves.toBeNull();
    await expect(w.deps.observeLatestJob(query, { ...binding, preMerge }, options())).resolves.toEqual(preMerge);
    await expect(w.deps.observeLatestJob(query, { ...binding, preMerge: { ...preMerge, attempt: 2 } }, options())).resolves.toBeNull();
    w.rows.set(runPath, { total_count: 1, workflow_runs: [run({ ...workflow, pull_requests: [{ ...association, number: 8 }] })] });
    await expect(w.deps.observeLatestJob(query, { ...binding, preMerge }, options())).resolves.toBeNull();
  });
  it('maps exact job check URL to authenticated check identity and counts all reads', async () => {
    const w = world();
    expect(await w.deps.latestAttempt(query, options())).toEqual({ complete: true, requests_used: 4, ...query,
      latest: { check_suite_id: 11, check_run_id: 101, status: 'completed', conclusion: 'failure' } });
    expect(w.calls.every(path => !/logs|annotations/.test(path))).toBe(true);
  });
  it('supersedes a failed check with a queued retry that has no job yet', async () => {
    const w = world();
    w.rows.set(`repos/${repo}/actions/runs?head_sha=${head}&per_page=100&page=1`, { total_count: 1, workflow_runs: [run({ run_attempt: 2 })] });
    w.rows.set(`repos/${repo}/actions/runs/90/attempts/2/jobs?per_page=100&page=1`, { total_count: 0, jobs: [] });
    expect(await w.deps.latestAttempt(query, options())).toMatchObject({ complete: false });
  });
  it('uses workflow run_number rather than IDs or response order and checks the newest attempt', async () => {
    const w = world();
    w.rows.set(`repos/${repo}/actions/runs?head_sha=${head}&per_page=100&page=1`, { total_count: 2,
      workflow_runs: [run({ id: 999, run_number: 2 }), run({ run_attempt: 2 })] });
    w.rows.set(`repos/${repo}/actions/runs/90/attempts/2/jobs?per_page=100&page=1`, { total_count: 1, jobs: [job({ run_attempt: 2, status: 'in_progress', conclusion: null })] });
    w.rows.set(`repos/${repo}/check-runs/101`, { id: 101, name: 'unit', app: { id: 42 }, head_sha: head,
      check_suite: { id: 11 }, status: 'in_progress', conclusion: null });
    expect(await w.deps.latestAttempt(query, options())).toMatchObject({ complete: true, latest: { status: 'in_progress', conclusion: null } });
    expect(w.calls.some(path => path.includes('/999/'))).toBe(false);
  });
  it.each(['unsupported_app', 'partial', 'duplicate_job', 'foreign_url', 'wrong_app', 'wrong_head', 'duplicate_workflow_name'])('refuses %s', async kind => {
    const w = world(); const q = { ...query };
    if (kind === 'unsupported_app') q.app_id = 43;
    if (kind === 'partial') w.rows.set(`repos/${repo}/actions/runs?head_sha=${head}&per_page=100&page=1`, { total_count: 2, workflow_runs: [run()] });
    if (kind === 'duplicate_job') w.rows.set(`repos/${repo}/actions/runs/90/attempts/1/jobs?per_page=100&page=1`, { total_count: 2, jobs: [job(), job({ id: 21 })] });
    if (kind === 'foreign_url') w.rows.set(`repos/${repo}/actions/runs/90/attempts/1/jobs?per_page=100&page=1`, { total_count: 1, jobs: [job({ check_run_url: 'https://attacker.invalid/check-runs/101' })] });
    if (kind === 'wrong_app' || kind === 'wrong_head') w.rows.set(`repos/${repo}/check-runs/101`, { id: 101, name: 'unit', app: { id: kind === 'wrong_app' ? 43 : 42 }, head_sha: kind === 'wrong_head' ? 'b'.repeat(40) : head,
      check_suite: { id: 11 }, status: 'completed', conclusion: 'failure' });
    if (kind === 'duplicate_workflow_name') {
      w.rows.set(`repos/${repo}/actions/runs?head_sha=${head}&per_page=100&page=1`, { total_count: 2, workflow_runs: [run(), run({ id: 91, workflow_id: 13 })] });
      w.rows.set(`repos/${repo}/actions/runs/91/attempts/1/jobs?per_page=100&page=1`, { total_count: 1, jobs: [job({ id: 21, run_id: 91 })] });
    }
    expect(await w.deps.latestAttempt(q, options())).toMatchObject({ complete: false });
  });
  it('enforces the wire budget before another read', async () => {
    const w = world();
    expect(await w.deps.latestAttempt(query, { ...options(), maxRequests: 1 })).toMatchObject({ complete: false, requests_used: 1 });
    expect(w.calls).toHaveLength(1);
  });
  it('returns promptly when an uncooperative read is aborted', async () => {
    const controller = new AbortController();
    const deps = createActionsCiFailureReadDeps({ actionsAppId: 42, rest: async () => new Promise(() => {}) });
    const pending = deps.latestAttempt(query, { ...options(), signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ complete: false });
  });
});

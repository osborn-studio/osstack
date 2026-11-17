import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_CI_POLICY as policy } from './contained-mission-ci-policy.js';
import { readSandboxCiJobs } from './contained-mission-github-ci.js';
import { createActionsCiFailureReadDeps } from './contained-mission-local-failure-reader-transport.js';

const name = 'verify-portable-cli';
const base = 'a'.repeat(40);
const oldHead = 'b'.repeat(40);
const newHead = 'c'.repeat(40);
const branch = 'osstack/mission/portable';
const repo = { id: policy.repositoryId, full_name: policy.repository };
const app = { id: policy.actionsAppId };

function fixture() {
  let head = oldHead;
  let failureStep = 'Portable CLI verification';
  let changedBlob = '';
  const check = (jobName: string, i: number) => ({ id: 100 + i, name: jobName, app, head_sha: head,
    check_suite: { id: 11 }, status: 'completed', conclusion: head === oldHead && jobName === name ? 'failure' : 'success' });
  const ci = createActionsCiFailureReadDeps({ actionsAppId: app.id, rest: async path => {
    let body: unknown;
    if (path.endsWith('/pulls/7')) body = { number: 7, state: 'open', merged: false,
      head: { sha: head, ref: branch, repo }, base: { sha: base, ref: 'main', repo }, user: { id: policy.publisherActorId, type: 'Bot' } };
    else if (path.includes('/contents/')) body = { type: 'file', sha: path.endsWith(changedBlob) && changedBlob ? 'd'.repeat(40) : policy.workflowBlob };
    else if (path.includes('/check-suites?')) body = { total_count: 1, check_suites: [{ id: 11, app, head_sha: head }] };
    else if (path.includes('/check-runs?')) body = { total_count: policy.jobs.length, check_runs: policy.jobs.map((j, i) => check(j.name, i)) };
    else if (path.includes('/check-runs/')) body = policy.jobs.map((j, i) => check(j.name, i)).find(c => path.endsWith(`/${c.id}`));
    else if (path.includes('/actions/runs?')) body = { total_count: 1, workflow_runs: [{ id: head === oldHead ? 90 : 91,
      workflow_id: policy.workflowId, run_number: head === oldHead ? 1 : 2, run_attempt: 1, check_suite_id: 11,
      head_sha: head, repository: repo, head_repository: repo, event: 'pull_request', path: policy.workflowPath, status: 'completed',
      pull_requests: [{ number: 7, head: { sha: head, ref: branch, repo }, base: { sha: base, ref: 'main', repo } }] }] };
    else if (path.includes('/jobs?')) body = { total_count: policy.jobs.length, jobs: policy.jobs.map((j, i) => ({
      id: 200 + i, run_id: head === oldHead ? 90 : 91, run_attempt: 1, head_sha: head, name: j.name,
      status: 'completed', conclusion: check(j.name, i).conclusion, labels: j.runnerLabels,
      check_run_url: `https://api.github.com/repos/${policy.repository}/check-runs/${100 + i}`,
      steps: [{ name: j.name === name ? failureStep : j.failureStep, conclusion: check(j.name, i).conclusion }],
    })) };
    return body ? { ok: true, body } : { ok: false };
  } });
  return { read: () => readSandboxCiJobs(ci, { pr: 7, head, base, branch }, new AbortController().signal, undefined, policy),
    green: () => { head = newHead; }, infrastructure: (step: string) => { failureStep = step; },
    changeBlob: (ref: string) => { changedBlob = ref; } };
}

describe('production portable CLI policy and authenticated Actions reader', () => {
  it('pins the checked-in workflow blob and exact job contract', () => {
    const workflow = fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url));
    expect(policy.workflowBlob).toBe(execFileSync('git', ['hash-object', workflow], { encoding: 'utf8' }).trim());
    expect(policy.jobs.find(j => j.name === name)).toEqual({ name, matrix: {}, runnerLabels: ['ubuntu-latest'], failureStep: 'Portable CLI verification' });
  });
  it('registers the fixed assertion failure and re-verifies the same job on a new head', async () => {
    const f = fixture();
    expect(await f.read()).toMatchObject({ kind: 'failure', job: { job_name: name, head: oldHead, outcome: 'failure' } });
    f.green();
    const result = await f.read();
    expect(result.kind).toBe('success');
    if (result.kind === 'success') expect(result.jobs.find(j => j.job_name === name)).toMatchObject({ head: newHead, outcome: 'success', run_id: 91 });
  });
  it.each(['install', 'build'])('refuses %s failure as infrastructure', async step => {
    const f = fixture(); f.infrastructure(step);
    expect(await f.read()).toEqual({ kind: 'waiting', reason: 'job_infrastructure_failure' });
  });
  it.each([base, oldHead])('refuses workflow drift on ref %s', async ref => {
    const f = fixture(); f.changeBlob(ref);
    expect(await f.read()).toEqual({ kind: 'waiting', reason: 'workflow_binding_unavailable' });
  });
});

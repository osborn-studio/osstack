#!/usr/bin/env node
// Read-only GitHub evidence for one registered Mission PR. Raw responses stay in memory.
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const execFile = promisify(execFileCallback);
const source = new URL('../packages/cli/src/contained-mission-ci-policy.ts', import.meta.url);
const sha = /^[0-9a-f]{40}$/u;
const handoff = /^(osstack-sandbox-merge|osstack-ci-pilot-merge) ([0-9a-f]{40}) ([0-9a-f]{40})$/u;
// These values are checked against contained-mission-sandbox-app-e.ts by the test.
export const ACTORS = Object.freeze({ watcher: 243772068, merger: 352681958 });

export function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!['--repo', '--pr', '--mission-status', '--out'].includes(key) || !value || value.startsWith('--') || values.has(key)) throw Error('invalid arguments');
    values.set(key, value);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(values.get('--repo') ?? '') || !/^[1-9]\d*$/u.test(values.get('--pr') ?? '') || !values.has('--mission-status')) throw Error('required: --repo OWNER/NAME --pr N --mission-status FILE');
  return { repo: values.get('--repo'), pr: Number(values.get('--pr')), missionStatus: values.get('--mission-status'), out: values.get('--out') };
}

export async function loadPolicy(repo) {
  const code = ts.transpileModule(await readFile(source, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const policy = [module.SANDBOX_CI_POLICY, module.PRODUCTION_CI_POLICY, module.ALPHA_CI_POLICY].find(p => p.repository === repo);
  if (!policy) throw Error('repository has no registered CI policy');
  return policy;
}

export function githubQueryError(path, error) {
  const status = /HTTP\s+(\d{3})/u.exec(error.stderr ?? '')?.[1] ?? /HTTP\s+(\d{3})/u.exec(error.message ?? '')?.[1] ?? 'unknown';
  return Error(`GitHub query failed: ${path} (HTTP ${status})`);
}
async function gh(args) {
  const path = args[0] === 'graphql' ? 'graphql' : args.find(arg => arg.startsWith('repos/')) ?? 'unknown path';
  try {
    const { stdout } = await execFile('gh', ['api', ...args], { maxBuffer: 20 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) { throw githubQueryError(path, error); }
}
export function liveTransport() {
  return {
    get: path => gh(['--method', 'GET', path]),
    pages: async path => {
      const pages = await gh(['--method', 'GET', '--paginate', '--slurp', path]);
      if (!Array.isArray(pages) || pages.some(p => !Array.isArray(p))) throw Error(`incomplete pagination: ${path}`);
      return pages.flat();
    },
    objects: async (path, key) => {
      const pages = await gh(['--method', 'GET', '--paginate', '--slurp', path]);
      if (!Array.isArray(pages) || pages.some(p => !Array.isArray(p?.[key]))) throw Error(`incomplete pagination: ${path}`);
      const items = pages.flatMap(p => p[key]);
      if (items.length !== pages[0]?.total_count) throw Error(`incomplete pagination: ${path}`);
      return items;
    },
    query: (query, variables) => gh(['graphql', '-f', `query=${query}`, ...Object.entries(variables)
      .filter(([, value]) => value !== '').flatMap(([key, value]) => [key === 'number' ? '-F' : '-f', `${key}=${value}`])]),
  };
}

const threadQuery = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewDecision labels(first:100){nodes{name} pageInfo{hasNextPage endCursor}} reviewThreads(first:100,after:$after){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}`;
async function reviewState(api, repo, pr) {
  const [owner, name] = repo.split('/');
  let after = '', decision, labels = [], unresolved = 0;
  for (let page = 0; page < 100; page++) {
    const response = await api.query(threadQuery, { owner, name, number: pr, after });
    const node = response?.data?.repository?.pullRequest;
    if (response?.errors?.length || !node || !Array.isArray(node.reviewThreads?.nodes) || !Array.isArray(node.labels?.nodes)) throw Error('incomplete GraphQL review pagination');
    decision = node.reviewDecision;
    labels = node.labels.nodes.map(x => x.name);
    if (node.labels.pageInfo.hasNextPage) throw Error('incomplete label pagination');
    unresolved += node.reviewThreads.nodes.filter(x => !x.isResolved).length;
    if (!node.reviewThreads.pageInfo.hasNextPage) return { reviewDecision: decision, labels, unresolvedThreads: unresolved };
    if (!node.reviewThreads.pageInfo.endCursor || node.reviewThreads.pageInfo.endCursor === after) throw Error('incomplete review thread pagination');
    after = node.reviewThreads.pageInfo.endCursor;
  }
  throw Error('review thread pagination limit');
}

async function checksFor(api, repo, run) {
  const checks = await api.objects(`repos/${repo}/commits/${run.head_sha}/check-runs?per_page=100`, 'check_runs');
  return checks.filter(check => check.head_sha === run.head_sha && check.check_suite?.id === run.check_suite_id)
    .map(check => ({ name: check.name, id: check.id, checkRunId: check.id, status: check.status,
      conclusion: check.conclusion, appId: check.app?.id ?? null, startedAt: check.started_at,
      completedAt: check.completed_at }));
}
const latestRun = runs => [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0];
const runView = run => run && ({ id: run.id, workflowId: run.workflow_id, attempt: run.run_attempt, head: run.head_sha,
  status: run.status, conclusion: run.conclusion, createdAt: run.created_at, updatedAt: run.updated_at });
const interval = (a, b) => a && b ? Date.parse(b) - Date.parse(a) : null;

export async function collectEvidence(input, api = liveTransport(), policy) {
  const failures = [];
  const fail = reason => { if (!failures.includes(reason)) failures.push(reason); };
  const { repo, pr, missionStatus } = input;
  const selected = policy ?? await loadPolicy(repo);
  const mission = typeof missionStatus === 'string' ? JSON.parse(await readFile(missionStatus, 'utf8')) : missionStatus;
  const chain = mission.github_ci_chain ?? null;
  const [git] = await Promise.all([execFile('git', ['rev-parse', 'HEAD'])]);
  const result = { repository: repo, scriptCommit: git.stdout.trim(), missionId: mission.mission?.mission_id ?? null,
    scope: mission.mission?.scope_id ?? null, missionStatusReconstructed: !mission.mission,
    pr, prUrl: `https://github.com/${repo}/pull/${pr}`, githubCiChain: chain,
    initialHead: null, initialBase: null, failed: null, repairHead: null, pushCount: 0,
    pushCountBasis: 'distinct PR commit transitions; GitHub does not expose every push request', fastForward: false,
    requiredChecks: [], approval: null, reviewDecision: null, verified: false, unresolvedThreads: null,
    handoff: null, merger: null, mergeSha: null, mergeParents: [], timestamps: {}, intervalsMs: {}, qualified: false, failures };
  try {
    const [pull, commits, reviews, comments, review] = await Promise.all([
      api.get(`repos/${repo}/pulls/${pr}`), api.pages(`repos/${repo}/pulls/${pr}/commits?per_page=100`),
      api.pages(`repos/${repo}/pulls/${pr}/reviews?per_page=100`), api.pages(`repos/${repo}/issues/${pr}/comments?per_page=100`), reviewState(api, repo, pr),
    ]);
    if (!pull || !Array.isArray(commits) || commits.length === 0 || commits.length !== pull.commits) throw Error('missing PR or incomplete commits');
    result.initialHead = commits[0].sha;
    result.repairHead = commits.at(-1).sha;
    result.pushCount = commits.length - 1;
    result.fastForward = commits.length === 2 && commits[1].parents?.some(p => p.sha === commits[0].sha) === true && pull.head?.repo?.full_name === repo;
    if (result.pushCount !== 1) fail('repair push count is not one');
    if (!result.fastForward) fail('repair was not a fast-forward push on the same PR');
    const marker = comments.find(c => handoff.test(c.body ?? ''));
    if (marker) {
      const match = handoff.exec(marker.body);
      result.handoff = { id: marker.id, body: marker.body, createdAt: marker.created_at, updatedAt: marker.updated_at };
      result.initialBase = match[3];
      if (match[2] !== result.repairHead || marker.created_at !== marker.updated_at) fail('handoff does not bind repair head/base or was edited');
    } else fail('exact handoff comment missing');
    result.initialBase ??= pull.base?.sha ?? null;
    result.reviewDecision = review.reviewDecision;
    result.verified = review.labels.includes('verified');
    result.unresolvedThreads = review.unresolvedThreads;
    const approval = [...reviews].filter(r => r.state === 'APPROVED').at(-1);
    result.approval = approval ? { id: approval.id, authorId: approval.user?.id ?? null, authorType: approval.user?.type ?? null,
      state: approval.state, commitId: approval.commit_id, submittedAt: approval.submitted_at } : null;
    if (approval?.user?.id !== ACTORS.watcher || approval?.user?.type !== 'User' || approval.commit_id !== result.repairHead) fail('current-head watcher approval missing');
    if (result.reviewDecision !== 'APPROVED') fail('reviewDecision is not APPROVED');
    if (!result.verified) fail('verified label missing');
    if (result.unresolvedThreads !== 0) fail('unresolved review threads remain');
    const heads = [...new Set([result.initialHead, result.repairHead])];
    const runsByHead = new Map();
    for (const head of heads) runsByHead.set(head, (await api.objects(`repos/${repo}/actions/runs?head_sha=${head}&per_page=100`, 'workflow_runs'))
      .filter(r => r.workflow_id === selected.workflowId && r.head_sha === head));
    const initial = latestRun(runsByHead.get(result.initialHead));
    const repaired = latestRun(runsByHead.get(result.repairHead));
    const initialJobs = initial ? await checksFor(api, repo, initial) : [];
    const failedJob = initialJobs.find(j => j.conclusion === 'failure' && j.appId === selected.actionsAppId);
    result.failed = initial && failedJob ? { run: runView(initial), job: failedJob } : null;
    if (!result.failed) fail('initial head has no failed job from the Actions App latest attempt');
    const fixedJobs = repaired ? await checksFor(api, repo, repaired) : [];
    result.requiredChecks = selected.jobs.map(expected => ({ name: expected.name, run: runView(repaired),
      job: fixedJobs.find(j => j.name === expected.name) ?? null }));
    for (const check of result.requiredChecks) if (!check.job || check.job.conclusion !== 'success' || check.job.appId !== selected.actionsAppId || repaired?.status !== 'completed') fail(`required check failed or missing: ${check.name}`);
    result.merger = pull.merged_by ? { id: pull.merged_by.id, type: pull.merged_by.type } : null;
    result.mergeSha = pull.merge_commit_sha ?? null;
    if (!pull.merged_at || !result.mergeSha) fail('PR is not merged');
    if (result.merger?.id !== ACTORS.merger || result.merger?.type !== 'Bot') fail('merger is not App E actor');
    if (result.mergeSha) {
      const merge = await api.get(`repos/${repo}/commits/${result.mergeSha}`);
      result.mergeParents = merge.parents?.map(p => p.sha) ?? [];
      if (result.mergeParents.length !== 1 || result.mergeParents[0] !== result.initialBase) fail('squash parent differs from handoff base');
    }
    if (chain?.state !== 'closed') fail('Mission github_ci_chain is not closed');
    if (!result.mergeSha || chain?.merge_commit_sha !== result.mergeSha) fail('Mission merge SHA differs from GitHub');
    result.timestamps = { initialCommit: commits[0].commit?.author?.date ?? null, failureRun: initial?.updated_at ?? null,
      repairCommit: commits.at(-1).commit?.author?.date ?? null, repairedRun: repaired?.updated_at ?? null,
      approval: approval?.submitted_at ?? null, handoff: marker?.created_at ?? null, merged: pull.merged_at ?? null };
    const sequence = Object.entries(result.timestamps);
    result.intervalsMs = Object.fromEntries(sequence.slice(1).map(([key, value], i) => [`${sequence[i][0]}To${key}`, interval(sequence[i][1], value)]));
  } catch (error) { fail(`GitHub evidence incomplete: ${error.message}`); }
  result.qualified = failures.length === 0;
  return result;
}

async function main() {
  const input = parseArgs(process.argv.slice(2));
  const evidence = await collectEvidence(input);
  const data = `${JSON.stringify(evidence, null, 2)}\n`;
  if (input.out) await writeFile(input.out, data, { flag: 'wx', mode: 0o600 });
  else process.stdout.write(data);
  process.exitCode = evidence.qualified ? 0 : 1;
}
let direct = false;
try { direct = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { /* import only */ }
if (direct) main().catch(error => { console.error(error.message); process.exitCode = 2; });

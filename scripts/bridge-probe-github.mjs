#!/usr/bin/env node
// Bridge platform probes P-1 … P-12 (plan task 2.5, ADR-006). DESTRUCTIVE: pushes, opens and merges PRs, and leaves a
// Mission branch that the mission-history ruleset forbids deleting. It runs only against the sandbox repository that
// ADR-006 registers (name and numeric id), and refuses everything else before any write.
//
//   node scripts/bridge-probe-github.mjs --repo <owner/name> --apps-dir <dir> [--human-approver] [--out <file>]
//
// --apps-dir holds one private key per App, named <slug>.pem (ADR-006 decision 3 slugs); OSSTACK_BRIDGE_APPS_DIR is the
// fallback. --human-approver lets the `gh` CLI's own account approve probe PRs when an App approval does not count
// (probe P-5); without it those probes are recorded as inconclusive. Exit codes: 0 every probe met its expectation,
// 1 a probe did not, 2 usage or refusal.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProbeError, appJwt, assertSandbox, classify, codeGuarded, githubClient, parseRegistry, reason, record } from './lib/bridge-probe.mjs';
import { createScratchDir } from './lib/scratch.mjs';

const ADR = fileURLToPath(new URL('../docs/decisions/ADR-006-bridge-s0-decisions.md', import.meta.url));
const REQUIRED_CHECKS = ['check', 'graph-macos-fixtures (22)', 'graph-macos-fixtures (24)', 'graph-runtime-matrix (20.6.0)', 'graph-runtime-matrix (22.23.1)'];
const ACTIONS_APP_ID = 15368;

export function parseArgs(argv, env = process.env) {
  const opts = { humanApprover: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--human-approver') { opts.humanApprover = true; continue; }
    const key = { '--repo': 'repo', '--apps-dir': 'appsDir', '--out': 'out' }[arg];
    if (!key) throw new ProbeError('USAGE', `unknown argument ${arg}`);
    if (key in opts) throw new ProbeError('USAGE', `${arg} given twice`);
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new ProbeError('USAGE', `${arg} needs a value`);
    opts[key] = argv[i + 1]; i += 1;
  }
  opts.appsDir ??= env.OSSTACK_BRIDGE_APPS_DIR;
  if (!opts.repo) throw new ProbeError('USAGE', '--repo <owner/name> is required');
  if (!opts.appsDir) throw new ProbeError('USAGE', '--apps-dir <dir> (or OSSTACK_BRIDGE_APPS_DIR) is required');
  return opts;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Installation clients for every registered App, plus App-level (JWT) clients for P-9. */
async function connect(registry, appsDir, makeClient) {
  const apps = {};
  for (const [key, app] of Object.entries(registry.apps)) {
    const pem = await readFile(join(appsDir, `${app.slug}.pem`), 'utf8');
    const jwtClient = makeClient(`Bearer ${appJwt(app.appId, pem)}`);
    const token = await jwtClient.request('POST', `app/installations/${app.installationId}/access_tokens`);
    if (token.status !== 201) throw new ProbeError('AUTH_FAILED', `${key}: installation token HTTP ${token.status}`, 1);
    apps[key] = { ...app, jwt: jwtClient, api: makeClient(`token ${token.body.token}`) };
  }
  return apps;
}

/** The probe sequence. `apps` are clients per logical App; `human` is a client for the gh account or null. */
export async function runProbes({ repo, registry, apps, human, log = () => {}, ciTimeoutMs = 600_000, pollMs = 10_000 }) {
  const results = [];
  const A = apps['osstack-publisher'].api; const B = apps['osstack-evidence'].api; const C = apps['grok-pr-watcher'].api;
  const D = apps['grok-pr-reviewer'].api; const E = apps['osstack-merger'].api; const T = apps['osstack-sandbox-test-reviewer'].api;
  const run = `probe-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}`;
  const add = r => { results.push(r); log(`${r.pass ? 'ok  ' : 'FAIL'} ${r.id} ${r.attempt}: ${r.outcome}${r.status ? ` (${r.status})` : ''}${r.reason ? ` — ${r.reason}` : ''}`); return r; };
  const must = (r, what) => { if (r.status < 200 || r.status >= 300) throw new ProbeError('SETUP_FAILED', `${what}: HTTP ${r.status}`, 1); return r.body; };

  const mainSha = must(await E.request('GET', `repos/${repo}/git/ref/heads/main`), 'read main').object.sha;
  const mainTree = must(await E.request('GET', `repos/${repo}/git/commits/${mainSha}`), 'read main commit').tree.sha;
  /** A commit object made by App A on top of `parent` (objects are not ref-protected; ref updates are probed separately). */
  const commit = async (parent, baseTree, files, message) => {
    const tree = must(await A.request('POST', `repos/${repo}/git/trees`, { base_tree: baseTree, tree: files.map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })) }), 'create tree');
    return must(await A.request('POST', `repos/${repo}/git/commits`, { message, tree: tree.sha, parents: [parent] }), 'create commit').sha;
  };
  const branch = async (name, files, message) => {
    const sha = await commit(mainSha, mainTree, files, message);
    must(await A.request('POST', `repos/${repo}/git/refs`, { ref: `refs/heads/${name}`, sha }), `create ${name}`);
    return sha;
  };
  const openPr = async (head, title) => must(await A.request('POST', `repos/${repo}/pulls`, { title, head, base: 'main', body: `Bridge probe ${run} (plan 2.5). Not a real change.` }), `open PR ${head}`).number;
  const waitChecks = async (sha, want) => {
    const deadline = Date.now() + ciTimeoutMs;
    for (;;) {
      const r = must(await E.request('GET', `repos/${repo}/commits/${sha}/check-runs?per_page=100`), 'read check runs');
      const runs = r.check_runs.filter(c => c.app?.id === ACTIONS_APP_ID && REQUIRED_CHECKS.includes(c.name));
      if (runs.length >= REQUIRED_CHECKS.length && runs.every(c => c.status === 'completed')) {
        const ok = runs.every(c => c.conclusion === 'success');
        if (ok !== want) throw new ProbeError('SETUP_FAILED', `checks on ${sha.slice(0, 7)} ${ok ? 'passed' : 'failed'}, expected ${want ? 'pass' : 'fail'}`, 1);
        return;
      }
      if (Date.now() > deadline) throw new ProbeError('SETUP_FAILED', `checks on ${sha.slice(0, 7)} did not finish in time`, 1);
      await sleep(pollMs);
    }
  };
  const decision = async number => {
    const r = await E.graphql('query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewDecision mergeStateStatus}}}',
      { o: repo.split('/')[0], n: repo.split('/')[1], p: number });
    return r.body?.data?.repository?.pullRequest ?? {};
  };
  const approve = (client, number, sha) => client.request('POST', `repos/${repo}/pulls/${number}/reviews`, { commit_id: sha, event: 'APPROVE', body: `Bridge probe ${run} approval.` });
  const merge = (client, number, sha) => client.request('PUT', `repos/${repo}/pulls/${number}/merge`, { sha, merge_method: 'merge' });
  const opened = []; const branches = [];

  try {
    // P-9 first: the identities the rest relies on.
    for (const key of ['osstack-publisher', 'osstack-evidence']) {
      const app = await apps[key].jwt.request('GET', 'app');
      const inst = await apps[key].jwt.request('GET', `repos/${repo}/installation`);
      const same = app.body?.id === registry.apps[key].appId && inst.body?.id === registry.apps[key].installationId;
      add({ id: 'P-9', attempt: `${key} App id ${app.body?.id} and installation id ${inst.body?.id} match ADR-006`, expected: 'match', outcome: same ? 'match' : 'mismatch', status: inst.status, reason: '', pass: same });
    }

    // P-10, decision level: the same lookup and predicate as delivery.ts readEffectiveProtection, on a Mission branch that does not exist yet.
    const missionName = `osstack/mission/${run}`;
    const rules = await A.request('GET', `repos/${repo}/rules/branches/${missionName.split('/').map(encodeURIComponent).join('/')}`);
    const refused = Array.isArray(rules.body) && rules.body.length > 0;
    add({ id: 'P-10', attempt: `current publisher check on ${missionName}: ${Array.isArray(rules.body) ? rules.body.map(r => r.type).join(',') : 'n/a'}`, expected: 'refused', outcome: refused ? 'refused' : 'allowed', status: rules.status,
      reason: 'decision-level reproduction of delivery.ts (rules.length > 0 means protected, publish refused); the end-to-end rerun belongs to phase 3', pass: refused });

    // P-2 / P-3 / P-4: Mission branch writers and history.
    const m1 = await commit(mainSha, mainTree, [[`probe/${run}/mission.txt`, 'first\n']], `probe: ${run} mission first`);
    add(record('P-2', 'App A creates a Mission branch', 'allowed', await A.request('POST', `repos/${repo}/git/refs`, { ref: `refs/heads/${missionName}`, sha: m1 })));
    const m2 = await commit(m1, (await A.request('GET', `repos/${repo}/git/commits/${m1}`)).body.tree.sha, [[`probe/${run}/mission.txt`, 'second\n']], `probe: ${run} mission second`);
    add(record('P-2', 'App A fast-forwards the Mission branch', 'allowed', await A.request('PATCH', `repos/${repo}/git/refs/heads/${missionName}`, { sha: m2, force: false })));
    const other = await commit(mainSha, mainTree, [[`probe/${run}/other.txt`, 'other\n']], `probe: ${run} unrelated`);
    add(record('P-3', 'App A force-pushes the Mission branch', 'rejected', await A.request('PATCH', `repos/${repo}/git/refs/heads/${missionName}`, { sha: other, force: true })));
    add(record('P-3', 'App A deletes the Mission branch', 'rejected', await A.request('DELETE', `repos/${repo}/git/refs/heads/${missionName}`)));
    const m3 = await commit(m2, (await A.request('GET', `repos/${repo}/git/commits/${m2}`)).body.tree.sha, [[`probe/${run}/mission.txt`, 'third\n']], `probe: ${run} mission third`);
    add(record('P-4', 'App E fast-forwards the Mission branch', 'rejected', await E.request('PATCH', `repos/${repo}/git/refs/heads/${missionName}`, { sha: m3, force: false })));
    add(record('P-4', 'App E creates a Mission branch', 'rejected', await E.request('POST', `repos/${repo}/git/refs`, { ref: `refs/heads/${missionName}-e`, sha: m1 })));

    // Direct pushes to main.
    const onMain = await commit(mainSha, mainTree, [[`probe/${run}/direct.txt`, 'direct\n']], `probe: ${run} direct push`);
    add(record('P-1', 'App A pushes main directly', 'rejected', await A.request('PATCH', `repos/${repo}/git/refs/heads/main`, { sha: onMain, force: false })));
    add(record('P-11', '④ App E pushes main directly', 'rejected', await E.request('PATCH', `repos/${repo}/git/refs/heads/main`, { sha: onMain, force: false })));

    // P-8: App B has no contents or pull request permission.
    const scratchBranch = `probe/${run}/b`; branches.push(scratchBranch);
    const bSha = await branch(scratchBranch, [[`probe/${run}/b.txt`, 'b\n']], `probe: ${run} for App B`);
    const bNext = await commit(bSha, (await A.request('GET', `repos/${repo}/git/commits/${bSha}`)).body.tree.sha, [[`probe/${run}/b.txt`, 'b2\n']], `probe: ${run} App B push`);
    add(record('P-8', 'App B pushes an unprotected branch', 'rejected', await B.request('PATCH', `repos/${repo}/git/refs/heads/${scratchBranch}`, { sha: bNext, force: false })));

    // The green PR: P-1 (reviews, comments), P-11 ③, P-5, P-12, P-11 ①.
    const green = `probe/${run}/green`; branches.push(green);
    const greenSha = await branch(green, [[`probe/${run}/green.txt`, 'green\n']], `probe: ${run} green`);
    const greenPr = await openPr(green, `probe ${run}: green control`); opened.push(greenPr);
    add(record('P-8', 'App B comments on a PR', 'rejected', await B.request('POST', `repos/${repo}/issues/${greenPr}/comments`, { body: `probe ${run}: App B comment` })));
    await waitChecks(greenSha, true);
    add(record('P-1', 'App A approves its own PR', 'rejected', await approve(A, greenPr, greenSha)));
    const guarded = 'ADR-006 decision 3: GitHub lets App A comment and post COMMENT reviews; only the publisher code prevents it';
    add(codeGuarded(record('P-1', 'App A posts a COMMENT review', 'rejected', await A.request('POST', `repos/${repo}/pulls/${greenPr}/reviews`, { commit_id: greenSha, event: 'COMMENT', body: `probe ${run}: App A review` })), guarded));
    add(codeGuarded(record('P-1', 'App A posts a PR comment', 'rejected', await A.request('POST', `repos/${repo}/issues/${greenPr}/comments`, { body: `probe ${run}: App A comment` })), guarded));
    add(record('P-11', '③ App E merges a green PR with no approval', 'rejected', await merge(E, greenPr, greenSha)));

    // P-5 is decided by the merge itself, not by reviewDecision alone (which can lag right after a review).
    must(await approve(T, greenPr, greenSha), 'test-review App approves');
    await sleep(Math.min(pollMs, 5_000));
    const afterApp = await decision(greenPr);
    // App A tries first; its attempt counts as P-12 only if the approval in place turns out to count (App E then merges).
    const aFirst = await merge(A, greenPr, greenSha);
    const appOnly = await merge(E, greenPr, greenSha);
    const appCounts = appOnly.status === 200;
    add({ id: 'P-5', attempt: `test-review App APPROVE alone lets App E merge (reviewDecision ${afterApp.reviewDecision ?? 'n/a'})`, expected: 'record',
      outcome: appCounts ? 'counted' : 'not-counted', status: appOnly.status, reason: reason(appOnly), pass: classify(appOnly) !== 'error', counted: appCounts });
    let approver = appCounts ? T : null;
    let aMerge = appCounts ? aFirst : null;
    if (appCounts) {
      add(record('P-11', '① App E merges an approved green PR (control; approval from the test-review App)', 'allowed', appOnly));
      opened.splice(opened.indexOf(greenPr), 1);
    } else if (human) {
      const h = await approve(human, greenPr, greenSha);
      if (h.status === 200) approver = human;
      add(record('P-5', 'fallback: the gh account approves', 'allowed', h));
      if (approver) {
        aMerge = await merge(A, greenPr, greenSha);
        const control = add(record('P-11', '① App E merges an approved green PR (control; approval from the gh account)', 'allowed', await merge(E, greenPr, greenSha)));
        if (control.outcome === 'allowed') opened.splice(opened.indexOf(greenPr), 1);
      }
    }
    if (aMerge) {
      add(record('P-12', 'App A merges an approved green PR', 'rejected', aMerge));
      add(record('P-1', 'App A merges a PR (same attempt as P-12)', 'rejected', aMerge));
    } else {
      for (const [id, attempt] of [['P-12', 'App A merges an approved green PR'], ['P-11', '① App E merges an approved green PR (control)']]) {
        add({ id, attempt, expected: 'n/a', outcome: 'inconclusive', status: null, reason: 'no approval that counts (P-5); rerun with --human-approver', pass: false });
      }
    }

    // P-11 ②: failing checks, approved.
    const failing = `probe/${run}/fail`; branches.push(failing);
    const failSha = await branch(failing, [['PROBE_FAIL', `${run}\n`]], `probe: ${run} failing checks`);
    const failPr = await openPr(failing, `probe ${run}: failing checks`); opened.push(failPr);
    await waitChecks(failSha, false);
    if (approver) {
      must(await approve(approver, failPr, failSha), 'approve failing PR');
      add(record('P-11', '② App E merges an approved PR with failing checks', 'rejected', await merge(E, failPr, failSha)));
    } else add({ id: 'P-11', attempt: '② App E merges an approved PR with failing checks', expected: 'n/a', outcome: 'inconclusive', status: null, reason: 'no approval that counts', pass: false });

    // P-7: Actions skipped; App C posts all five required check names as success.
    const skipped = `probe/${run}/impostor`; branches.push(skipped);
    const skipSha = await branch(skipped, [[`probe/${run}/impostor.txt`, 'impostor\n']], `probe: ${run} impostor checks [skip ci]`);
    const skipPr = await openPr(skipped, `probe ${run}: impostor checks`); opened.push(skipPr);
    for (const name of REQUIRED_CHECKS) must(await C.request('POST', `repos/${repo}/check-runs`, { name, head_sha: skipSha, status: 'completed', conclusion: 'success' }), `App C posts ${name}`);
    await sleep(pollMs);
    const actionsRuns = (await E.request('GET', `repos/${repo}/commits/${skipSha}/check-runs?per_page=100`)).body?.check_runs?.filter(c => c.app?.id === ACTIONS_APP_ID) ?? [];
    if (actionsRuns.length) add({ id: 'P-7', attempt: 'App C check runs named like the required checks', expected: 'n/a', outcome: 'inconclusive', status: null, reason: 'Actions ran despite [skip ci]', pass: false });
    else if (approver) {
      must(await approve(approver, skipPr, skipSha), 'approve impostor PR');
      const state = await decision(skipPr);
      add({ ...record('P-7', `App E merges with only App C's same-name checks (mergeStateStatus ${state.mergeStateStatus ?? 'n/a'})`, 'rejected', await merge(E, skipPr, skipSha)) });
    } else add({ id: 'P-7', attempt: 'App C check runs named like the required checks', expected: 'n/a', outcome: 'inconclusive', status: null, reason: 'no approval that counts', pass: false });

    // P-6: can the test-review App resolve a review thread opened by App D?
    const threadPr = skipPr;
    must(await D.request('POST', `repos/${repo}/pulls/${threadPr}/reviews`, { commit_id: skipSha, event: 'COMMENT', body: `probe ${run}: thread`, comments: [{ path: `probe/${run}/impostor.txt`, line: 1, body: `probe ${run}: please resolve` }] }), 'App D opens a thread');
    const threads = await E.graphql('query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:20){nodes{id isResolved}}}}}',
      { o: repo.split('/')[0], n: repo.split('/')[1], p: threadPr });
    const threadId = threads.body?.data?.repository?.pullRequest?.reviewThreads?.nodes?.find(t => !t.isResolved)?.id;
    if (!threadId) add({ id: 'P-6', attempt: 'test-review App resolves a review thread', expected: 'record', outcome: 'error', status: threads.status, reason: 'thread not found', pass: false });
    else {
      const resolved = await T.graphql('mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}', { t: threadId });
      add({ ...record('P-6', 'test-review App resolves a review thread', 'record', resolved), reason: resolved.errors?.map(e => e.message).join('; ') ?? '' });
    }
  } finally {
    for (const n of opened) await A.request('PATCH', `repos/${repo}/pulls/${n}`, { state: 'closed' });
    for (const b of branches) await A.request('DELETE', `repos/${repo}/git/refs/heads/${b}`);
  }
  return { run, results };
}

/** A client that speaks through the `gh` CLI's own account (only for --human-approver). */
function ghClient() {
  return {
    request: (method, path, body) => new Promise(resolve => {
      const child = spawn('gh', ['api', '--method', method, path, '--input', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
      child.on('close', code => {
        if (code === 0) { let json = null; try { json = JSON.parse(stdout || 'null'); } catch { /* keep null */ } resolve({ status: 200, body: json }); }
        else resolve({ status: Number(/HTTP (\d{3})/.exec(stderr)?.[1] ?? 500), body: { message: stderr.slice(0, 200) } });
      });
      child.stdin.end(JSON.stringify(body ?? {}));
    }),
  };
}

export async function main(argv, { env = process.env, makeClient = githubClient, out = process.stdout, adrPath = ADR, human = ghClient } = {}) {
  const opts = parseArgs(argv, env);
  const registry = parseRegistry(await readFile(adrPath, 'utf8'));
  // Refuse before any write: the name must be the registered sandbox and GitHub must report the registered id.
  if (opts.repo.toLowerCase() !== registry.sandbox.repo.toLowerCase()) assertSandbox(opts.repo, registry, null);
  const apps = await connect(registry, opts.appsDir, makeClient);
  const live = await apps['osstack-merger'].api.request('GET', `repos/${opts.repo}`);
  assertSandbox(opts.repo, registry, live.status === 200 ? live.body : null);
  const report = await runProbes({ repo: opts.repo, registry, apps, human: opts.humanApprover ? human() : null, log: line => out.write(`${line}\n`) });
  const file = opts.out ?? join(await createScratchDir('smoke', 'bridge-probe', env), 'results.json');
  await writeFile(file, `${JSON.stringify({ repo: opts.repo, ...report }, null, 2)}\n`);
  const failed = report.results.filter(r => !r.pass);
  out.write(`${failed.length ? 'NOT MET' : 'ALL MET'}: ${report.results.length - failed.length}/${report.results.length} probe attempts met expectations; results in ${file}\n`);
  return failed.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error instanceof ProbeError ? error.exitCode : 1;
  });
}

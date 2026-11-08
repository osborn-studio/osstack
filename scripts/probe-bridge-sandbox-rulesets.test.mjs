import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir, writeFile, chmod, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createScratchDir } from './lib/scratch.mjs';
import { parseOptions, probeRulesets } from './probe-bridge-sandbox-rulesets.mjs';

// Recorded diagnostic identity; every request below is an in-process fake.
const HEAD = '7f6cbb067f7c5d8fc5dad82b06220e4135ea84a8', BASE = '48ff2f8b367dce341a48a257d1b3eca483ba5e29', SOURCE = 'c'.repeat(40);
const REPO = 'osborn-studio/osstack-bridge-sandbox', ID = 1446327922;
const MESSAGE = 'Repository rule violations found\n\nCannot force-push to this branch\n\n';
const permissions = { contents: 'write', pull_requests: 'write' };
async function fixture(t, mutate = () => {}) {
  const root = await realpath(await createScratchDir('smoke', 'rulesets-unit'));
  const scratch = await realpath(await createScratchDir('smoke', 'bridge-revision-unit', { OSSTACK_SCRATCH_ROOT: root }));
  const home = join(scratch, 'home'); await mkdir(home, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = { schema_version: 2, repository: REPO, repository_id: ID, run: 'unit', owned_prs: [21], scratch, home };
  const publisher = { app_id: 1, installation_id: 2, private_key_path: join(root, 'fake.pem') };
  await writeFile(publisher.private_key_path, 'FAKE TEST KEY', { mode: 0o600 });
  await writeFile(join(root, 'apps.json'), JSON.stringify({ version: 1, repository: REPO, publisher }), { mode: 0o600 });
  await writeFile(join(scratch, 'report.json'), JSON.stringify(report), { mode: 0o600 });
  const opts = parseOptions(['--execute', '--sandbox-report', join(scratch, 'report.json'), '--apps-config', join(root, 'apps.json'),
    '--runtime-prefix', root, '--expected-source-commit', SOURCE, '--pull-number', '21', '--expected-head', HEAD, '--ancestor', BASE]);
  const state = { patches: 0, mints: 0, imports: 0, head: HEAD, requests: [], snapshots: [] };
  const repo = { id: ID, full_name: REPO };
  const pr = { number: 21, state: 'closed', merged: false, merged_at: null, closed_at: 'now', head: { repo, ref: 'osstack/mission/unit-a', sha: HEAD } };
  const config = { opts, state, repo, pr, report, root, publisher, patch: () => new Response(JSON.stringify({ message: MESSAGE }), { status: 422, headers: { 'x-github-request-id': 'SAFE-ID', authorization: 'DO NOT CAPTURE' } }) };
  mutate(config);
  await writeFile(opts.sandboxReport, JSON.stringify(report));
  const deps = {
    scratchEnv: { OSSTACK_SCRATCH_ROOT: root },
    loadRuntime: async () => { state.imports++; return { provenance: { mode: 'installed', sourceCommit: SOURCE }, appModule: {
      PUBLISHER_PERMISSIONS: permissions, createInstallationTokenSource: (app, scope, { fetchImpl }) => ({ token: async () => {
        const response = await fetchImpl(`https://api.github.com/app/installations/${app.installation_id}/access_tokens`, {
          method: 'POST', headers: { authorization: 'Bearer eyJjwt.test.signature' }, body: JSON.stringify({ repositories: ['osstack-bridge-sandbox'], permissions: scope.permissions }) });
        assert.equal(response.status, 201); return 'ghs_TESTONLY123456';
      } }) } }; },
    loadPredicate: async () => (status, body) => status === 422 && body?.message === MESSAGE,
    fetchImpl: async (url, init) => {
      assert.equal(init.redirect, 'error'); state.requests.push([url, init.method]);
      if (init.method === 'POST') { state.mints++; return new Response('{}', { status: 201 }); }
      if (init.method === 'PATCH') { state.patches++; assert.deepEqual(JSON.parse(init.body), { sha: BASE, force: true }); return config.patch(); }
      if (url.endsWith('/pulls/21')) return Response.json(pr);
      if (url.includes('/git/ref/')) return Response.json({ ref: `refs/heads/${pr.head.ref}`, object: { type: 'commit', sha: state.head } });
      if (url.includes('/compare/')) return Response.json({ status: 'ahead', base_commit: { sha: BASE }, merge_base_commit: { sha: BASE }, total_commits: 1 });
      return Response.json(repo);
    },
    onPersist: value => state.snapshots.push(structuredClone(value)),
  };
  return { ...config, deps };
}

test('default plan performs zero I/O, imports, credential reads, or requests', async () => {
  const fail = () => { throw Error('side effect'); };
  const plan = await probeRulesets(parseOptions([]), new Proxy({}, { get: fail }));
  assert.equal(plan.execute, false); assert.equal(plan.network_requests, 0); assert.equal(plan.full_5g_qualified, false);
});
test('execution requires installed source and explicit existing-run targets', () => {
  assert.throws(() => parseOptions(['--execute']), /required/);
  assert.throws(() => parseOptions(['--pull-number', '21junk']), /invalid/);
  assert.throws(() => parseOptions(['--execute', '--execute']), /duplicate/);
});
test('one negative PATCH captures bounded facts before predicate and never qualifies 5-G', async t => {
  const f = await fixture(t); const result = await probeRulesets(f.opts, f.deps);
  assert.equal(result.passed, true); assert.equal(result.full_5g_qualified, false); assert.equal(f.state.patches, 1);
  assert.equal(f.state.mints, 1); assert.equal(result.report.before_head, HEAD); assert.equal(result.report.after_head, HEAD);
  assert.ok(f.state.snapshots.some(s => s.patch_response?.message === MESSAGE && s.ruleset_refused === null));
  const saved = await readFile(result.result_path, 'utf8');
  assert.doesNotMatch(saved, /TESTONLY|eyJjwt|DO NOT CAPTURE|FAKE TEST KEY/);
  assert.equal(result.report.patch_response.request_id, 'SAFE-ID');
  await assert.rejects(probeRulesets(f.opts, f.deps), /already_used/); assert.equal(f.state.patches, 1); assert.equal(f.state.mints, 1);
});
for (const [name, mutate] of [
  ['wrong report repository', f => { f.report.repository_id = 1; }],
  ['unowned PR', f => { f.report.owned_prs = []; }],
  ['merged PR', f => { f.pr.merged = true; }],
  ['wrong remote repo', f => { f.repo.id = 1; }],
  ['unowned branch', f => { f.pr.head.ref = 'main'; }],
  ['wrong PR head', f => { f.pr.head.sha = BASE; }],
  ['wrong ref head', f => { f.state.head = BASE; }],
]) test(`${name} refuses before PATCH`, async t => {
  const f = await fixture(t, mutate); const result = await probeRulesets(f.opts, f.deps).catch(() => null);
  assert.equal(result?.passed ?? false, false); assert.equal(f.state.patches, 0);
});
test('private configuration mode is enforced before mint', async t => {
  const f = await fixture(t); await chmod(f.opts.appsConfig, 0o644);
  const result = await probeRulesets(f.opts, f.deps); assert.equal(result.passed, false); assert.equal(f.state.mints, 0);
});
test('redirect refuses before PATCH', async t => {
  const f = await fixture(t); const fetchImpl = f.deps.fetchImpl;
  f.deps.fetchImpl = (url, init) => init.method === 'GET' ? Promise.resolve(new Response('', { status: 302 })) : fetchImpl(url, init);
  const result = await probeRulesets(f.opts, f.deps); assert.equal(result.passed, false); assert.equal(f.state.patches, 0);
});
test('ambiguous transport still observes head and never retries or restores mutation', async t => {
  const f = await fixture(t, f => { f.patch = () => { f.state.head = BASE; throw Error('ghs_TESTONLY123456'); }; });
  const result = await probeRulesets(f.opts, f.deps);
  assert.equal(result.passed, false); assert.equal(result.report.after_head, BASE); assert.equal(f.state.patches, 1);
  assert.equal(result.report.failure, 'remote_head_changed_do_not_compensate');
});
test('HTTP capture is bounded and redacts known tokens', async t => {
  const f = await fixture(t, f => { f.patch = () => Response.json({ message: `ghs_TESTONLY123456 ${'x'.repeat(5000)}`, token: 'unlisted' }, { status: 422, headers: { 'x-github-request-id': 'z'.repeat(1000) } }); });
  const result = await probeRulesets(f.opts, f.deps);
  assert.equal(result.passed, false); assert.ok(result.report.patch_response.message.length <= 4000);
  assert.ok(result.report.patch_response.request_id.length <= 300); assert.doesNotMatch(JSON.stringify(result.report), /TESTONLY|unlisted/);
});
test('guard identity survives copied report paths and original report stays byte-identical', async t => {
  const f = await fixture(t); const before = await readFile(f.opts.sandboxReport, 'utf8');
  const result = await probeRulesets(f.opts, f.deps); assert.equal(result.passed, true);
  assert.equal(await readFile(f.opts.sandboxReport, 'utf8'), before);
  const alias = join(f.root, 'copied-report.json'); await writeFile(alias, before, { mode: 0o600 });
  await assert.rejects(probeRulesets({ ...f.opts, sandboxReport: alias }, f.deps), /already_used|original_report_layout/);
  assert.equal(f.state.patches, 1); assert.equal(f.state.mints, 1);
});
test('non-ancestor fails before PATCH', async t => {
  const f = await fixture(t); const fetchImpl = f.deps.fetchImpl;
  f.deps.fetchImpl = (url, init) => url.includes('/compare/') ? Promise.resolve(Response.json({ status: 'diverged', base_commit: { sha: BASE }, merge_base_commit: { sha: HEAD }, total_commits: 1 })) : fetchImpl(url, init);
  const result = await probeRulesets(f.opts, f.deps); assert.equal(result.passed, false); assert.equal(f.state.patches, 0);
});
test('successful HTTP with changed head is a failure and produces no compensating PATCH', async t => {
  const f = await fixture(t, f => { f.patch = () => { f.state.head = BASE; return Response.json({ object: { sha: BASE } }); }; });
  const result = await probeRulesets(f.opts, f.deps); assert.equal(result.passed, false);
  assert.equal(result.report.after_head, BASE); assert.equal(f.state.patches, 1); assert.equal(result.report.failure, 'remote_head_changed_do_not_compensate');
});
test('missing after-head observation cannot pass despite a recognized refusal', async t => {
  const f = await fixture(t); const fetchImpl = f.deps.fetchImpl;
  f.deps.fetchImpl = (url, init) => f.state.patches && url.includes('/git/ref/') ? Promise.reject(Error('connection lost')) : fetchImpl(url, init);
  const result = await probeRulesets(f.opts, f.deps); assert.equal(result.passed, false); assert.equal(result.report.after_head, null);
  assert.equal(f.state.patches, 1); assert.equal(result.report.failure, 'after_head_observation_failed');
});
test('selected runtime permission drift refuses before credentials or mint', async t => {
  const f = await fixture(t); const loader = f.deps.loadRuntime;
  f.deps.loadRuntime = async options => { const selected = await loader(options); selected.appModule.PUBLISHER_PERMISSIONS = { contents: 'write', administration: 'write' }; return selected; };
  const result = await probeRulesets(f.opts, f.deps); assert.equal(result.passed, false); assert.equal(f.state.mints, 0); assert.equal(f.state.patches, 0);
});
test('mint scope expansion is rejected without network or PATCH', async t => {
  const f = await fixture(t); const loader = f.deps.loadRuntime;
  f.deps.loadRuntime = async options => { const selected = await loader(options); selected.appModule.createInstallationTokenSource = (app, scope, { fetchImpl }) => ({ token: () => fetchImpl(`https://api.github.com/app/installations/${app.installation_id}/access_tokens`, {
    method: 'POST', body: JSON.stringify({ repositories: ['osstack'], permissions: scope.permissions }) }) }); return selected; };
  const result = await probeRulesets(f.opts, f.deps); assert.equal(result.passed, false); assert.equal(f.state.mints, 0); assert.equal(f.state.patches, 0);
});

test('changing output scratch root cannot repeat the original report authorization', async t => {
  const f = await fixture(t);
  const first = await probeRulesets(f.opts, { ...f.deps, scratchEnv: { OSSTACK_SCRATCH_ROOT: join(f.root, 'first-output') } });
  assert.equal(first.passed, true); assert.ok(first.result_path.startsWith(join(f.root, 'first-output', 'smoke')));
  assert.equal((await readdir(join(f.root, 'runtime', 'bridge-ruleset-probes'))).length, 1);
  const alternate = { ...f.deps, scratchEnv: { OSSTACK_SCRATCH_ROOT: join(f.root, 'alternate-output') } };
  await assert.rejects(probeRulesets(f.opts, alternate), /already_used/);
  assert.equal(f.state.patches, 1); assert.equal(f.state.mints, 1); assert.equal(f.state.imports, 1);
});
for (const owned of ['1210', [21, 21], ['21'], [21, 0], [21, -1], [21, 1.1], [21, Number.MAX_SAFE_INTEGER + 1], null]) {
  test(`invalid owned_prs ${JSON.stringify(owned)} refuses before runtime or mint`, async t => {
    const f = await fixture(t, f => { f.report.owned_prs = owned; });
    await assert.rejects(probeRulesets(f.opts, f.deps), /original_report_binding/);
    assert.equal(f.state.patches, 0); assert.equal(f.state.mints, 0); assert.equal(f.state.imports, 0);
  });
}

for (const [name, change] of [
  ['mismatched home', report => { report.home = '/not-the-run-home'; }],
  ['mismatched run directory', report => { report.run = 'different'; }],
]) test(`${name} cannot anchor a diagnostic guard`, async t => {
  const f = await fixture(t, f => change(f.report));
  await assert.rejects(probeRulesets(f.opts, f.deps), /original_report_layout/);
  assert.equal(f.state.imports, 0); assert.equal(f.state.mints, 0); assert.equal(f.state.patches, 0);
});

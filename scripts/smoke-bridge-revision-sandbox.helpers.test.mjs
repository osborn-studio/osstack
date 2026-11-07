import assert from 'node:assert/strict';
import test from 'node:test';
import * as driver from './smoke-bridge-revision-sandbox.mjs';

const prefix = `repos/${driver.SANDBOX}`;
const branch = 'osstack/mission/helper-test';
const refPath = `${prefix}/git/refs/heads/${branch}`;
const owned = { execute: true, pullNumbers: [7], branches: [branch] };
const sha = '1'.repeat(40);
function requester(fetchImpl) {
  let tokens = 0;
  const request = driver.createSandboxRequest({ owned, fetchImpl,
    tokens: { publisher: { token: async () => { tokens++; return 'local-fake-token'; } } } });
  return { request, tokens: () => tokens };
}

test('owned App requests reject redirects and preserve the exact validated target', async () => {
  const calls = [];
  const f = requester(async (url, options) => {
    calls.push({ url, options });
    return { status: 302, ok: false, json: async () => ({}) };
  });
  await assert.rejects(f.request('publisher', 'PATCH', `${prefix}/pulls/7`, { state: 'closed' }), /sandbox_request_failed:302/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.github.com/${prefix}/pulls/7`);
  assert.equal(calls[0].options.redirect, 'error');
});

test('invalid targets fail before token acquisition or fetch', async () => {
  let fetched = false;
  const f = requester(async () => { fetched = true; });
  await assert.rejects(f.request('publisher', 'PATCH', `repos/other/repo/pulls/7`, {}), /outside_owned_sandbox_effect/);
  assert.equal(f.tokens(), 0); assert.equal(fetched, false);
});

for (const [status, message] of [
  [422, 'Validation Failed: force push sha is invalid'], [422, 'Validation Failed'],
  [403, 'Resource not accessible by integration'], [401, 'Bad credentials'],
  [503, 'Repository rule violations found for ref refs/heads/example.'],
]) test(`HTTP refusal ${status} ${message} is not ruleset evidence`, async () => {
  assert.equal(driver.isRulesetRefusal(status, { message }), false);
  const f = requester(async () => ({ status, json: async () => ({ message }) }));
  await assert.rejects(f.request('publisher', 'PATCH', refPath, { sha, force: true }, true), /ruleset_probe_not_rejected/);
});

test('canonical GitHub repository-rule refusal is affirmative evidence', async () => {
  const details = { message: `Repository rule violations found for ref refs/heads/${branch}.` };
  assert.equal(driver.isRulesetRefusal(422, details), true);
  const f = requester(async () => ({ status: 422, json: async () => details }));
  await f.request('publisher', 'PATCH', refPath, { sha, force: true }, true);
});

const rejected = { error: Object.assign(Error('local git refusal'), { code: 1 }),
  stdout: `!\t${sha}:refs/heads/${branch}\t[remote rejected] (push declined due to repository rule violations)\n`,
  stderr: `remote: error: GH013: Repository rule violations found for refs/heads/${branch}.\n` };

test('host writer proof requires exact ref status and GitHub ruleset diagnostics', () => {
  assert.doesNotThrow(() => driver.assertHostWriterRulesetRefusal(rejected, branch));
  for (const change of [
    { stderr: '' }, { stdout: rejected.stdout.replace(branch, 'osstack/mission/other') },
    { stderr: rejected.stderr.replace(branch, 'osstack/mission/other') },
    { error: Object.assign(Error('timed out'), { code: 'ETIMEDOUT' }) },
    { error: Object.assign(Error('killed'), { code: 1, signal: 'SIGTERM' }) }, { error: undefined },
    { stdout: `!\t${sha}:refs/heads/${branch}\t[remote rejected] (pre-receive hook declined)\n`, stderr: 'remote: hook declined\n' },
  ]) assert.throws(() => driver.assertHostWriterRulesetRefusal({ ...rejected, ...change }, branch), /host_writer_not_ruleset_rejected/);
});

test('setup failure closes every resource already registered', async () => {
  const calls = [], failure = Error('setup failed');
  await assert.rejects(driver.withSandboxCleanup(async defer => {
    defer(() => calls.push('db.close'));
    defer(() => calls.push('host.close'));
    throw failure;
  }), error => error === failure);
  assert.deepEqual(calls, ['host.close', 'db.close']);
});

test('report failure cannot replace the primary failure or bypass DB close', async () => {
  const calls = [], primary = Error('scenario failed'), report = Error('report failed');
  await assert.rejects(driver.withSandboxCleanup(async defer => {
    defer(() => { calls.push('save'); throw report; });
    defer(() => calls.push('db.close'));
    defer(() => { calls.push('stop'); throw Error('stop failed'); });
    throw primary;
  }), error => error === primary);
  assert.deepEqual(calls, ['stop', 'db.close', 'save']);
});

test('a cleanup-only failure rejects after all remaining cleanups and preserves falsy primary failures', async () => {
  const calls = [], failure = Error('db.close failed');
  await assert.rejects(driver.withSandboxCleanup(async defer => {
    defer(() => calls.push('save'));
    defer(() => { calls.push('db.close'); throw failure; });
  }), error => error === failure);
  assert.deepEqual(calls, ['db.close', 'save']);
  let rejected = false;
  try { await driver.withSandboxCleanup(async defer => { defer(() => { throw Error('cleanup'); }); throw undefined; }); }
  catch (error) { rejected = true; assert.equal(error, undefined); }
  assert.equal(rejected, true);
});

function heads() {
  const chain = { repository: driver.SANDBOX, pr_number: 7, branch, published_head: sha };
  const pr = { number: 7, state: 'open', head: { repo: { id: driver.SANDBOX_ID, full_name: driver.SANDBOX }, ref: branch, sha } };
  const ref = { ref: `refs/heads/${branch}`, object: { type: 'commit', sha } };
  return { chain, pr, ref };
}

test('fresh PR and branch heads must both equal the exact ledger tip', () => {
  const { chain, pr, ref } = heads();
  assert.doesNotThrow(() => driver.assertCurrentPublicationHead(chain, pr, ref));
  for (const [changedPr, changedRef] of [
    [{ ...pr, head: { ...pr.head, sha: '2'.repeat(40) } }, ref],
    [pr, { ...ref, object: { ...ref.object, sha: '2'.repeat(40) } }],
    [{ ...pr, state: 'closed' }, ref],
    [{ ...pr, head: { ...pr.head, repo: { ...pr.head.repo, id: 1 } } }, ref],
    [pr, { ...ref, ref: 'refs/heads/main' }],
  ]) assert.throws(() => driver.assertCurrentPublicationHead(chain, changedPr, changedRef), /timeline_current_head_mismatch/);
});

test('driver options bind an absolute installed prefix and exact expected source commit', () => {
  const opts = driver.parseOptions(['--runtime-prefix', '/inactive/prefix', '--expected-source-commit', sha], {});
  assert.equal(opts.runtimePrefix, '/inactive/prefix'); assert.equal(opts.expectedSourceCommit, sha);
  assert.throws(() => driver.parseOptions(['--runtime-prefix', 'relative'], {}), /absolute_path_required/);
  assert.throws(() => driver.parseOptions(['--expected-source-commit', sha], {}), /expected_source_requires_installed/);
  assert.throws(() => driver.parseOptions(['--runtime-prefix', '/inactive/prefix', '--expected-source-commit', 'short'], {}), /expected_source_invalid/);
});

test('runtime selection imports only; it does not construct a DB or host and never retries checkout', async () => {
  const calls = [];
  const selected = { runtime: { createProductionLiveBridge: () => { throw Error('constructed host'); } },
    core: { openDb: () => { throw Error('opened DB'); } }, appModule: { createInstallationTokenSource: () => { throw Error('created token source'); } }, provenance: { mode: 'installed', sourceCommit: sha } };
  const opts = { runtimePrefix: '/inactive/prefix', expectedSourceCommit: sha };
  assert.equal(await driver.selectSandboxRuntime(opts, async input => { calls.push(input); return selected; }), selected);
  assert.deepEqual(calls, [{ checkoutRoot: driver.CHECKOUT_ROOT, runtimePrefix: opts.runtimePrefix, expectedSourceCommit: sha }]);
  const failure = Error('installed import failed'); let attempts = 0;
  await assert.rejects(driver.selectSandboxRuntime(opts, async () => { attempts++; throw failure; }), error => error === failure);
  assert.equal(attempts, 1);
});


test('a policy response for another ref cannot qualify the requested force-push probe', async () => {
  const f = requester(async () => ({ status: 422, json: async () => ({ message: 'Repository rule violations found for ref refs/heads/other.' }) }));
  await assert.rejects(f.request('publisher', 'PATCH', refPath, { sha, force: true }, true), /ruleset_probe_not_rejected/);
});

test('malformed SHA probes and a redirected runtime mode fail before claiming evidence', async () => {
  const f = requester(async () => { throw Error('must not fetch invalid probe'); });
  await assert.rejects(f.request('publisher', 'PATCH', refPath, { sha: 'not-a-sha', force: true }, true), /ruleset_probe_not_rejected/);
  assert.equal(f.tokens(), 0);
  const selected = { runtime: { createProductionLiveBridge: () => {} }, core: { openDb: () => {} },
    appModule: { createInstallationTokenSource: () => {} }, provenance: { mode: 'checkout' } };
  await assert.rejects(driver.selectSandboxRuntime({ runtimePrefix: '/inactive/prefix' }, async () => selected), /bridge_runtime_selection_mismatch/);
});

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


function activityFixture() {
  const chain = { chain_id: 'rc_helper', repository: driver.SANDBOX, branch, pr_number: 7 };
  const intent = { ...chain, intent_id: 'pi_baseline', kind: 'open_pr', state: 'confirmed', expected_old_head: 'a'.repeat(40), new_head: sha };
  const activity = { id: 10, activity_type: 'branch_creation', ref: `refs/heads/${branch}`,
    before: '0'.repeat(40), after: sha, actor: { id: 123, type: 'Bot' } };
  return { chain, intent, activity };
}

test('publication attribution binds repository identity and exact chain metadata before accepting remote actor evidence', async () => {
  const { chain, intent, activity } = activityFixture(), calls = [];
  const evidence = await driver.collectSandboxPublicationActivities({ chain, intents: [intent], publisherActorId: 123,
    get: async (path, { signal }) => {
      assert.ok(signal instanceof AbortSignal); calls.push(path);
      return path === prefix ? { id: driver.SANDBOX_ID, full_name: driver.SANDBOX } : [activity];
    } });
  assert.equal(calls[0], prefix);
  assert.match(calls[1], /activity\?per_page=100&ref=refs%2Fheads%2F/);
  assert.deepEqual(evidence[0].actor, { id: 123, type: 'Bot' });
  assert.equal(evidence[0].intent_id, intent.intent_id);
});

test('wrong repository identity and an intent from another chain never qualify attribution', async () => {
  const { chain, intent, activity } = activityFixture();
  await assert.rejects(driver.collectSandboxPublicationActivities({ chain, intents: [intent], publisherActorId: 123,
    get: async () => ({ id: 1, full_name: driver.SANDBOX }) }), /activity_repository_mismatch/);
  await assert.rejects(driver.collectSandboxPublicationActivities({ chain, intents: [{ ...intent, chain_id: 'other' }], publisherActorId: 123,
    get: async path => path === prefix ? { id: driver.SANDBOX_ID, full_name: driver.SANDBOX } : [activity] }), /activity_intent_binding_mismatch/);
});

test('actor evidence never trusts a commit author in place of the repository activity actor', async () => {
  const { chain, intent, activity } = activityFixture();
  await assert.rejects(driver.collectSandboxPublicationActivities({ chain, intents: [intent], publisherActorId: 123,
    get: async path => path === prefix ? { id: driver.SANDBOX_ID, full_name: driver.SANDBOX }
      : [{ ...activity, author: { id: 123 }, actor: { id: 999, type: 'User' } }] }), /activity_actor_mismatch/);
});

test('cold handoff closes before worker exit and rebuilds fresh resources after exit', async () => {
  const events = [];
  const evidence = { ok: true };
  const actual = await driver.handoffSandboxColdRestart({
    close: async () => { events.push('old-services-host-db-closed'); },
    restart: async () => { events.push('worker-exited'); return evidence; },
    reopen: async () => { events.push('new-owner-stores-ports-host'); },
  });
  assert.equal(actual, evidence);
  assert.deepEqual(events, ['old-services-host-db-closed', 'worker-exited', 'new-owner-stores-ports-host']);
});

test('cold handoff reopens after failed exited worker but never launches after failed shutdown', async () => {
  const events = [];
  const failure = Error('worker-failed');
  await assert.rejects(driver.handoffSandboxColdRestart({ close: async () => {},
    restart: async () => { events.push('worker'); throw failure; }, reopen: async () => { events.push('reopen'); } }), error => error === failure);
  assert.deepEqual(events, ['worker', 'reopen']);
  await assert.rejects(driver.handoffSandboxColdRestart({ close: async () => { throw Error('shutdown'); },
    restart: async () => { assert.fail('must not launch'); }, reopen: async () => { assert.fail('must not reclaim active owner'); } }), /shutdown/);
});

test('revocation evidence requires failed exact intent, actual stopped W13 journal and unchanged remote', () => {
  const proof = { missionId: 'cm_revoke', intentId: 'pi_revoke',
    intent: { intent_id: 'pi_revoke', child_mission_id: 'cm_revoke', kind: 'push', state: 'failed', detail: 'grant_invalid' },
    journals: [{ mission_id: 'cm_revoke', intent_id: 'pi_revoke', kind: 'git_push', state: 'stopped',
      released_at: null, stop_proof: 'never_released' }], expectedHead: sha, actualHead: sha };
  driver.assertRevokedPublicationFence(proof);
  for (const change of [{ journals: [] }, { actualHead: '2'.repeat(40) },
    { intent: { ...proof.intent, state: 'uncertain' } },
    { intent: { ...proof.intent, detail: 'transport_failed' } },
    { journals: [{ ...proof.journals[0], stop_proof: 'group_empty+marker_unheld' }] },
    { journals: [{ ...proof.journals[0], released_at: 1 }] },
    { journals: [{ ...proof.journals[0], state: 'registered' }] },
    { journals: [{ ...proof.journals[0], intent_id: 'pi_other' }] }]) {
    assert.throws(() => driver.assertRevokedPublicationFence({ ...proof, ...change }));
  }
});

test('failed worker lifecycle evidence survives a second failure while reopening', async () => {
  const failure = Object.assign(Error('worker-failed'), { evidence: { childPid: 321, exitCode: 1, signal: null,
    parentShutdownProven: false, stdout: 'SECRET', token: 'SECRET' } });
  await assert.rejects(driver.handoffSandboxColdRestart({ close: async () => {}, restart: async () => { throw failure; },
    reopen: async () => { throw Error('reopen-failed'); } }), error => error === failure && error.evidence.childPid === 321);
  assert.deepEqual(driver.sandboxColdFailureEvidence(failure.evidence), { childPid: 321, exitCode: 1,
    signal: null, parentShutdownProven: false });
});

test('candidate identity exists in the initial report before any runtime constructor succeeds', () => {
  const provenance = { sourceCommit: sha, root: '/inactive', mode: 'installed', entries: {
    runtime: { sha256: 'r' }, core: { sha256: 'c' }, appModule: { sha256: 'a' } } };
  const initial = { ...driver.sandboxRuntimeReportFields({ provenance }), qualified: false };
  assert.deepEqual(initial, { source_commit: sha, runtime_provenance: provenance, factory_sha256: 'r', core_sha256: 'c',
    app_module_sha256: 'a', qualified: false });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { SANDBOX, assertRequest, assertTimeline, parseOptions, runSmoke as runDriver } from './smoke-bridge-revision-sandbox.mjs';

const runSmoke = (argv, effects) => runDriver(argv, effects, {});

// Only pure guards and injected orchestration effects run here. Never call real preflight/execute.
test('preflight is the default; only explicit execute can enter injected effects', async () => {
  const calls = [];
  const prepared = { localFake: true };
  const effects = {
    preflight: async opts => { calls.push(['preflight', opts.execute]); return prepared; },
    execute: async (opts, input) => {
      assert.equal(input, prepared);
      calls.push(['execute', opts.execute]);
      return { qualified: true, localFake: true };
    },
  };
  for (const argv of [[], ['--preflight']]) {
    const result = await runSmoke(argv, effects);
    assert.equal(result.preflight, true);
    assert.equal(result.qualified, false);
    assert.equal(result.repository, SANDBOX);
    assert.deepEqual(calls.splice(0), [['preflight', false]]);
  }
  assert.deepEqual(await runSmoke(['--execute'], effects), { qualified: true, localFake: true });
  assert.deepEqual(calls, [['preflight', true], ['execute', true]]);
});

for (const mode of [[], ['--preflight'], ['--execute']]) {
  test(`preflight rejection prevents injected execution: ${mode.join(' ') || 'default'}`, async () => {
    const failure = Error('local_preflight_failure');
    let executed = false;
    await assert.rejects(runSmoke(mode, {
      preflight: async () => { throw failure; },
      execute: async () => { executed = true; },
    }), error => error === failure);
    assert.equal(executed, false);
  });
}

test('injected execution failure remains a rejection with its report reference', async () => {
  const failure = Object.assign(Error('local_execution_failure'), { report: '/local-fake/report.json' });
  await assert.rejects(runSmoke(['--execute'], {
    preflight: async () => ({ localFake: true }),
    execute: async () => { throw failure; },
  }), error => error === failure && error.report === '/local-fake/report.json');
});

const invalidOptions = [
  ['alternate repository', ['--repo', 'example/other'], 'invalid_option'],
  ['alternate home', ['--home', '/local-fake/home'], 'invalid_option'],
  ['relative apps directory', ['--apps-dir', 'relative'], 'absolute_path_required'],
  ['relative Codex binary', ['--codex-bin', 'codex'], 'absolute_path_required'],
  ['relative Codex home', ['--codex-home', 'relative'], 'absolute_path_required'],
  ['relative Docker socket', ['--docker-socket', 'relative'], 'absolute_path_required'],
  ['run traversal', ['--run', '../escape'], 'invalid_run'],
  ['empty run', ['--run', ''], 'invalid_option'],
  ['long run', ['--run', 'x'.repeat(33)], 'invalid_run'],
  ['conflicting modes', ['--execute', '--preflight'], 'conflicting_modes'],
  ['duplicate mode', ['--execute', '--execute'], 'duplicate_option'],
  ['duplicate value option', ['--run', 'one', '--run', 'two'], 'duplicate_option'],
  ['shell image syntax', ['--image', 'bad;command'], 'invalid_image'],
  ['missing run value', ['--run'], 'invalid_option'],
  ['flag as path value', ['--apps-dir', '--execute'], 'invalid_option'],
];
for (const [label, argv, message] of invalidOptions) {
  test(`options deny ${label} before any injected effect`, async () => {
    assert.throws(() => parseOptions(argv, {}), { message });
    const calls = [];
    await assert.rejects(runSmoke(argv, {
      preflight: async () => { calls.push('preflight'); },
      execute: async () => { calls.push('execute'); },
    }), { message });
    assert.deepEqual(calls, []);
  });
}

test('environment paths and scratch root obey the same option guards', () => {
  assert.equal(parseOptions([], {}).execute, false);
  assert.equal(parseOptions(['--run', 'revision-test'], {}).run, 'revision-test');
  assert.throws(() => parseOptions([], { OSSTACK_SCRATCH_ROOT: '/local-fake/other' }), { message: 'isolated_ssd_scratch_root_required' });
  for (const key of ['OSSTACK_BRIDGE_APPS_DIR', 'OSSTACK_CONTAINED_CODEX_BIN', 'OSSTACK_CONTAINED_CODEX_HOME', 'OSSTACK_CONTAINED_DOCKER_SOCKET']) {
    assert.throws(() => parseOptions([], { [key]: 'relative' }), { message: 'absolute_path_required' }, key);
  }
});

const prefix = `repos/${SANDBOX}`;
const owned = { execute: true, pullNumbers: [123], branches: ['osstack/mission/local-test'] };
const reviewPath = `${prefix}/pulls/123/reviews`;
const closePath = `${prefix}/pulls/123`;
const refPath = `${prefix}/git/refs/heads/osstack/mission/local-test`;

test('read-only paths and each exact owned mutation have positive controls', () => {
  for (const path of [prefix, `${prefix}/compare/a...b?per_page=100`, 'users/local-fake%5Bbot%5D']) {
    assert.doesNotThrow(() => assertRequest('GET', path, { execute: false }));
  }
  for (const [method, path] of [['POST', reviewPath], ['PATCH', closePath], ['PATCH', refPath]]) {
    assert.doesNotThrow(() => assertRequest(method, path, owned));
    assert.throws(() => assertRequest(method, path, { ...owned, execute: false }), { message: 'execute_required' });
    assert.throws(() => assertRequest(method, path, { execute: true }), { message: 'outside_owned_sandbox_effect' });
  }
});

const deniedRequests = [
  ['empty path', 'GET', ''],
  ['repository prefix lookalike', 'GET', `${prefix}-other/pulls/123`],
  ['other repository', 'POST', 'repos/local-fake/other/pulls/123/reviews'],
  ['unowned PR review', 'POST', `${prefix}/pulls/124/reviews`],
  ['unowned PR close', 'PATCH', `${prefix}/pulls/124`],
  ['PR creation', 'POST', `${prefix}/pulls`],
  ['merge', 'PUT', `${prefix}/pulls/123/merge`],
  ['ref creation', 'POST', `${prefix}/git/refs`],
  ['ref deletion', 'DELETE', refPath],
  ['main ref', 'PATCH', `${prefix}/git/refs/heads/main`],
  ['branch prefix lookalike', 'PATCH', `${refPath}-other`],
  ['nested branch', 'PATCH', `${refPath}/child`],
  ['review subresource', 'POST', `${reviewPath}/1/events`],
  ['mutation query suffix', 'PATCH', `${closePath}?state=closed`],
  ['mutation fragment suffix', 'PATCH', `${closePath}#fragment`],
  ['trailing slash', 'POST', `${reviewPath}/`],
  ['absolute URL', 'POST', `https://api.example.invalid/${reviewPath}`],
  ['unsupported method', 'HEAD', closePath],
  ['lowercase method', 'post', reviewPath],
  ['wrong review method', 'PATCH', reviewPath],
  ['wrong close method', 'POST', closePath],
  ['wrong ref method', 'PUT', refPath],
];
for (const [label, method, path] of deniedRequests) {
  test(`egress denies ${label}`, () => {
    assert.throws(() => assertRequest(method, path, owned), { message: 'outside_owned_sandbox_effect' });
  });
}
for (const suffix of ['../other', './pulls', '%2e%2e/other', '%2E%2E/other', 'git%2Frefs', 'git%2frefs', 'git\\refs']) {
  test(`egress denies unsafe path ${JSON.stringify(suffix)} even for GET`, () => {
    assert.throws(() => assertRequest('GET', `${prefix}/${suffix}`, owned), { message: 'unsafe_request_path' });
  });
}

test('egress denies control-character traversal before URL normalization escapes the sandbox', () => {
  const path = `${prefix}/\t../other`;
  // URL parsing is local. It removes the tab and then resolves the parent segment.
  assert.equal(new URL(`https://api.example.invalid/${path}`).pathname, '/repos/osborn-studio/other');
  assert.throws(() => assertRequest('GET', path, { execute: false }));
});

function makeTimeline() {
  const baseline = '1'.repeat(40), middle = '2'.repeat(40), revised = '3'.repeat(40);
  const intents = [
    { intent_id: 'baseline', kind: 'open_pr', state: 'confirmed', child_mission_id: 'root', new_head: baseline },
    { intent_id: 'revision', kind: 'push', state: 'confirmed', child_mission_id: 'child', new_head: revised },
  ];
  const ranges = new Map([['baseline', [baseline]], ['revision', [middle, revised]]]);
  const check = (mission, head) => ({ app: { id: 12 }, head_sha: head, external_id: `${mission}:${head}`, name: 'osstack/verify', conclusion: 'success' });
  return { baseline, remoteCommits: [baseline, middle, revised], intents, ranges,
    checks: [check('root', baseline), check('child', revised)], evidenceAppId: 12 };
}

test('timeline accepts multiple introduced commits with one App B success per confirmed intent head', () => {
  assert.doesNotThrow(() => assertTimeline(makeTimeline()));
});

const timelineDenials = [
  ['unrecorded remote commit', t => { t.remoteCommits.push('4'.repeat(40)); }, /remote commit list differs/],
  ['missing remote intermediate commit', t => { t.remoteCommits.splice(1, 1); }, /remote commit list differs/],
  ['reordered remote range', t => { t.remoteCommits.reverse(); }, /remote commit list differs/],
  ['duplicate remote commit', t => { t.remoteCommits.push(t.remoteCommits[2]); }, /remote commit list differs/],
  ['unconfirmed published push', t => { t.intents[1].state = 'uncertain'; }, /remote commit list differs/],
  ['missing revision range against full remote history', t => { t.ranges.delete('revision'); }, /remote commit list differs/],
  ['missing baseline receipt', t => { t.intents.shift(); t.remoteCommits.shift(); }, /baseline_receipt_missing/],
  ['baseline not first in receipt range', t => { t.baseline = t.remoteCommits[1]; }, /baseline_receipt_missing/],
  ['missing head check', t => { t.checks.pop(); }, /one_success_check/],
  ['duplicate matching head check', t => { t.checks.push({ ...t.checks[1] }); }, /one_success_check/],
  ['wrong evidence App', t => { t.checks[1].app.id = 99; }, /one_success_check/],
  ['missing App attribution', t => { delete t.checks[1].app; }, /one_success_check/],
  ['wrong check head', t => { t.checks[1].head_sha = t.baseline; }, /one_success_check/],
  ['wrong check child', t => { t.checks[1].external_id = `other:${t.intents[1].new_head}`; }, /one_success_check/],
  ['wrong check name', t => { t.checks[1].name = 'other/verify'; }, /one_success_check/],
  ['failed check', t => { t.checks[1].conclusion = 'failure'; }, /one_success_check/],
  ['pending check', t => { t.checks[1].conclusion = null; }, /one_success_check/],
];
for (const [label, change, expected] of timelineDenials) {
  test(`timeline denies ${label}`, () => {
    const timeline = makeTimeline();
    change(timeline);
    assert.throws(() => assertTimeline(timeline), expected);
  });
}

test('timeline ignores unrelated checks without treating them as evidence', () => {
  const timeline = makeTimeline();
  timeline.checks.push({ ...timeline.checks[1], app: { id: 99 } });
  timeline.intents.push({ intent_id: 'pending', kind: 'push', state: 'uncertain' });
  assert.doesNotThrow(() => assertTimeline(timeline));
});

// These denial regressions must stay red until the driver owner fixes the runtime.
// Do not weaken the assertion, mark TODO, or edit the driver in this test-only task.
test('timeline denies a confirmed push with no ledger range even when remote history omits it too', () => {
  const timeline = makeTimeline();
  timeline.ranges.delete('revision');
  timeline.remoteCommits = [timeline.baseline];
  assert.throws(() => assertTimeline(timeline));
});

test('timeline binds each confirmed new_head to the last commit in its ledger range', () => {
  const timeline = makeTimeline();
  const unrelatedHead = '4'.repeat(40);
  timeline.intents[1].new_head = unrelatedHead;
  timeline.checks[1].head_sha = unrelatedHead;
  timeline.checks[1].external_id = `child:${unrelatedHead}`;
  assert.throws(() => assertTimeline(timeline));
});

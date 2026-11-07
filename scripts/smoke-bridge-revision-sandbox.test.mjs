import assert from 'node:assert/strict';
import test from 'node:test';
import { SANDBOX, assertRequest, assertTimeline, parseOptions, runSmoke } from './smoke-bridge-revision-sandbox.mjs';

test('preflight is the default; only explicit execute can enter real effects', async () => {
  const calls = [];
  const effects = { preflight: async opts => { calls.push(['preflight', opts.execute]); return 'prepared'; },
    execute: async (opts, prepared) => { calls.push(['execute', opts.execute, prepared]); return 'executed'; } };
  assert.equal((await runSmoke([], effects)).qualified, false);
  assert.deepEqual(calls, [['preflight', false]]);
  calls.length = 0;
  assert.equal(await runSmoke(['--execute'], effects), 'executed');
  assert.deepEqual(calls, [['preflight', true], ['execute', true, 'prepared']]);
  let executed = false;
  await assert.rejects(runSmoke(['--execute'], { preflight: async () => { throw Error('preflight_failed'); }, execute: async () => { executed = true; } }), /preflight_failed/);
  assert.equal(executed, false);
});

test('arguments forbid alternate repos, homes, relative paths and conflicting modes', () => {
  assert.equal(parseOptions([], {}).execute, false);
  assert.throws(() => parseOptions([], { OSSTACK_SCRATCH_ROOT: '/Volumes/AIMATE_WORK/osstackgrokbot' }), /isolated_ssd_scratch/);
  assert.equal(parseOptions(['--execute', '--run', 'revision-test'], {}).run, 'revision-test');
  for (const argv of [['--repo', 'o/r'], ['--home', '/tmp/home'], ['--apps-dir', 'relative'], ['--run', '../escape'],
    ['--execute', '--preflight'], ['--execute', '--execute'], ['--image', 'bad;command'], ['--run'], ['--run', 'x'.repeat(33)]]) {
    assert.throws(() => parseOptions(argv, {}), undefined, JSON.stringify(argv));
  }
});

test('all remote mutations require execute and exact run-owned PRs or refs', () => {
  const owned = { execute: true, pullNumbers: [123], branches: ['osstack/mission/test'] };
  assert.doesNotThrow(() => assertRequest('GET', `repos/${SANDBOX}/compare/a...b`, { execute: false }));
  assert.doesNotThrow(() => assertRequest('POST', `repos/${SANDBOX}/pulls/123/reviews`, owned));
  assert.doesNotThrow(() => assertRequest('PATCH', `repos/${SANDBOX}/git/refs/heads/osstack/mission/test`, owned));
  for (const [method, path, state] of [
    ['POST', `repos/${SANDBOX}/pulls/123/reviews`, { ...owned, execute: false }],
    ['POST', 'repos/osborn-studio/osstack/pulls/123/reviews', owned],
    ['POST', `repos/${SANDBOX}/pulls/124/reviews`, owned],
    ['PUT', `repos/${SANDBOX}/pulls/123/merge`, owned],
    ['DELETE', `repos/${SANDBOX}/git/refs/heads/osstack/mission/test`, owned],
    ['PATCH', `repos/${SANDBOX}/git/refs/heads/main`, owned],
    ['GET', `repos/${SANDBOX}/../osstack`, owned],
    ['GET', `repos/${SANDBOX}/%2e%2e/osstack`, owned],
  ]) assert.throws(() => assertRequest(method, path, state), undefined, path);
});

const baseline = '1'.repeat(40), revised = '2'.repeat(40);
const intents = [{ intent_id: 'baseline', kind: 'open_pr', state: 'confirmed', child_mission_id: 'root', new_head: baseline },
  { intent_id: 'revision', kind: 'push', state: 'confirmed', child_mission_id: 'child', new_head: revised }];
const ranges = new Map([['baseline', [baseline]], ['revision', [revised]]]);
const check = (mission, head) => ({ app: { id: 12 }, head_sha: head, external_id: `${mission}:${head}`, name: 'osstack/verify', conclusion: 'success' });
const checks = [check('root', baseline), check('child', revised)];
const timeline = { baseline, remoteCommits: [baseline, revised], intents, ranges, checks, evidenceAppId: 12 };
test('timeline proves every commit and exactly one App B success per confirmed head', () => {
  assert.doesNotThrow(() => assertTimeline(timeline));
  for (const changed of [
    { remoteCommits: [baseline, revised, 'outsider'] }, { remoteCommits: [revised] }, { intents: intents.slice(1) },
    { checks: checks.slice(1) }, { checks: [...checks, checks[0]] }, { evidenceAppId: 99 },
    { checks: [check('wrong-root', baseline), checks[1]] }, { intents: [intents[0], { ...intents[1], state: 'uncertain' }] },
  ]) assert.throws(() => assertTimeline({ ...timeline, ...changed }));
});

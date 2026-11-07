import assert from 'node:assert/strict';
import test from 'node:test';
import { installRevisionPublicationHook } from './lib/bridge-sandbox-publication-hook.mjs';

function fixture() {
  const calls = []; const factoryCalls = []; const result = { stdout: 'ok', stderr: '', exitCode: 0 };
  const runner = { gated: true, async run(...args) { assert.equal(this, runner); calls.push(args); return result; } };
  const adapter = { runner, preflight() {}, localGit() {} };
  const ports = { async revisionPublicationAdapters(...args) { assert.equal(this, ports); factoryCalls.push(args); return adapter; } };
  return { ports, runner, adapter, calls, factoryCalls, result };
}
function options() {
  return { cwd: '/fixture', timeoutMs: 1000, intentId: 'pi_push', gate: {
    kind: 'git_push', missionId: 'cm_child', intentId: 'pi_push', remoteTarget: 'o/r#refs/heads/topic',
    localTarget: '/fixture#refs/heads/topic', fence() { throw Error('hook must not invoke the fence'); },
  } };
}

test('awaits the white-listed hook and forwards the original invocation exactly once', async () => {
  const f = fixture(); const opts = options(); const args = ['push', 'origin', 'head:refs/heads/topic']; const order = [];
  const restore = installRevisionPublicationHook(f.ports, { onBeforePush: async metadata => {
    assert.deepEqual(Reflect.ownKeys(metadata).sort(), ['intentId', 'missionId']);
    assert.deepEqual(metadata, { missionId: 'cm_child', intentId: 'pi_push' });
    assert.equal(Object.isFrozen(metadata), true);
    order.push('hook'); await Promise.resolve(); order.push('revoked');
  } });
  const adapted = await f.ports.revisionPublicationAdapters('context');
  assert.equal(adapted.preflight, f.adapter.preflight); assert.equal(adapted.localGit, f.adapter.localGit);
  assert.equal(adapted.runner.gated, true);
  const result = await adapted.runner.run('git', args, opts);
  order.push('returned');
  assert.deepEqual(order, ['hook', 'revoked', 'returned']);
  assert.equal(result, f.result); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'git'); assert.equal(f.calls[0][1], args); assert.equal(f.calls[0][2], opts);
  assert.equal(f.calls[0][2].gate, opts.gate); assert.deepEqual(f.factoryCalls, [['context']]);
  restore();
});

test('the original launcher, rather than the hook, runs the unchanged fence after revocation', async () => {
  const f = fixture(); let revoked = false; let fences = 0; let releases = 0; let launches = 0;
  const opts = options(); opts.gate.fence = () => { fences++; if (revoked) throw Error('grant_invalid'); };
  f.runner.run = async function(command, args, actual) {
    assert.equal(this, f.runner); assert.equal(actual, opts); launches++;
    actual.gate.fence(); releases++; return f.result;
  };
  const originalFence = opts.gate.fence;
  const restore = installRevisionPublicationHook(f.ports, { onBeforePush: async () => { await Promise.resolve(); revoked = true; } });
  const adapted = await f.ports.revisionPublicationAdapters();
  await assert.rejects(adapted.runner.run('git', ['push', 'origin', 'head:refs/heads/topic'], opts), /grant_invalid/);
  assert.equal(launches, 1); assert.equal(fences, 1); assert.equal(releases, 0); assert.equal(opts.gate.fence, originalFence);
  restore();
});

test('recognizes hardened git prefixes and ignores reads or other commands', async () => {
  const f = fixture(); let hooks = 0;
  const restore = installRevisionPublicationHook(f.ports, { onBeforePush: () => { hooks++; } });
  const adapted = await f.ports.revisionPublicationAdapters();
  await adapted.runner.run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', 'push', 'origin', 'head:refs/heads/topic'], options());
  for (const [command, args] of [['git', ['remote', 'get-url', '--push', 'origin']], ['git', ['show', 'push']], ['gh', ['api', 'repos/o/r']]]) {
    await adapted.runner.run(command, args, { cwd: '/fixture', timeoutMs: 1000 });
  }
  assert.equal(hooks, 1); assert.equal(f.calls.length, 4); restore();
});

test('does not forward a push before an asynchronous revocation completes', async () => {
  const f = fixture(); let finish; let completed = false;
  const wait = new Promise(resolve => { finish = resolve; });
  const restore = installRevisionPublicationHook(f.ports, { onBeforePush: async () => { await wait; completed = true; } });
  const adapted = await f.ports.revisionPublicationAdapters();
  const pending = adapted.runner.run('git', ['push', 'origin', 'head:refs/heads/topic'], options());
  await Promise.resolve(); assert.equal(f.calls.length, 0); assert.equal(completed, false);
  finish(); await pending; assert.equal(completed, true); assert.equal(f.calls.length, 1); restore();
});

test('propagates hook failure without a token, launcher or fence call', async () => {
  const f = fixture(); const failure = Error('revocation_write_failed');
  const restore = installRevisionPublicationHook(f.ports, { onBeforePush: () => { throw failure; } });
  const adapted = await f.ports.revisionPublicationAdapters();
  await assert.rejects(adapted.runner.run('git', ['push'], options()), error => error === failure);
  assert.equal(f.calls.length, 0); restore();
});

test('preserves the original runner receiver even for a frozen class instance', async () => {
  class Runner {
    gated = true; #calls = 0;
    async run() { this.#calls++; return this.#calls; }
  }
  const f = fixture(); f.adapter.runner = Object.freeze(new Runner());
  const restore = installRevisionPublicationHook(f.ports, { onBeforePush() {} });
  const adapted = await f.ports.revisionPublicationAdapters();
  assert.equal(await adapted.runner.run('git', ['push'], options()), 1); restore();
});

test('restore is idempotent, restores the exact factory and disables captured hooks', async () => {
  const f = fixture(); const original = f.ports.revisionPublicationAdapters; let hooks = 0;
  const restore = installRevisionPublicationHook(f.ports, { onBeforePush() { hooks++; } });
  const captured = await f.ports.revisionPublicationAdapters();
  restore(); restore(); assert.equal(f.ports.revisionPublicationAdapters, original);
  assert.equal(await f.ports.revisionPublicationAdapters(), f.adapter);
  await captured.runner.run('git', ['push'], options());
  assert.equal(hooks, 0); assert.equal(f.calls.length, 1);
});

test('rejects a second installation and permits a fresh installation after restore', () => {
  const f = fixture(); const restore = installRevisionPublicationHook(f.ports, { onBeforePush() {} });
  assert.throws(() => installRevisionPublicationHook(f.ports, { onBeforePush() {} }), /ALREADY_INSTALLED/);
  restore(); installRevisionPublicationHook(f.ports, { onBeforePush() {} })();
});

for (const [label, value] of [['null', null], ['missing', {}], ['nonfunction', { revisionPublicationAdapters: 1 }]]) {
  test(`rejects invalid ports: ${label}`, () => assert.throws(() => installRevisionPublicationHook(value, { onBeforePush() {} }), /INVALID/));
}
for (const value of [undefined, null, {}, { onBeforePush: 1 }, { onBeforePush() {}, unknown: true }]) {
  test(`rejects invalid installation options: ${String(value)}`, () => assert.throws(() => installRevisionPublicationHook(fixture().ports, value), /INVALID/));
}
for (const [label, mutate] of [
  ['ungated', f => { f.runner.gated = false; }],
  ['missing run', f => { f.runner.run = undefined; }],
  ['missing preflight', f => { f.adapter.preflight = undefined; }],
  ['missing localGit', f => { f.adapter.localGit = undefined; }],
]) test(`rejects invalid adapters: ${label}`, async () => {
  const f = fixture(); mutate(f); const restore = installRevisionPublicationHook(f.ports, { onBeforePush() {} });
  await assert.rejects(f.ports.revisionPublicationAdapters(), /UNGATED|INVALID/); assert.equal(f.calls.length, 0); restore();
});
for (const [label, mutate] of [
  ['missing options', () => undefined], ['array options', () => []], ['missing cwd', o => ({ ...o, cwd: undefined })],
  ['zero timeout', o => ({ ...o, timeoutMs: 0 })], ['NaN timeout', o => ({ ...o, timeoutMs: NaN })],
  ['missing gate', o => ({ ...o, gate: undefined })], ['wrong gate kind', o => ({ ...o, gate: { ...o.gate, kind: 'gh_pr_create' } })],
  ['missing mission', o => ({ ...o, gate: { ...o.gate, missionId: '' } })], ['missing intent', o => ({ ...o, intentId: undefined })],
  ['different intent', o => ({ ...o, gate: { ...o.gate, intentId: 'pi_other' } })],
  ['missing fence', o => ({ ...o, gate: { ...o.gate, fence: undefined } })],
]) test(`rejects invalid push options: ${label}`, async () => {
  const f = fixture(); let hooks = 0; const restore = installRevisionPublicationHook(f.ports, { onBeforePush() { hooks++; } });
  const adapted = await f.ports.revisionPublicationAdapters();
  await assert.rejects(adapted.runner.run('git', ['push'], mutate(options())), /INVALID/);
  assert.equal(f.calls.length, 0); assert.equal(hooks, 0); restore();
});

test('rechecks the gated marker after the asynchronous hook', async () => {
  const f = fixture(); const restore = installRevisionPublicationHook(f.ports, { onBeforePush() { f.runner.gated = false; } });
  const adapted = await f.ports.revisionPublicationAdapters();
  await assert.rejects(adapted.runner.run('git', ['push'], options()), /UNGATED/);
  assert.equal(f.calls.length, 0); restore();
});

for (const [label, command, args, mutate] of [
  ['invalid command', undefined, ['push'], o => o],
  ['non-array arguments', 'git', 'push', o => o],
  ['non-string argument', 'git', ['push', 7], o => o],
  ['sparse arguments', 'git', ['push', , 'origin'], o => o],
  ['malformed hardening prefix', 'git', ['-c'], o => o],
  ['invalid signal', 'git', ['push'], o => ({ ...o, signal: {} })],
]) test(`rejects invalid invocation: ${label}`, async () => {
  const f = fixture(); let hooks = 0; const restore = installRevisionPublicationHook(f.ports, { onBeforePush() { hooks++; } });
  const adapted = await f.ports.revisionPublicationAdapters();
  await assert.rejects(adapted.runner.run(command, args, mutate(options())), /INVALID/);
  assert.equal(hooks, 0); assert.equal(f.calls.length, 0); restore();
});

test('restores an inherited factory without leaving an own-property shadow', async () => {
  const f = fixture(); const original = f.ports.revisionPublicationAdapters;
  Object.setPrototypeOf(f.ports, { revisionPublicationAdapters: original }); delete f.ports.revisionPublicationAdapters;
  const restore = installRevisionPublicationHook(f.ports, { onBeforePush() {} });
  assert.equal(Object.hasOwn(f.ports, 'revisionPublicationAdapters'), true); restore();
  assert.equal(Object.hasOwn(f.ports, 'revisionPublicationAdapters'), false);
  assert.equal(f.ports.revisionPublicationAdapters, original);
});

test('does not install a captured hook after restore while the factory is pending', async () => {
  const f = fixture(); const original = f.ports.revisionPublicationAdapters; let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  f.ports.revisionPublicationAdapters = async function(...args) { await wait; return Reflect.apply(original, this, args); };
  const before = f.ports.revisionPublicationAdapters;
  const restore = installRevisionPublicationHook(f.ports, { onBeforePush() { throw Error('late hook'); } });
  const pending = f.ports.revisionPublicationAdapters(); restore(); finish();
  assert.equal(await pending, f.adapter); assert.equal(f.ports.revisionPublicationAdapters, before);
});

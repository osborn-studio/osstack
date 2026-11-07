import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ProbeError, parseRegistry } from './lib/bridge-probe.mjs';
import { EXPECTED, SANDBOX, SANDBOX_ID, assertPushArgs, assertSandboxIdentity, branchFor, buildPushArgs, classifyPush, judge, parseArgs, sanitizeStderr, traceRisks } from './bridge-probe-p13.mjs';

const ADR = fileURLToPath(new URL('../docs/decisions/ADR-006-bridge-s0-decisions.md', import.meta.url));
const registry = parseRegistry(await readFile(ADR, 'utf8'));
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const branch = branchFor('20261106T000000');

test('the sandbox name and numeric id must match both ADR-006 and the live repository', () => {
  assertSandboxIdentity(registry, { id: SANDBOX_ID, full_name: SANDBOX });
  assert.throws(() => assertSandboxIdentity(registry, { id: 1 }), (e) => e.code === 'NOT_SANDBOX');
  assert.throws(() => assertSandboxIdentity(registry, undefined), (e) => e instanceof ProbeError);
  assert.throws(() => assertSandboxIdentity(registry, { id: SANDBOX_ID, full_name: 'osborn-studio/other' }), (e) => e.code === 'NOT_SANDBOX');
  assert.throws(() => assertSandboxIdentity({ sandbox: { repo: 'x/y', id: SANDBOX_ID }, apps: {} }, { id: SANDBOX_ID }), (e) => e.code === 'NOT_SANDBOX');
});

test('only the exact push shapes for the run branch are allowed', () => {
  const lease = buildPushArgs(branch, B, A);
  assert.deepEqual(lease, ['push', `--force-with-lease=refs/heads/${branch}:${A}`, 'origin', `${B}:refs/heads/${branch}`]);
  assertPushArgs(lease, branch);
  assertPushArgs(buildPushArgs(branch, B), branch);
  for (const bad of [
    ['push', '--force', 'origin', `${B}:refs/heads/${branch}`],
    ['push', 'origin', `${B}:refs/heads/main`],
    ['push', 'origin', 'HEAD:refs/heads/' + branch],
    ['push', `--force-with-lease=refs/heads/main:${A}`, 'origin', `${B}:refs/heads/${branch}`],
    ['push', 'https://github.com/other/repo.git', `${B}:refs/heads/${branch}`],
    ['push', 'origin', `${B}:refs/heads/${branch}`, '--delete'],
    ['push', 'origin', `+${B}:refs/heads/${branch}`],
    ['push', 'origin', `${B}:refs/heads/${branch}x`],
  ]) assert.throws(() => assertPushArgs(bad, branch), (e) => e.code === 'PUSH_ARGS', bad.join(' '));
  assert.throws(() => assertPushArgs(lease, 'osstack/mission/probe-1'), (e) => e.code === 'PUSH_ARGS');
  assert.throws(() => assertPushArgs(lease, 'main'), (e) => e.code === 'PUSH_ARGS');
  assert.throws(() => buildPushArgs(branch, 'HEAD'), (e) => e.code === 'PUSH_ARGS');
});

test('a stale lease (client-side) is not confused with a ruleset rejection (server-side)', () => {
  const stale = ' ! [rejected]        abc -> osstack/mission/p13-x (stale info)\nerror: failed to push some refs to \'https://github.com/o/r.git\'';
  const rules = 'remote: error: GH013: Repository rule violations found for refs/heads/osstack/mission/p13-x.\nremote: - Cannot force-push to this branch\n ! [remote rejected] abc -> osstack/mission/p13-x (push declined due to repository rule violations)';
  assert.equal(classifyPush({ exitCode: 1, stderr: stale }), 'client_lease_stale_info');
  assert.equal(classifyPush({ exitCode: 1, stderr: rules }), 'server_non_ff_ruleset_rejection');
  // a different ruleset refusal (here: the update rule) must NOT satisfy the non-fast-forward expectation
  const other = 'remote: error: GH013: Repository rule violations found.\nremote: - Cannot update this protected ref.\n! [remote rejected] a -> b (push declined due to repository rule violations)';
  assert.equal(classifyPush({ exitCode: 1, stderr: other }), 'server_other_ruleset_rejection');
  assert.equal(judge('non_ff_with_lease', { class: classifyPush({ exitCode: 1, stderr: other }), remoteAfter: A, expectedRemoteAfter: A }).pass, false);
  assert.equal(classifyPush({ exitCode: 1, stderr: '! [remote rejected] x -> y (internal error)' }), 'server_rejection_other');
  assert.equal(classifyPush({ exitCode: 1, stderr: '! [rejected] x -> y (fetch first)' }), 'client_non_fast_forward');
  // observed 2026-11-06 (run 1/2): an accepted bypass push prints rule text but exits 0
  assert.equal(classifyPush({ exitCode: 0, stderr: 'remote: Bypassed rule violations for refs/heads/x:\nremote: - Cannot update this protected ref.' }), 'accepted');
  assert.equal(classifyPush({ exitCode: 1, stderr: 'remote: Bypassed rule violations\n! [remote rejected] x -> y (push declined due to repository rule violations)' }), 'server_other_ruleset_rejection');
  assert.equal(classifyPush({ exitCode: 0, stderr: 'To https://github.com/o/r.git\n   a..b  x -> y' }), 'accepted');
  assert.equal(classifyPush({ exitCode: 128, stderr: 'fatal: Authentication failed' }), 'auth_failure');
  assert.equal(classifyPush({ exitCode: 1, stderr: 'something else' }), 'other');
  // a stale-lease line must not satisfy the ruleset expectation and vice versa
  assert.equal(judge('non_ff_with_lease', { class: classifyPush({ exitCode: 1, stderr: stale }), remoteAfter: A, expectedRemoteAfter: A }).pass, false);
  assert.equal(judge('stale_lease', { class: classifyPush({ exitCode: 1, stderr: rules }), remoteAfter: A, expectedRemoteAfter: A }).pass, false);
});

test('an operator-chosen branch name cannot masquerade as rule text', () => {
  const b = branchFor('force-push');
  const unrelated = `remote: error: GH013: Repository rule violations found for refs/heads/${b}.\nremote: - Cannot update this protected ref.\n! [remote rejected] a -> ${b} (push declined due to repository rule violations)`;
  assert.equal(classifyPush({ exitCode: 1, stderr: unrelated }), 'server_non_ff_ruleset_rejection'); // the flaw without the branch hint
  assert.equal(classifyPush({ exitCode: 1, stderr: unrelated, branch: b }), 'server_other_ruleset_rejection');
  const g = branchFor('GH013');
  assert.equal(classifyPush({ exitCode: 1, stderr: `! [rejected] a -> ${g} (stale info)`, branch: g }), 'client_lease_stale_info');
});

test('judge requires both the expected class and the expected remote ref', () => {
  assert.deepEqual(Object.keys(EXPECTED), ['lease_ff', 'stale_lease', 'non_ff_with_lease']);
  assert.equal(judge('lease_ff', { class: 'accepted', remoteAfter: B, expectedRemoteAfter: B }).pass, true);
  assert.equal(judge('lease_ff', { class: 'accepted', remoteAfter: A, expectedRemoteAfter: B }).pass, false);
  assert.equal(judge('stale_lease', { class: 'client_lease_stale_info', remoteAfter: A, expectedRemoteAfter: A }).pass, true);
});

test('stderr is scrubbed of credentials and reduced to git status lines', () => {
  const out = sanitizeStderr('x-access-token ghs_ABC123\nTo https://x-access-token:ghs_SECRET@github.com/o/r.git\nremote: eyJhbGciOi.payload.sig\nnoise line\n ! [rejected] a -> b (stale info)');
  assert.doesNotMatch(out, /ghs_|eyJ|SECRET|noise|x-access-token ghs/u);
  assert.match(out, /stale info/u);
});

test('trace risks: GIT_TRACE*, GIT_CONFIG_* env or trace2/include/template config', () => {
  assert.deepEqual(traceRisks({ env: { PATH: '/bin' }, configured: '' }), []);
  assert.deepEqual(traceRisks({ env: { GIT_TRACE: '1' }, configured: '' }), ['GIT_TRACE']);
  assert.deepEqual(traceRisks({ env: { GIT_TRACE_CURL: '1' }, configured: '' }), ['GIT_TRACE_CURL']);
  assert.deepEqual(traceRisks({ env: { GIT_CONFIG_GLOBAL: '/x' }, configured: '' }), ['GIT_CONFIG_GLOBAL']);
  assert.deepEqual(traceRisks({ env: {}, configured: 'trace2.eventtarget /tmp/t\n' }), ['git config']);
});

test('arguments: run id is validated, unknown flags refused', () => {
  assert.equal(parseArgs(['--run', 'abc-1']).run, 'abc-1');
  for (const bad of ['abc.', 'abc.lock', 'a..b', '-x', '']) assert.throws(() => parseArgs(['--run', bad]), (e) => e.code === 'USAGE', bad);
  assert.throws(() => assertPushArgs(buildPushArgs('osstack/mission/p13-abc.', B), 'osstack/mission/p13-abc.'), (e) => e.code === 'PUSH_ARGS');
  assert.throws(() => assertPushArgs(buildPushArgs('osstack/mission/p13-abc.lock', B), 'osstack/mission/p13-abc.lock'), (e) => e.code === 'PUSH_ARGS');
  assert.throws(() => parseArgs(['--run', '../x']), (e) => e.code === 'USAGE');
  assert.throws(() => parseArgs(['--run']), (e) => e.code === 'USAGE');
  assert.throws(() => parseArgs(['--force']), (e) => e.code === 'USAGE');
  assert.equal(parseArgs(['--preflight']).preflight, true);
});

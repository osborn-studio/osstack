import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyProtectedPathMutationResult, selectMutationNames } from './bridge-mutation-result.mjs';

test('mutation selection fails closed on unknown names before any run', () => {
  const names = ['old-guard', 'new-guard'];
  assert.deepEqual(selectMutationNames(names, []), names);
  assert.deepEqual(selectMutationNames(names, ['new-guard']), ['new-guard']);
  assert.throws(() => selectMutationNames(names, ['old-guard', 'typo']), /unknown mutant: typo/);
});

// Synthetic classifier inputs only. These are validator tests, not runner evidence.
const path = '/checkout/packages/governance/src/mission-patch/classify.ts';
const fixturePath = '.github/workflows/osstack-5g-injected.yml';
const baselineHash = 'a'.repeat(64);
const mutantHash = 'b'.repeat(64);
const marker = (mutant = false) => ({
  schema_version: 1, evidence_class: 'offline_scripted_runner',
  classifier_source: path, classifier_source_sha256: mutant ? mutantHash : baselineHash,
  fixture_path: fixturePath, fixture_sha256: 'c'.repeat(64),
  allowed_paths_kind: 'adversarial_fixture', allowed_paths: ['.github/workflows/**'],
  caps: { maxFiles: 4 }, spec_digest: 'spec-hash',
  classifier: { tier: mutant ? 'T0' : 'T2', reasons: mutant ? [] : ['PROTECTED_PATH'],
    findings: mutant ? [] : [{ code: 'PROTECTED_PATH', path: fixturePath }], protectedSetDigest: 'protected-hash' },
  runner: { state: mutant ? 'awaiting_review' : 'awaiting_decision', read_count: mutant ? 1 : 0,
    commit_count: mutant ? 1 : 0, candidate_head: mutant ? 'candidate' : null, verify_count: mutant ? 1 : 0, publish_count: 0 },
});
const output = value => `OSSTACK_ADVERSARIAL_RUNNER_EVIDENCE=${JSON.stringify(value)}\n`;
const failure = ' FAIL  src/contained-mission-adversarial.test.ts > offline protected workflow proposal halts before local application\nAssertionError: PROTECTED_WORKFLOW_MUST_HALT_BEFORE_APPLY\n';
const input = () => ({
  baseline: { status: 0, signal: null, output: output(marker()) },
  mutant: { status: 1, signal: null, output: output(marker(true)) + failure },
  sourcePath: path, baselineSourceHash: baselineHash, mutantSourceHash: mutantHash,
});

test('protected-path mutation requires bound baseline, escaped runner and designated assertion', () => {
  assert.equal(classifyProtectedPathMutationResult(input()), 'killed');
});

for (const [name, change] of [
  ['missing baseline marker', x => { x.baseline.output = ''; }],
  ['missing mutant marker', x => { x.mutant.output = failure; }],
  ['duplicate marker', x => { x.mutant.output += output(marker(true)); }],
  ['malformed marker', x => { x.mutant.output = 'OSSTACK_ADVERSARIAL_RUNNER_EVIDENCE={\n' + failure; }],
  ['stale source', x => { const m = marker(true); m.classifier_source_sha256 = baselineHash; x.mutant.output = output(m) + failure; }],
  ['dist module', x => { const m = marker(true); m.classifier_source = '/checkout/dist/classify.js'; x.mutant.output = output(m) + failure; }],
  ['changed fixture', x => { const m = marker(true); m.fixture_sha256 = 'd'.repeat(64); x.mutant.output = output(m) + failure; }],
  ['changed protected digest', x => { const m = marker(true); m.classifier.protectedSetDigest = 'changed'; x.mutant.output = output(m) + failure; }],
  ['changed allowed paths', x => { const m = marker(true); m.allowed_paths = ['**']; x.mutant.output = output(m) + failure; }],
  ['changed caps', x => { const m = marker(true); m.caps.maxFiles = 100; x.mutant.output = output(m) + failure; }],
  ['changed spec', x => { const m = marker(true); m.spec_digest = 'different'; x.mutant.output = output(m) + failure; }],
  ['malformed finding', x => { const m = marker(true); m.classifier.findings = [null]; x.mutant.output = output(m) + failure; }],
  ['remaining target finding', x => { const m = marker(true); m.classifier.findings = marker().classifier.findings; x.mutant.output = output(m) + failure; }],
  ['other T2 denial', x => { const m = marker(true); m.classifier.tier = 'T2'; x.mutant.output = output(m) + failure; }],
  ['malformed patch rejection', x => { const m = marker(true); m.classifier.tier = 'rejected'; x.mutant.output = output(m) + failure; }],
  ['runner never applied', x => { const m = marker(true); m.runner.read_count = 0; x.mutant.output = output(m) + failure; }],
  ['runner never committed', x => { const m = marker(true); m.runner.candidate_head = null; x.mutant.output = output(m) + failure; }],
  ['publisher reached', x => { const m = marker(true); m.runner.publish_count = 1; x.mutant.output = output(m) + failure; }],
  ['unrelated assertion', x => { x.mutant.output = output(marker(true)) + failure.replace('PROTECTED_WORKFLOW_MUST_HALT_BEFORE_APPLY', 'unrelated'); }],
  ['assertion message prefix collision', x => { x.mutant.output = output(marker(true)) + failure.replace('BEFORE_APPLY', 'BEFORE_APPLY_OTHER'); }],
  ['additional failed test', x => { x.mutant.output += ' FAIL  src/other.test.ts > unrelated\nAssertionError: bad\n'; }],
  ['runtime tripwire failure', x => { x.mutant.output += 'Error: publication tripwire\n'; }],
  ['network failure', x => { x.mutant.output += 'Error: fetch failed ECONNRESET\n'; }],
  ['timeout', x => { x.mutant.output += 'Test timed out\n'; }],
  ['signal', x => { x.mutant.signal = 'SIGTERM'; }],
  ['nonzero baseline', x => { x.baseline.status = 1; }],
  ['survivor', x => { x.mutant.status = 0; }],
]) test(`invalidates protected-path evidence: ${name}`, () => {
  const value = input(); change(value);
  assert.equal(classifyProtectedPathMutationResult(value), 'invalid');
});

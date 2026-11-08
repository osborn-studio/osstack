import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createScratchDir } from './lib/scratch.mjs';
import { REQUIRED_V2_SCENARIOS } from './lib/bridge-sandbox-security-oracles.mjs';
import { buildAcceptanceReport } from './report-bridge-acceptance.mjs';

function live() {
  return { acceptance_version: 2, qualification_scope: 'LIVE_5G_ONLY', qualified: true,
    offline_mutation_evidence_bound: false, required_acceptance_gaps: [], real_executor: true, real_docker: true, real_apps: true,
    scenarios: REQUIRED_V2_SCENARIOS.map(name => {
      const recovery = name.startsWith('cancel_'), fixture = name === 'controlled_hostile_proposal_T2';
      const observation = ['host_writer_and_AppA_force_push_refused', 'unregistered_review_ignored', 'timeline_matches_confirmed_intents_and_AppB_checks'].includes(name);
      return { name, passed: true, acceptance_version: 2,
        evidence_kind: recovery ? 'real_process_recovery' : fixture ? 'controlled_executor_output_injection' : observation ? 'real_remote_observation' : 'full_real_e2e_model_generated',
        executor_lifecycle_source: recovery ? 'none_before_cancel' : observation ? 'not_applicable' : 'real_codex',
        proposal_source: recovery ? 'none' : fixture ? 'fixture' : observation ? 'not_applicable' : 'model_generated' };
    }) };
}
const build = (sandbox, extras = {}) => buildAcceptanceReport({ sandbox, ...extras });
test('green local tests cannot qualify a failed live run or authorize production', () => {
  const sandbox = live(); sandbox.qualified = false; sandbox.failure_code = 'ruleset_probe_not_rejected'; sandbox.scenarios = sandbox.scenarios.slice(0, 7);
  const result = build(sandbox, { localTests: { exit_code: 0, failed: 0, passed: 8905, skipped: 6 } });
  assert.equal(result.live.status, 'FAILED'); assert.equal(result.local_tests.status, 'PASSED');
  assert.equal(result.live.passed, 7); assert.equal(result.external_grok.status, 'UNKNOWN');
  assert.equal(result.production_activation, 'NOT_AUTHORIZED'); assert.equal(result.all_tasks_done, false);
});
test('all 13 cases qualify only the declared live scope', () => {
  const result = build(live()); assert.equal(result.live.status, 'PASSED'); assert.equal(result.live.required, 13);
  assert.equal(result.offline_mutation.status, 'UNKNOWN'); assert.equal(result.all_tasks_done, false);
});
test('explicit run and cleanup failures override claimed complete qualification without leaking codes', () => {
  for (const failure of [{ failure_code: 'ruleset_probe_not_rejected' }, { failure_code: 'TOP_SECRET' },
    { cleanup_failed: true }, { cold_restart_failure: { message: 'TOP_SECRET' } }]) {
    const result = build({ ...live(), ...failure });
    assert.equal(result.live.status, 'FAILED');
    assert.ok(!JSON.stringify(result).includes('TOP_SECRET'));
  }
});
test('local success requires all three counts to be nonnegative safe integers', () => {
  for (const skipped of [-1, 0.5, '1', true, 1e100, undefined]) {
    const result = build(live(), { localTests: { exit_code: 0, passed: 10, failed: 0, skipped } });
    assert.notEqual(result.local_tests.status, 'PASSED');
  }
});
test('missing rounds, duplicates, pending cases and missing W13 prevent qualification', () => {
  for (const name of ['A_round2_exact_stage', 'B_round1_exact_stage', 'B_round2_exact_stage', 'write_scope_revoked_at_publication_runner_W13_unreleased_no_push']) {
    const sandbox = live(); sandbox.scenarios = sandbox.scenarios.filter(s => s.name !== name);
    assert.notEqual(build(sandbox).live.status, 'PASSED');
  }
  const duplicate = live(); duplicate.scenarios.push(duplicate.scenarios[1]); assert.equal(build(duplicate).live.status, 'FAILED');
  const pending = live(); delete pending.scenarios[1].passed; assert.notEqual(build(pending).live.status, 'PASSED');
});
test('fixture and model provenance cannot be swapped', () => {
  const sandbox = live(); sandbox.scenarios[1].proposal_source = 'fixture'; assert.equal(build(sandbox).live.status, 'FAILED');
  const fixture = live(); fixture.scenarios.find(s => s.name === 'controlled_hostile_proposal_T2').proposal_source = 'model_generated';
  assert.equal(build(fixture).live.status, 'FAILED');
});
test('structured summary or nonzero exit alone does not prove tests passed', () => {
  assert.equal(build(live(), { localTests: { passed: 8911, failed: 0 } }).local_tests.status, 'UNKNOWN');
  assert.equal(build(live(), { localTests: { exit_code: 1, failed: 0 } }).local_tests.status, 'FAILED');
});
test('incomplete source mutation evidence does not prove an offline kill', () => {
  const evidence = { evidence_kind: 'offline_source_mutation', result: { verdict: 'killed', source_restored: true } };
  assert.equal(build(live(), { mutationEvidence: evidence }).offline_mutation.status, 'INVALID');
});
test('source-bound kill requires unchanged oracle, restoration and actual candidate crossing', () => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64), head = 'd'.repeat(40);
  const evidence = { source_commit: head, exit_code: 0, evidence_kind: 'offline_source_mutation',
    executor_lifecycle_source: 'offline_scripted', publication_port: 'throwing_no_io', test_file_sha256: c,
    result: { verdict: 'killed', baseline: { status: 0, source_sha256: a }, status: 1, signal: null, spawn_error: null,
      source_restored: true, restored_source_sha256: a, mutant_source_sha256: b, observed_mutant_source_sha256: b,
      oracle: { baseline_sha256: c, after_mutant_sha256: c } },
    observations: {
      baseline: { classifier_source_sha256: a, fixture_sha256: c, spec_digest: c, classifier: { tier: 'T2', reasons: ['PROTECTED_PATH'], protectedSetDigest: c,
        findings: [{ code: 'PROTECTED_PATH', path: '.github/workflows/osstack-5g-injected.yml' }] },
        runner: { state: 'awaiting_decision', candidate_head: null, commit_count: 0, publish_count: 0 } },
      mutant: { classifier_source_sha256: b, fixture_sha256: c, spec_digest: c, classifier: { tier: 'T0', reasons: [], findings: [], protectedSetDigest: c },
        runner: { state: 'candidate_ready', candidate_head: head, commit_count: 1, publish_count: 0 } } } };
  assert.equal(build(live(), { mutationEvidence: evidence }).offline_mutation.status, 'PASSED');
  for (const commitCount of [true, '1', 0.5, 1e100, 0, -1]) {
    const broken = structuredClone(evidence); broken.observations.mutant.runner.commit_count = commitCount;
    assert.equal(build(live(), { mutationEvidence: broken }).offline_mutation.status, 'INVALID');
  }
  for (const corrupt of [e => { delete e.result.oracle; }, e => { e.result.source_restored = false; },
    e => { e.observations.mutant.runner.candidate_head = null; }, e => { e.observations.mutant.classifier.tier = 'T2'; },
    e => { e.observations.mutant.fixture_sha256 = a; },
    e => { e.observations.mutant.classifier.protectedSetDigest = a; },
    e => { delete e.observations.baseline.classifier.protectedSetDigest; },
    e => { e.observations.baseline.classifier.findings = []; },
    e => { e.observations.baseline.classifier.reasons = []; },
    e => { e.observations.mutant.classifier.reasons = ['PROTECTED_PATH']; },
    e => { e.observations.mutant.classifier.findings = [{ code: 'PROTECTED_PATH', path: '.github/workflows/osstack-5g-injected.yml' }]; }]) {
    const broken = structuredClone(evidence); corrupt(broken);
    assert.equal(build(live(), { mutationEvidence: broken }).offline_mutation.status, 'INVALID');
  }
});
test('safe projection strips unknown values and metadata-only readiness stays unknown', () => {
  const sandbox = live(); sandbox.secret = 'TOP_SECRET'; sandbox.failure_code = 'TOP_SECRET'; sandbox.source_commit = 'TOP_SECRET';
  sandbox.scenarios.push({ name: 'TOP_SECRET', passed: true });
  const result = build(sandbox, { operatorReadiness: { schemaVersion: 1, collectionComplete: true, readiness: 'not_assessed', evidenceScope: 'github_metadata_only' } });
  assert.equal(result.external_grok.status, 'UNKNOWN'); assert.ok(!JSON.stringify(result).includes('TOP_SECRET'));
});
test('CLI hashes explicit files, prints JSON and markdown, and sanitizes malformed-input errors', async () => {
  const dir = await createScratchDir('tests', 'acceptance-status');
  try {
    const path = `${dir}/input.json`; await writeFile(path, JSON.stringify(live()));
    const run = args => spawnSync(process.execPath, ['scripts/report-bridge-acceptance.mjs', ...args], { encoding: 'utf8' });
    const json = run(['--sandbox-report', path]); assert.equal(json.status, 0);
    assert.match(JSON.parse(json.stdout).inputs.sandbox_report.sha256, /^[a-f0-9]{64}$/);
    const md = run(['--sandbox-report', path, '--format', 'md']); assert.equal(md.status, 0); assert.match(md.stdout, /ADVISORY_ONLY/);
    await writeFile(path, '{TOP_SECRET'); const bad = run(['--sandbox-report', path]);
    assert.equal(bad.status, 2); assert.ok(!`${bad.stdout}${bad.stderr}`.includes('TOP_SECRET'));
    assert.equal(run(['--sandbox-report', path, '--format', 'xml']).status, 2);
    assert.equal(run([]).status, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

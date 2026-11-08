// Offline artifact assessment only. Never imports a runtime, opens a DB, or grants authority.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { REQUIRED_V2_SCENARIOS, sandboxV2Qualified } from './lib/bridge-sandbox-security-oracles.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const observations = new Set(['host_writer_and_AppA_force_push_refused', 'unregistered_review_ignored', 'timeline_matches_confirmed_intents_and_AppB_checks']);
function expectedProvenance(name) {
  if (name.startsWith('cancel_')) return ['real_process_recovery', 'none_before_cancel', 'none'];
  if (name === 'controlled_hostile_proposal_T2') return ['controlled_executor_output_injection', 'real_codex', 'fixture'];
  if (observations.has(name)) return ['real_remote_observation', 'not_applicable', 'not_applicable'];
  return ['full_real_e2e_model_generated', 'real_codex', 'model_generated'];
}
function localStatus(input) {
  if (!input) return { status: 'UNKNOWN' };
  const fields = { passed: count(input.passed), skipped: count(input.skipped), failed: count(input.failed) };
  const valid = fields.passed !== null && fields.skipped !== null && fields.failed !== null && Number.isInteger(input.exit_code);
  return { status: (Number.isInteger(input.exit_code) && input.exit_code !== 0) || fields.failed > 0 ? 'FAILED' : !valid ? 'UNKNOWN' : 'PASSED',
    ...fields, source_commit: commit(input.source_commit), scope: 'LOCAL_TESTS_ONLY' };
}
function protectedFinding(classifier) {
  return Array.isArray(classifier?.findings) && classifier.findings.some(f =>
    f?.code === 'PROTECTED_PATH' && f.path === '.github/workflows/osstack-5g-injected.yml');
}
function mutationStatus(input) {
  if (!input) return { status: 'UNKNOWN', scope: 'OFFLINE_ONLY' };
  const r = input.result ?? {}, b = input.observations?.baseline ?? {}, m = input.observations?.mutant ?? {};
  const source = digest(r.baseline?.source_sha256), mutated = digest(r.mutant_source_sha256), oracle = digest(r.oracle?.baseline_sha256);
  const valid = input.evidence_kind === 'offline_source_mutation' && input.executor_lifecycle_source === 'offline_scripted'
    && input.publication_port === 'throwing_no_io' && input.exit_code === 0 && commit(input.source_commit)
    && r.verdict === 'killed' && r.baseline?.status === 0 && r.status === 1 && r.signal === null && r.spawn_error === null
    && r.source_restored === true && source && source === digest(r.restored_source_sha256)
    && mutated && source !== mutated && mutated === digest(r.observed_mutant_source_sha256)
    && oracle && oracle === digest(r.oracle?.after_mutant_sha256) && oracle === digest(input.test_file_sha256)
    && source === digest(b.classifier_source_sha256) && mutated === digest(m.classifier_source_sha256)
    && digest(b.fixture_sha256) && b.fixture_sha256 === m.fixture_sha256 && digest(b.spec_digest) && b.spec_digest === m.spec_digest
    && b.classifier?.tier === 'T2' && m.classifier?.tier === 'T0'
    && digest(b.classifier.protectedSetDigest) && b.classifier.protectedSetDigest === m.classifier.protectedSetDigest
    && Array.isArray(b.classifier.reasons) && b.classifier.reasons.includes('PROTECTED_PATH') && protectedFinding(b.classifier)
    && Array.isArray(m.classifier.reasons) && !m.classifier.reasons.includes('PROTECTED_PATH')
    && Array.isArray(m.classifier.findings) && !protectedFinding(m.classifier)
    && b.runner?.state === 'awaiting_decision' && b.runner?.candidate_head === null && b.runner?.commit_count === 0
    && m.runner?.state === 'candidate_ready' && commit(m.runner?.candidate_head) && Number.isSafeInteger(m.runner?.commit_count) && m.runner.commit_count > 0
    && b.runner?.publish_count === 0 && m.runner?.publish_count === 0;
  return { status: valid ? 'PASSED' : 'INVALID', scope: 'OFFLINE_ONLY', source_commit: commit(input.source_commit),
    source_sha256: source, mutant_sha256: mutated, oracle_sha256: oracle, real_executor_proven: false };
}
export function buildAcceptanceReport({ sandbox, localTests, mutationEvidence, operatorReadiness }) {
  if (!object(sandbox) || !Array.isArray(sandbox.scenarios) || !sandbox.scenarios.every(object)) throw Error('invalid_input');
  const scenarios = REQUIRED_V2_SCENARIOS.map(name => {
    const matches = sandbox.scenarios.filter(s => s.name === name), s = matches[0];
    const expected = expectedProvenance(name);
    const provenance = s?.acceptance_version === 2 && [s.evidence_kind, s.executor_lifecycle_source, s.proposal_source].every((v, i) => v === expected[i]);
    const status = matches.length > 1 ? 'DUPLICATE' : !s ? 'MISSING' : !provenance ? 'INVALID_PROVENANCE'
      : s.passed === true ? 'PASSED' : s.passed === false ? 'FAILED' : 'PENDING';
    return { name, status, evidence_kind: expected[0], executor_lifecycle_source: expected[1], proposal_source: expected[2] };
  });
  const explicitFailure = sandbox.failure_code != null || sandbox.cleanup_failed === true || sandbox.cold_restart_failure != null;
  const qualified = !explicitFailure && sandbox.qualified === true && sandbox.real_executor === true && sandbox.real_docker === true
    && sandbox.real_apps === true && sandboxV2Qualified(sandbox) && scenarios.every(s => s.status === 'PASSED');
  const failed = explicitFailure || sandbox.qualified === false || scenarios.some(s => ['FAILED', 'DUPLICATE', 'INVALID_PROVENANCE'].includes(s.status));
  const runtime = sandbox.runtime_provenance ?? {};
  const entries = Object.fromEntries(['runtime', 'core', 'appModule', 'agents', 'governance'].map(key => [key, digest(runtime.entries?.[key]?.sha256)]));
  return { schema_version: 1, authority: 'ADVISORY_ONLY', all_tasks_done: false,
    production_activation: 'NOT_AUTHORIZED', merge_authority: false,
    live: { status: qualified ? 'PASSED' : failed ? 'FAILED' : 'UNKNOWN', scope: 'LIVE_5G_ONLY',
      required: REQUIRED_V2_SCENARIOS.length, passed: scenarios.filter(s => s.status === 'PASSED').length,
      failure_code: sandbox.failure_code === 'ruleset_probe_not_rejected' ? sandbox.failure_code : null,
      original_ruleset_http_status: 'UNKNOWN', scenarios },
    local_tests: localStatus(localTests), offline_mutation: mutationStatus(mutationEvidence),
    external_grok: { status: 'UNKNOWN', reviewer: 'PAUSED_EXCLUDED',
      metadata_collection_complete: operatorReadiness?.schemaVersion === 1 && operatorReadiness.collectionComplete === true,
      capability_proven: false },
    provenance: { sandbox_source_commit: commit(sandbox.source_commit), runtime_source_commit: commit(runtime.sourceCommit),
      driver_source_commit: commit(sandbox.driver_source_commit),
      runtime_mode: ['installed', 'checkout'].includes(runtime.mode) ? runtime.mode : null, module_sha256: entries,
      cross_artifact_binding: 'NOT_ESTABLISHED', current_source_match: 'NOT_CHECKED' },
    limits: ['Artifact assertions only; input hashes identify bytes, not authenticity.',
      'Local tests and offline mutation do not prove unrun live scenarios.',
      'Later diagnostics cannot replace original run failures.',
      'External capabilities and production acceptance require separate evidence.'] };
}
export async function main(argv, out = process.stdout) {
  if (argv.length === 1 && argv[0] === '--help') {
    out.write('Usage: node scripts/report-bridge-acceptance.mjs --sandbox-report PATH [--local-tests PATH] [--mutation-evidence PATH] [--operator-readiness PATH] [--format json|md]\nOffline artifact report. Stdout only. Advisory; never authorizes activation. Exit 0: report emitted, 2: invalid input.\n');
    return;
  }
  const keys = { '--sandbox-report': 'sandbox', '--local-tests': 'localTests', '--mutation-evidence': 'mutationEvidence', '--operator-readiness': 'operatorReadiness' };
  const paths = {}, inputs = {}, values = {}; let format = 'json', formatSeen = false;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!value || value.startsWith('--')) throw Error('usage');
    if (flag === '--format') {
      if (formatSeen || !['json', 'md'].includes(value)) throw Error('usage');
      format = value; formatSeen = true;
    } else {
      if (!Object.hasOwn(keys, flag) || paths[flag]) throw Error('usage');
      paths[flag] = value;
    }
  }
  if (!paths['--sandbox-report']) throw Error('usage');
  for (const [flag, path] of Object.entries(paths)) {
    const bytes = await readFile(path);
    if (bytes.length > 32 * 1024 * 1024) throw Error('invalid_input');
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!object(parsed)) throw Error('invalid_input');
    values[keys[flag]] = parsed;
    inputs[flag.slice(2).replaceAll('-', '_')] = { sha256: hash(bytes) };
  }
  const report = { ...buildAcceptanceReport(values), inputs };
  out.write(format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : `# Bridge acceptance\n\nADVISORY_ONLY. All tasks done: false. Production: NOT_AUTHORIZED.\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('Report failed: invalid usage or input artifact. No input content or error details are printed.\n');
    process.exitCode = 2;
  });
}

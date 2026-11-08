// A test failure kills a mutant only when the failure is an actual assertion.
// Resource, launcher, import and unhandled failures invalidate the experiment.
import { isDeepStrictEqual } from 'node:util';

export function selectMutationNames(names, selected) {
  for (const name of selected) {
    if (!names.includes(name)) throw Error(`unknown mutant: ${name}`);
  }
  return selected.length ? names.filter(name => selected.includes(name)) : names;
}

export function classifyMutationResult({ status, signal, error, output }) {
  const plain = String(output ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const infrastructureFailure = /Test timed out|Hook timed out|Timeout calling|ERR_TEST_TIMEOUT|ETIMEDOUT|SIGKILL|SIGTERM|SIGINT|SIGABRT|SIGSEGV|Unhandled Errors?|Transform failed|Failed to load|Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_UNKNOWN_FILE_EXTENSION|Failed to start|Worker exited unexpectedly|Parse failure/i.test(plain)
    || /^\s*(?:TypeError|ReferenceError|SyntaxError|RangeError|AggregateError):/m.test(plain);
  if (signal || error || infrastructureFailure || !Number.isInteger(status)) return 'invalid';
  if (status === 0) return 'survived';
  if (status !== 1) return 'invalid';
  const failedTest = /^\s*FAIL\s+src\/[^\n]+ >[^\n]*/m.test(plain);
  const assertion = /^\s*AssertionError(?:\s*\[[^\]]+\])?:/m.test(plain);
  return failedTest && assertion ? 'killed' : 'invalid';
}

const fixturePath = '.github/workflows/osstack-5g-injected.yml';
const markerPrefix = 'OSSTACK_ADVERSARIAL_RUNNER_EVIDENCE=';
const targetTest = 'src/contained-mission-adversarial.test.ts > offline protected workflow proposal halts before local application';
const targetAssertion = 'PROTECTED_WORKFLOW_MUST_HALT_BEFORE_APPLY';
const plainOutput = result => String(result.output ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');

function protectedPathEvidence(result, sourcePath, sourceHash) {
  const lines = plainOutput(result).split('\n').filter(line => line.includes(markerPrefix));
  if (lines.length !== 1 || !lines[0].startsWith(markerPrefix)) return null;
  try {
    const value = JSON.parse(lines[0].slice(markerPrefix.length));
    if (value?.schema_version !== 1 || value.evidence_class !== 'offline_scripted_runner'
      || value.fixture_path !== fixturePath || !/^[a-f0-9]{64}$/.test(value.fixture_sha256)
      || value.classifier_source !== sourcePath || value.classifier_source_sha256 !== sourceHash
      || !/^[a-f0-9]{64}$/.test(sourceHash)
      || value.allowed_paths_kind !== 'adversarial_fixture' || !Array.isArray(value.allowed_paths)
      || !value.allowed_paths.includes('.github/workflows/**')
      || !value.caps || typeof value.caps !== 'object' || Array.isArray(value.caps)
      || typeof value.spec_digest !== 'string' || !value.spec_digest
      || !Array.isArray(value.classifier?.findings) || !Array.isArray(value.classifier.reasons)
      || !value.classifier.findings.every(f => f && typeof f.code === 'string' && typeof f.path === 'string')
      || typeof value.classifier.protectedSetDigest !== 'string' || !value.classifier.protectedSetDigest
      || !value.runner) return null;
    return value;
  } catch { return null; }
}

export function validateProtectedPathBaseline(result, sourcePath, sourceHash) {
  if (classifyMutationResult(result) !== 'survived') return false;
  const value = protectedPathEvidence(result, sourcePath, sourceHash);
  return !!value && value.classifier.tier === 'T2'
    && value.classifier.reasons.includes('PROTECTED_PATH')
    && value.classifier.findings.some(f => f.code === 'PROTECTED_PATH' && f.path === fixturePath)
    && value.runner.state === 'awaiting_decision'
    && value.runner.read_count === 0 && value.runner.commit_count === 0
    && value.runner.verify_count === 0 && value.runner.publish_count === 0
    && value.runner.candidate_head === null;
}

// This stricter oracle applies only to the v2 negative control. The original
// nineteen mutants retain classifyMutationResult's classifications unchanged.
export function classifyProtectedPathMutationResult({ baseline, mutant, sourcePath, baselineSourceHash, mutantSourceHash }) {
  if (!validateProtectedPathBaseline(baseline, sourcePath, baselineSourceHash)
    || baselineSourceHash === mutantSourceHash || classifyMutationResult(mutant) !== 'killed') return 'invalid';
  const before = protectedPathEvidence(baseline, sourcePath, baselineSourceHash);
  const after = protectedPathEvidence(mutant, sourcePath, mutantSourceHash);
  if (!after) return 'invalid';
  for (const key of ['fixture_sha256', 'allowed_paths_kind', 'allowed_paths', 'caps', 'spec_digest']) {
    if (!isDeepStrictEqual(before[key], after[key])) return 'invalid';
  }
  if (before.classifier.protectedSetDigest !== after.classifier.protectedSetDigest
    || !['T0', 'T1'].includes(after.classifier.tier)
    || after.classifier.reasons.includes('PROTECTED_PATH')
    || after.classifier.findings.some(f => f.code === 'PROTECTED_PATH' && f.path === fixturePath)
    || !Number.isInteger(after.runner.read_count) || after.runner.read_count <= 0
    || !Number.isInteger(after.runner.commit_count) || after.runner.commit_count <= 0
    || typeof after.runner.candidate_head !== 'string' || !after.runner.candidate_head
    || after.runner.publish_count !== 0) return 'invalid';
  const plain = plainOutput(mutant);
  const failures = plain.match(/^\s*FAIL\s+src\/[^\n]+ >[^\n]*/gm) ?? [];
  const assertions = plain.match(/^\s*AssertionError(?:\s*\[[^\]]+\])?:[^\n]*/gm) ?? [];
  if (failures.length !== 1 || failures[0].trim().replace(/^FAIL\s+/, '') !== targetTest
    || assertions.length !== 1 || !new RegExp(`: ${targetAssertion}(?=:|\\s|$)`).test(assertions[0])
    || /^\s*(?:Error|\w*(?:Error|Exception)):/m.test(plain.replace(/^\s*AssertionError(?:\s*\[[^\]]+\])?:[^\n]*/gm, ''))
    || /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network error/i.test(plain)) return 'invalid';
  return 'killed';
}

// Contract composition only. These synthetic receipts are not host execution authority.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  VerificationProfileIdSchema, localFailureBindingFromLedger, localFailureEligibility, localVerificationReceiptDigest,
  parseCiFailureHint, parseLocalFailureBinding, type LocalVerificationReceipt,
  createScratchDirSync, signLocalFailureRevisionGrant, parseStoredRevisionGrant, verifyStoredRevisionGrantSignature,
} from '@osstack/core';
import { canonicalJson } from '@osstack/protocol/source';
import { afterEach, describe, expect, it } from 'vitest';
import { readCiFailureHints } from './contained-mission-local-failure-reader.js';
import { normalizeContainedRevisionFeedback } from './contained-mission-revision-feedback.js';
import { loadInstalledVerificationProfile, verificationProfileDigest, type ContainedVerificationProfile } from './contained-mission-verification-profile.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const intakeId = 'lfi_00000000-0000-4000-8000-000000000001';
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const now = 1_800_000_000_000;
const samplePreview = () => ({
  kind: 'live' as const, grant_id: 'rg_00000000-0000-4000-8000-000000000002', rounds: 1 as const,
  principal_id: 'human', client_session_id: 'fixture', scope_id: 'a'.repeat(64), root_mission_id: 'cm_00000000-0000-4000-8000-000000000003',
  repository: 'o/r', pr_number: 7, branch: 'osstack/mission/fixture', base_ref: 'main', base_sha: 'b'.repeat(40), head_sha: 'c'.repeat(40),
  issued_at: now, expires_at: now + 3_600_000, review_deadline_ms: 3_600_000,
  budget: { max_executor_seconds: 3600, max_container_seconds: 3600, max_wall_clock_hours: 48 },
  protected_set_digest: 'd'.repeat(64), nonce: 'e'.repeat(32), key_id: 'fixture-key',
});
const profile = (profileId = 'bridge-contract'): ContainedVerificationProfile => ({
  version: 1, profile_id: profileId, harness: { path: '/osstack-trusted/harness.mjs', content: 'process.exit(1);\n' }, fixtures: [],
  argv: ['/usr/bin/node', '/osstack-trusted/harness.mjs'], image: `fixture/verification@sha256:${'a'.repeat(64)}`,
  checks: [{ check_id: 'bridge-test', category: 'test', failure_exit_codes: [1] }],
  limits: { timeout_seconds: 60, memory_mb: 128, cpus: 1, pids: 64, stdout_bytes: 4096, stderr_bytes: 4096 },
  network: 'none', read_only_rootfs: true, no_new_privileges: true, working_directory: 'candidate',
});
function fixture(profileId = 'bridge-contract') {
  const root = realpathSync(createScratchDirSync('tests', 'local-failure-contracts')); roots.push(root);
  const artifact = { version: 1, trusted_source: { repository: 'o/trusted', commit: 'e'.repeat(64) }, profile: profile(profileId) };
  const bytes = JSON.stringify(artifact), artifactDigest = sha(bytes), path = join(root, `${artifactDigest}.json`);
  writeFileSync(path, bytes, { mode: 0o600 });
  const keys = generateKeyPairSync('ed25519');
  const signed = signLocalFailureRevisionGrant({ ...samplePreview(), version: 2, local_failure: {
    enabled: true, profile_id: artifact.profile.profile_id, profile_digest: verificationProfileDigest(artifact.profile),
    trusted_source: { ...artifact.trusted_source, artifact_digest: artifactDigest }, diagnostic_timeout_seconds: 60, max_diagnostics_per_head: 1,
  } }, keys.privateKey);
  const stored = parseStoredRevisionGrant(JSON.stringify(signed));
  if (stored.version !== 2) throw Error('expected V2 fixture');
  const optIn = stored.local_failure;
  const loaded = loadInstalledVerificationProfile({ installedRoot: root, ownerUid: process.getuid!(), allowedArgv: [artifact.profile.argv] }, {
    profile_id: optIn.profile_id, profile_digest: optIn.profile_digest, trusted_source: optIn.trusted_source,
  });
  const binding = localFailureBindingFromLedger({
    intake_id: intakeId, chain_id: 'rc_fixture', root_mission_id: stored.root_mission_id, grant_id: stored.grant_id,
    repository: stored.repository, pr_number: stored.pr_number, branch: stored.branch, head_sha: stored.head_sha,
    tree_sha: 'f'.repeat(40), base_ref: stored.base_ref, base_sha: stored.base_sha, profile_id: loaded.binding.profile_id,
    profile_digest: loaded.binding.profile_digest, trusted_source_digest: loaded.binding.trusted_source.artifact_digest, invocation_id: 'fixture-diagnostic',
  });
  const receipt: LocalVerificationReceipt = { version: 1, ...binding, started_at: now, finished_at: now + 1000,
    outcome: 'reproducible_failure', checks: [{ check_id: 'bridge-test', category: 'test', exit_code: 1, result_digest: '1'.repeat(64) }],
    bounded_redacted_summary: 'Synthetic contract fixture only.', evidence_digest: '2'.repeat(64),
    stop: { proven: true, proof_ref: 'fixture:stop', proof_digest: '3'.repeat(64) },
  };
  return { keys, stored, loaded, binding, receipt, path, bytes };
}

describe('local-failure cross-leaf contracts (no host authority)', () => {
  it('composes signed V2, immutable installed profile, typed ledger binding and canonical feedback reference', () => {
    const f = fixture();
    expect(verifyStoredRevisionGrantSignature(f.stored, f.keys.publicKey)).toBe(true);
    expect(f.loaded.revalidateForLaunch().profile.checks).toEqual(profile().checks);
    expect(localFailureEligibility(f.receipt, f.binding, f.loaded.profile.checks)).toEqual({ eligible: true });
    const digest = localVerificationReceiptDigest(f.receipt);
    expect(digest).toBe(sha(canonicalJson({ domain: 'osstack.local-verification-receipt.v1', receipt: f.receipt })));
    expect(digest).not.toBe(sha(JSON.stringify(f.receipt)));
    const feedback = normalizeContainedRevisionFeedback({ source: { kind: 'local_verification', intake_id: f.receipt.intake_id, receipt_digest: digest }, nonce: 'a'.repeat(32), text: f.receipt.bounded_redacted_summary });
    expect(feedback.source).toEqual({ kind: 'local_verification', intake_id: intakeId, receipt_digest: digest });
    expect(feedback).not.toHaveProperty('review_ids');
    expect(feedback).not.toHaveProperty('authorized');
  });
  it('maps every database identity explicitly without leaking database-only field names', () => {
    const { binding, stored } = fixture();
    expect(binding).toMatchObject({ pr: stored.pr_number, head: stored.head_sha, tree: 'f'.repeat(40) });
    expect(Object.keys(binding)).not.toEqual(expect.arrayContaining(['pr_number', 'head_sha', 'tree_sha']));
    expect(parseLocalFailureBinding(binding)).toEqual(binding);
  });
  it.each(['lf_fixture', 'lfi_fixture', 'lfi_' + 'a'.repeat(35), intakeId + '\n'])('all reference boundaries reject noncanonical intake ID %j', badId => {
    const { binding } = fixture();
    expect(() => parseLocalFailureBinding({ ...binding, intake_id: badId })).toThrow();
    expect(() => normalizeContainedRevisionFeedback({ source: { kind: 'local_verification', intake_id: badId, receipt_digest: 'a'.repeat(64) }, nonce: 'b'.repeat(32), text: '' })).toThrow();
  });
  it('accepts every loader check definition directly but rejects runtime/timeout exits and changed profile identity', () => {
    const f = fixture();
    for (const exit_code of [0, null, 124, 127, 137]) {
      expect(localFailureEligibility({ ...f.receipt, checks: [{ ...f.receipt.checks[0], exit_code }] }, f.binding, f.loaded.profile.checks).eligible).toBe(false);
    }
    expect(localFailureEligibility(f.receipt, { ...f.binding, profile_digest: '9'.repeat(64) }, f.loaded.profile.checks).eligible).toBe(false);
    writeFileSync(f.path, f.bytes.replace('process.exit(1)', 'process.exit(0)'));
    expect(f.loaded.revalidateForLaunch).toThrow();
  });
  it('CI reader output parses directly as the one canonical epoch-ms domain hint', async () => {
    const target = { repository: 'o/r', pr: 7, head: 'c'.repeat(40), producerAppIds: [42] };
    const result = await readCiFailureHints({ now: () => new Date(now),
      rest: async path => ({ ok: true, body: path.endsWith('/pulls/7')
        ? { number: 7, state: 'open', head: { sha: target.head, repo: { full_name: target.repository } }, base: { repo: { full_name: target.repository } } }
        : path.includes('/check-runs?')
          ? { total_count: 1, check_runs: [{ id: 101, name: 'unit', app: { id: 42 }, head_sha: target.head, check_suite: { id: 11 }, status: 'completed', conclusion: 'failure', output: { text: 'untrusted command' } }] }
          : { total_count: 1, check_suites: [{ id: 11, app: { id: 42 }, head_sha: target.head }] } }),
      latestAttempt: async () => ({ complete: true, requests_used: 1, repository: target.repository, pr: 7, head: target.head, app_id: 42, name: 'unit', latest: { check_suite_id: 11, check_run_id: 101, status: 'completed', conclusion: 'failure' } }),
    }, target, { signal: new AbortController().signal });
    expect(result.ok).toBe(true);
    expect(result.hints).toHaveLength(1);
    expect(parseCiFailureHint(result.hints[0])).toEqual({ repository: target.repository, pr: 7, head: target.head, app_id: 42, check_run_id: 101, name: 'unit', status: 'completed', conclusion: 'failure', observed_at: now });
  });
});

it.each(['A', 'bridge.v1-main_2', '9' + 'a'.repeat(127)])('composes the shared profile ID grammar through signing, loading and receipt binding: %s', profile_id => {
  expect(VerificationProfileIdSchema.parse(profile_id)).toBe(profile_id);
  const f = fixture(profile_id);
  expect(f.stored.local_failure.profile_id).toBe(profile_id);
  expect(f.loaded.profile.profile_id).toBe(profile_id);
  expect(f.binding.profile_id).toBe(profile_id);
  expect(localFailureEligibility(f.receipt, f.binding, f.loaded.profile.checks)).toEqual({ eligible: true });
});

it.each(['bridge profile', 'bridge:profile', 'bridge/profile', '_bridge', '.bridge', 'bridge@v1', '验证', 'a'.repeat(129)])('shared profile grammar and installed profile parsing reject %s', profile_id => {
  expect(VerificationProfileIdSchema.safeParse(profile_id).success).toBe(false);
  expect(() => verificationProfileDigest({ ...profile(), profile_id })).toThrow();
});

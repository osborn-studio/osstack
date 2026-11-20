import { parseVerificationProducerPolicyV1 } from '@osstack/core/verification-intake';
import { buildVerificationResult } from '@osstack/core/verification-publish';
import { expect, it } from 'vitest';
import { classifyVerificationCheckRun } from './contained-mission-verification-reader.js';

const target = { repository: 'fixture-owner/fixture-repo', repository_id: 101, pr: 7, head: 'a'.repeat(40),
  base_sha: 'b'.repeat(40), base_ref: 'main', branch: 'fixture-branch' };
function policy(repository_id = 101, ttl_ms = 86400000) {
  const p = parseVerificationProducerPolicyV1({ schema_version: 1, producers: [{ type: 'App', app_id: 201, installation_id: 301, repository_id,
    carrier: 'check-run', skill_id: 'fixture-skill', skill_manifest_digest: 'c'.repeat(64), profile_id: 'fixture-profile', profile_digest: 'd'.repeat(64),
    allowed_failure_codes: ['assertion_failed'], ttl_ms, evidence_store: 'fixture-store' }] });
  if (!p.ok) throw new Error(p.code);
  return p.policy;
}

it.each(['passed', 'failed'] as const)('reads the published %s check run from the registered App', outcome => {
  const failure_code = outcome === 'failed' ? 'assertion_failed' : null;
  const started_at = '2026-11-16T12:00:00Z';
  const finished_at = '2026-11-16T12:01:00Z';
  const generated_at = '2026-11-16T12:02:00Z';
  const built = buildVerificationResult({
    result_id: '00000000-0000-4000-8000-000000000001', attempt: 1, generated_at, target: { ...target, head_sha: target.head },
    binding: { skill_id: 'fixture-skill', skill_version: '1.0.0', skill_blob: 'e'.repeat(40), skill_manifest_digest: 'c'.repeat(64),
      profile_id: 'fixture-profile', profile_digest: 'd'.repeat(64),
      trusted_source: { repository: 'fixture-owner/fixture-harness', commit_sha: 'e'.repeat(40), artifact_digest: 'f'.repeat(64) } },
    producer: { type: 'App', app_id: 201, installation_id: 301 }, supersedes_result_id: null, recheck: null,
    record: { invocation_id: '00000000-0000-4000-8000-000000000002', started_at, finished_at, outcome, failure_code,
      checks: [{ check_id: 'fixture-check', failure_code, exit: outcome === 'failed' ? 1 : 0, result_digest: '1'.repeat(64) }],
      evidence_refs: [], evidence_digest: '3'.repeat(64), runtime_provenance: { runtime_id: 'fixture-runtime',
        runtime_digest: '4'.repeat(64), source_manifest_digest: '5'.repeat(64) }, summary: 'Synthetic verification' },
  });
  if (!built.ok) throw new Error(built.reason);
  const detail = { ...built.publication.check_run, id: 1, app: { id: 201 }, check_suite: { id: 11 }, started_at, completed_at: finished_at };
  const now = Date.parse(generated_at);
  expect(classifyVerificationCheckRun(detail, policy(), target, 301, now))
    .toMatchObject({ verdict: { ok: true }, result: built.publication.result });
  expect(classifyVerificationCheckRun({ ...detail, app: { id: 999 } }, policy(), target, 301, now))
    .toMatchObject({ verdict: { ok: false, code: 'verify_producer_untrusted' }, result: null });
});

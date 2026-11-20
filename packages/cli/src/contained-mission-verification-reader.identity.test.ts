import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideVerificationSources, parseVerificationProducerPolicyV1, verificationDedupKey } from '@osstack/core/verification-intake';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createVerificationInstallationProof } from './contained-mission-verification-installation.js';
import { createVerificationRest } from './contained-mission-verification-read-transport.js';
import { readVerificationResults, type VerificationReadDeps } from './contained-mission-verification-reader.js';

const now = Date.parse('2026-11-16T12:02:00Z');
const target = { repository: 'fixture-owner/fixture-repo', repository_id: 101, pr: 7, head: 'a'.repeat(40), base_sha: 'b'.repeat(40), base_ref: 'main', branch: 'fixture-branch' };
function payload() {
  const value = {
    schema_version: 1, result_id: '00000000-0000-4000-8000-000000000001', attempt: 1,
    repository: target.repository, repository_id: 101, pr: 7, branch: target.branch, base_ref: 'main', head_sha: target.head, base_sha: target.base_sha,
    skill_id: 'fixture-skill', skill_version: '1.0.0', skill_blob: 'e'.repeat(40), skill_manifest_digest: 'c'.repeat(64), profile_id: 'fixture-profile', profile_digest: 'd'.repeat(64),
    trusted_source: { repository: 'fixture-owner/fixture-harness', commit_sha: 'e'.repeat(40), artifact_digest: 'f'.repeat(64) },
    invocation_id: '00000000-0000-4000-8000-000000000002', started_at: '2026-11-16T12:00:00Z', finished_at: '2026-11-16T12:01:00Z', generated_at: '2026-11-16T12:02:00Z',
    outcome: 'failed', failure_code: 'assertion_failed', checks: [], evidence_refs: [], evidence_digest: '3'.repeat(64),
    runtime_provenance: { runtime_id: 'fixture-runtime', runtime_digest: '4'.repeat(64), source_manifest_digest: '5'.repeat(64) },
    supersedes_result_id: null, withdraws_result_id: null, withdraw_reason_code: null,
    producer: { type: 'App', app_id: 201, installation_id: 301 }, summary: 'PAYLOAD_REFERENCE_MARKER',
  };
  return { ...value, dedup_key: verificationDedupKey(value) };
}
function policy() {
  const p = parseVerificationProducerPolicyV1({ schema_version: 1, producers: [{ type: 'App', app_id: 201, installation_id: 301, repository_id: 101,
    carrier: 'check-run', skill_id: 'fixture-skill', skill_manifest_digest: 'c'.repeat(64), profile_id: 'fixture-profile', profile_digest: 'd'.repeat(64),
    allowed_failure_codes: ['assertion_failed'], ttl_ms: 86400000, evidence_store: 'fixture-store' }] });
  if (!p.ok) throw new Error(p.code);
  return p.policy;
}
function run() {
  const contract = payload();
  return { id: 1, name: 'osstack/verify-intake/fixture-skill', app: { id: 201 }, head_sha: target.head, check_suite: { id: 11 }, status: 'completed', conclusion: 'failure', external_id: contract.result_id,
    started_at: '2026-11-16T12:00:00Z', completed_at: '2026-11-16T12:01:00Z',
    output: { text: JSON.stringify(contract), title: 'TITLE_MARKER', summary: 'SUMMARY_MARKER' }, details_url: 'DETAILS_MARKER', html_url: 'HTML_MARKER' };
}
const repo = { id: 101, full_name: target.repository };
const pr = () => ({ number: 7, state: 'open', head: { sha: target.head, ref: target.branch, repo: { ...repo } }, base: { sha: target.base_sha, ref: 'main', repo: { ...repo } } });
const root = `repos/${target.repository}`;
const prPath = `${root}/pulls/7`;
const suitesPath = `${root}/commits/${target.head}/check-suites?per_page=100&page=1`;
const runsPath = `${root}/check-suites/11/check-runs?filter=all&per_page=100&page=1`;
const detailPath = `${root}/check-runs/1`;
const incomplete = { status: 'waiting_source', code: 'verify_read_incomplete' };
let home: string; let key: string;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'verification-identity-')); key = join(home, 'fixture-key');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
});
afterAll(async () => { await rm(home, { recursive: true, force: true }); });
const body = { id: 301, app_id: 201, suspended_at: null, repository_selection: 'selected', permissions: { checks: 'write', metadata: 'read' } };
function harness(edit: Record<string, unknown> = {}) {
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ...body, ...edit }));
  const installationFor = createVerificationInstallationProof({ app_id: 201, installation_id: 301, verification_private_key_path: key },
    target, { fetchImpl, now: () => now }) satisfies NonNullable<VerificationReadDeps['installationFor']>;
  void (createVerificationRest() satisfies VerificationReadDeps['rest']);
  const row = run();
  const bodies = new Map<string, unknown>([[prPath, pr()], [detailPath, row],
    [suitesPath, { total_count: 1, check_suites: [{ id: 11, head_sha: target.head }] }],
    [runsPath, { total_count: 1, check_runs: [row] }]]);
  const deps: VerificationReadDeps = { installationFor, now: () => new Date(now),
    rest: async path => bodies.has(path) ? { ok: true, body: bodies.get(path) } : { ok: false } };
  return { fetchImpl, read: () => readVerificationResults(deps, policy(), target, { signal: new AbortController().signal }) };
}
it('accepts the registered installation and exact permissions', async () => {
  expect(await harness().read()).toMatchObject({ status: 'read', observations: [{ verdict: { ok: true } }] });
});
it.each([{ permissions: { ...body.permissions, contents: 'read' } }, { id: 302 }, { repository_selection: 'all' }])('rejects a different installation or grant', async edit => {
  expect(await harness(edit).read()).toMatchObject({ status: 'read', observations: [{ verdict: { ok: false, code: 'verify_producer_untrusted' } }] });
});
it('records nothing during an outage and accepts the unchanged run on retry', async () => {
  const h = harness(); h.fetchImpl.mockResolvedValueOnce(new Response(null, { status: 500 }));
  expect(await h.read()).toEqual(incomplete);
  const r = await h.read(); if (r.status !== 'read') throw new Error('read expected');
  expect(decideVerificationSources([], r.observations)[0]?.outcome.decision).toBe('accepted');
});

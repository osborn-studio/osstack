import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { canonicalJson } from '@osstack/protocol/source';
import * as verificationIntake from '@osstack/core/verification-intake';
import { decideVerificationSources, parseVerificationProducerPolicyV1, verificationDedupKey } from '@osstack/core/verification-intake';
import { expect, it, vi } from 'vitest';
import { readVerificationResults, classifyVerificationCheckRun, type VerificationReadDeps, type VerificationReadLimits } from './contained-mission-verification-reader.js';

const now = Date.parse('2026-11-16T12:02:00Z');
const target = { repository: 'fixture-owner/fixture-repo', repository_id: 101, pr: 7, head: 'a'.repeat(40), base_sha: 'b'.repeat(40), base_ref: 'main', branch: 'fixture-branch' };
function payload(changes: Record<string, unknown> = {}) {
  const value = {
    schema_version: 1, result_id: '00000000-0000-4000-8000-000000000001', attempt: 1,
    repository: target.repository, repository_id: 101, pr: 7, branch: target.branch, base_ref: 'main', head_sha: target.head, base_sha: target.base_sha,
    skill_id: 'fixture-skill', skill_version: '1.0.0', skill_blob: 'e'.repeat(40), skill_manifest_digest: 'c'.repeat(64), profile_id: 'fixture-profile', profile_digest: 'd'.repeat(64),
    trusted_source: { repository: 'fixture-owner/fixture-harness', commit_sha: 'e'.repeat(40), artifact_digest: 'f'.repeat(64) },
    invocation_id: '00000000-0000-4000-8000-000000000002', started_at: '2026-11-16T12:00:00Z', finished_at: '2026-11-16T12:01:00Z', generated_at: '2026-11-16T12:02:00Z',
    outcome: 'failed', failure_code: 'assertion_failed', checks: [], evidence_refs: [], evidence_digest: '3'.repeat(64),
    runtime_provenance: { runtime_id: 'fixture-runtime', runtime_digest: '4'.repeat(64), source_manifest_digest: '5'.repeat(64) },
    supersedes_result_id: null, withdraws_result_id: null, withdraw_reason_code: null,
    producer: { type: 'App', app_id: 201, installation_id: 301 }, summary: 'PAYLOAD_REFERENCE_MARKER', ...changes,
  };
  return { ...value, dedup_key: verificationDedupKey(value) };
}
function policy(repository_id = 101, ttl_ms = 86400000) {
  const p = parseVerificationProducerPolicyV1({ schema_version: 1, producers: [{ type: 'App', app_id: 201, installation_id: 301, repository_id,
    carrier: 'check-run', skill_id: 'fixture-skill', skill_manifest_digest: 'c'.repeat(64), profile_id: 'fixture-profile', profile_digest: 'd'.repeat(64),
    allowed_failure_codes: ['assertion_failed'], ttl_ms, evidence_store: 'fixture-store' }] });
  if (!p.ok) throw new Error(p.code);
  return p.policy;
}
function run(id = 1, changes: Record<string, unknown> = {}, contract = payload()) {
  return { id, name: 'osstack/verify-intake/fixture-skill', app: { id: 201 }, head_sha: target.head, check_suite: { id: 11 }, status: 'completed', conclusion: 'failure', external_id: contract.result_id,
    started_at: '2026-11-16T12:00:00Z', completed_at: '2026-11-16T12:01:00Z',
    output: { text: JSON.stringify(contract), title: 'TITLE_MARKER', summary: 'SUMMARY_MARKER' }, details_url: 'DETAILS_MARKER', html_url: 'HTML_MARKER', ...changes };
}
const repo = { id: 101, full_name: target.repository };
const pr = () => ({ number: 7, state: 'open', head: { sha: target.head, ref: target.branch, repo: { ...repo } }, base: { sha: target.base_sha, ref: 'main', repo: { ...repo } } });
const root = `repos/${target.repository}`;
const prPath = `${root}/pulls/7`;
const suitesPath = `${root}/commits/${target.head}/check-suites?per_page=100&page=1`;
const runsPath = `${root}/check-suites/11/check-runs?filter=all&per_page=100&page=1`;
const detailPath = `${root}/check-runs/1`;
const incomplete = { status: 'waiting_source', code: 'verify_read_incomplete' };
type ResponseEdit = (path: string, body: unknown, call: number, occurrence: number) => unknown;
function harness(rows = [run()], edit?: ResponseEdit) {
  const calls: string[] = []; const counts = new Map<string, number>();
  const rest: VerificationReadDeps['rest'] = vi.fn(async path => {
    calls.push(path); const occurrence = (counts.get(path) ?? 0) + 1; counts.set(path, occurrence);
    let body: unknown;
    if (path === prPath) body = pr();
    else if (path === suitesPath) body = { total_count: 1, check_suites: [{ id: 11, head_sha: target.head, app: { id: 201 } }] };
    else if (path.startsWith(`${root}/check-suites/11/check-runs?`)) {
      const page = Number(path.split('&page=')[1]); body = { total_count: rows.length, check_runs: rows.slice((page - 1) * 100, page * 100) };
    } else body = rows.find(r => path === `${root}/check-runs/${r.id}`);
    body = structuredClone(body);
    return { ok: true, body: edit ? edit(path, body, calls.length, occurrence) : body };
  });
  const installationFor = vi.fn(async () => ({ installation_id: 301 }));
  const deps: VerificationReadDeps = { rest, installationFor, now: () => new Date(now) };
  return { deps, calls, installationFor, read: (limits?: Partial<VerificationReadLimits>) => readVerificationResults(deps, policy(), target, { signal: new AbortController().signal, ...(limits ? { limits } : {}) }) };
}
it.each([ { schema_version: 1 as const, producers: [] }, policy(999) ])('closes without reads for unmatched policy', async p => {
  const h = harness(); expect(await readVerificationResults(h.deps, p, target, { signal: new AbortController().signal })).toEqual({ status: 'closed' }); expect(h.calls).toEqual([]);
});
it('reads a trusted failure with exact digests, reference boundaries and GET order', async () => {
  const h = harness(); const r = await h.read(); expect(r.status).toBe('read');
  if (r.status !== 'read') throw new Error('read expected');
  expect(r.observed_at).toBe(now); expect(r.pending).toBe(0); expect(r.observations).toHaveLength(1);
  const o = r.observations[0]!;
  expect(o.verdict).toEqual({ ok: true }); expect(o.result?.summary).toMatchObject({ kind: 'external_reference', usage: 'reference_only', content: 'PAYLOAD_REFERENCE_MARKER' });
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  expect(o.response_digest).toBe(sha(canonicalJson({
    id: 1, name: 'osstack/verify-intake/fixture-skill', app_id: 201, head_sha: target.head, check_suite_id: 11,
    status: 'completed', conclusion: 'failure', external_id: payload().result_id,
    started_at: '2026-11-16T12:00:00Z', completed_at: '2026-11-16T12:01:00Z',
    output_title: 'TITLE_MARKER', output_summary: 'SUMMARY_MARKER', output_text: run().output.text,
  }))); expect(o.contract_digest).toBe(sha(run().output.text));
  expect(h.calls).toEqual([prPath, suitesPath, runsPath, detailPath, suitesPath, runsPath, prPath]);
  expect(h.calls.join()).not.toMatch(/logs|annotations|statuses|reviews|comments/);
  expect(JSON.stringify(r.observations)).not.toMatch(/TITLE_MARKER|SUMMARY_MARKER|DETAILS_MARKER|HTML_MARKER/);
  const withoutSummary = { ...o, result: { ...o.result, summary: null } };
  expect(JSON.stringify(withoutSummary)).not.toContain('PAYLOAD_REFERENCE_MARKER');
  expect(decideVerificationSources([], r.observations)[0]?.outcome.decision).toBe('accepted');
});
it.each([
  ['head', 'sha', 'f'.repeat(40), 'verify_stale_head'], ['base', 'sha', 'f'.repeat(40), 'verify_base_changed'],
  ['base', 'ref', 'other', 'verify_scope_unregistered'], ['head', 'ref', 'other', 'verify_scope_unregistered'],
] as const)('detects initial PR change %s.%s', async (side, field, value, code) => {
  const h = harness([run()], (path, body) => { if (path === prPath) { const p = pr(); p[side][field] = value; return p; } return body; });
  expect(await h.read()).toEqual({ status: 'target_changed', code });
});
it('rejects a fork', async () => {
  const h = harness([run()], (path, body) => { if (path === prPath) { const p = pr(); p.head.repo.id = 999; return p; } return body; });
  expect(await h.read()).toEqual({ status: 'target_changed', code: 'verify_scope_unregistered' });
});
it.each([1, 2, 3, 4, 5, 6, 7])('discards everything on REST failure at call %i', async position => {
  const h = harness(); const rest = h.deps.rest; let n = 0;
  expect(await readVerificationResults({ ...h.deps, rest: (path, options) => ++n === position ? Promise.resolve({ ok: false }) : rest(path, options) }, policy(), target, { signal: new AbortController().signal })).toEqual(incomplete);
});
it.each([1, 2, 3, 4, 5, 6, 7])('discards malformed body at call %i', async position => {
  expect(await harness([run()], (_path, body, call) => call === position ? {} : body).read()).toEqual(incomplete);
});
it.each(['head', 'base'] as const)('discards PR %s changes on reread', async side => {
  const h = harness([run()], (path, body, _call, occurrence) => { if (path === prPath && occurrence === 2) { const p = pr(); p[side].sha = 'f'.repeat(40); return p; } return body; });
  expect(await h.read()).toEqual(incomplete);
});
it('discards closed PR and list/detail disagreement', async () => {
  expect(await harness([run()], (path, body) => path === prPath ? { ...pr(), state: 'closed' } : body).read()).toEqual(incomplete);
  expect(await harness([run()], (path, body) => path === detailPath ? run(1, { conclusion: 'success' }) : body).read()).toEqual(incomplete);
});
it.each(['appear', 'disappear', 'conclusion', 'time'] as const)('discards pass-two %s', async change => {
  const h = harness([run()], (path, body, _call, occurrence) => path === runsPath && occurrence === 2 ? {
    total_count: change === 'appear' ? 2 : change === 'disappear' ? 0 : 1,
    check_runs: change === 'appear' ? [run(), run(2)] : change === 'disappear' ? [] : [run(1, change === 'time' ? { completed_at: '2026-11-16T12:02:00Z' } : { conclusion: 'success' })],
  } : body);
  expect(await h.read()).toEqual(incomplete);
});
it('finds matching runs on three pages and ignores unrelated payloads', async () => {
  const rows = Array.from({ length: 250 }, (_, i) => run(i + 1, i % 100 === 0 ? {} : { name: 'unrelated', output: { text: 'invalid' } }));
  const h = harness(rows); const r = await h.read(); expect(r.status).toBe('read');
  if (r.status === 'read') expect(r.observations.map(o => o.object_id)).toEqual([1, 101, 201]);
  expect(h.calls.filter(p => /\/check-runs\/\d+$/.test(p))).toHaveLength(3);
});
it.each(['total', 'short', 'pages', 'requests', 'results'] as const)('enforces %s completeness bounds', async kind => {
  const rows = Array.from({ length: 101 }, (_, i) => run(i + 1));
  const h = harness(rows, (path, body) => path.endsWith('&page=2') && kind === 'total' ? { total_count: 102, check_runs: [rows[100]] }
    : path === runsPath && kind === 'short' ? { total_count: 101, check_runs: rows.slice(0, 99) } : body);
  expect(await h.read({ maxResults: 100, ...(kind === 'pages' ? { maxPages: 1 } : kind === 'requests' ? { maxRequests: 2 } : {}) })).toEqual(incomplete);
});
it.each([{ maxPages: 101 }, { maxRequests: 1001 }, { maxResults: 101 }, { maxPages: 0 }, { maxRequests: 1.5 }])('rejects invalid limits %j without reads', async limits => {
  const h = harness(); expect(await h.read(limits)).toEqual(incomplete); expect(h.calls).toEqual([]);
});
it('rejects invalid targets without reads', async () => {
  for (const changes of [{ head: 'A'.repeat(40) }, { repository_id: Number.MAX_SAFE_INTEGER + 1 }, { pr: 0 }, { repository: '../escape' }]) {
    const h = harness(); expect(await readVerificationResults(h.deps, policy(), { ...target, ...changes }, { signal: new AbortController().signal })).toEqual(incomplete); expect(h.calls).toEqual([]);
  }
});
it.each(['before', 'during'] as const)('honors abort %s including an uncooperative port', async when => {
  const h = harness(); const controller = new AbortController();
  if (when === 'before') controller.abort();
  const result = readVerificationResults({ ...h.deps, rest: async () => { controller.abort(); return new Promise(() => {}); } }, policy(), target, { signal: controller.signal });
  expect(await result).toEqual(incomplete);
});
it.each(['absent', 'null', 'throws', 'wrong', 'unsafe'] as const)('requires independent installation proof: %s', async kind => {
  const h = harness(); const { installationFor: _ignored, ...deps } = h.deps;
  const proof = kind === 'absent' ? {} : { installationFor: async () => { if (kind === 'throws') throw new Error('fixture'); return kind === 'null' ? null : { installation_id: kind === 'wrong' ? 999 : 0 }; } };
  const r = await readVerificationResults({ ...deps, ...proof }, policy(), target, { signal: new AbortController().signal });
  expect(r.status).toBe('read'); if (r.status === 'read') expect(r.observations[0]).toMatchObject({ verdict: { ok: false, code: 'verify_producer_untrusted' }, result: null });
});
it('rejects unregistered Apps before payload parsing and caches proof once per App', async () => {
  const h = harness([run(3, { app: { id: 999 } }), run(2), run(1)]); const r = await h.read();
  expect(h.installationFor).toHaveBeenCalledTimes(1);
  if (r.status !== 'read') throw new Error('read expected');
  expect(r.observations.map(o => [o.app_id, o.object_id])).toEqual([[201, 1], [201, 2], [999, 3]]);
  expect(r.observations[2]).toMatchObject({ verdict: { ok: false, code: 'verify_producer_untrusted' }, result: null });
  // Invalid text would report contract_invalid if the parser ran first.
  expect(classifyVerificationCheckRun(run(4, { app: { id: 999 }, output: { text: '{' } }), policy(), target, 301, now)).toMatchObject({ verdict: { code: 'verify_producer_untrusted' }, result: null });
  expect(decideVerificationSources([], [r.observations[0]!, r.observations[2]!]).map(x => x.outcome.decision)).toEqual(['accepted', 'rejected']);
});
it.each([
  ['app', { producer: { type: 'App', app_id: 202, installation_id: 301 } }, 'verify_contract_invalid', false],
  ['installation', { producer: { type: 'App', app_id: 201, installation_id: 302 } }, 'verify_contract_invalid', false],
  ['PR', { pr: 8 }, 'verify_scope_unregistered', false], ['repo', { repository_id: 102 }, 'verify_scope_unregistered', false],
  ['repository', { repository: 'fixture-owner/other' }, 'verify_scope_unregistered', false], ['branch', { branch: 'other' }, 'verify_scope_unregistered', false],
  ['base ref', { base_ref: 'other' }, 'verify_scope_unregistered', false],
  ['skill digest', { skill_manifest_digest: 'f'.repeat(64) }, 'verify_skill_unregistered', false],
  ['profile digest', { profile_digest: 'f'.repeat(64) }, 'verify_skill_unregistered', false],
  ['failure code', { failure_code: 'other' }, 'verify_skill_unregistered', false],
  ['head', { head_sha: 'f'.repeat(40) }, 'verify_stale_head', true], ['base', { base_sha: 'f'.repeat(40) }, 'verify_base_changed', true],
] as const)('classifies payload %s binding', async (_name, changes, code, retained) => {
  const r = await harness([run(1, {}, payload(changes))]).read();
  if (r.status !== 'read') throw new Error('read expected');
  expect(r.observations[0]?.verdict).toEqual({ ok: false, code }); expect(r.observations[0]?.result !== null).toBe(retained);
});
it.each([
  { name: 'osstack/verify-intake/other' }, { external_id: 'other' }, { conclusion: 'success' }, { output: {} },
  { output: { text: 'x'.repeat(16385) } }, { output: { text: JSON.stringify(payload()).replace('{', '{"attempt":1,') } },
])('rejects inconsistent or invalid envelopes %j', async changes => {
  const r = await harness([run(1, changes)]).read(); if (r.status !== 'read') throw new Error('read expected');
  expect(r.observations[0]).toMatchObject({ verdict: { code: 'verify_contract_invalid' }, result: null });
  if (!('text' in (changes.output ?? { text: '' }))) expect(r.observations[0]?.contract_digest).toBeNull();
});
it('rejects an unregistered skill with a consistent envelope', async () => {
  const r = await harness([run(1, { name: 'osstack/verify-intake/other' }, payload({ skill_id: 'other' }))]).read();
  if (r.status !== 'read') throw new Error('read expected'); expect(r.observations[0]?.verdict).toEqual({ ok: false, code: 'verify_skill_unregistered' });
});
it.each([25 * 3600000, -6 * 60000, 120000])('expires age %i using global and producer bounds', async age => {
  const time = new Date(now - age).toISOString(); const contract = payload({ started_at: time, finished_at: time, generated_at: time });
  const h = harness([run(1, {}, contract)]); const r = await readVerificationResults(h.deps, policy(101, 60000), target, { signal: new AbortController().signal });
  if (r.status !== 'read') throw new Error('read expected'); expect(r.observations[0]?.verdict).toEqual({ ok: false, code: 'verify_result_expired' }); expect(r.observations[0]?.result).not.toBeNull();
});
it('counts pending runs without parsing or proving installation', async () => {
  const h = harness([run(1, { status: 'in_progress', conclusion: null, completed_at: null, output: { text: '{' } })]);
  expect(await h.read()).toEqual({ status: 'read', observed_at: now, pending: 1, observations: [] }); expect(h.installationFor).not.toHaveBeenCalled();
});
it('returns withdrawals for ledger decision', async () => {
  const contract = payload({ outcome: 'cancelled', failure_code: null, withdraws_result_id: '00000000-0000-4000-8000-000000000003', withdraw_reason_code: 'source_invalid' });
  const r = await harness([run(1, { conclusion: 'cancelled' }, contract)]).read();
  if (r.status !== 'read') throw new Error('read expected'); expect(r.observations[0]?.verdict).toEqual({ ok: true }); expect(r.observations[0]?.result?.withdraws_result_id).toBe(contract.withdraws_result_id);
});
it('lets the ledger reject attempt gaps', async () => {
  const r = await harness([run(), run(3, {}, payload({ attempt: 3, result_id: '00000000-0000-4000-8000-000000000003' }))]).read();
  if (r.status !== 'read') throw new Error('read expected'); expect(decideVerificationSources([], r.observations).map(x => x.outcome)).toMatchObject([{ decision: 'accepted' }, { decision: 'rejected', reason_code: 'verify_attempt_ambiguous' }]);
});
it('has only allowed imports and stays unwired', () => {
  const source = readFileSync(new URL('./contained-mission-verification-reader.ts', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
  expect(imports.sort()).toEqual(['@osstack/core/verification-intake', '@osstack/protocol/source', 'node:crypto', 'zod'].sort());
  for (const name of readdirSync(new URL('.', import.meta.url))) {
    if (!name.endsWith('.ts') || name.startsWith('contained-mission-verification-reader.')) continue;
    expect(readFileSync(new URL(name, import.meta.url), 'utf8'), name).not.toMatch(/from\s+['"].*contained-mission-verification-reader|import\s*\(['"].*contained-mission-verification-reader/);
  }
});

it('never invokes the parser for a valid payload from an unregistered App', async () => {
  const parser = vi.spyOn(verificationIntake, 'parseVerificationResultV1');
  try {
    const r = await harness([run(1, { app: { id: 999 } })]).read();
    expect(r.status).toBe('read');
    expect(parser).not.toHaveBeenCalled();
  } finally { parser.mockRestore(); }
});
it.each(['suite duplicate', 'run duplicate', 'suite head', 'run head', 'run suite'] as const)('rejects %s identity corruption', async kind => {
  const h = harness([run()], (path, body) => {
    if (path === suitesPath && kind.startsWith('suite')) return {
      total_count: kind === 'suite duplicate' ? 2 : 1,
      check_suites: kind === 'suite duplicate' ? [{ id: 11, head_sha: target.head }, { id: 11, head_sha: target.head }] : [{ id: 11, head_sha: 'f'.repeat(40) }],
    };
    if (path === runsPath && kind.startsWith('run')) return {
      total_count: kind === 'run duplicate' ? 2 : 1,
      check_runs: kind === 'run duplicate' ? [run(), run()] : [run(1, kind === 'run head' ? { head_sha: 'f'.repeat(40) } : { check_suite: { id: 12 } })],
    };
    return body;
  });
  expect(await h.read()).toEqual(incomplete);
});
it('counts independent installation proof against the request budget', async () => {
  const h = harness(); expect(await h.read({ maxRequests: 7 })).toEqual(incomplete);
  expect(h.calls).toHaveLength(7); expect(h.installationFor).not.toHaveBeenCalled();
  expect((await harness().read({ maxRequests: 8 })).status).toBe('read');
});
it('discards thrown REST errors and aborts during installation proof', async () => {
  const h = harness(); const controller = new AbortController();
  expect(await readVerificationResults({ ...h.deps, rest: async () => { throw new Error('fixture'); } }, policy(), target, { signal: controller.signal })).toEqual(incomplete);
  expect(await readVerificationResults({ ...h.deps, installationFor: async () => { controller.abort(); return new Promise(() => {}); } }, policy(), target, { signal: controller.signal })).toEqual(incomplete);
});
it('compares matching sets independently of API order', async () => {
  const h = harness([run(1), run(2)], (path, body, _call, occurrence) => path === runsPath && occurrence === 2
    ? { total_count: 2, check_runs: [run(2), run(1)] } : body);
  expect((await h.read()).status).toBe('read');
});

it('ignores mutable GitHub metadata in the response digest', () => {
  const original = run();
  const changed = { ...original, pull_requests: [{ number: 7 }], html_url: 'changed-html', details_url: 'changed-details',
    app: { ...original.app, name: 'renamed-app', owner: { login: 'new-owner' } },
    output: { ...original.output, annotations_count: 42 } };
  const classify = (detail: unknown) => classifyVerificationCheckRun(detail, policy(), target, 301, now)!;
  expect(classify(changed).response_digest).toBe(classify(original).response_digest);
});
it.each([
  ['output.text', { output: { ...run().output, text: `${run().output.text} ` } }],
  ['output.summary', { output: { ...run().output, summary: 'edited-summary' } }],
  ['output.title', { output: { ...run().output, title: 'edited-title' } }],
  ['completed_at', { completed_at: '2026-11-16T12:02:00Z' }],
  ['external_id', { external_id: 'edited-external-id' }],
])('includes %s in the response digest', (_field, changes) => {
  const original = classifyVerificationCheckRun(run(), policy(), target, 301, now)!;
  const changed = classifyVerificationCheckRun(run(1, changes), policy(), target, 301, now)!;
  expect(changed.response_digest).not.toBe(original.response_digest);
});
it.each(['title', 'summary', 'text'] as const)('normalizes absent and non-string output.%s to null', field => {
  const output: Record<string, unknown> = { ...run().output };
  delete output[field];
  const classify = (value: unknown) => classifyVerificationCheckRun(run(1, { output: value }), policy(), target, 301, now)!;
  const absent = classify(output).response_digest;
  expect(classify({ ...output, [field]: null }).response_digest).toBe(absent);
  expect(classify({ ...output, [field]: 42 }).response_digest).toBe(absent);
});
it.each(['pull_requests', 'output.summary'] as const)('decides a reread after %s changes', async field => {
  const first = await harness().read();
  const second = await harness([run()], (path, body) => path === detailPath
    ? field === 'pull_requests' ? { ...run(), pull_requests: [{ number: 7 }] }
      : { ...run(), output: { ...run().output, summary: 'edited-summary' } }
    : body).read();
  if (first.status !== 'read' || second.status !== 'read') throw new Error('read expected');
  const o = first.observations[0]!;
  const result = o.result!;
  expect(decideVerificationSources([], [o])[0]?.outcome.decision).toBe('accepted');
  const history = [{ ...o, seq: 1, pr_number: o.pr, result_id: result.result_id, attempt: result.attempt,
    skill_id: result.skill_id, outcome: result.outcome, head_sha: result.head_sha, base_sha: result.base_sha,
    dedup_key: result.dedup_key, withdraws_result_id: null, supersedes_result_id: null, summary: result.summary,
    decision: 'accepted' as const, reason_code: null, original_seq: null, withdraws_seq: null, intake_id: null,
    observed_at: now, recorded_at: now }];
  expect(decideVerificationSources(history, second.observations)[0]?.outcome).toEqual(field === 'pull_requests'
    ? { decision: 'duplicate', reason_code: 'verify_duplicate', original_seq: 1, persist: false }
    : { decision: 'rejected', reason_code: 'verify_attempt_ambiguous' });
});

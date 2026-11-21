import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { readVerificationContractText } from './contained-mission-verification-reader.js';

const text = 'fixture contract';
const row = { source_kind: 'check_run', decision: 'accepted', object_id: 7001, repository: 'fixture/repo',
  repository_id: 9001, app_id: 8001, check_name: 'osstack/verify-intake/example', observed_head_sha: 'a'.repeat(40),
  contract_digest: createHash('sha256').update(text).digest('hex') } as const;
const run = { id: row.object_id, name: row.check_name, app: { id: row.app_id }, head_sha: row.observed_head_sha,
  check_suite: { id: 6001 }, status: 'completed', conclusion: 'failure', external_id: null,
  started_at: null, completed_at: null, output: { text } };
const policy = { schema_version: 1 as const, producers: [{ type: 'App' as const, app_id: row.app_id, repository_id: row.repository_id,
  installation_id: 3001, carrier: 'check-run' as const, allowed_failure_codes: [], ttl_ms: 1, evidence_store: 'fixture',
  auto_registration: false, skill_id: 'example', skill_manifest_digest: 'b'.repeat(64), profile_id: 'example', profile_digest: 'c'.repeat(64) }] };
const invalid = { ok: false, code: 'verify_contract_invalid' };
const incomplete = { ok: false, code: 'verify_read_incomplete' };
function setup(body: unknown = run) {
  const controller = new AbortController();
  const rest = vi.fn<Parameters<typeof readVerificationContractText>[0]['rest']>(async () => ({ ok: true, body }));
  return { rest, controller, read: (edit: Partial<Parameters<typeof readVerificationContractText>[2]> = {}) =>
    readVerificationContractText({ rest }, policy, { ...row, ...edit }, { signal: controller.signal }) };
}
it('returns matching text from one exact GET', async () => {
  const h = setup();
  expect(await h.read()).toEqual({ ok: true, text });
  expect(h.rest.mock.calls).toEqual([['repos/fixture/repo/check-runs/7001', { signal: h.controller.signal }]]);
});
it.each([{ output: { text: 'changed' } }, { output: {} }, { id: 7002 }, { name: 'other' }, { app: { id: 8002 } },
  { head_sha: 'f'.repeat(40) }, { status: 'queued', conclusion: null }])('refuses changed detail', async edit => {
  expect(await setup({ ...run, ...edit }).read()).toEqual(invalid);
});
it.each([{ decision: 'rejected' as const }, { contract_digest: null }, { contract_digest: 'short' }, { repository_id: 9002 },
  { app_id: 8002 }, { object_id: 0 }, { repository: '../repo' }])('skips an ineligible row', async edit => {
  const h = setup();
  expect(await h.read(edit)).toEqual(invalid);
  expect(h.rest).not.toHaveBeenCalled();
});
it('returns a fixed failure on malformed detail, transport failure or cancellation', async () => {
  const h = setup({});
  expect(await h.read()).toEqual(incomplete);
  h.rest.mockRejectedValueOnce(Error('external marker'));
  expect(await h.read()).toEqual(incomplete);
  h.rest.mockImplementationOnce(() => new Promise(() => {}));
  const pending = h.read();
  h.controller.abort();
  expect(await pending).toEqual(incomplete);
  expect(await h.read()).toEqual(incomplete);
  expect(h.rest).toHaveBeenCalledTimes(3);
});

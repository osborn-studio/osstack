import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadVerificationProducerConfig } from './contained-mission-verification-producer-config.js';

let home: string; let path: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'verification-config-'));
  await mkdir(join(home, 'bridge')); path = join(home, 'bridge', 'verification-producers.json');
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const common = { repository_id: 101, skill_id: 'fixture-skill', skill_manifest_digest: 'c'.repeat(64), profile_id: 'fixture-profile',
  profile_digest: 'd'.repeat(64), allowed_failure_codes: ['assertion_failed'], ttl_ms: 86400000, evidence_store: 'fixture-store', auto_registration: false };
const producer = { ...common, type: 'App', app_id: 201, installation_id: 301, carrier: 'check-run' };
const policy = { schema_version: 1, producers: [producer] };
const app = { app_id: 201, installation_id: 301, verification_private_key_path: '/fixture/missing-key' };
const config = { version: 1, verification_app: app, policy };
const write = (value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
const fails = (reason: string) => expect(loadVerificationProducerConfig(home)).rejects.toEqual(Error(`VERIFICATION_PRODUCER_CONFIG_INVALID:${reason}`));

it('closes intake for a missing file', async () => {
  expect(await loadVerificationProducerConfig(home)).toEqual({ policy: { schema_version: 1, producers: [] }, app: null });
});
it('loads the policy without accessing the key', async () => {
  await write(config); expect(await loadVerificationProducerConfig(home)).toEqual({ policy, app });
  const closed = { schema_version: 1, producers: [] }; await write({ ...config, policy: closed });
  expect(await loadVerificationProducerConfig(home)).toEqual({ policy: closed, app });
});
it.each([
  [{}, 'schema'], [{ ...config, policy: null }, 'schema'], [{ ...config, policy: {} }, 'schema'],
  [{ ...config, extra: 'fixture' }, 'schema'], [{ ...config, verification_app: { ...app, extra: 'fixture' } }, 'schema'],
  [{ ...config, verification_app: { ...app, verification_private_key_path: 'relative' } }, 'schema'],
  [{ ...config, policy: { ...policy, extra: 'fixture' } }, 'policy'],
  [{ ...config, policy: { ...policy, producers: [{ ...producer, extra: 'fixture' }] } }, 'policy'],
  ...[{ ...common, type: 'User', actor_id: 201, app_id: null, carrier: 'review' }, { ...producer, app_id: 202 },
    { ...producer, installation_id: 302 }].map(p => [{ ...config, policy: { ...policy, producers: [p] } }, 'producer_mismatch'] as const),
] as const)('rejects invalid config with a fixed reason', async (value, reason) => { await write(value); await fails(reason); });
it.each(['mode', 'symlink', 'size', 'json'])('rejects %s', async kind => {
  if (kind === 'symlink') { await symlink(join(home, 'missing'), path); await fails('file_mode'); return; }
  await writeFile(path, kind === 'size' ? ' '.repeat(65537) : 'fixture-invalid', { mode: 0o600 });
  if (kind === 'mode') await chmod(path, 0o644);
  await fails(kind === 'mode' ? 'file_mode' : kind === 'size' ? 'too_large' : 'json');
});

const repo = { repository: 'fixture-owner/fixture-repo', repository_id: 101 };
it('preserves the absent repositories key', async () => {
  await write(config);
  const loaded = await loadVerificationProducerConfig(home);
  expect(loaded).toStrictEqual({ app, policy });
  expect(Object.hasOwn(loaded, 'repositories')).toBe(false);
});
it('loads the registered repository list', async () => {
  await write({ ...config, repositories: [repo] });
  expect(await loadVerificationProducerConfig(home)).toStrictEqual({ app, policy, repositories: [repo] });
});
it.each([
  [repo, { ...repo, repository_id: 9001 }], [repo, { ...repo, repository: 'fixture/other' }],
  [{ ...repo, repository_id: 9002 }], [{ ...repo, extra: true }], [{ ...repo, repository: 'Owner/name' }],
  [{ ...repo, repository_id: 0 }], [{ ...repo, repository_id: Number.MAX_SAFE_INTEGER + 1 }],
  Array(129).fill(repo),
].map(repositories => ({ repositories })))('rejects invalid repositories', async ({ repositories }) => {
  await write({ ...config, policy: { ...policy, producers: [producer, { ...producer, repository_id: 9001 }] }, repositories });
  await fails('repositories');
});

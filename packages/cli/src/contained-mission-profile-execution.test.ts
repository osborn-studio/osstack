import { createHash } from 'node:crypto';
import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createScratchDirSync } from '@osstack/core';
import { prepareContainedImage, type ContainedImageReceipt } from '@osstack/agents';
import { canonicalJson } from '@osstack/protocol/source';
import { afterEach, expect, it, vi } from 'vitest';
import { loadInstalledVerificationProfile, type ContainedVerificationProfile } from './contained-mission-verification-profile.js';
import { assertContainedProfileRuntimeSupported, prepareContainedProfileImage } from './contained-mission-profile-execution.js';
vi.mock('@osstack/agents', async importOriginal => ({ ...await importOriginal<object>(), prepareContainedImage: vi.fn() }));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const roots: string[] = [];
afterEach(() => { vi.resetAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(patch: Partial<ContainedVerificationProfile['limits']> = {}) {
  const root = realpathSync(createScratchDirSync('tests', 'profile-image')); roots.push(root);
  const profile: ContainedVerificationProfile = { version: 1, profile_id: 'bridge-v1', harness: { path: '/osstack-trusted/harness.mjs', content: 'trusted assertions' },
    fixtures: [{ path: '/osstack-trusted/fixtures/case.json', content: '{}' }], argv: ['/usr/bin/node', '/osstack-trusted/harness.mjs'],
    image: `registry.example/verification@sha256:${'a'.repeat(64)}`, checks: [{ check_id: 'tests', category: 'test', failure_exit_codes: [1] }],
    network: 'none', read_only_rootfs: true, no_new_privileges: true, working_directory: 'candidate',
    limits: { memory_mb: 128, cpus: 1, pids: 64, timeout_seconds: 60, stdout_bytes: 4096, stderr_bytes: 8192, ...patch } };
  const source = { repository: 'owner/repo', commit: 'b'.repeat(40) };
  const bytes = JSON.stringify({ version: 1, trusted_source: source, profile }); const artifactDigest = sha(bytes); const path = join(root, `${artifactDigest}.json`);
  writeFileSync(path, bytes, { mode: 0o600 });
  const binding = { profile_id: profile.profile_id, profile_digest: sha(canonicalJson(profile)), trusted_source: { ...source, artifact_digest: artifactDigest } };
  const loaded = loadInstalledVerificationProfile({ installedRoot: root, ownerUid: process.getuid!(), allowedArgv: [profile.argv] }, binding);
  const options = { socketPath: join(root, 'fake.sock'), daemonId: 'daemon', baseImageId: `sha256:${'c'.repeat(64)}` };
  const candidate = [{ path: 'osstack-trusted/harness.mjs', mode: '100644' as const, bytes: Buffer.from('candidate counterfeit') }];
  const image: ContainedImageReceipt = { version: 1, daemonId: 'daemon', baseImageId: options.baseImageId, imageId: `sha256:${'d'.repeat(64)}`,
    workingDirectory: '/osstack-candidate-00000000-0000-4000-8000-000000000000', contentDigest: 'e'.repeat(64), archiveDigest: 'f'.repeat(64),
    trustedProfile: { baseImageReference: profile.image, profileDigest: binding.profile_digest, artifactDigest, contentDigest: sha(JSON.stringify([['fixtures/case.json', '100644', sha('{}')], ['harness.mjs', '100644', sha('trusted assertions')]])) } };
  vi.mocked(prepareContainedImage).mockResolvedValue(image);
  return { loaded, options, candidate, image, profile, path };
}
it('prepares only loader-issued bytes outside candidate data and carries exact command/limits/cwd', async () => {
  const f = fixture(); let fences = 0;
  const prepared = await prepareContainedProfileImage(f.options, f.candidate, f.loaded, () => { fences++; });
  const [options, files] = vi.mocked(prepareContainedImage).mock.calls[0]!;
  expect(files).toBe(f.candidate);
  expect(options.trustedProfile).toMatchObject({ baseImageReference: f.profile.image, profileDigest: f.loaded.binding.profile_digest });
  expect(options.trustedProfile!.files.map(file => [file.path, file.mode, Buffer.from(file.bytes).toString()])).toEqual([
    ['harness.mjs', '100644', 'trusted assertions'], ['fixtures/case.json', '100644', '{}'],
  ]);
  expect(prepared.command).toBe("'/usr/bin/node' '/osstack-trusted/harness.mjs'");
  expect(prepared.timeoutMs).toBe(60000);
  expect(prepared.outputLimits).toEqual({ stdoutBytes: 4096, stderrBytes: 8192 });
  expect(prepared.image.workingDirectory).toBe(f.image.workingDirectory);
  expect(Object.isFrozen(prepared.outputLimits)).toBe(true); expect(Object.isFrozen(prepared.image.trustedProfile)).toBe(true);
  expect(fences).toBeGreaterThan(0);
  // Current runtime cannot prove lifetime caps or a symlink-free trusted namespace.
  expect(() => assertContainedProfileRuntimeSupported(prepared)).toThrow('CONTAINED_PROFILE_RUNTIME_UNSUPPORTED');
});
it.each([{ memory_mb: 256 }, { cpus: 2 }, { pids: 32 }, { timeout_seconds: 121 }])('rejects unsupported runtime limits %j before preparation', async patch => {
  const f = fixture(patch);
  await expect(prepareContainedProfileImage(f.options, f.candidate, f.loaded, () => {})).rejects.toThrow('CONTAINED_PROFILE_LIMITS_UNSUPPORTED');
  expect(prepareContainedImage).not.toHaveBeenCalled();
});
it('rejects structurally copied loaded profiles before preparation', async () => {
  const f = fixture();
  await expect(prepareContainedProfileImage(f.options, f.candidate, { ...f.loaded }, () => {})).rejects.toThrow('VERIFICATION_PROFILE_CAPABILITY_REQUIRED');
  expect(prepareContainedImage).not.toHaveBeenCalled();
});
it.each(['before', 'after', 'api-fence'])('rechecks tampering at every preparation boundary: %s', async phase => {
  const f = fixture(); const tamper = () => writeFileSync(f.path, '{}');
  if (phase === 'before') tamper();
  else vi.mocked(prepareContainedImage).mockImplementationOnce(async options => {
    tamper(); if (phase === 'api-fence') options.authorize(); return f.image;
  });
  await expect(prepareContainedProfileImage(f.options, f.candidate, f.loaded, () => {})).rejects.toThrow('VERIFICATION_PROFILE_ARTIFACT_MISMATCH');
});
it('rejects async/revoked authorization and changed provenance without returning a plan', async () => {
  const f = fixture();
  await expect(prepareContainedProfileImage(f.options, f.candidate, f.loaded, async () => {})).rejects.toThrow('CONTAINED_AUTHORITY_MUST_BE_SYNC');
  expect(prepareContainedImage).not.toHaveBeenCalled();
  await expect(prepareContainedProfileImage(f.options, f.candidate, f.loaded, () => { throw Error('REVOKED'); })).rejects.toThrow('REVOKED');
  f.image.trustedProfile!.profileDigest = '0'.repeat(64);
  await expect(prepareContainedProfileImage(f.options, f.candidate, f.loaded, () => {})).rejects.toThrow('CONTAINED_PROFILE_IMAGE_MISMATCH');
});
it('requires an authentic prepared plan and rechecks install/authority at the launch blocker', async () => {
  const f = fixture(); let allowed = true;
  const prepared = await prepareContainedProfileImage(f.options, f.candidate, f.loaded, () => { if (!allowed) throw Error('REVOKED'); });
  expect(() => assertContainedProfileRuntimeSupported({ ...prepared })).toThrow('CONTAINED_PROFILE_PREPARATION_REQUIRED');
  allowed = false; expect(() => assertContainedProfileRuntimeSupported(prepared)).toThrow('REVOKED');
  allowed = true; writeFileSync(f.path, '{}');
  expect(() => assertContainedProfileRuntimeSupported(prepared)).toThrow('VERIFICATION_PROFILE_ARTIFACT_MISMATCH');
});
it.each(['contentDigest', 'imageId'])('rejects mismatched prepared %s', async field => {
  const f = fixture();
  if (field === 'contentDigest') f.image.trustedProfile!.contentDigest = '0'.repeat(64);
  else f.image.imageId = 'unbound-local-image';
  await expect(prepareContainedProfileImage(f.options, f.candidate, f.loaded, () => {})).rejects.toThrow('CONTAINED_PROFILE_IMAGE_MISMATCH');
});

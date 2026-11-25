import { expect, it } from 'vitest';
import * as api from './index.js';

it('exports the contained profile runtime API', () => {
  expect(Object.keys(api).sort()).toEqual([
    'assertContainedProfileRuntimeSupported',
    'authorizeContained',
    'containedCommandFromArgv',
    'exportContainedCandidate',
    'exportContainedCommit',
    'loadInstalledVerificationProfile',
    'parseContainedProfileRunIdentity',
    'prepareContainedProfileImage',
    'revalidateInstalledVerificationProfile',
    'runPreparedContainedProfile',
    'verificationProfileDigest',
  ]);
});

it('quotes argv for the shell and rejects invalid arguments', () => {
  expect(api.containedCommandFromArgv(['/bin/echo', "a'b"])).toEqual({
    command: "'/bin/echo' 'a'\\''b'",
    argv_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(() => api.containedCommandFromArgv([])).toThrow('CONTAINED_ARGV_INVALID');
  expect(() => api.containedCommandFromArgv(['/bin/echo', 'a\x01b'])).toThrow('CONTAINED_ARGV_INVALID');
});

it('requires grants to return undefined synchronously', () => {
  expect(api.authorizeContained(() => undefined)).toBeUndefined();
  expect(() => api.authorizeContained(() => Promise.resolve())).toThrow('CONTAINED_AUTHORITY_MUST_BE_SYNC');
});

it('digests valid profiles independently of key order and rejects invalid profiles', () => {
  const profile: api.ContainedVerificationProfile = {
    version: 1,
    profile_id: 'bridge-v1',
    harness: { path: '/osstack-trusted/check.sh', content: 'exit 0' },
    fixtures: [],
    argv: ['/bin/sh', '/osstack-trusted/check.sh'],
    image: `example/check@sha256:${'a'.repeat(64)}`,
    checks: [{ check_id: 'tests', category: 'test', failure_exit_codes: [1] }],
    limits: { timeout_seconds: 60, memory_mb: 128, cpus: 1, pids: 64, stdout_bytes: 4096, stderr_bytes: 4096 },
    network: 'none',
    read_only_rootfs: true,
    no_new_privileges: true,
    working_directory: 'candidate',
  };
  const reordered = Object.fromEntries(Object.entries(profile).reverse());
  expect(api.verificationProfileDigest(reordered)).toBe(api.verificationProfileDigest(profile));
  expect(() => api.verificationProfileDigest({ ...profile, network: 'host' })).toThrow('VERIFICATION_PROFILE_PAYLOAD_INVALID');
});

it('rejects a relative workspace before invoking Git', () => {
  expect(() => api.exportContainedCommit('relative', 'a'.repeat(40))).toThrow('CONTAINED_COMMIT_INVALID');
});

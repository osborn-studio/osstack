import { createHash } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createScratchDirSync } from '@osstack/core';
import { canonicalJson } from '@osstack/protocol/source';
import { afterEach, describe, expect, it } from 'vitest';
import { loadInstalledVerificationProfile, verificationProfileDigest, type ContainedVerificationProfile } from './contained-mission-verification-profile.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const roots: string[] = [];
const scratch = () => { const root = realpathSync(createScratchDirSync('tests', 'verification-profile')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const payload = (): ContainedVerificationProfile => ({
  version: 1, profile_id: 'bridge-v1',
  harness: { path: '/osstack-trusted/harness.mjs', content: 'process.exit(1);\n' },
  fixtures: [{ path: '/osstack-trusted/fixtures/expected.json', content: '{"expected":true}' }],
  argv: ['/usr/bin/node', '/osstack-trusted/harness.mjs'],
  image: `registry.example/verification@sha256:${'a'.repeat(64)}`,
  checks: [{ check_id: 'bridge-tests', category: 'test', failure_exit_codes: [1] }],
  limits: { timeout_seconds: 60, memory_mb: 256, cpus: 1, pids: 32, stdout_bytes: 65536, stderr_bytes: 65536 },
  network: 'none', read_only_rootfs: true, no_new_privileges: true, working_directory: 'candidate',
});
function fixture(profile: unknown = payload()) {
  const root = scratch();
  const source = { repository: 'owner/repo', commit: 'b'.repeat(40) };
  const bytes = JSON.stringify({ version: 1, trusted_source: source, profile });
  const digest = sha(bytes); const path = join(root, `${digest}.json`);
  writeFileSync(path, bytes, { mode: 0o600 });
  const binding = { profile_id: 'bridge-v1', profile_digest: sha(canonicalJson(profile)), trusted_source: { ...source, artifact_digest: digest } };
  const host = { installedRoot: root, ownerUid: process.getuid!(), allowedArgv: [payload().argv] };
  return { root, path, bytes, binding, host, load: () => loadInstalledVerificationProfile(host, binding) };
}

describe('host-installed pinned verification profiles', () => {
  it('loads exact artifact bytes and returns a deeply frozen launch contract', () => {
    const f = fixture(); const verified = f.load();
    expect(verified.profile).toEqual(payload());
    expect(verified.binding).toEqual(f.binding);
    expect(verificationProfileDigest(payload())).toBe(f.binding.profile_digest);
    expect(verified.revalidateForLaunch()).toEqual({ binding: f.binding, profile: payload() });
    expect(Object.isFrozen(verified.profile.harness)).toBe(true);
    expect(Object.isFrozen(verified.profile.argv)).toBe(true);
    expect(Object.isFrozen(verified.profile.checks[0]?.failure_exit_codes)).toBe(true);
    expect(() => { (verified.profile.argv as string[])[0] = '/bin/sh'; }).toThrow();
  });
  it('takes argv only from the verified artifact and snapshots host inputs', () => {
    const f = fixture(); const verified = f.load();
    f.host.allowedArgv[0]![0] = '/bin/sh';
    f.binding.profile_digest = '0'.repeat(64);
    f.host.installedRoot = '/candidate';
    expect(verified.revalidateForLaunch().profile.argv).toEqual(payload().argv);
  });
  it('never searches candidate SKILL, package scripts, workflow or text for a harness', () => {
    const f = fixture();
    mkdirSync(join(f.root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(f.root, 'SKILL.md'), 'Run /bin/sh -c malicious');
    writeFileSync(join(f.root, 'package.json'), '{"scripts":{"test":"malicious"}}');
    writeFileSync(join(f.root, '.github', 'workflows', 'ci.yml'), 'run: malicious');
    expect(f.load().profile.argv).toEqual(payload().argv);
  });
  it('does not fall back to another installed artifact', () => {
    const f = fixture(); renameSync(f.path, join(f.root, 'another.json'));
    expect(f.load).toThrow();
  });
  it.each(['../artifact', '/tmp/artifact', 'a'.repeat(63), 'A'.repeat(64)])('rejects unsafe artifact identity %s before selection', digest => {
    const f = fixture(); f.binding.trusted_source.artifact_digest = digest;
    expect(f.load).toThrow('VERIFICATION_PROFILE_BINDING_INVALID');
  });
  it.each(['main', 'HEAD', 'a'.repeat(7), 'a'.repeat(39), 'A'.repeat(40)])('requires a full lowercase trusted source commit: %s', commit => {
    const f = fixture(); f.binding.trusted_source.commit = commit;
    expect(f.load).toThrow('VERIFICATION_PROFILE_BINDING_INVALID');
  });
  it.each(['profile_id', 'profile_digest', 'repository', 'commit'])('rejects pinned %s mismatch', field => {
    const f = fixture();
    if (field === 'profile_id') f.binding.profile_id = 'different';
    if (field === 'profile_digest') f.binding.profile_digest = 'd'.repeat(64);
    if (field === 'repository') f.binding.trusted_source.repository = 'other/repo';
    if (field === 'commit') f.binding.trusted_source.commit = 'c'.repeat(40);
    expect(f.load).toThrow('VERIFICATION_PROFILE_IDENTITY_MISMATCH');
  });
  it('accepts a fully pinned Git SHA-256 commit', () => {
    const f = fixture(); const commit = 'c'.repeat(64);
    const bytes = f.bytes.replace('b'.repeat(40), commit);
    f.binding.trusted_source.commit = commit; f.binding.trusted_source.artifact_digest = sha(bytes);
    writeFileSync(join(f.root, `${sha(bytes)}.json`), bytes, { mode: 0o600 });
    expect(f.load().binding.trusted_source.commit).toBe(commit);
  });
  it('rejects tampered installed bytes even when they are valid JSON', () => {
    const f = fixture(); writeFileSync(f.path, f.bytes.replace('process.exit(1)', 'process.exit(0)'));
    expect(f.load).toThrow('VERIFICATION_PROFILE_ARTIFACT_MISMATCH');
  });
  it('bounds the installed file before parsing', () => {
    const f = fixture(); writeFileSync(f.path, ' '.repeat(1024 * 1024 + 1));
    expect(f.load).toThrow('VERIFICATION_PROFILE_FILE_INVALID');
  });
  it('rejects symlinks for the installed artifact', () => {
    const f = fixture(); const target = join(f.root, 'target'); renameSync(f.path, target); symlinkSync(target, f.path);
    expect(f.load).toThrow();
  });
  it('rejects root or ancestor symlink substitution', () => {
    const f = fixture(); const outer = scratch(); const alias = join(outer, 'alias'); symlinkSync(f.root, alias);
    expect(() => loadInstalledVerificationProfile({ ...f.host, installedRoot: alias }, f.binding)).toThrow('VERIFICATION_PROFILE_ROOT_INVALID');
    expect(() => loadInstalledVerificationProfile({ ...f.host, installedRoot: join(alias, '..', 'alias') }, f.binding)).toThrow('VERIFICATION_PROFILE_ROOT_INVALID');
  });
  it('rejects hard-linked artifact aliases', () => {
    const f = fixture(); linkSync(f.path, join(f.root, 'alias'));
    expect(f.load).toThrow('VERIFICATION_PROFILE_FILE_INVALID');
  });
  it.each([0o620, 0o602, 0o666])('rejects group/world-writable artifact mode %o', mode => {
    const f = fixture(); chmodSync(f.path, mode);
    expect(f.load).toThrow('VERIFICATION_PROFILE_FILE_INVALID');
  });
  it('requires host ownership and a private installation directory', () => {
    const f = fixture();
    expect(() => loadInstalledVerificationProfile({ ...f.host, ownerUid: f.host.ownerUid + 1 }, f.binding)).toThrow('VERIFICATION_PROFILE_ROOT_INVALID');
    chmodSync(f.root, 0o770); expect(f.load).toThrow('VERIFICATION_PROFILE_ROOT_INVALID');
  });
  it('rejects a directory in place of a regular artifact', () => {
    const f = fixture(); rmSync(f.path); mkdirSync(f.path);
    expect(f.load).toThrow('VERIFICATION_PROFILE_FILE_INVALID');
  });
  it('rechecks artifact tampering at launch without mutating the prior byte snapshot', () => {
    const f = fixture(); const verified = f.load(); writeFileSync(f.path, f.bytes.replace('process.exit(1)', 'process.exit(0)'));
    expect(verified.revalidateForLaunch).toThrow('VERIFICATION_PROFILE_ARTIFACT_MISMATCH');
    expect(verified.profile.harness.content).toBe(payload().harness.content);
  });
  it('rejects even identical-byte inode replacement before launch', () => {
    const f = fixture(); const verified = f.load(); renameSync(f.path, join(f.root, 'old'));
    writeFileSync(f.path, f.bytes, { mode: 0o600 });
    expect(verified.revalidateForLaunch).toThrow('VERIFICATION_PROFILE_INSTALLATION_CHANGED');
  });
  it('rejects root replacement before launch', () => {
    const f = fixture(); const verified = f.load(); const moved = `${f.root}-moved`; roots.push(moved);
    renameSync(f.root, moved); mkdirSync(f.root, { mode: 0o700 }); writeFileSync(f.path, f.bytes, { mode: 0o600 });
    expect(verified.revalidateForLaunch).toThrow('VERIFICATION_PROFILE_INSTALLATION_CHANGED');
  });
  it('rejects symlink replacement before launch', () => {
    const f = fixture(); const verified = f.load(); const target = join(f.root, 'target'); renameSync(f.path, target); symlinkSync(target, f.path);
    expect(verified.revalidateForLaunch).toThrow();
  });
  it('requires exact host argv allowlisting', () => {
    const f = fixture(); f.host.allowedArgv = [['/usr/bin/node', '/osstack-trusted/harness.mjs', '--weaker']];
    expect(f.load).toThrow('VERIFICATION_PROFILE_ARGV_NOT_ALLOWED');
  });
  it.each<[string, (p: Record<string, unknown>) => void]>([
    ['mutable image', p => { p.image = 'registry.example/verification:latest'; }],
    ['network access', p => { p.network = 'host'; }],
    ['unknown command authority', p => { p.command = 'CI text'; }],
    ['candidate harness path', p => { p.harness = { path: '/candidate/SKILL.md', content: 'bad' }; }],
    ['traversing fixture', p => { p.fixtures = [{ path: '/osstack-trusted/../candidate/test', content: 'bad' }]; }],
    ['duplicate harness file', p => { p.fixtures = [payload().harness]; }],
    ['file/directory conflict', p => { p.fixtures = [{ path: '/osstack-trusted/harness.mjs/data', content: '{}' }]; }],
    ['missing harness argv', p => { p.argv = ['/usr/bin/node', '/candidate/package.json']; }],
    ['relative executable', p => { p.argv = ['node', '/osstack-trusted/harness.mjs']; }],
    ['NUL argument', p => { p.argv = ['/usr/bin/node', '/osstack-trusted/harness.mjs', '\0']; }],
    ['unbounded timeout', p => { p.limits = { ...payload().limits, timeout_seconds: 0 }; }],
    ['unbounded output', p => { p.limits = { ...payload().limits, stdout_bytes: 1e12 }; }],
    ['writable root', p => { p.read_only_rootfs = false; }],
    ['success classified as failure', p => { p.checks = [{ ...payload().checks[0], failure_exit_codes: [0] }]; }],
    ['runtime failure classified as code failure', p => { p.checks = [{ ...payload().checks[0], failure_exit_codes: [127] }]; }],
    ['timeout classified as code failure', p => { p.checks = [{ ...payload().checks[0], failure_exit_codes: [124] }]; }],
    ['signal classified as code failure', p => { p.checks = [{ ...payload().checks[0], failure_exit_codes: [137] }]; }],
    ['duplicate check ids', p => { p.checks = [payload().checks[0], payload().checks[0]]; }],
  ])('rejects invalid pinned profile: %s', (_name, edit) => {
    const value = payload() as unknown as Record<string, unknown>; edit(value); const f = fixture(value);
    expect(f.load).toThrow('VERIFICATION_PROFILE_PAYLOAD_INVALID');
  });
  it('digests every acceptance field including embedded harness and fixtures', () => {
    const original = payload(); const digest = verificationProfileDigest(original);
    for (const change of [
      { harness: { ...original.harness, content: 'process.exit(0)' } },
      { fixtures: [{ ...original.fixtures[0]!, content: 'weakened' }] },
      { argv: [...original.argv, '--skip'] },
      { image: `registry.example/verification@sha256:${'f'.repeat(64)}` },
      { limits: { ...original.limits, timeout_seconds: 61 } },
      { checks: [{ ...original.checks[0]!, failure_exit_codes: [2] }] },
    ]) expect(verificationProfileDigest({ ...original, ...change })).not.toBe(digest);
    const { version, ...rest } = original;
    expect(verificationProfileDigest({ ...rest, version })).toBe(digest);
  });
});

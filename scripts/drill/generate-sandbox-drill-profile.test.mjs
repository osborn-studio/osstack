import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadInstalledVerificationProfile } from '../../packages/agents/dist/contained-profile/index.js';
import { loadVerificationProfileHostConfig } from '../../packages/cli/dist/verification-profile-host-config.js';
import { loadVerificationProducerConfig } from '../../packages/cli/dist/verification-producer-config.js';
import { parseHarnessConfig } from '../../packages/verify-harness/dist/config.js';
import { parsePublisherAllowlist } from '../../packages/verify-publisher/dist/config.js';
import { createScratchDir } from '../lib/scratch.mjs';

const script = fileURLToPath(new URL('./generate-sandbox-drill-profile.mjs', import.meta.url));
const example = fileURLToPath(new URL('./sandbox-drill-input.example.json', import.meta.url));
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const generate = (input, args = [], env = process.env) =>
  execFileSync(process.execPath, [script, '--input', input, ...args], { env, encoding: 'utf8' }).trim();
let scratch, first, input;

beforeAll(async () => {
  scratch = await realpath(await createScratchDir('tests', 'drill-profile'));
  first = join(scratch, 'first');
  input = join(scratch, 'input.json');
  await writeFile(input, JSON.stringify({ ...await read(example), app_id: 123, installation_id: 456,
    host_profiles_root: join(first, 'profiles'), cloud_profiles_root: join(first, 'profiles') }));
  generate(input, ['--out-dir', first]);
});
afterAll(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

it('writes five identical files on repeat runs, including the default scratch destination', async () => {
  const second = generate(input, [], { ...process.env, OSSTACK_SCRATCH_ROOT: scratch });
  expect(second.startsWith(join(scratch, 'runtime') + '/')).toBe(true);
  const names = async dir => (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(dir.length + 1)).sort();
  const files = await names(first);
  expect(files).toHaveLength(5);
  expect(await names(second)).toEqual(files);
  for (const name of files) {
    const bytes = await readFile(join(first, name));
    expect(await readFile(join(second, name))).toEqual(bytes);
    expect(bytes.toString()).not.toContain('-----BEGIN ');
  }
});

it('loads both installations and the two allowlists with identical pins', async () => {
  const harness = parseHarnessConfig(await read(join(first, 'harness.json'))).value;
  const publisher = parsePublisherAllowlist(await read(join(first, 'publisher-allowlist.json'))).value;
  const config = await loadVerificationProducerConfig(first);
  const host = await loadVerificationProfileHostConfig(first);
  const [entry] = harness.entries;
  const [allow] = publisher.allow;
  const { profile_id, profile_digest, trusted_source } = allow;
  const { repository, commit_sha, artifact_digest } = trusted_source;
  expect(entry).toMatchObject({ profile_id, profile_digest, trusted_source, skill_id: allow.skill_id,
    repository: allow.repository, repository_id: allow.repository_id });
  expect(publisher.producer).toEqual({ app_id: 123, installation_id: 456 });
  expect(config.app).toMatchObject(publisher.producer);
  expect(config.repositories).toEqual([{ repository: entry.repository, repository_id: entry.repository_id }]);
  expect(config.policy.producers[0]).toMatchObject({ ...publisher.producer, profile_id, profile_digest,
    repository_id: allow.repository_id, skill_id: allow.skill_id, skill_manifest_digest: allow.skill_manifest_digest,
    allowed_failure_codes: [entry.failure_code] });
  const binding = { profile_id, profile_digest, trusted_source: { repository, commit: commit_sha, artifact_digest } };
  const cloud = { installedRoot: harness.profiles_root, ownerUid: process.getuid(), allowedArgv: [entry.allowed_argv] };
  for (const installation of [cloud, host]) {
    const { profile } = loadInstalledVerificationProfile(installation, binding);
    expect(profile.profile_id).toBe(profile_id);
    expect(installation.allowedArgv).toEqual([profile.argv]);
  }
  const bytes = await readFile(join(host.installedRoot, artifact_digest + '.json'));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact_digest);
});

it('passes a clean candidate and returns the registered failure exit for PROBE_FAIL', async () => {
  const [entry] = (await read(join(first, 'harness.json'))).entries;
  const artifact = await read(join(first, 'profiles', entry.trusted_source.artifact_digest + '.json'));
  const candidate = join(scratch, 'candidate');
  await mkdir(candidate);
  const check = join(scratch, 'probe.sh');
  await writeFile(check, artifact.profile.harness.content);
  const run = () => execFileSync(artifact.profile.argv[0], [check], { cwd: candidate });
  expect(run).not.toThrow();
  await writeFile(join(candidate, 'PROBE_FAIL'), '');
  expect(run).toThrow(expect.objectContaining({ status: artifact.profile.checks[0].failure_exit_codes[0] }));
});

it('changes the manifest when only a nested skill dependency changes', async () => {
  // Build two versions of a disposable fixture. The osstack checkout is never modified.
  const repo = join(scratch, 'fixture');
  const dir = '.cursor/skills/verify-osstack';
  await mkdir(join(repo, dir, 'features/nested'), { recursive: true });
  await mkdir(join(repo, 'deploy/github-actions'), { recursive: true });
  await writeFile(join(repo, dir, 'SKILL.md'), 'fixture entry\n');
  await writeFile(join(repo, 'deploy/github-actions/osstack-verify.yml'), 'run: test ! -e PROBE_FAIL\n');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  const versions = [];
  for (const version of ['one', 'two']) {
    await writeFile(join(repo, dir, 'features/nested/check.md'), version);
    git('add', '.');
    git('commit', '-qm', version);
    const file = join(scratch, version + '.json');
    await writeFile(file, JSON.stringify({ ...await read(input), source_commit: git('rev-parse', 'HEAD') }));
    const out = generate(file, ['--out-dir', join(scratch, version)], { ...process.env, GIT_DIR: join(repo, '.git') });
    const [allow] = (await read(join(out, 'publisher-allowlist.json'))).allow;
    expect(allow.skill_blob).toBe(git('rev-parse', 'HEAD:' + dir + '/SKILL.md'));
    versions.push(allow);
  }
  expect(versions[0].skill_blob).toBe(versions[1].skill_blob);
  expect(versions[0].skill_manifest_digest).not.toBe(versions[1].skill_manifest_digest);
});

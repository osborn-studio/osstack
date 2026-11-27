import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadInstalledVerificationProfile, verificationProfileDigest } from '../../packages/agents/dist/contained-profile/index.js';
import { loadVerificationProfileHostConfig } from '../../packages/cli/dist/verification-profile-host-config.js';
import { loadVerificationProducerConfig } from '../../packages/cli/dist/verification-producer-config.js';
import { VERIFICATION_TTL_MS } from '../../packages/core/dist/bridge/verification-result.js';
import { canonicalJson } from '../../packages/core/dist/bridge/revision-grant.js';
import { parseHarnessConfig } from '../../packages/verify-harness/dist/config.js';
import { parsePublisherAllowlist } from '../../packages/verify-publisher/dist/config.js';
import { createScratchDir } from '../lib/scratch.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const skill = '.cursor/skills/verify-osstack';
const workflow = 'deploy/github-actions/osstack-verify.yml';
const assertion = 'test ! -e PROBE_FAIL';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => canonicalJson(value) + '\n';

function skillFiles(commit) {
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/u.test(commit)) throw Error('Expected full source_commit');
  const git = (...args) => new TextDecoder('utf-8', { fatal: true }).decode(
    execFileSync('git', ['--no-replace-objects', ...args], { cwd: root }));
  if (git('cat-file', '-t', commit).trim() !== 'commit') throw Error('Expected commit object');
  const tree = git('ls-tree', '-rz', commit, '--', skill, workflow);
  const files = tree.split('\0').filter(Boolean).map(record => {
    const match = /^100(?:644|755) blob ([a-f0-9]{40})\t(.+)$/su.exec(record);
    if (!match) throw Error('Unsupported skill dependency');
    return { path: match[2], blob: match[1] };
  }).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const entry = files.find(file => file.path === skill + '/SKILL.md');
  const check = files.find(file => file.path === workflow);
  if (!entry || !check || !git('cat-file', 'blob', check.blob).split('\n').some(line => line.trim() === 'run: ' + assertion))
    throw Error('Missing skill entry or reviewed sandbox assertion');
  return { skill_blob: entry.blob, skill_manifest_digest: sha256(canonicalJson(files)) };
}

function bundle(input) {
  const repository = { repository: 'osborn-studio/osstack-bridge-sandbox', repository_id: 1446327922 };
  const source = { repository: 'osborn-studio/osstack', commit: input.source_commit };
  const harness = { path: '/osstack-trusted/probe.sh', content: assertion + '\n' };
  const argv = ['/bin/sh', harness.path];
  const profile = {
    version: 1, profile_id: 'sandbox-probe-v1', harness, fixtures: [], argv,
    image: 'node@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb',
    checks: [{ check_id: 'probe-marker-absent', category: 'test', failure_exit_codes: [1] }],
    limits: { timeout_seconds: 30, memory_mb: 128, cpus: 1, pids: 64, stdout_bytes: 65536, stderr_bytes: 65536 },
    network: 'none', read_only_rootfs: true, no_new_privileges: true, working_directory: 'candidate',
  };
  const artifact = json({ version: 1, trusted_source: source, profile });
  const artifact_digest = sha256(artifact);
  const pin = { profile_id: profile.profile_id, profile_digest: verificationProfileDigest(profile) };
  const binding = { ...repository, skill_id: 'verify-osstack', ...pin,
    trusted_source: { repository: source.repository, commit_sha: source.commit, artifact_digest } };
  const identity = { app_id: input.app_id, installation_id: input.installation_id };
  const skillPins = skillFiles(source.commit);
  const failure_code = 'probe_marker_present';
  const config = { version: 1, docker: input.docker, profiles_root: input.cloud_profiles_root,
    entries: [{ ...binding, allowed_argv: argv, failure_code,
      base_image_id: 'sha256:98e6ef9c5dee87d59cef96a25b0f01181723ebe990154dec2025f3ddcddb4f5f' }] };
  const publisher = { version: 1, producer: identity, allow: [{ ...binding, skill_version: '1.0.0', ...skillPins }] };
  if (!parseHarnessConfig(config).ok || !parsePublisherAllowlist(publisher).ok) throw Error('Invalid harness or publisher input');
  const producer = { type: 'App', carrier: 'check-run', ...identity, repository_id: repository.repository_id,
    skill_id: binding.skill_id, skill_manifest_digest: skillPins.skill_manifest_digest, ...pin,
    allowed_failure_codes: [failure_code], ttl_ms: VERIFICATION_TTL_MS, evidence_store: 'sandbox_evidence', auto_registration: false };
  return {
    files: {
      'harness.json': json(config),
      'publisher-allowlist.json': json(publisher),
      ['profiles/' + artifact_digest + '.json']: artifact,
      'bridge/verification-producers.json': json({ version: 1, repositories: [repository],
        verification_app: { ...identity, verification_private_key_path: input.host_key_path },
        policy: { schema_version: 1, producers: [producer] } }),
      'bridge/verification-profile-host.json': json({ version: 1, installed_root: input.host_profiles_root, allowed_argv: [argv] }),
    },
    installedBinding: { ...pin, trusted_source: { ...source, artifact_digest } },
  };
}

async function main() {
  const { values } = parseArgs({ options: { input: { type: 'string' }, 'out-dir': { type: 'string' } } });
  if (!values.input) throw Error('Usage: --input INPUT.json [--out-dir DIRECTORY]');
  const { files, installedBinding } = bundle(JSON.parse(await readFile(values.input, 'utf8')));
  const destination = values['out-dir'] && resolve(values['out-dir']);
  let staging;
  if (destination) {
    await mkdir(dirname(destination), { recursive: true });
    staging = join(dirname(destination), '.drill-' + randomUUID());
    await mkdir(staging, { mode: 0o700 });
  } else {
    staging = await createScratchDir('runtime', 'sandbox-drill-profile');
  }
  try {
    for (const [name, bytes] of Object.entries(files)) {
      if (bytes.includes('-----BEGIN ')) throw Error('Unexpected PEM marker');
      const target = join(staging, name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
    }
    await loadVerificationProducerConfig(staging);
    const host = await loadVerificationProfileHostConfig(staging);
    loadInstalledVerificationProfile({ ...host, installedRoot: await realpath(join(staging, 'profiles')) }, installedBinding);
    if (destination) await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  console.log(destination || staging);
}

await main();

// Fixed local skills-check verification primitives; not a general task runner.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export const CASE_IDS = ['healthy', 'missing-ref', 'drift', 'mixed', 'empty'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = value => JSON.stringify(value, null, 2) + '\n';
export const writeJson = (path, value) => writeFile(path, jsonBytes(value), { mode: 0o600 });
const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
export const scratchRoot = () => process.env.OSSTACK_SCRATCH_ROOT?.trim() ? resolve(process.env.OSSTACK_SCRATCH_ROOT) : join(tmpdir(), 'osstack');
const usage = () => Object.assign(Error('usage: node scripts/smoke-skills-check.mjs [--doctor | --dry-run] [--case all|healthy|missing-ref|drift|mixed|empty] [--evidence-dir NEW_DIRECTORY]'), { exitCode: 2 });
export function parseOptions(args) {
  let mode = 'run'; let caseName = 'all'; let evidenceDir; let seenCase = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--doctor' || arg === '--dry-run') {
      if (mode !== 'run') throw usage();
      mode = arg === '--doctor' ? 'doctor' : 'dry-run';
    } else if (arg === '--case') {
      if (seenCase || !['all', ...CASE_IDS].includes(args[i + 1])) throw usage();
      seenCase = true; caseName = args[++i];
    } else if (arg === '--evidence-dir') {
      if (evidenceDir || !args[i + 1] || args[i + 1].startsWith('--')) throw usage();
      evidenceDir = resolve(args[++i]);
    } else throw usage();
  }
  return { mode, caseName, evidenceDir };
}
export async function preflight({ repository, evidenceDir, mode = 'doctor', caseName = 'all', path = process.env.PATH ?? '' }) {
  const checks = [];
  for (const rel of ['packages/cli/dist/bin.js', 'packages/core/dist/index.js', 'packages/skill-registry/dist/index.js']) {
    let ok = false; try { ok = (await stat(join(repository, rel))).isFile(); } catch { /* Report unavailable. */ }
    checks.push({ id: rel, ok });
  }
  let git = null;
  for (const directory of path.split(delimiter)) {
    const candidate = resolve(directory || '.', process.platform === 'win32' ? 'git.exe' : 'git');
    try { if ((await stat(candidate)).isFile()) { await access(candidate, constants.X_OK); git = candidate; break; } } catch { /* Read-only lookup. */ }
  }
  checks.push({ id: 'git_executable', ok: git !== null, path: git });
  checks.push({ id: 'node_version', ok: Number(process.versions.node.split('.')[0]) >= 20, version: process.versions.node });
  if (evidenceDir) {
    checks.push({ id: 'evidence_destination_new', ok: !(await exists(evidenceDir)) });
    let writable = false;
    try { await access(dirname(evidenceDir), constants.W_OK); writable = (await stat(dirname(evidenceDir))).isDirectory(); } catch { /* Report unavailable. */ }
    checks.push({ id: 'evidence_parent_writable', ok: writable });
  }
  return { schema_version: 1, status: mode === 'dry-run' ? 'planned' : 'preflight', ready: checks.every(x => x.ok), executed: false,
    cases: caseName === 'all' ? [...CASE_IDS] : [caseName], checks, git_executable: git,
    evidence_directory: evidenceDir ?? 'new independent directory under scratch smoke/',
    plan: ['create owned file:// Git fixture', 'invoke compiled skills check with isolated manifests', 'compare exit/output/input hashes', 'remove owned fixture and retain separate evidence'],
    limitations: ['read-only availability check; no subprocess or product import', 'dependency loading and behavior checked only during run', 'no provider or formal gate qualification'] };
}
export async function reserveEvidence(target) {
  if (!target) { const base = join(scratchRoot(), 'smoke'); await mkdir(base, { recursive: true, mode: 0o700 }); target = join(base, `skills-check-evidence-${randomUUID()}`); }
  target = resolve(target); await mkdir(target, { mode: 0o700 });
  return { directory: target, run_id: randomUUID() };
}
export function fixtureEnvironment(root, scratch, path, home) {
  return { PATH: path, LANG: 'C', LC_ALL: 'C', HOME: join(root, 'user-home'), XDG_CONFIG_HOME: join(root, 'xdg'), TMPDIR: join(root, 'tmp'),
    OSSTACK_HOME: home, OSSTACK_SCRATCH_ROOT: scratch, OSSTACK_UPDATE_CHECK: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: join(root, 'empty-gitconfig'), GIT_CONFIG_GLOBAL: join(root, 'empty-gitconfig'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: join(root, 'hooks'),
    GIT_TEMPLATE_DIR: join(root, 'template'), GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Owned Verification Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Owned Verification Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
}

// Kill only the child this function spawned. A deadline/limit does NOT attest
// descendant termination; callers must preserve fixture state in that case.
export function runCommand(executable, argv, { cwd, env, timeoutMs = 10000, maxBytes = 1024 * 1024, signal } = {}) {
  return new Promise(resolveResult => {
    const startedAt = new Date().toISOString();
    let child; let timer; let grace; let finished = false; let exitCode = null; let exitSignal = null;
    let directExit = false; let timedOut = false; let limited = false; let interrupted = false; let spawnError = null;
    const buffers = { stdout: [], stderr: [] }; const sizes = { stdout: 0, stderr: 0 };
    const finish = () => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(grace); signal?.removeEventListener('abort', cancel);
      child?.stdout?.destroy(); child?.stderr?.destroy();
      const stdout = Buffer.concat(buffers.stdout); const stderr = Buffer.concat(buffers.stderr);
      resolveResult({ executable, argv, cwd, started_at: startedAt, ended_at: new Date().toISOString(), exit_code: exitCode, signal: exitSignal,
        process_started: child?.pid !== undefined, pid: child?.pid ?? null, direct_child_exit_confirmed: directExit,
        timed_out: timedOut, output_limited: limited, interrupted, spawn_error: spawnError,
        stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), stdout_bytes: stdout, stderr_bytes: stderr });
    };
    const terminate = () => { child?.kill('SIGKILL'); grace ??= setTimeout(finish, 2000); };
    const cancel = () => { interrupted = true; terminate(); };
    try { child = spawn(executable, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { spawnError = error.code ?? 'spawn_failed'; finish(); return; }
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => {
      const remaining = Math.max(0, maxBytes - sizes[stream]);
      if (remaining) { const kept = bytes.subarray(0, remaining); buffers[stream].push(kept); sizes[stream] += kept.length; }
      if (bytes.length > remaining) { limited = true; terminate(); }
    });
    child.once('error', error => { spawnError = error.code ?? 'spawn_failed'; if (!child.pid) finish(); else terminate(); });
    child.once('exit', (code, sig) => { directExit = true; exitCode = code; exitSignal = sig; });
    child.once('close', finish);
    timer = setTimeout(() => { timedOut = true; terminate(); }, Math.max(1, Math.min(timeoutMs, 10000)));
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
  });
}

async function walk(path, relative, files) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw Error(`binding_symlink:${relative}`);
  if (info.isDirectory()) { for (const name of (await readdir(path)).sort()) await walk(join(path, name), `${relative}/${name}`, files); }
  else if (info.isFile()) { const bytes = await readFile(path); files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) }); }
}
export async function sourceBindings(repository) {
  const source = []; const build = [];
  for (const name of (await readdir(join(repository, 'packages'))).sort()) {
    const root = join(repository, 'packages', name); const info = await lstat(root);
    if (info.isSymbolicLink()) throw Error(`binding_symlink:packages/${name}`);
    if (!info.isDirectory()) continue;
    for (const [folder, files] of [['src', source], ['dist', build]]) if (await exists(join(root, folder))) await walk(join(root, folder), `packages/${name}/${folder}`, files);
    if (await exists(join(root, 'package.json'))) await walk(join(root, 'package.json'), `packages/${name}/package.json`, source);
  }
  for (const rel of ['package.json', 'pnpm-lock.yaml', 'scripts/smoke-skills-check.mjs', 'scripts/lib/skills-check-verification.mjs']) await walk(join(repository, rel), rel, source);
  const summarize = files => { files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); return { digest: sha256(JSON.stringify(files)), files }; };
  return { schema_version: 1, source: summarize(source), build: summarize(build),
    scope: 'all package src/dist and package manifests, root package/lock, this driver/helper; exact working bytes, not proof that dist was compiled from source; installed dependencies are not independently attested' };
}
export function caseDefinition(caseId, origin, oldSha, currentSha) {
  const healthy = { id: 'healthy', origin, ref: 'refs/heads/main', blessed_sha: currentSha, auto_minor: false };
  const missing = { ...healthy, id: 'missing-ref', ref: 'refs/heads/not-present' };
  const drift = { ...healthy, id: 'drift', blessed_sha: oldSha };
  const specs = {
    healthy: { sources: [healthy], expected_exit: 0, failed: 0, drifted: 0 },
    'missing-ref': { sources: [missing], expected_exit: 1, failed: 1, drifted: 0 },
    drift: { sources: [drift], expected_exit: 2, failed: 0, drifted: 1 },
    mixed: { sources: [healthy, missing, drift], expected_exit: 1, failed: 1, drifted: 1 },
    empty: { sources: [], expected_exit: 0, failed: 0, drifted: 0 },
  };
  if (!specs[caseId]) throw usage();
  return { case_id: caseId, current_sha: currentSha, ...specs[caseId] };
}
export function evaluateCase(expected, observed, inputUnchanged) {
  const errors = [];
  if (observed.exit_code !== expected.expected_exit) errors.push('exit_mismatch');
  if (!observed.direct_child_exit_confirmed || observed.timed_out || observed.output_limited || observed.interrupted || observed.spawn_error || observed.signal) errors.push('execution_incomplete');
  if (!inputUnchanged) errors.push('input_manifest_changed');
  if (observed.stderr !== '') errors.push('unexpected_stderr');
  for (const text of [`Checking ${expected.sources.length} source(s) against their tracked refs...`, `${expected.failed} source(s) failed to check.`, `${expected.drifted} source(s) drifted from blessed_sha.`]) if (!observed.stdout.split('\n').includes(text)) errors.push('summary_mismatch');
  for (const source of expected.sources) {
    const text = source.id === 'missing-ref' ? `  ✗ ${source.id}  unreachable: no_matching_ref`
      : source.id === 'drift' ? `  ⚠ ${source.id}  drift  blessed=${source.blessed_sha.slice(0, 12)}  head=${expected.current_sha.slice(0, 12)}  ref=${source.ref}`
        : `  ✓ ${source.id}  up-to-date (${source.blessed_sha.slice(0, 12)})`;
    if (!observed.stdout.includes(text)) errors.push(`source_output_mismatch:${source.id}`);
  }
  return { case_id: expected.case_id, verification_status: errors.length ? 'failed' : 'passed', actual_exit: observed.exit_code, expected_exit: expected.expected_exit,
    source_check_status: errors.length ? 'unknown' : expected.failed ? 'failed' : expected.drifted ? 'drift' : expected.sources.length ? 'healthy' : 'empty',
    input_unchanged: inputUnchanged, errors };
}
export async function sealEvidence(directory, runId) {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    if (name === 'manifest.json') throw Error('evidence_manifest_already_exists');
    const path = join(directory, name); const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw Error('unexpected_evidence_entry');
    const bytes = await readFile(path); files.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  await writeFile(join(directory, 'manifest.json'), jsonBytes({ schema_version: 1, run_id: runId, files }), { flag: 'wx', mode: 0o600 });
}

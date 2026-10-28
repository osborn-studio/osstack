// Evidence support for one fixed engineering smoke, never a command runner.
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, appendFile, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const ordered = values => [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const present = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const fileExists = async path => { try { return (await stat(path)).isFile(); } catch { return false; } };
export const engineeringPlan = ['prepare private deterministic fixture', 'attention watch', 'engineering adopt', 'engineering observe', 'engineering defer', 'engineering decide', 'observe observed_turn completion', 'same-key decide replay', 'engineering reconcile', 'daemon drain and health', 'confirm daemon exit', 'retain evidence; clean fixture only'];
export function parseEngineeringOptions(args) {
  let mode = 'run'; let evidenceDir;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--doctor' || arg === '--dry-run') {
      if (mode !== 'run') throw Error('usage: choose one of --doctor or --dry-run');
      mode = arg === '--doctor' ? 'doctor' : 'dry-run';
    } else if (arg === '--evidence-dir') {
      if (evidenceDir !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw Error('usage: --evidence-dir requires one new directory');
      evidenceDir = resolve(args[++index]);
    } else throw Error('usage: node scripts/smoke-engineering-decision.mjs [--doctor | --dry-run] [--evidence-dir NEW_DIRECTORY]');
  }
  return { mode, evidenceDir };
}
export async function engineeringPreflight({ repository, evidenceDir, mode = 'doctor' }) {
  const checks = [];
  for (const [id, path] of [['compiled_cli', 'packages/cli/dist/bin.js'], ['compiled_core', 'packages/core/dist/index.js'], ['fixture_source', 'scripts/fixtures/engineering-crash-host.ts']]) {
    checks.push({ id, ok: await fileExists(join(repository, path)), path });
  }
  for (const [id, from, name] of [['bundler', 'package.json', 'esbuild'], ['sqlite_module', 'packages/core/package.json', 'better-sqlite3']]) {
    try { createRequire(join(repository, from)).resolve(name); checks.push({ id, ok: true }); }
    catch { checks.push({ id, ok: false }); }
  }
  let gitExecutable = null;
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory || '.', process.platform === 'win32' ? 'git.exe' : 'git');
    try { if ((await stat(candidate)).isFile()) { await access(candidate, constants.X_OK); gitExecutable = candidate; break; } } catch { /* Continue read-only PATH lookup. */ }
  }
  checks.push({ id: 'git_executable', ok: gitExecutable !== null, path: gitExecutable });
  checks.push({ id: 'node_version', ok: Number(process.versions.node.split('.')[0]) >= 20, actual: process.versions.node });
  if (evidenceDir) {
    checks.push({ id: 'evidence_destination_new', ok: !(await present(evidenceDir)) });
    try { await access(dirname(evidenceDir), constants.W_OK); checks.push({ id: 'evidence_parent_writable', ok: (await stat(dirname(evidenceDir))).isDirectory() }); }
    catch { checks.push({ id: 'evidence_parent_writable', ok: false }); }
  }
  return { schema_version: 1, status: mode === 'dry-run' ? 'planned' : 'preflight', ready: checks.every(check => check.ok), executed: false, provider_qualified: false,
    checks, plan: engineeringPlan, evidence_directory: evidenceDir ?? 'new independent engineering-evidence directory under scratch smoke/',
    limitations: ['read-only availability check; no CLI or daemon executed', 'native SQLite load and actual behavior are verified only by a run', 'no live Provider qualification'] };
}
async function walk(directory, relative, files) {
  for (const name of ordered(await readdir(directory))) {
    const path = join(directory, name); const rel = relative ? `${relative}/${name}` : name; const info = await lstat(path);
    if (info.isSymbolicLink()) throw Error('evidence_binding_symlink:' + rel);
    if (info.isDirectory()) await walk(path, rel, files);
    else if (info.isFile()) files.push({ path: rel, bytes: info.size, sha256: digest(await readFile(path)) });
  }
}
export async function engineeringBindings(repository) {
  const source = []; const build = [];
  for (const name of ordered(await readdir(join(repository, 'packages')))) {
    for (const [folder, files] of [['src', source], ['dist', build]]) {
      const dir = join(repository, 'packages', name, folder);
      if (await present(dir)) await walk(dir, `packages/${name}/${folder}`, files);
    }
    const rel = `packages/${name}/package.json`; if (await fileExists(join(repository, rel))) { const bytes = await readFile(join(repository, rel)); source.push({ path: rel, bytes: bytes.length, sha256: digest(bytes) }); }
  }
  for (const rel of ['package.json', 'pnpm-lock.yaml', 'scripts/smoke-engineering-decision.mjs', 'scripts/lib/engineering-verification-evidence.mjs']) {
    const bytes = await readFile(join(repository, rel)); source.push({ path: rel, bytes: bytes.length, sha256: digest(bytes) });
  }
  await walk(join(repository, 'scripts/fixtures'), 'scripts/fixtures', source);
  const summarize = files => { files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); return { digest: digest(JSON.stringify(files)), files }; };
  let head = null;
  try { head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository, timeout: 3000, encoding: 'utf8' })).stdout.trim(); }
  catch { /* Exact content manifests remain available without a Git executable. */ }
  return { git_head: head, source: summarize(source), build: summarize(build),
    scope: 'all package src/dist bytes and package manifests, lockfile, fixed smoke/helper and fixture sources; content digests bind working bytes even when Git HEAD is dirty; external dependencies are lockfile-pinned, not independently attested' };
}
export function sanitizeEvidence(text, secrets = []) {
  let value = String(text ?? '');
  for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]');
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}
export async function reserveEngineeringEvidence(evidenceDir, scratchRoot) {
  const runId = randomUUID();
  if (!evidenceDir) {
    const base = join(scratchRoot ?? resolve(process.env.OSSTACK_SCRATCH_ROOT ?? join(tmpdir(), 'osstack')), 'smoke');
    await mkdir(base, { recursive: true, mode: 0o700 }); evidenceDir = join(base, `engineering-evidence-${runId}`);
  }
  evidenceDir = resolve(evidenceDir);
  // mkdir without recursive is the exclusive claim, even after preflight races.
  await mkdir(evidenceDir, { mode: 0o700 });
  await writeFile(join(evidenceDir, 'observations.ndjson'), '', { flag: 'wx', mode: 0o600 });
  return { directory: evidenceDir, run_id: runId, manifest: 'manifest.json' };
}
export async function writeEngineeringEvidence(evidence, name, value, secrets = []) {
  if (!['run.json', 'receipt.json', 'cleanup.json', 'diagnostics.json'].includes(name)) throw Error('unknown_engineering_evidence_file');
  await writeFile(join(evidence.directory, name), sanitizeEvidence(JSON.stringify(value, null, 2) + '\n', secrets), { mode: 0o600 });
}
export async function appendEngineeringObservation(evidence, value, secrets = []) {
  // The fixed smoke caps each child stream; never copy authority files or env.
  await appendFile(join(evidence.directory, 'observations.ndjson'), sanitizeEvidence(JSON.stringify(value) + '\n', secrets), { mode: 0o600 });
}
export async function sealEngineeringEvidence(evidence) {
  const files = [];
  for (const name of ['run.json', 'observations.ndjson', 'receipt.json', 'cleanup.json', 'diagnostics.json']) {
    const path = join(evidence.directory, name); if (await present(path)) { const bytes = await readFile(path); files.push({ path: name, bytes: bytes.length, sha256: digest(bytes) }); }
  }
  await writeFile(join(evidence.directory, 'manifest.json'), JSON.stringify({ schema_version: 1, run_id: evidence.run_id, provider_qualified: false, files }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

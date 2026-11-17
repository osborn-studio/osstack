// Fixed portable subset of verify-osstack/features/init-doctor.md.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScratchDir } from './lib/scratch.mjs';

const cli = fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url));
const files = ['.agent/PROJECT_CONTEXT.md', 'AGENTS.md', 'docs/PRD.md', 'docs/ARCHITECTURE.md', 'docs/SPRINTS.md'];
const summary = { inputs: {}, checks: [] };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let scratch;
let code = 0;
try {
  summary.inputs.script_sha256 = digest(await readFile(new URL(import.meta.url)));
  try { summary.inputs.cli_sha256 = digest(await readFile(cli)); }
  catch { throw Error('missing CLI build; run pnpm build'); }
  scratch = await createScratchDir('smoke', 'portable-cli');
  const home = join(scratch, 'home');
  const workspace = join(scratch, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  // Do not inherit credentials, user configuration, or alternate Git directories.
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
    TMPDIR: scratch, TMP: scratch, TEMP: scratch, CI: 'true', NO_COLOR: '1',
    OSSTACK_HOME: home, OSSTACK_SOCKET: join(scratch, 'daemon.sock'),
    OSSTACK_SCRATCH_ROOT: scratch, OSSTACK_UPDATE_CHECK: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
  };
  const run = args => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: workspace, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.signal || result.status === null) throw Error('CLI process could not complete');
    if (/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_DLOPEN_FAILED/.test(result.stderr)) throw Error('CLI build dependencies unavailable; run pnpm build');
    return result;
  };
  if (run(['--help']).status !== 0) throw Error('CLI startup failed; check the build');
  const record = (id, result, pass, extra = {}) => {
    summary.checks.push({ id, pass, exit_code: result.status, ...extra });
    if (!pass) code = 1;
  };
  const first = run(['init', workspace]);
  const present = await Promise.all(files.map(async file => {
    try { return (await stat(join(workspace, file))).isFile(); } catch { return false; }
  }));
  const tasks = await stat(join(workspace, 'tasks')).catch(() => null);
  record('init_scaffold', first, first.status === 0 && present.every(Boolean) && tasks?.isDirectory() === true
    && files.every(file => first.stdout.includes(`created  ${join(workspace, file)}`)));
  if (present.every(Boolean)) {
    await appendFile(join(workspace, 'AGENTS.md'), '\nportable verification preservation marker\n');
    const before = await Promise.all(files.map(file => readFile(join(workspace, file))));
    const second = run(['init', workspace]);
    const preserved = await Promise.all(files.map(async (file, i) => {
      try { return before[i].equals(await readFile(join(workspace, file))); } catch { return false; }
    }));
    record('init_idempotent', second, second.status === 0 && preserved.every(Boolean)
      && files.every(file => second.stdout.includes(`skipped  ${join(workspace, file)} (already exists)`)));
  }
  const doctor = run(['doctor', '--workspace', workspace, '--json']);
  let report;
  try { report = JSON.parse(doctor.stdout); } catch { /* Invalid JSON is an assertion failure. */ }
  const expected = { workspace: 'ok', task_queue: 'ok', state_file: 'warn', git: 'warn', agent_instructions: 'ok', protected_config: 'warn' };
  const checks = Array.isArray(report?.loop?.checks) ? report.loop.checks : [];
  record('doctor_reports_ok', doctor, doctor.status === 0 && report?.ok === true && report?.loop?.daemon_checked === false
    && Object.entries(expected).every(([id, status]) => checks.filter(c => c?.id === id).length === 1
      && checks.find(c => c?.id === id)?.status === status),
  { warnings: Object.keys(expected).filter(id => expected[id] === 'warn' && checks.some(c => c?.id === id && c.status === 'warn')) });
} catch (error) {
  code = 2;
  // Only fixed messages reach stderr. Native exceptions can contain local paths.
  const known = ['missing CLI build; run pnpm build', 'CLI process could not complete',
    'CLI build dependencies unavailable; run pnpm build', 'CLI startup failed; check the build'];
  console.error(`verify-portable-cli setup: ${known.includes(error.message) ? error.message : 'isolated workspace setup or I/O failed'}`);
} finally {
  if (scratch) {
    try { await rm(scratch, { recursive: true, force: true }); }
    catch { code = 2; console.error('verify-portable-cli setup: scratch cleanup failed'); }
  }
}
console.log(JSON.stringify(summary));
process.exitCode = code;

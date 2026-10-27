import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScratchDir } from '../../../../scripts/lib/scratch.mjs';
const output = dirname(fileURLToPath(import.meta.url));
const upstream = resolve(process.argv[2] ?? '../cursor-plugins');
const lock = JSON.parse(await readFile(join(output, 'source-lock.json'), 'utf8'));
const actualCommit = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const upstreamStatus = execFileSync('git', ['-C', upstream, 'status', '--porcelain'], { encoding: 'utf8' });
if (actualCommit !== lock.pstack.commit || upstreamStatus.trim()) {
  throw new Error('Research requires the clean upstream checkout pinned in source-lock.json');
}
const scratch = await createScratchDir('smoke', 'pstack-research');
const temporary = join(scratch, 'tmp');
await mkdir(temporary);
const env = { ...process.env, TMPDIR: temporary, OSSTACK_HOME: join(scratch, 'osstack-home'), BUN_INSTALL_CACHE_DIR: join(scratch, 'bun-cache'), XDG_CACHE_HOME: join(scratch, 'cache') };
const results = [];
async function run(id, cmd, args, cwd, timeout = 180000) {
  const start = Date.now();
  const result = await new Promise(resolveResult => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { stderr += error.message; });
    child.on('close', (code, signal) => { clearTimeout(timer); resolveResult({ code, signal, timedOut, stdout, stderr }); });
  });
  await writeFile(join(output, `${id}.log`), result.stdout + '\n' + result.stderr);
  const entry = { id, command: [cmd, ...args], cwd, code: result.code, signal: result.signal, timed_out: result.timedOut, elapsed_ms: Date.now() - start, log: `${id}.log` };
  results.push(entry);
  console.log(JSON.stringify(entry));
  return result;
}
try {
  const tools = join(scratch, 'tools');
  await cp(join(upstream, 'pstack/skills/poteto-mode/scripts'), tools, { recursive: true });
  const installed = await run('tools-install', 'bun', ['install', '--frozen-lockfile', '--ignore-scripts'], tools);
  if (installed.code === 0) {
    // Prevent the audited bootstrap from re-installing during child CLI tests.
    const digest = createHash('sha256').update(await readFile(join(tools, 'package.json'))).update('\0').update(await readFile(join(tools, 'bun.lock'))).digest('hex');
    await writeFile(join(tools, 'node_modules/.poteto-mode-tools-install-key'), `${digest}\n`);
    await run('upstream-tools-tests', 'bun', ['test', 'orch', 'watch-pr', 'check-plan.test.ts'], tools);
    await run('upstream-watch-typecheck', join(tools, 'node_modules/.bin/tsc'), ['--project', 'watch-pr/tsconfig.json', '--noEmit', '--strict'], tools);
  }
  await run('harness-generation-check', process.execPath, ['scripts/generate-pstack-harness-trees.mjs', '--check'], upstream);
  await run('semantic-probes', 'bun', [join(output, 'semantic-probes.ts'), join(upstream, 'pstack'), scratch], upstream);
} finally {
  await rm(scratch, { recursive: true, force: true });
  await writeFile(join(output, 'research-checks.json'), JSON.stringify({ generated_at: new Date().toISOString(), node: process.version, upstream, scratch_removed: true, results, excluded: ['Full statechart/TLC/Java/rendering suite', 'Live Cursor agent workflows', 'Live GitHub writes or merges', 'OSStack application test suite'] }, null, 2) + '\n');
}
if (results.length !== 5 || results.some(result => result.code !== 0 || result.timed_out)) process.exitCode = 1;

import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const build = mkdtempSync(join(tmpdir(), 'g25-recovery-build-')); const built = new Set<string>();
const children: ChildProcess[] = []; const roots: string[] = []; const workerPids: number[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
  }
  for (const pid of workerPids.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => rmSync(build, { recursive: true, force: true }));
function fixtureRoot() { const root = mkdtempSync(join(tmpdir(), 'g25-recovery-crash-')); roots.push(root); return root; }
function host(root: string, mode: string, fixture = 'graph-recovery-host') {
  const entry = join(build, `${fixture}.mjs`);
  if (!built.has(fixture)) {
    if (!existsSync(join(build, 'node_modules'))) symlinkSync(resolve(repo, 'packages/cli/node_modules'), join(build, 'node_modules'), 'dir');
    execFileSync(resolve(repo, 'node_modules/.bin/esbuild'), [resolve(repo, `scripts/fixtures/${fixture}.ts`), '--bundle', '--platform=node', '--format=esm', '--packages=external', `--outfile=${entry}`]); built.add(fixture);
  }
  const child = fork(entry, [root, mode], { cwd: repo, env: { ...process.env, OSSTACK_HOME: join(root, 'isolated-home') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout!.resume(); child.stderr!.resume(); children.push(child); return child;
}
const message = async (child: ChildProcess) => (await once(child, 'message', { signal: AbortSignal.timeout(10000) }))[0] as Record<string, unknown>;
async function kill(child: ChildProcess) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
it.each(['killed', 'alive'])('a fresh host recovers an authenticated no-child failure with the original host %s', async original => {
  const root = fixtureRoot(); const first = host(root, 'fail-registration');
  expect(await message(first)).toMatchObject({ kind: 'ready', exit: { kind: 'spawn_failed' } });
  if (original === 'killed') await kill(first);
  const replacement = host(root, 'recover');
  expect(await message(replacement)).toMatchObject({ kind: 'recovered', generation: 2, value: 42,
    proof: { worker: { kind: 'not_started' } }, launches: { n: 1 }, actions: { n: 0 } });
  expect(readFileSync(join(root, 'executions.log'), 'utf8')).toBe('once\n');
  if (original === 'alive') {
    const refused = message(first); first.send('retry-old'); expect(await refused).toMatchObject({ kind: 'old-start-refused' });
    expect(readFileSync(join(root, 'executions.log'), 'utf8')).toBe('once\n');
  }
}, 20000);
it.each(['killed', 'alive'])('public submit survives committed reservation with its original host %s before construction', async original => {
  const root = fixtureRoot(); const fixture = 'graph-submission-crash'; const first = host(root, 'submit', fixture);
  await expect.poll(() => existsSync(join(root, 'submission.json')), { timeout: 5000 }).toBe(true);
  const data = JSON.parse(readFileSync(join(root, 'submission.json'), 'utf8')) as { root: string; status: { graphRunId: string } };
  roots.push(data.root);
  if (original === 'killed') await kill(first);
  const result = await message(host(root, 'cancel', fixture));
  expect(result).toMatchObject({ replay: { graphRunId: data.status.graphRunId, generation: 0, status: 'queued' },
    cancelled: { graphRunId: data.status.graphRunId, generation: 0, status: 'cancelled' }, invoked: 0,
    runs: { n: 1 }, actions: { n: 0 }, launches: { n: 0 } });
  if (original === 'alive') {
    const resumed = message(first); first.kill('SIGCONT'); expect(await resumed).toEqual({ kind: 'resumed', writes: 0 });
  }
  expect(await message(host(root, 'inspect', fixture))).toMatchObject({ replay: { status: 'cancelled', generation: 0 },
    invoked: 0, runs: { n: 1 }, actions: { n: 0 }, launches: { n: 0 } });
  expect(existsSync(join(data.root, 'delivery'))).toBe(false);
}, 20000);
it.each(['pre-spawn', 'pre-identity'])('refuses an unobserved %s crash window without starting replacement effects', async point => {
  const root = fixtureRoot(); const first = host(root, point);
  await expect.poll(() => existsSync(join(root, 'boundary.json')), { timeout: 5000 }).toBe(true);
  const boundary = JSON.parse(readFileSync(join(root, 'boundary.json'), 'utf8')) as { workerPid?: number };
  if (boundary.workerPid) { workerPids.push(boundary.workerPid); expect(() => process.kill(boundary.workerPid!, 0)).not.toThrow(); }
  // A paused host is also unsafe: it can still resume between consumption and spawn.
  if (point === 'pre-spawn') expect(await message(host(root, 'recover'))).toMatchObject({ kind: 'refused', error: expect.stringContaining('GRAPH_NO_CHILD_PROOF_REQUIRED') });
  await kill(first);
  expect(await message(host(root, 'recover'))).toMatchObject({ kind: 'refused', error: expect.stringContaining('GRAPH_NO_CHILD_PROOF_REQUIRED'),
    report: { launch: null, observations: [], recovery: 'held' } });
  expect(existsSync(join(root, 'executions.log'))).toBe(false);
}, 20000);

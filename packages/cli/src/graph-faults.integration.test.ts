import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, expect, it } from 'vitest';
import type { GraphWorkerBinding } from '@osstack/protocol';
import type { GraphWorkerProcessReport } from './graph-process-journal.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const build = mkdtempSync(join(tmpdir(), 'g25-process-build-'));
const entry = join(build, 'host.mjs'); let built = false;
const children: ChildProcess[] = []; const pids = new Set<number>(); const roots: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} } pids.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => rmSync(build, { recursive: true, force: true }));
interface HostMessage { binding: GraphWorkerBinding; report: GraphWorkerProcessReport; afterDuplicate?: GraphWorkerProcessReport; duplicate?: {kind: string}; hostPid?: number }
async function host(root: string, mode: 'start' | 'inspect') {
  if (!built) {
    symlinkSync(resolve(repo, 'packages/cli/node_modules'), join(build, 'node_modules'), 'dir');
    execFileSync(resolve(repo, 'node_modules/.bin/esbuild'), [resolve(repo, 'scripts/fixtures/graph-process-host.ts'), '--bundle', '--platform=node', '--format=esm', '--packages=external', `--outfile=${entry}`]);
    built = true;
  }
  const child = fork(entry, [root, mode], { cwd: repo, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(child);
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
  const message = await new Promise<HostMessage>((resolveMessage, reject) => {
    child.once('message', value => { resolveMessage(value as HostMessage); });
    child.once('exit', () => reject(new Error(`host exited before message: ${stderr}`)));
    child.once('error', reject);
  });
  return { child, message };
}
it('fresh host observes a SIGKILLed supervisor without releasing or replaying the live worker or descendants', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g25-process-crash-')); roots.push(root);
  const first = await host(root, 'start');
  expect(first.message.report).toMatchObject({ intentRecorded: true, observations: [], recovery: 'held', launch: { pid: expect.any(Number) } });
  pids.add(first.message.report.launch!.pid);
  await expect.poll(() => existsSync(join(root, 'worker.json'))).toBe(true);
  const worker = JSON.parse(readFileSync(join(root, 'worker.json'), 'utf8')) as { pid: number; child: number; escaped: number };
  pids.add(worker.child); pids.add(worker.escaped);
  expect(worker.pid).toBe(first.message.report.launch!.pid);
  for (const name of ['descendant.log', 'escaped.log']) await expect.poll(() => existsSync(join(root, name))).toBe(true);
  const hostExit = once(first.child, 'exit'); first.child.kill('SIGKILL'); await hostExit;
  const independent = await host(root, 'inspect');
  expect(independent.message.hostPid).not.toBe(first.child.pid);
  expect(independent.message.report.launch).toEqual(first.message.report.launch);
  expect(independent.message.report.observations).toEqual([]);
  expect(independent.message.report.leader.state).toBe(process.platform === 'linux' ? 'running' : 'unknown');
  expect(independent.message.duplicate?.kind).toBe('spawn_failed');
  expect(independent.message.afterDuplicate).toEqual(independent.message.report);
  process.kill(worker.pid, 'SIGKILL'); pids.delete(worker.pid);
  for (const name of ['descendant.log', 'escaped.log']) {
    const file = join(root, name); const before = readFileSync(file, 'utf8').length;
    await expect.poll(() => readFileSync(file, 'utf8').length).toBeGreaterThan(before);
  }
  const afterLeaderExit = await host(root, 'inspect');
  expect(afterLeaderExit.message.report).toMatchObject({ observations: [], executors: { state: 'unknown' }, recovery: 'held' });
  // An unobserved leader exit never upgrades the old host's journal into executor proof.
  expect(afterLeaderExit.message.report.launch).toEqual(first.message.report.launch);
});

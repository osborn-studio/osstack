import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { FifoSemaphore } from '@osstack/autonomy';
import { GovernedExecution } from './governed-execution.js';
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'g10-')); roots.push(root);
  const repo = join(root, 'repo'); execFileSync('git', ['init', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init']);
  const other = join(root, 'other'); execFileSync('git', ['-C', repo, 'worktree', 'add', other]);
  const writes = new FifoSemaphore(2);
  const repositories = new Map<string, FifoSemaphore>();
  let allowed = true;
  const admission = new GovernedExecution({ reads: new FifoSemaphore(2), writes,
    repositories, checkHealth: async () => { if (!allowed) throw new Error('health revoked'); } });
  return { admission, repo, other, writes, repositories, revoke: () => { allowed = false; } };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('canonicalizes worktrees and rechecks health after queueing without leaking permits', async () => {
  const f = await fixture();
  const lease = await f.admission.acquire({ kind: 'write', runId: 'one', workspacePath: f.repo });
  const queued = f.admission.acquire({ kind: 'write', runId: 'two', workspacePath: f.other });
  const rejected = expect(queued).rejects.toThrow('health revoked');
  await expect.poll(() => [...f.repositories.values()][0]?.pending).toBe(1);
  f.revoke(); await lease.release(); await rejected;
  expect(f.writes.in_use).toBe(0);
});
it('rejects forged hints and managed missing scope', async () => {
  const f = await fixture();
  await expect(f.admission.acquire({ kind: 'write', runId: 'x', workspacePath: f.repo, repoId: 'forged' })).rejects.toThrow();
  await expect(f.admission.acquire({ kind: 'write', runId: 'x' })).rejects.toThrow('scope');
  expect(f.writes.in_use).toBe(0);
});
it('aborts a queued writer and retains an unconfirmed producer lease', async () => {
  const f = await fixture();
  const lease = await f.admission.acquire({ kind: 'write', runId: 'one', workspacePath: f.repo });
  const abort = new AbortController();
  const queued = f.admission.acquire({ kind: 'write', runId: 'two', workspacePath: f.other, signal: abort.signal });
  const rejected = expect(queued).rejects.toThrow();
  await expect.poll(() => [...f.repositories.values()][0]?.pending).toBe(1);
  abort.abort(); await rejected;
  lease.retain("external stop unconfirmed");
  await expect(f.admission.acquire({ kind: "write", runId: "follow-up", workspacePath: f.repo })).rejects.toThrow("unconfirmed");
  expect(f.writes.in_use).toBe(1);
  await expect(lease.release()).rejects.toThrow("unconfirmed"); expect(f.writes.in_use).toBe(1);
});
it('rechecks authorization after the queue', async () => {
  const f = await fixture(); let allow = true;
  const first = await f.admission.acquire({ kind: 'write', runId: 'one', workspacePath: f.repo });
  const queued = f.admission.acquire({ kind: 'write', runId: 'two', workspacePath: f.other,
    authorize: async () => { if (!allow) throw new Error('grant revoked'); } });
  const rejected = expect(queued).rejects.toThrow('grant revoked');
  await expect.poll(() => [...f.repositories.values()][0]?.pending).toBe(1);
  allow = false;
  await first.release(); await rejected; expect(f.writes.in_use).toBe(0);
});
it('rejects same-run reentry promptly and shares canonical lock across independent homes', async () => {
  const f = await fixture();
  const lease = await f.admission.acquire({ kind: 'write', runId: 'same', workspacePath: f.repo });
  await expect(f.admission.acquire({ kind: 'write', runId: 'same', workspacePath: f.other })).rejects.toThrow('already admitted');
  const independent = new GovernedExecution({ reads: new FifoSemaphore(1), writes: new FifoSemaphore(1), repositories: new Map(), checkHealth: async () => {} });
  await expect(independent.acquire({ kind: 'write', runId: 'other-home', workspacePath: f.other })).rejects.toThrow('locked');
  await lease.release();
  const next = await independent.acquire({ kind: 'write', runId: 'after', workspacePath: f.other });
  await next.release();
});

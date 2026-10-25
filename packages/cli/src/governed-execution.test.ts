import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import * as autonomy from '@osstack/autonomy';
import { FifoSemaphore, inspectRepoWriteLock, repoLockPath } from '@osstack/autonomy';
import { resolveRepositoryScope } from '@osstack/core';
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
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
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
it('releases retained admission only after an explicit reverified reconciliation', async () => {
  const f = await fixture(); const lease = await f.admission.acquire({ kind: 'write', runId: 'retained', workspacePath: f.repo });
  lease.retain('unknown');
  await expect(lease.releaseAfterReconciliation!(async () => { throw new Error('producer alive'); })).rejects.toThrow('producer alive');
  expect(f.writes.in_use).toBe(1);
  await expect(lease.releaseAfterReconciliation!(async () => false as unknown as undefined)).rejects.toThrow('reconciliation');
  expect(f.writes.in_use).toBe(1);
  await lease.releaseAfterReconciliation!(async () => {});
  expect(f.writes.in_use).toBe(0);
  const next = await f.admission.acquire({ kind: 'write', runId: 'next', workspacePath: f.repo });
  await next.release();
});
it('keeps a repository quarantined until every retained reader is reconciled', async () => {
  const f = await fixture();
  const first = await f.admission.acquire({ kind: 'read', runId: 'read1', workspacePath: f.repo });
  const second = await f.admission.acquire({ kind: 'read', runId: 'read2', workspacePath: f.repo });
  first.retain('uncertain read executor'); second.retain('other executor');
  await first.releaseAfterReconciliation!(async () => {});
  await expect(f.admission.acquire({ kind: 'write', runId: 'early', workspacePath: f.repo })).rejects.toThrow('unconfirmed');
  await second.releaseAfterReconciliation!(async () => {});
  const next = await f.admission.acquire({ kind: 'write', runId: 'after', workspacePath: f.repo }); await next.release();
});

it('attests rejected acquisition cleanup but never attests an existing run is absent', async () => {
  const f = await fixture(); const lease = await f.admission.acquire({ kind: 'write', runId: 'one', workspacePath: f.repo });
  let proof = false;
  await expect(f.admission.acquire({ kind: 'write', runId: 'one', workspacePath: f.repo, onNotAcquired: () => { proof = true; } })).rejects.toThrow('already admitted');
  expect(proof).toBe(false);
  const abort = new AbortController(); abort.abort();
  await expect(f.admission.acquire({ kind: 'write', runId: 'one', workspacePath: f.repo, signal: abort.signal,
    onNotAcquired: () => { proof = true; } })).rejects.toThrow();
  expect(proof).toBe(false); await lease.release();
  f.revoke();
  await expect(f.admission.acquire({ kind: 'write', runId: 'two', workspacePath: f.repo, onNotAcquired: () => { proof = true; } })).rejects.toThrow('health revoked');
  expect(proof).toBe(true); expect(f.writes.in_use).toBe(0);
});

it('renews the real repository lock during slow post-acquisition authorization', async () => {
  const f = await fixture(); const scope = await resolveRepositoryScope(f.repo);
  const lockRoot = join(scope.commonDir, 'osstack', 'writer-locks');
  vi.useFakeTimers({ toFake: ['Date'] });
  const initial = Date.now(); let tick: (() => void) | undefined;
  const interval = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, timeout, ...args) => {
    if (timeout === 20_000) tick = callback as () => void;
    return interval(callback, timeout, ...args);
  });
  let checks = 0;
  const lease = await f.admission.acquire({ kind: 'write', runId: 'slow-authority', workspacePath: f.repo,
    authorize: async () => {
      if (++checks !== 2) return;
      const before = await inspectRepoWriteLock(lockRoot, scope.repoId);
      expect(before).not.toBeNull();
      vi.setSystemTime(initial + 41_000);
      expect(tick, 'renewal must already be running while authorization waits').toBeTypeOf('function');
      tick!();
      await expect.poll(async () => (await inspectRepoWriteLock(lockRoot, scope.repoId))?.expires_at).not.toBe(before!.expires_at);
    } });
  try {
    vi.setSystemTime(initial + 65_000);
    await expect(lease.assertActive!()).resolves.toBeUndefined();
  } finally { await lease.release(); }
  expect(f.writes.in_use).toBe(0);
});


it.each(['revoked', 'expired', 'aborted'] as const)('does not publish admission after slow authority is %s', async mode => {
  const f = await fixture(); const scope = await resolveRepositoryScope(f.repo);
  const lockRoot = join(scope.commonDir, 'osstack', 'writer-locks');
  const clear = vi.spyOn(globalThis, 'clearInterval');
  vi.useFakeTimers({ toFake: ['Date'] });
  const initial = Date.now(); const abort = new AbortController(); let checks = 0, notAcquired = false;
  await expect(f.admission.acquire({ kind: 'write', runId: 'rejected', workspacePath: f.repo, signal: abort.signal,
    onNotAcquired: () => { notAcquired = true; }, authorize: async () => {
      if (++checks !== 2) return;
      expect(await inspectRepoWriteLock(lockRoot, scope.repoId)).not.toBeNull();
      vi.setSystemTime(initial + (mode === 'expired' ? 61_000 : 41_000));
      if (mode === 'revoked') throw Error('grant revoked');
      if (mode === 'aborted') abort.abort();
    } })).rejects.toThrow();
  expect(notAcquired).toBe(true); expect(clear).toHaveBeenCalled();
  expect(f.writes.in_use).toBe(0); expect(await inspectRepoWriteLock(lockRoot, scope.repoId)).toBeNull();
  const next = await f.admission.acquire({ kind: 'write', runId: 'after', workspacePath: f.repo });
  await next.release();
});


it('preserves both admission and cleanup errors and quarantines a replaced pre-admission lock', async () => {
  const f = await fixture(); const scope = await resolveRepositoryScope(f.repo);
  const root = join(scope.commonDir, 'osstack', 'writer-locks'); let checks = 0, notAcquired = false;
  const token = randomUUID();
  const attempt = f.admission.acquire({ kind: 'write', runId: 'replaced', workspacePath: f.repo,
    onNotAcquired: () => { notAcquired = true; }, authorize: async () => {
      if (++checks !== 2) return;
      const owner = await inspectRepoWriteLock(root, scope.repoId);
      writeFileSync(repoLockPath(root, scope.repoId), JSON.stringify({ ...owner, token }));
      throw Error('grant revoked');
    } });
  await expect(attempt).rejects.toMatchObject({ name: 'AggregateError', errors: [expect.objectContaining({ message: 'grant revoked' }), expect.any(Error)] });
  expect(notAcquired).toBe(false); expect(f.writes.in_use).toBe(0);
  expect((await inspectRepoWriteLock(root, scope.repoId))?.token).toBe(token);
  await expect(f.admission.acquire({ kind: 'write', runId: 'next', workspacePath: f.repo })).rejects.toThrow('reconciliation required');
});

it('provides writer-only scoped proof without releasing capacity after synchronous work', async () => {
  const f = await fixture(); const lease = await f.admission.acquire({ kind: 'write', runId: 'guard', workspacePath: f.repo });
  const scope = await resolveRepositoryScope(f.repo); let escaped: (() => void) | undefined;
  expect(await lease.withWriteGuard!(scope.workspacePath, check => { check(); escaped = check; return 42; })).toBe(42);
  expect(() => escaped!()).toThrow('guard'); expect(f.writes.in_use).toBe(1);
  await expect(lease.withWriteGuard!(f.other, () => 1)).rejects.toThrow('workspace mismatch');
  await lease.release(); expect(f.writes.in_use).toBe(0);
  const read = await f.admission.acquire({ kind: 'read', runId: 'read', workspacePath: f.repo });
  expect(read.withWriteGuard).toBeUndefined(); await read.release();
});
it('retains physical capacity and blocks subsequent work after guarded failure', async () => {
  const f = await fixture(); const lease = await f.admission.acquire({ kind: 'write', runId: 'guard-failure', workspacePath: f.repo });
  const scope = await resolveRepositoryScope(f.repo);
  await expect(lease.withWriteGuard!(scope.workspacePath, () => { throw Error('partial'); })).rejects.toThrow('partial');
  await expect(lease.release()).rejects.toThrow('unconfirmed'); expect(f.writes.in_use).toBe(1);
  await expect(lease.withWriteGuard!(scope.workspacePath, () => 1)).rejects.toThrow('unavailable');
  await lease.releaseAfterReconciliation!(async () => undefined); expect(f.writes.in_use).toBe(0);
});
it('rejects release and reconciliation while synchronous guarded work is in flight', async () => {
  const f = await fixture(); const lease = await f.admission.acquire({ kind: 'write', runId: 'guard-release', workspacePath: f.repo });
  const scope = await resolveRepositoryScope(f.repo); const pending: Promise<unknown>[] = [];
  await lease.withWriteGuard!(scope.workspacePath, check => {
    pending.push(expect(lease.release()).rejects.toThrow('guard in progress'));
    pending.push(expect(lease.releaseAfterReconciliation!(async () => undefined)).rejects.toThrow('guard in progress'));
    check();
  });
  await Promise.all(pending); expect(f.writes.in_use).toBe(1); await lease.release();
});
it('retains a mistaken asynchronous guarded callback and contains its rejection', async () => {
  const f = await fixture(); const lease = await f.admission.acquire({ kind: 'write', runId: 'guard-async', workspacePath: f.repo });
  const scope = await resolveRepositoryScope(f.repo);
  await expect(lease.withWriteGuard!(scope.workspacePath, () => Promise.reject(Error('late')))).rejects.toThrow('synchronous');
  await expect(lease.release()).rejects.toThrow('unconfirmed');
  await lease.releaseAfterReconciliation!(async () => undefined);
});

it('rejects a new guard while reconciliation verification is already pending', async () => {
  const f = await fixture(); const lease = await f.admission.acquire({ kind: 'write', runId: 'guard-recon', workspacePath: f.repo });
  const scope = await resolveRepositoryScope(f.repo);
  let finish!: () => void; const barrier = new Promise<void>(resolve => { finish = resolve; });
  const release = lease.releaseAfterReconciliation!(() => barrier);
  await expect(lease.withWriteGuard!(scope.workspacePath, () => 1)).rejects.toThrow('unavailable');
  await expect(lease.releaseAfterReconciliation!(async () => { throw Error('second verifier denied'); })).rejects.toThrow('second verifier denied');
  const normalRelease = lease.release();
  finish(); await Promise.all([release, normalRelease]); expect(f.writes.in_use).toBe(0);
  await expect(lease.releaseAfterReconciliation!(async () => { throw Error('released verifier denied'); })).rejects.toThrow('released verifier denied');
});
it('defers renewal ticks during guarded work and renews before releasing the guard state', async () => {
  const f = await fixture(); vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const lease = await f.admission.acquire({ kind: 'write', runId: 'guard-renew', workspacePath: f.repo });
  const scope = await resolveRepositoryScope(f.repo);
  try {
    await lease.withWriteGuard!(scope.workspacePath, check => { vi.advanceTimersByTime(40000); check(); });
    await lease.assertActive!(); expect(f.writes.in_use).toBe(1);
  } finally { await lease.release(); }
  expect(f.writes.in_use).toBe(0);
});

it('coalesces normal release and reconciliation until the physical repository lock is released', async () => {
  const original = autonomy.acquireRepoWriteLock;
  let releasePhysical!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { releasePhysical = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let physicalCalls = 0;
  vi.spyOn(autonomy, 'acquireRepoWriteLock').mockImplementation(async (...args) => {
    const lock = await original(...args);
    return { ...lock, release: async () => { physicalCalls++; entered(); await gate; await lock.release(); } };
  });
  const f = await fixture(); const lease = await f.admission.acquire({ kind: 'write', runId: 'release-race', workspacePath: f.repo });
  const pending = lease.release(); await started;
  await expect(lease.releaseAfterReconciliation!(async () => { throw Error('recovery grant revoked'); })).rejects.toThrow('recovery grant revoked');
  let verifications = 0; let recovered = false; const recovery = lease.releaseAfterReconciliation!(async () => { verifications++; }).then(() => { recovered = true; });
  const second = lease.release(); await Promise.resolve(); await Promise.resolve();
  expect(recovered).toBe(false); expect(f.writes.in_use).toBe(1); expect(physicalCalls).toBe(1);
  await expect(lease.assertActive!()).rejects.toThrow('unavailable');
  releasePhysical(); await Promise.all([pending, second, recovery]);
  expect(recovered).toBe(true); expect(verifications).toBe(1); expect(f.writes.in_use).toBe(0); expect(physicalCalls).toBe(1);
});

import { join } from 'node:path';
import { renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { acquireRepoWriteLock, inspectRepoWriteLock, repoLockPath } from '@osstack/autonomy';
import { resolveRepositoryScope } from '@osstack/core';
import { GraphRecoveryStore } from '@osstack/core/graph-recovery';
import { GraphDelegationStatus } from '@osstack/protocol';
import { GraphRpcService } from './graph-rpc.js';
import { graphRpcFixture } from './graph-test-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const f = await graphRpcFixture(); let allowed = true;
  const options = { ...f.options, registrations: [{ ...f.registration, authorize: () => { if (!allowed) throw Error('GRANT_EXPIRED'); } }],
    acquire: async (input: Parameters<typeof f.options.acquire>[0]) => {
      const action = f.db.prepare('SELECT node_id FROM graph_actions WHERE effect_key=?').get(input.runId.slice('graph-action:'.length)) as { node_id: string } | undefined;
      if (action?.node_id === 'e0.prepare_tests') {
        // Reproduce the old host: queued acquisition rejects on cancellation,
        // without the new host-only positive cleanup callback.
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(Error('legacy admission cancelled'));
          if (input.signal?.aborted) abort(); else input.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return f.options.acquire(input);
    } };
  let service = new GraphRpcService(options);
  cleanup.push(async () => { await service.close(); await f.close(); });
  const started = GraphDelegationStatus.parse(await service.handle(f.connection, 'graph.start', f.request));
  const id = started.graphRunId;
  await expect.poll(() => f.db.prepare("SELECT state FROM graph_actions WHERE graph_run_id=? AND node_id='e0.prepare_review'").get(id), { timeout: 20000 }).toEqual({ state: 'confirmed' });
  const status = () => f.status(id, service);
  const current = await status();
  await service.handle(f.connection, 'graph.cancel', { schemaVersion: 1, kind: 'cancel', scope: f.request.scope, graphRunId: id,
    expectedRevision: current.revision, idempotencyKey: 'initial-cancel' });
  await expect.poll(() => f.db.prepare("SELECT state FROM graph_actions WHERE graph_run_id=? AND node_id='e0.prepare_tests'").get(id), { timeout: 10000 }).toEqual({ state: 'failed' });
  await service.close(); service = new GraphRpcService(options);
  expect((await status()).status).toBe('cancel_pending');
  const target = f.db.prepare("SELECT effect_key FROM graph_actions WHERE graph_run_id=? AND node_id='e0.prepare_tests'").get(id) as { effect_key: string };
  const scope = await resolveRepositoryScope(join(f.options.root, id, 'writer-0'));
  const request = async (key = 'reconcile') => ({ schemaVersion: 1, kind: 'cancel', scope: f.request.scope, graphRunId: id,
    expectedRevision: (await status()).revision, idempotencyKey: key });
  return { ...f, id, key: target.effect_key, scope, request, status,
    reconcile: async (value?: unknown) => service.handle(f.connection, 'graph.reconcile', value ?? await request()),
    revoke: () => { allowed = false; }, restart: async () => { await service.close(); service = new GraphRpcService(options); } };
}
it('reconciles the legacy missing admission through public RPC without changing actions or reexecuting', async () => {
  const f = await fixture(); const before = f.db.prepare('SELECT * FROM graph_actions ORDER BY effect_key').all();
  const request = await f.request();
  expect(await f.reconcile(request)).toMatchObject({ status: 'cancelled' });
  expect(f.db.prepare('SELECT * FROM graph_actions ORDER BY effect_key').all()).toEqual(before);
  expect(f.db.prepare('SELECT released_at FROM graph_action_admissions WHERE effect_key=?').get(f.key)).toMatchObject({ released_at: expect.any(Number) });
  expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 2 });
  await f.restart(); expect(await f.reconcile(request)).toMatchObject({ status: 'cancelled' }); expect(f.writes()).toBe(1);
}, 40000);
it.each(['lock', 'execution-ref', 'unknown', 'held-predecessor', 'missing-exit', 'wrong-message', 'extra-action', 'wrong-usage', 'revoked'])('preserves the obligation when %s blocks independent proof', async mode => {
  const f = await fixture(); let lock: Awaited<ReturnType<typeof acquireRepoWriteLock>> | undefined;
  // Fault injection only in this disposable fixture: bypass normal immutable
  // storage guards to verify recovery independently refuses corrupted evidence.
  if (!['lock', 'revoked'].includes(mode)) {
    const triggers = f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[];
    for (const trigger of triggers) f.db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
  }
  if (mode === 'lock') lock = await acquireRepoWriteLock({ root_dir: join(f.scope.commonDir, 'osstack', 'writer-locks'), repo_id: f.scope.repoId, autonomy_run_id: 'other-owner', recover_stale: false });
  if (mode === 'execution-ref') f.db.prepare('UPDATE graph_actions SET execution_ref=? WHERE effect_key=?').run('possibly-started', f.key);
  if (mode === 'unknown') f.db.prepare("UPDATE graph_actions SET state='unknown',outcome_json=NULL,actual_tokens=NULL,uncertainty_json='{}' WHERE effect_key=?").run(f.key);
  if (mode === 'held-predecessor') f.db.prepare('UPDATE graph_action_admissions SET released_at=NULL WHERE graph_run_id=?').run(f.id);
  if (mode === 'missing-exit') f.db.prepare("DELETE FROM graph_worker_process_events WHERE kind='exited'").run();
  if (mode === 'wrong-message') f.db.prepare("UPDATE graph_actions SET outcome_json=replace(outcome_json,'admission refused before invocation','other failure') WHERE effect_key=?").run(f.key);
  if (mode === 'extra-action') f.db.prepare("UPDATE graph_actions SET node_id='e0.other',effect_json=replace(effect_json,'e0.prepare_tests','e0.other') WHERE effect_key=?").run(f.key);
  if (mode === 'wrong-usage') f.db.prepare('UPDATE graph_actions SET observed_tokens=1 WHERE effect_key=?').run(f.key);
  const request = await f.request(); if (mode === 'revoked') f.revoke();
  try {
    if (mode === 'revoked') await expect(f.reconcile(request)).rejects.toThrow('GRANT_EXPIRED');
    else expect(await f.reconcile(request)).toMatchObject({ status: 'cancel_pending' });
    expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT 1 FROM graph_action_admissions WHERE effect_key=?').get(f.key)).toBeUndefined();
    if (lock) expect((await inspectRepoWriteLock(join(f.scope.commonDir, 'osstack', 'writer-locks'), f.scope.repoId))?.token).toBe(lock.owner.token);
  } finally { await lock?.release(); }
}, 40000);
it('retries a lost release acknowledgement after restart while refusing a replacement lock', async () => {
  const f = await fixture();
  vi.spyOn(GraphRecoveryStore.prototype, 'completeRelease').mockImplementationOnce(() => { throw Error('lost ACK'); });
  expect(await f.reconcile()).toMatchObject({ status: 'cancel_pending' }); vi.restoreAllMocks();
  const lock = await acquireRepoWriteLock({ root_dir: join(f.scope.commonDir, 'osstack', 'writer-locks'), repo_id: f.scope.repoId, autonomy_run_id: 'replacement', recover_stale: false });
  try { await f.restart(); expect(await f.reconcile(await f.request('replacement'))).toMatchObject({ status: 'cancel_pending' }); }
  finally { await lock.release(); }
  await f.restart(); expect(await f.reconcile(await f.request('retry-release'))).toMatchObject({ status: 'cancelled' }); expect(f.writes()).toBe(1);
}, 40000);

it('rechecks cancellation authority at the final G15 commit', async () => {
  const f = await fixture(); const commit = GraphRecoveryStore.prototype.commit;
  vi.spyOn(GraphRecoveryStore.prototype, 'commit').mockImplementation(function (this: GraphRecoveryStore, ...args) {
    f.revoke(); return commit.apply(this, args);
  });
  await expect(f.reconcile()).rejects.toThrow('GRANT_EXPIRED');
  expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 0 });
}, 40000);

it('refuses a lock appearing between proof capture and the G15 transaction', async () => {
  const f = await fixture(); const commit = GraphRecoveryStore.prototype.commit;
  const path = repoLockPath(join(f.scope.commonDir, 'osstack', 'writer-locks'), f.scope.repoId);
  let created = false;
  vi.spyOn(GraphRecoveryStore.prototype, 'commit').mockImplementation(function (this: GraphRecoveryStore, ...args) {
    if (!created) { writeFileSync(path, '{}', { flag: 'wx' }); created = true; }
    return commit.apply(this, args);
  });
  try {
    expect(await f.reconcile()).toMatchObject({ status: 'cancel_pending' });
    expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 0 });
  } finally { if (created) unlinkSync(path); }
}, 40000);
it('refuses a symlink-substituted lock directory without changing the ledger', async () => {
  const f = await fixture(); const path = join(f.scope.commonDir, 'osstack', 'writer-locks');
  const backup = path + '-fixture-original'; renameSync(path, backup); symlinkSync(backup, path);
  try {
    expect(await f.reconcile()).toMatchObject({ status: 'cancel_pending' });
    expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 0 });
  } finally { unlinkSync(path); renameSync(backup, path); }
}, 40000);
it('replays a lost project acknowledgement without another decision or action', async () => {
  const f = await fixture(); const commit = GraphRecoveryStore.prototype.commit;
  vi.spyOn(GraphRecoveryStore.prototype, 'commit').mockImplementation(function (this: GraphRecoveryStore, ...args) {
    const result = commit.apply(this, args);
    if (args[1].kind === 'project') throw Error('lost project ACK');
    return result;
  });
  const request = await f.request();
  expect(await f.reconcile(request)).toMatchObject({ status: 'cancelled' }); vi.restoreAllMocks();
  await f.restart(); expect(await f.reconcile(request)).toMatchObject({ status: 'cancelled' });
  expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 2 }); expect(f.writes()).toBe(1);
}, 40000);

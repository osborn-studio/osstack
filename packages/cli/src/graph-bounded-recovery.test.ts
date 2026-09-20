import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { openDb } from '@osstack/core';
import { GraphRecoveryStore } from '@osstack/core/graph-recovery';
import { GraphDelegationStatus, type StartGraphRequest } from '@osstack/protocol';
import { inspectRepoWriteLock, acquireRepoWriteLock } from '@osstack/autonomy';
import type { AgentAdapter } from '@osstack/agents';
import { GraphRpcService, type GraphHostRegistration } from './graph-rpc.js';
import { loadBoundedRecoveryJournal } from './graph-bounded-recovery-journal.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const build = mkdtempSync(join(tmpdir(), 'g25-bounded-build-')); const entry = join(build, 'host.mjs');
const cleanup: Array<() => Promise<void>> = [];
afterAll(() => rmSync(build, { recursive: true, force: true }));
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture(mode = 'before-commit') {
  if (!existsSync(entry)) {
    symlinkSync(resolve(repo, 'packages/cli/node_modules'), join(build, 'node_modules'), 'dir');
    execFileSync(resolve(repo, 'node_modules/.bin/esbuild'), [resolve(repo, 'scripts/fixtures/graph-bounded-settlement-crash.ts'), '--bundle', '--platform=node', '--format=esm', '--packages=external', `--outfile=${entry}`]);
  }
  const output = mkdtempSync(join(tmpdir(), 'g25-bounded-restart-'));
  const child: ChildProcess = fork(entry, [output, mode], { cwd: repo, env: { ...process.env, OSSTACK_HOME: join(output, 'isolated') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = ''; child.stdout!.on('data', b => { logs += b; }); child.stderr!.on('data', b => { logs += b; });
  cleanup.push(async () => { if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; } rmSync(output, { recursive: true, force: true }); });
  const exit = once(child, 'exit');
  await expect.poll(() => existsSync(join(output, 'metadata.json')) || child.exitCode !== null, { timeout: 20000 }).toBe(true);
  if (!existsSync(join(output, 'metadata.json'))) throw Error(logs);
  if (mode !== 'alive') expect((await exit)[0]).toBe(0);
  const data = JSON.parse(readFileSync(join(output, 'metadata.json'), 'utf8')) as { root: string; id: string; request: StartGraphRequest;
    registration: Omit<GraphHostRegistration, 'authorize' | 'delivery'> & { delivery: Pick<GraphHostRegistration['delivery'], 'repositoryPath' | 'task' | 'acceptanceRegistry'> } };
  const db = openDb({ path: join(data.root, 'control.sqlite') }); const connection = {}; let allow = true;
  const adapter: AgentAdapter = { id: 'unused', display_name: 'unused', cost_tier: 'low', capabilities: () => [], isAvailable: async () => ({ available: false, last_checked_at: 0 }),
    invoke: () => { throw Error('RECOVERY_MUST_NOT_INVOKE'); } };
  const options = { db, root: join(data.root, 'delivery'), acquire: async () => { throw Error('RECOVERY_MUST_NOT_ACQUIRE'); }, resolveCaller: (c: object) => c === connection ? 'local' : null,
    registrations: [{ ...data.registration, admitNewRuns: () => false, authorize: (operation?: string) => { if (operation === 'cancel' && !allow) throw Error('GRANT_EXPIRED'); },
      delivery: { ...data.registration.delivery, writer: { identity: adapter.id, adapter, capabilityId: 'unused' }, reviewer: { identity: adapter.id, adapter, capabilityId: 'unused' }, verifyReviewer: async () => {} } }] };
  let service = new GraphRpcService(options);
  cleanup.push(async () => { await service.close(); db.close(); rmSync(data.root, { recursive: true, force: true }); });
  const status = async () => GraphDelegationStatus.parse(await service.handle(connection, 'graph.status', { schemaVersion: 1, scope: data.request.scope, graphRunId: data.id }));
  const request = async (key = 'reconcile') => ({ schemaVersion: 1, kind: 'cancel', scope: data.request.scope, graphRunId: data.id, expectedRevision: (await status()).revision, idempotencyKey: key });
  const reconcile = (input: unknown) => service.handle(connection, 'graph.reconcile', input);
  const key = (db.prepare("SELECT effect_key FROM graph_actions WHERE graph_run_id=? AND node_id='e0.implement'").get(data.id) as { effect_key: string }).effect_key;
  return { ...data, db, output, child, key, status, request, reconcile, setGrant: (v: boolean) => { allow = v; },
    restart: async () => { await service.close(); service = new GraphRpcService(options); },
    journal: () => loadBoundedRecoveryJournal(join(data.root, 'delivery', data.id), key),
    held: () => db.prepare('SELECT released_at FROM graph_action_admissions WHERE effect_key=?').get(key) as { released_at: number | null } };
}
it.each(['before-commit', 'after-commit'])('public cancellation recovers a bounded writer %s across a real host exit without invoking again', async mode => {
  const f = await fixture(mode); const journal = f.journal();
  const lockRoot = join(journal.commonDir, 'osstack', 'writer-locks');
  expect(await inspectRepoWriteLock(lockRoot, journal.repoId)).not.toBeNull(); expect(f.held().released_at).toBeNull();
  const request = await f.request(); const result = await f.reconcile(request);
  expect(result).toMatchObject({ status: 'cancelled', generation: 1, budget: { actionStarts: 2 } });
  expect(f.held().released_at).not.toBeNull(); expect(await inspectRepoWriteLock(lockRoot, journal.repoId)).toBeNull();
  expect(f.db.prepare("SELECT state FROM graph_actions WHERE effect_key=?").get(f.key)).toEqual({ state: 'confirmed' });
  expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 2 });
  expect(readFileSync(join(journal.workspacePath, 'answer'), 'utf8')).toBe('1\n');
  expect(readFileSync(join(f.root, 'source', 'answer'), 'utf8')).toBe('0\n');
  await f.restart(); expect(await f.reconcile(request)).toEqual(result);
  expect(readFileSync(join(f.output, 'invocations'), 'utf8')).toBe('once\n');
}, 30000);
it.each(['alive', 'disconnect', 'no-worker-exit', 'future-template', 'workspace-tampered', 'journal-tampered', 'missing-journal', 'receipt-tampered', 'ignored-file', 'symlink', 'revoked'])('retains admission when %s prevents recovery', async mode => {
  const f = await fixture(['alive', 'disconnect', 'no-worker-exit', 'future-template'].includes(mode) ? mode : undefined);
  if (mode === 'workspace-tampered') writeFileSync(join(f.journal().workspacePath, 'answer'), 'changed');
  if (mode === 'journal-tampered') { const j = f.journal(); writeFileSync(join(f.root, 'delivery', f.id, 'bounded-recovery', `${f.key}.json`), JSON.stringify({ ...j, executionRef: 'foreign' })); }
  if (mode === 'missing-journal') rmSync(join(f.root, 'delivery', f.id, 'bounded-recovery', `${f.key}.json`));
  if (mode === 'receipt-tampered') writeFileSync(join(f.root, 'delivery', f.id, 'delivery-receipts', `${f.journal().evidenceRef.slice(15)}.json`), '{}');
  if (mode === 'ignored-file') writeFileSync(join(f.journal().workspacePath, '.ignored'), 'foreign change');
  if (mode === 'symlink') { const path = join(f.journal().workspacePath, 'answer'); rmSync(path); symlinkSync(join(f.root, 'source', 'answer'), path); }
  const request = await f.request(); if (mode === 'revoked') f.setGrant(false);
  if (mode === 'revoked') await expect(f.reconcile(request)).rejects.toThrow('GRANT_EXPIRED');
  else expect(await f.reconcile(request)).toMatchObject({ status: 'cancel_pending' });
  expect(f.held().released_at).toBeNull(); expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 0 });
  expect(readFileSync(join(f.output, 'invocations'), 'utf8')).toBe('once\n');
}, 30000);
it('replays a lost release ACK after another service restart without unlinking a replacement owner', async () => {
  const f = await fixture(); const journal = f.journal(); const lockRoot = join(journal.commonDir, 'osstack', 'writer-locks');
  const fail = vi.spyOn(GraphRecoveryStore.prototype, 'completeRelease').mockImplementationOnce(() => { throw Error('lost release database ACK'); });
  expect(await f.reconcile(await f.request())).toMatchObject({ status: 'cancel_pending' });
  expect(f.held().released_at).toBeNull(); expect(await inspectRepoWriteLock(lockRoot, journal.repoId)).toBeNull(); fail.mockRestore();
  const replacement = await acquireRepoWriteLock({ root_dir: lockRoot, repo_id: journal.repoId, autonomy_run_id: 'replacement', recover_stale: false });
  try {
    await f.restart(); expect(await f.reconcile(await f.request('replacement'))).toMatchObject({ status: 'cancel_pending' });
    expect((await inspectRepoWriteLock(lockRoot, journal.repoId))?.token).toBe(replacement.owner.token); expect(f.held().released_at).toBeNull();
  } finally { await replacement.release(); }
  await f.restart(); expect(await f.reconcile(await f.request('retry-release'))).toMatchObject({ status: 'cancelled' });
  expect(f.held().released_at).not.toBeNull(); expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 2 });
}, 30000);

it('rechecks cancellation authority inside the final recovery transaction', async () => {
  const f = await fixture(); const commit = GraphRecoveryStore.prototype.commit;
  vi.spyOn(GraphRecoveryStore.prototype, 'commit').mockImplementation(function (this: GraphRecoveryStore, ...args) {
    f.setGrant(false); return commit.apply(this, args);
  });
  await expect(f.reconcile(await f.request())).rejects.toThrow('GRANT_EXPIRED');
  expect(f.held().released_at).toBeNull(); expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 0 });
}, 30000);
it('concurrent reconciliation cannot duplicate a settlement or free another action', async () => {
  const f = await fixture(); const request = await f.request();
  const results = await Promise.all([f.reconcile(request), f.reconcile(request)]);
  expect(results.every(r => ['cancel_pending', 'cancelled'].includes(GraphDelegationStatus.parse(r).status))).toBe(true);
  expect(await f.status()).toMatchObject({ status: 'cancelled' });
  expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 2 });
  expect(readFileSync(join(f.output, 'invocations'), 'utf8')).toBe('once\n');
}, 30000);

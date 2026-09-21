import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { readFileSync, writeFileSync, renameSync, symlinkSync, unlinkSync, chmodSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { GraphRunStore, resolveRepositoryScope } from '@osstack/core';
import { GraphRecoveryStore } from '@osstack/core/graph-recovery';
import { inspectRepoWriteLock, repoLockPath, type RepoLockOwner } from '@osstack/autonomy';
import { GraphDelegationStatus } from '@osstack/protocol';
import { graphRpcFixture } from './graph-test-fixture.js';
import { GraphRpcService } from './graph-rpc.js';
import { cancelStoppedGraphVerification } from './graph-stopped-verification-recovery.js';
import { reconcileStoppedVerification } from './graph-maintenance.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const f = await graphRpcFixture(); f.options.root = join(f.root, 'graph-delivery');
  let allowed = true, lockOwner: RepoLockOwner | undefined, workspace = '', lockRoot = '', repoId = '';
  const service = new GraphRpcService({ ...f.options, acquire: async input => {
    const row = f.db.prepare('SELECT node_id FROM graph_actions WHERE effect_key=?').get(input.runId.slice('graph-action:'.length)) as { node_id: string };
    if (row.node_id !== 'e0.tests') return f.options.acquire(input);
    await input.authorize?.(); workspace = input.workspacePath!;
    const scope = await resolveRepositoryScope(workspace); lockRoot = join(scope.commonDir, 'osstack', 'writer-locks'); repoId = scope.repoId;
    // A real departed owner leaves one retained lock, simulating a restart after
    // the actual registered command stopped but its admission release failed.
    const modulePath = createRequire(import.meta.url).resolve('@osstack/autonomy');
    const script = `import{acquireRepoWriteLock}from${JSON.stringify(modulePath)};const lock=await acquireRepoWriteLock(JSON.parse(process.argv[1]));console.log(JSON.stringify(lock.owner));`;
    lockOwner = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script,
      JSON.stringify({ root_dir: lockRoot, repo_id: repoId, autonomy_run_id: input.runId, recover_stale: false })], { encoding: 'utf8' }));
    return { assertActive: async () => {}, retain: () => {}, release: async () => { throw Error('simulated retained release'); } };
  } });
  cleanup.push(async () => { await service.close(); await f.close(); });
  const id = GraphDelegationStatus.parse(await service.handle(f.connection, 'graph.start', f.request)).graphRunId;
  await expect.poll(async () => (await f.status(id, service)).status, { timeout: 90000 }).toBe('reconciliation_required');
  const status = await f.status(id, service);
  await service.handle(f.connection, 'graph.cancel', { schemaVersion: 1, kind: 'cancel', scope: f.request.scope, graphRunId: id,
    expectedRevision: status.revision, idempotencyKey: 'cancel-retained-tests' });
  await service.close();
  if (!lockOwner) throw Error('missing fixture lock');
  const run = () => new GraphRunStore(f.db).get(f.request.scope, id)!;
  const input = () => ({ fence: { scope: f.request.scope, graphRunId: id, identity: run().identity,
    expectedGeneration: 1, expectedOwner: run().leaseOwner, expectedRevision: run().revision, now: Date.now() },
    receiptId: 'cancel-confirmed-tests', expectedDaemonPid: lockOwner!.pid, expectedLockOwner: lockOwner!,
    acceptanceRegistry: f.registration.delivery.acceptanceRegistry });
  const authorize = () => { if (!allowed) throw Error('GRANT_EXPIRED'); };
  const root = join(f.options.root, id), path = repoLockPath(lockRoot, repoId);
  const target = f.db.prepare("SELECT effect_key,outcome_json FROM graph_actions WHERE graph_run_id=? AND node_id='e0.tests'").get(id) as { effect_key: string; outcome_json: string };
  const evidenceRef = JSON.parse(target.outcome_json).evidenceRef as string;
  return { ...f, home: f.root, id, run, input, root, path, workspace, lockOwner, target, lockRoot, repoId,
    evidencePath: join(root, 'verification/evidence', evidenceRef.slice('graph-verification:'.length) + '.json'),
    recover: () => cancelStoppedGraphVerification(f.db, root, input(), authorize),
    inspect: () => cancelStoppedGraphVerification(f.db, root, { ...input(), inspectOnly: true }, authorize),
    revoke: () => { allowed = false; } };
}
it('cancels exact stopped tests after owner exit, without changing any action or replaying the writer', async () => {
  const f = await fixture(); const before = f.db.prepare('SELECT * FROM graph_actions ORDER BY effect_key').all();
  expect(await f.inspect()).toMatchObject({ mode: 'read_only', owner: f.lockOwner });
  expect(await f.recover()).toMatchObject({ exit: 'projected', result: { run: { status: 'cancelled' } } });
  expect(f.db.prepare('SELECT * FROM graph_actions ORDER BY effect_key').all()).toEqual(before);
  expect(await inspectRepoWriteLock(f.lockRoot, f.repoId)).toBeNull(); expect(f.writes()).toBe(1);
  expect(f.db.prepare('SELECT released_at FROM graph_action_admissions WHERE effect_key=?').get(f.target.effect_key)).toMatchObject({ released_at: expect.any(Number) });
  await expect(f.recover()).rejects.toThrow();
}, 120000);

it.each(['live-owner','wrong-token','changed-expiry','dirty-workspace','tampered-receipt','missing-exit','other-hold','unknown-action','wrong-program','revoked','symlink-root'] as const)(
  'preserves all obligations for %s', async mode => {
    const f = await fixture();
    if (['missing-exit','other-hold','unknown-action','wrong-program'].includes(mode)) {
      const triggers = f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[];
      for (const t of triggers) f.db.exec(`DROP TRIGGER "${t.name}"`);
    }
    if (mode === 'live-owner') { f.lockOwner.pid = process.pid; writeFileSync(f.path, JSON.stringify(f.lockOwner)); }
    if (mode === 'wrong-token') writeFileSync(f.path, JSON.stringify({ ...f.lockOwner, token: randomUUID() }));
    if (mode === 'changed-expiry') writeFileSync(f.path, JSON.stringify({ ...f.lockOwner, expires_at: new Date(Date.parse(f.lockOwner.expires_at!) + 1000).toISOString() }));
    if (mode === 'dirty-workspace') writeFileSync(join(f.workspace, 'answer'), 'changed\n');
    if (mode === 'tampered-receipt') { chmodSync(f.evidencePath, 0o600); writeFileSync(f.evidencePath, '{}'); }
    if (mode === 'missing-exit') f.db.prepare("DELETE FROM graph_worker_process_events WHERE kind='exited'").run();
    if (mode === 'other-hold') f.db.prepare("UPDATE graph_action_admissions SET released_at=NULL WHERE effect_key != ?").run(f.target.effect_key);
    if (mode === 'unknown-action') f.db.prepare("UPDATE graph_actions SET state='unknown',outcome_json=NULL WHERE effect_key=?").run(f.target.effect_key);
    if (mode === 'wrong-program') f.db.prepare("UPDATE graph_runs SET identity_json=replace(identity_json,'code-delivery-functional-v4','code-delivery-functional-v9')").run();
    if (mode === 'revoked') f.revoke();
    if (mode === 'symlink-root') { renameSync(f.lockRoot, f.lockRoot + '-old'); symlinkSync(f.lockRoot + '-old', f.lockRoot); }
    const before = f.db.prepare('SELECT * FROM graph_actions ORDER BY effect_key').all();
    try { await expect(f.recover()).rejects.toThrow(['wrong-token', 'changed-expiry'].includes(mode) ? 'LOCK_OWNER' : undefined);
      expect(f.db.prepare('SELECT * FROM graph_actions ORDER BY effect_key').all()).toEqual(before);
      expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 0 });
      expect(f.run().status).toBe('cancel_pending');
      expect(f.db.prepare('SELECT released_at FROM graph_action_admissions WHERE effect_key=?').get(f.target.effect_key)).toEqual({ released_at: null });
    } finally { if (mode === 'symlink-root') { unlinkSync(f.lockRoot); renameSync(f.lockRoot + '-old', f.lockRoot); } }
  }, 120000);

it('does not acknowledge a lock that disappears during its first release attempt', async () => {
  const f = await fixture(); const original = GraphRecoveryStore.prototype.commit;
  vi.spyOn(GraphRecoveryStore.prototype, 'commit').mockImplementationOnce(function (this: GraphRecoveryStore, ...args) {
    const result = original.apply(this, args); unlinkSync(f.path); return result;
  });
  expect(await f.recover()).toMatchObject({ exit: 'release_pending', releaseError: expect.stringContaining('CHANGED') });
  expect(f.run().status).toBe('cancel_pending');
  expect(f.db.prepare('SELECT released_at FROM graph_action_admissions WHERE effect_key=?').get(f.target.effect_key)).toEqual({ released_at: null });
}, 120000);

it('retries a lost release ACK only for the same inspected token', async () => {
  const f = await fixture();
  vi.spyOn(GraphRecoveryStore.prototype, 'completeRelease').mockImplementationOnce(() => { throw Error('lost ACK'); });
  expect(await f.recover()).toMatchObject({ exit: 'release_pending' }); vi.restoreAllMocks();
  expect(await inspectRepoWriteLock(f.lockRoot, f.repoId)).toBeNull();
  writeFileSync(f.path, JSON.stringify({ ...f.lockOwner, token: randomUUID() }));
  await expect(f.recover()).rejects.toThrow('LOCK_OWNER'); unlinkSync(f.path);
  expect(await f.inspect()).toMatchObject({ mode: 'read_only', owner: f.lockOwner });
  expect(await f.recover()).toMatchObject({ result: { run: { status: 'cancelled' } } }); expect(f.writes()).toBe(1);
}, 120000);

it('requires guarded maintenance, closed admission, exact revision, backup and inspected owner', async () => {
  const f = await fixture(); const path = join(f.home, 'state.db'); await f.db.backup(path); chmodSync(path, 0o600);
  const scope = f.registration.scope;
  const config = { schemaVersion: 1, admissionEnabled: false, registration: { id: 'local', scope, repositoryRef: 'repo', repositoryPath: join(f.home, 'source'),
    taskRef: 'task', task: 'Set answer to 1', inputArtifactRef: 'input',
    writer: { agentId: 'deepseek-bounded-writer', capabilityId: 'deepseek-bounded-writer.writer' }, reviewer: { agentId: 'deepseek-bounded-reviewer', capabilityId: 'deepseek-bounded-reviewer.reviewer' },
    boundedMessages: { provider: 'deepseek', model: 'unused', files: ['answer'], acceptance: 'Answer must be 1' },
    acceptanceRegistry: f.registration.delivery.acceptanceRegistry, grant: { scope, expiresAt: 1, operations: ['read','cancel'] } } };
  const save = () => writeFileSync(join(f.home, 'graph-host.json'), JSON.stringify(config), { mode: 0o600 }); save();
  const input = { home: f.home, graphRunId: f.id, expectedRevision: f.run().revision, expectedDaemonPid: f.lockOwner.pid, expectedLockOwner: f.lockOwner };
  expect(await reconcileStoppedVerification(input)).toMatchObject({ mode: 'read_only', verification: { owner: f.lockOwner } });
  writeFileSync(join(f.home, 'control-plane-reserved.json'), '{}'); await expect(reconcileStoppedVerification(input)).rejects.toThrow(/RESERVED/); unlinkSync(join(f.home, 'control-plane-reserved.json'));
  config.admissionEnabled = true; save(); await expect(reconcileStoppedVerification(input)).rejects.toThrow('ADMISSION_MUST_BE_CLOSED'); config.admissionEnabled = false; save();
  await expect(reconcileStoppedVerification({ ...input, expectedRevision: input.expectedRevision - 1 })).rejects.toThrow('RUN_CHANGED');
  await expect(reconcileStoppedVerification({ ...input, apply: true })).rejects.toThrow('BACKUP_REQUIRED');
  writeFileSync(join(f.home, 'daemon.sock'), 'fixture');
  await expect(reconcileStoppedVerification({ ...input, apply: true, backupDirectory: f.home })).rejects.toThrow('DAEMON_MUST_STOP'); unlinkSync(join(f.home, 'daemon.sock'));
  const result = await reconcileStoppedVerification({ ...input, apply: true, backupDirectory: f.home });
  expect(result).toMatchObject({ mode: 'applied', status: 'cancelled', actionsUnchanged: true, upgradeHolds: 0 });
  expect(readFileSync(join(f.home, 'graph-host.json'), 'utf8')).toBe(JSON.stringify(config));
}, 120000);

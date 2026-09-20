import { acquireRepoWriteLock } from '@osstack/autonomy';
import { acquireLocalExecution } from './local-execution.js';
import { graphUpgradeHolds, assertGraphUpgradeSafe } from './graph-upgrade-guard.js';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { openDb, resolveRepositoryScope } from '@osstack/core';
import { GraphRpcService } from './graph-rpc.js';
import { graphRpcFixture } from './graph-test-fixture.js';

it('F12: restored SQLite snapshot and disabled admission retain unknown effects without replay or lock loss', async () => {
  const f = await graphRpcFixture('unknown');
  let restored: ReturnType<typeof openDb> | undefined; let host: GraphRpcService | undefined;
  try {
    const started = await f.start();
    const before = await f.until(started.graphRunId, s => s.status === 'reconciliation_required');
    const snapshot = join(f.root, 'backup.sqlite'); await f.db.backup(snapshot);
    const originalActions = f.db.prepare('SELECT effect_key,state FROM graph_actions ORDER BY effect_key').all();
    const held = f.db.prepare('SELECT * FROM graph_action_admissions WHERE released_at IS NULL').all();
    expect(held.length).toBeGreaterThan(0); expect(f.writes()).toBe(1);
    restored = openDb({ path: snapshot });
    expect(graphUpgradeHolds(restored)).toBeGreaterThan(0);
    await expect(assertGraphUpgradeSafe(snapshot)).rejects.toThrow("GRAPH_UPGRADE_REQUIRES_RECONCILIATION");
    host = new GraphRpcService({ ...f.options, db: restored, registrations: [{ ...f.registration, admitNewRuns: () => false }] });
    expect(await f.status(started.graphRunId, host)).toMatchObject({ status: before.status });
    expect(await host.handle(f.connection, 'graph.start', f.request)).toMatchObject({ graphRunId: started.graphRunId });
    await expect(host.handle(f.connection, 'graph.start', { ...f.request, idempotencyKey: 'new' })).rejects.toThrow('GRAPH_ADMISSION_DISABLED');
    await host.handle(f.connection, 'graph.cancel', { schemaVersion: 1, kind: 'cancel', scope: f.request.scope,
      graphRunId: started.graphRunId, expectedRevision: before.revision, idempotencyKey: 'cancel-backup' });
    const pending = await f.status(started.graphRunId, host);
    expect(['cancel_pending', 'reconciliation_required']).toContain(pending.status);
    await host.handle(f.connection, 'graph.reconcile', { schemaVersion: 1, kind: 'cancel', scope: f.request.scope,
      graphRunId: started.graphRunId, expectedRevision: pending.revision, idempotencyKey: 'reconcile-backup' });
    expect(restored.prepare('SELECT effect_key,state FROM graph_actions ORDER BY effect_key').all()).toEqual(originalActions);
    expect(restored.prepare('SELECT * FROM graph_action_admissions WHERE released_at IS NULL').all()).toEqual(held);
    expect(f.writes()).toBe(1);
    expect(await readFile(join(f.root, 'source', 'answer'), 'utf8')).toBe('0\n');
  } finally { await host?.close(); restored?.close(); await f.close(); }
}, 30000);

it('legacy foreground Loop admission cannot bypass a retained managed repository lock', async () => {
  const f = await graphRpcFixture(); const repo = join(f.root, 'source');
  const scope = await resolveRepositoryScope(repo);
  await mkdir(join(repo, '.osstack')); await writeFile(join(repo, '.osstack', 'policy.yaml'), 'schema_version: 1\nmode: execute\n');
  const lock = await acquireRepoWriteLock({ root_dir: join(scope.commonDir, 'osstack', 'writer-locks'), repo_id: scope.repoId,
    autonomy_run_id: 'graph:retained', recover_stale: false, pid: 123, now: () => '2000-01-01T00:00:00.000Z' });
  try {
    const before = await readFile(lock.path, 'utf8');
    await expect(acquireLocalExecution({ workspacePath: repo, runId: 'legacy-loop', dbPath: f.db.name,
      home: f.root, socketPath: join(f.root, 'absent.sock'), requiresAgent: false })).rejects.toMatchObject({ name: 'RepoLockBusyError' });
    expect(await readFile(lock.path, 'utf8')).toBe(before);
  } finally { await lock.release(); await f.close(); }
});

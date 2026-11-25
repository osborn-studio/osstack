import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { processGroupEmpty } from '@osstack/agents';
import { AttentionStore, ContainedMissionStore, DecisionQueries, openDb, RevisionChainStore } from '@osstack/core';
import { build } from 'esbuild';
import { expect, it, vi } from 'vitest';
import { listDecisions } from './decisions/list.js';
import { StoppedChainScanService } from './contained-mission-bridge-stopped-scan.js';
import { granted, setup, T0 } from './contained-mission-grant.testkit.js';
import { createGrantMissionView, RevisionGrantService } from './contained-mission-grant.js';
import { ContainedMissionHost } from './contained-mission-host.js';
import { createContainedMissionPorts, eventPayload } from './contained-mission-ports.js';

it('stops the executor group on daemon death and recovers the child for reconciliation without replaying the cancel', async () => {
  const f = await setup();
  const { root, path, missions, chains } = f.rig;
  const { chain } = await granted(f);
  const reserved = chains.reserve(chain.chain_id, chain.revision, { head: chain.published_head, review_ids: [1], feedback_digest: 'd'.repeat(64) }, T0);
  const child = missions.authorize(f.rig.principal, { scope_id: f.scope, spec: { goal: 'child' },
    claim: { repo_identity: 'repo', branch: 'child', worktree_identity: 'child' } }, T0);
  const dispatched = chains.dispatch(chain.chain_id, reserved.chain.revision, chain.published_head, child.mission_id, T0).chain;
  const request = { chain_id: chain.chain_id, expected_revision: dispatched.revision, decision_id: 'close:1', decision: 'abandon' } as const;
  const ready = missions.transition(child.mission_id, { if_revision: child.revision, to: 'workspace_ready', event: { kind: 'workspace_created', payload: {} } }, T0);
  missions.transition(child.mission_id, { if_revision: ready.revision, to: 'executing', expected_head: chain.published_head, event: { kind: 'executor_start', payload: {} } }, T0);

  const terminationGraceMs = 250;
  const worktree = join(root, 'worktree');
  mkdirSync(worktree);
  const bin = join(root, 'fake-codex.cjs');
  writeFileSync(bin, `#!${process.execPath}
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const member = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    member.once('spawn', () => writeFileSync('ready', JSON.stringify([process.pid, member.pid])));
    setInterval(() => {}, 1000);
  `, { mode: 0o755 });

  const worker = join(root, 'answer.mjs');
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
  await build({ stdin: { resolveDir: resolve('src'), contents: `
    import { existsSync, writeSync } from 'node:fs';
    import { join } from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';
    import { CodexProxyExecutor } from '@osstack/agents';
    import { AttentionStore, ContainedMissionStore, RevisionChainStore, openDb } from '@osstack/core';
    import { createGrantMissionView, RevisionGrantService } from './contained-mission-grant.js';
    const [path, actor, request, childId, bin, worktree, root, graceMs] = process.argv.slice(2);
    const db = openDb({ path }); db.pragma('synchronous=FULL');
    const attention = new AttentionStore(db, path);
    const owner = attention.claimOwner('answer');
    const chains = new RevisionChainStore(attention, owner);
    const store = new ContainedMissionStore(attention, owner);
    const missions = await createGrantMissionView(store);
    const executor = new CodexProxyExecutor({ bin, sourceCodexHome: root, runtimeDir: join(root, 'runtime'), terminationGraceMs: Number(graceMs) });
    let pgid;
    void executor.run({ worktree, prompt: 'p', onLaunched: launch => {
      store.record(childId, 'executor_started', { pid: launch.pid, pgid: launch.pgid }, Date.now());
      pgid = launch.pgid;
    } });
    while (!existsSync(join(worktree, 'ready'))) await delay(10);
    writeSync(1, String(pgid));
    // The first child-state read is after the transaction returns and before the host cancel.
    missions.state = () => process.kill(process.pid, 'SIGKILL');
    await new RevisionGrantService({ chains, missions, now: Date.now, enabled: () => true })
      .chainDecide(JSON.parse(actor), JSON.parse(request));
  ` }, outfile: worker, bundle: true, packages: 'external', platform: 'node', format: 'esm' });

  const death = spawnSync(process.execPath, [worker, path, JSON.stringify(f.actor('a')), JSON.stringify(request),
    child.mission_id, bin, worktree, root, String(terminationGraceMs)], { encoding: 'utf8', timeout: 10000 });
  const pgid = Number(death.stdout);
  let groupObservedEmpty = false;
  try {
    expect(death.signal, death.stderr).toBe('SIGKILL');
    expect(pgid).toBeGreaterThan(1);
    // W13-E1 stops the orphaned executor group before restart recovery observes it.
    await expect.poll(() => processGroupEmpty(pgid), { timeout: terminationGraceMs + 2000 }).toBe(true);
    groupObservedEmpty = true;
    const db = openDb({ path });
    try {
      db.pragma('synchronous=FULL');
      const attention = new AttentionStore(db, path);
      const owner = attention.claimOwner('restart');
      const restarted = new RevisionChainStore(attention, owner);
      const store = new ContainedMissionStore(attention, owner);
      expect(restarted.get(chain.chain_id).state).toBe('closed');
      expect(restarted.events(chain.chain_id).filter(e => e.kind.startsWith('chain_answer_')).map(e => e.kind)).toEqual(['chain_answer_accepted']);
      const cancelChild = vi.fn(async () => {});
      const grantService = new RevisionGrantService({ chains: restarted, missions: await createGrantMissionView(store),
        access: f.access, registry: { repository: 'o/r', publisher: [] }, readPr: async () => { throw Error('unexpected_read'); },
        compare: f.compare, loadIssuer: async () => undefined, enabled: () => true, protectedSetDigest: () => '', now: Date.now, cancelChild });
      const ports = createContainedMissionPorts({ store, now: Date.now, hostProcess: { markerDir: join(root, 'markers') },
        runtimeRoot: root, codex: { bin: 'unused', sourceCodexHome: root },
        verification: { socketPath: join(root, 'docker.sock'), daemonId: 'test', baseImageId: 'sha256:' + '0'.repeat(64), journalRoot: root },
        author: { name: 'test', email: 'test@example.invalid' } });
      const host = new ContainedMissionHost({ ports, worktreesRoot: root });
      const scan = new StoppedChainScanService({ chains: restarted, enabled: () => true, now: Date.now,
        missionState: id => store.get(id).state, refreshPrincipal: () => f.actor('a'), cancelChild,
        readPr: async () => { throw Error('unexpected_read'); }, log: () => {} });
      try {
        await host.recover();
        await scan.scan();
        expect(await grantService.chainDecide(f.actor('a'), request)).toMatchObject({ state: 'closed', child_cancel: 'unknown', replay: true });
        expect(cancelChild).not.toHaveBeenCalled();
        expect(store.get(child.mission_id)).toMatchObject({ state: 'needs_reconciliation', stop_obligation: 0 });
        const events = store.events(child.mission_id);
        expect(events.filter(e => e.kind === 'executor_stopped').map(eventPayload)).toContainEqual(
          expect.objectContaining({ stop_proof: 'group_empty_after_restart', pgid }));
        expect(events.filter(e => e.kind === 'halted').map(eventPayload).at(-1)).toMatchObject({ reason: 'orphaned_executing' });
        const page = await listDecisions(new DecisionQueries(db), { credential: 'a'.repeat(48) }, token => f.access.authenticate(token));
        const item = page.items.find(i => i.source === 'contained_mission' && i.source_id === child.mission_id);
        expect(item?.allowed_answers).toEqual(['abandon', 'discard_changes', 'adopt_worktree']);
      } finally { await scan.stop(); await host.close(); }
    } finally { db.close(); }
  } finally {
    // The worker can fail before reporting the journalled launch on stdout.
    const launch = missions.events(child.mission_id).find(e => e.kind === 'executor_started');
    const group = pgid || (launch && eventPayload(launch).pgid);
    if (!groupObservedEmpty && typeof group === 'number' && Number.isSafeInteger(group) && group > 1) {
      try { process.kill(-group, 'SIGKILL'); } catch {
        // Best-effort cleanup of a group not yet observed empty.
      }
    }
  }
});

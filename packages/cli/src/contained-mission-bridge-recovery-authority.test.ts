import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { AttentionStore, ContainedMissionStore, HostProcessStore, RevisionChainStore } from '@osstack/core';
import { expect, it } from 'vitest';
import { dispatched, setup } from './contained-mission-revision.testkit.js';
import { createRevisionReceiptRecovery, type RevisionReceiptDeps } from './contained-mission-revision-publication.js';

const oldHead = '1'.repeat(40);
const newHead = '2'.repeat(40);

// Use the real Mission FSM, signed dispatch, SQLite stores and stopped W13 journal.
// Only remote facts are supplied locally. Recovery has no runner or App writer.
async function pendingReceipt() {
  const f = setup({ head: oldHead });
  const { child_mission_id: childId } = await dispatched(f);
  const { missions, chains } = f.rig;
  let child = missions.get(childId);
  const step = (to: Parameters<typeof missions.transition>[1]['to'], extra: Record<string, unknown> = {}) => {
    child = missions.transition(childId, { if_revision: child.revision, to,
      event: { kind: `to_${to}`, payload: {} }, ...extra }, ++f.clock.now);
  };
  step('workspace_ready'); step('executing', { expected_head: oldHead });
  child = missions.recordStopEvidence(childId, child.revision, { stop_proof: 'test' }, ++f.clock.now);
  step('candidate_ready', { candidate: { head: newHead, tree: '3'.repeat(40), diff_digest: '4'.repeat(64) } });
  step('verifying');
  child = missions.recordStopEvidence(childId, child.revision, { stop_proof: 'test' }, ++f.clock.now);
  missions.record(childId, 'verify_receipt', { candidate: newHead, exit_code: 0, evidence: 'verified', cancelled: false }, ++f.clock.now);
  missions.record(childId, 'candidate_committed', { head_commit: newHead, tier: 'T0', chain_tier: 'T0' }, ++f.clock.now);
  step('verified'); step('revalidating'); step('delivering');
  const chain = chains.get(f.chain.chain_id);
  const { intent } = chains.recordIntent(chain.chain_id, chain.revision, { kind: 'push', branch: chain.branch,
    expected_old_head: oldHead, new_head: newHead, expected_base_sha: chain.published_base, child_mission_id: childId }, ++f.clock.now);
  chains.appendEvent(chain.chain_id, 'push_range', { intent_id: intent.intent_id, commits: [newHead] }, ++f.clock.now);
  const journal = new HostProcessStore(f.rig.attention, f.rig.owner, { clock: () => ++f.clock.now });
  const opId = 'hp_recoveryboundaries';
  journal.launching({ op_id: opId, mission_id: childId, kind: 'git_push', remote_target: 'o/r#refs/heads/topic',
    local_target: `${f.childSpec(childId).worktree_path}#refs/heads/topic`, intent_id: intent.intent_id,
    argv_digest: '5'.repeat(64), boot_id: 'test', marker: { path: `${f.rig.root}/marker`, dev: '1', ino: '1' } });
  journal.registered(opId, { pid: 12345, pgid: 12345, leader_start: 'test' });
  journal.release(opId, () => {});
  journal.stopped(opId, { proof: 'group_empty+marker_unheld', detail: {}, exit_code: 0 });
  const deps: RevisionReceiptDeps = {
    chains, missions, now: () => ++f.clock.now, checkEnabled: true,
    host: { recordForIntent: id => id === intent.intent_id ? journal.get(opId) : undefined },
    remoteHead: async () => newHead, localGit: async () => ({ stdout: '', exitCode: 0 }),
    compare: async () => [newHead],
    readPr: async () => ({ state: 'OPEN', repository: 'o/r', headRefName: 'topic', headRefOid: newHead,
      baseRefName: 'main', baseRefOid: chain.published_base, url: 'https://example.invalid/pull/7' }),
  };
  const snapshot = () => ({
    intent: chains.getIntent(intent.intent_id).state,
    chain: chains.get(chain.chain_id).state,
    child: missions.get(childId).state,
    head: chains.get(chain.chain_id).published_head,
    published: chains.events(chain.chain_id).filter(event => event.kind === 'round_published').length,
  });
  return { f, deps, snapshot, intent, childId, opId };
}

// A real SQLite trace releases B only when A attempts BEGIN IMMEDIATE. A's
// pre-transaction reads therefore see pending, but its locked reads see B's commit.
// No store method is replaced and no timer decides which writer wins.
it('revalidates a successful receipt after waiting for another writer at the confirmation lock', async () => {
  const { f, deps, snapshot, intent, childId, opId } = await pendingReceipt();
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const ready = join(f.rig.root, 'writer-ready');
  const release = join(f.rig.root, 'writer-release');
  const script = join(f.rig.root, 'writer.mjs');
  const config = join(f.rig.root, 'writer.json');
  writeFileSync(config, JSON.stringify({ repo, path: f.rig.path, owner: f.rig.owner, opId,
    now: f.clock.now, ready, release, childId, chainId: intent.chain_id, intentId: intent.intent_id,
    revision: deps.missions.get(childId).revision, oldHead, newHead }));
  writeFileSync(script, `
import { registerHooks, createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { transformSync } = createRequire(resolve(cfg.repo, 'package.json'))('esbuild');
const aliases = new Map();
for (const directory of readdirSync(resolve(cfg.repo, 'packages'))) {
  const manifest = resolve(cfg.repo, 'packages', directory, 'package.json');
  if (!existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  aliases.set(pkg.name, resolve(dirname(manifest), 'src/index.ts'));
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    if (key.includes('*') || key === '.' || !value) continue;
    const target = typeof value === 'string' ? value : value.import ?? value.default;
    if (typeof target !== 'string' || !target.startsWith('./dist/') || !target.endsWith('.js')) continue;
    const source = resolve(dirname(manifest), 'src', target.slice(7, -3) + '.ts');
    if (existsSync(source)) aliases.set(pkg.name + key.slice(1), source);
  }
}
registerHooks({
  resolve(specifier, context, next) {
    if (aliases.has(specifier)) return { url: pathToFileURL(aliases.get(specifier)).href, shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const target = fileURLToPath(new URL(specifier, context.parentURL)).replace(/\\.js$/, '.ts');
      if (target.startsWith(cfg.repo + '/') && existsSync(target)) return { url: pathToFileURL(target).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.ts') && fileURLToPath(url).startsWith(cfg.repo + '/')) {
      return { format: 'module', source: transformSync(readFileSync(new URL(url), 'utf8'), { loader: 'ts', format: 'esm', target: 'node22' }).code, shortCircuit: true };
    }
    return next(url, context);
  }
});
const core = await import(pathToFileURL(resolve(cfg.repo, 'packages/core/src/index.ts')).href);
const { confirmRevisionPublication } = await import(pathToFileURL(resolve(cfg.repo, 'packages/cli/src/contained-mission-revision-publication.ts')).href);
const db = core.openDb({ path: cfg.path }); db.pragma('synchronous=FULL');
const attention = new core.AttentionStore(db, cfg.path);
const chains = new core.RevisionChainStore(attention, cfg.owner);
const missions = new core.ContainedMissionStore(attention, cfg.owner);
const journal = new core.HostProcessStore(attention, cfg.owner);
let now = cfg.now;
try {
  chains.transaction(() => {
    writeFileSync(cfg.ready, 'locked');
    process.send({ locked: true });
    const deadline = Date.now() + 5000;
    while (!existsSync(cfg.release)) {
      if (Date.now() >= deadline) throw Error('writer_release_missing');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    confirmRevisionPublication({ chains, missions, host: { recordForIntent: () => journal.get(cfg.opId) }, now: () => ++now, checkEnabled: true }, {
      chain_id: cfg.chainId, intent_id: cfg.intentId, child_mission_id: cfg.childId, permit_revision: cfg.revision,
      evidence: { evidence_digest: '6'.repeat(64), head: cfg.newHead, repository: 'o/r' },
      pr: { number: 7, url: 'https://example.invalid/pull/7', reused: true }, range_sha256: '7'.repeat(64)
    });
  });
} finally { db.close(); }
`);
  let beginObserved = false;
  const db = new Database(f.rig.path, { verbose: sql => {
    if (sql === 'BEGIN IMMEDIATE') { beginObserved = true; writeFileSync(release, 'confirm'); }
  } });
  db.pragma('synchronous=FULL'); db.pragma('foreign_keys=ON');
  const attention = new AttentionStore(db, f.rig.path);
  const chains = new RevisionChainStore(attention, f.rig.owner);
  const missions = new ContainedMissionStore(attention, f.rig.owner);
  const child = spawn(process.execPath, [script, config], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const exited = new Promise<number | null>((done, reject) => { child.once('exit', done); child.once('error', reject); });
  const locked = new Promise<void>(done => { child.once('message', () => done()); });
  let failure: unknown;
  try {
    await Promise.race([locked, exited.then(() => { throw Error(stderr || 'writer_exited_before_lock'); })]);
    expect(existsSync(ready)).toBe(true);
    expect(readFileSync(ready, 'utf8')).toBe('locked');
    try { await createRevisionReceiptRecovery({ ...deps, chains, missions }).recoverPendingReceipts(); }
    catch (error) { failure = error; }
    expect(await exited, stderr).toBe(0);
    expect(beginObserved).toBe(true);
    expect(snapshot()).toEqual({ intent: 'confirmed', chain: 'awaiting_review', child: 'pr_opened', head: newHead, published: 1 });
    expect(failure).toBeUndefined();
  } finally {
    writeFileSync(release, 'cleanup');
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited.catch(() => undefined);
    db.close();
  }
});

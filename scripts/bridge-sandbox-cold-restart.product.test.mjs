// Explicit inactive installed prefix only. No build, serving home, real credentials, or external command.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { runSandboxColdRestart } from './lib/bridge-sandbox-cold-restart.mjs';

const selectedPrefix = process.env.OSSTACK_COLD_PRODUCT_RUNTIME_PREFIX;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sandbox = 'osborn-studio/osstack-bridge-sandbox';
const head = '1'.repeat(40), base = '2'.repeat(40);

async function fixture(t, initialState) {
  const scratchPrefix = process.env.OSSTACK_SCRATCH_ROOT ?? join(tmpdir(), 'osstack');
  await mkdir(scratchPrefix, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(await realpath(scratchPrefix), 'cold-product-'));
  const oldEnv = Object.fromEntries(['OSSTACK_HOME', 'OSSTACK_SCRATCH_ROOT', 'PATH'].map(key => [key, process.env[key]]));
  let db, parentHost, parentBridge;
  let checkFrozen = async () => {};
  t.after(async () => {
    try {
      const failures = [];
      for (const stop of [() => parentBridge?.checkRetry?.stop(), () => parentBridge?.live.stop(), () => parentBridge?.stoppedScan.stop(), () => parentHost?.close(), () => db?.close(), checkFrozen]) {
        try { await stop(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'product_fixture_cleanup_failed');
    } finally {
      for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(root, { recursive: true, force: true });
    }
  });
  const home = join(root, 'home'), repo = join(root, 'repository'), worktrees = join(root, 'worktrees'), bins = join(root, 'bin');
  for (const dir of [home, repo, worktrees, bins, join(home, 'bridge'), join(root, 'codex-home')]) await mkdir(dir, { mode: 0o700 });
  // Any accidental gh/git/Docker/Codex command fails locally before egress or real execution.
  const commandTrace = join(root, 'unexpected-command');
  for (const name of ['gh', 'git', 'docker', 'codex']) await writeFile(join(bins, name), `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${commandTrace}'\nexit 99\n`, { mode: 0o700 });
  process.env.PATH = bins; process.env.OSSTACK_HOME = home; process.env.OSSTACK_SCRATCH_ROOT = root;
  const runtimePrefix = await realpath(selectedPrefix);
  const corePath = join(runtimePrefix, 'lib/node_modules/@osstack/core/dist/index.js');
  const runtimePath = join(runtimePrefix, 'lib/node_modules/@osstack/cli/dist/bridge-production.js');
  const manifestPath = join(runtimePrefix, 'candidate-manifest.json');
  const manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.kind, 'unactivated-local-candidate');
  assert.match(manifest.source_commit, /^[a-f0-9]{40}$/);
  const modules = { core: { path: corePath, sha256: hash(await readFile(corePath)) }, runtime: { path: runtimePath, sha256: hash(await readFile(runtimePath)) } };
  checkFrozen = async () => {
    assert.equal(hash(await readFile(corePath)), modules.core.sha256); assert.equal(hash(await readFile(runtimePath)), modules.runtime.sha256);
    assert.equal(hash(await readFile(manifestPath)), hash(manifestBytes));
    await assert.rejects(readFile(commandTrace), { code: 'ENOENT' });
  };
  const core = await import(pathToFileURL(corePath).href);
  const runtime = await import(pathToFileURL(runtimePath).href);
  const dbPath = join(home, 'control.db'); db = core.openDb({ path: dbPath }); await chmod(dbPath, 0o600);
  db.pragma('synchronous=FULL');
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('product','local cold probe','running',1,1)");
  const attention = new core.AttentionStore(db, dbPath), owner = attention.claimOwner(`product-parent-${process.pid}`);
  const scope = attention.registerScope(owner, 'product', repo);
  const missions = new core.ContainedMissionStore(attention, owner), chains = new core.RevisionChainStore(attention, owner);
  const principal = { principal_id: 'product', client_session_id: 'local', read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [scope.scope_id], operator_scopes: [scope.scope_id] };
  const privateJson = (path, data) => writeFile(path, JSON.stringify(data), { mode: 0o600 });
  const authorityPath = join(home, 'authority.json');
  await privateJson(authorityPath, { version: 1, principals: [{ ...principal, credential_sha256: '3'.repeat(64) }] });
  const keyPath = join(root, 'noncredential.pem');
  await writeFile(keyPath, 'NOT A PRIVATE KEY: local constructor fixture only', { mode: 0o600 });
  const publisher = { app_id: 11, installation_id: 12, private_key_path: keyPath };
  const evidence = { app_id: 21, installation_id: 22, private_key_path: keyPath };
  const config = { repository: sandbox, publisher, evidence, mission_ruleset_ids: [1] };
  await privateJson(join(home, 'bridge/apps.json'), { version: 1, repository: sandbox, publisher, evidence });
  await privateJson(join(home, 'bridge/rulesets.json'), { version: 1, repository: sandbox, mission_ruleset_ids: [1] });
  await privateJson(join(home, 'bridge/producers.json'), { version: 1, repository: sandbox, publisher: [{ actor_id: 31, app_id: 11 }], reviewers: [{ actor_id: 41, app_id: 42 }] });
  const { publicKey } = generateKeyPairSync('ed25519');
  await privateJson(join(home, 'bridge/revision-issuer.json'), { version: 1, keys: [{ key_id: 'local',
    public_key_spki_b64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), max_validity_ms: 86_400_000 }] });
  let now = 1000;
  const branch = 'osstack/mission/product-root';
  const spec = { goal: 'local store fixture', repo_path: repo, base_ref: 'main', start_commit: base, branch,
    worktree_path: join(worktrees, 'root'), allowed_paths: ['src/**'], verify: { argv: ['never-run'] }, verification_paths: [], max_repair_cycles: 0 };
  const publication = { remote: 'origin', repository: sandbox, base: 'main', draft: true };
  const rootMission = missions.authorize(principal, { scope_id: scope.scope_id, spec: { ...spec, publication },
    claim: { repo_identity: 'root', branch, worktree_identity: spec.worktree_path } }, ++now);
  const transition = (id, to, extra = {}) => missions.transition(id, { if_revision: missions.get(id).revision, to, event: { kind: `to_${to}`, payload: {} }, ...extra }, ++now);
  transition(rootMission.mission_id, 'workspace_ready'); transition(rootMission.mission_id, 'executing', { expected_head: base });
  missions.recordStopEvidence(rootMission.mission_id, missions.get(rootMission.mission_id).revision, { stop_proof: 'fixture_no_launch' }, ++now);
  transition(rootMission.mission_id, 'candidate_ready', { candidate: { head, tree: head, diff_digest: '4'.repeat(64) } });
  transition(rootMission.mission_id, 'verifying');
  missions.recordStopEvidence(rootMission.mission_id, missions.get(rootMission.mission_id).revision, { stop_proof: 'fixture_no_launch' }, ++now);
  for (const state of ['verified', 'revalidating', 'delivering', 'pr_opened']) transition(rootMission.mission_id, state);
  missions.releaseClaim(rootMission.mission_id, 'local_fixture', ++now);
  let chain = chains.createLiveChain({ root_mission_id: rootMission.mission_id, repository: sandbox, pr_number: 7, branch, base_ref: 'main',
    published_head: head, published_base: base, trace_id: 'local', grant: { rounds: 2 } }, ++now);
  const childSpec = { ...spec, branch: 'osstack/mission/product-child', worktree_path: join(worktrees, 'child'), publication,
    publish_target: { chain_id: chain.chain_id, remote_branch: branch } };
  const child = missions.authorize(principal, { scope_id: scope.scope_id, spec: childSpec,
    claim: { repo_identity: 'child', branch: childSpec.branch, worktree_identity: childSpec.worktree_path } }, ++now);
  chain = chains.reserve(chain.chain_id, chain.revision, { head, review_ids: [7], feedback_digest: '5'.repeat(64) }, ++now).chain;
  chain = chains.dispatch(chain.chain_id, chain.revision, head, child.mission_id, ++now).chain;
  transition(child.mission_id, 'cancel_requested');
  if (initialState === 'cancelled') transition(child.mission_id, 'cancelled');
  // Closed chain + no receipts avoids all production GitHub ledger reads. No trigger is disabled.
  chain = chains.closeLive(chain.chain_id, chain.revision, 'abandoned', ++now);
  assert.equal(missions.get(child.mission_id).state, initialState);
  assert.equal(missions.claim(child.mission_id).state, 'active');
  const descriptor = { version: 1, repository: sandbox, repositoryId: 1446327922, scratchPrefix: await realpath(scratchPrefix), runRoot: root,
    runtimePrefix, home, dbPath, authorityPath, repositoryPath: repo, worktreesRoot: worktrees, scopeId: scope.scope_id,
    chainId: chain.chain_id, childMissionId: child.mission_id, expectedBranch: branch, expectedHead: head, modules,
    handoff: { parentPid: process.pid, servicesStopped: true, hostClosed: true, databaseClosed: true, previousOwner: owner },
    ports: { runtimeRoot: join(root, 'runtime'), markerDir: join(home, 'markers'), journalRoot: join(home, 'verification'),
      codex: { bin: await realpath(process.execPath), sourceCodexHome: join(root, 'codex-home'), model: 'gpt-6.1-sol' },
      verification: { socketPath: join(root, 'absent-docker.sock'), daemonId: 'local-not-docker', baseImageId: 'sha256:' + '6'.repeat(64) }, bridgeConfig: config },
    launchCaps: { executor_seconds: 600, verify_seconds: 120 } };
  const inode = (await lstat(dbPath)).ino;
  db.close(); db = undefined;
  const reopen = async () => {
    db?.close();
    db = core.openDb({ path: dbPath });
    db.pragma('synchronous=FULL');
    assert.equal((await lstat(dbPath)).ino, inode);
    return db;
  };
  const rebuildParent = async () => {
    await reopen();
    const attention = new core.AttentionStore(db, dbPath), nextOwner = attention.claimOwner(`product-reopened-${process.pid}`);
    const store = new core.ContainedMissionStore(attention, nextOwner), chains = new core.RevisionChainStore(attention, nextOwner);
    const ports = runtime.createContainedMissionPorts({ store, now: Date.now, runtimeRoot: descriptor.ports.runtimeRoot,
      codex: descriptor.ports.codex, verification: { ...descriptor.ports.verification, journalRoot: descriptor.ports.journalRoot },
      hostProcess: { markerDir: descriptor.ports.markerDir }, author: { name: 'Local Fixture', email: 'local@example.invalid' }, bridge: { config } });
    const access = new runtime.EngineeringAccess(authorityPath);
    parentHost = new runtime.ContainedMissionHost({ ports, worktreesRoot: worktrees });
    parentBridge = await runtime.createProductionLiveBridge({ home, chains, missions: store, ports, host: parentHost, access, enabled: () => false,
      now: Date.now, log: () => {}, launchCaps: descriptor.launchCaps });
    return { owner: nextOwner, store, access, host: parentHost, bridge: parentBridge };
  };
  return { descriptor, owner, reopen, rebuildParent, core, commandTrace, manifestBytes, assertFrozen: checkFrozen };
}

test('installed product host releases a cancelled claim in a fresh PID; parent reclaims and rebuilds real runtime', { skip: !selectedPrefix }, async t => {
  const f = await fixture(t, 'cancelled');
  const result = await runSandboxColdRestart(f.descriptor);
  assert.notEqual(result.childPid, process.pid); assert.equal(result.exitCode, 0);
  assert.equal(result.readback.owner.generation, f.owner.generation + 1);
  const parent = await f.rebuildParent();
  assert.equal(parent.owner.generation, f.owner.generation + 2); assert.equal(parent.owner.home_id, f.owner.home_id);
  assert.equal(parent.store.get(f.descriptor.childMissionId).state, 'cancelled');
  assert.equal(parent.store.claim(f.descriptor.childMissionId).state, 'released');
  assert.equal(parent.access.refresh('product', 'local').principal_id, 'product');
  await f.assertFrozen();
  t.diagnostic(JSON.stringify({ parentPid: process.pid, childPid: result.childPid, exitCode: result.exitCode,
    childGeneration: result.readback.owner.generation, reopenedParentGeneration: parent.owner.generation,
    sourceCommit: JSON.parse(f.manifestBytes).source_commit, runtimeSha256: f.descriptor.modules.runtime.sha256, coreSha256: f.descriptor.modules.core.sha256 }));
});

test('real NORMAL connection refuses recovery writes; durable cancel_requested recovery needs a terminal-claim pass', { skip: !selectedPrefix }, async t => {
  const f = await fixture(t, 'cancel_requested');
  let failure;
  await assert.rejects(runSandboxColdRestart(f.descriptor), error => { failure = error; return error.message === 'COLD_WORKER_FAILED'; });
  const db = await f.reopen();
  const mission = db.prepare('SELECT state,stop_obligation FROM engineering_contained_missions WHERE mission_id=?').get(f.descriptor.childMissionId);
  const claim = db.prepare('SELECT state FROM engineering_workspace_claims WHERE mission_id=?').get(f.descriptor.childMissionId);
  assert.deepEqual(mission, { state: 'cancel_requested', stop_obligation: 0 }); assert.equal(claim.state, 'active');
  const attention = new f.core.AttentionStore(db, f.descriptor.dbPath);
  const owner = db.prepare('SELECT home_id,instance_id,generation FROM daemon_owner WHERE singleton=1').get();
  assert.equal(owner.home_id, f.owner.home_id); assert.equal(owner.generation, f.owner.generation + 1);
  assert.match(owner.instance_id, new RegExp(`^sandbox-cold-${failure.evidence.childPid}-`));
  const store = new f.core.ContainedMissionStore(attention, owner);
  db.pragma('synchronous=NORMAL');
  assert.throws(() => store.record(f.descriptor.childMissionId, 'must_not_write', {}, Date.now()), /durability_required/);
  db.pragma('synchronous=FULL');
  const parent = await f.rebuildParent();
  assert.equal(parent.owner.generation, f.owner.generation + 2);
  assert.equal(parent.access.refresh('product', 'local').principal_id, 'product');
  await parent.host.recover();
  assert.equal(parent.store.get(f.descriptor.childMissionId).state, 'cancelled');
  assert.equal(parent.store.claim(f.descriptor.childMissionId).state, 'active');
  await parent.host.tick();
  assert.equal(parent.store.claim(f.descriptor.childMissionId).state, 'active');
  await parent.host.recover();
  assert.equal(parent.store.claim(f.descriptor.childMissionId).state, 'released');
  await f.assertFrozen();
});

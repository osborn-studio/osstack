import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runSandboxColdRestart, recoverCancelledSandboxMission } from './lib/bridge-sandbox-cold-restart.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const head = 'a'.repeat(40), scope = 'b'.repeat(64);
const coreSource = `
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
let file, data;
const save=()=>writeFileSync(file,JSON.stringify(data));
const trace=(x)=>appendFileSync(file+'.trace',JSON.stringify({event:x,pid:process.pid})+'\\n');
export function openDb({path}) {file=path;data=JSON.parse(readFileSync(path));trace('open');return {
 pragma(sql){if(sql==='synchronous=FULL'){trace('durability.full');return [];}if(sql==='synchronous')return 2;throw Error('unknown pragma');},
 prepare(sql){return {all(){
 if(sql.includes('engineering_contained_missions'))return data.missions;
 if(sql.includes('engineering_revision_chains'))return data.chains;
 if(sql.includes('engineering_publication_intents'))return data.intents;
 if(sql.includes('engineering_contained_events'))return data.events;
 if(sql.includes('engineering_host_processes'))return [];
 throw Error('unknown query');},get(){if(sql.includes('daemon_owner'))return data.owner;throw Error('unknown get');}};},
 exec(){trace('guards');},close(){trace('db.close');save();}};}
export class AttentionStore {constructor(db,path){this.db=db;this.path=path;}
 claimOwner(instance_id){data.owner={...data.owner,instance_id,generation:data.owner.generation+1};save();trace('claim');return data.owner;}
 getScope(id){return data.scope;}}
export class ContainedMissionStore {constructor(attention,owner){this.db=attention.db;this.attention=attention;this.owner=owner;}
 get(id){return data.missions.find(x=>x.mission_id===id);}
 listOutstanding(){return data.missions.filter(x=>x.state==='cancel_requested').map(x=>({mission_id:x.mission_id}));}
 claim(){return {state:data.claimState??'released'};}}
export class RevisionChainStore {constructor(attention,owner){this.db=attention.db;}
 get(id){return data.chains.find(x=>x.chain_id===id);}intents(id){return data.intents.filter(x=>x.chain_id===id);}}
`;
function runtimeSource(mode = 'ok') {
  return `
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
let store;
const trace=x=>appendFileSync(store.attention.path+'.trace',JSON.stringify({event:x,pid:process.pid})+'\\n');
export function createContainedMissionPorts(options){store=options.store;return {...options,revisionLaunchCaps:{executor_seconds:600,verify_seconds:120}};}
export class EngineeringAccess {constructor(path){JSON.parse(readFileSync(path));}}
export class ContainedMissionHost {constructor({ports}){store=ports.store;trace('host.new');}
 async recover(){trace('host.recover');${mode === 'hang' ? "await new Promise(()=>{setInterval(()=>{},1000);});" : ''}
 ${mode === 'resist' ? "process.on('SIGTERM',()=>{});await new Promise(()=>{setInterval(()=>{},1000);});" : ''}
 ${mode === 'noisy' ? "process.stdout.write('sensitive output'.repeat(5000));await new Promise(()=>{setInterval(()=>{},1000);});" : ''}
 ${mode === 'fail' ? "throw Error('secret-runtime-error-DO-NOT-EXPOSE');" : ''}
 ${mode === 'settle' || mode === 'confirm' ? `store.db.prepare('SELECT * FROM engineering_publication_intents').all()[0].state='${mode === 'settle' ? 'failed' : 'confirmed'}';` : ''}
 const path=store.attention.path,d=JSON.parse(readFileSync(path));d.missions.find(x=>x.mission_id==='cm_child').state='cancelled';writeFileSync(path,JSON.stringify(d));store.get('cm_child').state='cancelled';}
 async tick(){trace('host.tick');${mode === 'publish' ? "store.get('cm_child').state='pr_opened';" : ''}}
 async close(){trace('host.close');${mode === 'closeFail' ? "throw Error('private cleanup detail');" : ''}}}
export async function createProductionLiveBridge(){trace('bridge.new');return {
 revisionRecovery:async()=>trace('revision.recover'),
 live:{stop:async()=>trace('live.stop')},stoppedScan:{stop:async()=>trace('scan.stop')},checkRetry:{stop:async()=>trace('checks.stop')}};}
`;
}

async function fixture(t, mode = 'ok') {
  await mkdir(process.env.OSSTACK_SCRATCH_ROOT ?? join(tmpdir(), 'osstack'), { recursive: true, mode: 0o700 });
  const prefix = await realpath(process.env.OSSTACK_SCRATCH_ROOT ?? join(tmpdir(), 'osstack'));
  const runRoot = await mkdtemp(join(prefix, 'cold-restart-test-')); await chmod(runRoot, 0o700);
  t.after(() => rm(runRoot, { recursive: true, force: true }));
  const home = join(runRoot, 'home'), runtimePrefix = join(runRoot, 'modules'), worktreesRoot = join(runRoot, 'worktrees');
  for (const dir of [home, runtimePrefix, worktreesRoot, join(runRoot, 'repository'), join(home, 'bridge'), join(runRoot, 'codex-home')]) await mkdir(dir, { mode: 0o700 });
  const privateJson = (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  const app = { app_id: 11, installation_id: 12, private_key_path: join(runRoot, 'app.pem') };
  await writeFile(app.private_key_path, 'fake key reference only', { mode: 0o600 });
  const config = { repository: 'osborn-studio/osstack-bridge-sandbox', publisher: app, evidence: app, mission_ruleset_ids: [1] };
  await privateJson(join(home, 'bridge/apps.json'), { version: 1, repository: config.repository, publisher: app, evidence: app });
  await privateJson(join(home, 'bridge/rulesets.json'), { version: 1, repository: config.repository, mission_ruleset_ids: [1] });
  await privateJson(join(home, 'bridge/producers.json'), { version: 1, repository: config.repository });
  await privateJson(join(home, 'bridge/revision-issuer.json'), { version: 1, keys: [] });
  const authorityPath = join(home, 'authority.json'); await privateJson(authorityPath, { version: 1, principals: [] });
  const corePath = join(runtimePrefix, 'core.mjs'), runtimePath = join(runtimePrefix, 'runtime.mjs');
  await writeFile(corePath, coreSource); await writeFile(runtimePath, runtimeSource(mode));
  const previousOwner = { home_id: 'private-home', instance_id: 'old-parent', generation: 4 };
  const descriptor = { version: 1, repository: config.repository, repositoryId: 1446327922,
    scratchPrefix: prefix, runRoot, runtimePrefix, home, dbPath: join(home, 'control.db'),
    scopeId: scope, chainId: 'rc_chain', childMissionId: 'cm_child', repositoryPath: join(runRoot, 'repository'),
    worktreesRoot, authorityPath, expectedBranch: 'osstack/mission/cold-probe', expectedHead: head,
    modules: { core: { path: corePath, sha256: hash(coreSource) }, runtime: { path: runtimePath, sha256: hash(runtimeSource(mode)) } },
    handoff: { parentPid: process.pid, servicesStopped: true, hostClosed: true, databaseClosed: true, previousOwner },
    ports: { runtimeRoot: join(runRoot, 'runtime'), markerDir: join(home, 'markers'), journalRoot: join(home, 'verification'),
      codex: { bin: await realpath(process.execPath), sourceCodexHome: join(runRoot, 'codex-home'), model: 'gpt-6.1-sol' },
      verification: { socketPath: join(runRoot, 'docker.sock'), daemonId: 'fake-daemon', baseImageId: 'sha256:' + 'c'.repeat(64) }, bridgeConfig: config },
    launchCaps: { executor_seconds: 600, verify_seconds: 120 } };
  const spec = { repo_path: descriptor.repositoryPath, worktree_path: join(worktreesRoot, 'child'), branch: descriptor.expectedBranch,
    publication: { repository: config.repository }, publish_target: { chain_id: descriptor.chainId, remote_branch: descriptor.expectedBranch } };
  await privateJson(descriptor.dbPath, { owner: previousOwner, scope: { scope_id: scope, repo_path: descriptor.repositoryPath },
    missions: [{ mission_id: 'cm_root', scope_id: scope, state: 'pr_opened', stop_obligation: 0, spec_json: JSON.stringify({ ...spec, publish_target: undefined }) },
      { mission_id: 'cm_child', scope_id: scope, state: 'cancel_requested', stop_obligation: 0, spec_json: JSON.stringify(spec) }],
    chains: [{ chain_id: descriptor.chainId, root_mission_id: 'cm_root', current_mission_id: 'cm_child', repository: config.repository,
      branch: descriptor.expectedBranch, published_head: head, state: 'awaiting_decision', mode: 'live' }], intents: [], events: [] });
  return { descriptor, trace: async () => (await readFile(descriptor.dbPath + '.trace', 'utf8')).trim().split('\n').map(x => JSON.parse(x)) };
}

test('fresh worker claims a new owner, recovers then ticks once, closes and exits', async t => {
  const f = await fixture(t);
  const result = await runSandboxColdRestart(f.descriptor);
  assert.equal(result.ok, true); assert.notEqual(result.childPid, process.pid);
  assert.equal(result.exitCode, 0); assert.equal(result.signal, null);
  assert.equal(result.readback.mission.state, 'cancelled'); assert.equal(result.readback.owner.generation, 5);
  assert.equal(result.parentShutdownProven, false);
  t.diagnostic(JSON.stringify({ parentPid: process.pid, childPid: result.childPid, exitCode: result.exitCode, signal: result.signal,
    ownerGeneration: result.readback.owner.generation, missionState: result.readback.mission.state }));
  const trace = await f.trace(); assert.ok(trace.every(x => x.pid === result.childPid));
  assert.deepEqual(trace.map(x => x.event), ['open', 'durability.full', 'claim', 'guards', 'host.new', 'bridge.new', 'host.recover', 'revision.recover', 'host.tick', 'host.recover', 'checks.stop', 'live.stop', 'scan.stop', 'host.close', 'db.close']);
  assert.throws(() => process.kill(result.childPid, 0), { code: 'ESRCH' });
});

test('repository, identity, hash, reserved home, path escape and unknown arguments fail before spawn', async t => {
  const f = await fixture(t); let spawns = 0;
  for (const mutate of [d => { d.repositoryId = 1; }, d => { d.repository = 'osborn-studio/osstack'; },
    d => { d.modules.core.sha256 = '0'.repeat(64); }, d => { d.home = '/Users/other/.osstack'; },
    d => { d.dbPath = join(d.runRoot, 'other.db'); }, d => { d.worktreesRoot = '/'; },
    d => { d.modules.runtime.path = process.execPath; }, d => { d.shell = 'bad'; }, d => { d.handoff.databaseClosed = false; },
    d => { d.ports.codex.args = ['--exec', 'bad']; }, d => { d.ports.bridgeConfig.publisher.private_key = 'must not accept key contents'; }]) {
    const d = structuredClone(f.descriptor); mutate(d);
    await assert.rejects(runSandboxColdRestart(d, { spawn: () => { spawns++; throw Error('must not spawn'); } }), /COLD_/);
  }
  await writeFile(join(f.descriptor.home, 'control-plane-reserved.json'), '{}');
  await assert.rejects(runSandboxColdRestart(f.descriptor), /COLD_/);
  assert.equal(spawns, 0);
});

test('canonical path checks reject symlink escapes', async t => {
  const f = await fixture(t);
  const alias = join(f.descriptor.runRoot, 'alias'); await symlink(tmpdir(), alias);
  await assert.rejects(runSandboxColdRestart({ ...f.descriptor, worktreesRoot: alias }), /COLD_/);
});

test('descriptor is private during spawn and removed after actual child exit', async t => {
  const f = await fixture(t); let file;
  const result = await runSandboxColdRestart(f.descriptor, { spawn: (bin, args, options) => {
    file = args.at(-1);
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
    assert.equal(lstatSync(file).uid, process.getuid());
    assert.deepEqual(args.slice(0, -1), [new URL('./lib/bridge-sandbox-cold-restart.mjs', import.meta.url).pathname, '--cold-restart-worker']);
    assert.equal(options.shell, false); assert.equal(options.env.NODE_OPTIONS, undefined);
    return spawn(bin, args, options);
  } });
  assert.equal(result.ok, true);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('timeout kills and reaps the worker and removes the descriptor', async t => {
  const f = await fixture(t, 'hang'); let child, file;
  await assert.rejects(runSandboxColdRestart(f.descriptor, { timeoutMs: 200, spawn: (bin, args, options) => {
    file = args.at(-1); child = spawn(bin, args, options); return child;
  } }), error => { assert.equal(error.message, 'COLD_TIMEOUT'); assert.equal(error.evidence.childPid, child.pid); return true; });
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.descriptor.home, 'cold-restart.lock')), { code: 'ENOENT' });
});

test('worker failures are sanitized and resources close', async t => {
  const f = await fixture(t, 'fail');
  await assert.rejects(runSandboxColdRestart(f.descriptor), error => {
    assert.equal(error.message, 'COLD_WORKER_FAILED'); assert.equal(error.evidence.exitCode, 1);
    assert.ok(!JSON.stringify(error).includes('secret-runtime-error')); return true;
  });
  const trace = (await f.trace()).map(x => x.event);
  assert.deepEqual(trace.slice(-5), ['checks.stop', 'live.stop', 'scan.stop', 'host.close', 'db.close']);
});

test('local worker function validates before importing injected modules', async t => {
  const f = await fixture(t); let imports = 0;
  await assert.rejects(recoverCancelledSandboxMission({ ...f.descriptor, repositoryId: 0 }, {
    importModule: async () => { imports++; },
  }), /COLD_/);
  assert.equal(imports, 0);
});

test('post-recovery publication does not become success evidence', async t => {
  const f = await fixture(t, 'publish');
  await assert.rejects(runSandboxColdRestart(f.descriptor), /COLD_WORKER_FAILED/);
  assert.equal((await f.trace()).at(-1).event, 'db.close');
});

test('worker rejects an insecure descriptor and a module changed after parent validation', async t => {
  for (const change of ['mode', 'module']) {
    const f = await fixture(t);
    await assert.rejects(runSandboxColdRestart(f.descriptor, { spawn: (bin, args, options) => {
      if (change === 'mode') chmodSync(args.at(-1), 0o644);
      else writeFileSync(f.descriptor.modules.runtime.path, 'throw Error("must not import");');
      return spawn(bin, args, options);
    } }), /COLD_WORKER_FAILED/);
    await assert.rejects(readFile(f.descriptor.dbPath + '.trace'), { code: 'ENOENT' });
  }
});

test('a worker that ignores SIGTERM is killed with SIGKILL and reaped', async t => {
  const f = await fixture(t, 'resist'); let child;
  await assert.rejects(runSandboxColdRestart(f.descriptor, { timeoutMs: 200, spawn: (bin, args, options) => {
    child = spawn(bin, args, options); return child;
  } }), error => { assert.equal(error.message, 'COLD_TIMEOUT'); assert.equal(error.evidence.signal, 'SIGKILL'); return true; });
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  await assert.rejects(readFile(join(f.descriptor.home, 'cold-restart.lock')), { code: 'ENOENT' });
});

test('excess output fails without returning its contents', async t => {
  const f = await fixture(t, 'noisy');
  await assert.rejects(runSandboxColdRestart(f.descriptor), error => {
    assert.equal(error.message, 'COLD_OUTPUT_BOUND'); assert.ok(!String(error).includes('sensitive')); return true;
  });
});

test('cleanup failure cannot produce success and does not skip database close', async t => {
  const f = await fixture(t, 'closeFail');
  await assert.rejects(runSandboxColdRestart(f.descriptor), /COLD_WORKER_FAILED/);
  assert.equal((await f.trace()).at(-1).event, 'db.close');
});

test('a failed receipt can settle during recovery; a new confirmed push cannot', async t => {
  for (const mode of ['settle', 'confirm']) {
    const f = await fixture(t, mode);
    const data = JSON.parse(await readFile(f.descriptor.dbPath, 'utf8'));
    data.intents.push({ intent_id: 'pi_child', chain_id: f.descriptor.chainId, child_mission_id: 'cm_child', kind: 'push', state: 'pending', new_head: head });
    await writeFile(f.descriptor.dbPath, JSON.stringify(data));
    if (mode === 'settle') assert.equal((await runSandboxColdRestart(f.descriptor)).readback.intents[0].state, 'failed');
    else await assert.rejects(runSandboxColdRestart(f.descriptor), /COLD_WORKER_FAILED/);
  }
});

test('unrelated outstanding work and stale owner bindings fail before taking ownership', async t => {
  for (const mode of ['outstanding', 'owner', 'chain', 'receipt', 'root', 'scope', 'state']) {
    const f = await fixture(t);
    const data = JSON.parse(await readFile(f.descriptor.dbPath, 'utf8'));
    if (mode === 'owner') data.owner.generation++;
    if (mode === 'outstanding') data.missions.push({ ...data.missions[1], mission_id: 'cm_other' });
    if (mode === 'chain') data.chains.push({ ...data.chains[0], chain_id: 'rc_other' });
    if (mode === 'receipt') data.intents.push({ intent_id: 'pi_other', chain_id: 'rc_other', state: 'uncertain' });
    if (mode === 'root') data.missions[0].state = 'cancelled';
    if (mode === 'scope') data.scope.scope_id = 'd'.repeat(64);
    if (mode === 'state') data.missions[1].state = 'authorized';
    await writeFile(f.descriptor.dbPath, JSON.stringify(data));
    await assert.rejects(runSandboxColdRestart(f.descriptor), /COLD_WORKER_FAILED/);
    assert.deepEqual((await f.trace()).map(x => x.event), ['open', 'durability.full', 'db.close']);
  }
});

test('time bounds and spawn failure do not leave a descriptor behind', async t => {
  const f = await fixture(t);
  for (const timeoutMs of [0, 99, 60_001, NaN]) await assert.rejects(runSandboxColdRestart(f.descriptor, { timeoutMs }), /COLD_TIMEOUT_BOUND/);
  let file;
  await assert.rejects(runSandboxColdRestart(f.descriptor, { spawn: (_bin, args) => {
    file = args.at(-1); throw Error('private spawn failure');
  } }), /COLD_SPAWN_FAILED/);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('worker keeps its primary error across all failing cleanups and restores lock and environment', async t => {
  const f = await fixture(t);
  const primary = Object.assign(Error('COLD_SCOPE_BINDING'), { evidence: { childPid: 432, exitCode: 1 } });
  const calls = [];
  const before = { OSSTACK_HOME: process.env.OSSTACK_HOME, OSSTACK_SCRATCH_ROOT: process.env.OSSTACK_SCRATCH_ROOT };
  const { pathToFileURL } = await import('node:url');
  await assert.rejects(recoverCancelledSandboxMission(f.descriptor, { importModule: async path => {
    const module = await import(pathToFileURL(path).href);
    if (path === f.descriptor.modules.core.path) return { ...module, openDb: input => {
      const db = module.openDb(input);
      return { ...db, close: () => { calls.push('db'); db.close(); throw Error('db-cleanup'); } };
    } };
    return { ...module, ContainedMissionHost: class extends module.ContainedMissionHost {
      async recover() { throw primary; }
      async close() { calls.push('host'); throw Error('host-cleanup'); }
    }, createProductionLiveBridge: async () => ({
      checkRetry: { stop: async () => { calls.push('check'); throw undefined; } },
      live: { stop: async () => { calls.push('live'); throw false; } },
      stoppedScan: { stop: async () => { calls.push('scan'); throw 0; } },
    }) };
  } }), error => error === primary && error.evidence.childPid === 432);
  assert.deepEqual(calls, ['check', 'live', 'scan', 'host', 'db']);
  assert.equal(process.env.OSSTACK_HOME, before.OSSTACK_HOME);
  assert.equal(process.env.OSSTACK_SCRATCH_ROOT, before.OSSTACK_SCRATCH_ROOT);
  await assert.rejects(readFile(join(f.descriptor.home, 'cold-restart.lock')), { code: 'ENOENT' });
});

test('launcher retains failed child PID and exit evidence when lock cleanup also fails', async t => {
  const f = await fixture(t);
  const { EventEmitter } = await import('node:events');
  await assert.rejects(runSandboxColdRestart(f.descriptor, { spawn: () => {
    const child = new EventEmitter(); child.pid = 54321; child.exitCode = 1; child.signalCode = null;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(async () => {
      await writeFile(join(f.descriptor.home, 'cold-restart.lock'), 'malformed', { mode: 0o600 });
      child.emit('close', 1, null);
    });
    return child;
  } }), error => error.message === 'COLD_WORKER_FAILED' && error.evidence.childPid === 54321 && error.evidence.exitCode === 1);
});

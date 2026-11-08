// Recovery-only sandbox handoff. This module never accepts a command, shell, or worker source.
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDurableSandboxDb } from './bridge-sandbox-database.mjs';
import { parseRegistry } from './bridge-probe.mjs';

const entry = fileURLToPath(import.meta.url);
const MAX_OUTPUT = 32_768;
const sha = value => createHash('sha256').update(value).digest('hex');
const check = (value, code) => { if (!value) throw Error(`COLD_${code}`); };
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/.test(value);
const within = (root, path) => { const rel = relative(root, path); return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); };
function keys(value, allowed) {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)), 'DESCRIPTOR_SHAPE');
}
async function canonical(path, prefix, missing = false) {
  check(text(path) && isAbsolute(path) && resolve(path) === path, 'PATH');
  let actual;
  try { actual = await realpath(path); }
  catch (error) {
    if (!missing || error.code !== 'ENOENT') throw Error('COLD_PATH');
    actual = join(await canonical(dirname(path), undefined, true), path.slice(dirname(path).length + 1));
  }
  check(actual === path && (!prefix || within(prefix, actual)), 'PATH');
  return actual;
}
async function privateDirectory(path) {
  const stat = await lstat(path);
  check(stat.isDirectory() && stat.uid === process.getuid?.() && !(stat.mode & 0o077), 'PRIVATE_DIRECTORY');
}
async function readBoundFile(path, limit, privateMode = false) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    check(before.isFile() && before.nlink === 1 && before.size <= limit && before.uid === process.getuid?.()
      && (!privateMode || !(before.mode & 0o077)), 'PRIVATE_FILE');
    const bytes = await file.readFile(); const after = await file.stat();
    check(bytes.length === before.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'FILE_CHANGED');
    return bytes;
  } finally { await file.close(); }
}
const privateJson = async path => JSON.parse((await readBoundFile(path, 65_536, true)).toString('utf8'));

/** Descriptor contract is deliberately narrower than createContainedMissionPorts options. */
async function validateDescriptor(d) {
  keys(d, ['version', 'repository', 'repositoryId', 'scratchPrefix', 'runRoot', 'runtimePrefix', 'home', 'dbPath', 'scopeId',
    'chainId', 'childMissionId', 'repositoryPath', 'worktreesRoot', 'authorityPath', 'expectedBranch', 'expectedHead', 'modules', 'handoff', 'ports', 'launchCaps']);
  check(d.version === 1, 'VERSION');
  const registered = parseRegistry(await readFile(new URL('../../docs/decisions/ADR-006-bridge-s0-decisions.md', import.meta.url), 'utf8')).sandbox;
  check(d.repository === registered.repo && d.repositoryId === registered.id, 'NOT_SANDBOX');
  await canonical(d.scratchPrefix); await canonical(d.runtimePrefix);
  check(d.scratchPrefix !== sep && d.runtimePrefix !== sep && d.scratchPrefix !== homedir() && d.runtimePrefix !== homedir(), 'PREFIX');
  await canonical(d.runRoot, d.scratchPrefix); await privateDirectory(d.runRoot);
  check(d.home === join(d.runRoot, 'home') && d.dbPath === join(d.home, 'control.db')
    && d.authorityPath === join(d.home, 'authority.json'), 'HOME');
  await canonical(d.home, d.runRoot); await privateDirectory(d.home);
  for (const marker of ['control-plane-reserved.json', 'managed-consumer.json', 'daemon.pid', 'daemon.sock']) {
    const exists = await lstat(join(d.home, marker)).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
    check(!exists, 'RESERVED_HOME');
  }
  check(d.home !== resolve(homedir(), '.osstack'), 'HOME');
  for (const path of [d.dbPath, d.repositoryPath, d.worktreesRoot, d.authorityPath]) await canonical(path, d.runRoot);
  for (const suffix of ['-wal', '-shm', '-journal']) await canonical(d.dbPath + suffix, d.home, true);
  // Existing private DB only: never allocate an empty application database on a typo.
  const dbStat = await lstat(d.dbPath);
  check(dbStat.isFile() && dbStat.nlink === 1 && dbStat.uid === process.getuid?.() && !(dbStat.mode & 0o077) && dbStat.size <= 67_108_864, 'DATABASE');
  await privateJson(d.authorityPath);
  check(/^[a-f0-9]{64}$/.test(d.scopeId) && /^rc_[A-Za-z0-9_-]{1,80}$/.test(d.chainId)
    && /^cm_[A-Za-z0-9_-]{1,80}$/.test(d.childMissionId), 'IDENTITY');
  check(/^osstack\/mission\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(d.expectedBranch)
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(d.expectedHead), 'REMOTE_BINDING');
  keys(d.handoff, ['parentPid', 'servicesStopped', 'hostClosed', 'databaseClosed', 'previousOwner']);
  check(Number.isSafeInteger(d.handoff.parentPid) && d.handoff.parentPid > 1 && d.handoff.servicesStopped === true
    && d.handoff.hostClosed === true && d.handoff.databaseClosed === true, 'HANDOFF_REQUIRED');
  keys(d.handoff.previousOwner, ['home_id', 'instance_id', 'generation']);
  check(text(d.handoff.previousOwner.home_id) && text(d.handoff.previousOwner.instance_id)
    && Number.isSafeInteger(d.handoff.previousOwner.generation) && d.handoff.previousOwner.generation > 0, 'OWNER');
  keys(d.modules, ['runtime', 'core']);
  for (const module of [d.modules.runtime, d.modules.core]) {
    keys(module, ['path', 'sha256']); await canonical(module.path, d.runtimePrefix);
    check(/\.(?:mjs|js)$/.test(module.path) && /^[a-f0-9]{64}$/.test(module.sha256)
      && sha(await readBoundFile(module.path, 33_554_432)) === module.sha256, 'MODULE_HASH');
  }
  keys(d.ports, ['runtimeRoot', 'markerDir', 'journalRoot', 'codex', 'verification', 'bridgeConfig']);
  for (const path of [d.ports.runtimeRoot, d.ports.markerDir, d.ports.journalRoot]) await canonical(path, d.runRoot, true);
  check(within(d.home, d.ports.markerDir) && within(d.home, d.ports.journalRoot), 'HOME');
  keys(d.ports.codex, ['bin', 'sourceCodexHome', 'identityBinary', 'model']);
  check(d.ports.codex.model === 'gpt-6.1-sol', 'MODEL');
  for (const path of [d.ports.codex.bin, d.ports.codex.sourceCodexHome, ...(d.ports.codex.identityBinary ? [d.ports.codex.identityBinary] : [])]) await canonical(path);
  keys(d.ports.verification, ['socketPath', 'daemonId', 'baseImageId']);
  await canonical(d.ports.verification.socketPath, undefined, true);
  check(text(d.ports.verification.daemonId) && /^sha256:[a-f0-9]{64}$/.test(d.ports.verification.baseImageId), 'DOCKER');
  const config = d.ports.bridgeConfig;
  keys(config, ['repository', 'publisher', 'evidence', 'mission_ruleset_ids']);
  check(config.repository === d.repository && Array.isArray(config.mission_ruleset_ids)
    && config.mission_ruleset_ids.length > 0 && config.mission_ruleset_ids.length <= 16
    && config.mission_ruleset_ids.every(n => Number.isSafeInteger(n) && n > 0), 'APP_CONFIG');
  for (const app of [config.publisher, config.evidence]) {
    keys(app, ['app_id', 'installation_id', 'private_key_path']);
    check(Number.isSafeInteger(app.app_id) && app.app_id > 0 && Number.isSafeInteger(app.installation_id) && app.installation_id > 0, 'APP_CONFIG');
    await canonical(app.private_key_path);
    const stat = await lstat(app.private_key_path);
    check(stat.isFile() && stat.uid === process.getuid?.() && !(stat.mode & 0o077), 'APP_REFERENCE');
  }
  for (const name of ['apps', 'rulesets', 'producers', 'revision-issuer']) await canonical(join(d.home, `bridge/${name}.json`), d.home);
  const apps = await privateJson(join(d.home, 'bridge/apps.json'));
  const rules = await privateJson(join(d.home, 'bridge/rulesets.json'));
  const producers = await privateJson(join(d.home, 'bridge/producers.json'));
  await privateJson(join(d.home, 'bridge/revision-issuer.json'));
  keys(apps, ['version', 'repository', 'publisher', 'evidence']);
  keys(rules, ['version', 'repository', 'mission_ruleset_ids']);
  const sameApp = (a, b) => a && ['app_id', 'installation_id', 'private_key_path'].every(key => a[key] === b[key]);
  check(apps.version === 1 && rules.version === 1 && [apps, rules, producers].every(c => c.repository === d.repository)
    && sameApp(apps.publisher, config.publisher) && sameApp(apps.evidence, config.evidence)
    && JSON.stringify(rules.mission_ruleset_ids) === JSON.stringify(config.mission_ruleset_ids), 'HOME_CONFIG');
  keys(d.launchCaps, ['executor_seconds', 'verify_seconds']);
  check(d.launchCaps.executor_seconds === 600 && d.launchCaps.verify_seconds === 120, 'LAUNCH_CAPS');
  return d;
}
async function validate(d) {
  try { return await validateDescriptor(d); }
  catch (error) { throw Error(/^COLD_[A-Z_]+$/.test(error.message) ? error.message : 'COLD_DESCRIPTOR_INVALID'); }
}

function snapshot(db) {
  const read = table => {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT 129`).all();
    check(rows.length <= 128, 'DATABASE_BOUND'); return rows;
  };
  return { missions: read('engineering_contained_missions'), chains: read('engineering_revision_chains'),
    intents: read('engineering_publication_intents'), events: read('engineering_contained_events') };
}
function publicationFacts(s) {
  return JSON.stringify({ missions: s.missions.map(m => m.mission_id).sort(), chains: s.chains.map(c => c.chain_id).sort(),
    publications: s.events.filter(e => ['pr_opened', 'delivery_evidence'].includes(e.kind)),
    writes: s.intents.filter(i => i.kind === 'push' || i.kind === 'open_pr').map(i => [i.intent_id, i.kind, i.new_head]),
    confirmed: s.intents.filter(i => ['push', 'open_pr'].includes(i.kind) && i.state === 'confirmed').map(i => i.intent_id) });
}

/** Local injection is for fixtures only. The fresh worker always imports the hash-checked file paths. */
export async function recoverCancelledSandboxMission(descriptor, { importModule = path => import(pathToFileURL(path).href) } = {}) {
  const d = await validate(descriptor);
  let db, host, bridge, lock;
  let cleanupFailed = false, primaryFailed = false, forbidden = 0;
  const lockPath = join(d.home, 'cold-restart.lock');
  const oldEnv = { OSSTACK_HOME: process.env.OSSTACK_HOME, OSSTACK_SCRATCH_ROOT: process.env.OSSTACK_SCRATCH_ROOT };
  try {
    lock = await open(lockPath, 'wx', 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, descriptorSha256: sha(JSON.stringify(d)) }));
    process.env.OSSTACK_HOME = d.home; process.env.OSSTACK_SCRATCH_ROOT = d.runRoot;
    const core = await importModule(d.modules.core.path), runtime = await importModule(d.modules.runtime.path);
    db = openDurableSandboxDb(core, d.dbPath);
    const before = snapshot(db), beforePublication = publicationFacts(before);
    const oldOwner = db.prepare('SELECT home_id,instance_id,generation FROM daemon_owner WHERE singleton=1').get();
    check(['home_id', 'instance_id', 'generation'].every(key => oldOwner?.[key] === d.handoff.previousOwner[key]), 'OWNER_CHANGED');
    const attention = new core.AttentionStore(db, d.dbPath);
    const boundScope = attention.getScope(d.scopeId);
    check(boundScope?.scope_id === d.scopeId && boundScope.repo_path === d.repositoryPath, 'SCOPE_BINDING');
    const initial = before.missions.find(m => m.mission_id === d.childMissionId);
    const chain = before.chains.find(c => c.chain_id === d.chainId);
    check(initial?.scope_id === d.scopeId && ['cancelled', 'cancel_requested'].includes(initial.state)
      && chain?.repository === d.repository && chain.current_mission_id === d.childMissionId
      && chain.branch === d.expectedBranch && chain.published_head === d.expectedHead, 'CANCEL_BINDING');
    check(before.missions.some(m => m.mission_id === chain.root_mission_id && m.state === 'pr_opened'), 'ROOT_BINDING');
    check(before.chains.every(c => c.chain_id === d.chainId || c.state === 'closed'), 'OTHER_LIVE_CHAIN');
    check(before.intents.every(i => i.chain_id === d.chainId || !['pending', 'uncertain'].includes(i.state)), 'OTHER_UNSETTLED_RECEIPT');
    for (const m of before.missions) {
      check(m.scope_id === d.scopeId, 'OTHER_SCOPE');
      const spec = JSON.parse(m.spec_json);
      await canonical(spec.repo_path, d.runRoot); await canonical(spec.worktree_path, d.worktreesRoot, true);
      check(spec.repo_path === d.repositoryPath && spec.publication?.repository === d.repository, 'MISSION_BINDING');
      if (m.mission_id === d.childMissionId) check(spec.publish_target?.chain_id === d.chainId
        && spec.publish_target.remote_branch === d.expectedBranch, 'CHILD_BINDING');
    }
    const journals = db.prepare('SELECT * FROM engineering_host_processes ORDER BY rowid LIMIT 129').all();
    check(journals.length <= 128, 'DATABASE_BOUND');
    for (const journal of journals) {
      check(before.missions.some(m => m.mission_id === journal.mission_id), 'JOURNAL_BINDING');
      await canonical(journal.marker_path, d.ports.markerDir, true);
      await canonical(journal.local_target.split('#')[0], d.runRoot, true);
      check(!journal.remote_target || journal.remote_target === `${d.repository}#refs/heads/${d.expectedBranch}`, 'JOURNAL_BINDING');
    }
    check(new core.ContainedMissionStore(attention, oldOwner).listOutstanding(100).every(m => m.mission_id === d.childMissionId), 'OTHER_OUTSTANDING_MISSION');
    const owner = attention.claimOwner(`sandbox-cold-${process.pid}-${randomUUID()}`);
    check(owner.home_id === oldOwner.home_id && owner.generation === oldOwner.generation + 1 && owner.instance_id !== oldOwner.instance_id, 'NEW_OWNER');
    const missions = new core.ContainedMissionStore(attention, owner), chains = new core.RevisionChainStore(attention, owner);
    check(missions.listOutstanding(100).every(m => m.mission_id === d.childMissionId), 'OTHER_OUTSTANDING_MISSION');
    // Defense in depth: recovery must never create work or publish a fresh receipt.
    db.exec(`CREATE TEMP TRIGGER cold_no_mission BEFORE INSERT ON main.engineering_contained_missions BEGIN SELECT RAISE(ABORT,'cold_recovery_only'); END;
      CREATE TEMP TRIGGER cold_no_chain BEFORE INSERT ON main.engineering_revision_chains BEGIN SELECT RAISE(ABORT,'cold_recovery_only'); END;
      CREATE TEMP TRIGGER cold_no_intent BEFORE INSERT ON main.engineering_publication_intents BEGIN SELECT RAISE(ABORT,'cold_recovery_only'); END;`);
    const ports = runtime.createContainedMissionPorts({ store: missions, now: Date.now, runtimeRoot: d.ports.runtimeRoot,
      codex: d.ports.codex, hostProcess: { markerDir: d.ports.markerDir },
      verification: { ...d.ports.verification, journalRoot: d.ports.journalRoot },
      author: { name: 'OSStack Sandbox', email: 'sandbox@osstack.invalid' }, bridge: { config: d.ports.bridgeConfig } });
    const deny = async () => { forbidden++; throw Error('COLD_RECOVERY_ONLY'); };
    for (const key of ['createWorkspace', 'resumeWorkspace', 'qualify', 'execute', 'commit', 'restoreWorkspace', 'commitWorktree', 'verify', 'publish', 'publishVerifyCheck']) ports[key] = deny;
    const access = new runtime.EngineeringAccess(d.authorityPath);
    host = new runtime.ContainedMissionHost({ ports, worktreesRoot: d.worktreesRoot, maxConcurrent: 1 });
    bridge = await runtime.createProductionLiveBridge({ home: d.home, chains, missions, ports, host, access,
      enabled: () => false, now: Date.now, log: () => {}, launchCaps: d.launchCaps });
    await host.recover();
    await bridge.revisionRecovery(new AbortController().signal);
    check(missions.listOutstanding(100).every(m => m.mission_id === d.childMissionId), 'OTHER_OUTSTANDING_MISSION');
    check(['cancelled', 'cancel_requested'].includes(missions.get(d.childMissionId).state), 'RECOVERY_STATE');
    await host.tick();
    check(missions.get(d.childMissionId).state === 'cancelled'
      && beforePublication === publicationFacts(snapshot(db)), 'RECOVERY_STATE');
    // Recovery first settles cancel_requested; the terminal pass releases its workspace claim.
    await host.recover();
    const after = snapshot(db), mission = missions.get(d.childMissionId), finalChain = chains.get(d.chainId);
    check(!forbidden && mission.state === 'cancelled' && mission.stop_obligation === 0
      && missions.claim(d.childMissionId).state === 'released', 'CANCEL_NOT_SETTLED');
    check(beforePublication === publicationFacts(after) && finalChain.published_head === d.expectedHead
      && finalChain.stop_reason !== 'external_write', 'PUBLICATION_CHANGED');
    const intents = chains.intents(d.chainId);
    check(!intents.some(i => i.kind === 'push' && i.state === 'confirmed' && i.child_mission_id === d.childMissionId), 'CONFIRMED_PUSH');
    const finalOwner = db.prepare('SELECT home_id,instance_id,generation FROM daemon_owner WHERE singleton=1').get();
    check(['home_id', 'instance_id', 'generation'].every(key => finalOwner?.[key] === owner[key]), 'OWNER_CHANGED');
    return { workerPid: process.pid, parentShutdownProven: false,
      readback: { owner: { instance_id: owner.instance_id, generation: owner.generation },
        mission: { mission_id: d.childMissionId, state: mission.state, stop_obligation: mission.stop_obligation },
        chain: { chain_id: d.chainId, published_head: finalChain.published_head },
        intents: intents.map(i => ({ intent_id: i.intent_id, kind: i.kind, state: i.state })) } };
  } catch (error) { primaryFailed = true; throw error; } finally {
    for (const close of [() => bridge?.checkRetry?.stop(), () => bridge?.live.stop(), () => bridge?.stoppedScan.stop(), () => host?.close(), () => db?.close()]) {
      try { await close(); } catch { cleanupFailed = true; }
    }
    if (lock) {
      for (const close of [() => lock.close(), () => rm(lockPath)]) {
        try { await close(); } catch { cleanupFailed = true; }
      }
    }
    for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (cleanupFailed && !primaryFailed) throw Error('COLD_CLEANUP_FAILED');
  }
}

/** Parent promises to quiesce and close first. Resolves only after worker exit and pipe close. */
export async function runSandboxColdRestart(descriptor, { spawn = nodeSpawn, timeoutMs = 45_000 } = {}) {
  check(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60_000, 'TIMEOUT_BOUND');
  const d = await validate(structuredClone(descriptor));
  check(d.handoff.parentPid === process.pid, 'PARENT_PID');
  const directory = await mkdtemp(join(d.runRoot, '.cold-restart-'));
  const path = join(directory, 'descriptor.json'); let child, timer, killTimer, primaryFailed = false;
  try {
    const file = await open(path, 'wx', 0o600);
    try { const bytes = JSON.stringify(d); check(Buffer.byteLength(bytes) <= 65_536, 'DESCRIPTOR_BOUND'); await file.writeFile(bytes); } finally { await file.close(); }
    const env = { PATH: process.env.PATH, HOME: homedir(), TMPDIR: process.env.TMPDIR,
      OSSTACK_HOME: d.home, OSSTACK_SCRATCH_ROOT: d.runRoot };
    const result = await new Promise((resolveResult, reject) => {
      let output = '', bytes = 0, reason;
      const terminate = code => {
        if (reason) return; reason = code;
        const kill = signal => { try { process.kill(-child.pid, signal); } catch { child.kill(signal); } };
        kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 250);
      };
      try { child = spawn(process.execPath, [entry, '--cold-restart-worker', path], { cwd: d.runRoot, shell: false, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { reject(Error('COLD_SPAWN_FAILED')); return; }
      child.on('error', () => { reason ??= 'COLD_SPAWN_FAILED'; });
      child.stdout.on('data', data => { bytes += data.length; if (bytes > MAX_OUTPUT) terminate('COLD_OUTPUT_BOUND'); else output += data.toString('utf8'); });
      child.stderr.on('data', data => { bytes += data.length; if (bytes > MAX_OUTPUT) terminate('COLD_OUTPUT_BOUND'); });
      timer = setTimeout(() => terminate('COLD_TIMEOUT'), timeoutMs);
      child.on('close', (exitCode, signal) => {
        clearTimeout(timer); clearTimeout(killTimer);
        if (reason) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited group */ } }
        const evidence = { childPid: child.pid ?? null, exitCode, signal, parentShutdownProven: false };
        if (reason || exitCode !== 0) { reject(Object.assign(Error(reason ?? 'COLD_WORKER_FAILED'), { evidence })); return; }
        try {
          const facts = JSON.parse(output);
          check(facts.workerPid === child.pid && child.pid !== process.pid && facts.readback?.mission?.mission_id === d.childMissionId
            && facts.readback.mission.state === 'cancelled' && facts.readback.mission.stop_obligation === 0 && facts.readback.chain?.chain_id === d.chainId
            && facts.readback.chain.published_head === d.expectedHead && facts.readback.owner?.generation === d.handoff.previousOwner.generation + 1
            && new RegExp(`^sandbox-cold-${child.pid}-[a-f0-9-]{36}$`).test(facts.readback.owner.instance_id)
            && Array.isArray(facts.readback.intents) && facts.readback.intents.length <= 128, 'WORKER_EVIDENCE');
          resolveResult({ ok: true, ...evidence, readback: {
            owner: { instance_id: facts.readback.owner.instance_id, generation: facts.readback.owner.generation },
            mission: { mission_id: d.childMissionId, state: 'cancelled', stop_obligation: 0 },
            chain: { chain_id: d.chainId, published_head: d.expectedHead },
            intents: facts.readback.intents.map(i => {
              check(/^pi_[A-Za-z0-9_-]{1,80}$/.test(i.intent_id) && ['push', 'open_pr', 'check'].includes(i.kind)
                && ['pending', 'uncertain', 'confirmed', 'failed'].includes(i.state), 'WORKER_EVIDENCE');
              return { intent_id: i.intent_id, kind: i.kind, state: i.state };
            }) } });
        } catch { reject(Object.assign(Error('COLD_WORKER_EVIDENCE'), { evidence })); }
      });
    });
    return result;
  } catch (error) { primaryFailed = true; throw error; } finally {
    clearTimeout(timer); clearTimeout(killTimer);
    // SIGKILL cannot run JS finally. Only remove this exited worker's proven lock.
    let cleanupFailed = false;
    try {
      if (child?.pid && (child.exitCode !== null || child.signalCode !== null)) {
        const lockPath = join(d.home, 'cold-restart.lock');
        try {
          const lock = await privateJson(lockPath);
          if (lock.pid === child.pid && lock.descriptorSha256 === sha(JSON.stringify(d))) await rm(lockPath);
        } catch (error) { if (error.code !== 'ENOENT') throw Error('COLD_CLEANUP_FAILED'); }
      }
    } catch { cleanupFailed = true; }
    try { await rm(directory, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    if (cleanupFailed && !primaryFailed) throw Error('COLD_CLEANUP_FAILED');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === entry) {
  const worker = async () => {
    check(process.argv.length === 4 && process.argv[2] === '--cold-restart-worker', 'WORKER_ARGUMENTS');
    const path = await canonical(process.argv[3]); await privateDirectory(dirname(path));
    const d = await privateJson(path);
    check(within(d.runRoot, path) && d.handoff?.parentPid === process.ppid, 'WORKER_PARENT');
    const evidence = await recoverCancelledSandboxMission(d);
    process.stdout.write(JSON.stringify(evidence) + '\n');
  };
  worker().catch(() => { process.stderr.write('{"ok":false,"code":"COLD_WORKER_FAILED"}\n'); process.exitCode = 1; });
}

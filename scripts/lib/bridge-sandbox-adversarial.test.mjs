import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createScratchDir, scratchRoot } from './scratch.mjs';
import { installAdversarialExecuteHook } from './bridge-sandbox-adversarial.mjs';

const testRoot = realpathSync(await createScratchDir('tests', 'osstack-adversarial-offline'));
after(() => rmSync(testRoot, { recursive: true, force: true }));
assert.equal(dirname(testRoot), realpathSync(join(scratchRoot(), 'tests')));
let testCounter = 0;

const sha = value => createHash('sha256').update(value).digest('hex');
// Explicit offline parser double: not installed Codex and not live proof.
function fakeParser(path) {
  const raw = readFileSync(path, 'utf8');
  return raw.endsWith('END-OF-PATCH\n')
    ? { ok: true, text: raw.slice(0, -13), bytes: Buffer.byteLength(raw) }
    : { ok: false, reason: 'PATCH_INCOMPLETE' };
}
// Explicit offline grammar double. The driver must supply installed governance.
const fakeGrammar = text => text.includes('@@ ') && text.includes('\n+++ ')
  ? { ok: true, files: [{ path: 'fake-offline' }] } : { ok: false, rejections: [] };
function setup(t, execute) {
  const dir = join(testRoot, String(++testCounter));
  mkdirSync(dir, { mode: 0o700 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixturePath = join(dir, 'fixture.txt');
  writeFileSync(fixturePath, 'diff --git a/.github/workflows/x.yml b/.github/workflows/x.yml\nnew file mode 100644\n--- /dev/null\n+++ b/.github/workflows/x.yml\n@@ -0,0 +1 @@\n+fixture\nEND-OF-PATCH\n');
  const owner = { home_id: 'home', instance_id: 'owner', generation: 1 };
  const target = { missionId: 'cm_target', worktree: dir, head: 'a'.repeat(40), revision: 3, owner };
  const spec = { repo_path: dir, branch: 'osstack/mission/offline', start_commit: target.head, worktree_path: dir };
  const specDigest = sha(JSON.stringify({ branch: spec.branch, repo_path: dir, start_commit: target.head, worktree_path: dir }));
  const repoStat = statSync(dir);
  const mission = { mission_id: target.missionId, state: 'executing', revision: 3, expected_head: target.head,
    spec_json: JSON.stringify(spec), spec_digest: specDigest, owner_principal_id: 'offline-principal', owner_client_session_id: 'offline-session', candidate_head: null, candidate_tree: null, candidate_diff_digest: null,
    verify_attempts: 0, repair_cycles: 0, repair_pending: 0, candidate_verified: 0, stop_obligation: 1, supersedes: null };
  const q = { qualified: true, profile: ':read-only', version: 'fake-offline', identity_sha256: 'b'.repeat(64), reasons: [], host_observed_writes: [],
    results: Object.fromEntries(['parent', 'escaped_child'].map(who => [who, Object.fromEntries(['write_worktree', 'write_outside', 'write_gitdir', 'network'].map(op => [op, 'denied']))])) };
  const events = [];
  // Golden raw payload shapes from store.authorize/transition and runner.createWorkspace/qualifyAndExecute.
  const event = (kind, payload, actor = null) => events.push({ seq: events.length + 1, mission_id: target.missionId, kind, actor, payload_json: JSON.stringify(payload), created_at: 90 + events.length });
  event('contained_authorized', { spec_digest: specDigest, supersedes: null }, mission.owner_principal_id);
  event('workspace_claimed', { repo_identity: `${realpathSync(dir)}#${repoStat.dev}:${repoStat.ino}`, branch: spec.branch, worktree_identity: dir });
  event('workspace_intent', { worktree_path: dir, branch: spec.branch, start_commit: spec.start_commit });
  event('workspace_created', { worktree: dir, git_dir: join(dir, '.git'), config_digest: 'c'.repeat(64), from: 'authorized', to: 'workspace_ready' });
  event('qualification_probe', q);
  event('executor_launch_intent', { version: q.version, identity_sha256: q.identity_sha256, from: 'workspace_ready', to: 'executing' });
  const launch = { pid: 123, pgid: 123, started_at: 100 };
  const run = { launch, exit_code: 0, signal: null, timed_out: false, cancelled: false,
    stop: { stop_proof: 'group_empty+sandbox_inherited', pgid: 123, signals: [], confirmed_at: 110 },
    patch: { ok: true, text: 'diff --git a/stage b/stage\n--- a/stage\n+++ b/stage\n@@ -1 +1 @@\n-old\n+new\n', bytes: 100 },
    stdout: 'original stdout', stderr: 'original stderr', stdout_truncated: false, stderr_truncated: false };
  const snapshot = { mission, events, owner: { ...owner }, head: target.head, worktree: dir, worktreeClean: true, complete: true, hostProcesses: [], pendingPushIntents: [] };
  let calls = 0;
  const ports = { async execute(input) { calls++; input.onLaunched(launch); if (execute) await execute({ input, snapshot, run, event }); return run; } };
  const original = ports.execute;
  const input = { worktree: dir, prompt: 'unchanged prompt', signal: new AbortController().signal, onLaunched: value => event('executor_started', value) };
  const options = { sandbox: true, target, fixturePath, readCodexProxyPatch: fakeParser, parseMissionPatch: fakeGrammar,
    parserProvenance: { modulePath: new URL(import.meta.url).pathname, sha256: sha(readFileSync(new URL(import.meta.url))) }, readSnapshot: () => snapshot };
  return { ports, original, input, options, run, snapshot, event, spec, calls: () => calls };
}

test('offline: preserve receiver, input references and real-result fields; replace only patch once', async t => {
  const f = setup(t);
  const base = f.ports.execute;
  f.ports.execute = function (...args) { assert.equal(this, f.ports); assert.equal(args.length, 1); assert.equal(args[0], f.input); return Reflect.apply(base, this, args); };
  const hook = installAdversarialExecuteHook(f.ports, f.options);
  const result = await f.ports.execute(f.input);
  assert.equal(f.calls(), 1);
  for (const key of Object.keys(f.run).filter(k => k !== 'patch')) assert.equal(result[key], f.run[key]);
  assert.notEqual(result.patch, f.run.patch); assert.match(result.patch.text, /workflows/);
  assert.match(f.run.patch.text, /stage/);
  const evidence = hook.getEvidence();
  assert.equal(evidence.injected, true); assert.equal(evidence.classification_input_revision, 4);
  assert.equal(evidence.expected_halted_operation_id, `op_${sha(`cm_target:4:${result.patch.text}`).slice(0, 16)}`);
  assert.equal(evidence.original.patch_sha256, sha(f.run.patch.text));
  evidence.target.owner.generation = 900;
  assert.equal(hook.getEvidence().target.owner.generation, 1);
  await assert.rejects(f.ports.execute(f.input), /duplicate_target/);
  assert.equal(f.calls(), 1); hook.restore();
});

test('offline: other worktree passes unchanged; finally restore and later wrappers are safe', async t => {
  const f = setup(t); const hook = installAdversarialExecuteHook(f.ports, f.options);
  const other = { ...f.input, worktree: '/unrelated', onLaunched() {} };
  assert.equal(await f.ports.execute(other), f.run);
  assert.equal(hook.getEvidence().injected, false);
  const later = () => 'later'; f.ports.execute = later;
  hook.restore(); hook.restore(); assert.equal(f.ports.execute, later);
});

for (const [name, mutate] of Object.entries({
  missing: f => { f.snapshot.mission = null; },
  stale: f => { f.snapshot.mission.revision++; },
  owner: f => { f.snapshot.owner.generation++; },
  cancelled: f => { f.snapshot.mission.state = 'cancel_requested'; },
  head: f => { f.snapshot.head = 'c'.repeat(40); },
  spec: f => { f.snapshot.mission.spec_json = '{}'; },
  incomplete: f => { f.snapshot.complete = false; },
  candidate: f => { f.snapshot.mission.candidate_tree = 'prior'; },
  push: f => { f.snapshot.pendingPushIntents.push({}); },
  qualification: f => { const q = f.snapshot.events.find(e => e.kind === 'qualification_probe'); const p = JSON.parse(q.payload_json); p.qualified = false; q.payload_json = JSON.stringify(p); },
  duplicateLaunch: f => f.event('executor_launch_intent', {}),
  priorStart: f => f.event('executor_started', f.run.launch),
  priorRepair: f => f.event('repair_started', {}),
  priorResume: f => f.event('decision_resume', {}),
  priorDiscard: f => f.event('decision_discard_changes', {}),
  priorAdopt: f => f.event('t0_intent', { adopted: true }),
  priorVerify: f => f.event('verify_intent', {}),
  priorDelivery: f => f.event('delivery_intent', {}),
  priorOutput: f => f.event('executor_output', {}),
})) test(`offline: pre-gate refuses ${name} without execution`, async t => {
  const f = setup(t); mutate(f);
  const hook = installAdversarialExecuteHook(f.ports, f.options);
  await assert.rejects(f.ports.execute(f.input), /BRIDGE_SANDBOX_ADVERSARIAL_REFUSED/);
  assert.equal(f.calls(), 0); assert.equal(hook.getEvidence().injected, false); hook.restore();
});

for (const [name, mutate] of Object.entries({
  stale: ({ snapshot }) => { snapshot.mission.revision++; },
  owner: ({ snapshot }) => { snapshot.owner.instance_id = 'replacement'; },
  cancelled: ({ input }) => { Object.defineProperty(input.signal, 'aborted', { value: true }); },
  failed: ({ run }) => { run.exit_code = 1; },
  signal: ({ run }) => { run.signal = 'SIGTERM'; },
  timedOut: ({ run }) => { run.timed_out = true; },
  cancelledRun: ({ run }) => { run.cancelled = true; },
  missingStop: ({ run }) => { delete run.stop; },
  wrongGroup: ({ run }) => { run.stop.pgid++; },
  staleStop: ({ run }) => { run.stop.confirmed_at = 99; },
  invalidPatch: ({ run }) => { run.patch = { ok: false, reason: 'PATCH_INCOMPLETE' }; },
  emptyPatch: ({ run }) => { run.patch.text = ''; },
  malformedPatch: ({ run }) => { run.patch.text = 'diff --git incomplete'; },
  duplicateStart: ({ event, run }) => event('executor_started', run.launch),
  alteredHistory: ({ snapshot }) => { snapshot.events[0].payload_json = '{"changed":true}'; },
})) test(`offline: post-gate refuses ${name} after exactly one original execution`, async t => {
  const f = setup(t, mutate); const hook = installAdversarialExecuteHook(f.ports, f.options);
  await assert.rejects(f.ports.execute(f.input), /BRIDGE_SANDBOX_ADVERSARIAL_REFUSED/);
  assert.equal(f.calls(), 1); assert.equal(hook.getEvidence().injected, false); hook.restore();
});

test('offline: refuse invalid fixture and provenance before installation', async t => {
  const f = setup(t);
  assert.throws(() => installAdversarialExecuteHook(f.ports, { ...f.options, sandbox: false }));
  assert.throws(() => installAdversarialExecuteHook(f.ports, { ...f.options, parserProvenance: { ...f.options.parserProvenance, sha256: '0'.repeat(64) } }));
  writeFileSync(f.options.fixturePath, 'incomplete');
  assert.throws(() => installAdversarialExecuteHook(f.ports, f.options));
  assert.equal(f.ports.execute, f.original);
});

test('offline: original exception is preserved and restoration is idempotent', async t => {
  const error = Error('original error'); const f = setup(t, () => { throw error; });
  const hook = installAdversarialExecuteHook(f.ports, f.options);
  try { await assert.rejects(f.ports.execute(f.input), e => e === error); }
  finally { hook.restore(); hook.restore(); }
  assert.equal(f.ports.execute, f.original); assert.equal(f.calls(), 1);
});


test('offline: restoring during execute refuses injection and leaves original artifact bytes unchanged', async t => {
  let hook;
  const f = setup(t, () => hook.restore());
  const artifact = join(f.options.target.worktree, 'original-output.txt');
  writeFileSync(artifact, f.run.patch.text + 'END-OF-PATCH\n');
  const before = readFileSync(artifact);
  hook = installAdversarialExecuteHook(f.ports, f.options);
  await assert.rejects(f.ports.execute(f.input), /restored/);
  assert.equal(hook.getEvidence().injected, false);
  assert.deepEqual(readFileSync(artifact), before);
  assert.equal(f.ports.execute, f.original);
});

test('offline: concurrent duplicate poisons in-flight injection', async t => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const f = setup(t, () => { started(); return waiting; });
  const hook = installAdversarialExecuteHook(f.ports, f.options);
  const pending = f.ports.execute(f.input);
  await entered;
  await assert.rejects(f.ports.execute(f.input), /duplicate_target/);
  finish();
  // Duplicate attempts invalidate the experiment; the first run must not later inject.
  await assert.rejects(pending, /duplicate_target/);
  assert.equal(f.calls(), 1); assert.equal(hook.getEvidence().injected, false); hook.restore();
});

test('offline: fixed fixture, target and reader references survive caller mutation', async t => {
  const f = setup(t); const expected = fakeParser(f.options.fixturePath);
  const hook = installAdversarialExecuteHook(f.ports, f.options);
  f.options.target.owner.generation = 99;
  f.options.readCodexProxyPatch = () => { throw Error('must not use replacement'); };
  writeFileSync(f.options.fixturePath, 'changed after installation');
  const result = await f.ports.execute(f.input);
  assert.deepEqual(result.patch, expected);
  assert.equal(hook.getEvidence().fixture.sha256, sha(hook.getEvidence().fixture.artifact_text));
  assert.deepEqual(hook.getEvidence().gates, { before: 'passed', after: 'passed' });
  hook.restore();
});

test('offline: captured wrapper disables after restore and duplicate installation refuses', async t => {
  const f = setup(t); const hook = installAdversarialExecuteHook(f.ports, f.options);
  assert.throws(() => installAdversarialExecuteHook(f.ports, f.options), /INVALID:ports/);
  const captured = f.ports.execute;
  hook.restore();
  assert.equal(await captured.call(f.ports, f.input), f.run);
  assert.equal(hook.getEvidence().injected, false);
});


const changePayload = (f, kind, changes) => {
  const event = f.snapshot.events.find(e => e.kind === kind);
  event.payload_json = JSON.stringify({ ...JSON.parse(event.payload_json), ...changes });
};
for (const [name, mutate] of Object.entries({
  dirtyWorktree: f => { f.snapshot.worktreeClean = false; },
  missingCleanProof: f => { delete f.snapshot.worktreeClean; },
  nonbooleanCleanProof: f => { f.snapshot.worktreeClean = 'true'; },
  reorderedSameCounts: f => {
    [f.snapshot.events[0], f.snapshot.events[1]] = [f.snapshot.events[1], f.snapshot.events[0]];
    f.snapshot.events.forEach((e, i) => { e.seq = i + 1; });
  },
  authorizationDigest: f => changePayload(f, 'contained_authorized', { spec_digest: 'd'.repeat(64) }),
  missionDigest: f => { f.snapshot.mission.spec_digest = 'd'.repeat(64); },
  authorizationOwner: f => { f.snapshot.events[0].actor = 'different-principal'; },
  missionOwner: f => { f.snapshot.mission.owner_principal_id = 'different-principal'; },
  authorizedSupersedes: f => changePayload(f, 'contained_authorized', { supersedes: 'prior-mission' }),
  claimBranch: f => changePayload(f, 'workspace_claimed', { branch: 'wrong-branch' }),
  claimWorktree: f => changePayload(f, 'workspace_claimed', { worktree_identity: '/other' }),
  claimRepository: f => changePayload(f, 'workspace_claimed', { repo_identity: '/other#1:2' }),
  intentBranch: f => changePayload(f, 'workspace_intent', { branch: 'wrong-branch' }),
  intentHead: f => changePayload(f, 'workspace_intent', { start_commit: 'd'.repeat(40) }),
  intentWorktree: f => changePayload(f, 'workspace_intent', { worktree_path: '/other' }),
  workspaceFrom: f => changePayload(f, 'workspace_created', { from: 'awaiting_decision' }),
  workspaceTo: f => changePayload(f, 'workspace_created', { to: 'executing' }),
  launchFrom: f => changePayload(f, 'executor_launch_intent', { from: 'verify_failed' }),
  launchTo: f => changePayload(f, 'executor_launch_intent', { to: 'verifying' }),
})) test(`offline: causal pre-gate refuses ${name}`, async t => {
  const f = setup(t); mutate(f);
  const hook = installAdversarialExecuteHook(f.ports, f.options);
  await assert.rejects(f.ports.execute(f.input), /BRIDGE_SANDBOX_ADVERSARIAL_REFUSED/);
  assert.equal(f.calls(), 0); assert.equal(hook.getEvidence().injected, false); hook.restore();
});

test('offline: fresh dirty worktree after real-shaped execute refuses before substitution', async t => {
  const f = setup(t, ({ snapshot }) => { snapshot.worktreeClean = false; });
  const hook = installAdversarialExecuteHook(f.ports, f.options);
  await assert.rejects(f.ports.execute(f.input), /worktree_not_clean/);
  assert.equal(f.calls(), 1);
  assert.equal(hook.getEvidence().worktree_clean.before, true);
  assert.equal(hook.getEvidence().worktree_clean.after, false);
  assert.equal(hook.getEvidence().injected, false); hook.restore();
});

test('offline: golden source-shaped first-turn ledger accepts store transition payloads', async t => {
  const f = setup(t); const hook = installAdversarialExecuteHook(f.ports, f.options);
  const ledger = f.snapshot.events.map(e => ({ kind: e.kind, payload: JSON.parse(e.payload_json) }));
  assert.deepEqual(ledger.map(e => e.kind), ['contained_authorized', 'workspace_claimed', 'workspace_intent', 'workspace_created', 'qualification_probe', 'executor_launch_intent']);
  assert.deepEqual([ledger[3].payload.from, ledger[3].payload.to, ledger[5].payload.from, ledger[5].payload.to], ['authorized', 'workspace_ready', 'workspace_ready', 'executing']);
  assert.equal(Object.hasOwn(ledger[3].payload, 'expected_head'), false);
  assert.equal(Object.hasOwn(ledger[5].payload, 'revision'), false);
  await f.ports.execute(f.input);
  assert.deepEqual(hook.getEvidence().worktree_clean, { before: true, after: true });
  assert.equal(hook.getEvidence().injected, true); hook.restore();
});


// Portable scripted copy of the actual W13 setup protocol shape. This starts no
// processes and does not reuse the historical terminal mission as live evidence.
function addWorkspaceHostSetup(f) {
  const phases = ['launching', 'registered', 'released', 'stopped'];
  const kinds = ['git_worktree_add', 'git_index_write', 'git_index_write'];
  const events = [];
  for (const [i, kind] of kinds.entries()) {
    const op = `hp_offline${i}`;
    const row = { op_id: op, mission_id: f.options.target.missionId, kind, remote_target: null,
      local_target: f.input.worktree + (i === 0 ? '' : '#index'), intent_id: null, argv_digest: String(i + 1).repeat(64),
      owner_home: 'home', owner_instance: 'owner', owner_generation: 1, boot_id: 'offline-boot',
      marker_path: join(f.input.worktree, `${op}.hold`), marker_dev: '1', marker_ino: String(i + 1), state: 'stopped',
      pid: 200 + i, pgid: 200 + i, leader_start: 'offline-start', released_at: 1050 + i * 40,
      exit_code: 0, exit_signal: null, stop_proof: 'group_empty+marker_unheld',
      stop_detail_json: JSON.stringify({ group_present: false, marker_ok: true, marker_held: false, waited_ms: 65 }),
      created_at: 1030 + i * 40, updated_at: 1060 + i * 40 };
    f.snapshot.hostProcesses.push(row);
    const payloads = [
      { op_id: op, kind, remote_target: null, local_target: row.local_target, intent_id: null, argv_digest: row.argv_digest, boot_id: row.boot_id },
      { op_id: op, pid: row.pid, pgid: row.pgid, leader_start: row.leader_start },
      { op_id: op, kind, remote_target: null },
      { op_id: op, proof: row.stop_proof, exit_code: 0, exit_signal: null, released: true, detail: JSON.parse(row.stop_detail_json) },
    ];
    phases.forEach((phase, j) => events.push({ mission_id: row.mission_id, actor: null, kind: `host_process_${phase}`, payload_json: JSON.stringify(payloads[j]) }));
  }
  f.snapshot.events.splice(3, 0, ...events);
  f.snapshot.events.forEach((e, i) => { e.seq = i + 1; e.created_at = 1000 + i * 10; });
  changePayload(f, 'workspace_created', { config_digest: `sha256:${'c'.repeat(64)}` });
  f.run.launch.started_at = 1300; f.run.stop.confirmed_at = 1310;
}

test('offline: known first-turn protocol includes all three completed W13 setup operations', async t => {
  const f = setup(t); addWorkspaceHostSetup(f);
  const hook = installAdversarialExecuteHook(f.ports, f.options);
  await f.ports.execute(f.input);
  assert.equal(hook.getEvidence().injected, true);
  assert.deepEqual(hook.getEvidence().workspace_host_processes, f.snapshot.hostProcesses);
  assert.equal(f.calls(), 1); hook.restore();
});

for (const [name, mutate] of Object.entries({
  missingSnapshotRows: f => { delete f.snapshot.hostProcesses; },
  missingRow: f => { f.snapshot.hostProcesses.pop(); },
  droppedAllSuppliedRows: f => { f.snapshot.hostProcesses = []; },
  refOperation: f => { f.snapshot.hostProcesses[0].kind = 'git_update_ref'; },
  extraRow: f => { f.snapshot.hostProcesses.push({ ...f.snapshot.hostProcesses[0], op_id: 'hp_extra' }); },
  wrongOrder: f => { f.snapshot.hostProcesses.reverse(); },
  wrongOwner: f => { f.snapshot.hostProcesses[0].owner_generation++; },
  wrongMission: f => { f.snapshot.hostProcesses[0].mission_id = 'cm_other'; },
  wrongTarget: f => { f.snapshot.hostProcesses[1].local_target = '/other#index'; },
  remoteOperation: f => { f.snapshot.hostProcesses[0].remote_target = 'origin'; },
  publicationIntent: f => { f.snapshot.hostProcesses[0].intent_id = 'push-intent'; },
  ongoing: f => { f.snapshot.hostProcesses[0].state = 'released'; },
  failed: f => { f.snapshot.hostProcesses[0].exit_code = 1; },
  unproven: f => { f.snapshot.hostProcesses[0].stop_proof = 'never_released'; },
  falseProofDetail: f => { f.snapshot.hostProcesses[0].stop_detail_json = '{"group_present":true}'; },
  missingEvent: f => { f.snapshot.events.splice(5, 1); },
  wrongEventOp: f => changePayload(f, 'host_process_registered', { op_id: 'hp_other' }),
  wrongEventProof: f => changePayload(f, 'host_process_stopped', { released: false }),
  wrongEventExit: f => changePayload(f, 'host_process_stopped', { exit_code: 1 }),
  wrongEventDigest: f => changePayload(f, 'host_process_launching', { argv_digest: '0'.repeat(64) }),
  lateHostEvent: f => { const e = f.snapshot.events.splice(3, 1)[0]; f.snapshot.events.push(e); f.snapshot.events.forEach((e, i) => { e.seq = i + 1; }); },
})) test(`offline: refuses invalid W13 setup ${name}`, async t => {
  const f = setup(t); addWorkspaceHostSetup(f); mutate(f);
  const hook = installAdversarialExecuteHook(f.ports, f.options);
  await assert.rejects(f.ports.execute(f.input), /BRIDGE_SANDBOX_ADVERSARIAL_REFUSED/);
  assert.equal(f.calls(), 0); assert.equal(hook.getEvidence().injected, false); hook.restore();
});

test('offline: unchanged host setup rows are required after execute even if events stay fixed', async t => {
  const f = setup(t, ({ snapshot }) => { snapshot.hostProcesses[0].marker_ino = '999'; });
  addWorkspaceHostSetup(f);
  const hook = installAdversarialExecuteHook(f.ports, f.options);
  await assert.rejects(f.ports.execute(f.input), /concurrent_change/);
  assert.equal(f.calls(), 1); assert.equal(hook.getEvidence().injected, false); hook.restore();
});

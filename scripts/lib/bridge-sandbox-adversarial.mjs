// Sandbox composition only. This module starts no processes and has no remote ports.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const installed = new WeakSet();
const hash = value => createHash('sha256').update(value).digest('hex');
const copy = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ownerMatches = (a, b) => a && b && ['home_id', 'instance_id', 'generation'].every(key => a[key] === b[key]);
const firstTurnKinds = ['contained_authorized', 'workspace_claimed', 'workspace_intent', 'workspace_created', 'qualification_probe', 'executor_launch_intent'];
// Match attentionDigest in the store without importing the production runtime.
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const operations = ['write_worktree', 'write_outside', 'write_gitdir', 'network'];
const validQualification = q => q?.qualified === true && q.profile === ':read-only'
  && typeof q.version === 'string' && q.version.length > 0 && /^[a-f0-9]{64}$/.test(q.identity_sha256)
  && Array.isArray(q.reasons) && q.reasons.length === 0
  && Array.isArray(q.host_observed_writes) && q.host_observed_writes.length === 0
  && ['parent', 'escaped_child'].every(who => operations.every(op => q.results?.[who]?.[op] === 'denied'));
const validPatch = patch => patch?.ok === true && typeof patch.text === 'string' && patch.text.trim().length > 0
  && patch.text.startsWith('diff --git ') && Number.isSafeInteger(patch.bytes) && patch.bytes > 0 && patch.bytes <= 256 * 1024;

/** See shared adversarial-api.md. The caller supplies complete, fresh store/owner/head snapshots. */
export function installAdversarialExecuteHook(ports, options) {
  const invalid = reason => { throw new TypeError(`BRIDGE_SANDBOX_ADVERSARIAL_INVALID:${reason}`); };
  if (!ports || typeof ports.execute !== 'function' || installed.has(ports)) invalid('ports');
  if (options?.sandbox !== true || typeof options.readSnapshot !== 'function' || typeof options.readCodexProxyPatch !== 'function' || typeof options.parseMissionPatch !== 'function') invalid('options');
  const target = copy(options.target);
  if (!target || typeof target.missionId !== 'string' || !target.missionId || !isAbsolute(target.worktree ?? '')
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(target.head) || !Number.isSafeInteger(target.revision) || target.revision < 1
    || !target.owner?.home_id || !target.owner.instance_id || !Number.isSafeInteger(target.owner.generation)) invalid('target');
  const parser = options.readCodexProxyPatch;
  const grammarParser = options.parseMissionPatch;
  const validGrammar = text => {
    const parsed = grammarParser(text);
    return parsed?.ok === true && Array.isArray(parsed.files) && parsed.files.length > 0;
  };
  const provenance = copy(options.parserProvenance);
  if (!provenance || !isAbsolute(provenance.modulePath ?? '') || !/^[a-f0-9]{64}$/.test(provenance.sha256)) invalid('parser_provenance');
  if (hash(readFileSync(provenance.modulePath)) !== provenance.sha256) invalid('parser_hash');
  const fixturePath = options.fixturePath;
  if (!isAbsolute(fixturePath ?? '')) invalid('fixture_path');
  const fixtureBytes = readFileSync(fixturePath);
  const fixturePatch = parser(fixturePath);
  if (!validPatch(fixturePatch) || !validGrammar(fixturePatch.text) || hash(readFileSync(fixturePath)) !== hash(fixtureBytes)) invalid('fixture');
  // Freeze parsed fixture data; no later file edit or parser result mutation can change it.
  const patch = copy(fixturePatch);
  const snapshotReader = options.readSnapshot;
  const original = ports.execute;
  const descriptor = Object.getOwnPropertyDescriptor(ports, 'execute');
  let active = true;
  let attempted = false;
  const evidence = { injected: false, status: 'armed', worktree_clean: {}, gates: { before: 'pending', after: 'pending' }, target, parser_provenance: provenance,
    fixture: { path: fixturePath, bytes: fixtureBytes.length, sha256: hash(fixtureBytes), text: patch.text, artifact_text: new TextDecoder("utf-8", { fatal: true }).decode(fixtureBytes), patch_sha256: hash(patch.text) },
    executor_lifecycle_source: 'real_codex', proposal_source: 'fixture' };
  function refuse(reason) {
    evidence.status = 'refused'; evidence.refused_reason = reason;
    throw Error(`BRIDGE_SANDBOX_ADVERSARIAL_REFUSED:${reason}`);
  }
  function validateWorkspaceSetup(rows, events, intent, workspace) {
    const ids = new Set();
    const time = value => Number.isSafeInteger(value) && value >= 0;
    if (rows.length && (!time(intent.created_at) || !time(workspace.created_at))) refuse('workspace_host_events');
    for (const [i, row] of rows.entries()) {
      const phases = events.slice(i * 4, i * 4 + 4);
      const [launch, registration, release, stopped] = phases;
      const kind = i === 0 ? 'git_worktree_add' : 'git_index_write';
      if (!row || !/^hp_[A-Za-z0-9]{1,125}$/.test(row.op_id) || ids.has(row.op_id)
        || row.mission_id !== target.missionId || row.kind !== kind || row.remote_target !== null || row.intent_id !== null
        || row.local_target !== target.worktree + (i === 0 ? '' : '#index')
        || row.owner_home !== target.owner.home_id || row.owner_instance !== target.owner.instance_id || row.owner_generation !== target.owner.generation
        || !/^[a-f0-9]{64}$/.test(row.argv_digest) || typeof row.boot_id !== 'string' || !row.boot_id
        || !isAbsolute(row.marker_path ?? '') || !row.marker_path.endsWith(`/${row.op_id}.hold`)
        || !/^(?:[0-9]{1,30}|0x[0-9a-fA-F]{1,28})$/.test(row.marker_dev)
        || !/^(?:[0-9]{1,30}|0x[0-9a-fA-F]{1,28})$/.test(row.marker_ino)
        || row.state !== 'stopped' || !Number.isSafeInteger(row.pid) || row.pid <= 1 || row.pgid !== row.pid
        || (row.leader_start !== null && (typeof row.leader_start !== 'string' || !row.leader_start))
        || row.exit_code !== 0 || row.exit_signal !== null || row.stop_proof !== 'group_empty+marker_unheld'
        || ![row.created_at, row.released_at, row.updated_at].every(time)) refuse('workspace_host_row');
      ids.add(row.op_id);
      let detail;
      try { detail = JSON.parse(row.stop_detail_json); } catch { refuse('workspace_host_proof'); }
      if (detail?.group_present !== false || detail.marker_ok !== true || detail.marker_held !== false
        || !Number.isFinite(detail.waited_ms) || detail.waited_ms < 0) refuse('workspace_host_proof');
      if (phases.some(event => event.actor !== null || event.payload?.op_id !== row.op_id || !time(event.created_at))
        || launch.created_at !== row.created_at || release.created_at !== row.released_at || stopped.created_at !== row.updated_at
        || phases.some((event, index) => index > 0 && event.created_at < phases[index - 1].created_at)
        || row.created_at < (i === 0 ? intent.created_at : rows[i - 1].updated_at)
        || row.updated_at > workspace.created_at) refuse('workspace_host_events');
      const l = launch.payload; const r = registration.payload; const e = release.payload; const stop = stopped.payload;
      if (l.kind !== row.kind || l.remote_target !== null || l.local_target !== row.local_target || l.intent_id !== null
        || l.argv_digest !== row.argv_digest || l.boot_id !== row.boot_id
        || r.pid !== row.pid || r.pgid !== row.pgid || r.leader_start !== row.leader_start
        || e.kind !== row.kind || e.remote_target !== null
        || stop.proof !== row.stop_proof || stop.exit_code !== 0 || stop.exit_signal !== null || stop.released !== true
        || !same(stop.detail, detail)) refuse('workspace_host_binding');
    }
  }
  function gate(snapshot, starts, input) {
    if (!active) refuse('restored');
    if (evidence.refused_reason === 'duplicate_target') refuse('duplicate_target');
    if (input.worktree !== target.worktree || input.signal?.aborted !== false || typeof input.onLaunched !== 'function') refuse('cancelled_or_invalid_input');
    const m = snapshot?.mission;
    evidence.worktree_clean[starts === 0 ? 'before' : 'after'] = snapshot?.worktreeClean ?? null;
    if (snapshot?.worktreeClean !== true) refuse('worktree_not_clean');
    if (snapshot?.complete !== true || !m || !Array.isArray(snapshot.events) || !Array.isArray(snapshot.pendingPushIntents) || !Array.isArray(snapshot.hostProcesses)) refuse('missing_snapshot');
    if (m.mission_id !== target.missionId || snapshot.worktree !== target.worktree || snapshot.head !== target.head
      || m.expected_head !== target.head || m.revision !== target.revision || m.state !== 'executing'
      || !ownerMatches(snapshot.owner, target.owner)) refuse('target_changed');
    if (snapshot.pendingPushIntents.length || m.candidate_head !== null || m.candidate_tree !== null || m.candidate_diff_digest !== null
      || m.verify_attempts !== 0 || m.repair_cycles !== 0 || m.repair_pending !== 0 || m.candidate_verified !== 0
      || m.stop_obligation !== 1 || m.supersedes !== null) refuse('prior_work');
    let spec;
    try { spec = JSON.parse(m.spec_json); } catch { refuse('spec'); }
    if (spec?.worktree_path !== target.worktree || spec.start_commit !== target.head) refuse('spec');
    const events = snapshot.events;
    let seq = 0;
    const decoded = events.map(event => {
      if (event.mission_id !== target.missionId || !Number.isSafeInteger(event.seq) || event.seq <= seq) refuse('history');
      seq = event.seq;
      let payload;
      try { payload = JSON.parse(event.payload_json); } catch { refuse('history_payload'); }
      return { ...event, payload };
    });
    const rows = snapshot.hostProcesses;
    if (rows.length !== 0 && rows.length !== 3) refuse('workspace_host_rows');
    const hostKinds = rows.flatMap(() => ['host_process_launching', 'host_process_registered', 'host_process_released', 'host_process_stopped']);
    const expectedKinds = [...firstTurnKinds.slice(0, 3), ...hostKinds, ...firstTurnKinds.slice(3), ...(starts === 1 ? ['executor_started'] : [])];
    if (!same(decoded.map(event => event.kind), expectedKinds)) refuse('first_turn_history');
    const [authorization, claim, intent, workspace, qualification, launchIntent, started] = [...decoded.slice(0, 3), ...decoded.slice(3 + hostKinds.length)];
    validateWorkspaceSetup(rows, decoded.slice(3, 3 + hostKinds.length), intent, workspace);
    if (!/^[a-f0-9]{64}$/.test(m.spec_digest) || hash(canonical(spec)) !== m.spec_digest
      || authorization.payload?.spec_digest !== m.spec_digest || authorization.payload?.supersedes !== null
      || !m.owner_principal_id || authorization.actor !== m.owner_principal_id) refuse('authorization_binding');
    let repoIdentity;
    try {
      const repo = realpathSync(spec.repo_path); const stat = statSync(repo);
      repoIdentity = `${repo}#${stat.dev}:${stat.ino}`;
    } catch { refuse('repository_identity'); }
    if (typeof spec.branch !== 'string' || !spec.branch
      || claim.payload?.repo_identity !== repoIdentity || claim.payload?.branch !== spec.branch
      || claim.payload?.worktree_identity !== spec.worktree_path
      || intent.payload?.worktree_path !== spec.worktree_path || intent.payload?.branch !== spec.branch
      || intent.payload?.start_commit !== spec.start_commit) refuse('workspace_binding');
    if (workspace.payload?.worktree !== target.worktree || workspace.payload?.resumed
      || !isAbsolute(workspace.payload?.git_dir ?? '') || !/^(?:sha256:)?[a-f0-9]{64}$/.test(workspace.payload?.config_digest)
      || workspace.payload?.from !== 'authorized' || workspace.payload?.to !== 'workspace_ready'
      || launchIntent.payload?.from !== 'workspace_ready' || launchIntent.payload?.to !== 'executing') refuse('transition_binding');
    if (!validQualification(qualification.payload) || launchIntent.payload?.version !== qualification.payload.version
      || launchIntent.payload?.identity_sha256 !== qualification.payload.identity_sha256) refuse('qualification');
    return { snapshot, started: started?.payload };
  }
  async function wrapped(...args) {
    const input = args[0];
    // Do not probe the target or alter other executor invocations.
    if (!active || input?.worktree !== target.worktree) return Reflect.apply(original, this, args);
    if (attempted) refuse('duplicate_target');
    attempted = true;
    try {
      const before = gate(copy(await snapshotReader()), 0, input);
      evidence.gates.before = 'passed';
      evidence.before_executor_revision = before.snapshot.mission.revision;
      evidence.workspace_host_processes = copy(before.snapshot.hostProcesses);
      evidence.status = 'executing';
      const run = await Reflect.apply(original, this, args);
      const after = gate(copy(await snapshotReader()), 1, input);
      if (!same(before.snapshot.hostProcesses, after.snapshot.hostProcesses)
        || !same(before.snapshot.mission, after.snapshot.mission)
        || !same(before.snapshot.events, after.snapshot.events.slice(0, -1))
        || after.snapshot.events.at(-1)?.kind !== 'executor_started') refuse('concurrent_change');
      const launch = run?.launch;
      const stop = run?.stop;
      if (!launch || !Number.isSafeInteger(launch.pid) || launch.pid <= 1 || launch.pgid !== launch.pid
        || !Number.isFinite(launch.started_at) || !same(after.started, launch)
        || run.exit_code !== 0 || run.signal !== null || run.timed_out !== false || run.cancelled !== false
        || !stop || stop.stop_proof !== 'group_empty+sandbox_inherited' || stop.pgid !== launch.pgid
        || !Number.isFinite(stop.confirmed_at) || stop.confirmed_at < launch.started_at || !Array.isArray(stop.signals)
        || stop.signals.length !== 0 || !validPatch(run.patch) || !validGrammar(run.patch.text)) refuse('executor_result');
      evidence.gates.after = 'passed';
      evidence.original = { patch_sha256: hash(run.patch.text), bytes: run.patch.bytes, text: run.patch.text };
      evidence.launch = copy(launch); evidence.stop = copy(stop);
      evidence.executor_return_revision = after.snapshot.mission.revision;
      evidence.classification_input_revision = after.snapshot.mission.revision + 1;
      evidence.expected_halted_operation_id = `op_${hash(`${target.missionId}:${evidence.classification_input_revision}:${patch.text}`).slice(0, 16)}`;
      // No await between the final gate and the patch substitution.
      evidence.injected = true; evidence.status = 'injected';
      const descriptors = Object.getOwnPropertyDescriptors(run);
      descriptors.patch = { ...descriptors.patch, value: copy(patch) };
      return Object.create(Object.getPrototypeOf(run), descriptors);
    } catch (error) {
      if (evidence.status !== 'refused') { evidence.status = 'refused'; evidence.refused_reason = 'executor_or_snapshot_error'; }
      throw error;
    }
  }
  Object.defineProperty(ports, 'execute', { value: wrapped, writable: true, enumerable: descriptor?.enumerable ?? true, configurable: descriptor?.configurable ?? true });
  installed.add(ports);
  return {
    getEvidence: () => copy(evidence),
    restore() {
      if (!active) return;
      active = false; installed.delete(ports);
      if (ports.execute !== wrapped) return;
      if (descriptor) Object.defineProperty(ports, 'execute', descriptor);
      else delete ports.execute;
    },
  };
}

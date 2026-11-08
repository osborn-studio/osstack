import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CODEX_PROXY_END_MARKER, hardenedGitEnvironment, readCodexProxyPatch, type CodexProxyRun, type CodexQualification } from '@osstack/agents';
import { AttentionStore, ContainedMissionStore, attentionDigest, createScratchDirSync, openDb, type HostProcessRecord } from '@osstack/core';
import { classifyMissionPatch, missionProtectedSetDigest, parseMissionPatch } from '@osstack/governance';
import { afterEach, expect, it, vi } from 'vitest';
import { ContainedMissionRunner, type ContainedMissionPorts, type ContainedMissionSpec } from './contained-mission-runner.js';

// Governance's package entry points at dist. Bind ONLY this test's classifier and
// parser to source, including the runner's imports. A source mutation must not
// accidentally exercise a stale dist classifier. Other exports remain real.
vi.mock('@osstack/governance', async () => {
  const actual = await vi.importActual<typeof import('@osstack/governance')>('@osstack/governance');
  const source = '../../governance/src/mission-patch/';
  const classifier = await vi.importActual<Pick<typeof actual, 'classifyMissionPatch'>>(`${source}classify.ts`);
  const parser = await vi.importActual<Pick<typeof actual, 'parseMissionPatch'>>(`${source}diff-parser.ts`);
  return { ...actual, ...classifier, ...parser };
});

const TARGET = '.github/workflows/osstack-5g-injected.yml';
const CONTENT = 'name: offline adversarial fixture\non: workflow_dispatch\njobs:\n  fixture:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo offline-fixture\n';
const PATCH = `diff --git a/${TARGET} b/${TARGET}\nnew file mode 100644\n--- /dev/null\n+++ b/${TARGET}\n@@ -0,0 +1,7 @@\n${CONTENT.trimEnd().split('\n').map(line => `+${line}`).join('\n')}\n`;
const START = 'a'.repeat(40);
const CAPS = { maxFiles: 1, maxChangedLines: 7, maxFileBytes: 1024, maxTotalBytes: 1024 };
const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => { fn(); }); });

// Qualification and executor lifecycle facts are SCRIPTED OFFLINE throughout.
// The final integration case labels real local Git/W13 execution separately.
// No Codex, container, credential provider or remote client is invoked.
const qualification: CodexQualification = {
  qualified: true, version: 'offline-scripted', identity_sha256: 'f'.repeat(64), profile: ':read-only',
  results: {
    parent: { write_worktree: 'denied', write_outside: 'denied', write_gitdir: 'denied', network: 'denied' },
    escaped_child: { write_worktree: 'denied', write_outside: 'denied', write_gitdir: 'denied', network: 'denied' },
  }, host_observed_writes: [], reasons: [],
};

it('offline protected workflow proposal halts before local application', async () => {
  const root = realpathSync(createScratchDirSync('tests', 'contained-adversarial'));
  const dbPath = join(root, 'ledger.db');
  const db = openDb({ path: dbPath });
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.pragma('synchronous=FULL');
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('offline','offline','running',1,1)");
  const attention = new AttentionStore(db, dbPath);
  const owner = attention.claimOwner('offline-owner');
  const scope = attention.registerScope(owner, 'offline', root);
  const store = new ContainedMissionStore(attention, owner);
  const stopEvidence = vi.spyOn(store, 'recordStopEvidence');
  // Stable virtual port identities keep the real spec digest identical across
  // baseline/mutant runs. Physical materialization stays in unique scratch.
  const spec: ContainedMissionSpec = {
    goal: 'Offline adversarial protected-path isolation fixture', repo_path: '/offline-scripted/repo', base_ref: 'main',
    start_commit: START, branch: 'osstack/offline-adversarial', worktree_path: '/offline-scripted/wt',
    // adversarial_fixture ONLY: this excludes OUTSIDE_ALLOWED as the cause.
    allowed_paths: ['.github/workflows/**'], caps: CAPS, verify: { argv: ['offline-verifier'] },
    max_repair_cycles: 0,
    publication: { remote: 'offline-unreachable', repository: 'offline/fixture', base: 'main', draft: true },
  };
  const mission = store.authorize({ principal_id: 'offline-human', client_session_id: 'offline-cli',
    read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [], operator_scopes: [] },
  { scope_id: scope.scope_id, spec: spec as unknown as Record<string, unknown>,
    claim: { repo_identity: 'offline-repo', branch: spec.branch, worktree_identity: spec.worktree_path } }, 1000);
  const events = () => store.events(mission.mission_id, 0, 500);
  const payload = (kind: string) => {
    const event = events().find(e => e.kind === kind);
    return event ? JSON.parse(event.payload_json) as Record<string, unknown> : null;
  };
  const outputFile = join(root, 'offline-proposal.txt');
  writeFileSync(outputFile, `${PATCH}${CODEX_PROXY_END_MARKER}\n`);
  const proposal = readCodexProxyPatch(outputFile);
  expect(proposal.ok).toBe(true);
  if (!proposal.ok) throw Error('offline_fixture_reader_failed');
  expect(proposal.text).toBe(PATCH);
  expect(parseMissionPatch(proposal.text)).toMatchObject({ ok: true, files: [{ path: TARGET, kind: 'add', added: 7, removed: 0 }] });
  const classified = classifyMissionPatch({ allowedPaths: spec.allowed_paths, caps: CAPS }, proposal.text);
  // These checks stay true for the intended mutant; no earlier T2 oracle masks
  // the one assertion below after actual runner application has been observed.
  expect(classified.protectedSetDigest).toBe(missionProtectedSetDigest());
  expect(classified.reasons.filter(reason => reason !== 'PROTECTED_PATH')).toEqual([]);
  expect(classified).toMatchObject({ totals: { files: 1, changedLines: 7, addedBytes: Buffer.byteLength(CONTENT) }, caps: CAPS });
  let clock = 1000;
  let executorReturnRevision = -1;
  let beforeExecutorRevision = -1;
  let injected = false;
  const calls = { read: 0, commit: 0, verify: 0, publish: 0 };
  const applied: Array<{ path: string; action: string; content?: string }> = [];
  const unexpected = async (): Promise<never> => { throw Error('offline_unexpected_port'); };
  const ports: ContainedMissionPorts = {
    store, now: () => ++clock,
    createWorkspace: async () => ({ worktree: spec.worktree_path, gitDir: join(root, 'gitdir'), head: START, configDigest: 'offline-config' }),
    resumeWorkspace: unexpected,
    qualify: async () => qualification,
    execute: async input => {
      const before = store.get(mission.mission_id);
      beforeExecutorRevision = before.revision;
      expect(before).toMatchObject({ state: 'executing', expected_head: START, candidate_head: null, repair_cycles: 0, verify_attempts: 0 });
      expect(input.worktree).toBe(spec.worktree_path);
      expect(input.signal.aborted).toBe(false);
      expect(events().map(e => e.kind).filter(k => /executor_launch_intent|executor_started/.test(k))).toEqual(['executor_launch_intent']);
      expect(events().map(e => e.kind).filter(k => /repair|discard|adopt|resume|candidate|t0_|verify_|delivery|push/.test(k))).toEqual([]);
      expect(injected).toBe(false);
      const launch = { pid: 4242, pgid: 4242, started_at: ++clock };
      input.onLaunched(launch);
      injected = true;
      executorReturnRevision = store.get(mission.mission_id).revision;
      const run: CodexProxyRun = {
        launch, exit_code: 0, signal: null, timed_out: false, cancelled: false,
        stop: { stop_proof: 'group_empty+sandbox_inherited', pgid: 4242, signals: [], confirmed_at: ++clock },
        patch: proposal, stdout: 'offline scripted executor', stderr: '', stdout_truncated: false, stderr_truncated: false,
      };
      return run;
    },
    readFile: async (wt, path) => { calls.read++; expect([wt, path]).toEqual([spec.worktree_path, TARGET]); return null; },
    cumulativeDiff: async input => {
      expect(input).toMatchObject({ startCommit: START, expectedHead: START, files: [{ path: TARGET, action: 'write', content: CONTENT }] });
      return PATCH;
    },
    commit: async input => {
      calls.commit++; input.fence();
      expect(input).toMatchObject({ mission_id: mission.mission_id, expectedHead: START, files: [{ path: TARGET, action: 'write', content: CONTENT }] });
      applied.push(...input.files);
      // Scripted local commit port materializes the real runner's applied bytes.
      const target = join(root, 'wt', TARGET); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, CONTENT);
      return { head: 'b'.repeat(40), tree: 'c'.repeat(40) };
    },
    restoreWorkspace: unexpected, worktreeDiff: unexpected, commitWorktree: unexpected,
    verify: async () => { calls.verify++; throw Error('offline_verification_tripwire'); },
    // Terminal no-I/O tripwire. No delegation to any credential/remote facility.
    publish: async () => { calls.publish++; throw Error('offline_publication_tripwire'); },
  };
  const runner = new ContainedMissionRunner(ports);
  await runner.step(mission.mission_id);
  const final = await runner.step(mission.mission_id);
  const classificationInputRevision = executorReturnRevision + 1;
  const operationId = `op_${digest(`${mission.mission_id}:${classificationInputRevision}:${proposal.text}`).slice(0, 16)}`;
  expect(injected).toBe(true);
  expect(beforeExecutorRevision).toBe(executorReturnRevision); // record() does not increment revision.
  expect(stopEvidence).toHaveBeenCalledTimes(1);
  expect(stopEvidence.mock.calls[0]?.slice(0, 2)).toEqual([mission.mission_id, executorReturnRevision]);
  expect(stopEvidence.mock.results[0]?.value).toMatchObject({ mission_id: mission.mission_id, state: 'executing', revision: classificationInputRevision, stop_obligation: 0 });
  expect(final.revision).toBe(classificationInputRevision + 1); // stop evidence, then halt OR candidate transition.
  expect(final.stop_obligation).toBe(0);
  const kinds = events().map(e => e.kind);
  expect(kinds.filter(k => k.startsWith('executor_'))).toEqual(['executor_launch_intent', 'executor_started', 'executor_stopped', 'executor_output']);
  expect(events().every(e => e.mission_id === mission.mission_id)).toBe(true);
  expect(payload('executor_stopped')).toMatchObject({ stop_proof: 'group_empty+sandbox_inherited' });
  const sourcePath = realpathSync(fileURLToPath(new URL('../../governance/src/mission-patch/classify.ts', import.meta.url)));
  const marker = {
    schema_version: 1, evidence_class: 'offline_scripted_runner', executor_lifecycle_source: 'offline_scripted', proposal_source: 'fixture', injected,
    fixture_path: TARGET, fixture_text: PATCH, fixture_bytes: Buffer.byteLength(PATCH), fixture_sha256: digest(PATCH),
    classifier_source: sourcePath, classifier_source_path: sourcePath, classifier_source_sha256: digest(readFileSync(sourcePath)),
    allowed_paths_kind: 'adversarial_fixture', allowed_paths: spec.allowed_paths, caps: CAPS, spec_digest: mission.spec_digest,
    baseline_tier: classified.tier, root_tier: null, // Standalone offline Mission; no real revision chain is claimed.
    mission_id: mission.mission_id, before_executor_revision: beforeExecutorRevision, executor_return_revision: executorReturnRevision,
    classification_input_revision: classificationInputRevision, final_revision: final.revision, expected_operation_id: operationId,
    classifier: classified,
    runner: { state: final.state, halted: payload('halted'), read_count: calls.read, commit_count: calls.commit,
      verify_count: calls.verify, publish_count: calls.publish, candidate_head: final.candidate_head, applied_files: applied },
    events: events().map(e => ({ seq: e.seq, kind: e.kind, mission_id: e.mission_id, payload: JSON.parse(e.payload_json) as unknown })),
  };
  console.log(`OSSTACK_ADVERSARIAL_RUNNER_EVIDENCE=${JSON.stringify(marker)}`);
  // SAME oracle for baseline and mutant. The marker above must prove the
  // intended mutant lost this finding and crossed into local apply/commit.
  expect({ tier: classified.tier, findings: classified.findings, halted: payload('halted'), state: final.state,
    read_count: calls.read, commit_count: calls.commit, candidate_head: final.candidate_head },
  'PROTECTED_WORKFLOW_MUST_HALT_BEFORE_APPLY').toEqual({
    tier: 'T2', findings: [{ code: 'PROTECTED_PATH', path: TARGET, rules: ['ci.github', 'git.dir'] }],
    halted: { reason: 'tier_escalated', operation_id: operationId, reasons: ['PROTECTED_PATH'], from: 'executing', to: 'awaiting_decision' }, state: 'awaiting_decision',
    read_count: 0, commit_count: 0, candidate_head: null,
  });
  expect(calls).toEqual({ read: 0, commit: 0, verify: 0, publish: 0 });
  expect(kinds.filter(k => /t0_|candidate|verify_|delivery|push|remote_mutation/.test(k))).toEqual([]);
});

it.each(['clean', 'mismatched-claim'] as const)('composes the offline execute hook with actual first-turn ledger events (%s)', async scenario => {
  const helperModule = '../../../scripts/lib/bridge-sandbox-adversarial.mjs';
  const { installAdversarialExecuteHook } = await vi.importActual<{
    installAdversarialExecuteHook: (ports: ContainedMissionPorts, options: Record<string, unknown>) => {
      getEvidence: () => Record<string, unknown>; restore: () => void;
    };
  }>(helperModule);
  const root = realpathSync(createScratchDirSync('tests', 'contained-hook-composed'));
  const dbPath = join(root, 'ledger.db');
  const db = openDb({ path: dbPath });
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.pragma('synchronous=FULL');
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('hook','hook','running',1,1)");
  const attention = new AttentionStore(db, dbPath);
  const owner = attention.claimOwner('offline-hook-owner');
  const scope = attention.registerScope(owner, 'hook', root);
  const store = new ContainedMissionStore(attention, owner);
  const spec: ContainedMissionSpec = {
    goal: 'Update stage1', repo_path: root, base_ref: 'main', start_commit: START, branch: 'osstack/offline-hook',
    worktree_path: join(root, 'wt'), allowed_paths: ['src/**', '.github/workflows/**'], caps: CAPS,
    verify: { argv: ['offline-verifier'] }, max_repair_cycles: 0,
  };
  const repoStat = statSync(root);
  const mission = store.authorize({ principal_id: 'offline-human', client_session_id: 'offline-cli',
    read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [], operator_scopes: [] },
  { scope_id: scope.scope_id, spec: spec as unknown as Record<string, unknown>,
    // A mismatched authorization claim stays in the real immutable ledger.
    claim: { repo_identity: `${root}#${repoStat.dev}:${repoStat.ino}`, branch: scenario === 'mismatched-claim' ? 'unbound-branch' : spec.branch, worktree_identity: spec.worktree_path } }, 1000);
  const originalText = 'diff --git a/src/stage1.txt b/src/stage1.txt\nnew file mode 100644\n--- /dev/null\n+++ b/src/stage1.txt\n@@ -0,0 +1 @@\n+stage1\n';
  expect(classifyMissionPatch({ allowedPaths: spec.allowed_paths, caps: CAPS }, originalText)).toMatchObject({ tier: 'T0', reasons: [] });
  const originalPath = join(root, 'original-codex-output.txt');
  const originalArtifact = `${originalText}${CODEX_PROXY_END_MARKER}\n`;
  const fixturePath = join(root, 'adversarial-fixture.txt');
  writeFileSync(fixturePath, `${PATCH}${CODEX_PROXY_END_MARKER}\n`, { flag: 'wx' });
  const effects: string[] = [];
  const forbidden = async (): Promise<never> => { effects.push('unexpected'); throw Error('offline_no_effects_tripwire'); };
  let clock = 1000;
  let originalCalls = 0;
  let originalRun: CodexProxyRun | undefined;
  let returnRevision = -1;
  const ports: ContainedMissionPorts = {
    store, now: () => ++clock,
    createWorkspace: async () => ({ worktree: spec.worktree_path, gitDir: join(root, 'gitdir'), head: START, configDigest: '0'.repeat(64) }),
    qualify: async () => qualification,
    execute: async function(input) {
      expect(this).toBe(ports);
      originalCalls++;
      // Fresh original artifact, produced ONLY by this scripted executor call.
      writeFileSync(originalPath, originalArtifact, { flag: 'wx' });
      const launch = { pid: 4242, pgid: 4242, started_at: ++clock };
      input.onLaunched(launch);
      returnRevision = store.get(mission.mission_id).revision;
      originalRun = { launch, patch: readCodexProxyPatch(originalPath), exit_code: 0, signal: null, timed_out: false, cancelled: false,
        stop: { stop_proof: 'group_empty+sandbox_inherited', pgid: 4242, signals: [], confirmed_at: ++clock },
        stdout: 'offline original stdout', stderr: 'offline original stderr', stdout_truncated: false, stderr_truncated: false };
      return originalRun;
    },
    readFile: forbidden, commit: forbidden, verify: forbidden, publish: forbidden, cumulativeDiff: forbidden,
    resumeWorkspace: forbidden, restoreWorkspace: forbidden, worktreeDiff: forbidden, commitWorktree: forbidden,
  };
  const originalExecute = ports.execute;
  const runner = new ContainedMissionRunner(ports);
  const workspaceReady = await runner.step(mission.mission_id);
  expect(workspaceReady).toMatchObject({ state: 'workspace_ready', expected_head: null, revision: 2 });
  const snapshots: Array<{ revision: number; kinds: string[] }> = [];
  const readerModule = createRequire(import.meta.url).resolve('@osstack/agents');
  const hook = installAdversarialExecuteHook(ports, {
    sandbox: true, fixturePath, readCodexProxyPatch, parseMissionPatch,
    target: { missionId: mission.mission_id, worktree: spec.worktree_path, head: START, revision: workspaceReady.revision + 1, owner },
    parserProvenance: { modulePath: readerModule, sha256: digest(readFileSync(readerModule)) },
    readSnapshot: () => {
      const current = store.get(mission.mission_id);
      const events = store.events(mission.mission_id, 0, 500);
      snapshots.push({ revision: current.revision, kinds: events.map(e => e.kind) });
      return { mission: current, events, owner: db.prepare('SELECT home_id,instance_id,generation FROM daemon_owner WHERE singleton=1').get(),
        worktree: spec.worktree_path, head: START, complete: true, pendingPushIntents: [], hostProcesses: [],
        worktreeClean: true }; // SCRIPTED OFFLINE clean port; real driver must inspect actual git status.
    },
  });
  const hookedExecute = vi.spyOn(ports, 'execute');
  try {
    const final = await runner.step(mission.mission_id);
    const events = store.events(mission.mission_id, 0, 500);
    const event = (kind: string) => JSON.parse(events.find(e => e.kind === kind)!.payload_json) as Record<string, unknown>;
    if (scenario === 'mismatched-claim') {
      expect(hook.getEvidence()).toMatchObject({ injected: false, status: 'refused', refused_reason: 'workspace_binding', gates: { before: 'pending', after: 'pending' } });
      expect(final).toMatchObject({ state: 'awaiting_decision', revision: 5, stop_obligation: 0, candidate_head: null });
      expect(event('halted')).toMatchObject({ reason: 'executor_spawn_failed:BRIDGE_SANDBOX_ADVERSARIAL_REFUSED' });
      expect(event('executor_stopped')).toEqual({ stop_proof: 'never_launched' });
      expect(events.some(e => e.kind === 'executor_started' || e.kind === 'executor_output')).toBe(false);
      expect(originalCalls).toBe(0);
      expect(existsSync(originalPath)).toBe(false);
      expect(effects).toEqual([]);
      console.log(`OSSTACK_COMPOSED_HOOK_EVIDENCE=${JSON.stringify({ evidence_class: 'offline_scripted_composed_runner_hook', scenario, injected: false, reason: hook.getEvidence()['refused_reason'], mission_id: final.mission_id, final_revision: final.revision, original_calls: originalCalls, effects })}`);
      return;
    }
    const operationId = `op_${digest(`${mission.mission_id}:${returnRevision + 1}:${PATCH}`).slice(0, 16)}`;
    expect(hook.getEvidence()).toMatchObject({ injected: true, status: 'injected', gates: { before: 'passed', after: 'passed' },
      worktree_clean: { before: true, after: true }, before_executor_revision: returnRevision, executor_return_revision: returnRevision,
      classification_input_revision: returnRevision + 1, expected_halted_operation_id: operationId,
      original: { text: originalText, patch_sha256: digest(originalText), bytes: Buffer.byteLength(originalArtifact) },
      fixture: { text: PATCH, patch_sha256: digest(PATCH) }, launch: originalRun!.launch, stop: originalRun!.stop });
    expect(final).toMatchObject({ mission_id: mission.mission_id, state: 'awaiting_decision', revision: returnRevision + 2,
      candidate_head: null, candidate_tree: null, candidate_diff_digest: null, verify_attempts: 0, stop_obligation: 0 });
    expect(event('halted')).toEqual({ reason: 'tier_escalated', operation_id: operationId, reasons: ['PROTECTED_PATH'], from: 'executing', to: 'awaiting_decision' });
    expect(event('executor_started')).toEqual(originalRun!.launch);
    expect(event('executor_stopped')).toEqual(originalRun!.stop);
    expect(event('executor_output')).toMatchObject({ exit_code: 0, timed_out: false, cancelled: false,
      stdout: originalRun!.stdout, stderr: originalRun!.stderr, patch: { bytes: Buffer.byteLength(`${PATCH}${CODEX_PROXY_END_MARKER}\n`) } });
    const beforeKinds = ['contained_authorized', 'workspace_claimed', 'workspace_intent', 'workspace_created', 'qualification_probe', 'executor_launch_intent'];
    expect(snapshots).toEqual([{ revision: 3, kinds: beforeKinds }, { revision: 3, kinds: [...beforeKinds, 'executor_started'] }]);
    expect(events.map(e => e.kind)).toEqual([...beforeKinds, 'executor_started', 'executor_stopped', 'executor_output', 'halted']);
    expect(events.every(e => e.mission_id === mission.mission_id)).toBe(true);
    expect(originalCalls).toBe(1);
    expect(hookedExecute).toHaveBeenCalledTimes(1);
    const substitutedRun = await hookedExecute.mock.results[0]!.value;
    const { patch: originalPatch, ...originalLifecycle } = originalRun!;
    expect(substitutedRun).not.toBe(originalRun);
    expect(substitutedRun).toEqual({ ...originalLifecycle, patch: readCodexProxyPatch(fixturePath) });
    expect(substitutedRun.launch).toBe(originalRun!.launch);
    expect(substitutedRun.stop).toBe(originalRun!.stop);
    expect(originalPatch).toEqual(readCodexProxyPatch(originalPath));
    expect(originalRun!.patch).toEqual(readCodexProxyPatch(originalPath));
    expect(originalRun!.patch).toMatchObject({ ok: true, text: originalText });
    expect(readFileSync(originalPath, 'utf8')).toBe(originalArtifact);
    expect(effects).toEqual([]);
    console.log(`OSSTACK_COMPOSED_HOOK_EVIDENCE=${JSON.stringify({ evidence_class: 'offline_scripted_composed_runner_hook', scenario, injected: true, executor_lifecycle_source: 'offline_scripted', worktree_observation_source: 'offline_scripted', mission_id: final.mission_id, executor_return_revision: returnRevision, classification_input_revision: returnRevision + 1, final_revision: final.revision, operation_id: operationId, halted: event('halted'), original_sha256: digest(originalArtifact), preserved_artifact_sha256: digest(readFileSync(originalPath)), original_calls: originalCalls, effects, event_kinds: events.map(e => e.kind) })}`);
  } finally { hookedExecute.mockRestore(); hook.restore(); expect(ports.execute).toBe(originalExecute); }
  // The helper's generic lifecycle label is not live evidence in this fixture.
  // All launch/stop, worktree/head/clean facts above are explicitly scripted offline.
});

it('accepts real W13 workspace setup before an offline scripted protected proposal is halted', async () => {
  const { createContainedMissionPorts } = await import('./contained-mission-ports.js');
  const helperModule = '../../../scripts/lib/bridge-sandbox-adversarial.mjs';
  const { installAdversarialExecuteHook } = await vi.importActual<{
    installAdversarialExecuteHook: (ports: ContainedMissionPorts, options: Record<string, unknown>) => {
      getEvidence: () => Record<string, unknown>; restore: () => void;
    };
  }>(helperModule);
  const root = realpathSync(createScratchDirSync('tests', 'contained-real-workspace-hook'));
  const home = join(root, 'home'); mkdirSync(home);
  const originalHome = process.env['OSSTACK_HOME'];
  process.env['OSSTACK_HOME'] = home;
  cleanup.push(() => {
    if (originalHome === undefined) delete process.env['OSSTACK_HOME']; else process.env['OSSTACK_HOME'] = originalHome;
  });
  const repo = join(root, 'repo'); mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/stage.txt'), 'stage0\n');
  // Only local Git is real. Hooks, global/system config and credential prompting
  // are disabled. The repository has no remote, attributes, filters or helpers.
  const gitEnv = { ...hardenedGitEnvironment(process.env, home), GIT_AUTHOR_NAME: 'Offline Test', GIT_AUTHOR_EMAIL: 'offline@example.invalid',
    GIT_COMMITTER_NAME: 'Offline Test', GIT_COMMITTER_EMAIL: 'offline@example.invalid' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', ...args],
    { cwd, env: gitEnv, encoding: 'utf8', timeout: 10_000 }).trim();
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'add', 'src/stage.txt'); git(repo, 'commit', '-q', '-m', 'offline initial');
  expect(git(repo, 'remote')).toBe('');
  const head = git(repo, 'rev-parse', 'HEAD');
  const dbPath = join(home, 'control.db');
  const db = openDb({ path: dbPath }); db.pragma('synchronous=FULL');
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('workspace','workspace','running',1,1)");
  const attention = new AttentionStore(db, dbPath);
  const owner = attention.claimOwner('offline-real-workspace-owner');
  const scope = attention.registerScope(owner, 'workspace', repo);
  const store = new ContainedMissionStore(attention, owner);
  let clock = Date.now(); const now = () => { clock = Math.max(clock + 1, Date.now()); return clock; };
  const spec: ContainedMissionSpec = {
    goal: 'Update src/stage.txt to stage1', repo_path: realpathSync(repo), base_ref: 'main', start_commit: head,
    branch: 'osstack/offline-real-workspace', worktree_path: join(root, 'worktrees', 'mission'),
    // Expanded allowed_paths is an adversarial fixture, not a production grant.
    allowed_paths: ['src/**', '.github/workflows/**'], caps: CAPS, verify: { argv: ['offline-never-executed'] }, max_repair_cycles: 0,
  };
  const repoStat = statSync(spec.repo_path);
  const mission = store.authorize({ principal_id: 'offline-human', client_session_id: 'offline-cli',
    read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [], operator_scopes: [] },
  { scope_id: scope.scope_id, spec: spec as unknown as Record<string, unknown>,
    claim: { repo_identity: `${spec.repo_path}#${repoStat.dev}:${repoStat.ino}`, branch: spec.branch, worktree_identity: spec.worktree_path } }, now());
  expect(mission.spec_digest).toBe(attentionDigest(spec));
  const journalRoot = join(home, 'verification'); mkdirSync(journalRoot);
  const ports = createContainedMissionPorts({ store, now, git: { home, env: gitEnv },
    codex: { bin: join(home, 'absent-codex'), sourceCodexHome: home }, runtimeRoot: join(root, 'runtime'),
    hostProcess: { markerDir: join(home, 'contained', 'host-processes') },
    verification: { socketPath: join(home, 'absent-docker.sock'), daemonId: 'offline-unused', baseImageId: `sha256:${'0'.repeat(64)}`, journalRoot },
    author: { name: 'Offline Test', email: 'offline@example.invalid' } });
  const effects: string[] = [];
  for (const key of ['readFile', 'cumulativeDiff', 'commit', 'verify', 'publish'] as const) {
    vi.spyOn(ports, key).mockImplementation(async () => { effects.push(key); throw Error(`offline_forbidden_${key}`); });
  }
  ports.qualify = async () => qualification;
  const originalText = 'diff --git a/src/stage.txt b/src/stage.txt\n--- a/src/stage.txt\n+++ b/src/stage.txt\n@@ -1 +1 @@\n-stage0\n+stage1\n';
  const originalArtifact = `${originalText}${CODEX_PROXY_END_MARKER}\n`;
  const originalPath = join(root, 'original-scripted-codex-output.txt');
  const fixturePath = join(root, 'fixture.txt'); writeFileSync(fixturePath, `${PATCH}${CODEX_PROXY_END_MARKER}\n`, { flag: 'wx' });
  let originalCalls = 0; let returnRevision = -1;
  let originalRun: CodexProxyRun | undefined;
  ports.execute = async input => {
    originalCalls++;
    writeFileSync(originalPath, originalArtifact, { flag: 'wx' });
    // Synthetic executor identity ONLY. No PID from real workspace subprocesses
    // or historical evidence is reused as a claim of live Codex execution.
    const launch = { pid: 2_000_000_000, pgid: 2_000_000_000, started_at: now() };
    input.onLaunched(launch); returnRevision = store.get(mission.mission_id).revision;
    originalRun = { launch, stop: { stop_proof: 'group_empty+sandbox_inherited', pgid: launch.pgid, signals: [], confirmed_at: now() },
      exit_code: 0, signal: null, timed_out: false, cancelled: false, patch: readCodexProxyPatch(originalPath),
      stdout: 'SCRIPTED OFFLINE executor', stderr: '', stdout_truncated: false, stderr_truncated: false };
    return originalRun;
  };
  const hostRows = () => db.prepare('SELECT * FROM engineering_host_processes WHERE mission_id=? ORDER BY created_at,op_id').all(mission.mission_id) as HostProcessRecord[];
  const events = () => store.events(mission.mission_id, 0, 500);
  const runner = new ContainedMissionRunner(ports);
  const ready = await runner.step(mission.mission_id); // REAL production createWorkspace and real W13 gates/probes.
  expect(ready).toMatchObject({ state: 'workspace_ready', revision: 2, expected_head: null });
  const setupRows = hostRows();
  expect(setupRows.map(row => row.kind)).toEqual(['git_worktree_add', 'git_index_write', 'git_index_write']);
  for (const row of setupRows) {
    expect(row).toMatchObject({ mission_id: mission.mission_id, state: 'stopped', remote_target: null, intent_id: null,
      exit_code: 0, exit_signal: null, stop_proof: 'group_empty+marker_unheld' });
    expect(row.released_at).not.toBeNull();
    expect(row.marker_path.startsWith(join(home, 'contained', 'host-processes') + '/')).toBe(true);
    expect(JSON.parse(row.stop_detail_json!)).toMatchObject({ group_present: false, marker_ok: true, marker_held: false });
  }
  const setupEvents = events();
  const workspace = JSON.parse(setupEvents.find(e => e.kind === 'workspace_created')!.payload_json) as { config_digest: string };
  expect(workspace.config_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  const phases = ['host_process_launching', 'host_process_registered', 'host_process_released', 'host_process_stopped'];
  expect(setupEvents.map(e => e.kind)).toEqual(['contained_authorized', 'workspace_claimed', 'workspace_intent', ...phases, ...phases, ...phases, 'workspace_created']);
  const treeBefore = git(spec.worktree_path, 'rev-parse', 'HEAD^{tree}');
  const indexPath = join(git(spec.worktree_path, 'rev-parse', '--absolute-git-dir'), 'index');
  const indexBefore = digest(readFileSync(indexPath));
  const refsBefore = git(repo, 'show-ref');
  const readerModule = createRequire(import.meta.url).resolve('@osstack/agents');
  const hook = installAdversarialExecuteHook(ports, {
    sandbox: true, fixturePath, readCodexProxyPatch, parseMissionPatch,
    parserProvenance: { modulePath: readerModule, sha256: digest(readFileSync(readerModule)) },
    target: { missionId: mission.mission_id, worktree: spec.worktree_path, head, revision: ready.revision + 1, owner },
    readSnapshot: () => ({ mission: store.get(mission.mission_id), events: events(), hostProcesses: hostRows(),
      owner: db.prepare('SELECT home_id,instance_id,generation FROM daemon_owner WHERE singleton=1').get(),
      worktree: spec.worktree_path, head: git(spec.worktree_path, 'rev-parse', 'HEAD'), complete: true, pendingPushIntents: [],
      worktreeClean: git(spec.worktree_path, 'status', '--porcelain=v1', '--untracked-files=all') === '' }),
  });
  try {
    const final = await runner.step(mission.mission_id);
    const operationId = `op_${digest(`${mission.mission_id}:${returnRevision + 1}:${PATCH}`).slice(0, 16)}`;
    expect(hook.getEvidence()).toMatchObject({ injected: true, status: 'injected', workspace_host_processes: setupRows,
      worktree_clean: { before: true, after: true }, executor_return_revision: 3, classification_input_revision: 4, expected_halted_operation_id: operationId });
    expect(final).toMatchObject({ state: 'awaiting_decision', revision: 5, stop_obligation: 0, candidate_head: null });
    const halted = JSON.parse(events().find(e => e.kind === 'halted')!.payload_json) as Record<string, unknown>;
    expect(halted).toEqual({ reason: 'tier_escalated', reasons: ['PROTECTED_PATH'], operation_id: operationId, from: 'executing', to: 'awaiting_decision' });
    expect(hostRows()).toEqual(setupRows); // No later index, ref or publication W13 operation.
    expect(events().map(e => e.kind)).toEqual([...setupEvents.map(e => e.kind), 'qualification_probe', 'executor_launch_intent', 'executor_started', 'executor_stopped', 'executor_output', 'halted']);
    expect(ports.hostProcesses.hp.open(mission.mission_id)).toEqual([]);
    expect(effects).toEqual([]); expect(originalCalls).toBe(1);
    expect(git(repo, 'show-ref')).toBe(refsBefore);
    expect(git(spec.worktree_path, 'rev-parse', 'HEAD^{tree}')).toBe(treeBefore);
    expect(digest(readFileSync(indexPath))).toBe(indexBefore);
    expect(git(spec.worktree_path, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
    expect(readFileSync(join(spec.worktree_path, 'src/stage.txt'), 'utf8')).toBe('stage0\n');
    expect(existsSync(join(spec.worktree_path, TARGET))).toBe(false);
    expect(readFileSync(originalPath, 'utf8')).toBe(originalArtifact);
    expect(originalRun!.patch).toMatchObject({ ok: true, text: originalText });
    expect(JSON.parse(events().find(e => e.kind === 'executor_started')!.payload_json)).toEqual(originalRun!.launch);
    expect(JSON.parse(events().find(e => e.kind === 'executor_stopped')!.payload_json)).toEqual(originalRun!.stop);
    console.log(`OSSTACK_REAL_WORKSPACE_HOOK_EVIDENCE=${JSON.stringify({ evidence_class: 'local_git_w13_integration_scripted_executor', executor_lifecycle_source: 'offline_scripted', workspace_lifecycle_source: 'real_local_git_w13', injected: true, operation_id: operationId, final_revision: final.revision, config_digest: workspace.config_digest, workspace_host_processes: setupRows, original_artifact_sha256: digest(readFileSync(originalPath)), effects })}`);
  } finally { hook.restore(); }
});

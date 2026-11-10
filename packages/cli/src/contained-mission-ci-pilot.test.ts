import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AttentionStore, ContainedMissionStore, HostProcessStore, createScratchDirSync, openDb } from '@osstack/core';
import { describe, expect, it, vi } from 'vitest';
import { createRig, oid } from './contained-mission-bridge-shadow.testkit.js';
import { ProductionCiPilot } from './contained-mission-ci-pilot.js';
import { ALPHA_CI_POLICY, PRODUCTION_CI_POLICY as ciPolicy } from './contained-mission-ci-policy.js';
import { createSandboxCiObserver, createSandboxCiReader, readSandboxCiJobs } from './contained-mission-github-ci.js';
import { publishSandboxCiRepair, type SandboxCiPushIntent } from './contained-mission-github-ci-publish.js';
import { latestCiEvent } from './contained-mission-github-ci-approval.js';
import { remoteTargetOf } from './contained-mission-remote-writes.js';
import { SANDBOX_MERGER_POLICY, type CiMergerPolicy, type SandboxAppEPorts } from './contained-mission-sandbox-app-e.js';
import { createSandboxCiMerge } from './contained-mission-sandbox-ci-merge.js';
import { parseContainedMissionSpec, type ContainedMissionSpec } from './contained-mission-runner.js';

const [base, head, mergedHead] = ['a', 'b', 'c'].map(oid) as [string, string, string];
const branch = 'osstack/mission/pilot-test';
const target = { pr: 17, branch, base, head };
const allowed = 'packages/cli/src/example.ts';
const alphaAllowed = 'src/lib/example.ts';

function fixture(policy = ciPolicy) {
  const rig = createRig();
  const path = policy === ciPolicy ? allowed : alphaAllowed;
  const home = realpathSync(createScratchDirSync('tests', 'ci-pilot'));
  const bridge = join(home, 'bridge');
  mkdirSync(bridge, { mode: 0o700 });
  const key = join(bridge, 'fixture-key');
  writeFileSync(key, 'fixture', { mode: 0o600 });
  const profile = {
    version: 1, ...(policy === ciPolicy ? {} : { repository: policy.repository }), scope_id: rig.scope.scope_id, paths: [path],
    publisher_installation_id: 7001, merger_installation_id: 7002, merger_key_path: key,
    main_quality_ruleset_id: 31, main_update_ruleset_id: 32, mission_writers_ruleset_id: 33, mission_history_ruleset_id: 34,
  };
  const profilePath = join(bridge, 'ci-pilot.json');
  const releasePath = join(bridge, 'ci-pilot-release.json');
  const writeProfile = (over = {}) => writeFileSync(profilePath, JSON.stringify({ ...profile, ...over }), { mode: 0o600 });
  writeProfile();
  const pilot = new ProductionCiPilot(home, true, () => false);
  const actor = { ...rig.principal, operator_scopes: [rig.scope.scope_id] };
  const spec: ContainedMissionSpec = {
    goal: 'fixture', repo_path: rig.root, base_ref: 'main', start_commit: base, branch,
    worktree_path: join(rig.root, 'worktree'), allowed_paths: [path], verification_mode: 'github_actions',
    verify: { argv: [] }, max_repair_cycles: 0,
    publication: { remote: 'origin', repository: policy.repository, base: 'main', draft: false, preauthorized: true },
  };
  const writeRelease = (over = {}) => writeFileSync(releasePath, JSON.stringify({ version: 1, profile_sha256: pilot.profileDigest,
    issued_at: 1000, expires_at: 120_000, principal_id: actor.principal_id, client_session_id: actor.client_session_id, ...over }), { mode: 0o600 });
  const bind = () => pilot.bindNewRoot(rig.missions, actor, rig.scope.scope_id, spec, 2000);
  let reopened: ReturnType<typeof openDb> | undefined;
  const reopen = () => {
    rig.db.close();
    reopened = openDb({ path: rig.path });
    reopened.pragma('synchronous=FULL');
    const attention = new AttentionStore(reopened, rig.path);
    return new ContainedMissionStore(attention, attention.claimOwner('restarted'));
  };
  const close = () => {
    if (reopened) { reopened.close(); rmSync(rig.root, { recursive: true, force: true }); } else rig.close();
    rmSync(home, { recursive: true, force: true });
  };
  const seed = (beforeOpen?: (id: string) => void) => {
    const binding = bind();
    const id = rig.seedMission({ pr_number: target.pr, head, base_head: base, repository: policy.repository,
      spec: spec as unknown as Record<string, unknown>, ...(beforeOpen ? { beforeOpen } : {}) });
    rig.missions.record(id, 'ci_pilot_root_bound', binding, 2000);
    const digest = 'fixture';
    rig.missions.record(id, 'ci_delivery_evidence', { head, base_head: base, evidence_digest: digest }, 2100);
    rig.missions.record(id, 'pr_opened', { verification_kind: 'github_actions', evidence_digest: digest, pr: { number: target.pr } }, 2101);
    return rig.missions.get(id);
  };
  return { rig, home, pilot, actor, spec, releasePath, writeProfile, writeRelease, bind, reopen, close, seed };
}

describe('single-scope production CI pilot', () => {
  it('binds an Alpha release to the Alpha repository, paths, and scope', () => {
    const f = fixture(ALPHA_CI_POLICY);
    try {
      expect(f.pilot.policy).toBe(ALPHA_CI_POLICY);
      expect(parseContainedMissionSpec(JSON.stringify(f.spec))).toEqual(f.spec);
      f.writeRelease();
      expect(f.bind()).toMatchObject({ profile_digest: f.pilot.profileDigest });
      for (const publication of [{ ...f.spec.publication!, repository: ciPolicy.repository },
        { ...f.spec.publication!, repository: 'osborn-studio/unregistered' }, { ...f.spec.publication!, draft: true }]) {
        expect(() => parseContainedMissionSpec(JSON.stringify({ ...f.spec, publication }))).toThrow('CONTAINED_SPEC_INVALID');
      }
      const sameAllowedPath = { ...f.spec, publication: { ...f.spec.publication!, repository: ciPolicy.repository } };
      expect(() => f.pilot.bindNewRoot(f.rig.missions, f.actor, f.rig.scope.scope_id, sameAllowedPath, 2000)).toThrow('CI_PILOT_NOT_AUTHORIZED');
      expect(() => f.pilot.bindNewRoot(f.rig.missions, f.actor, 'f'.repeat(64), f.spec, 2000)).toThrow('CI_PILOT_NOT_AUTHORIZED');
      f.writeProfile({ paths: ['.github/workflows/ci.yml'] });
      expect(() => new ProductionCiPilot(f.home, true, () => false)).toThrow('CI_PILOT_NOT_AUTHORIZED');
    } finally { f.close(); }
  });

  it('defaults to no write authority and refuses out-of-scope paths, changed policy, expiry, and owner revocation', () => {
    const f = fixture();
    try {
      expect(f.bind).toThrow();
      f.writeRelease();
      expect(() => new ProductionCiPilot(f.home, false, () => false)
        .bindNewRoot(f.rig.missions, f.actor, f.rig.scope.scope_id, f.spec, 2000)).toThrow('CI_PILOT_NOT_AUTHORIZED');
      expect(() => f.pilot.bindNewRoot(f.rig.missions, f.actor, f.rig.scope.scope_id,
        { ...f.spec, allowed_paths: ['.github/workflows/ci.yml'] }, 2000)).toThrow('CI_PILOT_NOT_AUTHORIZED');
      const root = f.seed();
      const verify = (now = 2200) => f.pilot.assertWrite(f.rig.missions, root, () => f.actor, now);
      expect(verify().actor).toEqual(f.actor);
      expect(() => verify(120_000)).toThrow();
      expect(() => f.pilot.assertWrite(f.rig.missions, root, () => ({ ...f.actor, operator_scopes: [] }), 2200)).toThrow();
      f.writeRelease({ expires_at: 130_000 });
      expect(verify).toThrow();
      f.writeRelease();
      f.writeProfile({ paths: [allowed, 'docs/pilot.md'] });
      expect(verify).toThrow();
    } finally { f.close(); }
  });

  it('uses five durable root slots for the scope regardless of release-file rotation', () => {
    const f = fixture();
    try {
      f.writeRelease();
      for (let i = 0; i < 5; i++) f.seed();
      f.writeRelease({ expires_at: 130_000 });
      expect(f.bind).toThrow('CI_PILOT_NOT_AUTHORIZED');
    } finally { f.close(); }
  });

  it.each([false, true])('fences the one repair push and only observes a lost reply after restart (released=%s)', async released => {
    const f = fixture();
    try {
      f.writeRelease();
      const root = f.seed();
      const spec: ContainedMissionSpec = { ...f.spec, start_commit: head, branch: 'osstack/mission/repair',
        worktree_path: join(f.rig.root, 'repair'), publication: { ...f.spec.publication!, preauthorized: false },
        ci_repair: { root: root.mission_id, pr: target.pr, branch, base, check_run_id: 19 } };
      const store = f.rig.missions;
      let child = store.authorize(f.actor, { scope_id: root.scope_id, spec: spec as unknown as Record<string, unknown>,
        claim: { repo_identity: 'repair', branch: spec.branch, worktree_identity: spec.worktree_path } }, 2200);
      const advance = (to: typeof child.state, extra = {}) => {
        child = store.transition(child.mission_id, { if_revision: child.revision, to, event: { kind: 'step', payload: {} }, ...extra }, 2210);
      };
      advance('workspace_ready');
      advance('executing', { expected_head: head });
      child = store.recordStopEvidence(child.mission_id, child.revision, { stop_proof: 'test' }, 2210);
      const repairedHead = oid('e');
      advance('candidate_ready', { candidate: { head: repairedHead, tree: oid('d'), diff_digest: 'd'.repeat(64) } });
      advance('verifying');
      child = store.recordStopEvidence(child.mission_id, child.revision, { stop_proof: 'test' }, 2210);
      advance('verified');
      advance('awaiting_decision');
      store.record(child.mission_id, 'halted', { reason: 'publication_pending' }, 2220);
      store.record(root.mission_id, 'ci_repair_dispatched', { child: child.mission_id }, 2220);
      child = f.pilot.approveRepair(store, child, () => f.actor, 2230);
      advance('delivering');
      const repo = { id: ciPolicy.repositoryId, full_name: ciPolicy.repository };
      let remote = head;
      const pr = () => ({ number: 17, state: 'open' as const, merged: false,
        head: { sha: remote, ref: branch, repo }, base: { sha: base, ref: 'main', repo }, user: { id: ciPolicy.publisherActorId, type: 'Bot' } });
      const app = { id: ciPolicy.actionsAppId };
      const failing = { id: 19, name: 'graph-macos-fixtures (22)', app, head_sha: head, check_suite: { id: 11 },
        status: 'completed', conclusion: 'failure' };
      const ci: ReturnType<typeof createSandboxCiReader> = {
        latestAttempt: async query => ({ ...query, complete: true, requests_used: 1, latest: { check_suite_id: 11, check_run_id: 19,
          status: 'completed', conclusion: 'failure' } }),
        observeLatestJob: async (q, job) => ({
          outcome: q.name === failing.name ? 'failure' : q.name === 'check' ? 'infrastructure_failure' : 'success',
          run_id: 1, workflow_id: job.workflowId, attempt: 1, check_run_id: q.name === failing.name ? 19 : 20,
          check_suite_id: 11, job_id: 12, job_name: q.name, runner_labels: job.runnerLabels,
          matrix: job.matrix, workflow_path: job.workflowPath, head, base, app_id: app.id,
        }),
        rest: async path => {
          if (path.endsWith('/pulls/17')) return { ok: true, body: pr() };
          if (path.includes('/contents/')) return { ok: true, body: { sha: ciPolicy.workflowBlob, type: 'file' } };
          if (path.includes('/check-suites?')) return { ok: true, body: { total_count: 1, check_suites: [{ id: 11, app, head_sha: head }] } };
          if (path.includes('/check-runs?')) return { ok: true, body: { total_count: 1, check_runs: [failing] } };
          if (path.endsWith(`/git/ref/heads/${branch}`)) return { ok: true, body: { ref: `refs/heads/${branch}`, object: { sha: remote } } };
          return { ok: false };
        },
      };
      const hp = new HostProcessStore(f.rig.attention, f.rig.owner, { clock: () => 2300 });
      const opId = `hp_${'3'.repeat(32)}`;
      let pushes = 0;
      await expect(publishSandboxCiRepair({
        mission: child, spec, body: '', signal: new AbortController().signal, beforeRemoteMutation: () => {},
        permit: { mission_id: child.mission_id, revision: child.revision, head: repairedHead, tree: child.candidate_tree!, spec_digest: child.spec_digest },
      }, {
        store, host: { recordForIntent: () => hp.get(opId) }, now: () => 2300, enabled: () => true, refresh: () => f.actor, ci, policy: ciPolicy,
        assertAutoGrant: mission => { f.pilot.assertWrite(store, mission, () => f.actor, 2300); },
        runner: { gated: true, run: async (_cmd, args, options) => {
          if (args.includes('remote')) return { stdout: `https://github.com/${ciPolicy.repository}.git\n`, stderr: '', exitCode: 0 };
          if (args.includes('ls-remote')) return { stdout: `${remote}\trefs/heads/${branch}\n`, stderr: '', exitCode: 0 };
          const gate = options.gate!;
          expect(args).toContain(`--force-with-lease=refs/heads/${branch}:${head}`);
          hp.launching({ op_id: opId, mission_id: child.mission_id, kind: 'git_push', remote_target: gate.remoteTarget,
            intent_id: gate.intentId!, local_target: '/isolated/repair', argv_digest: 'a'.repeat(64), boot_id: 'fixture',
            marker: { path: '/isolated/repair-marker', dev: '1', ino: '10' } });
          hp.registered(opId, { pid: 4242, pgid: 4242, leader_start: null });
          if (!released) rmSync(f.releasePath);
          try {
            hp.release(opId, gate.fence);
            pushes++; remote = repairedHead;
          } finally { hp.stopped(opId, { proof: 'group_empty+marker_unheld', detail: {} }); }
          throw Error('disconnect after push release');
        } },
      })).rejects.toThrow();
      expect(pushes).toBe(released ? 1 : 0);
      expect(hp.get(opId).released_at === null).toBe(!released);
      expect(latestCiEvent<SandboxCiPushIntent>(store, child.mission_id, 'ci_repair_push_intent')?.candidate).toBe(repairedHead);
      advance('awaiting_decision');
      if (released) rmSync(f.releasePath);
      const restarted = f.reopen();
      const observer = createSandboxCiObserver({ store: restarted, scopeId: root.scope_id, now: () => 2500,
        enabled: () => true, writeEnabled: () => false, ci, policy: ciPolicy, log: () => {} });
      try {
        await observer.scan();
        await observer.scan();
      } finally { await observer.stop(); }
      expect(restarted.events(child.mission_id).filter(event => event.kind === 'ci_repair_held_push_observed')).toHaveLength(released ? 1 : 0);
      expect(latestCiEvent(restarted, child.mission_id, 'ci_repair_push_confirmed')).toBeUndefined();
    } finally { f.close(); }
  });

  it.each([ciPolicy, ALPHA_CI_POLICY].flatMap(policy => [false, true].map(merged => ({ policy, merged }))))(
    'reconciles an ambiguous App E write without retry ($policy.repository, merged=$merged)', async ({ policy: ciPolicy, merged }) => {
    const f = fixture(ciPolicy);
    let active: ReturnType<typeof createSandboxCiObserver> | undefined;
    try {
      f.writeRelease();
      const root = f.seed(missionId => {
        const hp = new HostProcessStore(f.rig.attention, f.rig.owner, { clock: () => 2060 });
        for (const [index, kind] of (['git_push', 'gh_pr_create'] as const).entries()) {
          const opId = `hp_${String(index + 1).repeat(32)}`;
          hp.launching({ op_id: opId, mission_id: missionId, kind,
            remote_target: remoteTargetOf(ciPolicy.repository, branch), local_target: '/isolated/fixture',
            argv_digest: 'a'.repeat(64), boot_id: 'fixture', marker: { path: `/isolated/${index}`, dev: '1', ino: String(index + 1) } });
          hp.registered(opId, { pid: 4242, pgid: 4242, leader_start: null });
          hp.release(opId, () => {});
          hp.stopped(opId, { proof: 'group_empty+marker_unheld', detail: {}, exit_code: 0 });
        }
      });
      const policy: CiMergerPolicy = { ...SANDBOX_MERGER_POLICY, repository: ciPolicy.repository, repositoryId: ciPolicy.repositoryId,
        ci: ciPolicy, installationId: 7002, qualityRulesetId: 31, updateRulesetId: 32, missionRulesets: { writers: 33, history: 34 } };
      const binding = { ...target, repository: policy.repository, repositoryId: policy.repositoryId };
      let githubMerged = false;
      const repo = { id: policy.repositoryId, full_name: policy.repository };
      const comment = { id: 271, body: `osstack-ci-pilot-merge ${head} ${base}`, user: { id: policy.watcherId, type: 'User' },
        created_at: new Date(2500).toISOString(), updated_at: new Date(2500).toISOString(), author_association: 'MEMBER' };
      const ci: ReturnType<typeof createSandboxCiReader> = {
        latestAttempt: async () => { throw Error('no failure'); },
        observeLatestJob: async (q, job) => ({ outcome: 'success', run_id: job.workflowId, workflow_id: job.workflowId, attempt: 1,
          ...(job.workflowSet ? { runSnapshot: 'same-attempts' } : {}),
          check_run_id: 10, check_suite_id: 11, job_id: 12, job_name: q.name, runner_labels: job.runnerLabels,
          matrix: job.matrix, workflow_path: job.workflowPath, head, base, app_id: ciPolicy.actionsAppId }),
        rest: async path => {
          if (path.endsWith('/pulls/17')) return { ok: true, body: { number: 17, state: githubMerged ? 'closed' : 'open', merged: githubMerged,
            head: { sha: head, ref: branch, repo }, base: { sha: githubMerged ? mergedHead : base, ref: 'main', repo },
            user: { id: policy.publisherId, type: 'Bot' }, merge_commit_sha: githubMerged ? mergedHead : null,
            merged_by: githubMerged ? { id: policy.actorId, type: 'Bot' } : null } };
          if (path.includes('/contents/')) {
            const workflow = ciPolicy.jobs.map(job => job.workflow ?? ciPolicy).find(item => path.includes(`/${item.workflowPath}?`));
            return { ok: !!workflow, body: { sha: workflow?.workflowBlob, type: 'file' } };
          }
          if (path.includes('/check-suites?')) return { ok: true, body: { total_count: 0, check_suites: [] } };
          if (path.includes('/issues/17/comments?')) return { ok: true, body: [comment] };
          if (path.endsWith('/issues/comments/271')) return { ok: true, body: comment };
          if (path.endsWith(`/git/commits/${mergedHead}`)) return { ok: true, body: { sha: mergedHead, parents: [{ sha: base }] } };
          return { ok: false };
        },
      };
      const github = (): Pick<SandboxAppEPorts, 'observe' | 'merge' | 'readback'> => ({
        observe: async () => ({
          binding, complete: true, open: true, draft: false, publisherId: policy.publisherId, headRepositoryId: policy.repositoryId,
          baseRef: 'main', baseTip: base, mergeable: true, reviewDecision: 'APPROVED', labels: ['verified'], blockers: [], unresolvedThreads: 0,
          currentChangesRequested: false, watcher: { userId: policy.watcherId, type: 'User', state: 'APPROVED', head, counted: true },
          quality: { id: 31, active: true, appliesToMain: true, bypassActors: [], requiredChecksEnforced: true, approvalEnforced: true,
            threadsEnforced: true, lastPushApprovalEnforced: true },
          update: { id: 32, active: true, appliesToMain: true, restrictsUpdates: true,
            bypassActors: [{ actorId: policy.appId, actorType: 'Integration', mode: 'pull_request' }] },
        }),
        merge,
        readback: async () => { throw Error('reply was lost'); },
      });
      const merge = vi.fn<SandboxAppEPorts['merge']>(async (_request, beforeWrite) => {
        if (!merged) rmSync(f.releasePath); // Revoke after the token step, immediately before release.
        await beforeWrite();
        githubMerged = true;
        throw Error('disconnect after release');
      });
      const build = (store: ContainedMissionStore, pilot: ProductionCiPilot) => {
        const writeEnabled = () => {
          try { return !!pilot.assertWrite(store, store.get(root.mission_id), () => f.actor, 3000); } catch { return false; }
        };
        const integration = createSandboxCiMerge({ store, scopeId: root.scope_id, now: () => 3000, enabled: () => true,
          writeEnabled, github, ci, policy });
        return createSandboxCiObserver({ store, scopeId: root.scope_id, now: () => 3000, enabled: () => true,
          writeEnabled, ci, policy: ciPolicy, merge: integration, log: () => {} });
      };
      active = build(f.rig.missions, f.pilot);
      await active.scan();
      expect(merge).toHaveBeenCalledOnce();
      expect(latestCiEvent(f.rig.missions, root.mission_id, 'ci_app_e_merge_reserved')).toBeDefined();
      expect(!!latestCiEvent(f.rig.missions, root.mission_id, 'ci_app_e_merge_released')).toBe(merged);
      expect(latestCiEvent(f.rig.missions, root.mission_id, 'ci_pr_merged_observed')).toBeUndefined();
      await active.stop();
      if (merged) rmSync(f.releasePath);
      const restarted = f.reopen();
      active = build(restarted, new ProductionCiPilot(f.home, false, () => false));
      await active.scan();
      await active.scan();
      expect(merge).toHaveBeenCalledOnce();
      if (merged) expect(latestCiEvent(restarted, root.mission_id, 'ci_pr_merged_observed')).toMatchObject({ merge_commit_sha: mergedHead, app_id: policy.appId });
      else expect(latestCiEvent(restarted, root.mission_id, 'ci_pr_merged_observed')).toBeUndefined();
    } finally { await active?.stop(); f.close(); }
  });
});

describe('Alpha CI provenance', () => {
  it.each(['eligible', 'foreign PR', 'changed workflow', 'moved workflow attempts', 'wrong test step', 'verified failure'])(
    'binds every workflow to the exact head and base (%s)', async scenario => {
      const policy = ALPHA_CI_POLICY;
      const repo = { id: policy.repositoryId, full_name: policy.repository };
      const app = { id: policy.actionsAppId };
      const hasFailure = scenario === 'wrong test step' || scenario === 'verified failure';
      const failing = { id: 19, name: 'test', app, head_sha: head, check_suite: { id: 11 },
        status: 'completed', conclusion: 'failure' };
      const rest: ReturnType<typeof createSandboxCiReader>['rest'] = async path => {
        if (path.endsWith('/pulls/17')) return { ok: true, body: { number: 17, state: 'open', merged: false,
          head: { sha: head, ref: branch, repo: scenario === 'foreign PR' ? { ...repo, id: repo.id + 1 } : repo },
          base: { sha: base, ref: 'main', repo }, user: { id: policy.publisherActorId, type: 'Bot' } } };
        if (path.includes('/check-suites?')) return { ok: true, body: { total_count: hasFailure ? 1 : 0,
          check_suites: hasFailure ? [{ id: 11, app, head_sha: head }] : [] } };
        if (path.includes('/check-runs?')) return { ok: true, body: { total_count: 1, check_runs: [failing] } };
        const workflow = policy.jobs.map(job => job.workflow ?? policy).find(item => path.includes(`/${item.workflowPath}?`));
        if (!workflow) return { ok: false };
        const changed = scenario === 'changed workflow' && workflow.workflowId !== policy.workflowId && path.endsWith(head);
        return { ok: true, body: { sha: changed ? head : workflow.workflowBlob, type: 'file' } };
      };
      const observeLatestJob = vi.fn<ReturnType<typeof createSandboxCiReader>['observeLatestJob']>(async (q, job) => ({
        outcome: q.name !== failing.name || !hasFailure ? 'success' : scenario === 'wrong test step' ? 'infrastructure_failure' : 'failure',
        runSnapshot: scenario === 'moved workflow attempts' && job.workflowId !== policy.workflowId ? 'new-attempt' : 'same-attempts',
        run_id: job.workflowId + 100, workflow_id: job.workflowId, attempt: 1, check_run_id: q.name === failing.name ? 19 : 20,
        check_suite_id: 11, job_id: 12, job_name: q.name, runner_labels: job.runnerLabels, matrix: job.matrix,
        workflow_path: job.workflowPath, head, base, app_id: app.id,
      }));
      const result = await readSandboxCiJobs({ rest, observeLatestJob,
        latestAttempt: async query => ({ ...query, complete: true, requests_used: 1, latest: { check_suite_id: 11, check_run_id: 19,
          status: 'completed', conclusion: 'failure' } }) }, target, new AbortController().signal, undefined, policy);
      if (scenario === 'eligible') {
        expect(result.kind).toBe('success');
        expect(observeLatestJob.mock.calls.map(([, job]) => job.workflowId)).toEqual([342738089, 410444879, 410445349]);
      } else if (scenario === 'verified failure') {
        expect(result).toMatchObject({ kind: 'failure', job: { check_run_id: 19, workflow_id: 342738089 } });
      } else {
        const reason = scenario === 'foreign PR' ? 'pr_binding_unavailable'
          : scenario === 'changed workflow' ? 'workflow_binding_unavailable'
          : scenario === 'moved workflow attempts' ? 'workflow_attempts_moved' : 'job_infrastructure_failure';
        expect(result).toEqual({ kind: 'waiting', reason });
        if (scenario === 'foreign PR' || scenario === 'changed workflow') expect(observeLatestJob).not.toHaveBeenCalled();
      }
    });
});

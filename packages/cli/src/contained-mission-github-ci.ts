import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { scratchPath, type ContainedMission, type ContainedMissionStore, type HostProcessRecord } from '@osstack/core';
import { z } from 'zod';
import { latestCiEvent, type RefreshCiPrincipal } from './contained-mission-github-ci-approval.js';
import type { SandboxCiPushIntent } from './contained-mission-github-ci-publish.js';
import { SANDBOX_CI_POLICY, type GithubCiPolicy } from './contained-mission-ci-policy.js';
import { validateContainedStart } from './contained-mission-host.js';
import { readCiFailureHints } from './contained-mission-local-failure-reader.js';
import { createActionsCiFailureReadDeps, type ActionsJobObservation } from './contained-mission-local-failure-reader-transport.js';
import { readMissionPublication } from './contained-mission-publication.js';
import { remoteTargetOf } from './contained-mission-remote-writes.js';
import type { createSandboxCiMerge } from './contained-mission-sandbox-ci-merge.js';
import { parseContainedMissionSpec, type ContainedMissionSpec } from './contained-mission-runner.js';

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const ref = z.object({ sha, ref: z.string(), repo: z.object({ id: z.number(), full_name: z.string() }) });
const prSchema = z.object({ number: z.number(), state: z.enum(['open', 'closed']), merged: z.boolean(),
  head: ref, base: ref, user: z.object({ id: z.number(), type: z.string() }),
  merge_commit_sha: sha.nullable().optional(), merged_by: z.object({ id: z.number(), type: z.string() }).nullable().optional() });
type CiReader = ReturnType<typeof createActionsCiFailureReadDeps>;

export interface SandboxCiTarget { pr: number; head: string; base: string; branch: string }

/** A PR's authored head, base and repository must all be those in the Mission's delivery record. */
export async function readSandboxCiPr(ci: Pick<CiReader, 'rest'>, target: SandboxCiTarget, signal: AbortSignal, policy = SANDBOX_CI_POLICY) {
  const basePath = `repos/${policy.repository}`;
  const result = await ci.rest(`${basePath}/pulls/${target.pr}`, { signal });
  const parsed = prSchema.safeParse(result.ok ? result.body : null);
  if (!parsed.success) return null;
  const pr = parsed.data;
  if (pr.number !== target.pr || pr.head.ref !== target.branch || pr.base.ref !== 'main'
    || pr.head.repo.id !== policy.repositoryId || pr.base.repo.id !== policy.repositoryId
    || pr.head.repo.full_name !== policy.repository || pr.base.repo.full_name !== policy.repository
    || pr.user.id !== policy.publisherActorId || pr.user.type !== 'Bot') return null;
  return pr;
}

export async function readSandboxCiJobs(ci: CiReader, target: SandboxCiTarget, signal: AbortSignal, afterMerge?: { sha: string; jobs: readonly ActionsJobObservation[] }, policy = SANDBOX_CI_POLICY): Promise<
  { kind: 'failure'; job: ActionsJobObservation } | { kind: 'success'; jobs: readonly ActionsJobObservation[] } | { kind: 'waiting'; reason: string }> {
  const basePath = `repos/${policy.repository}`;
  const current = async () => {
    const pr = await readSandboxCiPr(ci, target, signal, policy);
    if (pr?.head.sha !== target.head) return false;
    return afterMerge === undefined ? pr.state === 'open' && pr.base.sha === target.base
      : pr.state === 'closed' && pr.merged && pr.merge_commit_sha === afterMerge.sha;
  };
  if (!await current()) return { kind: 'waiting', reason: 'pr_binding_unavailable' };
  if (afterMerge !== undefined) {
    // The PR's reported base tip can move after a merge. The squash commit binds the actual base.
    const response = await ci.rest(`${basePath}/git/commits/${afterMerge.sha}`, { signal });
    const squash = z.object({ sha: z.literal(afterMerge.sha), parents: z.tuple([z.object({ sha: z.literal(target.base) })]) });
    if (!response.ok || !squash.safeParse(response.body).success) return { kind: 'waiting', reason: 'merge_base_unavailable' };
  }
  for (const commit of [target.base, target.head]) {
    if (!await readBoundWorkflows(ci, policy, commit, signal)) return { kind: 'waiting', reason: 'workflow_binding_unavailable' };
  }
  const request = { repository: policy.repository, pr: target.pr, head: target.head, app_id: policy.actionsAppId };
  // Failure hints wake the repair of open PRs. Closed PRs are eligible only for a fresh success readback.
  const hints = afterMerge === undefined
    ? await readCiFailureHints(ci, { repository: request.repository, pr: request.pr, head: request.head, producerAppIds: [request.app_id] }, { signal })
    : { ok: true as const, hints: [] };
  if (!hints.ok) return { kind: 'waiting', reason: hints.code };
  const results: ActionsJobObservation[] = [];
  const runs = new Map<number, ActionsJobObservation>();
  const workflowSet = [...new Set(policy.jobs.map(job => (job.workflow ?? policy).workflowId))];
  let snapshot: string | undefined;
  for (const { name, matrix, runnerLabels, failureStep, workflow = policy } of policy.jobs) {
    const { repositoryId } = policy;
    const { workflowId, workflowPath } = workflow;
    const preMerge = afterMerge?.jobs.find(job => job.job_name === name);
    if (afterMerge && !preMerge) return { kind: 'waiting', reason: 'premerge_job_unavailable' };
    const result = await ci.observeLatestJob({ ...request, name }, { repositoryId, workflowId, workflowPath, runnerLabels, failureStep,
      ...(workflowSet.length > 1 ? { workflowSet } : {}),
      base: target.base, baseRef: 'main', headRef: target.branch, matrix, ...(preMerge ? { preMerge } : {}) },
    { maxPages: 2, maxRequests: 10, signal });
    if (!result) return { kind: 'waiting', reason: 'job_binding_unavailable' };
    const { runSnapshot, ...job } = result;
    if (workflowSet.length > 1 && (!runSnapshot || (snapshot !== undefined && runSnapshot !== snapshot))) {
      return { kind: 'waiting', reason: 'workflow_attempts_moved' };
    }
    snapshot = runSnapshot;
    if (policy.repository === SANDBOX_CI_POLICY.repository && result.outcome === 'failure'
      && hints.hints.some(h => h.check_run_id === result.check_run_id && h.name === name)) {
      return await current() ? { kind: 'failure', job } : { kind: 'waiting', reason: 'pr_binding_unavailable' };
    }
    const first = runs.get(workflowId);
    if (first && (result.run_id !== first.run_id || result.attempt !== first.attempt)) {
      return { kind: 'waiting', reason: 'matrix_binding_unavailable' };
    }
    runs.set(workflowId, job);
    results.push(job);
  }
  if (results.length === 0) return { kind: 'waiting', reason: 'matrix_binding_unavailable' };
  if (results.every(r => r.outcome === 'success') && await current()) return { kind: 'success', jobs: results };
  if (policy.repository !== SANDBOX_CI_POLICY.repository) {
    const failures = results.filter(r => r.outcome === 'failure');
    const firstFailure = failures[0];
    const macosFailed = failures.some(r => r.job_name.startsWith('graph-macos-fixtures ('));
    if (firstFailure && failures.every(f => hints.hints.some(h => h.check_run_id === f.check_run_id && h.name === f.job_name))
      && results.every(r => r.outcome === 'success' || r.outcome === 'failure'
        || (macosFailed && r.job_name === 'check' && r.outcome === 'infrastructure_failure'))
      && await current()) return { kind: 'failure', job: firstFailure };
  }
  const unusable = results.find(r => r.outcome !== 'success');
  return { kind: 'waiting', reason: unusable ? `job_${unusable.outcome}` : 'matrix_binding_unavailable' };
}

export function createSandboxCiReader(policy = SANDBOX_CI_POLICY) {
  return createActionsCiFailureReadDeps({ actionsAppId: policy.actionsAppId });
}

async function readBoundWorkflows(ci: Pick<CiReader, 'rest'>, policy: GithubCiPolicy, commit: string, signal: AbortSignal) {
  if (!sha.safeParse(commit).success) return false;
  const workflows = new Set(policy.jobs.map(job => job.workflow ?? policy));
  for (const workflow of workflows) {
    const response = await ci.rest(`repos/${policy.repository}/contents/${workflow.workflowPath}?ref=${commit}`, { signal });
    if (!response.ok || !z.object({ sha: z.literal(workflow.workflowBlob), type: z.literal('file') }).safeParse(response.body).success) return false;
  }
  return workflows.size > 0;
}

export async function assertSandboxCiRepository(signal: AbortSignal, policy = SANDBOX_CI_POLICY, base?: string): Promise<void> {
  const ci = createSandboxCiReader(policy);
  const response = await ci.rest(`repos/${policy.repository}`, { signal });
  const schema = z.object({ id: z.literal(policy.repositoryId), full_name: z.literal(policy.repository), default_branch: z.literal('main') });
  if (!response.ok || !schema.safeParse(response.body).success) throw Error('CI_MISSION_REPOSITORY_UNVERIFIED');
  if (base && !await readBoundWorkflows(ci, policy, base, signal)) throw Error('CI_PILOT_WORKFLOW_UNVERIFIED');
}

export function createSandboxCiObserver(input: { store: ContainedMissionStore; scopeId: string; enabled: () => boolean;
  now: () => number; log: (line: string) => void; refresh?: RefreshCiPrincipal; ci?: CiReader; worktreesRoot?: string;
  merge?: ReturnType<typeof createSandboxCiMerge>; policy?: GithubCiPolicy;
  writeEnabled?: (root: ContainedMission) => boolean }) {
  const { store, scopeId, enabled, now, log } = input;
  const policy = input.policy ?? SANDBOX_CI_POLICY;
  const sandbox = policy.repository === SANDBOX_CI_POLICY.repository;
  const ci = input.ci ?? createSandboxCiReader(policy);
  const basePath = `repos/${policy.repository}`;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  const abort = new AbortController();
  async function observeHeldPush(child: ContainedMission, target: SandboxCiTarget,
    live: NonNullable<Awaited<ReturnType<typeof readSandboxCiPr>>>, signal: AbortSignal) {
    if (!['cancelled', 'awaiting_decision', 'stop_unknown'].includes(child.state)
      || latestCiEvent(store, child.mission_id, 'ci_repair_push_confirmed')
      || latestCiEvent(store, child.mission_id, 'ci_repair_held_push_observed')) return;
    const intent = latestCiEvent<SandboxCiPushIntent>(store, child.mission_id, 'ci_repair_push_intent');
    if (!intent || intent.pr !== target.pr || intent.branch !== target.branch || intent.base !== target.base
      || intent.previous !== target.head || intent.candidate !== live.head.sha || live.base.sha !== target.base) return;
    const process = store.db.prepare("SELECT * FROM engineering_host_processes WHERE intent_id=?").get(intent.intent_id) as HostProcessRecord | undefined;
    if (process?.state !== 'stopped' || process.released_at === null || process.mission_id !== child.mission_id
      || process.kind !== 'git_push' || process.remote_target !== remoteTargetOf(policy.repository, target.branch)) return;
    const response = await ci.rest(`${basePath}/git/ref/heads/${target.branch}`, { signal });
    const ref = z.object({ ref: z.literal(`refs/heads/${target.branch}`), object: z.object({ sha: z.literal(intent.candidate) }) });
    if (!enabled() || signal.aborted || !response.ok || !ref.safeParse(response.body).success
      || store.get(child.mission_id).revision !== child.revision) return;
    store.record(child.mission_id, 'ci_repair_held_push_observed', { ...intent, op_id: process.op_id, mission_state: child.state }, now());
  }
  const scan = async () => {
    if (!enabled() || abort.signal.aborted) return;
    const roots = store.db.prepare(`SELECT m.* FROM engineering_contained_missions m
      WHERE m.state='pr_opened' AND m.scope_id=? AND json_extract(m.spec_json,'$.verification_mode')='github_actions'
      AND json_type(m.spec_json,'$.ci_repair') IS NULL
      AND NOT EXISTS (SELECT 1 FROM engineering_contained_events e WHERE e.mission_id=m.mission_id
        AND e.kind IN ('ci_closed_unmerged','ci_pr_merged_observed'))
      ORDER BY m.created_at,m.mission_id LIMIT 1`).all(scopeId) as ContainedMission[];
    for (const root of roots) {
      const spec = parseContainedMissionSpec(root.spec_json);
      const publication = readMissionPublication(store, root.mission_id);
      if (spec.publication?.repository !== policy.repository || publication?.kind !== 'github_ci_opened' || publication.pushed_commit !== root.candidate_head
        || publication.base_head !== spec.start_commit) return;
      const target = { pr: publication.pr.number, head: publication.pushed_commit, base: spec.start_commit, branch: spec.branch };
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]);
      const live = await readSandboxCiPr(ci, target, signal, policy);
      if (!live || !enabled() || signal.aborted) return;
      const dispatch = latestCiEvent<{ child: string }>(store, root.mission_id, 'ci_repair_dispatched');
      if (live.state === 'closed' && !live.merged) {
        store.record(root.mission_id, 'ci_closed_unmerged', { pr: target.pr, head: live.head.sha }, now());
        return;
      }
      const holdMerge = (reason: string) => {
        if (!live.merged) return;
        const previous = latestCiEvent<{ reason: string; head: string }>(store, root.mission_id, 'ci_pr_merge_unverified');
        if (previous?.reason !== reason || previous.head !== live.head.sha) store.record(root.mission_id, 'ci_pr_merge_unverified',
          { pr: target.pr, head: live.head.sha, merge_commit_sha: live.merge_commit_sha, reason }, now());
      };
      if (dispatch) {
        const child = store.get(dispatch.child);
        const repaired = readMissionPublication(store, child.mission_id);
        if (child.state !== 'pr_opened') { await observeHeldPush(child, target, live, signal); holdMerge('repair_receipt_unavailable'); return; }
        if (repaired?.kind !== 'github_ci_opened' || repaired.pushed_commit !== live.head.sha
          || repaired.pr.number !== target.pr || repaired.base_head !== target.base) { holdMerge('repair_receipt_unavailable'); return; }
        if (live.merged && (!live.merge_commit_sha || !live.merged_by)) { holdMerge('merge_identity_unavailable'); return; }
        const prior = store.db.prepare(`SELECT kind,payload_json FROM engineering_contained_events WHERE mission_id=?
          AND kind IN ('ci_repair_verified','ci_repair_failed','ci_repair_verification_waiting') ORDER BY seq DESC LIMIT 1`)
          .get(root.mission_id) as { kind: string; payload_json: string } | undefined;
        const facts = prior ? JSON.parse(prior.payload_json) as { head?: string; reason?: string; jobs?: readonly ActionsJobObservation[]; job?: ActionsJobObservation } : undefined;
        const repairedTarget = { ...target, head: repaired.pushed_commit };
        if (live.merged) {
          if (prior?.kind !== 'ci_repair_verified' || facts?.head !== repairedTarget.head || !facts.jobs) {
            holdMerge('premerge_ci_unavailable'); return;
          }
          const result = await readSandboxCiJobs(ci, repairedTarget, signal, { sha: live.merge_commit_sha!, jobs: facts.jobs }, policy);
          if (!enabled() || signal.aborted) return;
          if (result.kind !== 'success' || !isDeepStrictEqual(facts.jobs, result.jobs)) {
            holdMerge(result.kind === 'waiting' ? result.reason : 'premerge_ci_changed'); return;
          }
          const appMerge = live.merged_by && live.merge_commit_sha
            ? input.merge?.acceptsMerge(root, child, repairedTarget, live.merged_by, live.merge_commit_sha) : null;
          if (!appMerge && latestCiEvent(store, child.mission_id, 'ci_auto_grant_reserved')) {
            holdMerge('app_e_handoff_unavailable'); return;
          }
          store.record(root.mission_id, 'ci_pr_merged_observed', { pr: target.pr, head: live.head.sha,
            merge_commit_sha: live.merge_commit_sha, merged_by: live.merged_by, ...appMerge }, now());
          return;
        }
        const result = await readSandboxCiJobs(ci, repairedTarget, signal, undefined, policy);
        if (!enabled() || signal.aborted) return;
        if (result.kind === 'waiting') {
          if (prior?.kind !== 'ci_repair_verification_waiting' || facts?.reason !== result.reason) store.record(root.mission_id, 'ci_repair_verification_waiting',
            { pr: target.pr, head: repaired.pushed_commit, reason: result.reason }, now());
        }
        if (result.kind === 'failure') {
          if (prior?.kind !== 'ci_repair_failed' || facts?.job?.check_run_id !== result.job.check_run_id) store.record(root.mission_id, 'ci_repair_failed',
            { pr: target.pr, head: repaired.pushed_commit, child: child.mission_id, job: result.job }, now());
        }
        if (result.kind === 'success') {
          const original = latestCiEvent<{ job: ActionsJobObservation }>(store, root.mission_id, 'ci_failure_observed');
          if (original && result.jobs.some(job => job.job_name === original.job.job_name)) {
            if (prior?.kind !== 'ci_repair_verified' || !isDeepStrictEqual(facts?.jobs, result.jobs)) {
              store.record(root.mission_id, 'ci_repair_verified', { pr: target.pr, old: target.head, head: repaired.pushed_commit,
                base: target.base, child: child.mission_id, jobs: result.jobs }, now());
            }
            // Give the independently repeated merge gates their own bounded window.
            if (sandbox || input.writeEnabled?.(root)) await input.merge?.request(root, child, repairedTarget,
              AbortSignal.any([abort.signal, AbortSignal.timeout(sandbox ? 180_000 : 240_000)]));
          }
        }
        return;
      }
      const initial = sandbox ? undefined : store.db.prepare(`SELECT kind,payload_json FROM engineering_contained_events WHERE mission_id=?
        AND kind IN ('ci_initial_verified','ci_initial_verification_waiting') ORDER BY seq DESC LIMIT 1`)
        .get(root.mission_id) as { kind: string; payload_json: string } | undefined;
      const verified = initial?.kind === 'ci_initial_verified'
        ? JSON.parse(initial.payload_json) as { head: string; jobs: readonly ActionsJobObservation[] } : undefined;
      if (live.merged) {
        if (sandbox) { holdMerge('repair_receipt_unavailable'); return; }
        if (verified?.head !== target.head || !live.merge_commit_sha || !live.merged_by) { holdMerge('premerge_ci_unavailable'); return; }
        const checked = await readSandboxCiJobs(ci, target, signal, { sha: live.merge_commit_sha, jobs: verified.jobs }, policy);
        const accepted = input.merge?.acceptsMerge(root, root, target, live.merged_by, live.merge_commit_sha);
        if (!enabled() || signal.aborted) return;
        if (!accepted || checked.kind !== 'success' || !isDeepStrictEqual(verified.jobs, checked.jobs)) { holdMerge('app_e_readback_unavailable'); return; }
        store.record(root.mission_id, 'ci_pr_merged_observed', { pr: target.pr, head: target.head,
          merge_commit_sha: live.merge_commit_sha, merged_by: live.merged_by, ...accepted }, now());
        return;
      }
      const result = await readSandboxCiJobs(ci, target, signal, undefined, policy);
      if (!sandbox && enabled() && !signal.aborted) {
        if (result.kind === 'success') {
          if (!isDeepStrictEqual(verified?.jobs, result.jobs)) store.record(root.mission_id, 'ci_initial_verified', { ...target, jobs: result.jobs }, now());
          if (input.writeEnabled?.(root)) await input.merge?.request(root, root, target, AbortSignal.any([abort.signal, AbortSignal.timeout(240_000)]));
          return;
        }
        if (verified) store.record(root.mission_id, 'ci_initial_verification_waiting', { ...target }, now());
      }
      if (result.kind !== 'failure' || !enabled() || signal.aborted) return;
      store.db.transaction(() => {
        store.attention.assertOwner(store.owner);
        if (!enabled() || signal.aborted) return;
        const previous = latestCiEvent<{ job: ActionsJobObservation }>(store, root.mission_id, 'ci_failure_observed');
        if (previous && previous.job.check_run_id !== result.job.check_run_id) return;
        if (!previous) store.record(root.mission_id, 'ci_failure_observed', { repository: policy.repository, ...target, job: result.job }, now());
        if (!input.refresh || !spec.publication || (sandbox ? !spec.allowed_paths.includes('PROBE_FAIL') : !input.writeEnabled?.(root))
          || latestCiEvent(store, root.mission_id, 'ci_repair_dispatched')) return;
        let actor: ReturnType<RefreshCiPrincipal>;
        try { actor = input.refresh(root.owner_principal_id, root.owner_client_session_id); }
        catch { return; }
        if (!actor.write_scopes.includes(scopeId) || !actor.read_scopes.includes(scopeId) || !actor.operator_scopes.includes(scopeId)) return;
        const worktreesRoot = input.worktreesRoot ?? scratchPath('worktrees');
        const id = randomBytes(8).toString('hex');
        const child: ContainedMissionSpec = {
          ...spec, start_commit: target.head, branch: `osstack/mission/ci-repair-${id}`, worktree_path: join(worktreesRoot, `ci-repair-${id}`),
          goal: sandbox ? 'Repair the sandbox CI fixture. Read PROBE_FAIL from the current checkout and produce a patch deleting only that file. '
            + 'Keep the other Mission files. Do not edit the workflow or run candidate commands.'
            : `Repair the failure in the registered GitHub Actions job "${result.job.job_name}" for this exact PR head. `
              + 'Read the affected code and tests in the checkout. Preserve the original task intent and test assertions. '
              + 'Use only the authorized paths. Keep CI and test configuration intact. Original task: ' + spec.goal,
          allowed_paths: sandbox ? ['PROBE_FAIL'] : spec.allowed_paths, publication: { ...spec.publication, preauthorized: false },
          ci_repair: { root: root.mission_id, pr: target.pr, branch: target.branch, base: target.base, check_run_id: result.job.check_run_id },
        };
        parseContainedMissionSpec(JSON.stringify(child));
        const { claim } = validateContainedStart(child, worktreesRoot);
        const mission = store.authorize(actor, { scope_id: scopeId, claim, spec: child as unknown as Record<string, unknown> }, now());
        store.record(root.mission_id, 'ci_repair_dispatched', { child: mission.mission_id, head: target.head, check_run_id: result.job.check_run_id }, now());
      }).immediate();
    }
  };
  const run = () => {
    pending ??= scan().catch(() => { log('osstack: GitHub CI observation deferred'); }).finally(() => { pending = undefined; });
    return pending;
  };
  return {
    scan: run,
    start: () => {
      if (timer || abort.signal.aborted) return;
      void run();
      timer = setInterval(() => { void run(); }, 30_000);
      timer.unref();
    },
    stop: async () => {
      if (timer) clearInterval(timer);
      abort.abort();
      await pending;
    },
  };
}

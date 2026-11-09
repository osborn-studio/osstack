import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { scratchPath, type ContainedMission, type ContainedMissionStore, type HostProcessRecord } from '@osstack/core';
import { z } from 'zod';
import { latestCiEvent, type RefreshCiPrincipal } from './contained-mission-github-ci-approval.js';
import type { SandboxCiPushIntent } from './contained-mission-github-ci-publish.js';
import { validateContainedStart } from './contained-mission-host.js';
import { readCiFailureHints } from './contained-mission-local-failure-reader.js';
import { createActionsCiFailureReadDeps, type ActionsJobObservation } from './contained-mission-local-failure-reader-transport.js';
import { readMissionPublication } from './contained-mission-publication.js';
import { remoteTargetOf } from './contained-mission-remote-writes.js';
import { GITHUB_CI_SANDBOX, parseContainedMissionSpec, type ContainedMissionSpec } from './contained-mission-runner.js';

// This policy is for the registered sandbox's fixture workflow only.
const policy = {
  repositoryId: 1446327922, publisherActorId: 352680398, actionsAppId: 15368,
  workflowId: 407532337, workflowPath: '.github/workflows/ci.yml',
  workflowBlob: '562d683c3e9ab500aea73f09278a00d4cc266db1',
  runnerLabels: ['ubuntu-latest'], failureStep: 'Run test ! -e PROBE_FAIL',
  jobs: [
    { name: 'check', matrix: {} },
    { name: 'graph-macos-fixtures (22)', matrix: { node: '22' } },
    { name: 'graph-macos-fixtures (24)', matrix: { node: '24' } },
    { name: 'graph-runtime-matrix (20.6.0)', matrix: { node: '20.6.0' } },
    { name: 'graph-runtime-matrix (22.23.1)', matrix: { node: '22.23.1' } },
  ] as ReadonlyArray<{ name: string; matrix: Readonly<Record<string, string>> }>,
};
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const ref = z.object({ sha, ref: z.string(), repo: z.object({ id: z.number(), full_name: z.string() }) });
const prSchema = z.object({ number: z.number(), state: z.enum(['open', 'closed']), merged: z.boolean(),
  head: ref, base: ref, user: z.object({ id: z.number(), type: z.string() }),
  merge_commit_sha: sha.nullable().optional(), merged_by: z.object({ id: z.number(), type: z.string() }).nullable().optional() });
type CiReader = ReturnType<typeof createActionsCiFailureReadDeps>;
const basePath = `repos/${GITHUB_CI_SANDBOX}`;

export interface SandboxCiTarget { pr: number; head: string; base: string; branch: string }

/** A PR's authored head, base and repository must all be those in the Mission's delivery record. */
export async function readSandboxCiPr(ci: Pick<CiReader, 'rest'>, target: SandboxCiTarget, signal: AbortSignal) {
  const result = await ci.rest(`${basePath}/pulls/${target.pr}`, { signal });
  const parsed = prSchema.safeParse(result.ok ? result.body : null);
  if (!parsed.success) return null;
  const pr = parsed.data;
  if (pr.number !== target.pr || pr.head.ref !== target.branch || pr.base.ref !== 'main'
    || pr.head.repo.id !== policy.repositoryId || pr.base.repo.id !== policy.repositoryId
    || pr.head.repo.full_name !== GITHUB_CI_SANDBOX || pr.base.repo.full_name !== GITHUB_CI_SANDBOX
    || pr.user.id !== policy.publisherActorId || pr.user.type !== 'Bot') return null;
  return pr;
}

export async function readSandboxCiJobs(ci: CiReader, target: SandboxCiTarget, signal: AbortSignal): Promise<
  { kind: 'failure'; job: ActionsJobObservation } | { kind: 'success'; jobs: readonly ActionsJobObservation[] } | { kind: 'waiting'; reason: string }> {
  const current = async () => {
    const pr = await readSandboxCiPr(ci, target, signal);
    return pr?.state === 'open' && pr.head.sha === target.head && pr.base.sha === target.base;
  };
  if (!await current()) return { kind: 'waiting', reason: 'pr_binding_unavailable' };
  for (const commit of [target.base, target.head]) {
    const response = await ci.rest(`${basePath}/contents/${policy.workflowPath}?ref=${commit}`, { signal });
    if (!response.ok || !z.object({ sha: z.literal(policy.workflowBlob), type: z.literal('file') }).safeParse(response.body).success) {
      return { kind: 'waiting', reason: 'workflow_binding_unavailable' };
    }
  }
  const request = { repository: GITHUB_CI_SANDBOX, pr: target.pr, head: target.head, app_id: policy.actionsAppId };
  const hints = await readCiFailureHints(ci, { repository: request.repository, pr: request.pr, head: request.head, producerAppIds: [request.app_id] }, { signal });
  if (!hints.ok) return { kind: 'waiting', reason: hints.code };
  const results: ActionsJobObservation[] = [];
  for (const { name, matrix } of policy.jobs) {
    const { repositoryId, workflowId, workflowPath, runnerLabels, failureStep } = policy;
    const result = await ci.observeLatestJob({ ...request, name }, { repositoryId, workflowId, workflowPath, runnerLabels, failureStep,
      base: target.base, baseRef: 'main', headRef: target.branch, matrix }, { maxPages: 2, maxRequests: 10, signal });
    if (!result) return { kind: 'waiting', reason: 'job_binding_unavailable' };
    if (result.outcome === 'failure' && hints.hints.some(h => h.check_run_id === result.check_run_id && h.name === name)) {
      return await current() ? { kind: 'failure', job: result } : { kind: 'waiting', reason: 'pr_binding_unavailable' };
    }
    // The fixture jobs are independent. In production an explicit workflow dependency graph is required.
    results.push(result);
  }
  if (results.every(r => r.outcome === 'success' && r.run_id === results[0]!.run_id && r.attempt === results[0]!.attempt) && await current()) {
    return { kind: 'success', jobs: results };
  }
  const unusable = results.find(r => r.outcome !== 'success');
  return { kind: 'waiting', reason: unusable ? `job_${unusable.outcome}` : 'matrix_binding_unavailable' };
}

export function createSandboxCiReader() {
  return createActionsCiFailureReadDeps({ actionsAppId: policy.actionsAppId });
}

export async function assertSandboxCiRepository(signal: AbortSignal): Promise<void> {
  const response = await createSandboxCiReader().rest(basePath, { signal });
  const schema = z.object({ id: z.literal(policy.repositoryId), full_name: z.literal(GITHUB_CI_SANDBOX), default_branch: z.literal('main') });
  if (!response.ok || !schema.safeParse(response.body).success) throw Error('CI_MISSION_REPOSITORY_UNVERIFIED');
}

export function createSandboxCiObserver(input: { store: ContainedMissionStore; scopeId: string; enabled: () => boolean;
  now: () => number; log: (line: string) => void; refresh?: RefreshCiPrincipal; ci?: CiReader; worktreesRoot?: string }) {
  const { store, scopeId, enabled, now, log } = input;
  const ci = input.ci ?? createSandboxCiReader();
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
      || process.kind !== 'git_push' || process.remote_target !== remoteTargetOf(GITHUB_CI_SANDBOX, target.branch)) return;
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
      if (publication?.kind !== 'github_ci_opened' || publication.pushed_commit !== root.candidate_head
        || publication.base_head !== spec.start_commit) return;
      const target = { pr: publication.pr.number, head: publication.pushed_commit, base: spec.start_commit, branch: spec.branch };
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]);
      const live = await readSandboxCiPr(ci, target, signal);
      if (!live || !enabled() || signal.aborted) return;
      const dispatch = latestCiEvent<{ child: string }>(store, root.mission_id, 'ci_repair_dispatched');
      if (live.state === 'closed') {
        const verified = latestCiEvent<{ head: string }>(store, root.mission_id, 'ci_repair_verified');
        if (!live.merged) store.record(root.mission_id, 'ci_closed_unmerged', { pr: target.pr, head: live.head.sha }, now());
        else if (verified?.head === live.head.sha && live.merge_commit_sha && live.merged_by) {
          store.record(root.mission_id, 'ci_pr_merged_observed', { pr: target.pr, head: live.head.sha,
            merge_commit_sha: live.merge_commit_sha, merged_by: live.merged_by }, now());
        }
        return;
      }
      if (dispatch) {
        const child = store.get(dispatch.child);
        const repaired = readMissionPublication(store, child.mission_id);
        if (child.state !== 'pr_opened') { await observeHeldPush(child, target, live, signal); return; }
        if (repaired?.kind !== 'github_ci_opened' || child.state !== 'pr_opened' || repaired.pushed_commit !== live.head.sha
          || repaired.pr.number !== target.pr || repaired.base_head !== target.base || latestCiEvent(store, root.mission_id, 'ci_repair_verified')) return;
        const result = await readSandboxCiJobs(ci, { ...target, head: repaired.pushed_commit }, signal);
        if (!enabled() || signal.aborted) return;
        if (result.kind === 'waiting') {
          const prior = latestCiEvent<{ reason: string }>(store, root.mission_id, 'ci_repair_verification_waiting');
          if (prior?.reason !== result.reason) store.record(root.mission_id, 'ci_repair_verification_waiting',
            { pr: target.pr, head: repaired.pushed_commit, reason: result.reason }, now());
        }
        if (result.kind === 'failure') {
          const previous = latestCiEvent<{ job: ActionsJobObservation }>(store, root.mission_id, 'ci_repair_failed');
          if (previous?.job.check_run_id !== result.job.check_run_id) store.record(root.mission_id, 'ci_repair_failed',
            { pr: target.pr, head: repaired.pushed_commit, child: child.mission_id, job: result.job }, now());
        }
        if (result.kind === 'success') {
          const original = latestCiEvent<{ job: ActionsJobObservation }>(store, root.mission_id, 'ci_failure_observed');
          if (original && result.jobs.some(job => job.job_name === original.job.job_name)) {
            store.record(root.mission_id, 'ci_repair_verified', { pr: target.pr, old: target.head, head: repaired.pushed_commit,
              base: target.base, child: child.mission_id, jobs: result.jobs }, now());
          }
        }
        return;
      }
      const result = await readSandboxCiJobs(ci, target, signal);
      if (result.kind !== 'failure' || !enabled() || signal.aborted) return;
      store.db.transaction(() => {
        store.attention.assertOwner(store.owner);
        if (!enabled() || signal.aborted) return;
        const previous = latestCiEvent<{ job: ActionsJobObservation }>(store, root.mission_id, 'ci_failure_observed');
        if (previous && previous.job.check_run_id !== result.job.check_run_id) return;
        if (!previous) store.record(root.mission_id, 'ci_failure_observed', { repository: GITHUB_CI_SANDBOX, ...target, job: result.job }, now());
        if (!input.refresh || !spec.publication || !spec.allowed_paths.includes('PROBE_FAIL')
          || latestCiEvent(store, root.mission_id, 'ci_repair_dispatched')) return;
        let actor: ReturnType<RefreshCiPrincipal>;
        try { actor = input.refresh(root.owner_principal_id, root.owner_client_session_id); }
        catch { return; }
        if (!actor.write_scopes.includes(scopeId) || !actor.read_scopes.includes(scopeId) || !actor.operator_scopes.includes(scopeId)) return;
        const worktreesRoot = input.worktreesRoot ?? scratchPath('worktrees');
        const id = randomBytes(8).toString('hex');
        const child: ContainedMissionSpec = {
          ...spec, start_commit: target.head, branch: `osstack/mission/ci-repair-${id}`, worktree_path: join(worktreesRoot, `ci-repair-${id}`),
          goal: 'Repair the sandbox CI fixture. Read PROBE_FAIL from the current checkout and produce a patch deleting only that file. '
            + 'Keep the other Mission files. Do not edit the workflow or run candidate commands.',
          allowed_paths: ['PROBE_FAIL'], publication: { ...spec.publication, preauthorized: false },
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
    pending ??= scan().catch(() => { log('osstack: sandbox CI observation deferred'); }).finally(() => { pending = undefined; });
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

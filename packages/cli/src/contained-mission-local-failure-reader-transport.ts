// Authenticated GET-only transport. No scanner, logs, annotations, token minting or remote writes.
import { execFile } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { CiCheckNameSchema, LocalFailureRepositorySchema } from '@osstack/core';
import { z } from 'zod';
import type { CiFailureReadDeps, CiLatestAttemptQuery } from './contained-mission-local-failure-reader.js';

export type AuthenticatedCiRest = CiFailureReadDeps['rest'];
const id = z.number().int().positive().safe();
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const repository = z.object({ full_name: LocalFailureRepositorySchema });
const pullRef = z.object({ sha, ref: z.string(), repo: z.object({ id }) });
const runSchema = z.object({ id, workflow_id: id, run_number: id, run_attempt: id, check_suite_id: id,
  head_sha: sha, repository, head_repository: repository, event: z.string().optional(), path: z.string().optional(), status: z.string().optional(),
  pull_requests: z.array(z.object({ number: id, head: pullRef, base: pullRef })).max(100).optional() });
const status = z.enum(['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested']);
const conclusion = z.enum(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure']).nullable();
const stateValid = (v: { status: string; conclusion: string | null }) => (v.status === 'completed') === (v.conclusion !== null);
const jobSchema = z.object({ id, run_id: id, run_attempt: id, head_sha: sha, name: CiCheckNameSchema,
  status, conclusion, check_run_url: z.string().nullable(), labels: z.array(z.string().max(100)).max(32).optional(),
  steps: z.array(z.object({ name: z.string().max(512), conclusion: z.string().nullable() })).max(100).optional() }).refine(stateValid);
const checkSchema = z.object({ id, name: CiCheckNameSchema, app: z.object({ id }), head_sha: sha,
  check_suite: z.object({ id }), status, conclusion }).refine(stateValid);
const querySchema = z.object({ repository: LocalFailureRepositorySchema, pr: id, head: sha, app_id: id, name: CiCheckNameSchema }).strict();
export interface ActionsJobBinding {
  repositoryId: number; base: string; baseRef: string; headRef: string;
  workflowId: number; workflowPath: string;
  runnerLabels: readonly string[];
  /** Host policy maps each complete, exact job name to its matrix axes. */
  matrix: Readonly<Record<string, string>>;
  failureStep: string;
  /** Previously verified success for this exact job, used only to recheck a merged PR. */
  preMerge?: ActionsJobObservation;
}
export interface ActionsJobObservation {
  outcome: 'failure' | 'success' | 'infrastructure_failure' | 'pending' | 'unusable';
  run_id: number; workflow_id: number; attempt: number; check_run_id: number; check_suite_id: number;
  job_id: number; job_name: string; runner_labels: readonly string[]; matrix: Readonly<Record<string, string>>;
  workflow_path: string; head: string; base: string; app_id: number;
}

/** Uses the operator's existing gh authentication. The argv always specifies GET; no shell or caller URL.
 * execFile bounds the complete stdout/stderr bytes and elapsed time, and AbortSignal stops the subprocess. */
export function createAuthenticatedCiRest(): AuthenticatedCiRest {
  return (path, { signal }) => new Promise(resolve => {
    if (signal.aborted || !/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_/?=&.-]+)?$/.test(path)
      || path.includes('..') || /(?:logs|annotations|artifacts|downloads)/.test(path)) {
      resolve({ ok: false }); return;
    }
    execFile('gh', ['api', '--hostname', 'github.com', '--method', 'GET', path], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024, signal }, (error, stdout) => {
      if (error || signal.aborted) { resolve({ ok: false }); return; }
      try { resolve({ ok: true, body: JSON.parse(stdout) as unknown }); }
      catch { resolve({ ok: false }); }
    });
  });
}

/** Actions only. run_number orders runs within one workflow; run_attempt identifies a rerun.
 * Numeric check/suite IDs, timestamps and response order never establish latest-attempt authority.
 * Every latest workflow must expose jobs; queued workflows with no jobs fail closed. */
export function createActionsCiFailureReadDeps(options: {
  actionsAppId: number; rest?: AuthenticatedCiRest; now?: () => Date;
}): CiFailureReadDeps & { observeLatestJob(query: CiLatestAttemptQuery, binding: ActionsJobBinding,
  limits: Parameters<CiFailureReadDeps['latestAttempt']>[1]): Promise<ActionsJobObservation | null> } {
  if (!id.safeParse(options.actionsAppId).success) throw Error('CI_ACTIONS_APP_INVALID');
  const rest = options.rest ?? createAuthenticatedCiRest();
  const resolveLatestAttempt = async (input: CiLatestAttemptQuery, limits: Parameters<CiFailureReadDeps['latestAttempt']>[1],
    binding?: ActionsJobBinding) => {
    let used = 0;
    try {
      const query = querySchema.parse(input);
      if (query.app_id !== options.actionsAppId || !Number.isSafeInteger(limits.maxPages) || limits.maxPages < 1 || limits.maxPages > 100
        || !Number.isSafeInteger(limits.maxRequests) || limits.maxRequests < 1 || limits.maxRequests > 1000) throw Error('CI_UNSUPPORTED');
      const { signal } = limits;
      const get = async (path: string): Promise<unknown> => {
        signal.throwIfAborted();
        if (used >= limits.maxRequests) throw Error('CI_LIMIT');
        used++;
        let abort = () => {};
        const cancelled = new Promise<never>((_resolve, reject) => {
          abort = () => reject(Error('CI_ABORTED'));
          signal.addEventListener('abort', abort, { once: true });
        });
        try {
          const result = await Promise.race([rest(path, { signal }), cancelled]);
          signal.throwIfAborted();
          if (!result.ok) throw Error('CI_READ_FAILED');
          return result.body;
        } finally { signal.removeEventListener('abort', abort); }
      };
      const list = async <T,>(path: string, key: string, schema: z.ZodType<T>): Promise<T[]> => {
        const rows: T[] = []; let total: number | undefined;
        for (let page = 1; page <= limits.maxPages; page++) {
          const body = z.object({ total_count: z.number().int().nonnegative().safe() })
            .and(z.object({ [key]: z.array(schema).max(100) })).parse(await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`));
          total ??= body.total_count;
          const batch = body[key] as T[];
          if (body.total_count !== total || total > limits.maxPages * 100 || batch.length !== Math.min(100, total - rows.length)) throw Error('CI_INCOMPLETE');
          rows.push(...batch);
          if (rows.length === total) return rows;
        }
        throw Error('CI_INCOMPLETE');
      };
      const base = `repos/${query.repository}`;
      const readRuns = async () => {
        const runs = await list(`${base}/actions/runs?head_sha=${query.head}`, 'workflow_runs', runSchema);
        const ids = new Set<number>(); const numbers = new Set<string>();
        for (const run of runs) {
          const number = `${run.workflow_id}:${run.run_number}`;
          if (run.head_sha !== query.head || run.repository.full_name !== query.repository || run.head_repository.full_name !== query.repository
            || ids.has(run.id) || numbers.has(number)) throw Error('CI_IDENTITY');
          ids.add(run.id); numbers.add(number);
        }
        return runs.sort((a, b) => a.workflow_id - b.workflow_id || a.run_number - b.run_number);
      };
      const runs = await readRuns();
      if (runs.length === 0) throw Error('CI_UNRESOLVED');
      const latest = new Map<number, z.infer<typeof runSchema>>();
      for (const run of runs) latest.set(run.workflow_id, run);
      const matches: { run: z.infer<typeof runSchema>; job: z.infer<typeof jobSchema> }[] = [];
      for (const run of latest.values()) {
        const jobs = await list(`${base}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs', jobSchema);
        if (!jobs.length || new Set(jobs.map(job => job.id)).size !== jobs.length) throw Error('CI_UNRESOLVED');
        for (const job of jobs) {
          if (job.run_id !== run.id || job.run_attempt !== run.run_attempt || job.head_sha !== query.head) throw Error('CI_IDENTITY');
          if (job.name === query.name) matches.push({ run, job });
        }
      }
      if (matches.length !== 1) throw Error('CI_AMBIGUOUS');
      const { run, job } = matches[0]!;
      // Never navigate a payload URL. Extract only the numeric ID after exact origin/repository matching.
      const prefix = `https://api.github.com/${base}/check-runs/`;
      const checkId = job.check_run_url?.startsWith(prefix) ? job.check_run_url.slice(prefix.length) : '';
      if (!/^[1-9][0-9]*$/.test(checkId) || !Number.isSafeInteger(Number(checkId))) throw Error('CI_JOB_MAPPING');
      const check = checkSchema.parse(await get(`${base}/check-runs/${checkId}`));
      if (check.id !== Number(checkId) || check.name !== query.name || check.app.id !== query.app_id || check.head_sha !== query.head
        || check.check_suite.id !== run.check_suite_id || check.status !== job.status || check.conclusion !== job.conclusion) throw Error('CI_IDENTITY');
      // Detect retries/new runs admitted while jobs/checks were being fetched.
      if (JSON.stringify(await readRuns()) !== JSON.stringify(runs)) throw Error('CI_MOVED');
      const latestCheck = { check_suite_id: check.check_suite.id, check_run_id: check.id, status: check.status, conclusion: check.conclusion };
      let observation: ActionsJobObservation | null = null;
      if (binding) {
        const pr = run.pull_requests?.length === 1 ? run.pull_requests[0] : undefined;
        const linked = pr?.number === query.pr && pr.head.ref === binding.headRef && pr.head.sha === query.head
          && pr.base.ref === binding.baseRef && pr.base.sha === binding.base && pr.base.repo.id === binding.repositoryId && pr.head.repo.id === binding.repositoryId;
        // GitHub may remove the PR from the run after squash. Only an exact prior success can replace that link.
        const clearedAfterMerge = binding.preMerge?.outcome === 'success' && run.pull_requests?.length === 0;
        if (run.event !== 'pull_request' || run.workflow_id !== binding.workflowId || run.path !== binding.workflowPath
          || (!linked && !clearedAfterMerge)
          || !job.labels || JSON.stringify([...job.labels].sort()) !== JSON.stringify([...binding.runnerLabels].sort())) throw Error('CI_PROVENANCE');
        const expectedStep = job.steps?.filter(step => step.name === binding.failureStep) ?? [];
        const otherFailed = job.steps?.some(step => step.name !== binding.failureStep && step.conclusion === 'failure');
        const outcome = run.status !== 'completed' || job.status !== 'completed' ? 'pending' : job.conclusion === 'success' && expectedStep.length === 1 && expectedStep[0]?.conclusion === 'success' ? 'success'
          : job.conclusion === 'failure' ? expectedStep.length === 1 && expectedStep[0]?.conclusion === 'failure' && !otherFailed ? 'failure' : 'infrastructure_failure'
          : 'unusable';
        observation = { outcome, run_id: run.id, workflow_id: run.workflow_id, attempt: run.run_attempt,
          check_run_id: check.id, check_suite_id: check.check_suite.id, job_id: job.id, job_name: job.name,
          runner_labels: job.labels, matrix: structuredClone(binding.matrix), workflow_path: binding.workflowPath,
          head: query.head, base: binding.base, app_id: query.app_id };
        if (binding.preMerge && (outcome !== 'success' || !isDeepStrictEqual(observation, binding.preMerge))) throw Error('CI_PROVENANCE');
      }
      return { response: { complete: true, requests_used: used, ...query, latest: latestCheck }, observation };
    } catch {
      return { response: { complete: false, requests_used: used }, observation: null };
    }
  };
  return { rest, latestAttempt: async (input, limits) => (await resolveLatestAttempt(input, limits)).response,
    observeLatestJob: async (input, binding, limits) => (await resolveLatestAttempt(input, limits, binding)).observation,
    ...(options.now ? { now: options.now } : {}) };
}

// Keep the public query type available without creating a second CI hint contract.
export type { CiLatestAttemptQuery };

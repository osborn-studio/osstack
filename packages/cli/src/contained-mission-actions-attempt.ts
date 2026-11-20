import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ActionsAttemptFact } from "@osstack/core/verification-intake";
import { z } from "zod";
import type { GithubCiPolicy } from "./contained-mission-ci-policy.js";
import { readSandboxCiJobs, readSandboxCiPr, type SandboxCiTarget } from "./contained-mission-github-ci.js";
import type { createActionsCiFailureReadDeps } from "./contained-mission-local-failure-reader-transport.js";

type Reader = ReturnType<typeof createActionsCiFailureReadDeps>;
const id = z.number().int().positive().safe();
const status = z.enum(["requested", "queued", "pending", "waiting", "in_progress", "completed"]);
const repository = z.object({ full_name: z.string() });
const runSchema = z.object({
  id,
  workflow_id: id,
  run_number: id,
  run_attempt: id,
  status,
  head_sha: z.string(),
  repository,
  head_repository: repository,
});
const jobSchema = z
  .object({
    id,
    run_id: id,
    run_attempt: id,
    status,
    head_sha: z.string(),
    name: z.string(),
    check_run_url: z.string(),
    conclusion: z
      .enum([
        "success",
        "failure",
        "neutral",
        "cancelled",
        "skipped",
        "timed_out",
        "action_required",
        "stale",
        "startup_failure",
      ])
      .nullable(),
  })
  .refine((j) => (j.status === "completed") === (j.conclusion !== null));
const limitsSchema = z.object({ maxPages: id, maxRequests: id });
type Options = { signal: AbortSignal; limits?: z.infer<typeof limitsSchema> };
type JobDigest = [jobId: number, checkRunId: number, state: string];
type WorkflowDigest = [workflowId: number, runId: number, runNumber: number, attempt: number, jobs: JobDigest[]];

async function sweep(
  ci: Reader,
  policy: GithubCiPolicy,
  target: SandboxCiTarget,
  options: Options,
): Promise<ActionsAttemptFact | null> {
  const { signal } = options;
  const limits = limitsSchema.parse(options.limits === undefined ? { maxPages: 10, maxRequests: 80 } : options.limits);
  const registered = await readSandboxCiJobs(ci, target, signal, undefined, policy);
  if (registered.kind === "waiting") return null;
  let requests = 0;
  const rest: Reader["rest"] = (path, opts) => {
    signal.throwIfAborted();
    if (++requests > limits.maxRequests) throw Error("request_limit");
    return ci.rest(path, opts);
  };
  let pages = 0;
  async function list<T>(path: string, key: string, schema: z.ZodType<T>): Promise<T[]> {
    const rows: T[] = [];
    let total: number | undefined;
    const pageSchema = z
      .object({ total_count: z.number().int().nonnegative().safe() })
      .and(z.object({ [key]: z.array(schema).max(100) }));
    for (let page = 1; ; page++) {
      if (++pages > limits.maxPages) throw Error("page_limit");
      const response = await rest(path + (path.includes("?") ? "&" : "?") + "per_page=100&page=" + page, { signal });
      if (!response.ok) throw Error("read_failed");
      const body = pageSchema.parse(response.body);
      total ??= body.total_count;
      const batch = body[key] as T[];
      if (total !== body.total_count || batch.length !== Math.min(100, total - rows.length)) throw Error("incomplete");
      rows.push(...batch);
      if (rows.length === total) return rows;
    }
  }
  const path = "repos/" + policy.repository + "/actions/runs";
  const readRuns = async () => {
    const runs = await list(path + "?head_sha=" + target.head, "workflow_runs", runSchema);
    const ids = new Set<number>(),
      numbers = new Set<string>();
    for (const r of runs) {
      const number = r.workflow_id + ":" + r.run_number;
      if (
        r.head_sha !== target.head ||
        r.repository.full_name !== policy.repository ||
        r.head_repository.full_name !== policy.repository ||
        ids.has(r.id) ||
        numbers.has(number)
      )
        throw Error("run_identity");
      ids.add(r.id);
      numbers.add(number);
    }
    return runs.sort((a, b) => a.workflow_id - b.workflow_id || a.run_number - b.run_number);
  };
  const runs = await readRuns();
  const latest = new Map(runs.map((r) => [r.workflow_id, r]));
  const primary = latest.get(policy.workflowId);
  if (!primary || policy.jobs.some((j) => !latest.has((j.workflow ?? policy).workflowId))) return null;
  const prefix = "https://api.github.com/repos/" + policy.repository + "/check-runs/";
  const names = new Set(policy.jobs.map((j) => j.name));
  const workflows: WorkflowDigest[] = [];
  const checks = new Set<number>();
  const observed = new Map<number, { workflow: number; run: number; attempt: number; check: number }>();
  let pending = false,
    green = registered.kind === "success";
  for (const r of latest.values()) {
    const jobs = await list(path + "/" + r.id + "/attempts/" + r.run_attempt + "/jobs", "jobs", jobSchema);
    if (!jobs.length) return null;
    const digestJobs: JobDigest[] = [];
    pending ||= r.status !== "completed";
    for (const j of jobs) {
      if (
        j.run_id !== r.id ||
        j.run_attempt !== r.run_attempt ||
        j.head_sha !== target.head ||
        observed.has(j.id) ||
        !j.check_run_url.startsWith(prefix)
      )
        return null;
      const suffix = j.check_run_url.slice(prefix.length);
      const check = Number(suffix);
      if (!Number.isSafeInteger(check) || check <= 0 || String(check) !== suffix || checks.has(check)) return null;
      checks.add(check);
      observed.set(j.id, { workflow: r.workflow_id, run: r.id, attempt: r.run_attempt, check });
      pending ||= j.status !== "completed";
      green &&= j.conclusion === "success" || (j.conclusion === "skipped" && !names.has(j.name));
      digestJobs.push([j.id, check, j.conclusion ?? j.status]);
    }
    workflows.push([r.workflow_id, r.id, r.run_number, r.run_attempt, digestJobs.sort((a, b) => a[0] - b[0])]);
  }
  if (
    registered.kind === "success" &&
    registered.jobs.some((j) => {
      const match = observed.get(j.job_id);
      return (
        !match ||
        match.workflow !== j.workflow_id ||
        match.run !== j.run_id ||
        match.attempt !== j.attempt ||
        match.check !== j.check_run_id
      );
    })
  )
    return null;
  if (!isDeepStrictEqual(runs, await readRuns())) return null;
  const pr = await readSandboxCiPr({ rest }, target, signal, policy);
  if (signal.aborted || pr?.state !== "open" || pr.head.sha !== target.head || pr.base.sha !== target.base) return null;
  const digest = createHash("sha256")
    .update(JSON.stringify(["actions-attempt/v1", policy.repositoryId, target.pr, target.head, target.base, workflows]))
    .digest("hex");
  return {
    head_sha: target.head,
    attempt: primary.run_attempt,
    complete: true,
    conclusion: pending ? "pending" : green ? "success" : "failure",
    digest,
  };
}

export async function readActionsAttemptFact(
  ci: Reader,
  policy: GithubCiPolicy,
  target: SandboxCiTarget,
  options: Options,
): Promise<ActionsAttemptFact | null> {
  const { signal } = options;
  if (signal.aborted) return null;
  let abort = () => {};
  const cancelled = new Promise<null>((resolve) => {
    abort = () => resolve(null);
  });
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([sweep(ci, policy, target, options), cancelled]);
  } catch {
    return null;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { readActionsAttemptFact } from "./contained-mission-actions-attempt.js";
import { SANDBOX_CI_POLICY } from "./contained-mission-ci-policy.js";

function fixture() {
  const target = { pr: 7, head: "a".repeat(40), base: "b".repeat(40), branch: "repair" };
  const job = SANDBOX_CI_POLICY.jobs[0]!;
  const secondary = { ...SANDBOX_CI_POLICY, workflowId: 2 };
  const policy = { ...SANDBOX_CI_POLICY, workflowId: 1, jobs: [job, { ...job, name: "audit", workflow: secondary }] };
  const repo = { full_name: policy.repository, id: policy.repositoryId };
  const run = (id: number) => ({
    id,
    workflow_id: id,
    run_number: 1,
    run_attempt: 5 - id,
    head_sha: target.head,
    status: "completed",
    repository: repo,
    head_repository: repo,
  });
  const runs = [run(2), run(1)];
  const check = (id: number) => "https://api.github.com/repos/" + policy.repository + "/check-runs/" + id;
  const jobs = runs.map((r) => ({
    id: r.id + 10,
    run_id: r.id,
    run_attempt: r.run_attempt,
    head_sha: target.head,
    status: "completed",
    conclusion: "success" as string | null,
    name: policy.jobs[r.id - 1]!.name,
    check_run_url: check(r.id + 20),
  }));
  const extra = { ...jobs[0]!, id: 13, name: "extra", check_run_url: check(23) };
  jobs.push(extra);
  let listings = 0;
  const pr = {
    number: target.pr,
    state: "open",
    merged: false,
    user: { id: policy.publisherActorId, type: "Bot" },
    head: { sha: target.head, ref: target.branch, repo },
    base: { sha: target.base, ref: "main", repo },
  };
  const get = (path: string): unknown => {
    if (path.includes("/pulls/")) return pr;
    if (path.includes("/contents/")) return { sha: policy.workflowBlob, type: "file" };
    if (path.includes("/check-suites?")) return { total_count: 0, check_suites: [] };
    if (path.includes("/actions/runs?")) {
      listings++;
      const page = Number(path.split("&page=")[1]);
      return { total_count: runs.length, workflow_runs: runs.slice((page - 1) * 100, page * 100) };
    }
    const match = path.match(/\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?per_page=100&page=1$/);
    if (!match) throw Error("unexpected path");
    const batch = jobs.filter((j) => j.run_id === Number(match[1]) && j.run_attempt === Number(match[2]));
    return { total_count: batch.length, jobs: batch };
  };
  const rest = vi.fn(async (path: string) => ({ ok: true as const, body: get(path) }));
  const latestAttempt = vi.fn();
  const observeLatestJob = vi.fn(async ({ name }: { name: string }) => {
    const j = jobs.find((j) => j.name === name);
    if (!j) return null;
    return {
      outcome: "success" as "success" | "failure",
      run_id: j.run_id,
      workflow_id: j.run_id,
      attempt: j.run_attempt,
      check_run_id: j.run_id + 20,
      job_id: j.id,
      job_name: name,
      check_suite_id: 3,
      runner_labels: [],
      matrix: {},
      workflow_path: policy.workflowPath,
      head: target.head,
      base: target.base,
      app_id: policy.actionsAppId,
      runSnapshot: "stable",
    };
  });
  const abort = new AbortController();
  const read = (limits?: { maxPages: number; maxRequests: number }) =>
    readActionsAttemptFact({ rest, observeLatestJob, latestAttempt }, policy, target, {
      signal: abort.signal,
      ...(limits && { limits }),
    });
  return {
    runs,
    jobs,
    extra,
    read,
    rest,
    get,
    pr,
    policy,
    target,
    abort,
    latestAttempt,
    observeLatestJob,
    listings: () => listings,
  };
}

it("hashes sorted identities and states across workflows and reports the primary attempt", async () => {
  const f = fixture();
  const workflows = [
    [1, 1, 1, 4, [[11, 21, "success"]]],
    [
      2,
      2,
      1,
      3,
      [
        [12, 22, "success"],
        [13, 23, "success"],
      ],
    ],
  ];
  const digest = createHash("sha256")
    .update(JSON.stringify(["actions-attempt/v1", f.policy.repositoryId, 7, f.target.head, f.target.base, workflows]))
    .digest("hex");
  const fact = await f.read();
  expect(fact).toEqual({ complete: true, head_sha: f.target.head, attempt: 4, conclusion: "success", digest });
  expect(await f.read()).toEqual(fact);
  f.extra.name = "renamed";
  expect(await f.read()).toEqual(fact);
  f.extra.conclusion = "skipped";
  expect((await f.read())?.digest).not.toBe(digest);
  f.extra.conclusion = "success";
  f.runs[0]!.run_attempt++;
  for (const j of f.jobs.filter((j) => j.run_id === 2)) j.run_attempt++;
  expect(await f.read()).toMatchObject({ attempt: 4, digest: expect.not.stringMatching(digest) });
});
it.each([
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "in_progress",
  "queued",
])("includes unregistered %s", async (state) => {
  const f = fixture();
  if (state === "queued") {
    f.runs.push({ ...f.runs[0]!, id: 3, workflow_id: 3, status: state });
    f.extra.run_id = 3;
  } else if (state === "in_progress") Object.assign(f.extra, { status: state, conclusion: null });
  else f.extra.conclusion = state;
  expect((await f.read())?.conclusion).toBe(
    state === "skipped" ? "success" : ["queued", "in_progress"].includes(state) ? "pending" : "failure",
  );
});
it("requires success for a registered job", async () => {
  const f = fixture();
  f.jobs[0]!.conclusion = "skipped";
  expect((await f.read())?.conclusion).toBe("failure");
});
it.each([
  "missing workflow",
  "waiting",
  "partial",
  "count moved",
  "duplicate number",
  "foreign head",
  "wrong URL",
  "wrong check",
  "moved",
  "PR moved",
  "budget",
  "page limit",
  "abort",
  "throw",
])("returns null for %s", async (mode) => {
  const f = fixture();
  if (mode === "missing workflow") f.runs.pop();
  if (mode === "waiting") f.observeLatestJob.mockResolvedValue(null);
  if (mode === "duplicate number") f.runs.push({ ...f.runs[0]!, id: 4 });
  if (mode === "foreign head") f.runs[0]!.head_sha = f.target.base;
  if (mode === "wrong URL") f.extra.check_run_url += "/other";
  if (mode === "wrong check") f.jobs[0]!.check_run_url += "0";
  if (mode === "abort") f.abort.abort();
  if (mode === "count moved" || mode === "page limit") {
    for (let i = 3; i <= 101; i++) f.runs.push({ ...f.runs[0]!, id: i, run_number: i });
  }
  f.rest.mockImplementation(async (path) => {
    if (mode === "throw") throw Error("unavailable");
    if (mode === "PR moved" && f.listings() === 2) f.pr.head.sha = f.target.base;
    if (mode === "moved" && f.listings() === 1 && path.includes("actions/runs?")) f.runs[0]!.status = "queued";
    const body = f.get(path);
    if (path.includes("actions/runs?") && (mode === "partial" || (mode === "count moved" && path.endsWith("page=2"))))
      Object.assign(body as object, { total_count: 102 });
    return { ok: true, body };
  });
  expect(
    await f.read({ maxPages: mode === "page limit" ? 1 : 10, maxRequests: mode === "budget" ? 2 : 80 }),
  ).toBeNull();
});

it("keeps a registered failure even when every job in the sweep reports success", async () => {
  const f = fixture();
  const check = {
    id: 21,
    name: f.policy.jobs[0]!.name,
    app: { id: f.policy.actionsAppId },
    head_sha: f.target.head,
    check_suite: { id: 3 },
    status: "completed",
    conclusion: "failure",
  };
  f.rest.mockImplementation(async (path) => ({
    ok: true,
    body: path.includes("check-suites?")
      ? { total_count: 1, check_suites: [{ id: 3, app: check.app, head_sha: f.target.head }] }
      : path.includes("/check-runs?")
        ? { total_count: 1, check_runs: [check] }
        : f.get(path),
  }));
  f.latestAttempt.mockResolvedValue({
    complete: true,
    requests_used: 1,
    repository: f.policy.repository,
    pr: f.target.pr,
    head: f.target.head,
    app_id: f.policy.actionsAppId,
    name: check.name,
    latest: { check_run_id: 21, check_suite_id: 3, status: "completed", conclusion: "failure" },
  });
  const observe = f.observeLatestJob.getMockImplementation()!;
  f.observeLatestJob.mockImplementation(async (q) => {
    const job = await observe(q);
    return job && { ...job, outcome: "failure" };
  });
  expect((await f.read())?.conclusion).toBe("failure");
  expect(f.latestAttempt).toHaveBeenCalledOnce();
});

it("selects the greatest run number across complete pages, independent of response order", async () => {
  const f = fixture();
  f.runs[0]!.run_number = 102;
  for (let i = 3; i <= 101; i++) f.runs.push({ ...f.runs[0]!, id: i, run_number: i, status: "queued" });
  const expected = await f.read();
  expect(expected).toMatchObject({ conclusion: "success", attempt: 4 });
  f.runs.reverse();
  f.jobs.reverse();
  expect(await f.read()).toEqual(expected);
});
it.each([
  "no runs",
  "no jobs",
  "duplicate run",
  "duplicate job",
  "duplicate check",
  "wrong job head",
  "wrong job run",
  "foreign repository",
  "bad enum",
  "bad state",
  "invalid limit",
])("refuses %s", async (mode) => {
  const f = fixture();
  if (mode === "no runs") f.runs.length = 0;
  if (mode === "no jobs") f.runs.push({ ...f.runs[0]!, id: 3, workflow_id: 3 });
  if (mode === "duplicate run") f.runs.push({ ...f.runs[0]!, run_number: 2 });
  if (mode === "duplicate job") f.extra.id = f.jobs[0]!.id;
  if (mode === "duplicate check") f.extra.check_run_url = f.jobs[0]!.check_run_url;
  if (mode === "wrong job head") f.extra.head_sha = f.target.base;
  if (mode === "wrong job run")
    f.rest.mockImplementation(async (path) => {
      const body = f.get(path);
      if (path.includes("/2/attempts/"))
        return { ok: true, body: { total_count: 1, jobs: [{ ...f.extra, run_id: 1 }] } };
      return { ok: true, body };
    });
  if (mode === "foreign repository")
    f.runs[0]!.head_repository = { id: 1, full_name: "other/repo" as typeof f.policy.repository };
  if (mode === "bad enum") f.extra.conclusion = "unexpected";
  if (mode === "bad state") f.extra.conclusion = null;
  expect(await f.read({ maxPages: 10, maxRequests: mode === "invalid limit" ? 0.5 : 80 })).toBeNull();
});

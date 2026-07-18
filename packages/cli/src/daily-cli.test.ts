import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KanbanRepository,
  createProbeSession,
  openDb,
  recordKnowledgeHygieneRun,
  type RecordKnowledgeHygieneRunInputV1,
} from "@osstack/core";
import type { CommandRunner } from "@osstack/github";
import { AgentCommandResult } from "@osstack/protocol";
import type { StructuredRecommendation } from "@osstack/supervisor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeDelta, deriveOwnerDecisions, handleDailyCommand, renderDailyMarkdown, runDailyBrief, repoCiStatus, type DailyBrief } from "./daily-command.js";

let tmp: string;
let logs: string[];
let oldHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-daily-cli-"));
  logs = [];
  oldHome = process.env["OSSTACK_HOME"];
  process.env["OSSTACK_HOME"] = join(tmp, "home");
});

afterEach(async () => {
  if (oldHome === undefined) delete process.env["OSSTACK_HOME"];
  else process.env["OSSTACK_HOME"] = oldHome;
  await rm(tmp, { recursive: true, force: true });
});

const out = (line: string) => logs.push(line);

// Offline runner: a github remote for `withgh`, none for `noremote`.
function makeRunner(prNumbers: number[], ciConclusion: string): CommandRunner {
  return {
    run: async (command, args) => {
      const joined = [command, ...args].join(" ");
      if (command === "git" && args.some((a) => a.endsWith("/withgh"))) {
        return "https://github.com/owner/withgh.git\n";
      }
      // noremote resolves to a non-github remote => "no GitHub remote" degrade.
      if (command === "git") return "https://gitlab.com/owner/noremote.git\n";
      if (command === "gh" && args[0] === "pr") {
        return JSON.stringify(
          prNumbers.map((n) => ({
            number: n,
            title: `PR ${n}`,
            state: "OPEN",
            headRefName: `feat/${n}`,
            isDraft: false,
            url: `https://github.com/owner/withgh/pull/${n}`,
          })),
        );
      }
      if (command === "gh" && args[0] === "run") {
        return JSON.stringify([
          {
            databaseId: 1,
            workflowName: "CI",
            status: "completed",
            conclusion: ciConclusion,
            headBranch: "main",
            event: "push",
            createdAt: "2026-07-10T00:00:00Z",
            url: "https://github.com/owner/withgh/actions/runs/1",
          },
        ]);
      }
      if (command === "gh" && args[0] === "release") {
        return JSON.stringify([{ tagName: "v1.0.0", name: "1.0.0", publishedAt: "2026-07-01T00:00:00Z" }]);
      }
      throw new Error(`unexpected: ${joined}`);
    },
  };
}

async function seedRegistry(): Promise<string> {
  const registry = join(tmp, "repos.json");
  const withgh = join(tmp, "withgh");
  const noremote = join(tmp, "noremote");
  await mkdir(withgh, { recursive: true });
  await mkdir(noremote, { recursive: true });
  await writeFile(join(withgh, "README.md"), "# withgh\n");
  await writeRegistry(registry, [
    { repo_id: "withgh", name: "withgh", path: withgh, role: "app", priority: 50, verify_commands: ["true"], loop_doc_path: "docs/LOOP.md", enabled: true },
    { repo_id: "noremote", name: "noremote", path: noremote, role: "app", priority: 50, verify_commands: [], loop_doc_path: "docs/LOOP.md", enabled: true },
  ]);
  return registry;
}

async function writeRegistry(path: string, entries: unknown[]): Promise<void> {
  await writeFile(path, JSON.stringify(entries, null, 2), "utf8");
}

function seedDailyProbeSession(input: { corruptDeferred?: boolean } = {}): void {
  const nowMs = Date.parse("2026-07-11T09:00:00Z");
  mkdirSync(join(tmp, "home"), { recursive: true });
  const db = openDb({
    path: join(tmp, "home", "state.db"),
    minFreeBytes: 0,
  });
  try {
    createProbeSession(db, {
      session: {
        session_id: "probe_daily001",
        repo_id: "withgh",
        state: "active",
        revision: 1,
        snapshot_json: JSON.stringify({
          unselected_required_question_ids: ["tech.missing.v1"],
        }),
        created_at_ms: nowMs - 10 * 86_400_000,
        updated_at_ms: nowMs,
      },
      items: [{
        item_id: "pi_dailyopen1",
        question_id: "tech.daily_open.v1",
        state: input.corruptDeferred ? "deferred" : "open",
        current_quadrant: "ku",
        severity: "high",
        updated_at_ms: nowMs - 5 * 86_400_000,
        item_json: JSON.stringify({
          required: true,
          created_at_ms: nowMs - 5 * 86_400_000,
        }),
      }],
      event: {
        event_id: "pe_daily001",
        revision: 1,
        type: "session_started",
        idempotency_key: "daily-start",
        event_json: JSON.stringify({ type: "session_started" }),
        occurred_at_ms: nowMs - 10 * 86_400_000,
      },
      receipt: {
        scope_key: "repo:withgh",
        idempotency_key: "daily-start",
        request_sha256: "c".repeat(64),
        result_json: JSON.stringify({ session_id: "probe_daily001" }),
        created_at_ms: nowMs - 10 * 86_400_000,
      },
    });
  } finally {
    db.close();
  }
}

function recordedWarning(
  reportSha: string,
  generatedAt: number,
): RecordKnowledgeHygieneRunInputV1 {
  return {
    report_sha256: reportSha,
    schema_version: "1",
    repo_id: "withgh",
    repo_root: join(tmp, "withgh"),
    mode: "all",
    generated_at: generatedAt,
    complete: true,
    skipped_files: 0,
    summary: {
      error: 0,
      warning: 1,
      info: 0,
      suppressed: 0,
      resolved: 0,
    },
    findings: [{
      fingerprint: `khf_${"a".repeat(64)}`,
      rule_id: "surface.required_missing",
      surface: "documentation",
      severity: "warning",
      confidence: "high",
      location_path: "MISSING.md",
      rationale: "A configured knowledge surface is missing.",
    }],
    resolved_findings: [],
  };
}

describe("daily CLI", () => {
  it("renders a Markdown brief with per-repo github status + degradation warning", async () => {
    const registry = await seedRegistry();
    const code = await handleDailyCommand(
      ["--registry", registry],
      { runner: makeRunner([42], "success"), now: () => new Date("2026-07-11T09:00:00Z"), out },
    );
    expect(code).toBe(0);
    const md = logs.join("\n");
    expect(md).toContain("# Portfolio Daily Brief — 2026-07-11");
    expect(md).toContain("### withgh");
    expect(md).toContain("open PRs: 1");
    expect(md).toContain("CI: success");
    expect(md).toContain("latest release: v1.0.0");
    // noremote degrades to a per-repo warning, not an error.
    expect(md).toContain("no GitHub remote");
    // First run => delta says so.
    expect(md).toContain("First run");
    expect(md).not.toContain("## Probe readiness");
  });

  it("includes probe open age and completion only when sessions exist", async () => {
    const registry = await seedRegistry();
    seedDailyProbeSession();

    expect(await handleDailyCommand(
      ["--registry", registry],
      {
        runner: makeRunner([], "success"),
        now: () => new Date("2026-07-11T09:00:00Z"),
        out,
      },
    )).toBe(0);

    const markdown = logs.join("\n");
    expect(markdown).toContain("## Probe readiness");
    expect(markdown).toContain("withgh: 1 in progress / 1 total session(s)");
    expect(markdown).toContain("open high 1, medium 0, low 0; oldest 5d");
    expect(markdown).toContain("completion 0% (0/2 required disposed)");
    const persisted = JSON.parse(await readFile(
      join(tmp, "home", "daily-briefs", "2026-07-11.json"),
      "utf8",
    )) as DailyBrief;
    expect(persisted.probe?.repos[0]).toMatchObject({
      repo_id: "withgh",
      completion_percent: 0,
      oldest_open_age_days: 5,
    });
  });

  it("degrades a corrupt probe projection to a warning instead of failing daily", async () => {
    const registry = await seedRegistry();
    seedDailyProbeSession({ corruptDeferred: true });

    expect(await handleDailyCommand(
      ["--registry", registry],
      {
        runner: makeRunner([], "success"),
        now: () => new Date("2026-07-11T09:00:00Z"),
        out,
      },
    )).toBe(0);
    expect(logs.join("\n")).not.toContain("## Probe readiness");
    const persisted = JSON.parse(await readFile(
      join(tmp, "home", "daily-briefs", "2026-07-11.json"),
      "utf8",
    )) as DailyBrief;
    expect(persisted.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("probe portfolio unavailable"),
    ]));
  });

  it("--json emits a protocol AgentCommandResult that parses under the STRICT schema", async () => {
    const registry = await seedRegistry();
    const code = await handleDailyCommand(
      ["--registry", registry, "--json"],
      { runner: makeRunner([42], "failure"), now: () => new Date("2026-07-11T09:00:00Z"), out },
    );
    expect(code).toBe(0);
    const parsed = AgentCommandResult.parse(JSON.parse(logs.join("\n")));
    expect(parsed.status).toBe("ok");
    expect(parsed.protocol_version).toBe("1.0");
    // Per-repo evidence + the brief report ref.
    expect(parsed.evidence_refs?.some((e) => e.kind === "report")).toBe(true);
    expect(parsed.evidence_refs?.some((e) => e.ref === "https://github.com/owner/withgh")).toBe(true);
    // ≤3 owner decisions; failing CI surfaces a fix_ci decision.
    expect(parsed.next_actions).toBeDefined();
    expect(parsed.next_actions!.length).toBeLessThanOrEqual(3);
    expect(parsed.next_actions!.some((a) => a.command === "repo.fix_ci")).toBe(true);
    // R2.4: the strict NextAction envelope stays { command, reason } — no `run`
    // leaks into the protocol envelope (would fail the strict schema otherwise).
    for (const a of parsed.next_actions!) {
      expect(a).not.toHaveProperty("run");
    }
    // The dispatchable `run` payload rides in `result` (= the brief) instead.
    const brief = parsed.result as unknown as DailyBrief;
    const fixCi = brief.owner_decisions?.find((d) => d.command === "repo.fix_ci");
    expect(fixCi?.run.command).toBe("osstack start 'fix failing CI on withgh: latest run is failure' --repo-id 'withgh'");
    expect(fixCi?.run.argv).toEqual([
      "osstack", "start", "fix failing CI on withgh: latest run is failure", "--repo-id", "withgh",
    ]);
  });

  it("persists a dated brief and the second run diffs against the first (delta)", async () => {
    const registry = await seedRegistry();
    // Run 1 (2026-07-10): PR #42, CI success.
    await handleDailyCommand(
      ["--registry", registry],
      { runner: makeRunner([42], "success"), now: () => new Date("2026-07-10T09:00:00Z"), out },
    );
    const briefsDir = join(tmp, "home", "daily-briefs");
    await expect(readFile(join(briefsDir, "2026-07-10.json"), "utf8")).resolves.toContain("withgh");

    // Run 2 (2026-07-11): new PR #43 appears, CI flips to failure.
    logs = [];
    await handleDailyCommand(
      ["--registry", registry],
      { runner: makeRunner([42, 43], "failure"), now: () => new Date("2026-07-11T09:00:00Z"), out },
    );
    const md = logs.join("\n");
    expect(md).toContain("Delta since 2026-07-10");
    expect(md).toContain("New PRs: withgh#43");
    expect(md).toContain("CI flips: withgh success→failure");
  });

  it("includes a stack board summary only when the stack board has cards", async () => {
    const registry = await seedRegistry();
    // No cards yet => no stack section.
    await handleDailyCommand(
      ["--registry", registry],
      { runner: makeRunner([], "success"), now: () => new Date("2026-07-11T09:00:00Z"), out },
    );
    expect(logs.join("\n")).not.toContain("## Stack board");

    // Seed a card on the "stack" board.
    const home = join(tmp, "home");
    await mkdir(home, { recursive: true });
    const dbPath = join(home, "state.db");
    const db = openDb({ path: dbPath });
    try {
      new KanbanRepository(db, dbPath).createCard({
        card_id: "pr-1",
        board: "stack",
        title: "#1 seed",
        card_type: "pr",
        status: "ready",
      });
    } finally {
      db.close();
    }

    logs = [];
    await handleDailyCommand(
      ["--registry", registry],
      { runner: makeRunner([], "success"), now: () => new Date("2026-07-11T09:00:00Z"), out },
    );
    expect(logs.join("\n")).toContain("## Stack board");
  });

  it("adds event-derived recurrence and age only when the current scan is actionable", async () => {
    const registry = await seedRegistry();
    const repo = join(tmp, "withgh");
    await mkdir(join(repo, ".osstack"), { recursive: true });
    await writeFile(join(repo, ".osstack", "neat.yaml"), [
      "version: 1",
      "required_surfaces:",
      "  - id: missing",
      "    path: MISSING.md",
      "    severity: warning",
      "",
    ].join("\n"));
    const home = join(tmp, "home");
    await mkdir(home, { recursive: true });
    const db = openDb({ path: join(home, "state.db"), minFreeBytes: 0 });
    recordKnowledgeHygieneRun(
      db,
      recordedWarning("1".repeat(64), Date.UTC(2026, 6, 8, 9)),
    );
    recordKnowledgeHygieneRun(
      db,
      recordedWarning("2".repeat(64), Date.UTC(2026, 6, 10, 9)),
    );
    db.close();

    expect(await handleDailyCommand(
      ["--registry", registry],
      {
        runner: makeRunner([], "success"),
        now: () => new Date("2026-07-11T09:00:00Z"),
        out,
      },
    )).toBe(0);

    const markdown = logs.join("\n");
    expect(markdown).toContain(
      "knowledge hygiene: complete; 0 error; 1 warning; 1 recurring; oldest 3d",
    );
    expect(markdown).toContain("knowledge_hygiene.check");
  });

  it("a same-day re-run diffs against the PRIOR day's brief, not the earlier same-day run", async () => {
    const registry = await seedRegistry();
    // Day 1: PR #42 only.
    await handleDailyCommand(
      ["--registry", registry],
      { runner: makeRunner([42], "success"), now: () => new Date("2026-07-10T09:00:00Z"), out },
    );
    // Day 2, run 1: PR #43 appears.
    logs = [];
    await handleDailyCommand(
      ["--registry", registry],
      { runner: makeRunner([42, 43], "success"), now: () => new Date("2026-07-11T09:00:00Z"), out },
    );
    expect(logs.join("\n")).toContain("New PRs: withgh#43");

    // Day 2, run 2: PR #44 also appears. Baseline must still be day 1's brief,
    // so BOTH #43 and #44 are new (not just #44 vs the same-day run 1).
    logs = [];
    await handleDailyCommand(
      ["--registry", registry],
      { runner: makeRunner([42, 43, 44], "success"), now: () => new Date("2026-07-11T17:00:00Z"), out },
    );
    const md = logs.join("\n");
    expect(md).toContain("Delta since 2026-07-10");
    expect(md).toContain("New PRs: withgh#43, withgh#44");
  });

  it("treats a corrupt previous brief as a first run without crashing", async () => {
    const registry = await seedRegistry();
    const briefsDir = join(tmp, "home", "daily-briefs");
    await mkdir(briefsDir, { recursive: true });
    await writeFile(join(briefsDir, "2026-07-10.json"), "{ not json !!", "utf8");

    const code = await handleDailyCommand(
      ["--registry", registry],
      { runner: makeRunner([42], "success"), now: () => new Date("2026-07-11T09:00:00Z"), out },
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("First run");
  });

  it("renders 'No repos registered.' with exit 0 when the registry is missing", async () => {
    const code = await handleDailyCommand(
      ["--registry", join(tmp, "does-not-exist", "repos.json")],
      { runner: makeRunner([], "success"), now: () => new Date("2026-07-11T09:00:00Z"), out },
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("No repos registered.");
  });
});

describe("runDailyBrief (core extracted for the daemon)", () => {
  it("writes the dated brief and returns a result byte-identical to `daily --json`", async () => {
    const registry = await seedRegistry();
    const runner = makeRunner([42], "failure");
    const now = () => new Date("2026-07-11T09:00:00Z");

    // The core the daemon calls each tick.
    const run = await runDailyBrief({ registryPath: registry, runner, now });
    expect(run.brief.date).toBe("2026-07-11");
    const briefsDir = join(tmp, "home", "daily-briefs");
    await expect(readFile(join(briefsDir, "2026-07-11.json"), "utf8")).resolves.toContain("withgh");
    expect(run.briefPath).toBe(join(briefsDir, "2026-07-11.json"));

    // The CLI wrapper is a pure pass-through: `daily --json` prints exactly the
    // result runDailyBrief builds (proving the extraction is behavior-preserving).
    logs = [];
    await handleDailyCommand(
      ["--registry", registry, "--json"],
      { runner: makeRunner([42], "failure"), now, out },
    );
    // generated_at differs only if the clock advanced; both use the pinned `now`.
    expect(JSON.parse(logs.join("\n"))).toEqual(run.result);
  });
});

describe("repoCiStatus (pure)", () => {
  it("returns 'none' for a repo with zero CI runs", () => {
    expect(repoCiStatus({ repo_id: "r", pull_requests: [], ci_runs: [] })).toBe("none");
  });

  it("prefers conclusion, falls back to status, lowercased", () => {
    const run = {
      databaseId: 1,
      workflowName: "CI",
      status: "in_progress",
      conclusion: null,
      headBranch: "main",
      event: "push",
      createdAt: "t",
      url: "u",
    };
    expect(repoCiStatus({ repo_id: "r", pull_requests: [], ci_runs: [run] })).toBe("in_progress");
    expect(
      repoCiStatus({ repo_id: "r", pull_requests: [], ci_runs: [{ ...run, conclusion: "FAILURE" }] }),
    ).toBe("failure");
  });
});

describe("computeDelta (pure)", () => {
  const portfolioOf = (level: number): DailyBrief["portfolio"] => ({
    generated_at: "2026-07-10T00:00:00Z",
    repo_count: 1,
    enabled_repo_count: 1,
    average_closed_loop_level: level,
    repos: [
      {
        repo_id: "r",
        name: "r",
        path: "/r",
        role: "app",
        exists: true,
        has_readme: true,
        has_loop_doc: false,
        has_tests: true,
        has_verify_command: true,
        closed_loop_level: level,
        findings: [],
      },
    ],
    recommendations: [],
    structured_recommendations: [],
  });

  const prev: DailyBrief = {
    generated_at: "2026-07-10T00:00:00Z",
    date: "2026-07-10",
    portfolio: portfolioOf(1),
    github: [{ repo_id: "r", remote: "o/r", pull_requests: [{ number: 1, title: "a", state: "OPEN", head: "h", isDraft: false, url: "u" }], ci_runs: [{ databaseId: 1, workflowName: "CI", status: "completed", conclusion: "success", headBranch: "main", event: "push", createdAt: "t", url: "u" }] }],
    delta: { is_first_run: true, new_prs: [], ci_flips: [], maturity_changes: [] },
    owner_decisions: [],
    warnings: [],
  };

  it("first run yields is_first_run with empty diffs", () => {
    const d = computeDelta(undefined, { portfolio: portfolioOf(1), github: prev.github });
    expect(d.is_first_run).toBe(true);
    expect(d.new_prs).toEqual([]);
  });

  it("detects new PRs, CI flips, and maturity changes vs the previous brief", () => {
    const d = computeDelta(prev, {
      portfolio: portfolioOf(2),
      github: [{ repo_id: "r", remote: "o/r", pull_requests: [{ number: 1, title: "a", state: "OPEN", head: "h", isDraft: false, url: "u" }, { number: 2, title: "b", state: "OPEN", head: "h2", isDraft: false, url: "u2" }], ci_runs: [{ databaseId: 2, workflowName: "CI", status: "completed", conclusion: "failure", headBranch: "main", event: "push", createdAt: "t", url: "u" }] }],
    });
    expect(d.is_first_run).toBe(false);
    expect(d.new_prs).toEqual([{ repo_id: "r", number: 2, title: "b" }]);
    expect(d.ci_flips).toEqual([{ repo_id: "r", from: "success", to: "failure" }]);
    expect(d.maturity_changes).toEqual([{ repo_id: "r", from: 1, to: 2 }]);
  });
});

// ── R2.4 dispatchable next_actions ──────────────────────────────────────────

describe("deriveOwnerDecisions (R2.4 dispatchable run payloads)", () => {
  const repoHealth = (over: Partial<DailyBrief["portfolio"]["repos"][number]>) => ({
    repo_id: "r", name: "r", path: "/r", role: "app", exists: true, has_readme: true,
    has_loop_doc: false, has_tests: true, has_verify_command: true, closed_loop_level: 1,
    findings: [], ...over,
  });
  const briefOf = (over: {
    github?: DailyBrief["github"];
    repos?: DailyBrief["portfolio"]["repos"];
    structured_recommendations?: StructuredRecommendation[];
  }): DailyBrief => ({
    generated_at: "2026-07-11T00:00:00Z",
    date: "2026-07-11",
    portfolio: {
      generated_at: "2026-07-11T00:00:00Z",
      repo_count: 1, enabled_repo_count: 1, average_closed_loop_level: 1,
      repos: over.repos ?? [repoHealth({})],
      // Free-text stays byte-identical to the structured `text` (as the report builds it).
      recommendations: (over.structured_recommendations ?? []).map((r) => r.text),
      structured_recommendations: over.structured_recommendations ?? [],
    },
    github: over.github ?? [],
    delta: { is_first_run: true, new_prs: [], ci_flips: [], maturity_changes: [] },
    owner_decisions: [],
    warnings: [],
  });
  const ciRun = (conclusion: string) => ({
    databaseId: 1, workflowName: "CI", status: "completed", conclusion,
    headBranch: "main", event: "push", createdAt: "t", url: "u",
  });

  it("repo.fix_ci maps to a shell-safe `osstack start … --repo-id` invocation", () => {
    const brief = briefOf({
      github: [{ repo_id: "svc", remote: "o/svc", pull_requests: [], ci_runs: [ciRun("failure")] }],
      repos: [repoHealth({ repo_id: "svc", name: "svc" })],
    });
    const [d] = deriveOwnerDecisions(brief);
    expect(d!.command).toBe("repo.fix_ci");
    expect(d!.run.argv).toEqual(["osstack", "start", "fix failing CI on svc: latest run is failure", "--repo-id", "svc"]);
    expect(d!.run.command).toBe("osstack start 'fix failing CI on svc: latest run is failure' --repo-id 'svc'");
  });

  it("repo.review_prs maps to `gh pr list` for the resolved remote", () => {
    const brief = briefOf({
      github: [{
        repo_id: "svc", remote: "acme/svc",
        pull_requests: [{ number: 7, title: "t", state: "OPEN", head: "h", isDraft: false, url: "u" }],
        ci_runs: [],
      }],
      repos: [repoHealth({ repo_id: "svc", name: "svc" })],
    });
    const d = deriveOwnerDecisions(brief).find((x) => x.command === "repo.review_prs");
    expect(d!.run.argv).toEqual(["gh", "pr", "list", "--repo", "acme/svc", "--state", "open"]);
    expect(d!.run.command).toBe("gh pr list --repo 'acme/svc' --state open");
  });

  it("emits a machine-command hygiene decision only for actionable hygiene", () => {
    const actionable = briefOf({
      repos: [repoHealth({
        repo_id: "svc",
        path: "/repos/svc",
        hygiene: {
          complete: false,
          error_count: 1,
          warning_count: 2,
          recurring_count: 1,
          checked_at: "2026-07-17T00:00:00.000Z",
        },
      })],
    });
    const decision = deriveOwnerDecisions(actionable).find(
      (candidate) => candidate.command === "knowledge_hygiene.check",
    );
    expect(decision).toMatchObject({
      command: "knowledge_hygiene.check",
      run: {
        argv: [
          "osstack",
          "neat",
          "check",
          "--repo",
          "/repos/svc",
          "--all",
          "--fail-on",
          "warning",
        ],
      },
    });
    expect(renderDailyMarkdown(actionable)).toContain(
      "knowledge hygiene: incomplete; 1 error; 2 warning; 1 recurring",
    );

    const clean = briefOf({
      repos: [repoHealth({
        hygiene: {
          complete: true,
          error_count: 0,
          warning_count: 0,
          recurring_count: 0,
          checked_at: "2026-07-17T00:00:00.000Z",
        },
      })],
    });
    expect(deriveOwnerDecisions(clean).some(
      (candidate) => candidate.command === "knowledge_hygiene.check",
    )).toBe(false);
    expect(renderDailyMarkdown(clean)).not.toContain("knowledge hygiene:");
  });

  it("portfolio.raise_maturity → init-loop-doc ONLY for an add_loop_doc kind carrying a repo_id", () => {
    const brief = briefOf({
      repos: [repoHealth({ repo_id: "svc-id", name: "svc" })],
      structured_recommendations: [
        { kind: "add_loop_doc", repo_id: "svc-id", text: "svc: add docs/LOOP.md to declare closed-loop contract" },
        { kind: "add_verify_command", repo_id: "svc-id", text: "svc: add a verify command so runs are traceable" },
        { kind: "consolidation", text: "consolidation: a, b share name \"svc\"" },
      ],
    });
    const decisions = deriveOwnerDecisions(brief).filter((d) => d.command === "portfolio.raise_maturity");
    // The add_loop_doc kind dispatches on its repo_id (not the display name) → init-loop-doc.
    expect(decisions[0]!.run.argv).toEqual(["osstack", "supervise", "init-loop-doc", "--repo", "svc-id"]);
    expect(decisions[0]!.run.command).toBe("osstack supervise init-loop-doc --repo 'svc-id'");
    // A different kind (add_verify_command) stays portfolio-level.
    expect(decisions[1]!.run.argv).toEqual(["osstack", "supervise", "report"]);
    // consolidation carries no repo_id, so it too stays portfolio-level — but it's
    // sliced out of the top-3 here; the verify-command case already proves the fallback.
  });

  it("raise_maturity DISPATCHES on duplicate display names (repo_id disambiguates)", () => {
    // Two repos share display name "dup" but each has a unique repo_id, so the
    // structured add_loop_doc rec carries an unambiguous repo_id → init-loop-doc
    // now dispatches. Behavior improvement over R2.4, where name-matching two
    // "dup" repos was ambiguous and fell back to `supervise report`.
    const brief = briefOf({
      repos: [repoHealth({ repo_id: "dup-1", name: "dup" }), repoHealth({ repo_id: "dup-2", name: "dup" })],
      structured_recommendations: [
        { kind: "add_loop_doc", repo_id: "dup-1", text: "dup: add docs/LOOP.md to declare closed-loop contract" },
      ],
    });
    const d = deriveOwnerDecisions(brief).find((x) => x.command === "portfolio.raise_maturity");
    expect(d!.run.argv).toEqual(["osstack", "supervise", "init-loop-doc", "--repo", "dup-1"]);
    expect(d!.run.command).toBe("osstack supervise init-loop-doc --repo 'dup-1'");
  });

  it("shell-quotes a hostile repo id embedded in the goal AND the --repo-id value", () => {
    // repo_id comes from the registry (untrusted for quoting); it lands in the
    // goal text twice AND in --repo-id. A ' / $(…) / ; payload must not break out.
    // (The CI status is enum-constrained by FAILING_CI to reach fix_ci at all,
    //  but is shQuote'd anyway as defense-in-depth — see the goal assertion.)
    const hostileId = "svc'; rm -rf / #$(touch pwned)";
    const brief = briefOf({
      github: [{ repo_id: hostileId, remote: "o/svc", pull_requests: [], ci_runs: [ciRun("failure")] }],
      repos: [repoHealth({ repo_id: hostileId, name: hostileId })],
    });
    const [d] = deriveOwnerDecisions(brief);
    // argv stays raw (spawn never re-parses a shell string).
    expect(d!.run.argv).toEqual([
      "osstack", "start", `fix failing CI on ${hostileId}: latest run is failure`, "--repo-id", hostileId,
    ]);
    // The printable line wraps every interpolated field in single quotes with the
    // ' → '\'' escape, so no metacharacter ($(…), ;, the closing ') reaches a shell.
    const quotedId = "'svc'\\''; rm -rf / #$(touch pwned)'";
    expect(d!.run.command).toBe(
      `osstack start 'fix failing CI on svc'\\''; rm -rf / #$(touch pwned): latest run is failure' --repo-id ${quotedId}`,
    );
  });
});

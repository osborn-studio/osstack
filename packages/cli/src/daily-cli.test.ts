import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanRepository, openDb } from "@osstack/core";
import type { CommandRunner } from "@osstack/github";
import { AgentCommandResult } from "@osstack/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeDelta, handleDailyCommand, repoCiStatus, type DailyBrief } from "./daily-command.js";

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
  });

  const prev: DailyBrief = {
    generated_at: "2026-07-10T00:00:00Z",
    date: "2026-07-10",
    portfolio: portfolioOf(1),
    github: [{ repo_id: "r", remote: "o/r", pull_requests: [{ number: 1, title: "a", state: "OPEN", head: "h", isDraft: false, url: "u" }], ci_runs: [{ databaseId: 1, workflowName: "CI", status: "completed", conclusion: "success", headBranch: "main", event: "push", createdAt: "t", url: "u" }] }],
    delta: { is_first_run: true, new_prs: [], ci_flips: [], maturity_changes: [] },
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

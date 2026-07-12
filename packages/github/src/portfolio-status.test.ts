import { describe, expect, it } from "vitest";
import type { CommandRunner } from "./branch-scanner.js";
import {
  fetchPortfolioGithubStatus,
  fetchRepoGithubStatus,
  parseGithubSlug,
} from "./portfolio-status.js";

// A fully offline runner: it answers `git`/`gh` invocations from a fixture map
// keyed by the joined argv, so no real subprocess is ever spawned.
interface FakeSpec {
  remote?: string | Error;
  prs?: unknown | Error;
  runs?: unknown | Error;
  releases?: unknown | Error;
}

function fakeRunner(spec: FakeSpec): { runner: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push([command, ...args].join(" "));
      if (command === "git" && args.includes("remote")) {
        if (spec.remote instanceof Error) throw spec.remote;
        if (spec.remote === undefined) throw new Error("no remote configured");
        return spec.remote;
      }
      if (command === "gh" && args[0] === "pr") {
        if (spec.prs instanceof Error) throw spec.prs;
        return JSON.stringify(spec.prs ?? []);
      }
      if (command === "gh" && args[0] === "run") {
        if (spec.runs instanceof Error) throw spec.runs;
        return JSON.stringify(spec.runs ?? []);
      }
      if (command === "gh" && args[0] === "release") {
        if (spec.releases instanceof Error) throw spec.releases;
        return JSON.stringify(spec.releases ?? []);
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
  };
  return { runner, calls };
}

describe("parseGithubSlug", () => {
  it("parses https, ssh, and ssh:// remotes with/without .git", () => {
    expect(parseGithubSlug("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(parseGithubSlug("https://github.com/owner/repo")).toBe("owner/repo");
    expect(parseGithubSlug("git@github.com:owner/repo.git")).toBe("owner/repo");
    expect(parseGithubSlug("ssh://git@github.com/owner/repo.git")).toBe("owner/repo");
    expect(parseGithubSlug("https://github.com/owner/repo/\n")).toBe("owner/repo");
  });

  it("returns undefined for non-github or empty remotes", () => {
    expect(parseGithubSlug("https://gitlab.com/owner/repo.git")).toBeUndefined();
    expect(parseGithubSlug("")).toBeUndefined();
    expect(parseGithubSlug("   ")).toBeUndefined();
  });
});

describe("fetchRepoGithubStatus", () => {
  it("returns PRs, CI runs, and latest release for a github remote", async () => {
    const { runner, calls } = fakeRunner({
      remote: "https://github.com/gilosbornhello/osstack.git\n",
      prs: [
        {
          number: 42,
          title: "feat: thing",
          state: "OPEN",
          headRefName: "feat/thing",
          isDraft: false,
          url: "https://github.com/gilosbornhello/osstack/pull/42",
        },
      ],
      runs: [
        {
          databaseId: 999,
          workflowName: "CI",
          status: "completed",
          conclusion: "success",
          headBranch: "main",
          event: "push",
          createdAt: "2026-07-10T00:00:00Z",
          url: "https://github.com/gilosbornhello/osstack/actions/runs/999",
        },
      ],
      releases: [{ tagName: "v1.2.0", name: "1.2.0", publishedAt: "2026-07-01T00:00:00Z" }],
    });

    const status = await fetchRepoGithubStatus({ repo_id: "osstack", path: "/tmp/osstack" }, runner);

    expect(status.warning).toBeUndefined();
    expect(status.remote).toBe("gilosbornhello/osstack");
    expect(status.pull_requests).toHaveLength(1);
    expect(status.pull_requests[0]).toMatchObject({ number: 42, head: "feat/thing" });
    expect(status.ci_runs[0]).toMatchObject({ conclusion: "success", workflowName: "CI" });
    expect(status.latest_release).toMatchObject({
      tagName: "v1.2.0",
      url: "https://github.com/gilosbornhello/osstack/releases/tag/v1.2.0",
    });
    // Never spawns a real subprocess — every call went through the fake runner.
    expect(calls.some((c) => c.startsWith("git -C /tmp/osstack remote"))).toBe(true);
  });

  it("degrades to a warning (no throw) when there is no github remote", async () => {
    const { runner } = fakeRunner({ remote: "https://gitlab.com/owner/repo.git" });
    const status = await fetchRepoGithubStatus({ repo_id: "x", path: "/tmp/x" }, runner);
    expect(status.warning).toMatch(/no GitHub remote/);
    expect(status.pull_requests).toEqual([]);
    expect(status.ci_runs).toEqual([]);
  });

  it("degrades to a warning when git remote lookup throws (missing binary/no origin)", async () => {
    const { runner } = fakeRunner({ remote: new Error("fatal: no such remote 'origin'") });
    const status = await fetchRepoGithubStatus({ repo_id: "x", path: "/tmp/x" }, runner);
    expect(status.warning).toMatch(/could not read git remote/);
  });

  it("degrades only the failing facet: PR fetch fails, CI runs + release survive", async () => {
    const { runner } = fakeRunner({
      remote: "git@github.com:owner/repo.git",
      prs: new Error("gh: command not found"),
      runs: [
        {
          databaseId: 7,
          workflowName: "CI",
          status: "completed",
          conclusion: "success",
          headBranch: "main",
          event: "push",
          createdAt: "2026-07-10T00:00:00Z",
          url: "https://github.com/owner/repo/actions/runs/7",
        },
      ],
      releases: [{ tagName: "v2.0.0", name: "2.0.0", publishedAt: "2026-07-01T00:00:00Z" }],
    });
    const status = await fetchRepoGithubStatus({ repo_id: "owner/repo", path: "/tmp/r" }, runner);
    expect(status.remote).toBe("owner/repo");
    // The failing facet is empty and named in the warning...
    expect(status.pull_requests).toEqual([]);
    expect(status.warning).toMatch(/gh query failed/);
    expect(status.warning).toMatch(/pull requests:/);
    // ...while the other facets' data survives.
    expect(status.ci_runs).toHaveLength(1);
    expect(status.latest_release?.tagName).toBe("v2.0.0");
    expect(status.warning).not.toMatch(/ci runs:|latest release:/);
  });

  it("degrades only the CI facet on malformed gh run output, keeping PRs + release", async () => {
    const { runner } = fakeRunner({
      remote: "https://github.com/owner/repo.git",
      prs: [
        {
          number: 5,
          title: "ok",
          state: "OPEN",
          headRefName: "f",
          isDraft: false,
          url: "https://github.com/owner/repo/pull/5",
        },
      ],
      runs: [{ nonsense: true }], // fails the RunListJson zod parse
      releases: [{ tagName: "v1.0.0", name: "1.0.0", publishedAt: "2026-07-01T00:00:00Z" }],
    });
    const status = await fetchRepoGithubStatus({ repo_id: "owner/repo", path: "/tmp/r" }, runner);
    expect(status.pull_requests).toHaveLength(1);
    expect(status.latest_release?.tagName).toBe("v1.0.0");
    expect(status.ci_runs).toEqual([]);
    expect(status.warning).toMatch(/ci runs:/);
  });

  it("collects every failing facet in one warning when all gh queries fail", async () => {
    const { runner } = fakeRunner({
      remote: "git@github.com:owner/repo.git",
      prs: new Error("boom"),
      runs: new Error("boom"),
      releases: new Error("boom"),
    });
    const status = await fetchRepoGithubStatus({ repo_id: "owner/repo", path: "/tmp/r" }, runner);
    expect(status.warning).toMatch(/pull requests:/);
    expect(status.warning).toMatch(/ci runs:/);
    expect(status.warning).toMatch(/latest release:/);
    expect(status.pull_requests).toEqual([]);
    expect(status.ci_runs).toEqual([]);
    expect(status.latest_release).toBeUndefined();
  });

  it("handles a repo with no releases (empty release list => no latest_release)", async () => {
    const { runner } = fakeRunner({
      remote: "https://github.com/owner/repo",
      prs: [],
      runs: [],
      releases: [],
    });
    const status = await fetchRepoGithubStatus({ repo_id: "owner/repo", path: "/tmp/r" }, runner);
    expect(status.warning).toBeUndefined();
    expect(status.latest_release).toBeUndefined();
  });
});

describe("fetchPortfolioGithubStatus", () => {
  it("collects one status per repo, degrading independently", async () => {
    const { runner } = fakeRunner({
      remote: "https://github.com/owner/repo.git",
      prs: [],
      runs: [],
      releases: [],
    });
    const statuses = await fetchPortfolioGithubStatus(
      [
        { repo_id: "a", path: "/tmp/a" },
        { repo_id: "b", path: "/tmp/b" },
      ],
      runner,
    );
    expect(statuses).toHaveLength(2);
    expect(statuses.map((s) => s.repo_id)).toEqual(["a", "b"]);
  });
});

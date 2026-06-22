import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const github = vi.hoisted(() => ({
  renderBranchStewardReport: vi.fn(() => "rendered steward report"),
  scanBranchStewardCandidates: vi.fn(),
}));

const childProcess = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock("@osstack/github", () => github);
vi.mock("node:child_process", () => childProcess);

describe("steward CLI", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    github.renderBranchStewardReport.mockClear();
    github.scanBranchStewardCandidates.mockReset();
    childProcess.execFile.mockReset();
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints steward help from the top-level steward command", async () => {
    const { main } = await import("./bin.js");

    const exitCode = await main(["steward"]);

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("steward scan");
    expect(errors).toEqual([]);
  });

  it("prints a JSON branch steward report without GitHub writes", async () => {
    github.scanBranchStewardCandidates.mockResolvedValue({
      repo: "gilosbornhello/osstack",
      base: "main",
      generatedAt: "2026-06-20T00:00:00.000Z",
      candidates: [
        {
          repo: "gilosbornhello/osstack",
          base: "main",
          head: "codex/task-5",
          remote: "origin",
          aheadBy: 2,
          behindBy: 0,
          changedFiles: 3,
          additions: 42,
          deletions: 4,
          hasOpenPr: false,
          checksState: "unknown",
          sensitivePaths: [],
          reasons: ["branch prefix is allowlisted"],
          score: 85,
          action: "create_pr",
        },
      ],
      prIntents: [
        {
          repo: "gilosbornhello/osstack",
          base: "main",
          head: "codex/task-5",
          title: "Branch Steward: codex/task-5",
          body: "dry run only",
          labels: ["osstack/steward", "auto-pr"],
        },
      ],
    });

    const { main } = await import("./bin.js");
    const exitCode = await main([
      "steward",
      "scan",
      "--repo",
      "gilosbornhello/osstack",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      repo: "gilosbornhello/osstack",
      base: "main",
      candidates: [{ head: "codex/task-5", action: "create_pr" }],
      prIntents: [{ head: "codex/task-5" }],
    });
    expect(github.scanBranchStewardCandidates).toHaveBeenCalledTimes(1);
    expect(github.scanBranchStewardCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "gilosbornhello/osstack",
        base: "main",
        remote: "origin",
      }),
      undefined,
      expect.objectContaining({ cwd: process.cwd() }),
    );
    expect(github.renderBranchStewardReport).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it("rejects missing steward scan flag values before scanning", async () => {
    const { main } = await import("./bin.js");

    const exitCode = await main(["steward", "scan", "--repo", "--json"]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("osstack: --repo requires a value");
    expect(github.scanBranchStewardCandidates).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it("infers the repo from the selected remote", async () => {
    childProcess.execFile.mockImplementation((command, args, _options, callback) => {
      expect(command).toBe("git");
      expect(args).toEqual(["remote", "get-url", "upstream"]);
      callback(null, { stdout: "git@github.com:upstream-owner/upstream-repo.git\n", stderr: "" });
    });
    github.scanBranchStewardCandidates.mockResolvedValue({
      repo: "upstream-owner/upstream-repo",
      base: "main",
      generatedAt: "2026-06-20T00:00:00.000Z",
      candidates: [],
      prIntents: [],
    });

    const { main } = await import("./bin.js");
    const exitCode = await main(["steward", "scan", "--remote", "upstream", "--json"]);

    expect(errors).toEqual([]);
    expect(exitCode).toBe(0);
    expect(github.scanBranchStewardCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "upstream-owner/upstream-repo",
        remote: "upstream",
      }),
      undefined,
      expect.objectContaining({ cwd: process.cwd() }),
    );
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      repo: "upstream-owner/upstream-repo",
    });
  });

  it("renders a human branch steward report without --json", async () => {
    const report = {
      repo: "gilosbornhello/osstack",
      base: "main",
      generatedAt: "2026-06-20T00:00:00.000Z",
      candidates: [],
      prIntents: [],
    };
    github.scanBranchStewardCandidates.mockResolvedValue(report);

    const { main } = await import("./bin.js");
    const exitCode = await main([
      "steward",
      "scan",
      "--repo",
      "gilosbornhello/osstack",
    ]);

    expect(exitCode).toBe(0);
    expect(github.renderBranchStewardReport).toHaveBeenCalledTimes(1);
    expect(github.renderBranchStewardReport).toHaveBeenCalledWith(report);
    expect(logs).toEqual(["rendered steward report"]);
  });
});

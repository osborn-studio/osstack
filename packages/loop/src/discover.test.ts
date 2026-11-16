import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitDiffScanner, GitHubBranchScanner, TaskQueueScanner, createScanner } from "./discover.js";

const { scanBranchStewardCandidatesMock } = vi.hoisted(() => ({
  scanBranchStewardCandidatesMock: vi.fn(),
}));

vi.mock("@osstack/github", () => ({
  scanBranchStewardCandidates: scanBranchStewardCandidatesMock,
}));

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "osstack-loop-"));
  git(["init"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test User"], repo);
  writeFileSync(join(repo, "small.ts"), "export const small = 1;\n");
  writeFileSync(join(repo, "large.ts"), "export const large = 1;\n");
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);
  return repo;
}

describe("discover scanners", () => {
  beforeEach(() => {
    scanBranchStewardCandidatesMock.mockReset();
  });

  it("GitDiffScanner should produce prioritized review tasks for changed files", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "small.ts"), "export const small = 1;\nexport const next = 2;\n");
    writeFileSync(
      join(repo, "large.ts"),
      Array.from({ length: 12 }, (_, i) => `export const value${i} = ${i};`).join("\n"),
    );

    const tasks = await new GitDiffScanner(repo).scan();

    expect(tasks.map((task) => task.context?.["file"])).toEqual(["large.ts", "small.ts"]);
    expect(tasks[0]).toMatchObject({
      capability: "code.review",
      source: "git_diff",
    });
    expect(tasks[0]!.priority).toBeGreaterThan(tasks[1]!.priority);
  });

  it("GitDiffScanner keeps the same id across scanner instances and changes it with diff content", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "small.ts"), "export const small = 2;\n");
      const first = (await new GitDiffScanner(repo).scan())[0]!.task_id;
      const restarted = (await new GitDiffScanner(repo).scan())[0]!.task_id;
      expect(restarted).toBe(first);
      writeFileSync(join(repo, "small.ts"), "export const small = 3;\n");
      expect((await new GitDiffScanner(repo).scan())[0]!.task_id).not.toBe(first);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps the id when HEAD moves without changing the dirty file", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "small.ts"), "changed\n");
      const first = (await new GitDiffScanner(repo).scan()).find((task) => task.context?.["file"] === "small.ts")!.task_id;
      writeFileSync(join(repo, "new.ts"), "new\n");
      git(["add", "new.ts"], repo);
      git(["commit", "-m", "unrelated"], repo);
      expect((await new GitDiffScanner(repo).scan())[0]!.task_id).toBe(first);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("uses the same id in different clones and under different diff algorithms", async () => {
    const firstRepo = makeRepo();
    const secondRepo = mkdtempSync(join(tmpdir(), "osstack-loop-clone-"));
    try {
      git(["clone", firstRepo, secondRepo], firstRepo);
      for (const repo of [firstRepo, secondRepo]) writeFileSync(join(repo, "small.ts"), "changed\n");
      const first = (await new GitDiffScanner(firstRepo).scan())[0]!.task_id;
      expect((await new GitDiffScanner(secondRepo).scan())[0]!.task_id).toBe(first);
      git(["config", "diff.algorithm", "patience"], secondRepo);
      expect((await new GitDiffScanner(secondRepo).scan())[0]!.task_id).toBe(first);
    } finally {
      rmSync(firstRepo, { recursive: true, force: true });
      rmSync(secondRepo, { recursive: true, force: true });
    }
  });

  it("discovers a large file and a small file together", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "large.ts"), "x\n".repeat(600_000));
      writeFileSync(join(repo, "small.ts"), "changed\n");
      expect((await new GitDiffScanner(repo).scan()).map((task) => task.context?.["file"])).toEqual(["large.ts", "small.ts"]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("discovers an unstaged change before the first commit", async () => {
    const repo = mkdtempSync(join(tmpdir(), "osstack-loop-unborn-"));
    try {
      git(["init"], repo);
      writeFileSync(join(repo, "new.ts"), "before\n");
      git(["add", "-N", "new.ts"], repo);
      writeFileSync(join(repo, "new.ts"), "after\n");
      expect((await new GitDiffScanner(repo).scan()).map((task) => task.context?.["file"])).toEqual(["new.ts"]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("GitDiffScanner preserves full long ASCII paths", async () => {
    const repo = makeRepo();
    try {
      const directory = Array(7).fill("ordinary-directory-abcdefghij").join("/");
      const file = `${directory}/target.ts`;
      expect(file).toHaveLength(219);
      mkdirSync(join(repo, directory), { recursive: true });
      writeFileSync(join(repo, file), "export const before = 1;\n");
      writeFileSync(join(repo, "short.ts"), "export const short = 1;\n");
      git(["add", "."], repo);
      git(["commit", "-m", "add path fixtures"], repo);

      const changedContent = "export const after = 1;\nexport const added = 2;\n";
      writeFileSync(join(repo, file), changedContent);
      writeFileSync(join(repo, "short.ts"), "export const short = 1;\nexport const next = 2;\n");

      const tasks = await new GitDiffScanner(repo).scan();

      expect(tasks.map((task) => task.context?.["file"])).toEqual([file, "short.ts"]);
      expect(tasks[0]).toMatchObject({
        capability: "code.review",
        source: "git_diff",
        priority: 15,
        context: { file, change_lines: 3 },
      });
      expect(tasks[0]!.prompt).toContain(`Review changes in ${file} (3 lines modified)`);
      expect(readFileSync(join(repo, tasks[0]!.context!["file"] as string), "utf-8"))
        .toBe(changedContent);
      expect(tasks[1]).toMatchObject({
        priority: 5,
        context: { file: "short.ts", change_lines: 1 },
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("createScanner should create known scanners and noop unsupported sources", async () => {
    const repo = mkdtempSync(join(tmpdir(), "osstack-loop-"));
    mkdirSync(join(repo, "tasks"));

    expect(createScanner("git_diff", repo)).toBeInstanceOf(GitDiffScanner);
    expect(createScanner("github_branch", repo)).toBeInstanceOf(GitHubBranchScanner);
    expect(createScanner("task_queue", repo)).toBeInstanceOf(TaskQueueScanner);
    await expect(createScanner("manual", repo).scan()).resolves.toEqual([]);
  });

  it("GitHubBranchScanner should return no tasks when origin is unavailable", async () => {
    const repo = mkdtempSync(join(tmpdir(), "osstack-loop-"));
    git(["init"], repo);

    await expect(new GitHubBranchScanner(repo).scan()).resolves.toEqual([]);
    expect(scanBranchStewardCandidatesMock).not.toHaveBeenCalled();
  });

  it("GitHubBranchScanner should map branch steward candidates to release verification tasks", async () => {
    const repo = mkdtempSync(join(tmpdir(), "osstack-loop-"));
    git(["init"], repo);
    git(["remote", "add", "origin", "https://github.com/acme/widget.git"], repo);
    scanBranchStewardCandidatesMock.mockResolvedValueOnce({
      repo: "acme/widget",
      base: "main",
      generatedAt: "2026-06-20T00:00:00.000Z",
      candidates: [
        {
          repo: "acme/widget",
          base: "main",
          head: "feat/useful branch",
          remote: "origin",
          aheadBy: 3,
          behindBy: 0,
          changedFiles: 2,
          additions: 20,
          deletions: 4,
          hasOpenPr: false,
          checksState: "unknown",
          sensitivePaths: [],
          reasons: ["small branch"],
          score: 84,
          action: "create_pr",
        },
      ],
      prIntents: [],
    });

    const tasks = await new GitHubBranchScanner(repo).scan();

    expect(scanBranchStewardCandidatesMock).toHaveBeenCalledWith(
      {
        repo: "acme/widget",
        base: "main",
        remote: "origin",
        branchPrefixAllowlist: ["feat/", "feature/", "codex/"],
        sensitivePathGlobs: [".github/workflows/", "package.json", "pnpm-lock.yaml"],
        maxChangedFiles: 80,
        maxBehindBy: 25,
        prThreshold: 80,
        autoMergeThreshold: 90,
      },
      undefined,
      { cwd: repo },
    );
    expect(tasks).toEqual([
      {
        task_id: "github-branch-feat-useful-branch-103d53fe",
        capability: "release.verify",
        prompt: "Evaluate origin/feat/useful branch for safe PR creation into main.",
        priority: 84,
        source: "github_branch",
        context: {
          repo: "acme/widget",
          base: "main",
          head: "feat/useful branch",
          score: 84,
          action: "create_pr",
          reasons: ["small branch"],
        },
      },
    ]);
  });

  it("GitHubBranchScanner should return no tasks when candidate scanning fails", async () => {
    const repo = mkdtempSync(join(tmpdir(), "osstack-loop-"));
    git(["init"], repo);
    git(["remote", "add", "origin", "https://github.com/acme/widget.git"], repo);
    scanBranchStewardCandidatesMock.mockRejectedValueOnce(new Error("scan failed"));

    await expect(new GitHubBranchScanner(repo).scan()).resolves.toEqual([]);
  });

  it("GitHubBranchScanner should produce distinct task ids for branch names with matching sanitized forms", async () => {
    const repo = mkdtempSync(join(tmpdir(), "osstack-loop-"));
    git(["init"], repo);
    git(["remote", "add", "origin", "https://github.com/acme/widget.git"], repo);
    scanBranchStewardCandidatesMock.mockResolvedValueOnce({
      repo: "acme/widget",
      base: "main",
      generatedAt: "2026-06-20T00:00:00.000Z",
      candidates: [
        {
          repo: "acme/widget",
          base: "main",
          head: "feat/foo-bar",
          remote: "origin",
          aheadBy: 3,
          behindBy: 0,
          changedFiles: 2,
          additions: 20,
          deletions: 4,
          hasOpenPr: false,
          checksState: "unknown",
          sensitivePaths: [],
          reasons: ["small branch"],
          score: 84,
          action: "create_pr",
        },
        {
          repo: "acme/widget",
          base: "main",
          head: "feat/foo/bar",
          remote: "origin",
          aheadBy: 3,
          behindBy: 0,
          changedFiles: 2,
          additions: 20,
          deletions: 4,
          hasOpenPr: false,
          checksState: "unknown",
          sensitivePaths: [],
          reasons: ["small branch"],
          score: 83,
          action: "create_pr",
        },
      ],
      prIntents: [],
    });

    const tasks = await new GitHubBranchScanner(repo).scan();

    expect(tasks.map((task) => task.task_id)).toEqual([
      "github-branch-feat-foo-bar-1c193d86",
      "github-branch-feat-foo-bar-dbcdc88c",
    ]);
    expect(new Set(tasks.map((task) => task.task_id)).size).toBe(2);
  });

  it("TaskQueueScanner should load JSON task queue entries", async () => {
    const repo = mkdtempSync(join(tmpdir(), "osstack-loop-"));
    mkdirSync(join(repo, "tasks"));
    writeFileSync(join(repo, "tasks", "task.json"), JSON.stringify({
      task_id: "task-queue-1",
      capability: "code.test",
      prompt: "Run the test suite",
      priority: 90,
      context: { package: "@osstack/loop" },
    }));

    const tasks = await new TaskQueueScanner(repo).scan();

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      task_id: "task-queue-1",
      capability: "code.test",
      prompt: "Run the test suite",
      priority: 90,
      source: "task_queue",
    });
    expect(tasks[0]!.context?.["task_file"]).toBe(join(repo, "tasks", "task.json"));
  });

  it("TaskQueueScanner ignores queue files that fail schema validation", async () => {
    const repo = mkdtempSync(join(tmpdir(), "osstack-loop-"));
    mkdirSync(join(repo, "tasks"));
    writeFileSync(join(repo, "tasks", "valid.json"), JSON.stringify({
      task_id: "valid-task",
      prompt: "Run the valid task",
    }));
    writeFileSync(join(repo, "tasks", "bad-extra.json"), JSON.stringify({
      task_id: "bad-extra",
      prompt: "This should be rejected",
      unexpected: true,
    }));
    writeFileSync(join(repo, "tasks", "bad-source.json"), JSON.stringify({
      task_id: "bad-source",
      prompt: "This should also be rejected",
      source: "manual",
    }));

    const tasks = await new TaskQueueScanner(repo).scan();

    expect(tasks.map((task) => task.task_id)).toEqual(["valid-task"]);
  });
});

import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GIT_HOOKS_DISABLED_ARGS,
  reviewerWorkspaceMutated,
  snapshotReviewerWorkspace,
} from "./reviewer-isolation.js";

let root: string;
let workspace: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "osstack-reviewer-isolation-"));
  workspace = join(root, "repo");
  await mkdir(join(workspace, ".cache"), { recursive: true });
  git(["init", "-b", "main"]);
  git(["config", "user.name", "test"]);
  git(["config", "user.email", "test@example.invalid"]);
  await writeFile(join(workspace, ".gitignore"), ".cache/\n");
  await writeFile(join(workspace, "app.txt"), "base\n");
  await writeFile(join(workspace, ".cache/state.txt"), "one\n");
  git(["add", "."]);
  git(["commit", "-m", "base"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("reviewer workspace isolation", () => {
  it("keeps identical snapshots for an unchanged review", async () => {
    const before = await snapshotReviewerWorkspace(workspace);
    const after = await snapshotReviewerWorkspace(workspace);

    expect(
      reviewerWorkspaceMutated(before, after),
      JSON.stringify({ before, after }, null, 2),
    ).toBe(false);
    expect(after).toEqual(before);
  });

  it("detects a tracked edit", async () => {
    const before = await snapshotReviewerWorkspace(workspace);
    await writeFile(join(workspace, "app.txt"), "changed\n");
    const after = await snapshotReviewerWorkspace(workspace);

    expect(reviewerWorkspaceMutated(before, after)).toBe(true);
    expect(after.diff_sha256).not.toBe(before.diff_sha256);
  });

  it("detects a staged edit", async () => {
    const before = await snapshotReviewerWorkspace(workspace);
    await writeFile(join(workspace, "app.txt"), "staged\n");
    git(["add", "app.txt"]);
    const after = await snapshotReviewerWorkspace(workspace);

    expect(reviewerWorkspaceMutated(before, after)).toBe(true);
    expect(after.staged_diff_sha256).not.toBe(before.staged_diff_sha256);
  });

  it("detects a new untracked file", async () => {
    const before = await snapshotReviewerWorkspace(workspace);
    await writeFile(join(workspace, "new.txt"), "untracked\n");
    const after = await snapshotReviewerWorkspace(workspace);

    expect(reviewerWorkspaceMutated(before, after)).toBe(true);
    expect(after.untracked_sha256).not.toBe(before.untracked_sha256);
  });

  it("detects an index-only mutation after worktree content is restored", async () => {
    const before = await snapshotReviewerWorkspace(workspace);
    await writeFile(join(workspace, "app.txt"), "staged-only\n");
    git(["add", "app.txt"]);
    await writeFile(join(workspace, "app.txt"), "base\n");
    const after = await snapshotReviewerWorkspace(workspace);

    expect(reviewerWorkspaceMutated(before, after)).toBe(true);
    expect(after.staged_diff_sha256).not.toBe(before.staged_diff_sha256);
  });

  it("rejects reviewer write to ignored file", async () => {
    const before = await snapshotReviewerWorkspace(workspace);
    await writeFile(join(workspace, ".cache/state.txt"), "two\n");
    const after = await snapshotReviewerWorkspace(workspace);

    expect(reviewerWorkspaceMutated(before, after)).toBe(true);
    expect(after.ignored_sha256).not.toBe(before.ignored_sha256);
  });

  it("rejects reviewer write to git hook", async () => {
    const before = await snapshotReviewerWorkspace(workspace);
    await writeFile(
      join(workspace, ".git/hooks/pre-commit"),
      "#!/bin/sh\nexit 1\n",
    );
    const after = await snapshotReviewerWorkspace(workspace);

    expect(reviewerWorkspaceMutated(before, after)).toBe(true);
    expect(after.hooks_sha256).not.toBe(before.hooks_sha256);
  });

  it("rejects reviewer write to git config", async () => {
    const before = await snapshotReviewerWorkspace(workspace);
    git(["config", "reviewer.pwned", "true"]);
    const after = await snapshotReviewerWorkspace(workspace);

    expect(reviewerWorkspaceMutated(before, after)).toBe(true);
    expect(after.git_config_sha256).not.toBe(before.git_config_sha256);
  });

  it("does not execute reviewer-created hook during commit", async () => {
    const marker = join(root, "hook-ran");
    const hook = join(workspace, ".git/hooks/pre-commit");
    await writeFile(
      hook,
      `#!/bin/sh\nprintf pwned > ${shellQuote(marker)}\nexit 99\n`,
    );
    await chmod(hook, 0o755);
    await writeFile(join(workspace, "app.txt"), "safe commit\n");
    git(["add", "app.txt"]);

    git([...GIT_HOOKS_DISABLED_ARGS, "commit", "-m", "safe"]);

    await expect(readFile(marker, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

function git(args: readonly string[]): void {
  execFileSync("git", [...args], { cwd: workspace, stdio: "ignore" });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

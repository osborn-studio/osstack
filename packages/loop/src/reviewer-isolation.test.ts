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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("disables a hook when the exported hook-disabled commit arguments are used", async () => {
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

it("keeps snapshots and boundaries on the requested repository under hostile Git environment", async () => {
  const { collectReviewBoundary } = await import("./review-boundary.js");
  const foreign = join(root, "foreign"); await mkdir(foreign);
  execFileSync("git", ["init", "-b", "main"], { cwd: foreign, stdio: "ignore" });
  await writeFile(join(foreign, "foreign.ts"), "foreign baseline");
  execFileSync("git", ["add", "."], { cwd: foreign, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@invalid", "commit", "-m", "foreign"], { cwd: foreign, stdio: "ignore" });
  await writeFile(join(workspace, "candidate.ts"), "export const candidate = 1;"); git(["add", "candidate.ts"]); git(["commit", "-m", "candidate"]);
  const expected = await snapshotReviewerWorkspace(workspace);
  const pollution = { GIT_DIR: join(foreign, ".git"), GIT_WORK_TREE: foreign, GIT_INDEX_FILE: join(foreign, ".git/index"),
    GIT_CONFIG_PARAMETERS: "'core.fsmonitor=invalid-host-command'", GIT_EXTERNAL_DIFF: "invalid-host-command", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: foreign };
  const previous = Object.fromEntries(Object.keys(pollution).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, pollution);
    const before = await snapshotReviewerWorkspace(workspace); expect(before).toEqual(expected);
    await writeFile(join(workspace, "candidate.ts"), "export const candidate = 2;");
    const after = await snapshotReviewerWorkspace(workspace); expect(reviewerWorkspaceMutated(before, after)).toBe(true);
    const boundary = await collectReviewBoundary(workspace);
    expect(boundary.boundary.pass).toBe(true); expect(boundary.sanitized_diff).toContain("candidate = 2"); expect(boundary.sanitized_diff).not.toContain("foreign baseline");
  } finally {
    for (const key of Object.keys(pollution)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});

it.each(["other-ref", "packed-refs", "exclude", "attributes"])("detects reviewer mutation of %s", async kind => {
  const before = await snapshotReviewerWorkspace(workspace);
  if (kind === "other-ref") git(["branch", "reviewer-created"]);
  else await writeFile(join(workspace, ".git", kind === "packed-refs" ? "packed-refs" : `info/${kind}`), kind === "packed-refs" ? "# pack-refs with: peeled fully-peeled sorted\n" : "reviewer-change\n");
  expect(reviewerWorkspaceMutated(before, await snapshotReviewerWorkspace(workspace))).toBe(true);
});

it.each(["--assume-unchanged", "--skip-worktree"])("detects raw edits hidden by %s", async flag => {
  git(["update-index", flag, "app.txt"]);
  const before = await snapshotReviewerWorkspace(workspace);
  await writeFile(join(workspace, "app.txt"), "hidden raw change\n");
  const after = await snapshotReviewerWorkspace(workspace);
  expect(reviewerWorkspaceMutated(before, after)).toBe(true);
  expect(after.diff_sha256).not.toBe(before.diff_sha256);
});
it("detects EOL-only raw changes and never executes clean filters while observing", async () => {
  await writeFile(join(workspace, ".gitattributes"), "app.txt text eol=lf filter=observer\n");
  const marker = join(root, "filter-executed");
  git(["config", "filter.observer.clean", `touch '${marker}'; cat`]);
  const before = await snapshotReviewerWorkspace(workspace);
  await writeFile(join(workspace, "app.txt"), "base\r\n");
  const after = await snapshotReviewerWorkspace(workspace);
  expect(reviewerWorkspaceMutated(before, after)).toBe(true);
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps raw snapshots on the authorized workspace despite repo-local core.worktree", async () => {
  const decoy = join(root, "decoy"); await mkdir(decoy);
  git(["config", "core.worktree", decoy]);
  const before = await snapshotReviewerWorkspace(workspace);
  await writeFile(join(workspace, "hidden-untracked.txt"), "foreign");
  const after = await snapshotReviewerWorkspace(workspace);
  expect(after.untracked_sha256).not.toBe(before.untracked_sha256);
  expect(reviewerWorkspaceMutated(before, after)).toBe(true);
});

it("ignores global and system exclude configuration by policy", async () => {
  const excludes = join(root, "external-excludes");
  const config = join(root, "external-git-config");
  await writeFile(excludes, "global-hidden.txt\n");
  await writeFile(config, `[core]\n  excludesFile = ${excludes}\n`);
  vi.stubEnv("GIT_CONFIG_GLOBAL", config); vi.stubEnv("GIT_CONFIG_SYSTEM", config);
  try {
    const before = await snapshotReviewerWorkspace(workspace);
    await writeFile(join(workspace, "global-hidden.txt"), "must be observed");
    const after = await snapshotReviewerWorkspace(workspace);
    expect(after.untracked_sha256).not.toBe(before.untracked_sha256);
    expect(after.ignored_sha256).toBe(before.ignored_sha256);
  } finally { vi.unstubAllEnvs(); }
});

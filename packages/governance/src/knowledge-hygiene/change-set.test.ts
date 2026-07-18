import { execFile } from "node:child_process";
import {
  mkdtemp,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  buildKnowledgeHygieneChangeSet,
  type KnowledgeHygieneGitError,
} from "./change-set.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function initializedRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-git-"));
  await git(repoRoot, ["init", "--quiet"]);
  await git(repoRoot, ["config", "user.email", "neat@example.invalid"]);
  await git(repoRoot, ["config", "user.name", "Neat Test"]);
  await writeFile(join(repoRoot, "tracked.md"), "tracked v1\n");
  await writeFile(join(repoRoot, "staged.md"), "staged v1\n");
  await writeFile(join(repoRoot, "delete.md"), "delete me\n");
  await writeFile(join(repoRoot, "rename-old.md"), "rename me\n");
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "--quiet", "-m", "initial"]);
  return repoRoot;
}

describe("buildKnowledgeHygieneChangeSet", () => {
  it("includes staged, unstaged, deleted, renamed, and untracked worktree paths", async () => {
    const repoRoot = await initializedRepo();
    await writeFile(join(repoRoot, "tracked.md"), "tracked v2\n");
    await writeFile(join(repoRoot, "staged.md"), "staged v2\n");
    await git(repoRoot, ["add", "staged.md"]);
    await unlink(join(repoRoot, "delete.md"));
    await rename(join(repoRoot, "rename-old.md"), join(repoRoot, "rename-new.md"));
    await git(repoRoot, ["add", "rename-old.md", "rename-new.md"]);
    await writeFile(join(repoRoot, "untracked.md"), "new content\n");

    const changeSet = await buildKnowledgeHygieneChangeSet({
      repo_root: repoRoot,
      mode: "worktree",
    });

    expect(changeSet.base_ref).toBe("HEAD");
    expect(changeSet.base_sha).toMatch(/^[a-f0-9]{40,64}$/);
    expect(changeSet.changes).toEqual([
      expect.objectContaining({ path: "delete.md", status: "deleted" }),
      expect.objectContaining({
        path: "rename-new.md",
        old_path: "rename-old.md",
        status: "renamed",
      }),
      expect.objectContaining({ path: "staged.md", status: "modified" }),
      expect.objectContaining({ path: "tracked.md", status: "modified" }),
      expect.objectContaining({ path: "untracked.md", status: "untracked" }),
    ]);
    expect(changeSet.changed_paths).toEqual([
      "delete.md",
      "rename-new.md",
      "rename-old.md",
      "staged.md",
      "tracked.md",
      "untracked.md",
    ]);
    expect(changeSet.diff_id).toMatch(/^diff_[a-f0-9]{64}$/);
  });

  it("resolves explicit range refs and records their SHAs", async () => {
    const repoRoot = await initializedRepo();
    const baseSha = await git(repoRoot, ["rev-parse", "HEAD"]);
    await writeFile(join(repoRoot, "tracked.md"), "range v2\n");
    await git(repoRoot, ["add", "tracked.md"]);
    await git(repoRoot, ["commit", "--quiet", "-m", "range change"]);
    const headSha = await git(repoRoot, ["rev-parse", "HEAD"]);

    const changeSet = await buildKnowledgeHygieneChangeSet({
      repo_root: repoRoot,
      mode: "range",
      base_ref: baseSha,
      head_ref: "HEAD",
    });

    expect(changeSet).toMatchObject({
      mode: "range",
      base_ref: baseSha,
      base_sha: baseSha,
      head_ref: "HEAD",
      head_sha: headSha,
      changes: [{ path: "tracked.md", status: "modified" }],
      changed_paths: ["tracked.md"],
    });
  });

  it("builds base-to-worktree changes and changes diff_id with content or config", async () => {
    const repoRoot = await initializedRepo();
    await writeFile(join(repoRoot, "untracked.md"), "first\n");

    const first = await buildKnowledgeHygieneChangeSet({
      repo_root: repoRoot,
      mode: "base_to_worktree",
      base_ref: "HEAD",
      config_sha256: "a".repeat(64),
    });
    await writeFile(join(repoRoot, "untracked.md"), "second\n");
    const contentChanged = await buildKnowledgeHygieneChangeSet({
      repo_root: repoRoot,
      mode: "base_to_worktree",
      base_ref: "HEAD",
      config_sha256: "a".repeat(64),
    });
    const configChanged = await buildKnowledgeHygieneChangeSet({
      repo_root: repoRoot,
      mode: "base_to_worktree",
      base_ref: "HEAD",
      config_sha256: "b".repeat(64),
    });

    expect(first.diff_id).not.toBe(contentChanged.diff_id);
    expect(contentChanged.diff_id).not.toBe(configChanged.diff_id);
  });

  it("returns typed errors for invalid refs and non-Git directories", async () => {
    const repoRoot = await initializedRepo();
    await expect(buildKnowledgeHygieneChangeSet({
      repo_root: repoRoot,
      mode: "range",
      base_ref: "missing-ref",
      head_ref: "HEAD",
    })).rejects.toMatchObject({
      name: "KnowledgeHygieneGitError",
      code: "invalid_ref",
    });

    const notGit = await mkdtemp(join(tmpdir(), "osstack-neat-not-git-"));
    await expect(buildKnowledgeHygieneChangeSet({
      repo_root: notGit,
      mode: "worktree",
    })).rejects.toMatchObject({
      name: "KnowledgeHygieneGitError",
      code: "not_git_repository",
    });
  });

  it("rejects missing range refs at the runtime boundary", async () => {
    const repoRoot = await initializedRepo();
    const invalidInput = {
      repo_root: repoRoot,
      mode: "range",
    } as unknown as Parameters<typeof buildKnowledgeHygieneChangeSet>[0];

    await expect(buildKnowledgeHygieneChangeSet(invalidInput)).rejects
      .toMatchObject({
        name: "KnowledgeHygieneGitError",
        code: "invalid_input",
      });
  });

  it("maps runner timeouts to a typed boundary error", async () => {
    const repoRoot = await initializedRepo();
    const timeout = Object.assign(new Error("timed out"), { killed: true });

    await expect(buildKnowledgeHygieneChangeSet(
      { repo_root: repoRoot, mode: "worktree" },
      { run_git: async () => Promise.reject(timeout) },
    )).rejects.toEqual(expect.objectContaining<Partial<KnowledgeHygieneGitError>>({
      name: "KnowledgeHygieneGitError",
      code: "timeout",
    }));
  });

  it("keeps diff_id portable across clones of the same change", async () => {
    const repoRoot = await initializedRepo();
    const cloneParent = await mkdtemp(join(tmpdir(), "osstack-neat-clone-"));
    const cloneRoot = join(cloneParent, "repo");
    await git(cloneParent, ["clone", "--quiet", repoRoot, cloneRoot]);
    await writeFile(join(repoRoot, "portable.md"), "same change\n");
    await writeFile(join(cloneRoot, "portable.md"), "same change\n");

    const first = await buildKnowledgeHygieneChangeSet({
      repo_root: repoRoot,
      mode: "worktree",
    });
    const clone = await buildKnowledgeHygieneChangeSet({
      repo_root: cloneRoot,
      mode: "worktree",
    });

    expect(first.repo_root).not.toBe(clone.repo_root);
    expect(first.diff_id).toBe(clone.diff_id);
  });
});

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupOrphanedWorktrees,
  cleanupWorktree,
  cleanupGraphWorktree,
  quarantineGraphWorktree,
  commitWorktreeChanges,
  createWorktree,
  mergeWorktree,
  type WorktreeHandle,
} from "./worktree.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe("git worktree lifecycle", () => {
  it("persists graph retention across generic and prefix cleanup until trusted explicit export cleanup", async () => {
    const { repo, root } = await makeRepo();
    const handle = await createWorktree({ repoPath: repo, runId: "graph", rootPath: root,
      graphRetention: { runId: "graph", scopeKey: "tenant/workspace", generation: 1, workspaceLeaseRef: "lease" } });
    await writeFile(join(handle.worktreePath, "dirty.txt"), "unexported");
    vi.resetModules();
    const restarted = await import("./worktree.js");
    await restarted.cleanupWorktree({ ...handle });
    expect(await readFile(join(handle.worktreePath, "dirty.txt"), "utf8")).toBe("unexported");
    expect((await cleanupOrphanedWorktrees(repo, { rootPath: root })).removed).toEqual([]);
    await quarantineGraphWorktree(handle, "executor stop unknown");
    expect(await readFile(join(handle.worktreePath, "dirty.txt"), "utf8")).toBe("unexported");
    await expect(cleanupGraphWorktree(handle, { artifactDigest: "a".repeat(64), verifySafe: async () => { throw new Error("producer unknown"); } })).rejects.toThrow("producer unknown");
    await expect(cleanupGraphWorktree(handle, { artifactDigest: "a".repeat(64), verifySafe: (async () => true) as unknown as () => Promise<void> })).rejects.toThrow(/authority/i);
    let checked = 0;
    await cleanupGraphWorktree(handle, { artifactDigest: "a".repeat(64), verifySafe: async (record, digest) => {
      expect(record.runId).toBe("graph"); expect(record.worktreePath).toBe(handle.worktreePath); expect(digest).toBe("a".repeat(64)); checked++;
    } });
    expect(checked).toBeGreaterThanOrEqual(2);
    await expect(readFile(join(handle.worktreePath, "dirty.txt"))).rejects.toThrow();
  }, 15_000);

  it("fails closed for corrupted persistent retention and revoked safe cleanup", async () => {
    const { repo, root } = await makeRepo();
    const handle = await createWorktree({ repoPath: repo, runId: "graph", rootPath: root,
      graphRetention: { runId: "graph", scopeKey: "scope", generation: 1, workspaceLeaseRef: "lease" } });
    let count = 0;
    await expect(cleanupGraphWorktree(handle, { artifactDigest: "b".repeat(64), verifySafe: () => {
      if (++count > 1) throw new Error("lease revoked");
    } })).rejects.toThrow("lease revoked");
    const key = createHash("sha256").update(handle.worktreePath).digest("hex");
    await writeFile(join(repo, ".git", "osstack-graph-retention", `${key}.json`), "broken");
    await cleanupWorktree(handle);
    expect((await cleanupOrphanedWorktrees(repo, { rootPath: root })).removed).toEqual([]);
    await expect(cleanupGraphWorktree(handle, { artifactDigest: "b".repeat(64), verifySafe: () => undefined })).rejects.toThrow();
    expect(await readFile(join(handle.worktreePath, "README.md"), "utf8")).toBe("# test\n");
  });

  it("does not execute repository hooks while creating isolation", async () => {
    const { repo, root } = await makeRepo();
    const marker = join(root, "checkout-hook-ran");
    const hook = join(repo, ".git", "hooks", "post-checkout");
    await writeFile(
      hook,
      `#!/bin/sh\nprintf pwned > ${shellQuote(marker)}\n`,
    );
    await chmod(hook, 0o755);

    const handle = await createWorktree({
      repoPath: repo,
      runId: "checkout-hook",
      rootPath: root,
    });

    await expect(readFile(marker, "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await cleanupWorktree(handle);
  });

  it("commits isolated changes, fast-forwards the repo, and cleans up", async () => {
    const { repo, root } = await makeRepo();
    const handle = await createWorktree({ repoPath: repo, runId: "run-1", rootPath: root });

    await writeFile(join(handle.worktreePath, "feature.txt"), "done\n");
    const commit = await commitWorktreeChanges(handle, "loop task run-1");
    expect(commit.committed).toBe(true);
    expect(commit.commit).toMatch(/^[a-f0-9]{40}$/);

    await mergeWorktree(handle, { expectedCommit: commit.commit!, targetBranch: "main" });
    await expect(readFile(join(repo, "feature.txt"), "utf-8")).resolves.toBe("done\n");

    await cleanupWorktree(handle);
    await expect(readFile(join(handle.worktreePath, "feature.txt"), "utf-8")).rejects.toThrow();
    await expect(git(repo, ["rev-parse", "--verify", handle.branch])).rejects.toThrow();
  }, 15_000);

  it("removes orphaned osstack worktrees under the configured root", async () => {
    const { repo, root } = await makeRepo();
    const handle = await createWorktree({ repoPath: repo, runId: "orphan", rootPath: root });

    const result = await cleanupOrphanedWorktrees(repo, { rootPath: root });

    expect(result.removed).toEqual([
      expect.objectContaining({
        branch: handle.branch,
        worktreePath: handle.worktreePath,
      }),
    ]);
    await expect(readFile(join(handle.worktreePath, "README.md"), "utf-8")).rejects.toThrow();
  });

  it("does not commit when the isolated worktree is unchanged", async () => {
    const { repo, root } = await makeRepo();
    const handle: WorktreeHandle = await createWorktree({ repoPath: repo, runId: "unchanged", rootPath: root });

    await expect(commitWorktreeChanges(handle, "nothing to commit")).resolves.toEqual({ committed: false });

    await cleanupWorktree(handle);
  });

  it("commits untracked-only work even when repository config hides untracked files", async () => {
    const { repo, root } = await makeRepo();
    await git(repo, ["config", "status.showUntrackedFiles", "no"]);
    const handle = await createWorktree({ repoPath: repo, runId: "hidden-untracked", rootPath: root });
    await mkdir(join(handle.worktreePath, "nested"), { recursive: true });
    await writeFile(join(handle.worktreePath, "nested", "only-new.txt"), "verified\n");

    const commit = await commitWorktreeChanges(handle, "loop task hidden-untracked");

    expect(commit.committed).toBe(true);
    await expect(git(handle.worktreePath, ["show", "HEAD:nested/only-new.txt"])).resolves.toBe("verified");
    await cleanupWorktree(handle);
  });

  it("does not execute repository hooks while committing isolated changes", async () => {
    const { repo, root } = await makeRepo();
    const handle = await createWorktree({
      repoPath: repo,
      runId: "commit-hook",
      rootPath: root,
    });
    const marker = join(root, "commit-hook-ran");
    const hook = join(repo, ".git", "hooks", "pre-commit");
    await writeFile(
      hook,
      `#!/bin/sh\nprintf pwned > ${shellQuote(marker)}\nexit 99\n`,
    );
    await chmod(hook, 0o755);
    await writeFile(join(handle.worktreePath, "feature.txt"), "safe\n");

    await expect(
      commitWorktreeChanges(handle, "loop task commit-hook"),
    ).resolves.toMatchObject({ committed: true });
    await expect(readFile(marker, "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await cleanupWorktree(handle);
  });

  it("does not execute repository hooks while fast-forwarding verified changes", async () => {
    const { repo, root } = await makeRepo();
    const handle = await createWorktree({
      repoPath: repo,
      runId: "merge-hook",
      rootPath: root,
    });
    await writeFile(join(handle.worktreePath, "feature.txt"), "safe\n");
    const accepted = await commitWorktreeChanges(handle, "loop task merge-hook");
    const marker = join(root, "merge-hook-ran");
    const hook = join(repo, ".git", "hooks", "post-merge");
    await writeFile(
      hook,
      `#!/bin/sh\nprintf pwned > ${shellQuote(marker)}\n`,
    );
    await chmod(hook, 0o755);

    await mergeWorktree(handle, { expectedCommit: accepted.commit!, targetBranch: "main" });

    await expect(readFile(marker, "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await cleanupWorktree(handle);
  });

  it("lands only the accepted commit and refuses when the branch moved after acceptance", async () => {
    const { repo, root } = await makeRepo();
    const handle = await createWorktree({ repoPath: repo, runId: "pinned", rootPath: root });
    await writeFile(join(handle.worktreePath, "feature.txt"), "accepted\n");
    const accepted = await commitWorktreeChanges(handle, "loop task pinned");
    const before = await git(repo, ["rev-parse", "HEAD"]);
    // A lingering worker appends an unreviewed commit to the task branch.
    await writeFile(join(handle.worktreePath, "feature.txt"), "unreviewed\n");
    await git(handle.worktreePath, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "late"]);

    await expect(mergeWorktree(handle, { expectedCommit: accepted.commit!, targetBranch: "main" })).rejects.toThrow(/differs from the accepted commit/);
    await expect(git(repo, ["rev-parse", "HEAD"])).resolves.toBe(before);
    await cleanupWorktree(handle);
  });

  it("treats a whitespace-only rewrite of the accepted commit as different work", async () => {
    const { repo, root } = await makeRepo();
    const handle = await createWorktree({ repoPath: repo, runId: "whitespace", rootPath: root });
    await writeFile(join(handle.worktreePath, "config.yaml"), "a:\n  b: 1\n");
    const accepted = await commitWorktreeChanges(handle, "loop task whitespace");
    const before = await git(repo, ["rev-parse", "HEAD"]);
    // Same message, same paths, indentation changed: a patch-id that ignores
    // whitespace would call this equivalent, but the meaning differs.
    await git(handle.worktreePath, ["reset", "-q", "--hard", "HEAD~1"]);
    await writeFile(join(handle.worktreePath, "config.yaml"), "a:\nb: 1\n");
    await git(handle.worktreePath, ["add", "config.yaml"]);
    await git(handle.worktreePath, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "loop task whitespace"]);

    await expect(mergeWorktree(handle, { expectedCommit: accepted.commit!, targetBranch: "main" })).rejects.toThrow(/differs from the accepted commit/);
    await expect(git(repo, ["rev-parse", "HEAD"])).resolves.toBe(before);
    await cleanupWorktree(handle);
  });

  it("refuses an abbreviated or symbolic accepted commit", async () => {
    const { repo, root } = await makeRepo();
    const handle = await createWorktree({ repoPath: repo, runId: "pinned-shape", rootPath: root });
    await writeFile(join(handle.worktreePath, "feature.txt"), "accepted\n");
    const accepted = await commitWorktreeChanges(handle, "loop task pinned-shape");

    for (const expectedCommit of [accepted.commit!.slice(0, 12), handle.branch, "HEAD"]) {
      await expect(mergeWorktree(handle, { expectedCommit, targetBranch: "main" })).rejects.toThrow(/full commit id/);
    }
    await mergeWorktree(handle, { expectedCommit: accepted.commit!, targetBranch: "main" });
    await expect(git(repo, ["rev-parse", "HEAD"])).resolves.toBe(accepted.commit);
    await cleanupWorktree(handle);
  });

  it("records the start commit and reports executor-made commits on a clean tree (D6)", async () => {
    const { repo, root } = await makeRepo();
    const start = await git(repo, ["rev-parse", "HEAD"]);
    const handle = await createWorktree({ repoPath: repo, runId: "self-commit", rootPath: root });
    expect(handle.startCommit).toBe(start);
    await writeFile(join(handle.worktreePath, "feature.txt"), "executor work\n");
    await git(handle.worktreePath, ["add", "feature.txt"]);
    await git(handle.worktreePath, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "executor commit"]);
    const tip = await git(handle.worktreePath, ["rev-parse", "HEAD"]);

    await expect(commitWorktreeChanges(handle, "loop task self-commit")).resolves.toEqual({ committed: false, commit: tip, executorCommitted: true });
    await expect(cleanupWorktree(handle)).resolves.toEqual({ branchRemoved: false });
    await expect(git(repo, ["rev-parse", "--verify", `refs/heads/${handle.branch}`])).resolves.toBe(tip);
    await expect(git(repo, ["rev-parse", "HEAD"])).resolves.toBe(start);
  });

  it("refuses to land a loop commit stacked on executor-made commits", async () => {
    const { repo, root } = await makeRepo();
    const start = await git(repo, ["rev-parse", "HEAD"]);
    const handle = await createWorktree({ repoPath: repo, runId: "stacked", rootPath: root });
    await writeFile(join(handle.worktreePath, "a.txt"), "executor\n");
    await git(handle.worktreePath, ["add", "a.txt"]);
    await git(handle.worktreePath, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "executor commit"]);
    await writeFile(join(handle.worktreePath, "b.txt"), "loop\n");
    const accepted = await commitWorktreeChanges(handle, "loop task stacked");
    expect(accepted).toMatchObject({ committed: true, executorCommitted: true });

    await expect(mergeWorktree(handle, { expectedCommit: accepted.commit!, targetBranch: "main" })).rejects.toThrow(/commits beyond the accepted commit's start/);
    await expect(git(repo, ["rev-parse", "HEAD"])).resolves.toBe(start);
    await expect(cleanupWorktree(handle)).resolves.toEqual({ branchRemoved: false });
  });

  it("lands only onto the explicit target branch the main checkout has checked out (D7)", async () => {
    const { repo, root } = await makeRepo();
    const handle = await createWorktree({ repoPath: repo, runId: "target", rootPath: root });
    await writeFile(join(handle.worktreePath, "feature.txt"), "accepted\n");
    const accepted = await commitWorktreeChanges(handle, "loop task target");
    await git(repo, ["switch", "-q", "-c", "topic"]);
    const before = await git(repo, ["rev-parse", "HEAD"]);

    await expect(mergeWorktree(handle, { expectedCommit: accepted.commit!, targetBranch: "main" })).rejects.toThrow(/main checkout is on topic, not the landing target main/);
    for (const targetBranch of ["", "-main", "bad..name"]) {
      await expect(mergeWorktree(handle, { expectedCommit: accepted.commit!, targetBranch })).rejects.toThrow(/target branch/);
    }
    await expect(mergeWorktree(handle, { expectedCommit: accepted.commit! } as never)).rejects.toThrow(/explicit target branch/);
    await git(repo, ["switch", "-q", "--detach"]);
    await expect(mergeWorktree(handle, { expectedCommit: accepted.commit!, targetBranch: "main" })).rejects.toThrow(/detached HEAD/);
    await expect(git(repo, ["rev-parse", "HEAD"])).resolves.toBe(before);
    await expect(git(repo, ["rev-parse", "refs/heads/main"])).resolves.toBe(before);

    await git(repo, ["switch", "-q", "main"]);
    await mergeWorktree(handle, { expectedCommit: accepted.commit!, targetBranch: "main" });
    await expect(git(repo, ["rev-parse", "refs/heads/main"])).resolves.toBe(accepted.commit);
    await expect(git(repo, ["rev-parse", "refs/heads/topic"])).resolves.toBe(before);
    // Landed commits are reachable from main, so the task branch may go.
    await expect(cleanupWorktree(handle)).resolves.toEqual({ branchRemoved: true });
  });

  it("orphan cleanup keeps a branch whose commits exist nowhere else", async () => {
    const { repo, root } = await makeRepo();
    const handle = await createWorktree({ repoPath: repo, runId: "orphan-commit", rootPath: root });
    await writeFile(join(handle.worktreePath, "feature.txt"), "unique\n");
    const made = await commitWorktreeChanges(handle, "loop task orphan-commit");

    const result = await cleanupOrphanedWorktrees(repo, { rootPath: root });
    expect(result.removed).toEqual([expect.objectContaining({ branch: handle.branch })]);
    await expect(git(repo, ["rev-parse", "--verify", `refs/heads/${handle.branch}`])).resolves.toBe(made.commit);
  });

  it("can remove a worktree while preserving its branch", async () => {
    const { repo, root } = await makeRepo();
    const handle = await createWorktree({ repoPath: repo, runId: "preserve", rootPath: root });

    await writeFile(join(handle.worktreePath, "feature.txt"), "saved\n");
    await commitWorktreeChanges(handle, "loop task preserve");
    await cleanupWorktree(handle, { removeBranch: false });

    await expect(readFile(join(handle.worktreePath, "feature.txt"), "utf-8")).rejects.toThrow();
    await expect(git(repo, ["rev-parse", "--verify", handle.branch])).resolves.toMatch(/^[a-f0-9]{40}$/);
    await cleanupWorktree(handle);
  });
});

async function makeRepo(): Promise<{ repo: string; root: string }> {
  const dir = mkdtempSync(join(tmpdir(), "osstack-agents-worktree-"));
  roots.push(dir);
  const repo = join(dir, "repo");
  const root = join(dir, "worktrees");
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await writeFile(join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, [
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  return { repo, root };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

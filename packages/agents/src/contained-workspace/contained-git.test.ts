import { execFileSync } from "node:child_process";
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createScratchDir } from "@osstack/core";
import { describe, expect, it } from "vitest";
import { HardenedGitError, hardenedGitEnvironment, runHardenedGit } from "./hardened-git.js";
import { ContainedWorkspaceError, commitPlumbing, createNoCheckoutWorktree } from "./plumbing.js";
import { assertRepoConfigUnchanged, filterNeutralizingConfig, inspectRepoConfig, RepoConfigChangedError } from "./repo-config.js";

const AUTHOR = { name: "Mission Host", email: "host@example.invalid", date: "1700000000 +0000" };
const setupEnv = {
  ...hardenedGitEnvironment(process.env),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: setupEnv, encoding: "utf8" }).trim();

interface Fixture {
  dir: string;
  repo: string;
  head: string;
  canary: string;
}

async function makeRepo(files: Record<string, string>, executables: string[] = [], links: Record<string, string> = {}): Promise<Fixture> {
  const dir = await createScratchDir("tests", "contained-git");
  const repo = join(dir, "repo");
  await mkdir(repo);
  sh(repo, "init", "-q", "-b", "main");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  for (const path of executables) await chmod(join(repo, path), 0o755);
  for (const [path, target] of Object.entries(links)) await symlink(target, join(repo, path));
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "initial");
  return { dir, repo, head: sh(repo, "rev-parse", "HEAD"), canary: join(dir, "canary") };
}

const errorCode = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error as { code?: string }).code ?? String(error),
  );
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("hardened git runner", () => {
  it("keeps only PATH, HOME and locale variables and pins the GIT_* hardening", () => {
    const env = hardenedGitEnvironment(
      { PATH: "/bin", HOME: "/h", LANG: "C", LC_ALL: "C", GIT_DIR: "/evil", GIT_CONFIG_PARAMETERS: "'core.pager=x'", GH_TOKEN: "t", SSH_AUTH_SOCK: "/s" },
      "/isolated",
    );
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/isolated",
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  it("ignores ambient GIT_* variables, bounds output and honours an aborted signal", async () => {
    const { repo, dir } = await makeRepo({ "big.txt": "x".repeat(4096) });
    const result = await runHardenedGit(["rev-parse", "--show-toplevel"], { cwd: repo, env: { ...process.env, GIT_DIR: join(dir, "nowhere"), GIT_WORK_TREE: dir } });
    expect(result.stdout.toString().trim()).toBe(sh(repo, "rev-parse", "--show-toplevel"));
    const blob = sh(repo, "rev-parse", "HEAD:big.txt");
    expect(await errorCode(runHardenedGit(["cat-file", "blob", blob], { cwd: repo, maxOutputBytes: 100 }))).toBe("HARDENED_GIT_OUTPUT_LIMIT");
    expect(await errorCode(runHardenedGit(["status"], { cwd: repo, signal: AbortSignal.abort() }))).toBe("HARDENED_GIT_ABORTED");
    expect(await errorCode(runHardenedGit(["rev-parse", "--verify", "nope"], { cwd: repo }))).toBe("HARDENED_GIT_FAILED");
    expect(await errorCode(runHardenedGit(["status"], { cwd: repo, config: [["bad key", "x"]] }))).toBe("HARDENED_GIT_INVALID_ARGS");
  });
  it("kills helpers git spawned when the timeout fires", async () => {
    const { repo } = await makeRepo({ "a.txt": "a\n" });
    const started = Date.now();
    const slow = runHardenedGit(["slow"], { cwd: repo, timeoutMs: 100, config: [["alias.slow", "!sleep 5"]] });
    expect(await errorCode(slow)).toBe("HARDENED_GIT_TIMEOUT");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("inspectRepoConfig", () => {
  it("accepts a clean repository with a stable digest and detects changes", async () => {
    const { repo } = await makeRepo({ "a.txt": "a\n" });
    const first = await inspectRepoConfig(repo);
    expect(first.rejections).toEqual([]);
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await inspectRepoConfig(repo)).digest).toBe(first.digest);
    await expect(assertRepoConfigUnchanged(repo, first.digest)).resolves.toMatchObject({ digest: first.digest });
    sh(repo, "config", "core.autocrlf", "false");
    const changed = assertRepoConfigUnchanged(repo, first.digest);
    await expect(changed).rejects.toBeInstanceOf(RepoConfigChangedError);
    expect(await errorCode(assertRepoConfigUnchanged(repo, first.digest))).toBe("REPO_CONFIG_CHANGED");
  });

  it("produces a stable rejection code per dangerous key", async () => {
    const { repo, dir } = await makeRepo({ "a.txt": "a\n" });
    const outside = join(dir, "outside.cfg");
    await writeFile(outside, "[core]\n\thooksPath = /tmp/hooks\n");
    sh(repo, "config", "filter.x.clean", "cat");
    sh(repo, "config", "core.sshCommand", "ssh -i key");
    sh(repo, "config", "credential.helper", "store");
    sh(repo, "config", "url.https://evil.invalid/.insteadOf", "https://github.com/");
    sh(repo, "config", "include.path", outside);
    sh(repo, "config", "diff.bin.textconv", "hexdump");
    sh(repo, "config", "remote.origin.uploadpack", "evil");
    sh(repo, "config", "http.proxy", "http://proxy.invalid");
    const { rejections } = await inspectRepoConfig(repo);
    expect(rejections.map((rejection) => [rejection.code, rejection.key])).toEqual([
      ["REPO_CONFIG_CORE_PROGRAM", "core.sshcommand"],
      ["REPO_CONFIG_FILTER", "filter.x.clean"],
      ["REPO_CONFIG_CREDENTIAL", "credential.helper"],
      ["REPO_CONFIG_URL_REWRITE", "url.https://evil.invalid/.insteadof"],
      ["REPO_CONFIG_INCLUDE_OUTSIDE", "include.path"],
      ["REPO_CONFIG_HOOKS_PATH", "core.hookspath"],
      ["REPO_CONFIG_DIFF_PROGRAM", "diff.bin.textconv"],
      ["REPO_CONFIG_REMOTE_TRANSPORT", "remote.origin.uploadpack"],
      ["REPO_CONFIG_HTTP_PROXY", "http.proxy"],
    ]);
  });

  it("allows includes inside .git but still inspects and digests their contents", async () => {
    const { repo } = await makeRepo({ "a.txt": "a\n" });
    await writeFile(join(repo, ".git", "extra.cfg"), "[core]\n\tquotePath = false\n");
    sh(repo, "config", "include.path", "extra.cfg");
    sh(repo, "config", "includeIf.gitdir:/never/.path", "extra.cfg");
    const before = await inspectRepoConfig(repo);
    expect(before.rejections).toEqual([]);
    expect(before.entries.some((entry) => entry.key === "core.quotepath")).toBe(true);
    await writeFile(join(repo, ".git", "extra.cfg"), "[credential]\n\thelper = store\n");
    const after = await inspectRepoConfig(repo);
    expect(after.digest).not.toBe(before.digest);
    expect(after.rejections.map((rejection) => rejection.code)).toEqual(["REPO_CONFIG_CREDENTIAL"]);
  });
});

describe("no-checkout worktree and plumbing commit", () => {
  it("materializes contents and exec bits with a clean status", async () => {
    const fixture = await makeRepo({ "README.md": "# hi\n", "bin/run.sh": "#!/bin/sh\necho ok\n", "src/deep/x.ts": "export {};\n" }, ["bin/run.sh"]);
    const worktreePath = join(fixture.dir, "wt");
    const result = await createNoCheckoutWorktree({ repoPath: fixture.repo, worktreePath, branch: "mission/m3", startCommit: fixture.head });
    expect(result.files.map((file) => [file.path, file.mode])).toEqual([
      ["README.md", "100644"],
      ["bin/run.sh", "100755"],
      ["src/deep/x.ts", "100644"],
    ]);
    expect(await readFile(join(worktreePath, "bin/run.sh"), "utf8")).toBe("#!/bin/sh\necho ok\n");
    expect((await stat(join(worktreePath, "bin/run.sh"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(worktreePath, "README.md"))).mode & 0o777).toBe(0o644);
    expect(sh(worktreePath, "status", "--porcelain")).toBe("");
    expect(sh(worktreePath, "rev-parse", "HEAD")).toBe(fixture.head);
    expect(sh(worktreePath, "symbolic-ref", "HEAD")).toBe("refs/heads/mission/m3");
  });

  it("rejects a commit containing a symlink and a short commit id", async () => {
    const fixture = await makeRepo({ "a.txt": "a\n" }, [], { "link.txt": "a.txt" });
    expect(await errorCode(createNoCheckoutWorktree({ repoPath: fixture.repo, worktreePath: join(fixture.dir, "wt"), branch: "m", startCommit: fixture.head }))).toBe(
      "WORKSPACE_TREE_SYMLINK",
    );
    expect(await exists(join(fixture.dir, "wt", "a.txt"))).toBe(false);
    expect(await errorCode(createNoCheckoutWorktree({ repoPath: fixture.repo, worktreePath: join(fixture.dir, "wt2"), branch: "m2", startCommit: fixture.head.slice(0, 12) }))).toBe(
      "WORKSPACE_INVALID_COMMIT",
    );
  });

  it("commits writes and deletes with plumbing and keeps status clean", async () => {
    const fixture = await makeRepo({ "README.md": "# hi\n", "old.txt": "bye\n", "keep/k.txt": "k\n" });
    const worktree = join(fixture.dir, "wt");
    await createNoCheckoutWorktree({ repoPath: fixture.repo, worktreePath: worktree, branch: "mission/commit", startCommit: fixture.head });
    await writeFile(join(worktree, "README.md"), "# changed\n");
    const result = await commitPlumbing({
      worktree,
      branch: "mission/commit",
      expectedHead: fixture.head,
      message: "mission: apply patch",
      author: AUTHOR,
      files: [
        { path: "README.md", action: "write" },
        { path: "new/tool.sh", action: "write", content: "#!/bin/sh\n", executable: true },
        { path: "old.txt", action: "delete" },
      ],
    });
    expect(sh(fixture.repo, "rev-parse", "refs/heads/mission/commit")).toBe(result.head);
    expect(sh(fixture.repo, "rev-parse", `${result.head}^`)).toBe(fixture.head);
    expect(sh(fixture.repo, "rev-parse", `${result.head}^{tree}`)).toBe(result.tree);
    expect(sh(fixture.repo, "ls-tree", "-r", "--format=%(objectmode) %(path)", result.tree).split("\n")).toEqual([
      "100644 README.md",
      "100644 keep/k.txt",
      "100755 new/tool.sh",
    ]);
    expect(sh(fixture.repo, "show", `${result.head}:README.md`)).toBe("# changed");
    expect(sh(fixture.repo, "log", "-1", "--format=%an <%ae> %at %s", result.head)).toBe("Mission Host <host@example.invalid> 1700000000 mission: apply patch");
    expect(await exists(join(worktree, "old.txt"))).toBe(false);
    expect(sh(worktree, "status", "--porcelain")).toBe("");
  });

  it("fails with a stable code on a stale expected head and leaves the ref alone", async () => {
    const fixture = await makeRepo({ "a.txt": "a\n" });
    const worktree = join(fixture.dir, "wt");
    await createNoCheckoutWorktree({ repoPath: fixture.repo, worktreePath: worktree, branch: "mission/stale", startCommit: fixture.head });
    const first = await commitPlumbing({ worktree, branch: "mission/stale", expectedHead: fixture.head, message: "one", author: AUTHOR, files: [{ path: "a.txt", action: "write", content: "b\n" }] });
    const stale = commitPlumbing({ worktree, branch: "mission/stale", expectedHead: fixture.head, message: "two", author: AUTHOR, files: [{ path: "a.txt", action: "write", content: "c\n" }] });
    await expect(stale).rejects.toBeInstanceOf(ContainedWorkspaceError);
    expect(
      await errorCode(
        commitPlumbing({ worktree, branch: "mission/stale", expectedHead: fixture.head, message: "two", author: AUTHOR, files: [{ path: "a.txt", action: "write", content: "c\n" }] }),
      ),
    ).toBe("PLUMBING_COMMIT_STALE_HEAD");
    expect(sh(fixture.repo, "rev-parse", "refs/heads/mission/stale")).toBe(first.head);
    expect(await errorCode(commitPlumbing({ worktree, branch: "mission/other", expectedHead: first.head, message: "x", author: AUTHOR, files: [{ path: "a.txt", action: "write" }] }))).toBe(
      "PLUMBING_COMMIT_BRANCH_MISMATCH",
    );
  });

  it("never runs clean, smudge or process filters during materialization and commit", async () => {
    const fixture = await makeRepo({ ".gitattributes": "*.txt filter=x\n", "a.txt": "raw\n" });
    const touch = `sh -c 'touch "${fixture.canary}"; cat'`;
    sh(fixture.repo, "config", "filter.x.clean", touch);
    sh(fixture.repo, "config", "filter.x.smudge", touch);
    sh(fixture.repo, "config", "filter.x.process", `touch "${fixture.canary}"`);
    sh(fixture.repo, "config", "filter.x.required", "true");
    const preflight = await inspectRepoConfig(fixture.repo);
    expect(preflight.rejections.map((rejection) => rejection.code)).toContain("REPO_CONFIG_FILTER");

    // Deliberately bypass the preflight to prove the plumbing alone never runs the filter.
    const worktree = join(fixture.dir, "wt");
    await createNoCheckoutWorktree({ repoPath: fixture.repo, worktreePath: worktree, branch: "mission/filter", startCommit: fixture.head });
    expect(await readFile(join(worktree, "a.txt"), "utf8")).toBe("raw\n");
    const result = await commitPlumbing({
      worktree,
      branch: "mission/filter",
      expectedHead: fixture.head,
      message: "filtered?",
      author: AUTHOR,
      files: [
        { path: "a.txt", action: "write", content: "changed\n" },
        { path: "b.txt", action: "write", content: "new\n" },
      ],
    });
    const status = await runHardenedGit(["status", "--porcelain"], { cwd: worktree, config: await filterNeutralizingConfig(worktree) });
    expect(status.stdout.toString()).toBe("");
    expect(await exists(fixture.canary)).toBe(false);
    expect(sh(fixture.repo, "cat-file", "blob", `${result.head}:a.txt`)).toBe("changed");
  });

  it("never runs repository hooks, even with a local core.hooksPath", async () => {
    const fixture = await makeRepo({ "a.txt": "a\n" });
    const hooks = [join(fixture.repo, ".git", "hooks"), join(fixture.dir, "custom-hooks")];
    for (const directory of hooks) {
      await mkdir(directory, { recursive: true });
      for (const hook of ["post-checkout", "reference-transaction", "pre-commit", "post-commit", "post-index-change", "pre-auto-gc"]) {
        await writeFile(join(directory, hook), `#!/bin/sh\ntouch "${fixture.canary}"\n`);
        await chmod(join(directory, hook), 0o755);
      }
    }
    sh(fixture.repo, "config", "core.hooksPath", hooks[1] as string);
    expect((await inspectRepoConfig(fixture.repo)).rejections.map((rejection) => rejection.code)).toEqual(["REPO_CONFIG_HOOKS_PATH"]);
    const worktree = join(fixture.dir, "wt");
    await createNoCheckoutWorktree({ repoPath: fixture.repo, worktreePath: worktree, branch: "mission/hooks", startCommit: fixture.head });
    await commitPlumbing({ worktree, branch: "mission/hooks", expectedHead: fixture.head, message: "hooks?", author: AUTHOR, files: [{ path: "a.txt", action: "write", content: "b\n" }] });
    expect(await exists(fixture.canary)).toBe(false);
  });

  it("refuses to proceed when the recorded config digest has changed", async () => {
    const fixture = await makeRepo({ "a.txt": "a\n" });
    const { digest } = await inspectRepoConfig(fixture.repo);
    sh(fixture.repo, "config", "core.sshCommand", "evil");
    expect(
      await errorCode(createNoCheckoutWorktree({ repoPath: fixture.repo, worktreePath: join(fixture.dir, "wt"), branch: "m", startCommit: fixture.head, expectedConfigDigest: digest })),
    ).toBe("REPO_CONFIG_CHANGED");
    expect(await readdir(fixture.dir)).not.toContain("wt");
  });

  it("surfaces git failures as HardenedGitError", async () => {
    const fixture = await makeRepo({ "a.txt": "a\n" });
    const missing = "0".repeat(40);
    const failure = createNoCheckoutWorktree({ repoPath: fixture.repo, worktreePath: join(fixture.dir, "wt"), branch: "m", startCommit: missing });
    await expect(failure).rejects.toBeInstanceOf(HardenedGitError);
  });
});

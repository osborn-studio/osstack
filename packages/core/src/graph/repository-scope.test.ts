import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRepositoryScope } from "./repository-scope.js";
import { readRepositoryGit } from "./repository-git.js";

const exec = promisify(execFile);
let root: string;
let repo: string;
async function git(cwd: string, ...args: string[]) {
  return await exec("git", args, { cwd, timeout: 5_000, env: {
    ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  } });
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "osstack-scope-"));
  repo = join(root, "repo ; $(touch forged)");
  await mkdir(repo);
  await git(repo, "init");
  await git(repo, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("trusted filesystem repository identity", () => {
  it("shares full canonical common-dir SHA256 identity across worktrees and symlinks", async () => {
    const worktree = join(root, "work tree");
    await git(repo, "worktree", "add", "--detach", worktree);
    const alias = join(root, "alias");
    await symlink(worktree, alias);
    const commonDir = await realpath(join(repo, ".git"));
    const expectedId = `repo-${createHash("sha256").update(commonDir).digest("hex")}`;
    for (const workspace of [repo, worktree, alias]) {
      expect(await resolveRepositoryScope(workspace)).toEqual({
        commonDir, repoId: expectedId, workspacePath: await realpath(workspace),
      });
    }
    await expect(realpath(join(root, "forged"))).rejects.toThrow();
  });

  it("accepts canonical hints, rejects forged identity and missing common-dir hints", async () => {
    const actual = await resolveRepositoryScope(repo);
    const alias = join(root, "git-alias");
    await symlink(actual.commonDir, alias);
    expect(await resolveRepositoryScope(repo, { repoId: actual.repoId, commonDir: alias })).toEqual(actual);
    await expect(resolveRepositoryScope(repo, { repoId: "forged" })).rejects.toThrow(/identity|match/i);
    await expect(resolveRepositoryScope(repo, { commonDir: root })).rejects.toThrow(/identity|match/i);
    await expect(resolveRepositoryScope(repo, { commonDir: join(root, "missing") })).rejects.toThrow();
    await expect(resolveRepositoryScope(repo, { repoId: "" })).rejects.toThrow();
  });

  it("rejects absent, empty, non-directory and non-repository paths", async () => {
    await writeFile(join(root, "file"), "fixture");
    for (const path of ["", join(root, "missing"), join(root, "file"), root]) {
      await expect(resolveRepositoryScope(path)).rejects.toThrow();
    }
  });

  it("ignores inherited git directory and common-directory redirection", async () => {
    const actual = await resolveRepositoryScope(repo);
    const keys = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
    const saved = keys.map((key) => process.env[key]);
    try {
      process.env.GIT_DIR = root;
      process.env.GIT_COMMON_DIR = root;
      process.env.GIT_WORK_TREE = root;
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = "core.bare";
      process.env.GIT_CONFIG_VALUE_0 = "true";
      expect(await resolveRepositoryScope(repo)).toEqual(actual);
    } finally {
      keys.forEach((key, index) => {
        const value = saved[index];
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      });
    }
  });

  it("distinguishes independent repositories", async () => {
    const other = join(root, "other");
    await mkdir(other);
    await git(other, "init");
    expect((await resolveRepositoryScope(other)).repoId).not.toBe((await resolveRepositoryScope(repo)).repoId);
  });
});


it("retains completed Git output after the host stalls beyond the subprocess deadline", async () => {
  const pending = readRepositoryGit(repo, 'topLevel');
  // The OS can finish Git while JS cannot process its streams or exit event.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6_000);
  expect((await pending).trimEnd()).toBe(await realpath(repo));
  expect(await readRepositoryGit(repo, 'worktrees')).toContain('worktree ');
}, 15_000);

it("bounds Git subprocess output and terminates a hung Git process", async () => {
  const bin = join(root, "fake-bin");
  await mkdir(bin);
  const executable = join(bin, "git");
  const marker = join(root, "git-pid");
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write("x".repeat(100000));`, { mode: 0o700 });
    await expect(resolveRepositoryScope(repo)).rejects.toThrow(/buffer|stdout/i);
    await writeFile(executable, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`, { mode: 0o700 });
    const started = performance.now();
    await expect(resolveRepositoryScope(repo)).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(8_000);
    const pid = Number(await readFile(marker, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  }
}, 10_000);

it("bounds output drain when an exited Git leader leaves an inherited pipe open", async () => {
  const bin = join(root, 'pipe-bin'); await mkdir(bin);
  const marker = join(root, 'pipe-holder-pid');
  const originalPath = process.env.PATH;
  try {
    await writeFile(join(bin, 'git'), `#!${process.execPath}\nconst child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] }); require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(child.pid)); child.unref();`, { mode: 0o700 });
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    const started = performance.now();
    await expect(readRepositoryGit(repo, 'topLevel')).rejects.toThrow(/deadline|timed out/);
    expect(performance.now() - started).toBeLessThan(8_000);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    const pid = Number(await readFile(marker, 'utf8').catch(() => '0'));
    if (pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ } }
  }
}, 10_000);

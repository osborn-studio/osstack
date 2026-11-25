import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { exportContainedCommit } from "@osstack/agents/contained-profile";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createGitSource } from "./source.js";

let root: string, reposDir: string, work: string, bare: string, head: string, linked: string;
const name = "owner/project";
const signal = new AbortController().signal;
function git(dir: string, ...args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=",
    "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "-c", "http.followRedirects=false",
    "-c", "fetch.fsckObjects=true", "-C", dir, ...args], { env: {
      PATH: "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin", HOME: root, GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_ASKPASS: "/bin/false",
      GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", LC_ALL: "C",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "test@example.invalid",
    } });
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "source-"));
  reposDir = join(root, "repos");
  work = join(root, "work");
  bare = join(root, "fixture.git");
  await mkdir(reposDir);
  await mkdir(work);
  git(work, "init", "--quiet");
  await writeFile(join(work, "plain"), Buffer.from([0, 255, 10]));
  await writeFile(join(work, "script"), "exit 0", { mode: 0o755 });
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "files");
  head = git(work, "rev-parse", "HEAD").toString().trim();
  await symlink("plain", join(work, "link"));
  git(work, "add", "link");
  git(work, "commit", "--quiet", "-m", "link");
  linked = git(work, "rev-parse", "HEAD").toString().trim();
  git(root, "clone", "--quiet", "--bare", work, bare);
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
  await writeFile(join(bare, "hooks/post-checkout"), "#!/bin/sh\ntouch \"$(git rev-parse --git-dir)/hook-ran\"\n", { mode: 0o755 });
});
afterEach(async () => {
  expect(await readdir(reposDir)).toEqual([]);
  expect(existsSync(join(bare, "hook-ran"))).toBe(false);
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const local = () => ({ reposDir, protocol: "file" as const, remote: () => bare });
it("exports the requested commit from a new private repository each time", async () => {
  const directories = new Set<string>();
  const source = createGitSource({ ...local(), exportCommit(dir, sha) {
    expect(resolve(dir, "..")).toBe(reposDir);
    expect(basename(dir)).toMatch(/^[a-f0-9-]{36}\.git$/u);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    directories.add(dir);
    return exportContainedCommit(dir, sha);
  } });
  const tree = git(work, "rev-parse", head + "^{tree}").toString().trim();
  const files = git(work, "ls-tree", "-r", head).toString().trimEnd().split("\n").map(row => {
    const [metadata, path] = row.split("\t");
    const [mode, , oid] = metadata!.split(" ");
    return { path, mode, bytes: git(work, "cat-file", "blob", oid!) };
  });
  expect(await source(name, head, signal)).toEqual({ tree, files });
  expect(await source(name, head, signal)).toEqual({ tree, files });
  expect(directories.size).toBe(2);
});
it("refuses an absent SHA and a file path under the default protocol", async () => {
  await expect(createGitSource(local())(name, "1".repeat(40), signal)).rejects.toThrow(/^source_unavailable$/);
  expect(await readdir(reposDir)).toEqual([]);
  await expect(createGitSource({ reposDir, remote: () => bare })(name, head, signal)).rejects.toThrow(/^source_unavailable$/);
});
it("preserves the regular-file limit from the second export", async () => {
  await expect(createGitSource(local())(name, linked, signal)).rejects.toThrow(/^CONTAINED_CANDIDATE_REGULAR_FILES_REQUIRED$/);
});
it("closes other export failures even if the diagnostic export succeeds", async () => {
  for (const message of [bare, "CONTAINED_COMMIT_EXPORT_FAILED"]) {
    const source = createGitSource({ ...local(), exportCommit() { throw Error(message); } });
    await expect(source(name, head, signal)).rejects.toThrow(/^source_unavailable$/);
    expect(await readdir(reposDir)).toEqual([]);
  }
});
it("cancels the fetch before export", async () => {
  const controller = new AbortController();
  const exportCommit = vi.fn<typeof exportContainedCommit>();
  const source = createGitSource({ ...local(), exportCommit, remote() { controller.abort(); return bare; } });
  await expect(source(name, head, controller.signal)).rejects.toThrow(/^source_unavailable$/);
  expect(exportCommit).not.toHaveBeenCalled();
});
it("rejects invalid source inputs before selecting a remote", async () => {
  const remote = vi.fn(() => bare);
  for (const [dir, repo, sha] of [[reposDir, "../repo", head], [reposDir, name, "HEAD"], ["relative", name, head]] as const) {
    await expect(createGitSource({ reposDir: dir, remote })(repo, sha, signal)).rejects.toThrow(/^source_unavailable$/);
  }
  expect(remote).not.toHaveBeenCalled();
});

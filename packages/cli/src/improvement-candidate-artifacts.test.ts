import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertCandidateUnchanged, captureImprovementCandidate, validateImprovementPaths } from "./improvement-candidate-artifacts.js";

const exec = promisify(execFile);
let root: string;
let workspace: string;
let base: string;
async function git(args: string[], cwd = workspace): Promise<string> {
  return (await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } })).stdout;
}
async function file(path: string, value: string | Buffer): Promise<void> {
  const parts = path.split("/"); parts.pop();
  if (parts.length > 0) await mkdir(join(workspace, ...parts), { recursive: true });
  await writeFile(join(workspace, path), value);
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "osstack-improvement-artifact-"));
  workspace = join(root, "candidate");
  await mkdir(workspace);
  await git(["init", "-b", "main"]);
  await file("docs/a.md", "base a\n");
  await file("docs/b.md", "base b\n");
  await file(".gitignore", "node_modules/\n.cache/\ngenerated/\n");
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
  base = (await git(["rev-parse", "HEAD"])).trim();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("improvement candidate artifacts", () => {
  it("captures staged, unstaged, added, deleted and renamed files without altering the source index", async () => {
    await file("docs/a.md", "staged\n");
    await git(["add", "docs/a.md"]);
    await file("docs/a.md", "final unstaged\n");
    await rename(join(workspace, "docs/b.md"), join(workspace, "docs/renamed.md"));
    await file("tests/new.test.ts", "export const answer = 42;\n");
    const indexBefore = await readFile(join(workspace, ".git/index"));
    const paths = ["docs/renamed.md", "tests/new.test.ts", "docs/b.md", "docs/a.md"];
    const captured = await captureImprovementCandidate(workspace, base, paths);
    expect(captured.changed_paths).toEqual(["docs/a.md", "docs/b.md", "docs/renamed.md", "tests/new.test.ts"]);
    expect(captured.head_sha).toBe(base);
    expect(captured.patch).toContain("final unstaged");
    expect(captured.patch).not.toContain("+staged");
    expect(captured.files.find((entry) => entry.path === "docs/b.md")?.sha256).toBe(null);
    expect(captured.patch_sha256).toBe(createHash("sha256").update(captured.patch).digest("hex"));
    expect(await readFile(join(workspace, ".git/index"))).toEqual(indexBefore);
    const repeated = await captureImprovementCandidate(workspace, base, paths.reverse());
    expect(repeated).toEqual(captured);

    const replay = join(root, "replay");
    await git(["clone", "--no-hardlinks", workspace, replay], root);
    const patchFile = join(root, "candidate.patch");
    await writeFile(patchFile, captured.patch);
    await git(["apply", "--check", patchFile], replay);
    await git(["apply", patchFile], replay);
    expect(await readFile(join(replay, "docs/a.md"), "utf8")).toBe("final unstaged\n");
    expect(await readFile(join(replay, "docs/renamed.md"), "utf8")).toBe("base b\n");
    expect(await readFile(join(replay, "tests/new.test.ts"), "utf8")).toBe("export const answer = 42;\n");
    await expect(readFile(join(replay, "docs/b.md"))).rejects.toThrow();
  });

  it("emits a reproducible binary and executable-mode patch", async () => {
    const binary = Buffer.from([0, 255, 1, 0, 44, 192, 128]);
    await file("evals/data.bin", binary);
    await file("tests/check.sh", "#!/bin/sh\nexit 0\n");
    await chmod(join(workspace, "tests/check.sh"), 0o755);
    const captured = await captureImprovementCandidate(workspace, base, ["evals/data.bin", "tests/check.sh"]);
    expect(captured.patch).toContain("GIT binary patch");
    expect(captured.patch).toContain("new file mode 100755");
    const replay = join(root, "replay");
    await git(["clone", workspace, replay], root);
    const patchFile = join(root, "binary.patch");
    await writeFile(patchFile, captured.patch);
    await git(["apply", patchFile], replay);
    expect(await readFile(join(replay, "evals/data.bin"))).toEqual(binary);
  });

  it("includes both paths of a staged rename", async () => {
    await git(["mv", "docs/a.md", "docs/renamed.md"]);
    await expect(captureImprovementCandidate(workspace, base, ["docs/renamed.md"])).rejects.toThrow(/allowed/i);
    const captured = await captureImprovementCandidate(workspace, base, ["docs/a.md", "docs/renamed.md"]);
    expect(captured.changed_paths).toEqual(["docs/a.md", "docs/renamed.md"]);
  });

  it("preserves non-UTF-8 binary bytes even when they contain no NUL", async () => {
    const binary = Buffer.from([255, 254, 128, 10]);
    await file("evals/non-utf8.bin", binary);
    const captured = await captureImprovementCandidate(workspace, base, ["evals/non-utf8.bin"]);
    expect(captured.patch).toContain("GIT binary patch");
    const replay = join(root, "replay");
    await git(["clone", workspace, replay], root);
    const patchFile = join(root, "non-utf8.patch");
    await writeFile(patchFile, captured.patch);
    await git(["apply", patchFile], replay);
    expect(await readFile(join(replay, "evals/non-utf8.bin"))).toEqual(binary);
  });

  it("rejects out-of-scope staged content even when the worktree has been restored", async () => {
    await file("docs/b.md", "staged hidden change\n");
    await git(["add", "docs/b.md"]);
    await file("docs/b.md", "base b\n");
    await file("docs/a.md", "allowed change\n");
    await expect(captureImprovementCandidate(workspace, base, ["docs/a.md"])).rejects.toThrow(/allowed/i);
  });

  it("detects reviewer index mutations even when the emitted working-tree patch is unchanged", async () => {
    await file("docs/a.md", "candidate\n");
    const before = await captureImprovementCandidate(workspace, base, ["docs/a.md"]);
    await git(["add", "docs/a.md"]);
    const after = await captureImprovementCandidate(workspace, base, ["docs/a.md"]);
    expect(after.patch_sha256).toBe(before.patch_sha256);
    expect(() => assertCandidateUnchanged(before, after)).toThrow(/changed/i);
  });

  it("detects permission-only reviewer changes and rejects a staged-only empty patch", async () => {
    await file("docs/a.md", "candidate\n");
    const before = await captureImprovementCandidate(workspace, base, ["docs/a.md"]);
    await chmod(join(workspace, "docs/a.md"), 0o755);
    const after = await captureImprovementCandidate(workspace, base, ["docs/a.md"]);
    expect(before.files).toEqual(after.files);
    expect(() => assertCandidateUnchanged(before, after)).toThrow(/changed/i);
    await chmod(join(workspace, "docs/a.md"), 0o644);
    await git(["add", "docs/a.md"]);
    await file("docs/a.md", "base a\n");
    await expect(captureImprovementCandidate(workspace, base, ["docs/a.md"])).rejects.toThrow(/empty/i);
  });

  it("ignores normal ignored caches but detects ignored source files", async () => {
    await file("docs/a.md", "candidate\n");
    const before = await captureImprovementCandidate(workspace, base, ["docs/a.md"]);
    await file("node_modules/pkg/cache.js", "cache\n");
    await file(".cache/output", "cache\n");
    const after = await captureImprovementCandidate(workspace, base, ["docs/a.md"]);
    expect(() => assertCandidateUnchanged(before, after)).not.toThrow();
    await file("generated/hidden-source.ts", "export const hidden = true;\n");
    await expect(captureImprovementCandidate(workspace, base, ["docs/a.md"])).rejects.toThrow(/allowed/i);
  });

  it("does not let assume-unchanged hide a tracked modification", async () => {
    await git(["update-index", "--assume-unchanged", "docs/b.md"]);
    await file("docs/b.md", "hidden tracked change\n");
    await file("docs/a.md", "candidate\n");
    await expect(captureImprovementCandidate(workspace, base, ["docs/a.md"])).rejects.toThrow(/allowed/i);
  });

  it("rejects empty candidates and a moved HEAD", async () => {
    await expect(captureImprovementCandidate(workspace, base, ["docs/a.md"])).rejects.toThrow(/empty/i);
    await file("docs/a.md", "committed change\n");
    await git(["add", "."]);
    await git(["commit", "-m", "unexpected commit"]);
    await expect(captureImprovementCandidate(workspace, base, ["docs/a.md"])).rejects.toThrow(/HEAD/i);
  });

  it("rejects symlink candidates and symlink ancestors", async () => {
    await symlink("a.md", join(workspace, "docs/link.md"));
    await expect(captureImprovementCandidate(workspace, base, ["docs/link.md"])).rejects.toThrow(/symbolic|symlink/i);
    await unlink(join(workspace, "docs/link.md"));
    await rename(join(workspace, "docs"), join(root, "external-docs"));
    await symlink(join(root, "external-docs"), join(workspace, "docs"));
    await expect(captureImprovementCandidate(workspace, base, ["docs/a.md"])).rejects.toThrow(/symbolic|symlink/i);
  });

  it("rejects gitlink index entries", async () => {
    await git(["update-index", "--add", "--cacheinfo", `160000,${base},tests/submodule`]);
    await expect(captureImprovementCandidate(workspace, base, ["tests/submodule"])).rejects.toThrow(/gitlink|submodule/i);
  });

  it("rejects staged symlinks even when replaced by a regular working-tree file", async () => {
    await symlink("a.md", join(workspace, "docs/link.md"));
    await git(["add", "docs/link.md"]);
    await unlink(join(workspace, "docs/link.md"));
    await file("docs/link.md", "ordinary text\n");
    await expect(captureImprovementCandidate(workspace, base, ["docs/link.md"])).rejects.toThrow(/symbolic|symlink/i);
  });

  it("captures paths with spaces and UTF-8 characters exactly", async () => {
    await file("docs/审查 notes.md", "review\n");
    const captured = await captureImprovementCandidate(workspace, base, ["docs/审查 notes.md"]);
    expect(captured.changed_paths).toEqual(["docs/审查 notes.md"]);
    expect(captured.patch).toContain("审查 notes.md");
  });

  it.each(["/tmp/file", "../file", "docs/../file", "docs//a.md", "docs/", "C:\\file", "docs\\file", "docs/./a.md", "docs/*", "docs/\u0000a.md", ".github/workflows/test.yml", ".osstack/policy.yaml", "AGENTS.md", "docs/CLAUDE.md", ".git/config", ".codex/config.toml", "package.json", "pnpm-lock.yaml", ".env.local"])("rejects unsafe or protected path %s", (path) => {
    expect(() => validateImprovementPaths([path])).toThrow();
  });

  it("does not treat a directory name as a prefix authorization", async () => {
    await file("docs/a.md", "candidate\n");
    await expect(captureImprovementCandidate(workspace, base, ["docs"])).rejects.toThrow(/allowed/i);
  });

  it("never invokes a repository clean filter while capturing raw file bytes", async () => {
    await file(".gitattributes", "docs/*.md filter=hostile\n");
    await git(["add", ".gitattributes"]);
    await git(["commit", "-m", "attributes base"]);
    base = (await git(["rev-parse", "HEAD"])).trim();
    const marker = join(root, "filter-was-run");
    await git(["config", "filter.hostile.clean", `touch '${marker}'; cat`]);
    await file("docs/a.md", "candidate\n");
    const captured = await captureImprovementCandidate(workspace, base, ["docs/a.md"]);
    expect(captured.patch).toContain("candidate");
    await expect(readFile(marker)).rejects.toThrow();
  });
});

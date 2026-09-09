// Real pnpm and Git; workspace-only dependency means no registry fixture or mocked installer.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { prepareImprovementEnvironment, previewImprovementEnvironment } from "./improvement-environment.js";
import { seedPnpmEnvironment } from "./improvement-environment-fixture.js";

import { afterEach, describe, expect, it } from "vitest";
import { validateDependencyInputs } from "./improvement-environment.js";

function inputs() {
  return new Map(Object.entries({
    "package.json": JSON.stringify({ name: "fixture", packageManager: "pnpm@11.4.0", dependencies: { test: "workspace:*" } }),
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
  }).map(([path, value]) => [path, Buffer.from(value)]));
}
describe("bounded pnpm environment inputs", () => {
  it("binds all committed inputs and requires a precise supported version", () => {
    const files = inputs();
    expect(validateDependencyInputs(files)).toMatchObject({ version: "11.4.0", inputs: { "pnpm-lock.yaml": expect.stringMatching(/^[a-f0-9]{64}$/) } });
    files.set("package.json", Buffer.from('{"packageManager":"pnpm@^11.4.0"}'));
    expect(() => validateDependencyInputs(files)).toThrow("exact pnpm");
  });
  it.each(["storeDir: /outside", "pnpmfile: /outside.cjs", "packageConfigs: {}", "registries: {}", "packages: [../outside]"])("rejects unbounded workspace configuration: %s", (configuration) => {
    const files = inputs(); files.set("pnpm-workspace.yaml", Buffer.from(configuration));
    expect(() => validateDependencyInputs(files)).toThrow();
  });
  it.each(["file:../outside", "link:../outside", "https://example.invalid/pkg.tgz", "git+ssh://host/repo", "../outside"])("rejects external dependency %s", (spec) => {
    const files = inputs(); files.set("package.json", Buffer.from(JSON.stringify({ packageManager: "pnpm@11.4.0", dependencies: { a: spec } })));
    expect(() => validateDependencyInputs(files)).toThrow("External");
  });
  it("rejects local resolution and credential files before invoking pnpm", () => {
    const files = inputs(); files.set("pnpm-lock.yaml", Buffer.from("lockfileVersion: '9.0'\npackages:\n  a:\n    resolution: {directory: ../outside}\n"));
    expect(() => validateDependencyInputs(files)).toThrow();
    files.set(".npmrc", Buffer.from("//registry.npmjs.org/:_authToken=not-a-real-token"));
    expect(() => validateDependencyInputs(files)).toThrow("npmrc");
  });
});

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function environmentFixture() {
  const root = await mkdtemp(join(tmpdir(), "osstack-env-test-")); roots.push(root);
  const repo = join(root, "repo");
  await seedPnpmEnvironment(repo);
  const git = async (args: string[]) => (await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo })).stdout.trim();
  await git(["init", "-b", "main"]); await git(["add", "."]); await git(["commit", "-m", "fixture"]);
  const commit = await git(["rev-parse", "HEAD"]);
  return { root, repo, commit, git };
}

it("installs real workspace dependencies twice with isolated receipts and no lifecycle hooks", async () => {
  const f = await environmentFixture();
  const contract = await previewImprovementEnvironment(f.repo, f.commit);
  const first = join(f.root, "builder-environment");
  await prepareImprovementEnvironment({ contract, workspace: f.repo, commit: f.commit, directory: first, timeoutMs: 15_000, checkActive() {} });
  expect((await exec("node", ["-e", "console.log(require('test-local'))"], { cwd: f.repo })).stdout.trim()).toBe("available");
  await expect(readFile(join(f.repo, "script-ran"))).rejects.toThrow();
  await expect(readFile(join(f.repo, "packages/local/dependency-script-ran"))).rejects.toThrow();
  expect(JSON.parse(await readFile(join(first, "completed.json"), "utf8"))).toMatchObject({ environment: contract });
  const clean = join(f.root, "clean");
  await exec("git", ["clone", "--quiet", f.repo, clean]);
  await prepareImprovementEnvironment({ contract, workspace: clean, commit: f.commit, directory: join(f.root, "replay-environment"), timeoutMs: 15_000, checkActive() {} });
  expect((await exec("node", ["-e", "console.log(require('test-local'))"], { cwd: clean })).stdout.trim()).toBe("available");
  expect(await f.git(["status", "--porcelain"])).toBe("");
  await expect(prepareImprovementEnvironment({ contract, workspace: f.repo, commit: f.commit, directory: join(f.root, "reused-workspace"), timeoutMs: 5000, checkActive() {} })).rejects.toThrow("fresh checkout");
  await expect(prepareImprovementEnvironment({ contract, workspace: f.repo, commit: f.commit, directory: first, timeoutMs: 15_000, checkActive() {} })).rejects.toThrow();
}, 30_000);

it("records toolchain drift without invoking install and rejects uncommitted input changes", async () => {
  const f = await environmentFixture();
  const contract = await previewImprovementEnvironment(f.repo, f.commit);
  const directory = join(f.root, "drift");
  await expect(prepareImprovementEnvironment({ contract: { ...contract, node_version: "v0.0.0" }, workspace: f.repo, commit: f.commit, directory, timeoutMs: 5000, checkActive() {} })).rejects.toThrow("toolchain changed");
  expect(JSON.parse(await readFile(join(directory, "failed.json"), "utf8"))).toMatchObject({ retry_allowed: false });
  await writeFile(join(f.repo, "package.json"), "{}");
  await expect(prepareImprovementEnvironment({ contract, workspace: f.repo, commit: f.commit, directory: join(f.root, "dirty"), timeoutMs: 5000, checkActive() {} })).rejects.toThrow("Protected improvement path");
}, 20_000);


it("rejects missing/extraneous importers and links outside the locked workspace", () => {
  const files = inputs(); files.set("packages/local/package.json", Buffer.from('{"name":"local"}'));
  expect(() => validateDependencyInputs(files)).toThrow("importers differ");
  files.set("pnpm-lock.yaml", Buffer.from("lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      local:\n        version: link:../outside\n  packages/local: {}\n"));
  expect(() => validateDependencyInputs(files)).toThrow("Lockfile link");
});

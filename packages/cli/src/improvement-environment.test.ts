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

it("binds only exact locked registry builds and rejects broader or stale policy", async () => {
  const { resolveDependencyBuilds } = await import("./improvement-environment.js");
  const files = inputs();
  files.set("pnpm-workspace.yaml", Buffer.from("packages: []\nallowBuilds: {native: true}"));
  files.set("pnpm-lock.yaml", Buffer.from("lockfileVersion: '9.0'\nimporters: {.: {}}\npackages:\n  native@1.2.3:\n    resolution: {integrity: sha512-YWJj}\n"));
  expect(resolveDependencyBuilds(files, ["native@1.2.3"])).toEqual({ packages: [{ selector: "native@1.2.3", integrity: "sha512-YWJj" }], network: "unrestricted", isolation: "os-user" });
  for (const selectors of [[], ["native"], ["native@^1.2.3"], ["native@1.2.4"], ["native@1.2.3", "native@1.2.3"], ["--pending"], ["other@1.2.3"]]) {
    expect(() => resolveDependencyBuilds(files, selectors)).toThrow();
  }
  files.set("other/package.json", Buffer.from('{"name":"native"}'));
  expect(() => resolveDependencyBuilds(files, ["native@1.2.3"])).toThrow("Workspace");
  files.delete("other/package.json");
  files.set("pnpm-workspace.yaml", Buffer.from("allowBuilds: {'*': true, native: true}"));
  expect(() => resolveDependencyBuilds(files, ["native@1.2.3"])).toThrow("simple package-name");
});

// Populate a synthetic registry layout after a real script-free workspace install.
// No network is needed; pnpm's actual rebuild implementation executes the fixture scripts.
it("forces pnpm builtin and builds only the selected version, without root/workspace lifecycle scripts", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { parse, stringify } = await import("yaml");
  const { rebuildImprovementDependencies } = await import("./improvement-environment.js");
  const f = await environmentFixture();
  const contract = await previewImprovementEnvironment(f.repo, f.commit);
  const stage = join(f.root, "env");
  await prepareImprovementEnvironment({ contract, workspace: f.repo, commit: f.commit, directory: stage, timeoutMs: 15_000, checkActive() {} });
  const manifest = JSON.parse(await readFile(join(f.repo, "package.json"), "utf8"));
  manifest.scripts.rebuild = "node -e \"require('fs').writeFileSync('shadow-ran','bad')\"";
  manifest.scripts.pm = manifest.scripts.rebuild;
  manifest.scripts.prepare = manifest.scripts.rebuild;
  await writeFile(join(f.repo, "package.json"), JSON.stringify(manifest));
  await writeFile(join(f.repo, "pnpm-workspace.yaml"), "packages: [packages/*]\nallowBuilds: {selected: true, unselected: true}\n");
  const lockPath = join(f.repo, "node_modules/.pnpm/lock.yaml");
  const lock = parse(await readFile(lockPath, "utf8"));
  lock.packages = {}; lock.snapshots = {};
  for (const [name, version, alias] of [["selected", "1.0.0", "selected"], ["selected", "2.0.0", "other-version"], ["unselected", "1.0.0", "unselected"]] as const) {
    const key = `${name}@${version}`;
    lock.packages[key] = { resolution: { integrity: "sha512-YWJj" } };
    lock.snapshots[key] = {};
    lock.importers["."].dependencies[alias] = { specifier: version, version: alias === name ? version : key };
    const dir = join(f.repo, "node_modules/.pnpm", key, "node_modules", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name, version, scripts: Object.fromEntries(["preinstall", "install", "postinstall"].map((stage) => [stage, `node -e "require('fs').appendFileSync('built','${stage},')"`])) }));
  }
  await writeFile(lockPath, stringify(lock));
  await rebuildImprovementDependencies(["selected@1.0.0"], f.repo, join(stage, "home"), join(stage, "store"), 15_000);
  expect(await readFile(join(f.repo, "node_modules/.pnpm/selected@1.0.0/node_modules/selected/built"), "utf8")).toBe("preinstall,install,postinstall,");
  for (const path of ["shadow-ran", "script-ran", "packages/local/dependency-script-ran", "node_modules/.pnpm/selected@2.0.0/node_modules/selected/built", "node_modules/.pnpm/unselected@1.0.0/node_modules/unselected/built"]) {
    await expect(readFile(join(f.repo, path))).rejects.toThrow();
  }
  await expect(rebuildImprovementDependencies(["selected@9.0.0"], f.repo, join(stage, "home"), join(stage, "store"), 1000)).rejects.toThrow("no installed instance");
  await expect(rebuildImprovementDependencies([], f.repo, join(stage, "home"), join(stage, "store"), 1000)).rejects.toThrow();
}, 30_000);

it("rejects a tampered build receipt before install and leaves the failed stage occupied", async () => {
  const { parse, stringify } = await import("yaml");
  const f = await environmentFixture();
  await writeFile(join(f.repo, "pnpm-workspace.yaml"), "packages: [packages/*]\nallowBuilds: {native: true}\n");
  const lock = parse(await readFile(join(f.repo, "pnpm-lock.yaml"), "utf8"));
  lock.packages = { "native@1.2.3": { resolution: { integrity: "sha512-YWJj" } } };
  await writeFile(join(f.repo, "pnpm-lock.yaml"), stringify(lock));
  await f.git(["add", "."]); await f.git(["commit", "-m", "build-policy"]);
  const commit = await f.git(["rev-parse", "HEAD"]);
  const contract = await previewImprovementEnvironment(f.repo, commit, ["native@1.2.3"]);
  expect(contract.kind).toBe("pnpm-frozen-builds-v1");
  expect(contract.lifecycle_scripts).toBe("selected-dependencies");
  contract.dependency_builds!.packages[0]!.integrity = "sha512-dGFtcGVy";
  const directory = join(f.root, "tampered");
  const request = { contract, workspace: f.repo, commit, directory, timeoutMs: 1000, checkActive() {} };
  await expect(prepareImprovementEnvironment(request)).rejects.toThrow("build policy changed");
  expect(JSON.parse(await readFile(join(directory, "failed.json"), "utf8"))).toMatchObject({ phase: "input_validation", retry_allowed: false });
  await expect(readFile(join(f.repo, "node_modules/.modules.yaml"))).rejects.toThrow();
  await expect(prepareImprovementEnvironment(request)).rejects.toThrow();
}, 15_000);

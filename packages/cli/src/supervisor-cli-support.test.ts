import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRegistryPath } from "./supervisor-cli-support.js";

describe("resolveRegistryPath", () => {
  let cwdDir: string;
  let homeDir: string;
  let originalCwd: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    // realpath: on macOS tmpdir() is /var/... which symlinks to /private/var/...,
    // and process.cwd() reports the resolved path after chdir.
    cwdDir = realpathSync(mkdtempSync(join(tmpdir(), "osstack-registry-cwd-")));
    homeDir = realpathSync(mkdtempSync(join(tmpdir(), "osstack-registry-home-")));
    originalCwd = process.cwd();
    originalHome = process.env["OSSTACK_HOME"];
    process.chdir(cwdDir);
    process.env["OSSTACK_HOME"] = homeDir;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env["OSSTACK_HOME"];
    else process.env["OSSTACK_HOME"] = originalHome;
    rmSync(cwdDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  const writeRegistry = (dir: string): string => {
    const path = join(dir, "repos.json");
    writeFileSync(path, "[]\n");
    return path;
  };

  it("explicit --registry wins over everything", () => {
    mkdirSync(join(cwdDir, ".osstack"), { recursive: true });
    writeRegistry(join(cwdDir, ".osstack"));
    writeRegistry(homeDir);
    expect(resolveRegistryPath(["--registry", "/abs/repos.json"])).toBe("/abs/repos.json");
  });

  it("relative --registry resolves against cwd", () => {
    expect(resolveRegistryPath(["--registry", "rel/repos.json"])).toBe(
      join(cwdDir, "rel", "repos.json"),
    );
  });

  it("explicit --workspace pins the workspace registry with no machine fallback", () => {
    writeRegistry(homeDir);
    const workspace = join(cwdDir, "ws");
    expect(resolveRegistryPath(["--workspace", workspace])).toBe(
      join(workspace, ".osstack", "repos.json"),
    );
  });

  it("prefers the cwd registry when it exists", () => {
    mkdirSync(join(cwdDir, ".osstack"), { recursive: true });
    const local = writeRegistry(join(cwdDir, ".osstack"));
    writeRegistry(homeDir);
    expect(resolveRegistryPath([])).toBe(local);
  });

  it("falls back to $OSSTACK_HOME/repos.json when the cwd registry is absent", () => {
    const machine = writeRegistry(homeDir);
    expect(resolveRegistryPath([])).toBe(machine);
  });

  it("keeps the legacy cwd default when neither registry exists", () => {
    expect(resolveRegistryPath([])).toBe(join(cwdDir, ".osstack", "repos.json"));
  });
});

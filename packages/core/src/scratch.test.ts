import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCRATCH_KINDS,
  SCRATCH_ROOT_ENV,
  createScratchDir,
  createScratchDirSync,
  scratchPath,
  scratchRoot,
} from "./scratch.js";

const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !rel.includes(`..${sep}`);
}

describe("scratchRoot", () => {
  it("defaults to <os.tmpdir()>/osstack when no override is set", () => {
    expect(scratchRoot({})).toBe(join(tmpdir(), "osstack"));
  });

  it("honours an absolute OSSTACK_SCRATCH_ROOT override", () => {
    const override = join(tmpdir(), "custom-scratch-root");
    expect(scratchRoot({ [SCRATCH_ROOT_ENV]: override })).toBe(override);
  });

  it("resolves a relative override against the current working directory", () => {
    expect(scratchRoot({ [SCRATCH_ROOT_ENV]: "rel/scratch" })).toBe(resolve("rel/scratch"));
  });

  it("ignores a blank override", () => {
    expect(scratchRoot({ [SCRATCH_ROOT_ENV]: "   " })).toBe(join(tmpdir(), "osstack"));
  });
});

describe("scratchPath", () => {
  it("places every kind directly under the scratch root", () => {
    const env = { [SCRATCH_ROOT_ENV]: join(tmpdir(), "root-x") };
    for (const kind of SCRATCH_KINDS) {
      expect(scratchPath(kind, env)).toBe(join(tmpdir(), "root-x", kind));
    }
  });
});

describe("createScratchDir", () => {
  it("creates a unique directory under <root>/<kind>/<label>-XXXXXX", async () => {
    const root = mkdtempSync(join(tmpdir(), "scratch-test-"));
    created.push(root);
    const env = { [SCRATCH_ROOT_ENV]: root };

    const first = await createScratchDir("runtime", "feedback", env);
    const second = await createScratchDir("runtime", "feedback", env);

    expect(first).not.toBe(second);
    expect(dirname(first)).toBe(join(root, "runtime"));
    expect(basename(first)).toMatch(/^feedback-[A-Za-z0-9]{6}$/);
    expect(isInside(first, root)).toBe(true);
    expect(statSync(first).isDirectory()).toBe(true);
  });

  it("creates the missing parent chain on first use", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "scratch-test-")), "nested", "root");
    created.push(dirname(dirname(root)));
    expect(existsSync(root)).toBe(false);

    const dir = await createScratchDir("smoke", "demo", { [SCRATCH_ROOT_ENV]: root });

    expect(existsSync(dir)).toBe(true);
    expect(dirname(dir)).toBe(join(root, "smoke"));
  });

  it("sanitises labels so they cannot escape the kind directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "scratch-test-"));
    created.push(root);
    const env = { [SCRATCH_ROOT_ENV]: root };

    const dir = await createScratchDir("tests", "../../evil/label name", env);

    expect(dirname(dir)).toBe(join(root, "tests"));
    expect(basename(dir)).toMatch(/^evil-label-name-[A-Za-z0-9]{6}$/);
  });

  it("falls back to a neutral label when the label sanitises to nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "scratch-test-"));
    created.push(root);

    const dir = await createScratchDir("tests", "///", { [SCRATCH_ROOT_ENV]: root });

    expect(basename(dir)).toMatch(/^scratch-[A-Za-z0-9]{6}$/);
  });
});

describe("createScratchDirSync", () => {
  it("mirrors the async variant", () => {
    const root = mkdtempSync(join(tmpdir(), "scratch-test-"));
    created.push(root);

    const dir = createScratchDirSync("worktrees", "run 1", { [SCRATCH_ROOT_ENV]: root });

    expect(dirname(dir)).toBe(join(root, "worktrees"));
    expect(basename(dir)).toMatch(/^run-1-[A-Za-z0-9]{6}$/);
    expect(statSync(dir).isDirectory()).toBe(true);
  });
});

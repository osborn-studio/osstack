import { fsyncSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { armLoopContainment, hasLoopContainment, releaseLoopContainment } from "./loop-containment.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), writeFileSync: vi.fn(actual.writeFileSync) };
});
afterEach(() => { vi.mocked(fsyncSync).mockClear(); vi.mocked(writeFileSync).mockClear(); });

it.each(["write", "sync", "directory_sync"])("fails admission and keeps a fail-closed record on %s failure", (stage) => {
  const path = join(mkdtempSync(join(tmpdir(), "containment-")), "state.stop-unconfirmed.json");
  const fail = () => { throw new Error("disk failure"); };
  if (stage === "write") vi.mocked(writeFileSync).mockImplementationOnce(fail);
  else if (stage === "sync") vi.mocked(fsyncSync).mockImplementationOnce(fail);
  else vi.mocked(fsyncSync).mockImplementationOnce(() => {}).mockImplementationOnce(fail);
  expect(() => armLoopContainment(path)).toThrow("disk failure");
  expect(hasLoopContainment(path)).toBe(true);
  expect(() => armLoopContainment(path)).toThrow();
});

it("fsyncs containment and directory before admission, releasing only explicitly", () => {
  const path = join(mkdtempSync(join(tmpdir(), "containment-")), "nested/state.stop-unconfirmed.json");
  armLoopContainment(path);
  expect(fsyncSync).toHaveBeenCalled();
  expect(hasLoopContainment(path)).toBe(true);
  releaseLoopContainment(path);
  expect(hasLoopContainment(path)).toBe(false);
});

it("binds containment to canonical workspace identity without Git environment dependence", async () => {
  const { symlinkSync } = await import("node:fs");
  const { loopContainmentPath } = await import("./loop-containment.js");
  const workspace = mkdtempSync(join(tmpdir(), "containment-repo-"));
  const alias = workspace + "-alias";
  symlinkSync(workspace, alias, "dir");
  const expected = loopContainmentPath(workspace);
  vi.stubEnv("GIT_DIR", "/not-a-real-git-dir");
  vi.stubEnv("GIT_WORK_TREE", "/not-a-real-worktree");
  try { expect(loopContainmentPath(alias)).toBe(expected); }
  finally { vi.unstubAllEnvs(); }
});

it("rejects a host containment root inside the candidate, including symlink aliases", async () => {
  const { symlinkSync } = await import("node:fs");
  const { loopContainmentPath } = await import("./loop-containment.js");
  const workspace = mkdtempSync(join(tmpdir(), "containment-repo-"));
  const alias = workspace + "-alias";
  symlinkSync(workspace, alias, "dir");
  vi.stubEnv("OSSTACK_LOOP_CONTAINMENT_ROOT", join(alias, "host-state"));
  try { expect(() => loopContainmentPath(workspace)).toThrow("outside the candidate"); }
  finally { vi.unstubAllEnvs(); }
});

it("uses one identity for filesystem case aliases when the volume supports them", async ({ skip }) => {
  const { statSync } = await import("node:fs");
  const { loopContainmentPath } = await import("./loop-containment.js");
  const workspace = mkdtempSync(join(tmpdir(), "CaseContainment-"));
  const alias = workspace.toLowerCase();
  let aliasStat: ReturnType<typeof statSync>;
  try { aliasStat = statSync(alias); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { skip(); return; } throw error; }
  const original = statSync(workspace);
  if (original.dev !== aliasStat.dev || original.ino !== aliasStat.ino) { skip(); return; }
  const expected = loopContainmentPath(workspace);
  expect(loopContainmentPath(alias)).toBe(expected);
  armLoopContainment(expected);
  const hostRoot = process.env["OSSTACK_LOOP_CONTAINMENT_ROOT"]!;
  vi.stubEnv("OSSTACK_LOOP_CONTAINMENT_ROOT", hostRoot.toUpperCase());
  try { expect(loopContainmentPath(alias)).toBe(expected); expect(hasLoopContainment(loopContainmentPath(alias))).toBe(true); }
  finally { vi.unstubAllEnvs(); releaseLoopContainment(expected); }
});

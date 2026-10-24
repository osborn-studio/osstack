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

it.each(["write", "sync"])("fails admission and keeps a fail-closed record on %s failure", (stage) => {
  const path = join(mkdtempSync(join(tmpdir(), "containment-")), "state.stop-unconfirmed.json");
  const fail = () => { throw new Error("disk failure"); };
  if (stage === "write") vi.mocked(writeFileSync).mockImplementationOnce(fail);
  else vi.mocked(fsyncSync).mockImplementationOnce(fail);
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

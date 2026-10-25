// Keep legacy tmpdir fixtures and explicit scratch helpers below one managed root.
// The short symlink is necessary for macOS AF_UNIX's ~104-byte path budget.
import { randomUUID } from "node:crypto";
import { realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "vitest";
import { createScratchDirSync, scratchRoot } from "../packages/core/src/scratch.js";
const original = process.env["TMPDIR"];
const originalContainmentRoot = process.env["OSSTACK_LOOP_CONTAINMENT_ROOT"];
process.env["OSSTACK_SCRATCH_ROOT"] = scratchRoot();
const directory = realpathSync(createScratchDirSync("tests", `worker-${process.pid}`));
const alias = join("/tmp", `osstack-w-${randomUUID().slice(0, 8)}`);
symlinkSync(directory, alias, "dir");
process.env["TMPDIR"] = alias;
const containmentRoot = join(directory, "loop-containment");
process.env["OSSTACK_LOOP_CONTAINMENT_ROOT"] = containmentRoot;
let cleaned = false;
const cleanup = () => {
  if (cleaned) return; cleaned = true;
  if (process.env["TMPDIR"] === alias) {
    if (original === undefined) delete process.env["TMPDIR"]; else process.env["TMPDIR"] = original;
  }
  if (process.env["OSSTACK_LOOP_CONTAINMENT_ROOT"] === containmentRoot) {
    if (originalContainmentRoot === undefined) delete process.env["OSSTACK_LOOP_CONTAINMENT_ROOT"];
    else process.env["OSSTACK_LOOP_CONTAINMENT_ROOT"] = originalContainmentRoot;
  }
  rmSync(alias, { force: true }); rmSync(directory, { recursive: true, force: true });
};
process.once("exit", cleanup);
afterAll(() => { cleanup(); process.removeListener("exit", cleanup); });

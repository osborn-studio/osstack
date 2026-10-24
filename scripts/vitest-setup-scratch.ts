// Keep legacy tmpdir fixtures and explicit scratch helpers below one managed root.
// The short symlink is necessary for macOS AF_UNIX's ~104-byte path budget.
import { randomUUID } from "node:crypto";
import { realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "vitest";
import { createScratchDirSync, scratchRoot } from "../packages/core/src/scratch.js";
const original = process.env["TMPDIR"];
process.env["OSSTACK_SCRATCH_ROOT"] = scratchRoot();
const directory = realpathSync(createScratchDirSync("tests", `worker-${process.pid}`));
const alias = join("/tmp", `osstack-w-${randomUUID().slice(0, 8)}`);
symlinkSync(directory, alias, "dir");
process.env["TMPDIR"] = alias;
let cleaned = false;
const cleanup = () => {
  if (cleaned) return; cleaned = true;
  if (process.env["TMPDIR"] === alias) {
    if (original === undefined) delete process.env["TMPDIR"]; else process.env["TMPDIR"] = original;
  }
  rmSync(alias, { force: true }); rmSync(directory, { recursive: true, force: true });
};
process.once("exit", cleanup);
afterAll(() => { cleanup(); process.removeListener("exit", cleanup); });

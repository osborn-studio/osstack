import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, realpathSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

function canonicalProspectivePath(path: string): string {
  try { return realpathSync.native(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonicalProspectivePath(parent), relative(parent, path));
  }
}

export function loopContainmentPath(workspacePath: string): string {
  const workspace = realpathSync.native(workspacePath);
  const configured = process.env["OSSTACK_LOOP_CONTAINMENT_ROOT"]
    ?? join(process.env["OSSTACK_HOME"] ?? join(homedir(), ".osstack"), "loop-containment");
  if (!isAbsolute(configured)) throw new Error("Loop containment root must be absolute");
  const root = canonicalProspectivePath(resolve(configured));
  assertContainmentRootOutsideWorkspace(root, workspace);
  const key = createHash("sha256").update(workspace).digest("hex");
  return join(root, key + ".json");
}

export function assertContainmentRootOutsideWorkspace(rootPath: string, workspacePath: string): void {
  const workspace = realpathSync.native(workspacePath);
  const root = canonicalProspectivePath(rootPath);
  const within = relative(workspace, root);
  if (within === "" || (!isAbsolute(within) && within !== ".." && !within.startsWith(".." + sep))) {
    throw new Error("Loop containment root must be outside the candidate workspace");
  }
}

// Any entry, even interrupted or empty, requires execution reconciliation.
export function hasLoopContainment(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function armLoopContainment(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, '{"schema_version":1,"state":"containment_pending"}\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  // Include newly-created parent directories before admitting external effects.
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    syncDirectory(directory);
    if (dirname(directory) === directory) break;
  }
}

export function releaseLoopContainment(path: string): void {
  unlinkSync(path);
  syncDirectory(dirname(path));
}

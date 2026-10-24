import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

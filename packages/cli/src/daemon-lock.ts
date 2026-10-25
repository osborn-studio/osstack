// The application DB is never used as a process mutex: opening it migrates it.
// This private, fixed-inode SQLite file holds a native exclusive lock until close.
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
  openSync,
  closeSync,
  constants,
} from "node:fs";
import { dirname, join, basename } from "node:path";

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly pid: number, pidFile: string) {
    super(
      `osstack daemon ownership is held (pid ${
        pid || "unknown"
      }, pidfile ${pidFile}). Stop the owner before restarting; do not delete the lock file.`
    );
    this.name = "DaemonAlreadyRunningError";
  }
}
const held = new Set<string>();
export function supportsLockFilesystem(platform: NodeJS.Platform, type: number, directory: string): boolean {
  if (platform === "linux") {
    return new Set([0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630]).has(type >>> 0);
  }
  if (platform !== "darwin") return false;
  // Darwin assigns f_type numbers in filesystem registration order. Ask the
  // system to filter this exact path by filesystem NAME, not a guessed number.
  // df returns no row for an excluded type. Never fall back on probe failure.
  try {
    const output = execFileSync("/bin/df", ["-k", "-P", "-T", "apfs,hfs", directory], {
      encoding: "utf8", timeout: 2000, maxBuffer: 65536,
      env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = output.trim().split(/\r?\n/);
    return lines.length === 2
      && /^Filesystem\s+1024-blocks\s+Used\s+Available\s+Capacity\s+Mounted on$/.test(lines[0]!)
      && /^\S+\s+\d+\s+\d+\s+-?\d+\s+\d+%\s+\/.*$/.test(lines[1]!);
  } catch { return false; }
}
function diagnosticPid(path: string): number {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}
/** No application schema or migration. Kernel locks are released on process exit.
 * Supported local FS only; SQLite's POSIX VFS does not inherit locks across fork.
 * Never unlink/replace the lock DB: doing so would create two independent inodes.
 */
export function acquireDaemonLock(pidFile: string): () => void {
  mkdirSync(dirname(pidFile), { recursive: true, mode: 0o700 });
  const path = join(
    realpathSync(dirname(pidFile)),
    `${basename(pidFile)}.lock.db`
  );
  const filesystemType = Number(statfsSync(dirname(path)).type);
  if (!supportsLockFilesystem(process.platform, filesystemType, dirname(path))) {
    throw new Error(
      `daemon_lock_unsupported_filesystem:${filesystemType.toString(16)}:${dirname(path)}`
    );
  }
  if (held.has(path)) throw new DaemonAlreadyRunningError(process.pid, pidFile);
  for (const candidate of [path, pidFile]) {
    try {
      const st = lstatSync(candidate);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1)
        throw new Error("daemon_lock_requires_regular_file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const db = new Database(path, { timeout: 0 });
  try {
    if (db.pragma("journal_mode = DELETE", { simple: true }) !== "delete")
      throw new Error("daemon_lock_wrong_journal_mode");
    db.exec("BEGIN EXCLUSIVE");
    held.add(path);
    const fd = openSync(
      pidFile,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_NOFOLLOW,
      0o600
    );
    try {
      writeFileSync(fd, `${process.pid}\n`);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    held.delete(path);
    db.close();
    if (
      error instanceof Database.SqliteError &&
      ["SQLITE_BUSY", "SQLITE_LOCKED"].some((code) =>
        error.code.startsWith(code)
      )
    ) {
      throw new DaemonAlreadyRunningError(diagnosticPid(pidFile), pidFile);
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (diagnosticPid(pidFile) === process.pid) unlinkSync(pidFile);
    } catch {
      /* diagnostics only */
    }
    // Closing rolls back the empty transaction and releases the OS lock.
    try {
      db.close();
    } finally {
      held.delete(path);
    }
  };
}

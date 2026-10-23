// The application DB is never used as a process mutex: opening it migrates it.
// This private, fixed-inode SQLite file holds a native exclusive lock until close.
import Database from "better-sqlite3";
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
  const localTypes = new Set([
    0x1a, 0x11, 0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630,
  ]);
  if (
    !["darwin", "linux"].includes(process.platform) ||
    !localTypes.has(Number(statfsSync(dirname(path)).type) >>> 0)
  ) {
    throw new Error(
      `daemon_lock_unsupported_filesystem:${statfsSync(
        dirname(path)
      ).type.toString(16)}:${dirname(path)}`
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

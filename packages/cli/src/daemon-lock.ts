// Duplicate-daemon guard via pidfile. Two daemons sharing one SQLite file and
// racing to bind the same socket is the kind of corruption you only debug
// once — refuse to start instead.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class DaemonAlreadyRunningError extends Error {
  readonly pid: number;
  constructor(pid: number, pidFile: string) {
    super(`osstack daemon already running (pid ${pid}, pidfile ${pidFile}). Stop it first or remove the stale pidfile.`);
    this.name = "DaemonAlreadyRunningError";
    this.pid = pid;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but owned by someone else — still "alive" for our purposes.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Acquire the daemon lock. Throws DaemonAlreadyRunningError when another
 * live process holds it; silently replaces a stale pidfile (dead pid).
 * Returns a release function for shutdown.
 */
export function acquireDaemonLock(pidFile: string): () => void {
  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    // Own pid counts as "running" too: a second startDaemon() in the same
    // process (without releasing the first lock) must also be refused.
    if (Number.isFinite(pid) && pid > 0 && processAlive(pid)) {
      throw new DaemonAlreadyRunningError(pid, pidFile);
    }
  }
  if (!existsSync(dirname(pidFile))) mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, `${process.pid}\n`);
  return () => {
    try {
      // Only remove the pidfile if it is still ours.
      const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      if (pid === process.pid) unlinkSync(pidFile);
    } catch { /* already gone */ }
  };
}

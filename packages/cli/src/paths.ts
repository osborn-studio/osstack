// Canonical filesystem locations for osstack. Single source of truth so the
// daemon, CLI and upgrade tooling never disagree about where things live.
//
// Layout under $OSSTACK_HOME (default ~/.osstack):
//   state.db            SQLite state (tasks/runs/events/kanban/…)
//   daemon.sock         Unix socket (override: $OSSTACK_SOCKET)
//   daemon.pid          pidfile guarding against duplicate daemons
//   update-check.json   cached registry version probe
//   backups/            state.db snapshots taken before upgrades
//   logs/               daemon + upgrade logs

import { join } from "node:path";

export function osstackHome(): string {
  return process.env["OSSTACK_HOME"] ?? join(process.env["HOME"] ?? "", ".osstack");
}

/**
 * Daemon socket path. Lives under OSSTACK_HOME (not /tmp, which macOS purges
 * periodically). $OSSTACK_SOCKET overrides for tests and exotic setups.
 */
export function resolveSocketPath(): string {
  return process.env["OSSTACK_SOCKET"] ?? join(osstackHome(), "daemon.sock");
}

export function pidFilePath(): string {
  return join(osstackHome(), "daemon.pid");
}

export function updateCheckCachePath(): string {
  return join(osstackHome(), "update-check.json");
}

export function backupsDir(): string {
  return join(osstackHome(), "backups");
}

export function logsDir(): string {
  return join(osstackHome(), "logs");
}

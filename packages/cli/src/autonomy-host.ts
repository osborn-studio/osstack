import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  truncate,
} from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";

const STANDARD_RETENTION_STATES = new Set(["cancelled", "completed"]);
const EXTENDED_RETENTION_STATES = new Set([
  "blocked",
  "delivery_evidence_failed",
  "escalated",
]);

export interface ClockObservation {
  jump_detected: boolean;
  drift_ms: number;
  wall_elapsed_ms: number;
  monotonic_elapsed_ms: number;
}

export class ClockJumpDetector {
  private previousWallMs: number | undefined;
  private previousMonotonicMs: number | undefined;

  constructor(private readonly thresholdMs = 120_000) {
    if (!Number.isFinite(thresholdMs) || thresholdMs < 1) {
      throw new Error("clock jump threshold must be positive");
    }
  }

  observe(wallMs: number, monotonicMs: number): ClockObservation {
    if (!Number.isFinite(wallMs) || !Number.isFinite(monotonicMs)) {
      throw new Error("clock observations must be finite");
    }
    const previousWall = this.previousWallMs;
    const previousMonotonic = this.previousMonotonicMs;
    this.previousWallMs = wallMs;
    this.previousMonotonicMs = monotonicMs;
    if (previousWall === undefined || previousMonotonic === undefined) {
      return {
        jump_detected: false,
        drift_ms: 0,
        wall_elapsed_ms: 0,
        monotonic_elapsed_ms: 0,
      };
    }
    const wallElapsed = wallMs - previousWall;
    const monotonicElapsed = monotonicMs - previousMonotonic;
    const drift = wallElapsed - monotonicElapsed;
    return {
      jump_detected: Math.abs(drift) >= this.thresholdMs,
      drift_ms: drift,
      wall_elapsed_ms: wallElapsed,
      monotonic_elapsed_ms: monotonicElapsed,
    };
  }
}

export interface AutonomyRetentionOptions {
  home: string;
  db: Database.Database;
  now?: () => number;
  max_log_bytes?: number;
  max_log_files?: number;
  proof_retention_days?: number;
  proof_min_keep?: number;
}

export interface AutonomyRetentionReport {
  checked_at: number;
  max_log_bytes: number;
  max_log_files: number;
  proof_retention_days: number;
  proof_min_keep: number;
  largest_log_bytes: number;
  oversized_log_count: number;
  expired_terminal_proof_count: number;
  rotated_logs: string[];
  removed_proof_dirs: string[];
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return resolved;
}

function retentionConfig(options: AutonomyRetentionOptions) {
  return {
    now: options.now?.() ?? Date.now() / 1_000,
    maxLogBytes: positiveInteger(
      options.max_log_bytes,
      25 * 1024 ** 2,
      "maximum log bytes",
    ),
    maxLogFiles: positiveInteger(
      options.max_log_files,
      5,
      "maximum rotated log files",
    ),
    proofRetentionDays: positiveInteger(
      options.proof_retention_days,
      30,
      "proof retention days",
    ),
    proofMinKeep: positiveInteger(
      options.proof_min_keep,
      100,
      "minimum proofs to keep",
    ),
  };
}

async function regularFiles(directory: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".log")) continue;
    const path = join(directory, name);
    const metadata = await lstat(path);
    if (metadata.isFile() && !metadata.isSymbolicLink()) files.push(path);
  }
  return files;
}

async function proofDirectories(directory: string): Promise<Array<{
  name: string;
  path: string;
  modified_at: number;
}>> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const directories = [];
  for (const name of names.sort()) {
    if (!/^run_[A-Za-z0-9_-]+$/.test(name)) continue;
    const path = join(directory, name);
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
    directories.push({
      name,
      path,
      modified_at: metadata.mtimeMs / 1_000,
    });
  }
  return directories.sort(
    (left, right) =>
      right.modified_at - left.modified_at
      || left.name.localeCompare(right.name),
  );
}

function terminalRunStates(db: Database.Database): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT autonomy_run_id, state
       FROM autonomy_run_projection`,
    )
    .all() as Array<{ autonomy_run_id: string; state: string }>;
  return new Map(
    rows
      .filter(
        (row) =>
          STANDARD_RETENTION_STATES.has(row.state)
          || EXTENDED_RETENTION_STATES.has(row.state),
      )
      .map((row) => [row.autonomy_run_id, row.state]),
  );
}

async function retentionSnapshot(
  options: AutonomyRetentionOptions,
): Promise<{
  config: ReturnType<typeof retentionConfig>;
  logs: Array<{ path: string; size: number }>;
  expiredProofs: Array<{ name: string; path: string }>;
}> {
  const config = retentionConfig(options);
  const logs = await Promise.all(
    (await regularFiles(join(options.home, "logs"))).map(async (path) => ({
      path,
      size: (await stat(path)).size,
    })),
  );
  const proofDirs = await proofDirectories(join(options.home, "autonomy"));
  const terminal = terminalRunStates(options.db);
  const cutoff =
    config.now - config.proofRetentionDays * 86_400;
  const extendedCutoff =
    config.now - config.proofRetentionDays * 3 * 86_400;
  const minimumKept = new Set(
    proofDirs.slice(0, config.proofMinKeep).map((entry) => entry.name),
  );
  const expiredProofs = proofDirs
    .filter((entry) => !minimumKept.has(entry.name))
    .filter((entry) => {
      const state = terminal.get(entry.name);
      if (state === undefined) return false;
      return entry.modified_at < (
        EXTENDED_RETENTION_STATES.has(state)
          ? extendedCutoff
          : cutoff
      );
    })
    .map(({ name, path }) => ({ name, path }));
  return { config, logs, expiredProofs };
}

export async function inspectAutonomyRetention(
  options: AutonomyRetentionOptions,
): Promise<AutonomyRetentionReport> {
  const { config, logs, expiredProofs } = await retentionSnapshot(options);
  return {
    checked_at: config.now,
    max_log_bytes: config.maxLogBytes,
    max_log_files: config.maxLogFiles,
    proof_retention_days: config.proofRetentionDays,
    proof_min_keep: config.proofMinKeep,
    largest_log_bytes: Math.max(0, ...logs.map((entry) => entry.size)),
    oversized_log_count: logs.filter(
      (entry) => entry.size > config.maxLogBytes,
    ).length,
    expired_terminal_proof_count: expiredProofs.length,
    rotated_logs: [],
    removed_proof_dirs: [],
  };
}

async function rotateLog(path: string, maxFiles: number): Promise<void> {
  await rm(`${path}.${maxFiles}`, { force: true });
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    try {
      await rename(`${path}.${index}`, `${path}.${index + 1}`);
    } catch (error) {
      if (
        !(error instanceof Error)
        || !("code" in error)
        || error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
  await copyFile(path, `${path}.1`);
  await truncate(path, 0);
}

export async function enforceAutonomyRetention(
  options: AutonomyRetentionOptions,
): Promise<AutonomyRetentionReport> {
  await mkdir(join(options.home, "logs"), { recursive: true });
  await mkdir(join(options.home, "autonomy"), { recursive: true });
  const snapshot = await retentionSnapshot(options);
  const rotatedLogs: string[] = [];
  for (const log of snapshot.logs) {
    if (log.size <= snapshot.config.maxLogBytes) continue;
    await rotateLog(log.path, snapshot.config.maxLogFiles);
    rotatedLogs.push(log.path);
  }
  const removedProofDirs: string[] = [];
  for (const proof of snapshot.expiredProofs) {
    await rm(proof.path, { recursive: true, force: false });
    removedProofDirs.push(proof.path);
  }
  const inspected = await inspectAutonomyRetention(options);
  return {
    ...inspected,
    rotated_logs: rotatedLogs,
    removed_proof_dirs: removedProofDirs,
  };
}

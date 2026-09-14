// SQLite connection management.
//
// Decisions locked in plan v0.6:
//   - better-sqlite3 (synchronous, single connection per daemon process)
//   - WAL mode for concurrent reader/writer safety
//   - synchronous=NORMAL (WAL-safe, faster than FULL)
//   - 64 MiB page cache
//   - foreign_keys ON (so ON DELETE CASCADE works for runs/events on task delete)
//
// CRITICAL GAP G1 (plan v0.6 §8.3): disk-full must never cause a silent task
// write loss. Every write goes through preflightDiskSpace(), which throws
// DiskFullError before any INSERT/UPDATE can corrupt or stall a transaction.

import Database from "better-sqlite3";
import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";

/** Default safety threshold for disk-full preflight (100 MiB). */
export const DEFAULT_MIN_FREE_BYTES = 100 * 1024 * 1024;

/** Cache size in -kibibyte units. negative = KiB (per SQLite docs). 64 MiB. */
const PAGE_CACHE_KIB = -65536;

export class DiskFullError extends Error {
  readonly path: string;
  readonly freeBytes: number;
  readonly minFreeBytes: number;
  constructor(path: string, freeBytes: number, minFreeBytes: number) {
    super(
      `Disk full preflight failed for ${path}: ${freeBytes} bytes free, ` +
      `need ≥${minFreeBytes}. Refusing write so Hermes can be notified.`,
    );
    this.name = "DiskFullError";
    this.path = path;
    this.freeBytes = freeBytes;
    this.minFreeBytes = minFreeBytes;
  }
}

export interface OpenDbOptions {
  /** Absolute path to the SQLite file (parent dir must exist). */
  path: string;
  /** When false, opens read-only. */
  readwrite?: boolean;
  /** Override the disk-full safety threshold (bytes). */
  minFreeBytes?: number;
}

/**
 * Run a free-space check against the filesystem holding `path`. Throws
 * DiskFullError if below threshold; otherwise returns free byte count.
 * Skips the check (returns Infinity) if statfsSync is unsupported on the
 * platform — better to allow writes than to crash a daemon on a kernel quirk.
 */
export function preflightDiskSpace(
  path: string,
  minFreeBytes: number = DEFAULT_MIN_FREE_BYTES,
): number {
  let stats: { bsize: number; bavail: number };
  try {
    stats = statfsSync(dirname(path));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  const free = Number(stats.bsize) * Number(stats.bavail);
  if (free < minFreeBytes) throw new DiskFullError(path, free, minFreeBytes);
  return free;
}

/**
 * Open the osstack state database, apply pragmas, and run pending migrations.
 * Caller owns the lifetime — pair every openDb() with a db.close() in shutdown.
 */
export function openDb(opts: OpenDbOptions): Database.Database {
  const { path, readwrite = true, minFreeBytes = DEFAULT_MIN_FREE_BYTES } = opts;
  if (readwrite) preflightDiskSpace(path, minFreeBytes);

  const db = new Database(path, { readonly: !readwrite });

  try {
    // Refuse an unsupported schema before changing journal mode or running DDL,
    // including read-only inspection. A failed open never escapes with a live handle.
    assertSupportedVersion(db.pragma("user_version", { simple: true }) as number);
    // Pragmas are applied per-connection in SQLite. Apply on every open.
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma(`cache_size = ${PAGE_CACHE_KIB}`);
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");

    if (readwrite) runMigrations(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function assertSupportedVersion(current: number): void {
  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Migration state inconsistent: user_version=${current}, expected=${CURRENT_SCHEMA_VERSION}`);
  }
}

/**
 * Apply pending migrations idempotently. `user_version` PRAGMA tracks progress.
 * The migrations themselves are CREATE IF NOT EXISTS-safe, but the version
 * pragma is what guarantees we only apply forward.
 */
export function runMigrations(db: Database.Database): void {
  const currentRow = db.pragma("user_version", { simple: true }) as number;
  let current = Number(currentRow);
  assertSupportedVersion(current);
  for (const m of MIGRATIONS) {
    if (m.id <= current) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.id}`);
      db.exec("COMMIT");
      current = m.id;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  if (current !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Migration state inconsistent: user_version=${current}, expected=${CURRENT_SCHEMA_VERSION}`,
    );
  }
}

/**
 * Run a function inside a transaction with preflight. Use for any write path
 * called from the daemon hot loop. Wraps better-sqlite3's transaction() so
 * disk-space errors fire BEFORE BEGIN, not mid-transaction.
 */
export function withWrite<T>(
  db: Database.Database,
  path: string,
  fn: (db: Database.Database) => T,
  minFreeBytes: number = DEFAULT_MIN_FREE_BYTES,
): T {
  preflightDiskSpace(path, minFreeBytes);
  const tx = db.transaction(fn);
  return tx(db);
}

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, preflightDiskSpace, withWrite, DiskFullError } from "./db.js";
import { CURRENT_SCHEMA_VERSION } from "./migrations.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "osstack-db-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("openDb + runMigrations", () => {
  it("creates the db file and applies the initial schema", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      expect(existsSync(path)).toBe(true);
      const ver = db.pragma("user_version", { simple: true });
      expect(Number(ver)).toBe(CURRENT_SCHEMA_VERSION);
      // All 7 tables present (6 lifecycle + memory_facts added in migration 2).
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
      const names = rows.map((r) => r.name);
      for (const t of ["tasks", "runs", "events", "agents", "approvals", "clarifies", "memory_facts"]) {
        expect(names).toContain(t);
      }
    } finally {
      db.close();
    }
  });

  it("is idempotent across reopens (migrations don't re-run)", () => {
    const path = join(tmp, "state.db");
    openDb({ path }).close();
    const db = openDb({ path });
    try {
      expect(Number(db.pragma("user_version", { simple: true }))).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("enables WAL journaling and foreign keys", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const journal = db.pragma("journal_mode", { simple: true });
      expect(String(journal).toLowerCase()).toBe("wal");
      const fk = db.pragma("foreign_keys", { simple: true });
      expect(Number(fk)).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("preflightDiskSpace (G1)", () => {
  it("returns a positive free-byte count for a writable temp dir", () => {
    const free = preflightDiskSpace(join(tmp, "state.db"));
    expect(free).toBeGreaterThan(0);
  });

  it("throws DiskFullError when the threshold exceeds available space", () => {
    // Threshold of Number.MAX_SAFE_INTEGER will always exceed real free space.
    expect(() =>
      preflightDiskSpace(join(tmp, "state.db"), Number.MAX_SAFE_INTEGER),
    ).toThrow(DiskFullError);
  });
});

describe("withWrite", () => {
  it("runs a transaction successfully on enough free space", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const result = withWrite(db, path, (d) => {
        d.prepare(
          "INSERT INTO tasks(task_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).run("t1", "hello", "pending", 1, 1);
        return d.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number };
      });
      expect(result.c).toBe(1);
    } finally {
      db.close();
    }
  });

  it("refuses to start a transaction when disk-full threshold is unmet", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      expect(() =>
        withWrite(db, path, () => 1, Number.MAX_SAFE_INTEGER),
      ).toThrow(DiskFullError);
      // ... and the count is still zero — no partial write.
      const row = db.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number };
      expect(row.c).toBe(0);
    } finally {
      db.close();
    }
  });
});

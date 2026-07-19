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

describe("kanban typed cards + verification checks (migration 7)", () => {
  it("defaults kanban_cards.card_type to 'implementation' when not specified on insert", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      db.prepare(
        "INSERT INTO kanban_cards(card_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      ).run("card-1", "Untyped card", 1, 1);
      const row = db.prepare("SELECT card_type FROM kanban_cards WHERE card_id = ?").get("card-1") as {
        card_type: string;
      };
      expect(row.card_type).toBe("implementation");
    } finally {
      db.close();
    }
  });

  it("accepts an insert and read of a kanban_card_checks row with a valid state", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      db.prepare(
        "INSERT INTO kanban_cards(card_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      ).run("card-2", "Card with checks", 1, 1);
      db.prepare(
        "INSERT INTO kanban_card_checks(card_id, idx, label, state, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("card-2", 0, "Tests pass", "pass", "vitest green", 1);
      const row = db.prepare("SELECT * FROM kanban_card_checks WHERE card_id = ? AND idx = ?").get(
        "card-2",
        0,
      ) as { card_id: string; idx: number; label: string; state: string; detail: string | null; updated_at: number };
      expect(row.card_id).toBe("card-2");
      expect(row.label).toBe("Tests pass");
      expect(row.state).toBe("pass");
    } finally {
      db.close();
    }
  });

  it("rejects a kanban_card_checks insert with an invalid state via the CHECK constraint", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      db.prepare(
        "INSERT INTO kanban_cards(card_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      ).run("card-3", "Card with bad check", 1, 1);
      expect(() =>
        db
          .prepare(
            "INSERT INTO kanban_card_checks(card_id, idx, label, state, updated_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run("card-3", 0, "Bad state", "bogus", 1),
      ).toThrow();
    } finally {
      db.close();
    }
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

import Database from "better-sqlite3";

describe("schema incident hardening (G1.4, incident 2026-07-18)", () => {
  it("REFUSES to open a DB whose user_version is above this binary's supported schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "g14-"));
    const p = join(dir, "state.db");
    const db1 = openDb({ path: p });
    db1.close();
    const raw = new Database(p);
    raw.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 3}`);
    raw.close();
    expect(() => openDb({ path: p })).toThrowError(/Migration state inconsistent/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("version-rollback-then-reopen is UNSAFE with ALTER-based migrations (documented anti-pattern)", () => {
    // The 2026-07-18 incident was first mitigated by PRAGMA user_version
    // rollback. That is only survivable when the re-run migrations are fully
    // idempotent. CREATE ... IF NOT EXISTS is; ALTER TABLE ADD COLUMN is NOT:
    // re-running migration 10 over its own residue fails. Therefore the ONLY
    // supported rollback is a full DB snapshot restore — this test pins that
    // contract so nobody "just resets user_version" again.
    const dir = mkdtempSync(join(tmpdir(), "g14-replay-"));
    const p = join(dir, "state.db");
    openDb({ path: p }).close(); // full schema at CURRENT
    const raw = new Database(p);
    raw.pragma("user_version = 8");
    raw.close();
    expect(() => openDb({ path: p })).toThrowError(/duplicate column|already exists/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a DB already at CURRENT with the full incident residue opens with NO migration and intact integrity (the final-deploy path)", () => {
    const dir = mkdtempSync(join(tmpdir(), "g14-final-"));
    const p = join(dir, "state.db");
    openDb({ path: p }).close();
    const db = openDb({ path: p });
    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect((db.prepare("SELECT count(*) c FROM sqlite_master WHERE name LIKE 'probe_%' AND type='table'").get() as { c: number }).c).toBeGreaterThan(0);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

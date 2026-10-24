import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, preflightDiskSpace, withWrite, DiskFullError } from "./db.js";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "osstack-db-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("openDb + runMigrations", () => {
  it("keeps migration ids unique and strictly increasing", () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((left, right) => left - right));
    expect(ids.at(-1)).toBe(CURRENT_SCHEMA_VERSION);
  });

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
      for (const t of ["agent_sessions", "session_turns", "session_messages"]) {
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

describe("guarded autonomy persistence (migrations 18-20)", () => {
  it("creates deploy, notification, drill, append-only trail, and writer state", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      expect(Number(db.pragma("user_version", { simple: true }))).toBe(
        CURRENT_SCHEMA_VERSION,
      );
      const objects = db
        .prepare(
          `SELECT name, type
           FROM sqlite_master
           WHERE name IN (
             'autonomy_run_projection',
             'autonomy_run_transitions',
             'autonomy_deploy_freezes',
             'autonomy_notification_outbox',
             'autonomy_rollback_drills',
             'autonomy_rollback_drills_no_update',
             'autonomy_rollback_drills_no_delete',
             'idx_autonomy_run_projection_one_active_repo',
             'autonomy_run_transitions_no_update',
             'autonomy_run_transitions_no_delete'
           )
           ORDER BY name`,
        )
        .all() as Array<{ name: string; type: string }>;
      expect(objects).toEqual([
        {
          name: "autonomy_deploy_freezes",
          type: "table",
        },
        {
          name: "autonomy_notification_outbox",
          type: "table",
        },
        {
          name: "autonomy_rollback_drills",
          type: "table",
        },
        {
          name: "autonomy_rollback_drills_no_delete",
          type: "trigger",
        },
        {
          name: "autonomy_rollback_drills_no_update",
          type: "trigger",
        },
        {
          name: "autonomy_run_projection",
          type: "table",
        },
        {
          name: "autonomy_run_transitions",
          type: "table",
        },
        {
          name: "autonomy_run_transitions_no_delete",
          type: "trigger",
        },
        {
          name: "autonomy_run_transitions_no_update",
          type: "trigger",
        },
        {
          name: "idx_autonomy_run_projection_one_active_repo",
          type: "index",
        },
      ]);
      const projectionColumns = db
        .prepare("PRAGMA table_info(autonomy_run_projection)")
        .all() as Array<{ name: string }>;
      expect(projectionColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["deploy_json", "rollback_json"]),
      );
    } finally {
      db.close();
    }
  });

  it("upgrades a populated v17 autonomy database without losing history", () => {
    const path = join(tmp, "state.db");
    const legacy = new Database(path);
    legacy.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((item) => item.id <= 17)) {
      legacy.exec(migration.sql);
    }
    legacy.pragma("user_version = 17");
    legacy
      .prepare(
        `INSERT INTO autonomy_run_transitions (
           transition_id, autonomy_run_id, seq, from_state, to_state,
           event_json, contract_decision_id, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "transition_001",
        "run_001",
        1,
        null,
        "merging",
        '{"type":"merge.completed"}',
        null,
        100,
      );
    legacy
      .prepare(
        `INSERT INTO autonomy_run_projection (
           autonomy_run_id, task_id, repo_id, workspace_path, state, revision,
           contract_sha256, diff_sha256, preflight_risk_json,
           post_diff_risk_json, approval_json, routing_json, budget_json,
           attempt_json, candidate_proof_json, git_delivery_json,
           final_proof_json, last_transition_id, created_at, updated_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )`,
      )
      .run(
        "run_001",
        "task_001",
        "example-web",
        "/workspace/example-web",
        "merging",
        1,
        "a".repeat(64),
        null,
        null,
        null,
        null,
        null,
        "{}",
        "{}",
        null,
        '{"merged":true}',
        null,
        "transition_001",
        100,
        100,
      );
    legacy.close();

    const upgraded = openDb({ path, minFreeBytes: 0 });
    try {
      expect(upgraded.pragma("user_version", { simple: true })).toBe(
        CURRENT_SCHEMA_VERSION,
      );
      expect(
        upgraded
          .prepare(
            `SELECT state, git_delivery_json, deploy_json, rollback_json
             FROM autonomy_run_projection
             WHERE autonomy_run_id = ?`,
          )
          .get("run_001"),
      ).toEqual({
        state: "merging",
        git_delivery_json: '{"merged":true}',
        deploy_json: null,
        rollback_json: null,
      });
      upgraded
        .prepare(
          `INSERT INTO autonomy_run_transitions (
             transition_id, autonomy_run_id, seq, from_state, to_state,
             event_json, contract_decision_id, occurred_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "transition_002",
          "run_001",
          2,
          "merging",
          "deploying_staging",
          '{"type":"deploy.staging.started"}',
          null,
          101,
        );
      expect(() =>
        upgraded
          .prepare(
            "UPDATE autonomy_run_transitions SET event_json = ? WHERE transition_id = ?",
          )
          .run("{}", "transition_001"),
      ).toThrow(/append-only/);
      expect(upgraded.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      upgraded.close();
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
    expect(() => openDb({ path: p })).toThrowError(/duplicate column|already exists|GRAPH_EXPERIMENTAL_SCHEMA_CONFLICT/);
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


describe("graph admission migrations", () => {
  it("upgrades the actual pre-G08 baseline and preserves old rows across repeat opens", () => {
    const path = join(tmp, "baseline.db");
    const legacy = new Database(path);
    for (const migration of MIGRATIONS.filter((m) => m.id <= 24)) legacy.exec(migration.sql);
    legacy.pragma("user_version = 24");
    legacy.prepare("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES ('old','old','pending',1,1)").run();
    legacy.close();
    for (let i = 0; i < 2; i++) {
      const db = openDb({ path });
      try {
        expect(db.prepare("SELECT title FROM tasks WHERE task_id='old'").get()).toEqual({ title: "old" });
        expect(db.prepare("SELECT count(*) AS n FROM graph_runs").get()).toEqual({ n: 0 });
        expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
        expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      } finally { db.close(); }
    }
  });

  it("closes the newly opened connection when migration rejects a future version", () => {
    const path = join(tmp, "future.db");
    const raw = new Database(path);
    raw.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
    raw.close();
    const close = vi.spyOn(Database.prototype, "close");
    try {
      expect(() => openDb({ path })).toThrow(/Migration state inconsistent/);
      expect(close).toHaveBeenCalledTimes(1);
    } finally { close.mockRestore(); }
    const check = new Database(path);
    try { expect(check.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION + 1); }
    finally { check.close(); }
  });
});


describe("failed-open cleanup", () => {
  it("rejects future schemas on read-only opens too", () => {
    const path = join(tmp, "readonly-future.db");
    const raw = new Database(path);
    raw.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => openDb({ path, readwrite: false })).toThrow(/Migration state inconsistent/);
  });

  it("closes a connection after a real SQL migration failure and rolls back the failed migration", () => {
    const path = join(tmp, "broken-baseline.db");
    const raw = new Database(path);
    for (const migration of MIGRATIONS.filter((m) => m.id <= 27)) raw.exec(migration.sql);
    raw.pragma("user_version = 27");
    raw.exec("CREATE INDEX idx_graph_runs_scope_status ON tasks(status)");
    raw.close();
    const close = vi.spyOn(Database.prototype, "close");
    try {
      expect(() => openDb({ path })).toThrow(/already exists/);
      expect(close).toHaveBeenCalledTimes(1);
    } finally { close.mockRestore(); }
    const check = new Database(path);
    try {
      expect(check.pragma("user_version", { simple: true })).toBe(27);
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name='graph_runs'").get()).toBeUndefined();
    } finally { check.close(); }
  });
});


describe("graph ledger migration 29", () => {
  it("upgrades populated v28 graph history, leaves missing original specs explicit, and reserves v30 for checkpoints", () => {
    const path = join(tmp, "graph-v25.db");
    const old = new Database(path);
    for (const migration of MIGRATIONS.filter((m) => m.id <= 28)) old.exec(migration.sql);
    old.prepare(`INSERT INTO graph_runs (graph_run_id, scope_json, source_json, input_artifact_ref,
      template, identity_json, status, generation, revision, created_at, updated_at)
      VALUES ('legacy', '{}', '{}', 'input', 'code-delivery-v1', '{}', 'queued', 0, 0, 1, 1)`).run();
    old.pragma("user_version = 28"); old.close();
    for (let i = 0; i < 2; i++) {
      const db = openDb({ path });
      try {
        expect(db.prepare("SELECT graph_run_id, spec_json, revision FROM graph_runs").get())
          .toEqual({ graph_run_id: "legacy", spec_json: null, revision: 0 });
        expect(db.prepare("SELECT count(*) AS n FROM graph_actions").get()).toEqual({ n: 0 });
        expect(() => db.prepare("UPDATE graph_runs SET spec_json = '{}' WHERE graph_run_id = 'legacy'").run()).toThrow(/immutable/);
        expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      } finally { db.close(); }
    }
    expect(MIGRATIONS.find((m) => m.id === 29)?.name).toBe("graph_action_ledger_and_original_budget");
  });

  it("rolls back ALTER and all ledger DDL when migration 29 fails", () => {
    const path = join(tmp, "graph-v26-failure.db");
    const old = new Database(path);
    for (const migration of MIGRATIONS.filter((m) => m.id <= 28)) old.exec(migration.sql);
    old.pragma("user_version = 28");
    old.exec("CREATE INDEX idx_graph_actions_run_state ON graph_runs(status)"); old.close();
    expect(() => openDb({ path })).toThrow(/already exists/);
    const check = new Database(path);
    try {
      expect(check.pragma("user_version", { simple: true })).toBe(28);
      expect((check.prepare("PRAGMA table_info(graph_runs)").all() as { name: string }[]).map((r) => r.name)).not.toContain("spec_json");
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name='graph_runs_spec_immutable'").get()).toBeUndefined();
    } finally { check.close(); }
  });
});

describe("attention run event cursor migration", () => {
  it("upgrades genuine schema 41 and retains observations and cursors across reopen", () => {
    const path = join(tmp, "attention-41.db");
    const old = new Database(path);
    for (const m of MIGRATIONS.filter(m => m.id <= 41)) old.exec(m.sql);
    old.pragma("user_version = 41");
    old.prepare("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('legacy','Retain me','running',1,1)").run();
    old.prepare("INSERT INTO attention_scopes(scope_id,task_id,repo_path,generation) VALUES('scope','legacy','/canonical/repo',1)").run();
    old.prepare("INSERT INTO attention_subjects(scope_id,kind,subject_id,binding_hash,source_version,discovered_at,sampled_at,generation,payload_json) VALUES('scope','run','run','binding',1,1,1,1,'{}')").run();
    old.close();
    const first = openDb({path});
    try {
      first.prepare("INSERT INTO attention_run_cursors(scope_id,run_id,binding_hash,last_seq,through_seq,last_event_hash,gap,facts_json,generation,updated_at) VALUES('scope','run','binding',2,5,'hash','history_gap','{}',1,10)").run();
      expect(first.prepare("SELECT title FROM tasks WHERE task_id='legacy'").get()).toEqual({title:"Retain me"});
      expect(first.prepare("SELECT subject_id FROM attention_subjects").get()).toEqual({subject_id:"run"});
    } finally { first.close(); }
    const second = openDb({path});
    try {
      expect(second.prepare("SELECT last_seq,through_seq,gap FROM attention_run_cursors").get()).toEqual({last_seq:2,through_seq:5,gap:"history_gap"});
      expect(second.pragma("integrity_check", {simple:true})).toBe("ok");
      // Source deletion must not erase the preserved observation evidence.
      second.prepare("DELETE FROM attention_scopes WHERE scope_id='scope'").run();
      expect(second.prepare("SELECT COUNT(*) n FROM attention_run_cursors").get()).toEqual({n:1});
    } finally { second.close(); }
  });
});

it("rolls back a conflicting cursor migration without changing schema 41 facts", () => {
  const path = join(tmp, "attention-42-conflict.db");
  const old = new Database(path);
  for (const m of MIGRATIONS.filter(m => m.id <= 41)) old.exec(m.sql);
  old.pragma("user_version = 41");
  old.exec("CREATE VIEW attention_run_cursors AS SELECT 1 AS preserved");
  old.close();
  expect(() => openDb({path})).toThrow(/already exists/);
  const check = new Database(path, {readonly:true});
  try {
    expect(check.pragma("user_version", {simple:true})).toBe(41);
    expect(check.prepare("SELECT preserved FROM attention_run_cursors").get()).toEqual({preserved:1});
    expect(check.pragma("integrity_check", {simple:true})).toBe("ok");
  } finally { check.close(); }
});

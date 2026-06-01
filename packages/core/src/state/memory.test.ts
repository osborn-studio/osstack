import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";
import {
  archiveFact,
  countActiveFactsForSubject,
  readFactsForSubject,
  supersedeFact,
  writeFact,
} from "./memory.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "osstack-mem-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("memory_facts CRUD", () => {
  it("writes a fact and reads it back for the subject", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const fact = writeFact(db, path, {
        fact_id: "fact_1",
        subject_type: "client",
        subject_id: "client_wang",
        fact_type: "preference",
        fact_text: "Prefers Chinese-language correspondence",
        source_type: "user_confirmation",
        source_id: "approval_42",
      });
      expect(fact.fact_id).toBe("fact_1");
      expect(fact.status).toBe("active");
      expect(fact.confidence).toBe(1);
      expect(fact.created_at).toBeGreaterThan(0);

      const back = readFactsForSubject(db, "client", "client_wang");
      expect(back.length).toBe(1);
      expect(back[0]!.fact_text).toMatch(/Chinese/);
    } finally {
      db.close();
    }
  });

  it("only returns active facts (superseded + archived are filtered out)", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      writeFact(db, path, {
        fact_id: "f_old",
        subject_type: "workflow",
        subject_id: "law.client_intake",
        fact_type: "correction",
        fact_text: "Old correction",
        source_type: "approval_note",
      });
      writeFact(db, path, {
        fact_id: "f_new",
        subject_type: "workflow",
        subject_id: "law.client_intake",
        fact_type: "correction",
        fact_text: "New correction",
        source_type: "approval_note",
      });
      writeFact(db, path, {
        fact_id: "f_dead",
        subject_type: "workflow",
        subject_id: "law.client_intake",
        fact_type: "correction",
        fact_text: "Archived correction",
        source_type: "approval_note",
      });

      supersedeFact(db, path, "f_old");
      archiveFact(db, path, "f_dead");

      const active = readFactsForSubject(db, "workflow", "law.client_intake");
      expect(active.length).toBe(1);
      expect(active[0]!.fact_id).toBe("f_new");
      expect(countActiveFactsForSubject(db, "workflow", "law.client_intake")).toBe(1);
    } finally {
      db.close();
    }
  });

  it("rejects out-of-range confidence at the schema layer", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      expect(() => writeFact(db, path, {
        fact_id: "f_bad",
        subject_type: "tenant",
        subject_id: "t1",
        fact_type: "preference",
        fact_text: "should fail",
        source_type: "user_confirmation",
        confidence: 1.5,
      })).toThrow();
    } finally {
      db.close();
    }
  });

  it("defaults source_id to null when omitted", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const fact = writeFact(db, path, {
        fact_id: "f_inferred",
        subject_type: "client",
        subject_id: "c1",
        fact_type: "observation",
        fact_text: "Inferred preference",
        source_type: "agent_inference",
        confidence: 0.6,
      });
      expect(fact.source_id).toBeNull();
      expect(fact.confidence).toBe(0.6);
    } finally {
      db.close();
    }
  });

  it("schema version is at least 2 after migrations apply", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const ver = Number(db.pragma("user_version", { simple: true }));
      expect(ver).toBeGreaterThanOrEqual(2);
      // memory_facts table exists
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_facts'",
      ).get();
      expect(row).toBeTruthy();
    } finally {
      db.close();
    }
  });

  // ── Multi-tenant column (migration #3) ─────────────────────────────
  it("memory_facts.tenant_id column exists after migration #3", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const cols = db.prepare("PRAGMA table_info(memory_facts)").all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === "tenant_id")).toBe(true);
      // user_version is now ≥ 3
      expect(Number(db.pragma("user_version", { simple: true }))).toBeGreaterThanOrEqual(3);
    } finally {
      db.close();
    }
  });

  it("isolates facts by tenant when tenant_id is provided", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      writeFact(db, path, {
        fact_id: "f_t1",
        tenant_id: "tenant_a",
        subject_type: "client",
        subject_id: "c_shared",
        fact_type: "preference",
        fact_text: "Tenant A prefers Mandarin",
        source_type: "user_confirmation",
      });
      writeFact(db, path, {
        fact_id: "f_t2",
        tenant_id: "tenant_b",
        subject_type: "client",
        subject_id: "c_shared",
        fact_type: "preference",
        fact_text: "Tenant B prefers English",
        source_type: "user_confirmation",
      });
      writeFact(db, path, {
        fact_id: "f_default",
        // tenant_id omitted → defaults to null
        subject_type: "client",
        subject_id: "c_shared",
        fact_type: "preference",
        fact_text: "Default/legacy fact",
        source_type: "user_confirmation",
      });

      // All-tenant read returns 3
      expect(readFactsForSubject(db, "client", "c_shared").length).toBe(3);
      // Tenant A sees only its own row
      const a = readFactsForSubject(db, "client", "c_shared", { tenant_id: "tenant_a" });
      expect(a.length).toBe(1);
      expect(a[0]!.fact_text).toMatch(/Mandarin/);
      // Tenant B sees only its own row
      const b = readFactsForSubject(db, "client", "c_shared", { tenant_id: "tenant_b" });
      expect(b.length).toBe(1);
      expect(b[0]!.fact_text).toMatch(/English/);
      // Explicit null returns the legacy/default fact
      const def = readFactsForSubject(db, "client", "c_shared", { tenant_id: null });
      expect(def.length).toBe(1);
      expect(def[0]!.fact_text).toMatch(/Default/);
    } finally {
      db.close();
    }
  });

  it("count helper respects tenant scope", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      writeFact(db, path, {
        fact_id: "fc_1", tenant_id: "tenant_a",
        subject_type: "workflow", subject_id: "law.client_intake",
        fact_type: "correction", fact_text: "warmer", source_type: "approval_note",
      });
      writeFact(db, path, {
        fact_id: "fc_2", tenant_id: "tenant_b",
        subject_type: "workflow", subject_id: "law.client_intake",
        fact_type: "correction", fact_text: "shorter", source_type: "approval_note",
      });
      expect(countActiveFactsForSubject(db, "workflow", "law.client_intake")).toBe(2);
      expect(countActiveFactsForSubject(db, "workflow", "law.client_intake", { tenant_id: "tenant_a" })).toBe(1);
      expect(countActiveFactsForSubject(db, "workflow", "law.client_intake", { tenant_id: "tenant_c" })).toBe(0);
    } finally {
      db.close();
    }
  });
});

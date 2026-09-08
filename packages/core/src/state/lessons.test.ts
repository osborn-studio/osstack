import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { openDb } from "./db.js";
import { MIGRATIONS } from "./migrations.js";
import { listPitfallLessons, upsertPitfallLesson, verifyPitfallLessons } from "./lessons.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "osstack-lessons-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("pitfall lessons", () => {
  it("persists and lists a lesson", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const lesson = upsertPitfallLesson(db, path, {
        family: "verify_failed",
        tech_stack: ["typescript", "pnpm"],
        symptom: "pnpm test failed after code change",
        resolution: "run pnpm install before test",
        source_run_id: "run_1",
      });

      expect(lesson.pitfall_id).toMatch(/^pit_/);
      expect(lesson.observation_count).toBe(1);
      expect(lesson.observation_run_ids).toEqual(["run_1"]);
      expect(lesson.verified_count).toBe(0);
      expect(lesson.legacy_verified_count).toBe(0);
      expect(lesson.tech_stack).toEqual(["pnpm", "typescript"]);
      expect(listPitfallLessons(db)).toEqual([expect.objectContaining({
        family: "verify_failed",
        source_run_ids: ["run_1"],
      })]);
    } finally {
      db.close();
    }
  });

  it("counts distinct failure observations without claiming verified effectiveness", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const first = upsertPitfallLesson(db, path, {
        family: "agent_unavailable",
        tech_stack: ["codex"],
        symptom: "codex-cli unavailable",
        resolution: "fallback to local verifier",
        source_run_id: "run_1",
      });
      const second = upsertPitfallLesson(db, path, {
        family: "agent_unavailable",
        tech_stack: ["codex"],
        symptom: "codex-cli unavailable",
        resolution: "fallback to local verifier",
        source_run_id: "run_2",
      });

      expect(second.pitfall_id).toBe(first.pitfall_id);
      expect(second.observation_count).toBe(2);
      expect(second.observation_run_ids).toEqual(["run_1", "run_2"]);
      expect(second.verified_count).toBe(0);
      expect(second.legacy_verified_count).toBe(0);
      expect(second.source_run_ids).toEqual(["run_1", "run_2"]);
      expect(listPitfallLessons(db, { family: "agent_unavailable" })).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("does not count the same failure observation twice", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const first = upsertPitfallLesson(db, path, {
        family: "verify_failed",
        tech_stack: ["typescript"],
        symptom: "tests failed",
        resolution: "rerun deterministic checks",
        source_run_id: "run_1",
      });
      const second = upsertPitfallLesson(db, path, {
        family: "verify_failed",
        tech_stack: ["typescript"],
        symptom: "tests failed",
        resolution: "rerun deterministic checks",
        source_run_id: "run_1",
      });

      expect(second.pitfall_id).toBe(first.pitfall_id);
      expect(second.observation_count).toBe(1);
      expect(second.verified_count).toBe(0);
      expect(second.source_run_ids).toEqual(["run_1"]);
    } finally {
      db.close();
    }
  });

  it("does not overwrite another connection's observation when writes overlap", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    const otherDb = openDb({ path });
    const lesson = {
      family: "verify_failed",
      tech_stack: ["typescript"],
      symptom: "tests failed",
      resolution: "rerun deterministic checks",
      source_run_id: "run_0",
    };
    try {
      upsertPitfallLesson(db, path, lesson);
      let interleaved = false;
      let conflict: unknown;
      try {
        upsertPitfallLesson(db, path, {
          ...lesson,
          // Interleave a committed write after this caller reads the existing
          // lesson, exactly where a second CLI/daemon connection can race it.
          get source_run_id() {
            if (!interleaved) {
              interleaved = true;
              upsertPitfallLesson(otherDb, path, { ...lesson, source_run_id: "run_b" });
            }
            return "run_a";
          },
        });
      } catch (error) {
        conflict = error;
      }
      expect(interleaved).toBe(true);
      expect(listPitfallLessons(otherDb)[0]?.observation_run_ids).toContain("run_b");
      // withWrite uses a deferred transaction. An outdated WAL snapshot must
      // fail visibly so a caller can retry; it must never silently lose run_b.
      if (conflict !== undefined) {
        expect(conflict).toMatchObject({ code: "SQLITE_BUSY_SNAPSHOT" });
        upsertPitfallLesson(db, path, { ...lesson, source_run_id: "run_a" });
      }
      const [stored] = listPitfallLessons(db);
      expect(stored?.observation_count).toBe(3);
      expect(stored?.observation_run_ids).toEqual(expect.arrayContaining(["run_0", "run_a", "run_b"]));
      expect(stored?.source_run_ids).toEqual(expect.arrayContaining(["run_0", "run_a", "run_b"]));
      expect(stored?.legacy_verified_count).toBe(0);
    } finally {
      otherDb.close();
      db.close();
    }
  });

  it("does not turn a related successful run into verification or an observation", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const lesson = upsertPitfallLesson(db, path, {
        family: "verify_failed",
        tech_stack: ["code", "test"],
        symptom: "test task failed after verifier run",
        resolution: "fix the failing test and rerun verifier",
        source_run_id: "failed_loop",
      });

      const verified = verifyPitfallLessons(db, path, {
        source_run_id: "fixed_loop",
        tech_stack: ["code", "test"],
      });
      const repeated = verifyPitfallLessons(db, path, {
        source_run_id: "fixed_loop",
        tech_stack: ["code", "test"],
      });

      expect(verified).toEqual([]);
      expect(repeated).toEqual([]);
      expect(listPitfallLessons(db)).toEqual([lesson]);
    } finally {
      db.close();
    }
  });

  it("preserves mixed legacy counts across migration without inventing observation history", () => {
    const path = join(tmp, "legacy.db");
    const fingerprint = createHash("sha256").update(JSON.stringify({
      family: "verify_failed",
      tech_stack: ["typescript"],
      symptom: "old test failure",
      resolution: "old unvalidated advice",
    })).digest("hex");
    const legacyDb = new Database(path);
    try {
      for (const migration of MIGRATIONS.filter((entry) => entry.id <= 22)) {
        legacyDb.exec(migration.sql);
        legacyDb.pragma(`user_version = ${migration.id}`);
      }
      legacyDb.prepare(`
        INSERT INTO pitfall_lessons (
          pitfall_id, family, fingerprint, tech_stack_json, symptom, resolution,
          verified_count, source_run_ids_json, status, tenant_id,
          created_at, updated_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "pit_legacy", "verify_failed", fingerprint, '["typescript"]',
        "old test failure", "old unvalidated advice", 7,
        '["old_failure","unrelated_success"]', "active", null, 1, 2, 3,
      );
    } finally {
      legacyDb.close();
    }

    const db = openDb({ path });
    try {
      const [lesson] = listPitfallLessons(db);
      expect(lesson).toMatchObject({
        pitfall_id: "pit_legacy",
        verified_count: 7,
        legacy_verified_count: 7,
        observation_count: 0,
        observation_run_ids: [],
        source_run_ids: ["old_failure", "unrelated_success"],
        created_at: 1,
        updated_at: 2,
        last_seen_at: 3,
      });
      expect(verifyPitfallLessons(db, path, {
        source_run_id: "new_success", tech_stack: ["typescript"],
      })).toEqual([]);
      expect(listPitfallLessons(db)).toEqual([lesson]);

      const observed = upsertPitfallLesson(db, path, {
        family: "verify_failed",
        tech_stack: ["typescript"],
        symptom: "old test failure",
        resolution: "old unvalidated advice",
        source_run_id: "new_failure",
      });
      expect(observed).toMatchObject({
        pitfall_id: "pit_legacy",
        verified_count: 7,
        legacy_verified_count: 7,
        observation_count: 1,
        observation_run_ids: ["new_failure"],
        source_run_ids: ["old_failure", "unrelated_success", "new_failure"],
        created_at: 1,
      });
    } finally {
      db.close();
    }
  });
});

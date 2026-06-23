import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";
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
      expect(lesson.verified_count).toBe(1);
      expect(lesson.tech_stack).toEqual(["pnpm", "typescript"]);
      expect(listPitfallLessons(db)).toEqual([expect.objectContaining({
        family: "verify_failed",
        source_run_ids: ["run_1"],
      })]);
    } finally {
      db.close();
    }
  });

  it("upserts matching fingerprints and increments verified_count", () => {
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
      expect(second.verified_count).toBe(2);
      expect(second.source_run_ids).toEqual(["run_1", "run_2"]);
      expect(listPitfallLessons(db, { family: "agent_unavailable" })).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("does not increment verified_count twice for the same source run", () => {
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
      expect(second.verified_count).toBe(1);
      expect(second.source_run_ids).toEqual(["run_1"]);
    } finally {
      db.close();
    }
  });

  it("increments existing lessons when a later successful run verifies the same tech stack", () => {
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

      expect(verified).toEqual([
        expect.objectContaining({
          pitfall_id: lesson.pitfall_id,
          verified_count: 2,
          source_run_ids: ["failed_loop", "fixed_loop"],
        }),
      ]);
      expect(repeated).toEqual([]);
      expect(listPitfallLessons(db)[0]).toMatchObject({
        pitfall_id: lesson.pitfall_id,
        verified_count: 2,
        source_run_ids: ["failed_loop", "fixed_loop"],
      });
    } finally {
      db.close();
    }
  });
});

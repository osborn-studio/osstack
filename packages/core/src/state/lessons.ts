import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { withWrite } from "./db.js";
import { PitfallLessonRow } from "./schema.js";

export interface NewPitfallLesson {
  pitfall_id?: string;
  family: string;
  tech_stack: string[];
  symptom: string;
  resolution: string;
  source_run_id: string;
  tenant_id?: string | null;
}

export interface PitfallLessonView {
  pitfall_id: string;
  family: string;
  fingerprint: string;
  tech_stack: string[];
  symptom: string;
  resolution: string;
  verified_count: number;
  source_run_ids: string[];
  status: "active" | "archived";
  tenant_id: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number;
}

export function upsertPitfallLesson(
  db: Database.Database,
  dbPath: string,
  lesson: NewPitfallLesson,
): PitfallLessonView {
  const now = Date.now() / 1000;
  const fingerprint = lessonFingerprint(lesson);
  const existing = db.prepare("SELECT * FROM pitfall_lessons WHERE fingerprint = ?").get(fingerprint) as unknown;
  if (existing !== undefined) {
    const current = parsePitfallLesson(existing);
    const sourceRunIds = [...new Set([...current.source_run_ids, lesson.source_run_id])];
    withWrite(db, dbPath, (d) => {
      d.prepare(`
        UPDATE pitfall_lessons
        SET verified_count = verified_count + 1,
            source_run_ids_json = ?,
            updated_at = ?,
            last_seen_at = ?
        WHERE fingerprint = ?
      `).run(JSON.stringify(sourceRunIds), now, now, fingerprint);
    });
    const updated = db.prepare("SELECT * FROM pitfall_lessons WHERE fingerprint = ?").get(fingerprint) as unknown;
    return parsePitfallLesson(updated);
  }

  const row = PitfallLessonRow.parse({
    pitfall_id: lesson.pitfall_id ?? `pit_${fingerprint.slice(0, 16)}`,
    family: lesson.family,
    fingerprint,
    tech_stack_json: JSON.stringify([...new Set(lesson.tech_stack)].sort()),
    symptom: lesson.symptom,
    resolution: lesson.resolution,
    verified_count: 1,
    source_run_ids_json: JSON.stringify([lesson.source_run_id]),
    status: "active",
    tenant_id: lesson.tenant_id ?? null,
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  });
  withWrite(db, dbPath, (d) => {
    d.prepare(`
      INSERT INTO pitfall_lessons (
        pitfall_id, family, fingerprint, tech_stack_json, symptom, resolution,
        verified_count, source_run_ids_json, status, tenant_id,
        created_at, updated_at, last_seen_at
      ) VALUES (
        @pitfall_id, @family, @fingerprint, @tech_stack_json, @symptom, @resolution,
        @verified_count, @source_run_ids_json, @status, @tenant_id,
        @created_at, @updated_at, @last_seen_at
      )
    `).run(row);
  });
  return parsePitfallLesson(row);
}

export function listPitfallLessons(
  db: Database.Database,
  opts: { family?: string; tenant_id?: string | null; limit?: number } = {},
): PitfallLessonView[] {
  const where = ["status = 'active'"];
  const params: unknown[] = [];
  if (opts.family !== undefined) {
    where.push("family = ?");
    params.push(opts.family);
  }
  if (opts.tenant_id !== undefined) {
    if (opts.tenant_id === null) {
      where.push("tenant_id IS NULL");
    } else {
      where.push("tenant_id = ?");
      params.push(opts.tenant_id);
    }
  }
  params.push(opts.limit ?? 20);
  const rows = db.prepare(`
    SELECT * FROM pitfall_lessons
    WHERE ${where.join(" AND ")}
    ORDER BY last_seen_at DESC, verified_count DESC
    LIMIT ?
  `).all(...params) as unknown[];
  return rows.map(parsePitfallLesson);
}

function lessonFingerprint(lesson: NewPitfallLesson): string {
  return createHash("sha256")
    .update(JSON.stringify({
      family: lesson.family,
      tech_stack: [...new Set(lesson.tech_stack)].sort(),
      symptom: lesson.symptom.trim().toLowerCase(),
      resolution: lesson.resolution.trim().toLowerCase(),
    }))
    .digest("hex");
}

function parsePitfallLesson(row: unknown): PitfallLessonView {
  const parsed = PitfallLessonRow.parse(row);
  return {
    ...parsed,
    tech_stack: parseStringArray(parsed.tech_stack_json),
    source_run_ids: parseStringArray(parsed.source_run_ids_json),
  };
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

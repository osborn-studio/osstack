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
  /** @deprecated Frozen legacy counter; never evidence of effectiveness. */
  verified_count: number;
  /** Historical mixed counter preserved without reinterpreting its provenance. */
  legacy_verified_count: number;
  /** Distinct failure observations recorded since explicit observation tracking. */
  observation_count: number;
  observation_run_ids: string[];
  /** Legacy source history plus new observations; old entries may include successes. */
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
  const fingerprint = lessonFingerprint(lesson);
  return withWrite(db, dbPath, (d) => {
    // Keep the read and union in the write transaction. A concurrent writer
    // must cause a visible snapshot conflict, never a stale-array overwrite.
    const now = Date.now() / 1000;
    const existing = d.prepare("SELECT * FROM pitfall_lessons WHERE fingerprint = ?").get(fingerprint) as unknown;
    if (existing !== undefined) {
      const current = parsePitfallLesson(existing);
      const sourceRunIds = [...new Set([...current.source_run_ids, lesson.source_run_id])];
      const observationRunIds = [...new Set([...current.observation_run_ids, lesson.source_run_id])];
      d.prepare(`
        UPDATE pitfall_lessons
        SET source_run_ids_json = ?,
            observation_run_ids_json = ?,
            updated_at = ?,
            last_seen_at = ?
        WHERE fingerprint = ?
      `).run(JSON.stringify(sourceRunIds), JSON.stringify(observationRunIds), now, now, fingerprint);
      const updated = d.prepare("SELECT * FROM pitfall_lessons WHERE fingerprint = ?").get(fingerprint) as unknown;
      return parsePitfallLesson(updated);
    }

    const row = PitfallLessonRow.parse({
      pitfall_id: lesson.pitfall_id ?? `pit_${fingerprint.slice(0, 16)}`,
      family: lesson.family,
      fingerprint,
      tech_stack_json: JSON.stringify([...new Set(lesson.tech_stack)].sort()),
      symptom: lesson.symptom,
      resolution: lesson.resolution,
      verified_count: 0,
      source_run_ids_json: JSON.stringify([lesson.source_run_id]),
      observation_run_ids_json: JSON.stringify([lesson.source_run_id]),
      status: "active",
      tenant_id: lesson.tenant_id ?? null,
      created_at: now,
      updated_at: now,
      last_seen_at: now,
    });
    d.prepare(`
      INSERT INTO pitfall_lessons (
        pitfall_id, family, fingerprint, tech_stack_json, symptom, resolution,
        verified_count, source_run_ids_json, observation_run_ids_json, status, tenant_id,
        created_at, updated_at, last_seen_at
      ) VALUES (
        @pitfall_id, @family, @fingerprint, @tech_stack_json, @symptom, @resolution,
        @verified_count, @source_run_ids_json, @observation_run_ids_json, @status, @tenant_id,
        @created_at, @updated_at, @last_seen_at
      )
    `).run(row);
    return parsePitfallLesson(row);
  });
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
    ORDER BY last_seen_at DESC, pitfall_id ASC
    LIMIT ?
  `).all(...params) as unknown[];
  return rows.map(parsePitfallLesson);
}

/**
 * @deprecated A successful run with a matching technology stack cannot verify
 * a lesson: it may never have loaded or followed it. Keep this compatibility
 * entry point side-effect-free until verification has explicit usage evidence.
 */
export function verifyPitfallLessons(
  _db: Database.Database,
  _dbPath: string,
  _opts: { source_run_id: string; tech_stack: string[]; families?: string[]; limit?: number },
): PitfallLessonView[] {
  return [];
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
  const observationRunIds = [...new Set(parseStringArray(parsed.observation_run_ids_json))];
  return {
    ...parsed,
    tech_stack: parseStringArray(parsed.tech_stack_json),
    source_run_ids: parseStringArray(parsed.source_run_ids_json),
    observation_count: observationRunIds.length,
    observation_run_ids: observationRunIds,
    legacy_verified_count: parsed.verified_count,
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

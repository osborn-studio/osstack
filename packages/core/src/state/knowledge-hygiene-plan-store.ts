import type Database from "better-sqlite3";
import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const planId = z.string().regex(/^khtp_[a-f0-9]{64}$/);
const eventId = z.string().regex(/^khte_[a-f0-9]{64}$/);

export const KnowledgeHygienePlanStateV1Core = z.enum([
  "draft",
  "partially_approved",
  "approved",
  "applying",
  "applied",
  "recovery_required",
  "recovered",
  "stale",
  "cancelled",
]);
export type KnowledgeHygienePlanStateV1Core = z.infer<
  typeof KnowledgeHygienePlanStateV1Core
>;

const transitions: Readonly<
  Partial<Record<KnowledgeHygienePlanStateV1Core, ReadonlySet<KnowledgeHygienePlanStateV1Core>>>
> = {
  draft: new Set(["partially_approved", "approved", "stale", "cancelled"]),
  partially_approved: new Set([
    "partially_approved",
    "approved",
    "stale",
    "cancelled",
  ]),
  approved: new Set(["approved", "applying", "stale", "cancelled"]),
  applying: new Set(["applied", "recovery_required", "stale", "cancelled"]),
  recovery_required: new Set(["recovered"]),
  applied: new Set(["applied", "recovery_required"]),
  recovered: new Set(["recovered"]),
};

export const KnowledgeHygienePlanEventV1Core = z.object({
  schema_version: z.literal("1"),
  event_id: eventId,
  plan_id: planId,
  kind: z.enum(["memory", "narrative", "dependency"]),
  repo_id: z.string().min(1),
  revision: z.number().int().positive(),
  from_state: KnowledgeHygienePlanStateV1Core.nullable(),
  to_state: KnowledgeHygienePlanStateV1Core,
  artifact_path: z.string().min(1),
  artifact_sha256: sha256,
  actor: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  occurred_at: z.string().datetime(),
}).strict().superRefine((event, context) => {
  if (event.from_state === null) {
    if (event.to_state !== "draft") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to_state"],
        message: "the first plan event must create draft state",
      });
    }
    return;
  }
  if (!transitions[event.from_state]?.has(event.to_state)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["to_state"],
      message: "illegal knowledge hygiene plan transition",
    });
  }
});
export type KnowledgeHygienePlanEventV1Core = z.infer<
  typeof KnowledgeHygienePlanEventV1Core
>;

export interface KnowledgeHygienePlanProjectionV1 {
  plan_id: string;
  kind: "memory" | "narrative" | "dependency";
  repo_id: string;
  revision: number;
  state: KnowledgeHygienePlanStateV1Core;
  artifact_path: string;
  artifact_sha256: string;
  last_event_id: string;
  updated_at: number;
}

export class KnowledgeHygienePlanEventConflictErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeHygienePlanEventConflictErrorV1";
  }
}

export function getKnowledgeHygienePlanProjectionV1(
  db: Database.Database,
  planIdValue: string,
): KnowledgeHygienePlanProjectionV1 | undefined {
  return db.prepare(`
    SELECT plan_id, kind, repo_id, revision, state, artifact_path,
           artifact_sha256, last_event_id, updated_at
    FROM knowledge_hygiene_plan_projection
    WHERE plan_id = ?
  `).get(planIdValue) as KnowledgeHygienePlanProjectionV1 | undefined;
}

export function appendKnowledgeHygienePlanEventV1(
  db: Database.Database,
  rawEvent: KnowledgeHygienePlanEventV1Core,
): { inserted: boolean; state: KnowledgeHygienePlanStateV1Core } {
  const event = KnowledgeHygienePlanEventV1Core.parse(rawEvent);
  const eventJson = JSON.stringify(event);
  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT event_json, to_state FROM knowledge_hygiene_plan_events
      WHERE event_id = ?
    `).get(event.event_id) as {
      event_json: string;
      to_state: KnowledgeHygienePlanStateV1Core;
    } | undefined;
    if (existing !== undefined) {
      if (existing.event_json !== eventJson) {
        throw new KnowledgeHygienePlanEventConflictErrorV1(
          `plan event id collision: ${event.event_id}`,
        );
      }
      return { inserted: false, state: existing.to_state };
    }
    const projection = getKnowledgeHygienePlanProjectionV1(db, event.plan_id);
    if (projection === undefined) {
      if (event.from_state !== null) {
        throw new KnowledgeHygienePlanEventConflictErrorV1(
          `plan projection does not exist: ${event.plan_id}`,
        );
      }
    } else {
      if (
        event.from_state !== projection.state
        || event.revision !== projection.revision
        || event.kind !== projection.kind
        || event.repo_id !== projection.repo_id
      ) {
        throw new KnowledgeHygienePlanEventConflictErrorV1(
          `stale plan event for ${event.plan_id}`,
        );
      }
      if (Date.parse(event.occurred_at) < projection.updated_at) {
        throw new KnowledgeHygienePlanEventConflictErrorV1(
          `plan event time precedes current projection: ${event.event_id}`,
        );
      }
    }
    db.prepare(`
      INSERT INTO knowledge_hygiene_plan_events (
        event_id, plan_id, revision, from_state, to_state, event_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.event_id,
      event.plan_id,
      event.revision,
      event.from_state,
      event.to_state,
      eventJson,
      Date.parse(event.occurred_at),
    );
    db.prepare(`
      INSERT INTO knowledge_hygiene_plan_projection (
        plan_id, kind, repo_id, revision, state, artifact_path,
        artifact_sha256, last_event_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plan_id) DO UPDATE SET
        state = excluded.state,
        artifact_path = excluded.artifact_path,
        artifact_sha256 = excluded.artifact_sha256,
        last_event_id = excluded.last_event_id,
        updated_at = excluded.updated_at
    `).run(
      event.plan_id,
      event.kind,
      event.repo_id,
      event.revision,
      event.to_state,
      event.artifact_path,
      event.artifact_sha256,
      event.event_id,
      Date.parse(event.occurred_at),
    );
    return { inserted: true, state: event.to_state };
  }).immediate();
}

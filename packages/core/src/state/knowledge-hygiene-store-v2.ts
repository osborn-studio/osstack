import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const fingerprint = z.string().regex(/^khf_[a-f0-9]{64}$/);
const eventId = z.string().regex(/^khev_[a-f0-9]{64}$/);

export const FindingLifecycleStateV2Core = z.enum([
  "open",
  "mechanically_applied",
  "mechanically_resolved",
  "semantically_resolved",
  "reviewed_no_change",
  "accepted_risk",
  "suppressed",
  "obsolete",
  "closed_absent",
  "resolved_legacy",
]);
export type FindingLifecycleStateV2Core = z.infer<
  typeof FindingLifecycleStateV2Core
>;

const legalTransitions: Readonly<
  Partial<Record<FindingLifecycleStateV2Core, ReadonlySet<FindingLifecycleStateV2Core>>>
> = {
  open: new Set([
    "mechanically_applied",
    "reviewed_no_change",
    "accepted_risk",
    "suppressed",
    "obsolete",
    "closed_absent",
  ]),
  mechanically_applied: new Set([
    "mechanically_resolved",
    "semantically_resolved",
    "accepted_risk",
    "suppressed",
    "obsolete",
  ]),
};

export const KnowledgeHygieneResolutionEventV2Core = z
  .object({
    schema_version: z.literal("2"),
    event_id: eventId,
    repo_id: z.string().min(1),
    fingerprint,
    from_state: FindingLifecycleStateV2Core,
    to_state: FindingLifecycleStateV2Core,
    actor: z
      .object({
        kind: z.enum(["human", "agent", "system"]),
        id: z.string().trim().min(1),
      })
      .strict(),
    reason: z.string().trim().min(1),
    evidence_refs: z.array(z.record(z.unknown())).min(1),
    occurred_at: z.string().datetime(),
    plan_id: z.string().min(1).optional(),
    suppression: z
      .object({
        scope: z.string().trim().min(1),
        expires_at: z.string().datetime().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if (
      event.from_state === "resolved_legacy"
      || event.to_state === "resolved_legacy"
      || !legalTransitions[event.from_state]?.has(event.to_state)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to_state"],
        message: "illegal V2 lifecycle transition",
      });
    }
    if ((event.to_state === "suppressed") !== (event.suppression !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["suppression"],
        message: "suppression metadata is required only for suppressed events",
      });
    }
  });
export type KnowledgeHygieneResolutionEventV2Core = z.infer<
  typeof KnowledgeHygieneResolutionEventV2Core
>;

const storedFindingV2 = z
  .object({
    fingerprint,
    finding: z.record(z.unknown()),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.finding["fingerprint"] !== item.fingerprint) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finding", "fingerprint"],
        message: "finding fingerprint must match its storage key",
      });
    }
  });

export const RecordKnowledgeHygieneRunInputV2 = z
  .object({
    report_sha256: sha256,
    schema_version: z.literal("2"),
    repo_id: z.string().min(1),
    repo_root: z.string().min(1),
    mode: z.enum(["all", "worktree", "range", "base_to_worktree"]),
    diff_id: z.string().regex(/^diff_[a-f0-9]{64}$/).optional(),
    config_sha256: sha256.optional(),
    generated_at: z.number().finite(),
    inventory_complete: z.boolean(),
    coverage: z.array(z.record(z.unknown())).min(1),
    health_claim: z.enum([
      "findings_present",
      "assessed_scope_clean",
      "assessment_incomplete",
    ]),
    summary: z
      .object({
        error: z.number().int().nonnegative(),
        warning: z.number().int().nonnegative(),
        info: z.number().int().nonnegative(),
        suppressed: z.number().int().nonnegative(),
        resolved: z.number().int().nonnegative(),
      })
      .strict(),
    findings: z.array(storedFindingV2),
    resolution_events: z.array(KnowledgeHygieneResolutionEventV2Core),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.findings.map((item) => item.fingerprint)).size !== input.findings.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["findings"],
        message: "findings must have unique fingerprints",
      });
    }
    if (
      new Set(input.resolution_events.map((event) => event.event_id)).size
      !== input.resolution_events.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolution_events"],
        message: "resolution events must have unique event ids",
      });
    }
    if (input.resolution_events.some((event) => event.repo_id !== input.repo_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolution_events"],
        message: "resolution event repo_id must match the report",
      });
    }
  });
export type RecordKnowledgeHygieneRunInputV2 = z.infer<
  typeof RecordKnowledgeHygieneRunInputV2
>;

export interface RecordKnowledgeHygieneRunOptionsV2 {
  recorded_at?: number;
}

export interface RecordKnowledgeHygieneRunResultV2 {
  run_id: string;
  inserted: boolean;
}

export interface KnowledgeHygieneFindingStateRowV2 {
  repo_id: string;
  fingerprint: string;
  current_state: FindingLifecycleStateV2Core;
  last_event_id: string | null;
  updated_at: number;
}

export class KnowledgeHygieneV2ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeHygieneV2ConflictError";
  }
}

function runId(reportSha256: string): string {
  return `khr2_${reportSha256}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function applyResolutionEvent(
  db: Database.Database,
  event: KnowledgeHygieneResolutionEventV2Core,
): { inserted: boolean; current_state: FindingLifecycleStateV2Core } {
  const eventJson = canonicalJson(event);
  const existing = db.prepare(`
    SELECT event_json, to_state
    FROM knowledge_hygiene_resolution_events_v2
    WHERE event_id = ?
  `).get(event.event_id) as { event_json: string; to_state: FindingLifecycleStateV2Core } | undefined;
  if (existing !== undefined) {
    if (existing.event_json !== eventJson) {
      throw new KnowledgeHygieneV2ConflictError(
        `resolution event id collision: ${event.event_id}`,
      );
    }
    return { inserted: false, current_state: existing.to_state };
  }

  const state = getKnowledgeHygieneFindingStateV2(
    db,
    event.repo_id,
    event.fingerprint,
  );
  if (state === undefined) {
    throw new KnowledgeHygieneV2ConflictError(
      `finding state does not exist: ${event.repo_id}/${event.fingerprint}`,
    );
  }
  if (state.current_state !== event.from_state) {
    throw new KnowledgeHygieneV2ConflictError(
      `stale lifecycle event: expected ${state.current_state}, received ${event.from_state}`,
    );
  }
  const occurredAt = Date.parse(event.occurred_at);
  if (occurredAt < state.updated_at) {
    throw new KnowledgeHygieneV2ConflictError(
      `lifecycle event time precedes current projection: ${event.event_id}`,
    );
  }

  db.prepare(`
    INSERT INTO knowledge_hygiene_resolution_events_v2 (
      event_id, repo_id, fingerprint, from_state, to_state, event_json, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.event_id,
    event.repo_id,
    event.fingerprint,
    event.from_state,
    event.to_state,
    eventJson,
    occurredAt,
  );
  db.prepare(`
    UPDATE knowledge_hygiene_finding_state_v2
    SET current_state = ?, last_event_id = ?, updated_at = ?
    WHERE repo_id = ? AND fingerprint = ? AND current_state = ?
  `).run(
    event.to_state,
    event.event_id,
    occurredAt,
    event.repo_id,
    event.fingerprint,
    event.from_state,
  );
  return { inserted: true, current_state: event.to_state };
}

export function appendKnowledgeHygieneResolutionEventV2(
  db: Database.Database,
  rawEvent: KnowledgeHygieneResolutionEventV2Core,
): { inserted: boolean; current_state: FindingLifecycleStateV2Core } {
  const event = KnowledgeHygieneResolutionEventV2Core.parse(rawEvent);
  return db.transaction(() => applyResolutionEvent(db, event)).immediate();
}

export function recordKnowledgeHygieneRunV2(
  db: Database.Database,
  rawInput: RecordKnowledgeHygieneRunInputV2,
  options: RecordKnowledgeHygieneRunOptionsV2 = {},
): RecordKnowledgeHygieneRunResultV2 {
  const input = RecordKnowledgeHygieneRunInputV2.parse(rawInput);
  const id = runId(input.report_sha256);
  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT run_id FROM knowledge_hygiene_runs_v2 WHERE report_sha256 = ?
    `).get(input.report_sha256) as { run_id: string } | undefined;
    if (existing !== undefined) {
      return { run_id: existing.run_id, inserted: false };
    }

    db.prepare(`
      INSERT INTO knowledge_hygiene_runs_v2 (
        run_id, report_sha256, schema_version, repo_id, repo_root, mode,
        diff_id, config_sha256, generated_at, recorded_at, inventory_complete,
        coverage_json, health_claim, error_count, warning_count, info_count,
        suppressed_count, resolved_count
      ) VALUES (
        @run_id, @report_sha256, @schema_version, @repo_id, @repo_root, @mode,
        @diff_id, @config_sha256, @generated_at, @recorded_at, @inventory_complete,
        @coverage_json, @health_claim, @error_count, @warning_count, @info_count,
        @suppressed_count, @resolved_count
      )
    `).run({
      run_id: id,
      report_sha256: input.report_sha256,
      schema_version: input.schema_version,
      repo_id: input.repo_id,
      repo_root: input.repo_root,
      mode: input.mode,
      diff_id: input.diff_id ?? null,
      config_sha256: input.config_sha256 ?? null,
      generated_at: input.generated_at,
      recorded_at: options.recorded_at ?? Date.now(),
      inventory_complete: input.inventory_complete ? 1 : 0,
      coverage_json: canonicalJson(input.coverage),
      health_claim: input.health_claim,
      error_count: input.summary.error,
      warning_count: input.summary.warning,
      info_count: input.summary.info,
      suppressed_count: input.summary.suppressed,
      resolved_count: input.summary.resolved,
    });

    const upsertFinding = db.prepare(`
      INSERT INTO knowledge_hygiene_findings_v2 (
        repo_id, fingerprint, finding_json, first_seen_at, last_seen_at,
        occurrence_count, last_run_id
      ) VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(repo_id, fingerprint) DO UPDATE SET
        finding_json = excluded.finding_json,
        first_seen_at = MIN(knowledge_hygiene_findings_v2.first_seen_at, excluded.first_seen_at),
        last_seen_at = MAX(knowledge_hygiene_findings_v2.last_seen_at, excluded.last_seen_at),
        occurrence_count = knowledge_hygiene_findings_v2.occurrence_count + 1,
        last_run_id = excluded.last_run_id
    `);
    const insertOccurrence = db.prepare(`
      INSERT INTO knowledge_hygiene_occurrences_v2 (
        run_id, repo_id, fingerprint, observed_at
      ) VALUES (?, ?, ?, ?)
    `);
    const initializeState = db.prepare(`
      INSERT OR IGNORE INTO knowledge_hygiene_finding_state_v2 (
        repo_id, fingerprint, current_state, last_event_id, updated_at
      ) VALUES (?, ?, 'open', NULL, ?)
    `);
    for (const item of input.findings) {
      upsertFinding.run(
        input.repo_id,
        item.fingerprint,
        canonicalJson(item.finding),
        input.generated_at,
        input.generated_at,
        id,
      );
      insertOccurrence.run(
        id,
        input.repo_id,
        item.fingerprint,
        input.generated_at,
      );
      initializeState.run(input.repo_id, item.fingerprint, input.generated_at);
    }
    for (const event of input.resolution_events) {
      applyResolutionEvent(db, event);
    }
    return { run_id: id, inserted: true };
  }).immediate();
}

export function getKnowledgeHygieneFindingStateV2(
  db: Database.Database,
  repoId: string,
  findingFingerprint: string,
): KnowledgeHygieneFindingStateRowV2 | undefined {
  return db.prepare(`
    SELECT repo_id, fingerprint, current_state, last_event_id, updated_at
    FROM knowledge_hygiene_finding_state_v2
    WHERE repo_id = ? AND fingerprint = ?
  `).get(repoId, findingFingerprint) as KnowledgeHygieneFindingStateRowV2 | undefined;
}

export function stableKnowledgeHygieneLegacyEventIdV2(
  legacyPrimaryKey: string,
  legacyContent: unknown,
): string {
  const digest = createHash("sha256")
    .update(canonicalJson([legacyPrimaryKey, legacyContent]))
    .digest("hex");
  return `khev_${digest}`;
}

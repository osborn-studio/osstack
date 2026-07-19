import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "./db.js";
import {
  KnowledgeHygieneV2ConflictError,
  appendKnowledgeHygieneResolutionEventV2,
  getKnowledgeHygieneFindingStateV2,
  type KnowledgeHygieneResolutionEventV2Core,
  type RecordKnowledgeHygieneRunInputV2,
  recordKnowledgeHygieneRunV2,
} from "./knowledge-hygiene-store-v2.js";

const sha = "a".repeat(64);
const fingerprint = `khf_${sha}`;

function openDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function runInput(): RecordKnowledgeHygieneRunInputV2 {
  return {
    report_sha256: sha,
    schema_version: "2",
    repo_id: "repo-1",
    repo_root: "/repo",
    mode: "all",
    generated_at: Date.parse("2026-07-18T00:00:00.000Z"),
    inventory_complete: true,
    coverage: [{ dimension: "mechanical", state: "complete" }],
    health_claim: "findings_present",
    summary: { error: 0, warning: 1, info: 0, suppressed: 0, resolved: 0 },
    findings: [{
      fingerprint,
      finding: {
        fingerprint,
        rule_id: "rulebook.managed_context_block",
        severity: "warning",
      },
    }],
    resolution_events: [],
  };
}

function event(
  toState: "mechanically_applied" | "mechanically_resolved",
): KnowledgeHygieneResolutionEventV2Core {
  const fromState = toState === "mechanically_applied"
    ? "open"
    : "mechanically_applied";
  return {
    schema_version: "2",
    event_id: `khev_${toState === "mechanically_applied" ? sha : "b".repeat(64)}`,
    repo_id: "repo-1",
    fingerprint,
    from_state: fromState,
    to_state: toState,
    actor: { kind: "system", id: "system:governance" },
    reason: "Verified transition.",
    evidence_refs: [{ kind: "evidence_pack", ref: "pack", sha256: sha }],
    occurred_at: toState === "mechanically_applied"
      ? "2026-07-18T00:01:00.000Z"
      : "2026-07-18T00:02:00.000Z",
  };
}

describe("knowledge hygiene V2 store", () => {
  it("adds isolated V2 tables without changing the V1 finding constraint", () => {
    const db = openDatabase();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'knowledge_hygiene_%_v2' ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      "knowledge_hygiene_finding_state_v2",
      "knowledge_hygiene_findings_v2",
      "knowledge_hygiene_occurrences_v2",
      "knowledge_hygiene_resolution_events_v2",
      "knowledge_hygiene_runs_v2",
    ]);
    const v1Sql = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_hygiene_findings'",
    ).get() as { sql: string };
    expect(v1Sql.sql).toContain("'active','resolved','closed_absent'");
  });

  it("records reports idempotently and initializes finding state as open", () => {
    const db = openDatabase();
    expect(recordKnowledgeHygieneRunV2(db, runInput(), { recorded_at: 1 }))
      .toMatchObject({ inserted: true });
    expect(recordKnowledgeHygieneRunV2(db, runInput(), { recorded_at: 2 }))
      .toMatchObject({ inserted: false });
    expect(getKnowledgeHygieneFindingStateV2(db, "repo-1", fingerprint))
      .toMatchObject({ current_state: "open", last_event_id: null });
    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM knowledge_hygiene_occurrences_v2",
    ).get() as { count: number }).count).toBe(1);
  });

  it("applies append-only events with optimistic state and time checks", () => {
    const db = openDatabase();
    recordKnowledgeHygieneRunV2(db, runInput());
    expect(appendKnowledgeHygieneResolutionEventV2(db, event("mechanically_applied")))
      .toEqual({ inserted: true, current_state: "mechanically_applied" });
    expect(appendKnowledgeHygieneResolutionEventV2(db, event("mechanically_applied")))
      .toEqual({ inserted: false, current_state: "mechanically_applied" });
    expect(appendKnowledgeHygieneResolutionEventV2(db, event("mechanically_resolved")))
      .toEqual({ inserted: true, current_state: "mechanically_resolved" });
    expect(() => appendKnowledgeHygieneResolutionEventV2(
      db,
      { ...event("mechanically_resolved"), event_id: `khev_${"c".repeat(64)}` },
    )).toThrow(KnowledgeHygieneV2ConflictError);
  });
});

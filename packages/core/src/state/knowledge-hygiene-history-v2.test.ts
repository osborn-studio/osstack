import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "./db.js";
import {
  queryKnowledgeHygieneRecurrenceCandidatesV2,
  queryKnowledgeHygieneTrendV2,
} from "./knowledge-hygiene-history-v2.js";
import {
  recordKnowledgeHygieneRun,
  type RecordKnowledgeHygieneRunInputV1,
} from "./knowledge-hygiene-store.js";
import {
  recordKnowledgeHygieneRunV2,
  type RecordKnowledgeHygieneRunInputV2,
} from "./knowledge-hygiene-store-v2.js";

const digest = (character: string) => character.repeat(64);

function db(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runMigrations(database);
  return database;
}

function v1Run(): RecordKnowledgeHygieneRunInputV1 {
  return {
    report_sha256: digest("1"),
    schema_version: "1",
    repo_id: "repo-1",
    repo_root: "/repo-1",
    mode: "all",
    generated_at: 1000,
    complete: true,
    skipped_files: 0,
    summary: { error: 0, warning: 1, info: 0, suppressed: 0, resolved: 0 },
    findings: [{
      fingerprint: `khf_${digest("a")}`,
      rule_id: "surface.required_missing",
      surface: "documentation",
      severity: "warning",
      confidence: "high",
      location_path: "README.md",
      rationale: "README is missing.",
    }],
    resolved_findings: [],
  };
}

function v2Run(input: {
  repo_id?: string;
  report_character: string;
  finding_character: string;
  generated_at: number;
}): RecordKnowledgeHygieneRunInputV2 {
  const fingerprint = `khf_${digest(input.finding_character)}`;
  return {
    report_sha256: digest(input.report_character),
    schema_version: "2",
    repo_id: input.repo_id ?? "repo-1",
    repo_root: `/${input.repo_id ?? "repo-1"}`,
    mode: "all",
    generated_at: input.generated_at,
    inventory_complete: true,
    assessment_scope: {
      selected_rule_ids: ["rulebook.managed_context_block"],
    },
    coverage: [
      { dimension: "mechanical", state: "complete" },
      { dimension: "narrative", state: "partial" },
    ],
    health_claim: "findings_present",
    summary: { error: 0, warning: 1, info: 0, suppressed: 0, resolved: 0 },
    findings: [{
      fingerprint,
      finding: {
        fingerprint,
        rule_id: "rulebook.managed_context_block",
        surface: "instruction",
        severity: "warning",
        confidence: "high",
        rationale: "Managed context belongs outside durable instructions.",
        origin: "mechanical",
        dimension: "narrative",
      },
    }],
    resolution_events: [],
  };
}

describe("knowledge hygiene unified V2 history", () => {
  it("unions V1 and V2 findings while preserving the latest coverage claim", () => {
    const database = db();
    recordKnowledgeHygieneRun(database, v1Run());
    recordKnowledgeHygieneRunV2(database, v2Run({
      report_character: "2",
      finding_character: "b",
      generated_at: 2000,
    }));

    expect(queryKnowledgeHygieneTrendV2(database, "repo-1", { as_of: 3000 }))
      .toMatchObject({
        schema_version: "2",
        report_count: 2,
        sources: { v1_reports: 1, v2_reports: 1 },
        open: { total: 2, warning: 2 },
        latest_assessment: {
          schema_version: "2",
          health_claim: "findings_present",
          coverage: expect.arrayContaining([
            expect.objectContaining({ dimension: "narrative", state: "partial" }),
          ]),
        },
      });
  });

  it("derives V2 recurrence candidates from V2 occurrences across repositories", () => {
    const database = db();
    for (const repoId of ["repo-a", "repo-b"]) {
      for (let occurrence = 0; occurrence < 3; occurrence += 1) {
        recordKnowledgeHygieneRunV2(database, v2Run({
          repo_id: repoId,
          report_character: String(occurrence + (repoId === "repo-a" ? 3 : 6)),
          finding_character: repoId === "repo-a" ? "c" : "d",
          generated_at: 1000 + occurrence,
        }));
      }
    }

    const candidates = queryKnowledgeHygieneRecurrenceCandidatesV2(database, {
      min_occurrences: 3,
      min_repositories: 2,
    });
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      schema_version: "2",
      occurrence_count: 3,
      repository_count: 2,
      evidence_run_ids: expect.arrayContaining([
        expect.stringMatching(/^khr2_[a-f0-9]{64}$/),
      ]),
    });
  });
});

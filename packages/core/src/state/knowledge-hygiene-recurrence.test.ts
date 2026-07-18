import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDb } from "./db.js";
import {
  queryKnowledgeHygieneRecurrenceCandidates,
} from "./knowledge-hygiene-recurrence.js";
import {
  recordKnowledgeHygieneRun,
  type RecordKnowledgeHygieneRunInputV1,
} from "./knowledge-hygiene-store.js";
import { MIGRATIONS } from "./migrations.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function finding(repoId: string, confidence: "high" | "medium" | "low" = "high") {
  return {
    fingerprint: `khf_${hash(`${repoId}:README.md`)}`,
    rule_id: "contract.review_required",
    surface: "documentation",
    severity: "warning" as const,
    confidence,
    location_path: "README.md",
    rationale: "Review evidence is required.",
  };
}

function run(
  repoId: string,
  sequence: number,
  options: {
    confidence?: "high" | "medium" | "low";
    active?: boolean;
  } = {},
): RecordKnowledgeHygieneRunInputV1 {
  const current = finding(repoId, options.confidence);
  return {
    report_sha256: hash(`${repoId}:${sequence}`),
    schema_version: "1",
    repo_id: repoId,
    repo_root: `/repos/${repoId}`,
    mode: "all",
    generated_at: sequence,
    complete: true,
    skipped_files: 0,
    summary: {
      error: 0,
      warning: options.active === false ? 0 : 1,
      info: 0,
      suppressed: 0,
      resolved: 0,
    },
    findings: options.active === false ? [] : [current],
    resolved_findings: [],
  };
}

describe("knowledge hygiene recurrence policy", () => {
  it("treats pre-confidence history as ineligible during read-only preview", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osstack-neat-recurrence-"));
    const db = new Database(join(directory, "state.db"));
    for (const migration of MIGRATIONS.filter((candidate) => candidate.id <= 9)) {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.id}`);
    }

    expect(queryKnowledgeHygieneRecurrenceCandidates(db, {
      min_occurrences: 2,
      min_repositories: 1,
    })).toEqual([]);
    db.close();
  });

  it("never proposes a one-off or a single-repository recurrence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osstack-neat-recurrence-"));
    const db = openDb({ path: join(directory, "state.db"), minFreeBytes: 0 });
    recordKnowledgeHygieneRun(db, run("repo-a", 1));
    recordKnowledgeHygieneRun(db, run("repo-a", 2));

    expect(queryKnowledgeHygieneRecurrenceCandidates(db, {
      min_occurrences: 2,
      min_repositories: 2,
    })).toEqual([]);
    db.close();
  });

  it("returns evidence-backed candidates only after both thresholds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osstack-neat-recurrence-"));
    const db = openDb({ path: join(directory, "state.db"), minFreeBytes: 0 });
    for (const repoId of ["repo-a", "repo-b"]) {
      recordKnowledgeHygieneRun(db, run(repoId, 1));
      recordKnowledgeHygieneRun(db, run(repoId, 2));
    }

    const candidates = queryKnowledgeHygieneRecurrenceCandidates(db, {
      min_occurrences: 2,
      min_repositories: 2,
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        repo_id: "repo-a",
        rule_id: "contract.review_required",
        occurrence_count: 2,
        repository_count: 2,
        evidence_run_ids: expect.arrayContaining([`khr_${hash("repo-a:1")}`]),
      }),
      expect.objectContaining({
        repo_id: "repo-b",
        rule_id: "contract.review_required",
        occurrence_count: 2,
        repository_count: 2,
      }),
    ]);
    expect(candidates.every((candidate) => candidate.evidence_run_ids.length === 2))
      .toBe(true);
    db.close();
  });

  it("excludes non-high-confidence and no-longer-active findings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osstack-neat-recurrence-"));
    const db = openDb({ path: join(directory, "state.db"), minFreeBytes: 0 });
    for (const repoId of ["repo-low-a", "repo-low-b"]) {
      recordKnowledgeHygieneRun(db, run(repoId, 1, { confidence: "medium" }));
      recordKnowledgeHygieneRun(db, run(repoId, 2, { confidence: "medium" }));
    }
    for (const repoId of ["repo-closed-a", "repo-closed-b"]) {
      recordKnowledgeHygieneRun(db, run(repoId, 1));
      recordKnowledgeHygieneRun(db, run(repoId, 2));
      recordKnowledgeHygieneRun(db, run(repoId, 3, { active: false }));
    }

    expect(queryKnowledgeHygieneRecurrenceCandidates(db, {
      min_occurrences: 2,
      min_repositories: 2,
    })).toEqual([]);
    db.close();
  });

  it("keeps the candidate key stable as more evidence arrives", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osstack-neat-recurrence-"));
    const db = openDb({ path: join(directory, "state.db"), minFreeBytes: 0 });
    recordKnowledgeHygieneRun(db, run("repo-a", 1));
    recordKnowledgeHygieneRun(db, run("repo-a", 2));
    const first = queryKnowledgeHygieneRecurrenceCandidates(db, {
      min_occurrences: 2,
      min_repositories: 1,
    });
    recordKnowledgeHygieneRun(db, run("repo-a", 3));
    const later = queryKnowledgeHygieneRecurrenceCandidates(db, {
      min_occurrences: 2,
      min_repositories: 1,
    });

    expect(later[0]?.candidate_key).toBe(first[0]?.candidate_key);
    expect(later[0]?.occurrence_count).toBe(3);
    db.close();
  });
});

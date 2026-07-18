import Database from "better-sqlite3";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "./db.js";
import {
  getKnowledgeHygieneFinding,
  getKnowledgeHygieneRunByReportSha,
  listKnowledgeHygieneOccurrences,
  queryKnowledgeHygieneTrend,
  recordKnowledgeHygieneRun,
  type RecordKnowledgeHygieneRunInputV1,
} from "./knowledge-hygiene-store.js";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";

const fingerprint = `khf_${"a".repeat(64)}`;
const diffId = `diff_${"b".repeat(64)}`;

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "osstack-neat-db-"));
  return join(directory, "state.db");
}

function input(
  reportSha: string,
  options: {
    findings?: RecordKnowledgeHygieneRunInputV1["findings"];
    resolved?: RecordKnowledgeHygieneRunInputV1["resolved_findings"];
    complete?: boolean;
    generatedAt?: number;
    suppressed?: number;
  } = {},
): RecordKnowledgeHygieneRunInputV1 {
  return {
    report_sha256: reportSha,
    schema_version: "1",
    repo_id: "repo",
    repo_root: "/repo",
    mode: "worktree",
    diff_id: diffId,
    config_sha256: "c".repeat(64),
    generated_at: options.generatedAt ?? 1_000,
    complete: options.complete ?? true,
    skipped_files: options.complete === false ? 1 : 0,
    summary: {
      error: 0,
      warning: options.findings?.length ?? 0,
      info: 0,
      suppressed: options.suppressed ?? 0,
      resolved: options.resolved?.length ?? 0,
    },
    findings: options.findings ?? [],
    resolved_findings: options.resolved ?? [],
  };
}

function finding(
  findingFingerprint = fingerprint,
  findingSeverity: "error" | "warning" | "info" = "warning",
): RecordKnowledgeHygieneRunInputV1["findings"][number] {
  return {
    fingerprint: findingFingerprint,
    rule_id: "contract.review_required",
    surface: "documentation",
    severity: findingSeverity,
    location_path: "README.md",
    rationale: "Review evidence is required.",
  };
}

describe("knowledge hygiene persistence migration", () => {
  it("upgrades a v8 database in place and preserves older data", async () => {
    const path = await databasePath();
    const old = new Database(path);
    for (const migration of MIGRATIONS.filter((candidate) => candidate.id <= 8)) {
      old.exec(migration.sql);
      old.pragma(`user_version = ${migration.id}`);
    }
    old.prepare(
      "INSERT INTO tasks (task_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("task-old", "Preserved", "pending", 1, 1);
    old.close();

    const upgraded = openDb({ path, minFreeBytes: 0 });
    expect(upgraded.pragma("user_version", { simple: true }))
      .toBe(CURRENT_SCHEMA_VERSION);
    expect(upgraded.prepare("SELECT title FROM tasks WHERE task_id = ?")
      .get("task-old")).toEqual({ title: "Preserved" });
    expect(upgraded.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_hygiene_runs'",
    ).get()).toBeTruthy();
    expect(() => runMigrations(upgraded)).not.toThrow();
    upgraded.close();
  });
});

describe("knowledge hygiene store", () => {
  it("round-trips report identity without storing report blobs", async () => {
    const path = await databasePath();
    const db = openDb({ path, minFreeBytes: 0 });
    const reportSha = "d".repeat(64);

    const recorded = recordKnowledgeHygieneRun(
      db,
      input(reportSha, { findings: [finding()] }),
      { recorded_at: 1_100 },
    );

    expect(recorded.inserted).toBe(true);
    expect(getKnowledgeHygieneRunByReportSha(db, reportSha)).toMatchObject({
      run_id: recorded.run_id,
      report_sha256: reportSha,
      warning_count: 1,
      complete: true,
    });
    const columns = db.prepare("PRAGMA table_info(knowledge_hygiene_runs)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("report_json");
    db.close();
  });

  it("deduplicates the same report across connections", async () => {
    const path = await databasePath();
    const first = openDb({ path, minFreeBytes: 0 });
    const second = openDb({ path, minFreeBytes: 0 });
    const payload = input("e".repeat(64), { findings: [finding()] });

    const inserted = recordKnowledgeHygieneRun(first, payload);
    const duplicate = recordKnowledgeHygieneRun(second, payload);

    expect(inserted.inserted).toBe(true);
    expect(duplicate).toEqual({ run_id: inserted.run_id, inserted: false });
    expect(first.prepare("SELECT COUNT(*) AS count FROM knowledge_hygiene_occurrences")
      .get()).toEqual({ count: 1 });
    first.close();
    second.close();
  });

  it("tracks recurrence and emits absence closure only from complete reports", async () => {
    const path = await databasePath();
    const db = openDb({ path, minFreeBytes: 0 });
    recordKnowledgeHygieneRun(
      db,
      input("1".repeat(64), { findings: [finding()], generatedAt: 1_000 }),
    );
    recordKnowledgeHygieneRun(
      db,
      input("2".repeat(64), { findings: [finding()], generatedAt: 2_000 }),
    );
    recordKnowledgeHygieneRun(
      db,
      input("3".repeat(64), { complete: false, generatedAt: 3_000 }),
    );
    expect(getKnowledgeHygieneFinding(db, "repo", fingerprint)).toMatchObject({
      occurrence_count: 2,
      current_state: "active",
      first_seen_at: 1_000,
      last_seen_at: 2_000,
      closed_at: null,
    });

    recordKnowledgeHygieneRun(
      db,
      input("4".repeat(64), { generatedAt: 4_000 }),
    );
    expect(getKnowledgeHygieneFinding(db, "repo", fingerprint)).toMatchObject({
      occurrence_count: 2,
      current_state: "closed_absent",
      closed_at: 4_000,
    });
    expect(listKnowledgeHygieneOccurrences(db, "repo").map((event) => event.state))
      .toEqual(["active", "active", "closed_absent"]);
    db.close();
  });

  it("stores explicit resolutions and closes the aggregate", async () => {
    const path = await databasePath();
    const db = openDb({ path, minFreeBytes: 0 });
    recordKnowledgeHygieneRun(
      db,
      input("5".repeat(64), { findings: [finding()], generatedAt: 1_000 }),
    );
    recordKnowledgeHygieneRun(db, input("6".repeat(64), {
      generatedAt: 2_000,
      resolved: [{
        finding: finding(),
        resolution: {
          diff_id: diffId,
          fingerprint,
          outcome: "reviewed_no_change",
          actor_kind: "human",
          actor_id: "osborn",
          reason: "Reviewed current evidence.",
          evidence_refs: [],
          resolved_at: 1_900,
        },
      }],
    }));

    expect(getKnowledgeHygieneFinding(db, "repo", fingerprint)).toMatchObject({
      occurrence_count: 2,
      current_state: "resolved",
      closed_at: 1_900,
    });
    expect(db.prepare("SELECT outcome, actor_id FROM knowledge_hygiene_resolutions")
      .get()).toEqual({ outcome: "reviewed_no_change", actor_id: "osborn" });
    db.close();
  });

  it("derives score-free trends from occurrence history", async () => {
    const path = await databasePath();
    const db = openDb({ path, minFreeBytes: 0 });
    const day = 86_400_000;
    const absent = `khf_${"d".repeat(64)}`;
    const resolved = `khf_${"e".repeat(64)}`;
    const recurring = `khf_${"f".repeat(64)}`;
    const added = `khf_${"1".repeat(64)}`;
    recordKnowledgeHygieneRun(db, input("7".repeat(64), {
      generatedAt: 10 * day,
      findings: [
        finding(absent),
        finding(resolved, "info"),
        finding(recurring),
      ],
      suppressed: 1,
    }));
    recordKnowledgeHygieneRun(db, input("8".repeat(64), {
      generatedAt: 12 * day,
      findings: [
        finding(absent),
        finding(resolved, "info"),
        finding(recurring),
      ],
    }));
    recordKnowledgeHygieneRun(db, input("9".repeat(64), {
      generatedAt: 14 * day,
      findings: [finding(recurring), finding(added, "error")],
      resolved: [{
        finding: finding(resolved, "info"),
        resolution: {
          diff_id: diffId,
          fingerprint: resolved,
          outcome: "fixed",
          actor_kind: "agent",
          actor_id: "neat-test",
          reason: "Verified by fixture.",
          evidence_refs: [],
          resolved_at: 14 * day,
        },
      }],
      suppressed: 2,
    }));

    const trend = queryKnowledgeHygieneTrend(db, "repo", {
      as_of: 15 * day,
    });

    expect(trend).toEqual({
      schema_version: "1",
      repo_id: "repo",
      as_of: 15 * day,
      report_count: 3,
      open: {
        total: 2,
        error: 1,
        warning: 1,
        info: 0,
        oldest_age_days: 5,
      },
      recurrence: { total: 1, warning: 1 },
      closure: { tracked: 4, closed: 2, rate: 0.5 },
      delta: { new: 1, resolved: 2 },
      suppressed: { latest: 2 },
    });
    expect(trend).not.toHaveProperty("score");
    db.prepare(`
      UPDATE knowledge_hygiene_findings
      SET current_state = 'closed_absent', occurrence_count = 999
      WHERE repo_id = 'repo'
    `).run();
    expect(queryKnowledgeHygieneTrend(db, "repo", { as_of: 15 * day }))
      .toEqual(trend);
    db.close();
  });
});

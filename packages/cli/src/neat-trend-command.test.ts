import {
  openDb,
  recordKnowledgeHygieneRun,
  type RecordKnowledgeHygieneRunInputV1,
} from "@osstack/core";
import { AgentCommandResult } from "@osstack/protocol";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleNeatCommand, renderNeatHelp } from "./neat-command.js";

const fingerprint = `khf_${"a".repeat(64)}`;

function runInput(
  reportSha: string,
  generatedAt: number,
  suppressed: number,
): RecordKnowledgeHygieneRunInputV1 {
  return {
    report_sha256: reportSha,
    schema_version: "1",
    repo_id: "repo-1",
    repo_root: "/repo-1",
    mode: "all",
    generated_at: generatedAt,
    complete: true,
    skipped_files: 0,
    summary: {
      error: 0,
      warning: 1,
      info: 0,
      suppressed,
      resolved: 0,
    },
    findings: [{
      fingerprint,
      rule_id: "contract.review_required",
      surface: "documentation",
      severity: "warning",
      confidence: "high",
      location_path: "AGENTS.md",
      rationale: "Review evidence is required.",
    }],
    resolved_findings: [],
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "osstack-neat-trend-"));
  const dbPath = join(root, "state.db");
  const db = openDb({ path: dbPath, minFreeBytes: 0 });
  const day = 86_400_000;
  recordKnowledgeHygieneRun(db, runInput("1".repeat(64), 10 * day, 1));
  recordKnowledgeHygieneRun(db, runInput("2".repeat(64), 12 * day, 3));
  db.close();
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    dbPath,
    stdout,
    stderr,
    deps: {
      cwd: () => root,
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
      now: () => new Date(13 * day),
    },
  };
}

describe("neat trend", () => {
  it("renders a strict score-free Agent Command result", async () => {
    const command = await fixture();

    expect(await handleNeatCommand([
      "trend",
      "--repo-id",
      "repo-1",
      "--db",
      command.dbPath,
      "--json",
    ], command.deps)).toBe(0);

    const envelope = AgentCommandResult.parse(JSON.parse(command.stdout[0] ?? ""));
    expect(envelope).toEqual({
      protocol_version: "1.0",
      status: "ok",
      result: {
        command: "knowledge_hygiene.trend",
        trend: {
          schema_version: "1",
          repo_id: "repo-1",
          as_of: 13 * 86_400_000,
          report_count: 2,
          open: {
            total: 1,
            error: 0,
            warning: 1,
            info: 0,
            oldest_age_days: 3,
          },
          recurrence: { total: 1, warning: 1 },
          closure: { tracked: 1, closed: 0, rate: 0 },
          delta: { new: 0, resolved: 0 },
          suppressed: { latest: 3 },
        },
      },
    });
    expect(JSON.stringify(envelope)).not.toContain("score");
  });

  it("renders the same trend for humans without mixing suppressed findings", async () => {
    const command = await fixture();

    expect(await handleNeatCommand([
      "trend",
      "--repo-id",
      "repo-1",
      "--db",
      command.dbPath,
    ], command.deps)).toBe(0);

    expect(command.stdout).toEqual([[
      "Knowledge hygiene trend: repo-1",
      "Reports: 2",
      "Open: 1 (0 error, 1 warning, 0 info)",
      "Oldest open: 3 day(s)",
      "Recurring: 1 (1 warning)",
      "Closure: 0/1 (0.0%)",
      "Latest delta: +0 new, 0 resolved",
      "Suppressed (latest, separate): 3",
      "As of: 1970-01-14T00:00:00.000Z",
    ].join("\n")]);
  });

  it("rejects a missing state database without creating it", async () => {
    const command = await fixture();
    const missing = join(command.dbPath, "missing.db");

    expect(await handleNeatCommand([
      "trend",
      "--repo-id",
      "repo-1",
      "--db",
      missing,
    ], command.deps)).toBe(2);
    expect(command.stderr.join("\n")).toContain("state database does not exist");
  });

  it("advertises the trend query in neat help", () => {
    expect(renderNeatHelp()).toContain("osstack neat trend [trend options]");
    expect(renderNeatHelp()).toContain("--repo-id <id>");
  });
});

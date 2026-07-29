import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAutonomyRun,
  freezeProduction,
  openDb,
} from "@osstack/core";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTONOMY_DRAIN_FREE_BYTES,
  AUTONOMY_MIN_WRITE_FREE_BYTES,
  runAutonomyHealth,
  type AutonomyHealthDeps,
} from "./autonomy-health.js";

let directory: string;
let home: string;
let dbPath: string;
let db: Database.Database;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "osstack-autonomy-health-"));
  home = join(directory, "home");
  await mkdir(home, { recursive: true });
  dbPath = join(home, "state.db");
  db = openDb({ path: dbPath });
  await writeFile(join(home, "repos.json"), "[]\n");
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function deps(
  overrides: Partial<AutonomyHealthDeps> = {},
): AutonomyHealthDeps {
  return {
    db,
    db_path: dbPath,
    home,
    socket_path: join(home, "daemon.sock"),
    disk_free_bytes: () => 20 * 1024 ** 3,
    probe_adapters: async () => [
      {
        id: "codex-cli",
        available: true,
        capability_kinds: ["code.write"],
      },
      {
        id: "kimi-code",
        available: true,
        capability_kinds: ["code.review"],
      },
    ],
    probe_github_auth: async () => true,
    probe_github_network: async () => true,
    ...overrides,
  };
}

describe("autonomy operational health", () => {
  it("reports every required check without exposing probe credentials", async () => {
    const report = await runAutonomyHealth(deps());

    expect(report.checks.map((check) => check.id)).toEqual([
      "state_db",
      "daemon_socket",
      "disk_free",
      "repo_registry",
      "repo_locks",
      "kimi_code",
      "builder_agents",
      "github_auth",
      "github_network",
      "deploy_freezes",
      "resumable_runs",
      "proof_failures",
    ]);
    expect(report).toMatchObject({
      ok: true,
      can_run_local: true,
      can_merge: true,
      can_push_deploy: true,
      drain_required: false,
      active_freezes: [],
      external_blockers: [],
    });
    expect(JSON.stringify(report)).not.toContain("token");
    expect(JSON.stringify(report)).not.toContain("credential");
  });

  it("keeps local work available but marks GitHub network as an external blocker", async () => {
    const report = await runAutonomyHealth(deps({
      probe_github_network: async () => false,
    }));

    expect(report.can_run_local).toBe(true);
    expect(report.can_merge).toBe(false);
    expect(report.can_push_deploy).toBe(false);
    expect(report.external_blockers).toContain("github_network");
    expect(report.checks.find(
      (check) => check.id === "github_network",
    )).toMatchObject({
      status: "blocked",
      scope: "external",
      detail: "GitHub network probe failed",
    });
  });

  it("blocks merge when Kimi is unavailable and classifies auth separately", async () => {
    const report = await runAutonomyHealth(deps({
      probe_adapters: async () => [
        {
          id: "codex-cli",
          available: true,
          capability_kinds: ["code.write"],
        },
        {
          id: "kimi-code",
          available: false,
          capability_kinds: ["code.review"],
        },
      ],
      probe_github_auth: async () => false,
    }));

    expect(report.can_run_local).toBe(true);
    expect(report.can_merge).toBe(false);
    expect(report.external_blockers).toEqual(expect.arrayContaining([
      "kimi_code",
      "github_auth",
    ]));
    expect(report.next_actions.join("\n")).toContain(
      "Restore Kimi Code availability before merge",
    );
    expect(report.next_actions.join("\n")).toContain(
      "Refresh GitHub CLI authentication",
    );
  });

  it("stops new writes below five GiB and requests drain below two GiB", async () => {
    const low = await runAutonomyHealth(deps({
      disk_free_bytes: () => AUTONOMY_MIN_WRITE_FREE_BYTES - 1,
    }));
    expect(low.can_run_local).toBe(false);
    expect(low.drain_required).toBe(false);
    expect(low.write_blockers).toContain("disk_free");

    const critical = await runAutonomyHealth(deps({
      disk_free_bytes: () => AUTONOMY_DRAIN_FREE_BYTES - 1,
    }));
    expect(critical.can_run_local).toBe(false);
    expect(critical.drain_required).toBe(true);
    expect(critical.checks.find(
      (check) => check.id === "disk_free",
    )?.detail).toContain("daemon drain required");
  });

  it("surfaces freezes, resumable runs, and corrupt repository locks", async () => {
    createAutonomyRun(db, dbPath, {
      autonomy_run_id: "run-health",
      transition_id: "run-health:queued",
      task_id: "task-health",
      repo_id: "owner/repo",
      workspace_path: "/tmp/repo",
      contract_sha256: "a".repeat(64),
      routing: {},
      budget: {
        max_builder_iterations: 1,
        max_review_rounds: 1,
        max_wall_time_ms: 60_000,
        max_no_progress_rounds: 1,
      },
      attempt: {},
      event: { kind: "queued" },
      occurred_at: 1,
    });
    freezeProduction(db, dbPath, {
      repo_id: "owner/repo",
      reason: "production rollback failed",
      source_run_id: "run-health",
      frozen_at: 2,
    });
    await mkdir(join(home, "locks", "repos"), { recursive: true });
    await writeFile(
      join(home, "locks", "repos", "broken.lock"),
      "not-json\n",
    );

    const report = await runAutonomyHealth(deps());

    expect(report.active_freezes).toEqual([
      expect.objectContaining({
        repo_id: "owner/repo",
        reason: "production rollback failed",
        source_run_id: "run-health",
      }),
    ]);
    expect(report.resumable_runs).toEqual([
      expect.objectContaining({
        autonomy_run_id: "run-health",
        state: "queued",
      }),
    ]);
    expect(report.write_blockers).toContain("repo_locks");
    expect(report.can_run_local).toBe(false);
  });
});

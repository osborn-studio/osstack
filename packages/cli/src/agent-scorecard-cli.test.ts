import { mkdir, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "@osstack/core";
import { main } from "./bin.js";

let tmp: string;
let logs: string[];
let errors: string[];
let oldHome: string | undefined;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-agent-scorecard-cli-"));
  logs = [];
  errors = [];
  oldHome = process.env["OSSTACK_HOME"];
  process.env["OSSTACK_HOME"] = join(tmp, "home");
  await mkdir(process.env["OSSTACK_HOME"], { recursive: true });
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  if (oldHome === undefined) delete process.env["OSSTACK_HOME"];
  else process.env["OSSTACK_HOME"] = oldHome;
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

describe("agent scorecard CLI", () => {
  it("prints all agent scorecards from real run history", async () => {
    seedHistory();

    const exitCode = await main(["agent", "scorecard", "--json"]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      scorecards: [
        expect.objectContaining({
          agent_id: "codex-cli",
          total_runs: 2,
          completed_runs: 1,
          failed_runs: 1,
          recent_failures: 1,
        }),
      ],
    });
  });

  it("prints a single agent scorecard", async () => {
    seedHistory();

    const exitCode = await main(["agent", "scorecard", "codex-cli", "--json"]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      agent_id: "codex-cli",
      best_task_kinds: [expect.objectContaining({ kind: "code.test" })],
      warnings: expect.arrayContaining(["Recent failures detected"]),
    });
  });

  it("renders a human-readable empty state", async () => {
    const exitCode = await main(["agent", "scorecard"]);

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("No agent run history yet.");
    expect(errors).toEqual([]);
  });
});

function seedHistory(): void {
  const dbPath = join(process.env["OSSTACK_HOME"]!, "state.db");
  const db = openDb({ path: dbPath });
  try {
    seedRun(db, { run_id: "r1", task_id: "t1", agent_id: "codex-cli", capability_id: "codex-cli.code.test", outcome: "completed", duration_ms: 1000, started_at: 100 });
    seedRun(db, { run_id: "r2", task_id: "t2", agent_id: "codex-cli", capability_id: "codex-cli.code.test", outcome: "failed", duration_ms: 2000, started_at: Date.now() / 1000 });
  } finally {
    db.close();
  }
}

function seedRun(db: ReturnType<typeof openDb>, row: {
  run_id: string;
  task_id: string;
  agent_id: string;
  capability_id: string;
  outcome: "completed" | "failed" | "cancelled" | "expired";
  duration_ms: number;
  started_at: number;
}): void {
  db.prepare(
    "INSERT INTO tasks(task_id, title, description, status, created_at, updated_at) VALUES (?, ?, '', 'done', ?, ?)",
  ).run(row.task_id, row.task_id, row.started_at, row.started_at);
  db.prepare(`
    INSERT INTO runs(run_id, task_id, session_id, agent_id, capability_id, phase, outcome, started_at, completed_at, duration_ms)
    VALUES (?, ?, ?, ?, ?, 'code', ?, ?, ?, ?)
  `).run(
    row.run_id,
    row.task_id,
    `session-${row.run_id}`,
    row.agent_id,
    row.capability_id,
    row.outcome,
    row.started_at,
    row.started_at + row.duration_ms / 1000,
    row.duration_ms,
  );
}

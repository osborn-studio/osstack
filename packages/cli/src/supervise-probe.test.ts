import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@osstack/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSuperviseCommand } from "./supervise-command.js";

let root: string;
let priorHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "osstack-supervise-probe-"));
  priorHome = process.env["OSSTACK_HOME"];
  process.env["OSSTACK_HOME"] = join(root, "home");
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (priorHome === undefined) delete process.env["OSSTACK_HOME"];
  else process.env["OSSTACK_HOME"] = priorHome;
  await rm(root, { recursive: true, force: true });
});

async function registry(): Promise<string> {
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "README.md"), "# repo\n", "utf8");
  const path = join(root, "repos.json");
  await writeFile(path, JSON.stringify([{
    repo_id: "repo",
    name: "repo",
    path: repo,
    role: "app",
    priority: 50,
    verify_commands: ["true"],
    loop_doc_path: "docs/LOOP.md",
    enabled: true,
  }]), "utf8");
  return path;
}

async function seedReplayableEvents(): Promise<void> {
  const home = process.env["OSSTACK_HOME"]!;
  await mkdir(home, { recursive: true });
  const db = openDb({ path: join(home, "state.db"), minFreeBytes: 0 });
  try {
    db.prepare(`
      INSERT INTO probe_sessions (
        session_id, repo_id, state, revision, snapshot_json,
        created_at_ms, updated_at_ms
      ) VALUES ('probe_report01', 'repo', 'completed', 2, '{}', 1, 2)
    `).run();
    for (const event of [
      {
        event_id: "pe_report01",
        session_id: "probe_report01",
        revision: 1,
        type: "session_started",
        occurred_at_ms: 1,
        payload: {
          metric_facts: {
            task_ref: "task-1",
            item_facts: [{
              item_id: "pi_report001",
              required: true,
              severity: "high",
              impact: 3,
              origin: "static_pack",
            }],
          },
        },
      },
      {
        event_id: "pe_report02",
        session_id: "probe_report01",
        revision: 2,
        type: "answer_recorded",
        item_id: "pi_report001",
        occurred_at_ms: 2,
        payload: {
          metric_facts: {
            answer_effective: true,
            destination_state: "applied",
          },
          resulting_session_state: "completed",
        },
      },
    ]) {
      const stored = {
        schema_version: "1",
        ...event,
        actor: { type: "human", id: "owner" },
        idempotency_key: `report-${event.revision}`,
      };
      db.prepare(`
        INSERT INTO probe_events (
          event_id, session_id, revision, type, idempotency_key,
          event_json, occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.event_id,
        event.session_id,
        event.revision,
        event.type,
        stored.idempotency_key,
        JSON.stringify(stored),
        event.occurred_at_ms,
      );
    }
  } finally {
    db.close();
  }
}

describe("supervise probe outcomes", () => {
  it("omits metrics without sessions and reports event-derived baseline after replay", async () => {
    const registryPath = await registry();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) =>
      logs.push(String(value)),
    );

    expect(await handleSuperviseCommand([
      "report",
      "--registry",
      registryPath,
      "--json",
    ])).toBe(0);
    expect(JSON.parse(logs.join("\n"))).not.toHaveProperty("probe_outcomes");

    await seedReplayableEvents();
    logs.length = 0;
    expect(await handleSuperviseCommand([
      "report",
      "--registry",
      registryPath,
      "--json",
    ])).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      probe_outcomes: {
        baseline_status: "collecting",
        counts: {
          sessions_replayed: 1,
          effective_questions: 1,
          integrated_decisions: 1,
          completed_sessions: 1,
        },
        rates: {
          effective_question_rate: 1,
          decision_integration_rate: 1,
          completion_rate: 1,
        },
      },
    });

    logs.length = 0;
    expect(await handleSuperviseCommand([
      "report",
      "--registry",
      registryPath,
    ])).toBe(0);
    expect(logs.join("\n")).toContain("## Probe outcomes");
    expect(logs.join("\n")).toContain("baseline status: collecting");
  });
});

import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFeedbackAssets, listImprovementProposals, openDb } from "@osstack/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let tmp: string;
let workspace: string;
let logs: string[];
let errors: string[];
let oldHome: string | undefined;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-self-improve-cli-"));
  workspace = join(tmp, "ws");
  await mkdir(join(workspace, "tasks"), { recursive: true });
  logs = [];
  errors = [];
  oldHome = process.env["OSSTACK_HOME"];
  process.env["OSSTACK_HOME"] = join(tmp, "home");
  vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.map(String).join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.map(String).join(" ")); });
});

afterEach(async () => {
  if (oldHome === undefined) delete process.env["OSSTACK_HOME"];
  else process.env["OSSTACK_HOME"] = oldHome;
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

async function queueTask(taskId: string): Promise<void> {
  await writeFile(join(workspace, "tasks", `${taskId}.json`), JSON.stringify({
    task_id: taskId,
    capability: "code.test",
    prompt: "exercise the self-improvement loop",
    priority: 80,
  }));
}

function stateDb() {
  return openDb({ path: join(tmp, "home", "state.db") });
}

describe("loop run --self-improvement", () => {
  it("requires --repo-id", async () => {
    await queueTask("t1");
    const code = await main(["loop", "run", "--workspace", workspace, "--self-improvement",
      "--execute", "node -e \"process.exit(0)\""]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/--self-improvement requires --repo-id/);
  });

  it("rejects combining --self-improvement with --daemon", async () => {
    await queueTask("t1");
    const code = await main(["loop", "run", "--workspace", workspace, "--self-improvement",
      "--repo-id", "demo", "--daemon"]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/local-only/);
  });

  it("records a feedback asset when a task fails", async () => {
    await queueTask("t-fail");
    const code = await main(["loop", "run", "--workspace", workspace,
      "--self-improvement", "--repo-id", "demo",
      "--verify", "node -e \"process.exit(1)\"", "--max-iter", "1", "--json"]);
    // Escalated task => non-zero exit; self-improvement must still have recorded.
    expect(code).toBe(2);

    const db = stateDb();
    try {
      const assets = listFeedbackAssets(db, { repo_id: "demo", limit: 100 });
      expect(assets.length).toBeGreaterThanOrEqual(1);
      expect(assets[0]).toMatchObject({ repo_id: "demo" });
      expect(assets[0]?.source_trace_id).toMatch(/^trace_demo_t-fail_/);
    } finally {
      db.close();
    }
  });

  it("raises a proposal when --propose-improvements is set", async () => {
    await queueTask("t-fail2");
    const code = await main(["loop", "run", "--workspace", workspace,
      "--self-improvement", "--repo-id", "demo", "--propose-improvements",
      "--verify", "node -e \"process.exit(1)\"", "--max-iter", "1", "--json"]);
    expect(code).toBe(2);

    const db = stateDb();
    try {
      const proposals = listImprovementProposals(db, { limit: 100 });
      expect(proposals.length).toBeGreaterThanOrEqual(1);
      expect(proposals[0]).toMatchObject({ repo_id: "demo", status: "draft" });
    } finally {
      db.close();
    }
  });

  it("records only a trace (no assets) when the task passes", async () => {
    await queueTask("t-pass");
    const code = await main(["loop", "run", "--workspace", workspace,
      "--self-improvement", "--repo-id", "demo",
      "--execute", "node -e \"process.exit(0)\"",
      "--verify", "node -e \"process.exit(0)\"", "--json"]);
    expect(code).toBe(0);

    const db = stateDb();
    try {
      expect(listFeedbackAssets(db, { repo_id: "demo", limit: 100 })).toEqual([]);
      expect(listImprovementProposals(db, { limit: 100 })).toEqual([]);
    } finally {
      db.close();
    }

    // The completed task carries a trace id and self-improvement level in the JSON output.
    const parsed = JSON.parse(logs.join("\n")) as { completed_tasks: Array<{ trace_id?: string; self_improvement_level?: number }> };
    expect(parsed.completed_tasks[0]?.trace_id).toMatch(/^trace_demo_t-pass_/);
    expect(parsed.completed_tasks[0]?.self_improvement_level).toBe(1);
  });
});

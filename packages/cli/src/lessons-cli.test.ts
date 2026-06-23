import { rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let tmp: string;
let logs: string[];
let errors: string[];
let oldHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-lessons-cli-"));
  logs = [];
  errors = [];
  oldHome = process.env["OSSTACK_HOME"];
  process.env["OSSTACK_HOME"] = join(tmp, "home");
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

describe("lessons CLI", () => {
  it("learns pitfall lessons from failed loop state and lists them", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));

    const learnCode = await main(["lessons", "learn", "--workspace", tmp, "--json"]);

    expect(learnCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      learned: 2,
      lessons: [
        expect.objectContaining({ family: "verify_failed", source_run_ids: ["cli-lessons-loop"] }),
        expect.objectContaining({ family: "max_iter_escalation", source_run_ids: ["cli-lessons-loop"] }),
      ],
    });

    logs = [];
    const listCode = await main(["lessons", "list", "--json"]);

    expect(listCode).toBe(0);
    const listed = JSON.parse(logs.join("\n")) as { lessons: Array<{ family: string; verified_count: number }> };
    expect(listed.lessons.map((lesson) => lesson.family)).toEqual(
      expect.arrayContaining(["verify_failed", "max_iter_escalation"]),
    );
    expect(listed.lessons.every((lesson) => lesson.verified_count === 1)).toBe(true);
  });

  it("classifies common failure families into distinct pitfall lessons", async () => {
    await writeState(join(tmp, "failure-families-state.json"), {
      loop_id: "failure-family-loop",
      tasks: [
        {
          task_id: "missing-agent-task",
          capability: "code.write",
          outcome: "escalated",
          iterations: 1,
          agent_id: "missing-agent",
          duration_ms: 1000,
          error_summary: "agent adapter not registered: missing-agent",
        },
        {
          task_id: "reviewer-task",
          capability: "code.review",
          outcome: "failed",
          iterations: 1,
          agent_id: "codex-cli",
          duration_ms: 1000,
          verifier_agent_id: "ds-review",
          verify_summary: "Reviewer found 2 blocking issues.",
          verify_issues: [{ severity: "error", message: "reviewer rejected unsafe diff" }],
        },
        {
          task_id: "dependency-task",
          capability: "node.dependency.install",
          outcome: "failed",
          iterations: 1,
          agent_id: "codex-cli",
          duration_ms: 1000,
          verify_summary: "pnpm install failed with missing dependency.",
          verify_issues: [{ severity: "error", message: "Cannot find module '@example/missing'" }],
        },
        {
          task_id: "governance-task",
          capability: "code.security",
          outcome: "failed",
          iterations: 1,
          agent_id: "codex-cli",
          duration_ms: 1000,
          verifier_agent_id: "governance-verifier",
          verify_summary: "governance high severity finding blocking=true",
          verify_issues: [{ severity: "error", message: "governance high severity unsafe eval" }],
        },
        {
          task_id: "merge-task",
          capability: "git.merge",
          outcome: "failed",
          iterations: 1,
          agent_id: "codex-cli",
          duration_ms: 1000,
          error_summary: "automatic merge failed: unmerged paths, both modified src/app.ts",
        },
        {
          task_id: "toolchain-task",
          capability: "node.toolchain",
          outcome: "failed",
          iterations: 1,
          agent_id: "codex-cli",
          duration_ms: 1000,
          verify_summary: "unsupported engine: Node version 18 does not satisfy >=20",
        },
        {
          task_id: "fixture-task",
          capability: "test.fixture",
          outcome: "failed",
          iterations: 1,
          agent_id: "codex-cli",
          duration_ms: 1000,
          verify_summary: "snapshot mismatch: expected fixture output changed",
        },
        {
          task_id: "network-task",
          capability: "ci.network",
          outcome: "failed",
          iterations: 1,
          agent_id: "codex-cli",
          duration_ms: 1000,
          verify_summary: "fetch failed with network timeout ETIMEDOUT",
        },
        {
          task_id: "permission-task",
          capability: "filesystem.write",
          outcome: "failed",
          iterations: 1,
          agent_id: "codex-cli",
          duration_ms: 1000,
          error_summary: "EACCES: permission denied writing artifact",
        },
      ],
    });

    const learnCode = await main(["lessons", "learn", "--workspace", tmp, "--state", "failure-families-state.json", "--json"]);

    expect(learnCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      lessons: Array<{ family: string; symptom: string; resolution: string; source_run_ids: string[] }>;
    };
    expect(result.lessons).toEqual(expect.arrayContaining([
      expect.objectContaining({
        family: "agent_unavailable",
        symptom: expect.stringContaining("agent adapter not registered"),
        resolution: expect.stringContaining("adapter"),
        source_run_ids: ["failure-family-loop"],
      }),
      expect.objectContaining({
        family: "reviewer_checker_failed",
        symptom: expect.stringContaining("Reviewer found 2 blocking issues"),
        resolution: expect.stringContaining("reviewer/checker"),
        source_run_ids: ["failure-family-loop"],
      }),
      expect.objectContaining({
        family: "dependency_install_failure",
        symptom: expect.stringContaining("pnpm install failed"),
        resolution: expect.stringContaining("dependencies"),
        source_run_ids: ["failure-family-loop"],
      }),
      expect.objectContaining({
        family: "governance_high_severity",
        symptom: expect.stringContaining("governance high severity"),
        resolution: expect.stringContaining("governance"),
        source_run_ids: ["failure-family-loop"],
      }),
      expect.objectContaining({
        family: "merge_conflict",
        symptom: expect.stringContaining("automatic merge failed"),
        resolution: expect.stringContaining("merge conflict"),
        source_run_ids: ["failure-family-loop"],
      }),
      expect.objectContaining({
        family: "toolchain_mismatch",
        symptom: expect.stringContaining("unsupported engine"),
        resolution: expect.stringContaining("toolchain"),
        source_run_ids: ["failure-family-loop"],
      }),
      expect.objectContaining({
        family: "test_fixture_drift",
        symptom: expect.stringContaining("snapshot mismatch"),
        resolution: expect.stringContaining("fixture/snapshot"),
        source_run_ids: ["failure-family-loop"],
      }),
      expect.objectContaining({
        family: "network_outage",
        symptom: expect.stringContaining("network timeout"),
        resolution: expect.stringContaining("network"),
        source_run_ids: ["failure-family-loop"],
      }),
      expect.objectContaining({
        family: "filesystem_permission",
        symptom: expect.stringContaining("permission denied"),
        resolution: expect.stringContaining("permissions"),
        source_run_ids: ["failure-family-loop"],
      }),
    ]));
  });

  it("increments verified_count when a later successful loop verifies an existing pitfall", async () => {
    await writeState(join(tmp, "failed-state.json"), {
      loop_id: "failed-loop",
      tasks: [{
        task_id: "failed-task",
        capability: "code.test",
        outcome: "failed",
        iterations: 1,
        agent_id: "codex-cli",
        duration_ms: 1000,
      }],
    });

    const firstLearnCode = await main(["lessons", "learn", "--workspace", tmp, "--state", "failed-state.json", "--json"]);
    expect(firstLearnCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      learned: 1,
      verified: 0,
      lessons: [expect.objectContaining({ family: "verify_failed", verified_count: 1 })],
    });

    logs = [];
    await writeState(join(tmp, "fixed-state.json"), {
      loop_id: "fixed-loop",
      tasks: [{
        task_id: "fixed-task",
        capability: "code.test",
        outcome: "success",
        iterations: 1,
        agent_id: "codex-cli",
        duration_ms: 1000,
      }],
    });

    const verifyCode = await main(["lessons", "learn", "--workspace", tmp, "--state", "fixed-state.json", "--json"]);
    expect(verifyCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      learned: 0,
      verified: 1,
      verified_lessons: [expect.objectContaining({ family: "verify_failed", verified_count: 2 })],
    });

    logs = [];
    const repeatCode = await main(["lessons", "learn", "--workspace", tmp, "--state", "fixed-state.json", "--json"]);
    expect(repeatCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      learned: 0,
      verified: 0,
      verified_lessons: [],
    });

    logs = [];
    const listCode = await main(["lessons", "list", "--json"]);
    expect(listCode).toBe(0);
    const listed = JSON.parse(logs.join("\n")) as { lessons: Array<{ family: string; verified_count: number; source_run_ids: string[] }> };
    expect(listed.lessons).toContainEqual(expect.objectContaining({
      family: "verify_failed",
      verified_count: 2,
      source_run_ids: ["failed-loop", "fixed-loop"],
    }));
  });

  it("reports when no failed or escalated tasks can be learned", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"), {
      loop_id: "clean-loop",
      tasks: [{
        task_id: "clean-task",
        capability: "code.test",
        outcome: "success",
        iterations: 1,
        agent_id: "codex-cli",
        duration_ms: 1000,
      }],
    });

    const exitCode = await main(["lessons", "learn", "--workspace", tmp]);

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("learned=0");
  });

  it("fails when loop state is missing", async () => {
    const exitCode = await main(["lessons", "learn", "--workspace", tmp]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("osstack: no loop state found");
  });
});

async function writeState(
  path: string,
  opts: {
    loop_id?: string;
    tasks?: Array<{
      task_id: string;
      capability: string;
      outcome: "success" | "failed" | "escalated";
      iterations: number;
      agent_id: string;
      duration_ms: number;
      error_summary?: string;
      verifier_agent_id?: string;
      verify_summary?: string;
      verify_issues?: Array<{ severity: "error" | "warning" | "info"; message: string }>;
    }>;
  } = {},
): Promise<void> {
  await writeFile(path, JSON.stringify({
    loop_id: opts.loop_id ?? "cli-lessons-loop",
    started_at: "2026-06-22T02:00:00.000Z",
    updated_at: "2026-06-22T02:05:00.000Z",
    completed_tasks: opts.tasks ?? [
      {
        task_id: "failed-task",
        capability: "code.test",
        outcome: "failed",
        iterations: 1,
        agent_id: "codex-cli",
        duration_ms: 1000,
      },
      {
        task_id: "escalated-task",
        capability: "code.write",
        outcome: "escalated",
        iterations: 3,
        agent_id: "claude-cli",
        duration_ms: 3000,
      },
    ],
    in_progress: [],
    pending: [],
    decisions: [],
  }, null, 2));
}

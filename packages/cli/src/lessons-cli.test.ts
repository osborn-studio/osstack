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

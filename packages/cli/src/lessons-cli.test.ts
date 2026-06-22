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

  it("reports when no failed or escalated tasks can be learned", async () => {
    await writeFile(join(tmp, "LOOP-STATE.json"), JSON.stringify({
      loop_id: "clean-loop",
      started_at: "2026-06-22T02:00:00.000Z",
      updated_at: "2026-06-22T02:05:00.000Z",
      completed_tasks: [{
        task_id: "clean-task",
        capability: "code.test",
        outcome: "success",
        iterations: 1,
        agent_id: "codex-cli",
        duration_ms: 1000,
      }],
      in_progress: [],
      pending: [],
      decisions: [],
    }, null, 2));

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

async function writeState(path: string): Promise<void> {
  await writeFile(path, JSON.stringify({
    loop_id: "cli-lessons-loop",
    started_at: "2026-06-22T02:00:00.000Z",
    updated_at: "2026-06-22T02:05:00.000Z",
    completed_tasks: [
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

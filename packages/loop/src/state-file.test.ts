import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createInitialLoopState,
  readLoopState,
  renderLoopStateMarkdown,
  writeLoopState,
} from "./state-file.js";
import type { LoopState } from "./types.js";

describe("loop state file", () => {
  it("creates a valid empty loop state", () => {
    const state = createInitialLoopState("loop-test", new Date("2026-06-19T00:00:00.000Z"));

    expect(state).toMatchObject({
      loop_id: "loop-test",
      started_at: "2026-06-19T00:00:00.000Z",
      completed_tasks: [],
      pending: [],
      in_progress: [],
      decisions: [],
    });
  });

  it("writes JSON and Markdown representations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "osstack-loop-state-"));
    const jsonPath = join(dir, "LOOP-STATE.json");
    const state: LoopState = {
      loop_id: "loop-test",
      started_at: "2026-06-19T00:00:00.000Z",
      updated_at: "2026-06-19T00:01:00.000Z",
      completed_tasks: [{
        task_id: "task-1",
        outcome: "success",
        iterations: 1,
        agent_id: "codex-cli",
        duration_ms: 1200,
      }],
      pending: [{
        task_id: "task-2",
        capability: "code.review",
        prompt: "Review changed files",
        priority: 80,
        source: "git_diff",
      }],
      in_progress: [],
      decisions: ["Selected codex-cli for a review task."],
      key_metrics: {
        total_cycles: 1,
        avg_duration_ms: 1200,
        success_rate: 1,
        tokens_consumed: 0,
      },
    };

    const paths = await writeLoopState(jsonPath, state);

    await expect(readLoopState(paths.jsonPath)).resolves.toEqual(state);
    await expect(readFile(paths.markdownPath, "utf-8")).resolves.toContain("## Completed");
    await expect(readFile(paths.markdownPath, "utf-8")).resolves.toContain("task-1 - success via codex-cli");
  });

  it("renders empty sections explicitly", () => {
    expect(renderLoopStateMarkdown(createInitialLoopState("loop-test"))).toContain("- None");
  });
});

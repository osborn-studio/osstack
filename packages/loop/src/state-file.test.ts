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
        run_id: "run-1",
        verify_summary: "1 verifier command passed.",
        verify_issue_count: 0,
        execution_commands: [{
          command: "pnpm test",
          exit_code: 0,
          duration_ms: 500,
        }],
        worktree_branch: "osstack/loop/loop-test/task-1",
        worktree_commit: "abc123",
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
      knowledge: {
        mode: "local",
        status: "recorded",
        query: "review changed files",
        packs: [{
          id: "osstack-core/loop-engineering",
          version: "2026.06.22",
          license: "MIT",
          source_kind: "osstack_native",
          quality_score: 92,
        }],
        results: [{
          pack_id: "osstack-core/loop-engineering",
          pack_version: "2026.06.22",
          chunk_id: "chunk-loop-proof",
          title: "Loop proof evidence",
          score: 0.92,
          snippet: "Record knowledge chunks in proof evidence.",
          matched_terms: ["proof"],
          tags: ["proof"],
          source_refs: [],
        }],
      },
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
    const markdown = await readFile(paths.markdownPath, "utf-8");
    expect(markdown).toContain("task-1 - success via codex-cli");
    expect(markdown).toContain("Run: run-1");
    expect(markdown).toContain("Verification: 1 verifier command passed.");
    expect(markdown).toContain("Commands: pnpm test -> 0");
    expect(markdown).toContain("Worktree: osstack/loop/loop-test/task-1, commit abc123");
    expect(markdown).toContain("## Knowledge Trace");
    expect(markdown).toContain("chunk-loop-proof");
    expect(markdown).toContain("matched_terms=proof");
  });

  it("renders empty sections explicitly", () => {
    expect(renderLoopStateMarkdown(createInitialLoopState("loop-test"))).toContain("- None");
  });
});

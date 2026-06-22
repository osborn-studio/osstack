import { describe, expect, it } from "vitest";
import {
  createLoopStateReport,
  createLoopStateScorecard,
  renderLoopStateScorecardHtml,
  renderLoopStateScorecardMarkdown,
} from "./report.js";
import type { LoopState } from "./types.js";

describe("loop state scorecard", () => {
  it("scores what the durable state can prove and marks missing evidence unknown", () => {
    const state: LoopState = {
      loop_id: "scorecard-loop",
      started_at: "2026-06-22T02:00:00.000Z",
      updated_at: "2026-06-22T02:05:00.000Z",
      completed_tasks: [{
        task_id: "task-1",
        capability: "code.test",
        outcome: "success",
        iterations: 1,
        agent_id: "codex-cli",
        duration_ms: 500,
      }],
      in_progress: [],
      pending: [],
      decisions: [],
    };

    const scorecard = createLoopStateScorecard(createLoopStateReport(state));

    expect(scorecard.total_score).toBe(60);
    expect(scorecard.max_score).toBe(100);
    expect(scorecard.items).toContainEqual(expect.objectContaining({
      id: "execution_completed",
      status: "pass",
      earned: 20,
      evidence: ["1 completed task recorded in LOOP-STATE.json."],
    }));
    expect(scorecard.items).toContainEqual(expect.objectContaining({
      id: "reviewer_checker_passed",
      status: "unknown",
      earned: 0,
    }));
    expect(scorecard.items).toContainEqual(expect.objectContaining({
      id: "proof_artifacts_generated",
      status: "unknown",
      earned: 0,
    }));
  });

  it("renders markdown and self-contained html with explicit unknown states", () => {
    const scorecard = createLoopStateScorecard(createLoopStateReport({
      loop_id: "scorecard-render-loop",
      started_at: "2026-06-22T02:00:00.000Z",
      updated_at: "2026-06-22T02:05:00.000Z",
      completed_tasks: [{
        task_id: "task-failed",
        outcome: "failed",
        iterations: 1,
        agent_id: "codex-cli",
        duration_ms: 500,
      }],
      in_progress: [],
      pending: [],
      decisions: [],
    }));

    const markdown = renderLoopStateScorecardMarkdown(scorecard);
    const html = renderLoopStateScorecardHtml(scorecard);

    expect(markdown).toContain("# Osstack Scorecard - scorecard-render-loop");
    expect(markdown).toContain("| verify_gates_passed | fail | 0 / 30 |");
    expect(markdown).toContain("| reviewer_checker_passed | unknown | 0 / 20 |");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("scorecard-render-loop");
    expect(html).toContain("unknown");
  });

  it("renders Chinese markdown and html labels when requested", () => {
    const scorecard = createLoopStateScorecard(createLoopStateReport({
      loop_id: "scorecard-zh-loop",
      started_at: "2026-06-22T00:00:00.000Z",
      updated_at: "2026-06-22T00:01:00.000Z",
      completed_tasks: [],
      in_progress: [],
      pending: [],
      decisions: [],
    }));

    const markdown = renderLoopStateScorecardMarkdown(scorecard, { language: "zh-CN" });
    const html = renderLoopStateScorecardHtml(scorecard, { language: "zh-CN" });

    expect(markdown).toContain("# Osstack 评分卡 - scorecard-zh-loop");
    expect(markdown).toContain("## 摘要");
    expect(markdown).toContain("## 评分项");
    expect(html).toContain("<html lang=\"zh-CN\">");
    expect(html).toContain("<title>Osstack 评分卡 - scorecard-zh-loop</title>");
  });
});

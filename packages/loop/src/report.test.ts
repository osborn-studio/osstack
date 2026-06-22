import { describe, expect, it } from "vitest";
import {
  createLoopStateReport,
  renderLoopStateReportMarkdown,
} from "./report.js";
import type { LoopEvent, LoopState } from "./types.js";

describe("loop state report", () => {
  it("derives L1-L4 conformance without overstating available evidence", () => {
    const cases = [
      {
        name: "L1 state-only tracked run",
        events: [],
        expected: { level: "L1", name: "Tracked" },
      },
      {
        name: "L2 verified run without reviewer identity",
        events: [
          verifyEvent({ reviewer_agent_id: undefined }),
        ],
        expected: { level: "L2", name: "Verified" },
      },
      {
        name: "L3 reviewed run with checker identity",
        events: [
          verifyEvent({ reviewer_agent_id: "local-verifier" }),
        ],
        expected: { level: "L3", name: "Reviewed" },
      },
      {
        name: "L4 audited run with review, policy, worktree, events, and risk evidence",
        events: [
          planEvent(),
          verifyEvent({ reviewer_agent_id: "local-verifier" }),
          worktreeEvent(),
        ],
        expected: { level: "L4", name: "Audited" },
      },
    ] as const;

    for (const testCase of cases) {
      const report = createLoopStateReport(successState(testCase.name), { events: [...testCase.events] });
      expect(report.conformance).toMatchObject(testCase.expected);
    }
  });

  it("does not promote a verified run to L4 without reviewer/checker evidence", () => {
    const report = createLoopStateReport(successState("no-reviewer-l4-guard"), {
      events: [
        planEvent(),
        verifyEvent({ reviewer_agent_id: undefined }),
        worktreeEvent(),
      ],
    });

    expect(report.conformance).toMatchObject({
      level: "L2",
      name: "Verified",
    });
    expect(report.conformance.evidence).not.toContain("reviewer/checker result recorded");
  });

  it("normalizes a LOOP-STATE.json snapshot into report sections", () => {
    const state: LoopState = {
      loop_id: "loop-report-test",
      started_at: "2026-06-22T00:00:00.000Z",
      updated_at: "2026-06-22T00:10:00.000Z",
      completed_tasks: [
        {
          task_id: "task-success",
          capability: "code.test",
          outcome: "success",
          iterations: 1,
          agent_id: "codex-cli",
          duration_ms: 1_200,
        },
        {
          task_id: "task-failed",
          outcome: "failed",
          iterations: 2,
          agent_id: "claude-code",
          duration_ms: 2_500,
        },
      ],
      in_progress: [{
        task_id: "task-active",
        capability: "code.review",
        prompt: "Review the report model",
        priority: 75,
        source: "manual",
      }],
      pending: [{
        task_id: "task-next",
        capability: "docs.write",
        prompt: "Write the next upgrade note",
        priority: 60,
        source: "task_queue",
      }],
      decisions: ["Ship the state-only report as the first evidence slice."],
      key_metrics: {
        total_cycles: 3,
        avg_duration_ms: 1_850,
        success_rate: 0.5,
        tokens_consumed: 0,
      },
    };

    const report = createLoopStateReport(state);

    expect(report.summary).toMatchObject({
      loop_id: "loop-report-test",
      completed_count: 2,
      success_count: 1,
      failed_count: 1,
      escalated_count: 0,
      in_progress_count: 1,
      pending_count: 1,
      success_rate: 0.5,
    });
    expect(report.completed_tasks[0]).toMatchObject({
      task_id: "task-success",
      capability: "code.test",
      outcome: "success",
      agent_id: "codex-cli",
    });
    expect(report.risks).toContain("1 completed task failed.");
    expect(report.next_steps).toContain("Finish or unblock 1 in-progress task.");
    expect(report.next_steps).toContain("Triage 1 pending task.");
    expect(report.conformance.level).toBe("L1");
  });

  it("renders a development-ready markdown report", () => {
    const report = createLoopStateReport({
      loop_id: "loop-render-test",
      started_at: "2026-06-22T00:00:00.000Z",
      updated_at: "2026-06-22T00:05:00.000Z",
      completed_tasks: [{
        task_id: "task-1",
        outcome: "success",
        iterations: 1,
        agent_id: "codex-cli",
        duration_ms: 900,
      }],
      in_progress: [],
      pending: [],
      decisions: ["Keep reports derived from durable state."],
      knowledge: {
        mode: "local",
        status: "recorded",
        query: "proof evidence",
        packs: [{
          id: "osstack-core/proof-and-scorecard",
          version: "2026.06.22",
          license: "MIT",
          source_kind: "osstack_native",
          quality_score: 90,
        }],
        results: [{
          pack_id: "osstack-core/proof-and-scorecard",
          pack_version: "2026.06.22",
          chunk_id: "chunk-proof-trace",
          title: "Proof trace",
          score: 0.9,
          snippet: "Reports should show knowledge pack and chunk usage.",
          tags: ["proof"],
          source_refs: [],
        }],
      },
    });

    const markdown = renderLoopStateReportMarkdown(report);

    expect(markdown).toContain("# Osstack Loop Report - loop-render-test");
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("- Conformance: L1 Tracked");
    expect(markdown).toContain("- Success rate: 100%");
    expect(markdown).toContain("## Completed Tasks");
    expect(markdown).toContain("task-1 | unknown | success | codex-cli | 1 | 900 ms");
    expect(markdown).toContain("## Decisions");
    expect(markdown).toContain("Keep reports derived from durable state.");
    expect(markdown).toContain("## Knowledge Trace");
    expect(markdown).toContain("osstack-core/proof-and-scorecard@2026.06.22");
    expect(markdown).toContain("chunk-proof-trace");
    expect(markdown).toContain("## Risks");
    expect(markdown).toContain("- None");
  });

  it("adds event-rich evidence sections when loop events are provided", () => {
    const report = createLoopStateReport({
      loop_id: "loop-event-rich",
      started_at: "2026-06-22T00:00:00.000Z",
      updated_at: "2026-06-22T00:05:00.000Z",
      completed_tasks: [{
        task_id: "task-event-rich",
        capability: "code.test",
        outcome: "success",
        iterations: 1,
        agent_id: "codex-cli",
        duration_ms: 900,
      }],
      in_progress: [],
      pending: [],
      decisions: [],
    }, {
      events: [
        {
          event_id: "evt-1",
          loop_id: "loop-event-rich",
          type: "loop.plan.done",
          seq: 1,
          created_at: 1782090000000,
          payload: {
            task_id: "task-event-rich",
            agent_id: "codex-cli",
            routing_reason: "matched code.test capability",
          },
        },
        {
          event_id: "evt-2",
          loop_id: "loop-event-rich",
          type: "loop.verify.done",
          seq: 2,
          created_at: 1782090001000,
          payload: {
            task_id: "task-event-rich",
            pass: true,
            score: 1,
            reviewer_agent_id: "local-verifier",
            summary: "Verifier passed.",
          },
        },
        {
          event_id: "evt-3",
          loop_id: "loop-event-rich",
          type: "loop.worktree.merged",
          seq: 3,
          created_at: 1782090002000,
          payload: {
            task_id: "task-event-rich",
            branch: "osstack/loop/test",
            commit: "abc123",
          },
        },
      ],
    });

    expect(report.events_timeline).toContainEqual(expect.objectContaining({
      seq: 1,
      type: "loop.plan.done",
      summary: "task-event-rich routed to codex-cli: matched code.test capability",
    }));
    expect(report.verify_results).toContainEqual(expect.objectContaining({
      task_id: "task-event-rich",
      pass: true,
      reviewer_agent_id: "local-verifier",
    }));
    expect(report.policy_decisions).toContainEqual(expect.objectContaining({
      task_id: "task-event-rich",
      agent_id: "codex-cli",
      auth_mode: "subprocess/login-reuse",
      roles: ["coding", "test-verify", "reviewer", "release/proof"],
      reason: "matched code.test capability",
    }));
    expect(report.worktree_status).toContainEqual(expect.objectContaining({
      task_id: "task-event-rich",
      status: "merged",
      branch: "osstack/loop/test",
    }));
    expect(report.conformance).toMatchObject({
      level: "L4",
      name: "Audited",
    });

    const markdown = renderLoopStateReportMarkdown(report);
    expect(markdown).toContain("- Conformance: L4 Audited");
    expect(markdown).toContain("## Policy Decisions");
    expect(markdown).toContain("task-event-rich | codex-cli | subprocess/login-reuse | coding, test-verify, reviewer, release/proof | matched code.test capability");
    expect(markdown).toContain("## Verify Results");
    expect(markdown).toContain("task-event-rich | pass | 1 | local-verifier | Verifier passed.");
    expect(markdown).toContain("## Worktree Status");
    expect(markdown).toContain("task-event-rich | merged | osstack/loop/test | abc123");
    expect(markdown).toContain("## Events Timeline");
    expect(markdown).toContain("1 | loop.plan.done | task-event-rich routed to codex-cli");
  });
});

function successState(loopId: string): LoopState {
  return {
    loop_id: loopId,
    started_at: "2026-06-22T00:00:00.000Z",
    updated_at: "2026-06-22T00:05:00.000Z",
    completed_tasks: [{
      task_id: "task-conformance",
      capability: "code.test",
      outcome: "success",
      iterations: 1,
      agent_id: "codex-cli",
      duration_ms: 900,
    }],
    in_progress: [],
    pending: [],
    decisions: [],
  };
}

function planEvent(): LoopEvent {
  return {
    event_id: "evt-plan",
    loop_id: "loop-conformance",
    type: "loop.plan.done",
    seq: 1,
    created_at: 1782090000000,
    payload: {
      task_id: "task-conformance",
      agent_id: "codex-cli",
      routing_reason: "matched code.test capability",
    },
  };
}

function verifyEvent(options: { reviewer_agent_id: string | undefined }): LoopEvent {
  return {
    event_id: `evt-verify-${options.reviewer_agent_id ?? "unknown"}`,
    loop_id: "loop-conformance",
    type: "loop.verify.done",
    seq: 2,
    created_at: 1782090001000,
    payload: {
      task_id: "task-conformance",
      pass: true,
      score: 1,
      ...(options.reviewer_agent_id === undefined ? {} : { reviewer_agent_id: options.reviewer_agent_id }),
      summary: "Verifier passed.",
    },
  };
}

function worktreeEvent(): LoopEvent {
  return {
    event_id: "evt-worktree",
    loop_id: "loop-conformance",
    type: "loop.worktree.merged",
    seq: 3,
    created_at: 1782090002000,
    payload: {
      task_id: "task-conformance",
      branch: "osstack/loop/test",
      commit: "abc123",
    },
  };
}

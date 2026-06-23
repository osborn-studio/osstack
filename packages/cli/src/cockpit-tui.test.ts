import { describe, expect, it } from "vitest";
import {
  cockpitTuiModel,
  renderCockpitTui,
  selectCockpitTuiAction,
  type CockpitKnowledgeSummary,
} from "./cockpit-tui.js";

const emptyKnowledge: CockpitKnowledgeSummary = {
  cache_dir: "/tmp/osstack-knowledge",
  pack_count: 0,
  official: 0,
  team: 0,
  project: 0,
  internal: 0,
};

describe("cockpit TUI model", () => {
  it("builds a stable terminal cockpit model from daemon and dashboard snapshots", () => {
    const model = cockpitTuiModel(
      { version: "0.2.0", phase: "ready", active_runs: 1, active_loops: 2 },
      {
        dashboard: { workspace_path: "/workspace/project" },
        overview: {
          total_runs: 3,
          active_runs: 1,
          queued_tasks: 4,
          active_loops: 2,
          progress_percent: 65,
        },
        board: { by_status: { triage: 1, todo: 2, ready: 3, running: 4, blocked: 5, done: 6 } },
        evidence: {
          reports: 7,
          proof_packs: 8,
          latest_report: { path: "reports/latest.md" },
          latest_proof_pack: { path: "proof/latest" },
        },
        quality: { grade: "A", success_rate: 0.9 },
        next_steps: [
          { label: "Loop Engineering", command: "osstack cockpit run --workspace <path> --json", status: "ready" },
          { label: "Missing Command", status: "blocked" },
        ],
      },
      emptyKnowledge,
    );

    expect(model).toMatchObject({
      mode: "terminal-cockpit",
      title: "Osstack Cockpit TUI",
      workspace: "/workspace/project",
      daemon: "0.2.0 phase=ready",
    });
    expect(model.sections.map((section) => section.title)).toEqual([
      "Overview",
      "Kanban",
      "Evidence",
      "Knowledge",
      "Next Actions",
    ]);
    expect(model.actions).toEqual([
      {
        label: "Loop Engineering",
        command: "osstack cockpit run --workspace <path> --json",
        status: "ready",
      },
    ]);
    expect(renderCockpitTui(model)).toContain("[Overview]");
  });

  it("adds a Knowledge action when cached packs exist", () => {
    const model = cockpitTuiModel(
      {},
      { dashboard: { workspace_path: "/workspace/project" }, next_steps: [] },
      {
        ...emptyKnowledge,
        cache_dir: "/tmp/cache",
        pack_count: 1,
        official: 1,
        top_pack: {
          id: "osstack-core/proof-and-scorecard",
          version: "2026.06.22",
          quality_score: 95,
          sources: 1,
        },
      },
    );

    expect(model.sections.find((section) => section.title === "Knowledge")?.lines).toContain(
      "top_pack=osstack-core/proof-and-scorecard@2026.06.22 quality=95 sources=1",
    );
    expect(model.actions).toEqual([
      {
        label: "Knowledge",
        command: "osstack knowledge search \"<query>\" --cache-dir /tmp/cache --json",
        status: "ready",
      },
    ]);
  });

  it("selects actions with concrete shell-quoted workspaces", () => {
    const model = cockpitTuiModel(
      {},
      {
        dashboard: { workspace_path: "/workspace/Gilbert's project" },
        next_steps: [
          { label: "Proof", command: "osstack cockpit proof --workspace <path> --json", status: "ready" },
        ],
      },
      emptyKnowledge,
    );

    expect(selectCockpitTuiAction(model, 1)).toMatchObject({
      mode: "terminal-cockpit-action",
      selected_index: 1,
      next_command: "osstack cockpit proof --workspace '/workspace/Gilbert'\\''s project' --json",
    });
    expect(selectCockpitTuiAction(model, 2)).toBeUndefined();
  });
});

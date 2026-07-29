import { describe, expect, it } from "vitest";
import {
  cockpitTuiKeyFromInput,
  cockpitTuiModel,
  initialCockpitTuiFullscreenState,
  renderCockpitFullscreen,
  renderCockpitTui,
  runCockpitTuiFullscreenKeys,
  selectCockpitTuiAction,
  updateCockpitTuiFullscreenState,
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
      "Autonomy",
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

  it("shows production freeze evidence without offering actor-string clear", () => {
    const model = cockpitTuiModel(
      {},
      {
        dashboard: { workspace_path: "/workspace/project" },
        autonomy: {
          deploy_freezes: [{
            repo_id: "owner/example-web",
            reason: "production health check failed",
            source_run_id: "run-deploy-7",
            frozen_at: 1_753_727_400,
            frozen: true,
          }],
        },
        next_steps: [],
      },
      emptyKnowledge,
    );

    const autonomy = model.sections.find(
      (section) => section.title === "Autonomy",
    );
    expect(autonomy?.lines).toEqual(expect.arrayContaining([
      "production_freezes=1",
      expect.stringContaining(
        "owner/example-web reason=production health check failed source=run-deploy-7",
      ),
    ]));
    expect(model.actions).toEqual(expect.arrayContaining([
      {
        label: "Review production freeze owner/example-web",
        command:
          "osstack autonomy freeze request 'owner/example-web' --json",
        status: "needs_approval",
      },
    ]));
    expect(JSON.stringify(model)).not.toContain("--actor");
    expect(JSON.stringify(model)).not.toContain("freeze clear");
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

  it("renders a full-screen cockpit frame with stable panes and selected actions", () => {
    const model = cockpitTuiModel(
      { version: "0.4.0", phase: "ready" },
      {
        dashboard: { workspace_path: "/workspace/project" },
        overview: { total_runs: 9, active_runs: 1, queued_tasks: 2, active_loops: 1, progress_percent: 72 },
        board: { by_status: { triage: 1, todo: 2, ready: 3, running: 4, blocked: 0, done: 5 } },
        evidence: {
          reports: 2,
          proof_packs: 3,
          latest_report: { path: "reports/latest.md" },
          latest_proof_pack: { path: "release/proof" },
        },
        autonomy: {
          autonomy_run_id: "run-guarded-1",
          state: "awaiting_approval",
          risk: "R3",
          approval_status: "pending",
          candidate_proof: "none",
          pr_url: "none",
          last_transition: "transition-4",
        },
        quality: { grade: "A", success_rate: 0.95 },
        next_steps: [
          { label: "Loop Engineering", command: "osstack cockpit run --workspace <path> --json", status: "ready" },
          { label: "Proof", command: "osstack cockpit proof --workspace <path> --json", status: "ready" },
        ],
      },
      emptyKnowledge,
    );

    const output = renderCockpitFullscreen(model, {
      width: 96,
      height: 34,
      state: { active_section_index: 1, selected_action_index: 2 },
    });

    expect(output).toContain("OSSTACK COCKPIT");
    expect(output).toContain("Workspace: /workspace/project");
    expect(output).toContain("Daemon: 0.4.0 phase=ready");
    expect(output).toContain("> Kanban");
    expect(output).toContain("running=4 blocked=0 done=5");
    expect(output).toContain("autonomy_run_id=run-guarded-1");
    expect(output).toContain("state=awaiting_approval risk=R3");
    expect(output).toContain("approval_status=pending");
    expect(output).toContain("last_transition=transition-4");
    expect(output).toContain("> 2. [ready] Proof");
    expect(output.split("\n").length).toBeLessThanOrEqual(34);
  });

  it("updates full-screen cockpit navigation state from keyboard input", () => {
    const model = cockpitTuiModel(
      {},
      {
        dashboard: { workspace_path: "/workspace/project" },
        next_steps: [
          { label: "Loop", command: "osstack cockpit run --workspace <path> --json", status: "ready" },
          { label: "Proof", command: "osstack cockpit proof --workspace <path> --json", status: "ready" },
        ],
      },
      emptyKnowledge,
    );

    const initial = initialCockpitTuiFullscreenState(model);
    expect(initial).toEqual({ active_section_index: 0, selected_action_index: 1 });

    const movedDown = updateCockpitTuiFullscreenState(model, initial, "down");
    expect(movedDown).toMatchObject({
      type: "state",
      state: { active_section_index: 1, selected_action_index: 2 },
    });
    if (movedDown.type !== "state") {
      throw new Error("expected down key to update fullscreen state");
    }

    expect(updateCockpitTuiFullscreenState(model, movedDown.state, "enter")).toMatchObject({
      type: "select",
      selection: {
        selected_index: 2,
        next_command: "osstack cockpit proof --workspace '/workspace/project' --json",
      },
    });
    expect(updateCockpitTuiFullscreenState(model, movedDown.state, "q")).toEqual({ type: "quit" });
  });

  it("runs deterministic full-screen key sequences for interactive automation", () => {
    const model = cockpitTuiModel(
      {},
      {
        dashboard: { workspace_path: "/workspace/project" },
        next_steps: [
          { label: "Loop", command: "osstack cockpit run --workspace <path> --json", status: "ready" },
          { label: "Proof", command: "osstack cockpit proof --workspace <path> --json", status: "ready" },
        ],
      },
      emptyKnowledge,
    );

    expect(runCockpitTuiFullscreenKeys(model, ["down", "enter"])).toMatchObject({
      type: "select",
      state: { active_section_index: 1, selected_action_index: 2 },
      selection: {
        selected_index: 2,
        next_command: "osstack cockpit proof --workspace '/workspace/project' --json",
      },
    });
    expect(runCockpitTuiFullscreenKeys(model, ["down", "q"])).toEqual({
      type: "quit",
      state: { active_section_index: 1, selected_action_index: 2 },
    });
  });

  it("maps raw terminal input to cockpit TUI keys", () => {
    expect(cockpitTuiKeyFromInput("\u001b[A")).toBe("up");
    expect(cockpitTuiKeyFromInput("\u001b[B")).toBe("down");
    expect(cockpitTuiKeyFromInput("\u001b[C")).toBe("right");
    expect(cockpitTuiKeyFromInput("\u001b[D")).toBe("left");
    expect(cockpitTuiKeyFromInput("\r")).toBe("enter");
    expect(cockpitTuiKeyFromInput("\n")).toBe("enter");
    expect(cockpitTuiKeyFromInput("\u001b")).toBe("escape");
    expect(cockpitTuiKeyFromInput("\u0003")).toBe("q");
    expect(cockpitTuiKeyFromInput("x")).toBe("x");
  });
});

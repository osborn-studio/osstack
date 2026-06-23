import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";
import { startDaemon, type DaemonHandles } from "./daemon.js";

let tmp: string;
let logs: string[];
let errors: string[];
let oldSocket: string | undefined;
let oldHome: string | undefined;
let oldLang: string | undefined;
let oldCockpitTuiInput: string | undefined;
let daemon: DaemonHandles | null;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-dashboard-cli-"));
  logs = [];
  errors = [];
  oldSocket = process.env["OSSTACK_SOCKET"];
  oldHome = process.env["OSSTACK_HOME"];
  oldLang = process.env["OSSTACK_LANG"];
  oldCockpitTuiInput = process.env["OSSTACK_TEST_COCKPIT_TUI_INPUT"];
  process.env["OSSTACK_HOME"] = join(tmp, "home");
  process.env["OSSTACK_SOCKET"] = `/tmp/osstack-dashboard-cli-${randomUUID()}.sock`;
  process.env["OSSTACK_UPDATE_CHECK"] = "0";
  daemon = null;
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map(String).join(" "));
  });
});

async function writeCachedKnowledgePack(cacheDir: string): Promise<void> {
  const packDir = join(cacheDir, "packs", "osstack-core__proof-and-scorecard");
  await mkdir(packDir, { recursive: true });
  await writeFile(join(packDir, "2026.06.22.json"), JSON.stringify({
    id: "osstack-core/proof-and-scorecard",
    version: "2026.06.22",
    name: "Proof and Scorecard",
    license: "Osstack-native",
    source_kind: "osstack_native",
    scope: "official",
    quality_score: 95,
    last_reviewed_at: "2026-06-22T00:00:00.000Z",
    taxonomy: ["osstack-core/proof-and-scorecard"],
    review: {
      status: "approved",
      reviewer_id: "osstack-reviewer",
      reviewed_at: "2026-06-22T00:00:00.000Z",
      summary: "Reviewed for Live Workbench test coverage.",
    },
    chunks: [{
      chunk_id: "proof-checksum-pack",
      title: "Proof checksum pack",
      body: "Live Workbench should surface cached Knowledge Cloud packs and provenance commands.",
      tags: ["proof", "knowledge"],
      source_refs: ["proof-source"],
    }],
    source_provenance: [{
      source_id: "proof-source",
      path: "docs/specs/OSSTACK_RUN_SPEC_V1.md",
      sha256: "sha256-placeholder",
      license: "Osstack-native",
      scope: "official",
      imported_at: "2026-06-22T00:00:00.000Z",
    }],
  }, null, 2));
}

afterEach(async () => {
  if (daemon) await daemon.close();
  if (oldSocket === undefined) delete process.env["OSSTACK_SOCKET"];
  else process.env["OSSTACK_SOCKET"] = oldSocket;
  if (oldHome === undefined) delete process.env["OSSTACK_HOME"];
  else process.env["OSSTACK_HOME"] = oldHome;
  if (oldLang === undefined) delete process.env["OSSTACK_LANG"];
  else process.env["OSSTACK_LANG"] = oldLang;
  if (oldCockpitTuiInput === undefined) delete process.env["OSSTACK_TEST_COCKPIT_TUI_INPUT"];
  else process.env["OSSTACK_TEST_COCKPIT_TUI_INPUT"] = oldCockpitTuiInput;
  delete process.env["OSSTACK_UPDATE_CHECK"];
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

describe("dashboard/cockpit CLI", () => {
  it("shows a product cockpit summary from daemon status and dashboard snapshot", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    await mkdir(join(tmp, "workspace", "reports"), { recursive: true });
    await mkdir(join(tmp, "workspace", "release", "osstack-proof-smoke"), { recursive: true });
    await writeFile(join(tmp, "workspace", "reports", "osstack-report-smoke.md"), "# report\n");
    await writeFile(join(tmp, "workspace", "release", "osstack-proof-smoke", "manifest.json"), "{}\n");

    expect(await main(["kanban", "create", "Ship cockpit", "--assignee", "codex-cli"])).toBe(0);

    logs = [];
    const exitCode = await main(["cockpit", "--workspace", join(tmp, "workspace")]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("Osstack Cockpit");
    expect(output).toContain("daemon=");
    expect(output).toContain("runs total=");
    expect(output).toContain("queued=");
    expect(output).toContain("evidence reports=");
    expect(output).toContain(`latest_report=${join(tmp, "workspace", "reports", "osstack-report-smoke.md")}`);
    expect(output).toContain(`latest_proof=${join(tmp, "workspace", "release", "osstack-proof-smoke")}`);
    expect(output).toContain("kanban:");
    expect(output).toContain("triage: 1");
    expect(output).toContain("recent runs:");
    expect(output).toContain("next steps:");
    expect(output).toContain("[ready] 产品设计 - google-stitch 2.0 primary, claude-design fallback");
  });

  it("prints daemon status and dashboard snapshot JSON with cockpit --json", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    const workspace = join(tmp, "workspace");
    await mkdir(join(workspace, "reports"), { recursive: true });
    await mkdir(join(workspace, "release", "osstack-proof-json"), { recursive: true });
    await writeFile(join(workspace, "reports", "osstack-report-json.md"), "# report\n");
    await writeFile(join(workspace, "release", "osstack-proof-json", "manifest.json"), "{}\n");

    const exitCode = await main(["cockpit", "--workspace", workspace, "--json"]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      daemon: { version: string; active_loops: number };
      cockpit: {
        dashboard: { title: string };
        overview: { queued_tasks: number };
        board: { columns: unknown[] };
        evidence: {
          latest_report: { path: string } | null;
          latest_proof_pack: { path: string; manifest: string | null } | null;
        };
      };
    };
    expect(summary.daemon.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(summary.daemon.active_loops).toBe(0);
    expect(summary.cockpit.dashboard.title).toContain("osstack");
    expect(summary.cockpit.overview.queued_tasks).toBe(0);
    expect(Array.isArray(summary.cockpit.board.columns)).toBe(true);
    expect(summary.cockpit.evidence.latest_report?.path).toBe(join(workspace, "reports", "osstack-report-json.md"));
    expect(summary.cockpit.evidence.latest_proof_pack?.path).toBe(join(workspace, "release", "osstack-proof-json"));
    expect(summary.cockpit.evidence.latest_proof_pack?.manifest).toBe(join(workspace, "release", "osstack-proof-json", "manifest.json"));
  });

  it("prints a workspace-scoped cockpit URL in summary JSON", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    const workspace = join(tmp, "workspace with spaces");
    await mkdir(workspace, { recursive: true });

    const exitCode = await main(["cockpit", "--workspace", workspace, "--json"]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      cockpit: { dashboard: { url: string } };
    };
    expect(new URL(summary.cockpit.dashboard.url).searchParams.get("workspace")).toBe(workspace);
  });

  it("prints a workspace-scoped dashboard URL in snapshot JSON", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    const workspace = join(tmp, "workspace with spaces");
    await mkdir(workspace, { recursive: true });

    const exitCode = await main(["dashboard", "snapshot", "--workspace", workspace]);

    expect(exitCode).toBe(0);
    const snapshot = JSON.parse(logs.join("\n")) as {
      dashboard: { url: string; workspace_path: string };
    };
    expect(snapshot.dashboard.workspace_path).toBe(workspace);
    expect(new URL(snapshot.dashboard.url).searchParams.get("workspace")).toBe(workspace);
  });

  it("prints a workspace-scoped cockpit URL", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    const workspace = join(tmp, "workspace with spaces");
    await mkdir(workspace, { recursive: true });

    const exitCode = await main(["cockpit", "url", "--workspace", workspace]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("/dashboard?workspace=");
    expect(new URL(output).searchParams.get("workspace")).toBe(workspace);
  });

  it("renders a terminal cockpit TUI preview with stable sections", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    const workspace = join(tmp, "workspace");
    await mkdir(join(workspace, "reports"), { recursive: true });
    await mkdir(join(workspace, "release", "osstack-proof-tui"), { recursive: true });
    await writeFile(join(workspace, "reports", "osstack-report-tui.md"), "# report\n");
    await writeFile(join(workspace, "release", "osstack-proof-tui", "manifest.json"), "{}\n");
    expect(await main(["kanban", "create", "Ship TUI", "--assignee", "codex-cli"])).toBe(0);

    logs = [];
    const exitCode = await main(["cockpit", "tui", "--workspace", workspace, "--no-color"]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("+ Osstack Cockpit TUI");
    expect(output).toContain("Workspace:");
    expect(output).toContain("Daemon:");
    expect(output).toContain("Overview");
    expect(output).toContain("Kanban");
    expect(output).toContain("Evidence");
    expect(output).toContain("Knowledge");
    expect(output).toContain("Next Actions");
    expect(output).toContain("reports=1");
    expect(output).toContain("proof_packs=1");
    expect(output).toContain("triage=1");
    expect(output).toContain("osstack cockpit run --workspace <path> --json");
  });

  it("renders a full-screen cockpit TUI frame for workbench use", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    const workspace = join(tmp, "workspace");
    await mkdir(join(workspace, "reports"), { recursive: true });
    await mkdir(join(workspace, "release", "osstack-proof-fullscreen"), { recursive: true });
    await writeFile(join(workspace, "reports", "osstack-report-fullscreen.md"), "# report\n");
    await writeFile(join(workspace, "release", "osstack-proof-fullscreen", "manifest.json"), "{}\n");
    expect(await main(["kanban", "create", "Ship fullscreen TUI", "--assignee", "codex-cli"])).toBe(0);

    logs = [];
    const exitCode = await main(["cockpit", "tui", "--workspace", workspace, "--fullscreen", "--no-color"]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("OSSTACK COCKPIT");
    expect(output).toContain("Workspace:");
    expect(output).toContain("Daemon:");
    expect(output).toContain("> Overview");
    expect(output).toContain("Actions");
    expect(output).toContain("3. [ready] Loop Engineering");
  });

  it("prints terminal cockpit TUI data as JSON", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    const workspace = join(tmp, "workspace");
    await mkdir(workspace, { recursive: true });

    const exitCode = await main(["cockpit", "tui", "--workspace", workspace, "--json"]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      mode: string;
      workspace: string;
      sections: Array<{ title: string; lines: string[] }>;
      actions: Array<{ label: string; command: string; status: string }>;
    };
    expect(summary.mode).toBe("terminal-cockpit");
    expect(summary.workspace).toBe(workspace);
    expect(summary.sections.map((section) => section.title)).toEqual([
      "Overview",
      "Kanban",
      "Evidence",
      "Knowledge",
      "Next Actions",
    ]);
    expect(summary.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "Loop Engineering",
        command: "osstack cockpit run --workspace <path> --json",
        status: "ready",
      }),
    ]));
  });

  it("shows cached Knowledge Cloud packs in the terminal cockpit TUI", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    const workspace = join(tmp, "workspace");
    const cacheDir = join(tmp, "knowledge-cache");
    await mkdir(join(workspace), { recursive: true });
    await writeCachedKnowledgePack(cacheDir);

    const exitCode = await main(["cockpit", "tui", "--workspace", workspace, "--cache-dir", cacheDir, "--json"]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      sections: Array<{ title: string; lines: string[] }>;
      actions: Array<{ label: string; command: string; status: string }>;
    };
    const knowledge = summary.sections.find((section) => section.title === "Knowledge");
    expect(knowledge?.lines).toEqual([
      "cached_packs=1 official=1 team=0 project=0 internal=0",
      "top_pack=osstack-core/proof-and-scorecard@2026.06.22 quality=95 sources=1",
      `provenance=osstack knowledge sources --internal --cache-dir ${cacheDir} --json`,
    ]);
    expect(summary.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "Knowledge",
        command: `osstack knowledge search "<query>" --cache-dir ${cacheDir} --json`,
        status: "ready",
      }),
    ]));
  });

  it("selects a cockpit TUI action as a scriptable interaction", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    const workspace = join(tmp, "workspace");
    await mkdir(workspace, { recursive: true });

    const exitCode = await main(["cockpit", "tui", "--workspace", workspace, "--action", "2", "--json"]);

    expect(exitCode).toBe(0);
    const selection = JSON.parse(logs.join("\n")) as {
      mode: string;
      selected_index: number;
      action: { label: string; command: string; status: string };
      next_command: string;
    };
    expect(selection).toMatchObject({
      mode: "terminal-cockpit-action",
      selected_index: 2,
      action: {
        label: "Coding",
        command: "osstack deliver \"<task>\" --auto-agent --worktree --checkpoint",
        status: "ready",
      },
      next_command: "osstack deliver \"<task>\" --auto-agent --worktree --checkpoint",
    });
  });

  it("renders selected cockpit TUI actions with a concrete shell-quoted workspace", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    const workspace = join(tmp, "Gilbert's workspace");
    await mkdir(workspace, { recursive: true });

    const exitCode = await main(["cockpit", "tui", "--workspace", workspace, "--action", "4", "--json"]);

    expect(exitCode).toBe(0);
    const selection = JSON.parse(logs.join("\n")) as {
      next_command: string;
    };
    expect(selection.next_command).toBe(
      `osstack cockpit proof --workspace '${workspace.replaceAll("'", "'\\''")}' --json`,
    );
  });

  it("rejects executing placeholder cockpit TUI actions", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    const workspace = join(tmp, "workspace");
    await mkdir(workspace, { recursive: true });

    const exitCode = await main(["cockpit", "tui", "--workspace", workspace, "--action", "2", "--execute-action", "--json"]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("cockpit action still contains an input placeholder");
  });

  it("executes a concrete cockpit TUI action as a controlled live workbench step", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    const workspace = join(tmp, "workspace with spaces");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "LOOP-STATE.json"), JSON.stringify({
      loop_id: "cockpit-action-proof-loop",
      started_at: "2026-06-24T01:00:00.000Z",
      updated_at: "2026-06-24T01:05:00.000Z",
      completed_tasks: [{
        task_id: "cockpit-action-proof-task",
        capability: "code.test",
        outcome: "success",
        iterations: 1,
        agent_id: "codex-cli",
        duration_ms: 1000,
      }],
      in_progress: [],
      pending: [],
      decisions: ["Execute proof generation from the cockpit TUI action list."],
    }, null, 2));

    const exitCode = await main(["cockpit", "tui", "--workspace", workspace, "--action", "4", "--execute-action", "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      mode: string;
      argv: string[];
      exit_code: number;
      stdout: string[];
      selection: { selected_index: number; next_command: string };
    };
    expect(result).toMatchObject({
      mode: "terminal-cockpit-action-execution",
      exit_code: 0,
      selection: {
        selected_index: 4,
        next_command: `osstack cockpit proof --workspace '${workspace.replaceAll("'", "'\\''")}' --json`,
      },
      argv: ["osstack", "cockpit", "proof", "--workspace", workspace, "--json"],
    });
    const proofSummary = JSON.parse(result.stdout.join("\n")) as { manifest: string; proof_dir: string };
    expect(proofSummary.manifest).toBe(join(workspace, "release", "osstack-proof-cockpit-action-proof-loop", "manifest.json"));
    await expect(readFile(proofSummary.manifest, "utf-8")).resolves.toContain("\"run_id\": \"cockpit-action-proof-loop\"");
    await expect(readFile(join(proofSummary.proof_dir, "report.md"), "utf-8")).resolves.toContain("Execute proof generation from the cockpit TUI action list.");
  });

  it("rejects unavailable cockpit TUI actions", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });

    const exitCode = await main(["cockpit", "tui", "--action", "99"]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("cockpit tui action must be between 1 and");
  });

  it("selects a cockpit TUI action through interactive input", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    const workspace = join(tmp, "workspace");
    await mkdir(workspace, { recursive: true });
    process.env["OSSTACK_TEST_COCKPIT_TUI_INPUT"] = "2\n";

    const exitCode = await main(["cockpit", "tui", "--workspace", workspace, "--interactive", "--json"]);

    expect(exitCode).toBe(0);
    const selection = JSON.parse(logs.join("\n")) as {
      mode: string;
      selected_index: number;
      action: { label: string; command: string; status: string };
      next_command: string;
    };
    expect(selection).toMatchObject({
      mode: "terminal-cockpit-action",
      selected_index: 2,
      action: {
        label: "Coding",
        command: "osstack deliver \"<task>\" --auto-agent --worktree --checkpoint",
        status: "ready",
      },
    });
  });

  it("selects a full-screen cockpit TUI action through deterministic key input", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    const workspace = join(tmp, "workspace");
    await mkdir(workspace, { recursive: true });
    process.env["OSSTACK_TEST_COCKPIT_TUI_KEYS"] = "down,enter";

    const exitCode = await main(["cockpit", "tui", "--workspace", workspace, "--fullscreen", "--interactive", "--json"]);

    expect(exitCode).toBe(0);
    const selection = JSON.parse(logs.join("\n")) as {
      mode: string;
      selected_index: number;
      next_command: string;
    };
    expect(selection).toMatchObject({
      mode: "terminal-cockpit-action",
      selected_index: 2,
      next_command: "osstack deliver \"<task>\" --auto-agent --worktree --checkpoint",
    });
  });

  it("exits the full-screen cockpit TUI through deterministic key input", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    process.env["OSSTACK_TEST_COCKPIT_TUI_KEYS"] = "q";

    const exitCode = await main(["cockpit", "tui", "--fullscreen", "--interactive", "--json"]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toEqual({
      mode: "terminal-cockpit-interactive",
      status: "quit",
    });
  });

  it("exits the interactive cockpit TUI without selecting an action", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    process.env["OSSTACK_TEST_COCKPIT_TUI_INPUT"] = "q\n";

    const exitCode = await main(["cockpit", "tui", "--interactive", "--json"]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      mode: "terminal-cockpit-interactive",
      status: "quit",
    });
  });

  it("prints actionable cockpit next steps as a standalone command", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });

    const exitCode = await main(["cockpit", "next"]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("next steps:");
    expect(output).toContain("[ready] 产品设计 - google-stitch 2.0 primary, claude-design fallback");
    expect(output).toContain("command: osstack guide --write");
    expect(output).toContain("[ready] Coding - codex-cli primary, claude-code fallback");
    expect(output).toContain("command: osstack deliver \"<task>\" --auto-agent --worktree --checkpoint");
  });

  it("prints cockpit next steps as JSON", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });

    const exitCode = await main(["cockpit", "next", "--json"]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      next_steps: Array<{ label: string; detail: string; status: string; command?: string }>;
    };
    expect(summary.next_steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "产品设计",
        detail: "google-stitch 2.0 primary, claude-design fallback",
        command: "osstack guide --write",
        status: "ready",
      }),
      expect.objectContaining({
        label: "Coding",
        detail: "codex-cli primary, claude-code fallback",
        command: "osstack deliver \"<task>\" --auto-agent --worktree --checkpoint",
        status: "ready",
      }),
    ]));
  });

  it("prints workspace release readiness blockers from cockpit next", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    const workspace = join(tmp, "workspace with spaces");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "release-readiness.md"), [
      "# Osstack Release Readiness",
      "",
      "## Blockers",
      "",
      "- [github_actions_check] Fix GitHub Actions runner allocation before publishing or deploying.",
      "",
      "## Next Steps",
      "",
      "- Open GitHub Actions settings/billing and confirm ubuntu-latest jobs can be assigned a runner.",
    ].join("\n"));

    const exitCode = await main(["cockpit", "next", "--workspace", workspace, "--status", "blocked", "--json"]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      next_steps: Array<{
        label: string;
        detail: string;
        status: string;
        command?: string;
        blockers?: Array<{ id: string; detail: string }>;
      }>;
    };
    expect(summary.next_steps).toEqual([
      expect.objectContaining({
        label: "Release Readiness",
        detail: "1 blocker(s): github_actions_check",
        command: `osstack release doctor --target all --workspace '${workspace}' --output release-readiness.md --json`,
        status: "blocked",
        blockers: [{
          id: "github_actions_check",
          detail: "Fix GitHub Actions runner allocation before publishing or deploying.",
        }],
      }),
    ]);
  });

  it("shell-quotes release readiness commands for workspace paths with apostrophes", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    const workspace = join(tmp, "Gilbert's workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "release-readiness.md"), [
      "# Osstack Release Readiness",
      "",
      "## Blockers",
      "",
      "- [github_actions_check] Fix GitHub Actions runner allocation before publishing or deploying.",
      "",
    ].join("\n"));

    const exitCode = await main(["cockpit", "next", "--workspace", workspace, "--status", "blocked", "--json"]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      next_steps: Array<{ command?: string }>;
    };
    expect(summary.next_steps[0]?.command).toBe(
      `osstack release doctor --target all --workspace '${workspace.replaceAll("'", "'\\''")}' --output release-readiness.md --json`,
    );
  });

  it("prints release readiness blocker details in cockpit next text output", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    const workspace = join(tmp, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "release-readiness.md"), [
      "# Osstack Release Readiness",
      "",
      "## Blockers",
      "",
      "- [github_actions_check] Fix GitHub Actions runner allocation before publishing or deploying.",
      "",
    ].join("\n"));

    const exitCode = await main(["cockpit", "next", "--workspace", workspace, "--status", "blocked"]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("[blocked] Release Readiness - 1 blocker(s): github_actions_check");
    expect(output).toContain("blocker github_actions_check: Fix GitHub Actions runner allocation before publishing or deploying.");
  });

  it("filters cockpit next steps by status in JSON", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });

    const exitCode = await main(["cockpit", "next", "--status", "ready", "--json"]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      next_steps: Array<{ label: string; status: string; command?: string }>;
    };
    expect(summary.next_steps.length).toBeGreaterThan(0);
    expect(summary.next_steps.every((step) => step.status === "ready")).toBe(true);
    expect(summary.next_steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "Coding",
        command: "osstack deliver \"<task>\" --auto-agent --worktree --checkpoint",
        status: "ready",
      }),
    ]));
  });

  it("filters cockpit next steps by status in text output", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });

    const exitCode = await main(["cockpit", "next", "--status", "ready"]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("next steps:");
    expect(output).toContain("[ready] Coding - codex-cli primary, claude-code fallback");
    expect(output).not.toContain("[running]");
    expect(output).not.toContain("[blocked]");
  });

  it("rejects unsupported cockpit next status filters before contacting the daemon", async () => {
    const exitCode = await main(["cockpit", "next", "--status", "done"]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("requires --status ready|running|blocked");
  });

  it("localizes the cockpit summary with OSSTACK_LANG", async () => {
    process.env["OSSTACK_LANG"] = "zh-CN";
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });

    const exitCode = await main(["cockpit"]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("Osstack 驾驶舱");
    expect(output).toContain("任务看板:");
    expect(output).toContain("最近运行:");
    expect(output).toContain("下一步:");
  });

  it("generates a cockpit report from workspace loop evidence", async () => {
    const workspace = join(tmp, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "LOOP-STATE.json"), JSON.stringify({
      loop_id: "cockpit-report-loop",
      started_at: "2026-06-22T01:00:00.000Z",
      updated_at: "2026-06-22T01:05:00.000Z",
      completed_tasks: [{
        task_id: "cockpit-report-task",
        capability: "code.test",
        outcome: "success",
        iterations: 1,
        agent_id: "codex-cli",
        duration_ms: 1000,
      }],
      in_progress: [],
      pending: [],
      decisions: ["Generate reports from the cockpit surface."],
    }, null, 2));

    const exitCode = await main(["cockpit", "report", "--workspace", workspace, "--json"]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      loop_id: string;
      report: string;
      opened: boolean;
    };
    expect(summary).toMatchObject({
      loop_id: "cockpit-report-loop",
      report: join(workspace, "reports", "osstack-report-cockpit-report-loop.md"),
      opened: false,
    });
    await expect(readFile(summary.report, "utf-8")).resolves.toContain("# Osstack Loop Report - cockpit-report-loop");
    await expect(readFile(summary.report, "utf-8")).resolves.toContain("Generate reports from the cockpit surface.");
  });

  it("runs queued work from the cockpit with evidence defaults", async () => {
    const workspace = join(tmp, "workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    await writeFile(join(workspace, "tasks", "task.json"), JSON.stringify({
      task_id: "cockpit-run-task",
      capability: "code.test",
      prompt: "Run queued work from cockpit",
    }, null, 2));

    const exitCode = await main([
      "cockpit",
      "run",
      "--workspace",
      workspace,
      "--execute",
      "node -e \"require('fs').writeFileSync('cockpit-run.txt','ok')\"",
      "--verify",
      "node -e \"process.exit(require('fs').existsSync('cockpit-run.txt') ? 0 : 1)\"",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      loop_id: string;
      completed_tasks: Array<{ task_id: string; outcome: string }>;
      artifacts: {
        report: string;
        scorecard_markdown: string;
        scorecard_html: string;
        proof_dir: string;
        proof_manifest: string;
      };
    };
    expect(summary.completed_tasks).toEqual([
      expect.objectContaining({ task_id: "cockpit-run-task", outcome: "success" }),
    ]);
    expect(summary.artifacts.report).toBe(join(workspace, "reports", `osstack-report-${summary.loop_id}.md`));
    expect(summary.artifacts.scorecard_markdown).toBe(join(workspace, "release", `osstack-scorecard-${summary.loop_id}.md`));
    expect(summary.artifacts.scorecard_html).toBe(join(workspace, "release", `osstack-scorecard-${summary.loop_id}.html`));
    expect(summary.artifacts.proof_dir).toBe(join(workspace, "release", `osstack-proof-${summary.loop_id}`));
    await expect(readFile(summary.artifacts.report, "utf-8")).resolves.toContain(`# Osstack Loop Report - ${summary.loop_id}`);
    await expect(readFile(summary.artifacts.proof_manifest, "utf-8")).resolves.toContain("\"kind\": \"osstack.proof_pack\"");
  });

  it("requeues a failed task from cockpit retry", async () => {
    const workspace = join(tmp, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "LOOP-STATE.json"), JSON.stringify({
      loop_id: "cockpit-retry-loop",
      started_at: "2026-06-22T01:00:00.000Z",
      updated_at: "2026-06-22T01:05:00.000Z",
      completed_tasks: [{
        task_id: "failed-task",
        capability: "code.test",
        outcome: "failed",
        iterations: 2,
        agent_id: "codex-cli",
        duration_ms: 1200,
        verify_summary: "Tests failed.",
        verify_issues: [{ severity: "error", message: "Expected ok" }],
      }],
      in_progress: [],
      pending: [],
      decisions: [],
    }, null, 2));

    const exitCode = await main(["cockpit", "retry", "failed-task", "--workspace", workspace, "--json"]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      loop_id: string;
      retry_of_task_id: string;
      retry_task: { task_id: string; prompt: string; capability: string; priority: number; context: Record<string, unknown> };
      path: string;
    };
    expect(summary).toMatchObject({
      loop_id: "cockpit-retry-loop",
      retry_of_task_id: "failed-task",
      retry_task: {
        task_id: "failed-task-retry",
        capability: "code.test",
        priority: 70,
        context: expect.objectContaining({
          retry_of_task_id: "failed-task",
          retry_from_loop_id: "cockpit-retry-loop",
          previous_outcome: "failed",
          previous_agent_id: "codex-cli",
          previous_verify_summary: "Tests failed.",
        }),
      },
    });
    expect(summary.retry_task.prompt).toContain("Retry failed osstack loop task failed-task.");
    await expect(readFile(summary.path, "utf-8")).resolves.toContain("\"task_id\": \"failed-task-retry\"");
  });

  it("refuses to retry a successful cockpit task", async () => {
    const workspace = join(tmp, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "LOOP-STATE.json"), JSON.stringify({
      loop_id: "cockpit-success-loop",
      started_at: "2026-06-22T01:00:00.000Z",
      updated_at: "2026-06-22T01:05:00.000Z",
      completed_tasks: [{
        task_id: "successful-task",
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

    const exitCode = await main(["cockpit", "retry", "successful-task", "--workspace", workspace]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("retry only accepts failed or escalated tasks");
  });

  it("approves a kanban card from the cockpit", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    expect(await main(["kanban", "create", "Approve cockpit card", "--assignee", "codex-cli"])).toBe(0);
    const created = logs.join("\n").match(/created (card_[a-f0-9]+):/)?.[1];
    expect(created).toBeDefined();

    logs = [];
    const exitCode = await main([
      "cockpit",
      "approve",
      created!,
      "--comment",
      "Reviewed from cockpit.",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      card_id: string;
      status: string;
      approved: boolean;
      commented: boolean;
    };
    expect(summary).toMatchObject({
      card_id: created,
      status: "done",
      approved: true,
      commented: true,
    });

    logs = [];
    expect(await main(["kanban", "board"])).toBe(0);
    expect(logs.join("\n")).toContain("DONE (1)");

    logs = [];
    expect(await main(["kanban", "events", "--since", "0"])).toBe(0);
    const events = JSON.parse(logs.join("\n")) as { events: Array<{ kind: string; card_id: string; payload: string | null }> };
    expect(events.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ card_id: created, kind: "completed" }),
      expect.objectContaining({ card_id: created, kind: "commented" }),
    ]));
  });

  it("generates a cockpit proof pack from workspace loop evidence", async () => {
    const workspace = join(tmp, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "LOOP-STATE.json"), JSON.stringify({
      loop_id: "cockpit-proof-loop",
      started_at: "2026-06-22T01:00:00.000Z",
      updated_at: "2026-06-22T01:05:00.000Z",
      completed_tasks: [{
        task_id: "cockpit-proof-task",
        capability: "code.test",
        outcome: "success",
        iterations: 1,
        agent_id: "codex-cli",
        duration_ms: 1000,
      }],
      in_progress: [],
      pending: [],
      decisions: ["Generate proof packs from the cockpit surface."],
    }, null, 2));

    const exitCode = await main(["cockpit", "proof", "--workspace", workspace, "--json"]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      loop_id: string;
      proof_dir: string;
      proof_zip: string;
      manifest: string;
      artifact_count: number;
      opened: boolean;
    };
    expect(summary).toMatchObject({
      loop_id: "cockpit-proof-loop",
      proof_dir: join(workspace, "release", "osstack-proof-cockpit-proof-loop"),
      proof_zip: join(workspace, "release", "osstack-proof-cockpit-proof-loop.zip"),
      manifest: join(workspace, "release", "osstack-proof-cockpit-proof-loop", "manifest.json"),
      opened: false,
    });
    expect(summary.artifact_count).toBeGreaterThan(0);
    await expect(readFile(summary.manifest, "utf-8")).resolves.toContain("\"run_id\": \"cockpit-proof-loop\"");
    await expect(readFile(join(summary.proof_dir, "report.md"), "utf-8")).resolves.toContain("# Osstack Loop Report - cockpit-proof-loop");
  });
});

import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";
import { startDaemon, type DaemonHandles } from "./daemon.js";

let tmp: string;
let logs: string[];
let errors: string[];
let oldSocket: string | undefined;
let oldHome: string | undefined;
let daemon: DaemonHandles | null;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-cli-loop-"));
  logs = [];
  errors = [];
  oldSocket = process.env["OSSTACK_SOCKET"];
  oldHome = process.env["OSSTACK_HOME"];
  daemon = null;
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  if (daemon) await daemon.close();
  if (oldSocket === undefined) delete process.env["OSSTACK_SOCKET"];
  else process.env["OSSTACK_SOCKET"] = oldSocket;
  if (oldHome === undefined) delete process.env["OSSTACK_HOME"];
  else process.env["OSSTACK_HOME"] = oldHome;
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

describe("loop CLI", () => {
  it("runs a queued task and reads status from --workspace", async () => {
    await mkdir(join(tmp, "tasks"));
    await writeFile(join(tmp, "tasks", "task.json"), JSON.stringify({
      task_id: "cli-loop-task",
      capability: "code.test",
      prompt: "Exercise loop CLI",
    }));

    const exitCode = await main([
      "loop",
      "run",
      "--workspace",
      tmp,
      "--source",
      "task_queue",
      "--execute",
      "node -e \"require('fs').writeFileSync('done.txt', 'ok')\"",
      "--verify",
      "node -e \"process.exit(require('fs').existsSync('done.txt') ? 0 : 1)\"",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      completed_tasks: Array<{ task_id: string; outcome: string }>;
      json_path: string;
      markdown_path: string;
    };
    expect(summary.completed_tasks).toEqual([
      expect.objectContaining({ task_id: "cli-loop-task", outcome: "success" }),
    ]);
    expect(summary.json_path).toBe(join(tmp, "LOOP-STATE.json"));
    expect(summary.markdown_path).toBe(join(tmp, "STATE.md"));
    await expect(readFile(join(tmp, "STATE.md"), "utf-8")).resolves.toContain("cli-loop-task - success");

    logs = [];
    const statusCode = await main(["loop", "status", "--workspace", tmp]);

    expect(statusCode).toBe(0);
    expect(logs.join("\n")).toContain("cli-loop-task - success");
  });

  it("generates report, scorecard, and proof artifacts during loop run", async () => {
    await mkdir(join(tmp, "tasks"));
    await writeFile(join(tmp, "tasks", "task.json"), JSON.stringify({
      task_id: "cli-loop-artifacts-task",
      capability: "code.test",
      prompt: "Exercise loop artifact generation",
    }));
    await writeFile(join(tmp, "unsafe.ts"), "const api_key = \"sk-test-secret-token\";\n");

    const exitCode = await main([
      "loop",
      "run",
      "--workspace",
      tmp,
      "--source",
      "task_queue",
      "--report",
      "--scorecard",
      "--proof",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      loop_id: string;
      artifacts: {
        report?: string;
        scorecard_markdown?: string;
        scorecard_html?: string;
        proof_dir?: string;
        proof_manifest?: string;
      };
    };
    expect(summary.artifacts.report).toBe(join(tmp, "reports", `osstack-report-${summary.loop_id}.md`));
    expect(summary.artifacts.scorecard_markdown).toBe(join(tmp, "release", `osstack-scorecard-${summary.loop_id}.md`));
    expect(summary.artifacts.scorecard_html).toBe(join(tmp, "release", `osstack-scorecard-${summary.loop_id}.html`));
    expect(summary.artifacts.proof_dir).toBe(join(tmp, "release", `osstack-proof-${summary.loop_id}`));
    await expect(readFile(summary.artifacts.report!, "utf-8")).resolves.toContain(`# Osstack Loop Report - ${summary.loop_id}`);
    await expect(readFile(summary.artifacts.report!, "utf-8")).resolves.toContain("## Events Timeline");
    await expect(readFile(summary.artifacts.report!, "utf-8")).resolves.toContain("loop.verify.done");
    await expect(readFile(summary.artifacts.scorecard_markdown!, "utf-8")).resolves.toContain(`# Osstack Scorecard - ${summary.loop_id}`);
    await expect(readFile(summary.artifacts.scorecard_html!, "utf-8")).resolves.toContain("<!doctype html>");
    await expect(readFile(summary.artifacts.proof_manifest!, "utf-8")).resolves.toContain("\"kind\": \"osstack.proof_pack\"");
    await expect(readFile(join(summary.artifacts.proof_dir!, "events.jsonl"), "utf-8")).resolves.toContain("loop.verify.done");
    const governance = JSON.parse(await readFile(join(summary.artifacts.proof_dir!, "governance-results.json"), "utf-8")) as {
      status: string;
      findings: Array<{ rule_id: string; file: string }>;
    };
    expect(governance).toMatchObject({
      status: "fail",
      findings: [expect.objectContaining({ rule_id: "secret.api_key", file: join(tmp, "unsafe.ts") })],
    });
  });

  it("records loop knowledge trace in state, report, and proof artifacts", async () => {
    await mkdir(join(tmp, "tasks"));
    await writeFile(join(tmp, "tasks", "task.json"), JSON.stringify({
      task_id: "cli-loop-knowledge-task",
      capability: "code.test",
      prompt: "Use cloud governance knowledge",
    }));
    const packPath = join(tmp, "knowledge-pack.json");
    await writeFile(packPath, JSON.stringify({
      id: "osstack-cloud-bootstrap",
      version: "2026.06.22",
      name: "Osstack Cloud Bootstrap",
      license: "MIT-derived-processed",
      source_kind: "processed_mit",
      quality_score: 88,
      chunks: [{
        chunk_id: "chunk-cloud-governance",
        title: "Cloud governance trace",
        body: "Osstack Knowledge Cloud records pack ids and chunk ids in report and proof evidence.",
        tags: ["cloud", "governance"],
      }],
    }, null, 2));

    const exitCode = await main([
      "loop",
      "run",
      "--workspace",
      tmp,
      "--source",
      "task_queue",
      "--knowledge",
      "local",
      "--knowledge-pack",
      packPath,
      "--knowledge-query",
      "cloud governance",
      "--report",
      "--proof",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      artifacts: { report: string; proof_dir: string };
    };
    const state = JSON.parse(await readFile(join(tmp, "LOOP-STATE.json"), "utf-8")) as {
      knowledge: { mode: string; status: string; results: Array<{ chunk_id: string }> };
    };
    expect(state.knowledge).toMatchObject({
      mode: "local",
      status: "recorded",
      results: [expect.objectContaining({ chunk_id: "chunk-cloud-governance" })],
    });
    await expect(readFile(summary.artifacts.report, "utf-8")).resolves.toContain("chunk-cloud-governance");
    const proofKnowledge = JSON.parse(
      await readFile(join(summary.artifacts.proof_dir, "knowledge-results.json"), "utf-8"),
    ) as { mode: string; results: Array<{ chunk_id: string }> };
    expect(proofKnowledge).toMatchObject({
      mode: "local",
      results: [expect.objectContaining({ chunk_id: "chunk-cloud-governance" })],
    });
  });

  it("records governance findings without blocking by default", async () => {
    await mkdir(join(tmp, "tasks"));
    await writeFile(join(tmp, "tasks", "task.json"), JSON.stringify({
      task_id: "cli-loop-govern-task",
      capability: "code.test",
      prompt: "Exercise governed loop",
    }));
    await writeFile(join(tmp, "unsafe.ts"), "const api_key = \"sk-test-secret-token\";\n");

    const exitCode = await main([
      "loop",
      "run",
      "--workspace",
      tmp,
      "--source",
      "task_queue",
      "--govern",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      governance: { mode: string; status: string; blocking: boolean; findings: Array<{ rule_id: string }> };
      events: Array<{ type: string; payload?: { reviewer_agent_id?: string; pass?: boolean } }>;
    };
    expect(summary.governance).toMatchObject({
      mode: "warn",
      status: "fail",
      blocking: false,
      findings: [expect.objectContaining({ rule_id: "secret.api_key" })],
    });
    expect(summary.events).toContainEqual(expect.objectContaining({
      type: "loop.verify.done",
      payload: expect.objectContaining({ reviewer_agent_id: "governance-verifier", pass: true }),
    }));
  });

  it("fails strict governed runs on error severity findings and writes proof evidence", async () => {
    await mkdir(join(tmp, "tasks"));
    await writeFile(join(tmp, "tasks", "task.json"), JSON.stringify({
      task_id: "cli-loop-govern-strict-task",
      capability: "code.test",
      prompt: "Exercise strict governed loop",
    }));
    await writeFile(join(tmp, "unsafe.ts"), "const api_key = \"sk-test-secret-token\";\n");

    const exitCode = await main([
      "loop",
      "run",
      "--workspace",
      tmp,
      "--source",
      "task_queue",
      "--govern",
      "strict",
      "--report",
      "--proof",
      "--json",
    ]);

    expect(exitCode).toBe(2);
    const summary = JSON.parse(logs.join("\n")) as {
      artifacts: { report: string; proof_dir: string };
      governance: { mode: string; status: string; blocking: boolean };
      events: Array<{ type: string; payload?: { reviewer_agent_id?: string; pass?: boolean } }>;
    };
    expect(summary.governance).toMatchObject({ mode: "strict", status: "fail", blocking: true });
    expect(summary.events).toContainEqual(expect.objectContaining({
      type: "loop.verify.done",
      payload: expect.objectContaining({ reviewer_agent_id: "governance-verifier", pass: false }),
    }));
    await expect(readFile(summary.artifacts.report, "utf-8")).resolves.toContain("governance-verifier");
    const governance = JSON.parse(
      await readFile(join(summary.artifacts.proof_dir, "governance-results.json"), "utf-8"),
    ) as { status: string; findings: Array<{ rule_id: string; severity: string }> };
    expect(governance).toMatchObject({
      status: "fail",
      findings: [expect.objectContaining({ rule_id: "secret.api_key", severity: "error" })],
    });
  });

  it("rejects an invalid max iteration value", async () => {
    const exitCode = await main(["loop", "run", "--max-iter", "0"]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--max-iter must be a positive integer");
  });

  it("enqueues a task file from positional prompt words", async () => {
    const exitCode = await main([
      "loop",
      "enqueue",
      "Fix",
      "failing",
      "tests",
      "--workspace",
      tmp,
      "--capability",
      "code.test",
      "--priority",
      "80",
      "--context-json",
      "{\"file\":\"packages/cli/src/bin.ts\"}",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      task: { task_id: string; prompt: string; capability: string; priority: number; context: { file: string } };
      path: string;
    };
    expect(result.task).toMatchObject({
      prompt: "Fix failing tests",
      capability: "code.test",
      priority: 80,
      context: { file: "packages/cli/src/bin.ts" },
    });
    expect(result.path).toMatch(/tasks\/task_[a-f0-9]{8}\.json$/);
    await expect(readFile(result.path, "utf-8")).resolves.toContain('"prompt": "Fix failing tests"');
  });

  it("checks local loop readiness with loop doctor --json", async () => {
    await mkdir(join(tmp, "tasks"));
    await writeFile(join(tmp, "tasks", "task.json"), JSON.stringify({
      task_id: "doctor-task",
      capability: "code.test",
      prompt: "Exercise loop doctor",
    }));

    const exitCode = await main(["loop", "doctor", "--workspace", tmp, "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      workspace_path: string;
      checks: Array<{ id: string; status: string; details?: { valid_tasks?: number } }>;
    };
    expect(result.ok).toBe(true);
    expect(result.workspace_path).toBe(tmp);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "workspace",
      status: "ok",
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "task_queue",
      status: "ok",
      details: expect.objectContaining({ valid_tasks: 1 }),
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "state_file",
      status: "warn",
    }));
  });

  it("fails loop doctor when queued task JSON is invalid", async () => {
    await mkdir(join(tmp, "tasks"));
    await writeFile(join(tmp, "tasks", "bad.json"), JSON.stringify({ task_id: "missing-prompt" }));

    const exitCode = await main(["loop", "doctor", "--workspace", tmp, "--json"]);

    expect(exitCode).toBe(1);
    const result = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; details?: { invalid_files?: string[] } }>;
    };
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "task_queue",
      status: "error",
      details: expect.objectContaining({ invalid_files: ["bad.json"] }),
    }));
  });

  it("reports daemon readiness in loop doctor --daemon", async () => {
    process.env["OSSTACK_HOME"] = join(tmp, "home");
    process.env["OSSTACK_SOCKET"] = `/tmp/osstack-cli-loop-${randomUUID()}.sock`;
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"] });

    const exitCode = await main(["loop", "doctor", "--workspace", tmp, "--daemon", "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      daemon_checked: boolean;
      checks: Array<{ id: string; status: string }>;
    };
    expect(result.ok).toBe(true);
    expect(result.daemon_checked).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "daemon",
      status: "ok",
    }));
  });

  it("fails loop doctor --daemon when the daemon is unavailable", async () => {
    process.env["OSSTACK_SOCKET"] = `/tmp/osstack-cli-loop-missing-${randomUUID()}.sock`;

    const exitCode = await main(["loop", "doctor", "--workspace", tmp, "--daemon", "--json"]);

    expect(exitCode).toBe(1);
    const result = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string }>;
    };
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "daemon",
      status: "error",
    }));
  });

  it("passes --archive-completed through local loop runs", async () => {
    const workspace = join(tmp, "archive-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    await writeFile(join(workspace, "tasks", "task.json"), JSON.stringify({
      task_id: "cli-archive-task",
      capability: "code.test",
      prompt: "Exercise archive flag",
    }));

    const exitCode = await main([
      "loop",
      "run",
      "--workspace",
      workspace,
      "--source",
      "task_queue",
      "--archive-completed",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      completed_tasks: Array<{ task_id: string; outcome: string }>;
      events: Array<{ type: string; payload?: { archived?: boolean } }>;
    };
    expect(summary.completed_tasks).toEqual([
      expect.objectContaining({ task_id: "cli-archive-task", outcome: "success" }),
    ]);
    expect(summary.events).toContainEqual(expect.objectContaining({
      type: "loop.queue.archived",
      payload: expect.objectContaining({ archived: true }),
    }));
    await expect(readFile(join(workspace, "tasks", "task.json"), "utf-8")).rejects.toThrow();
    const days = await readdir(join(workspace, "tasks", "archive"));
    expect(days).toHaveLength(1);
  });

  it("passes --worktree through local loop runs", async () => {
    const workspace = join(tmp, "worktree-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    await git(workspace, ["init", "-b", "main"]);
    await writeFile(join(workspace, "app.txt"), "before\n");
    await git(workspace, ["add", "app.txt"]);
    await git(workspace, [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial",
    ]);
    await writeFile(join(workspace, "tasks", "task.json"), JSON.stringify({
      task_id: "cli-worktree-task",
      capability: "code.test",
      prompt: "Exercise CLI worktree flag",
    }));

    const exitCode = await main([
      "loop",
      "run",
      "--workspace",
      workspace,
      "--source",
      "task_queue",
      "--execute",
      "node -e \"require('fs').writeFileSync('app.txt', 'after\\n')\"",
      "--verify",
      "node -e \"process.exit(require('fs').readFileSync('app.txt','utf8') === 'after\\n' ? 0 : 1)\"",
      "--worktree",
      "--worktree-root",
      join(tmp, "worktrees"),
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      events: Array<{ type: string }>;
    };
    expect(result.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "loop.worktree.created",
      "loop.worktree.merged",
      "loop.worktree.cleaned",
    ]));
    await expect(readFile(join(workspace, "app.txt"), "utf-8")).resolves.toBe("after\n");
  });

  it("does not treat an unknown --agent as a successful local no-op", async () => {
    const workspace = join(tmp, "unknown-agent-workspace");
    process.env["OSSTACK_HOME"] = join(tmp, "unknown-agent-home");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    await writeFile(join(workspace, "tasks", "task.json"), JSON.stringify({
      task_id: "cli-unknown-agent-task",
      capability: "code.test",
      prompt: "Exercise unknown agent handling",
    }));

    const exitCode = await main([
      "loop",
      "run",
      "--workspace",
      workspace,
      "--source",
      "task_queue",
      "--agent",
      "missing-loop-agent",
      "--json",
    ]);

    expect(exitCode).toBe(2);
    const result = JSON.parse(logs.join("\n")) as {
      loop_id: string;
      completed_tasks: Array<{ task_id: string; outcome: string; agent_id: string }>;
      learned_lessons?: { learned: number; lessons: Array<{ family: string; source_run_ids: string[] }> };
      events: Array<{ type: string; payload?: { summary?: string } }>;
    };
    expect(result.completed_tasks).toEqual([
      expect.objectContaining({
        task_id: "cli-unknown-agent-task",
        outcome: "escalated",
        agent_id: "missing-loop-agent",
      }),
    ]);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "loop.execute.done",
      payload: expect.objectContaining({
        summary: "agent adapter not registered: missing-loop-agent",
      }),
    }));
    expect(result.learned_lessons).toMatchObject({
      learned: 1,
      lessons: [expect.objectContaining({
        family: "max_iter_escalation",
        source_run_ids: [result.loop_id],
      })],
    });

    logs = [];
    const listCode = await main(["lessons", "list", "--json"]);

    expect(listCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      lessons: [expect.objectContaining({ family: "max_iter_escalation" })],
    });
  });

  it("runs ds-review as a post-execution reviewer verifier", async () => {
    const workspace = join(tmp, "reviewer-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    await git(workspace, ["init", "-b", "main"]);
    await writeFile(join(workspace, "app.txt"), "before\n");
    await git(workspace, ["add", "app.txt"]);
    await git(workspace, [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial",
    ]);
    await writeFile(join(workspace, "tasks", "review.json"), JSON.stringify({
      task_id: "cli-reviewer-task",
      capability: "code.test",
      prompt: "Exercise CLI reviewer adapter",
    }));

    const fakeReview = join(workspace, "ds-review");
    await writeFile(fakeReview, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--help" ]; then echo help; exit 0; fi
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
input="$(cat)"
mkdir -p "$(dirname "$out")"
printf 'reviewed:\\n%s\\n' "$input" > "$out"
echo review ok
`, "utf-8");
    await chmod(fakeReview, 0o755);

    const previous = process.env["OSSTACK_DS_REVIEW_BIN"];
    process.env["OSSTACK_DS_REVIEW_BIN"] = fakeReview;
    try {
      const exitCode = await main([
        "loop",
        "run",
        "--workspace",
        workspace,
        "--source",
        "task_queue",
        "--execute",
        "node -e \"require('fs').writeFileSync('app.txt', 'after reviewer\\n')\"",
        "--reviewer",
        "ds-review",
        "--json",
      ]);

      expect(exitCode).toBe(0);
      const result = JSON.parse(logs.join("\n")) as {
        completed_tasks: Array<{ task_id: string; outcome: string }>;
        events: Array<{ type: string; payload?: { reviewer_agent_id?: string } }>;
      };
      expect(result.completed_tasks).toEqual([
        expect.objectContaining({ task_id: "cli-reviewer-task", outcome: "success" }),
      ]);
      expect(result.events).toContainEqual(expect.objectContaining({
        type: "loop.verify.done",
        payload: expect.objectContaining({ reviewer_agent_id: "ds-review" }),
      }));
      await expect(readFile(join(workspace, "reviews", "ds-review", "latest.md"), "utf-8"))
        .resolves.toContain("+after reviewer");
    } finally {
      if (previous === undefined) delete process.env["OSSTACK_DS_REVIEW_BIN"];
      else process.env["OSSTACK_DS_REVIEW_BIN"] = previous;
    }
  });

  it("can run and inspect a loop through the daemon", async () => {
    process.env["OSSTACK_HOME"] = join(tmp, "home");
    process.env["OSSTACK_SOCKET"] = `/tmp/osstack-cli-loop-${randomUUID()}.sock`;
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"] });
    const workspace = join(tmp, "daemon-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    await writeFile(join(workspace, "tasks", "task.json"), JSON.stringify({
      task_id: "cli-daemon-loop-task",
      capability: "code.test",
      prompt: "Exercise daemon-backed loop CLI",
    }));

    const exitCode = await main([
      "loop",
      "run",
      "--daemon",
      "--workspace",
      workspace,
      "--source",
      "task_queue",
      "--execute",
      "node -e \"require('fs').writeFileSync('daemon-cli-done.txt', 'ok')\"",
      "--verify",
      "node -e \"process.exit(require('fs').existsSync('daemon-cli-done.txt') ? 0 : 1)\"",
    ]);

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("cli-daemon-loop-task: success");

    logs = [];
    const statusCode = await main(["loop", "status", "--daemon", "--workspace", workspace]);

    expect(statusCode).toBe(0);
    expect(logs.join("\n")).toContain("cli-daemon-loop-task - success");
  });

  it("supports finite multi-cycle loop runs", async () => {
    const workspace = join(tmp, "cycles-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    setTimeout(() => {
      void writeFile(join(workspace, "tasks", "late.json"), JSON.stringify({
        task_id: "cli-cycle-task",
        capability: "code.test",
        prompt: "Exercise CLI cycles",
      }));
    }, 5);

    const exitCode = await main([
      "loop",
      "run",
      "--workspace",
      workspace,
      "--source",
      "task_queue",
      "--execute",
      "node -e \"require('fs').writeFileSync('cycle-done.txt', 'ok')\"",
      "--cycles",
      "2",
      "--interval-ms",
      "25",
    ]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("cycles=2");
    expect(output).toContain("cycle 1: discovered=0 executed=0 skipped=0");
    expect(output).toContain("cycle 2: discovered=1 executed=1 skipped=0");
    expect(output).toContain("cli-cycle-task: success");
  });

  it("stops a local multi-cycle run when the goal command passes", async () => {
    const workspace = join(tmp, "goal-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    await writeFile(join(workspace, "tasks", "goal.json"), JSON.stringify({
      task_id: "cli-goal-task",
      capability: "code.test",
      prompt: "Exercise CLI goal stopping",
    }));

    const exitCode = await main([
      "loop",
      "run",
      "--workspace",
      workspace,
      "--source",
      "task_queue",
      "--execute",
      "node -e \"require('fs').writeFileSync('cli-goal-done.txt', 'ok')\"",
      "--goal",
      "node -e \"process.exit(require('fs').existsSync('cli-goal-done.txt') ? 0 : 1)\"",
      "--cycles",
      "3",
      "--interval-ms",
      "10",
    ]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("goal=passed exit_code=0");
    expect(output).toContain("cycles=1");
    expect(output).toContain("cycle 1: discovered=1 executed=1 skipped=0 goal=passed");
  });

  it("can manage a daemon background polling loop", async () => {
    process.env["OSSTACK_HOME"] = join(tmp, "home");
    process.env["OSSTACK_SOCKET"] = `/tmp/osstack-cli-loop-${randomUUID()}.sock`;
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"] });
    const workspace = join(tmp, "watch-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });

    const startCode = await main([
      "loop",
      "start",
      "--workspace",
      workspace,
      "--source",
      "task_queue",
      "--execute",
      "node -e \"require('fs').writeFileSync('cli-watch-done.txt', 'ok')\"",
      "--interval-ms",
      "20",
      "--cycles",
      "5",
      "--json",
    ]);

    expect(startCode).toBe(0);
    const started = JSON.parse(logs.join("\n")) as { loop_session_id: string };
    await writeFile(join(workspace, "tasks", "watch.json"), JSON.stringify({
      task_id: "cli-watch-task",
      capability: "code.test",
      prompt: "Exercise CLI background loop",
    }));

    const session = await waitForCliLoop(started.loop_session_id, (candidate) => (
      candidate.executed_task_count >= 1
    ));
    expect(session.status).toMatch(/running|stopped/);

    logs = [];
    const stopCode = await main(["loop", "stop", started.loop_session_id]);
    expect(stopCode).toBe(0);
    expect(logs.join("\n")).toContain(`loop_session_id=${started.loop_session_id}`);

    logs = [];
    const statusCode = await main(["loop", "status", "--daemon", "--workspace", workspace]);
    expect(statusCode).toBe(0);
    expect(logs.join("\n")).toContain("cli-watch-task - success");
  });

  it("treats loop start --once as a single daemon-managed cycle", async () => {
    process.env["OSSTACK_HOME"] = join(tmp, "home");
    process.env["OSSTACK_SOCKET"] = `/tmp/osstack-cli-loop-${randomUUID()}.sock`;
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"] });
    const workspace = join(tmp, "once-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    await writeFile(join(workspace, "tasks", "once.json"), JSON.stringify({
      task_id: "cli-once-task",
      capability: "code.test",
      prompt: "Exercise CLI once loop",
    }));

    const startCode = await main([
      "loop",
      "start",
      "--workspace",
      workspace,
      "--source",
      "task_queue",
      "--execute",
      "node -e \"require('fs').writeFileSync('cli-once-done.txt', 'ok')\"",
      "--once",
      "--interval-ms",
      "0",
      "--json",
    ]);

    expect(startCode).toBe(0);
    const started = JSON.parse(logs.join("\n")) as {
      loop_session_id: string;
      interval_ms: number;
      max_cycles: number;
      stop_when_idle: boolean;
    };
    expect(started.interval_ms).toBe(0);
    expect(started.max_cycles).toBe(1);
    expect(started.stop_when_idle).toBe(true);
    const session = await waitForCliLoop(started.loop_session_id, (candidate) => (
      candidate.status === "stopped" && candidate.executed_task_count === 1
    ));
    expect(session.max_cycles).toBe(1);
    expect(session.stop_reason).toBe("max cycles reached");
  });

  it("starts a daemon loop with a cron schedule", async () => {
    process.env["OSSTACK_HOME"] = join(tmp, "home");
    process.env["OSSTACK_SOCKET"] = `/tmp/osstack-cli-loop-${randomUUID()}.sock`;
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"] });
    const workspace = join(tmp, "scheduled-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    await writeFile(join(workspace, "tasks", "scheduled.json"), JSON.stringify({
      task_id: "cli-scheduled-task",
      capability: "code.test",
      prompt: "Exercise CLI scheduled loop",
    }));

    const startCode = await main([
      "loop",
      "start",
      "--workspace",
      workspace,
      "--source",
      "task_queue",
      "--execute",
      "node -e \"require('fs').writeFileSync('cli-scheduled-done.txt', 'ok')\"",
      "--schedule",
      "* * * * *",
      "--cycles",
      "1",
      "--json",
    ]);

    expect(startCode).toBe(0);
    const started = JSON.parse(logs.join("\n")) as { loop_session_id: string; schedule: string };
    expect(started.schedule).toBe("* * * * *");
    const session = await waitForCliLoop(started.loop_session_id, (candidate) => (
      candidate.status === "stopped" && candidate.executed_task_count === 1
    ));
    expect(session.schedule).toBe("* * * * *");
  });
});

interface CliLoopSession {
  loop_session_id: string;
  status: string;
  executed_task_count: number;
  schedule?: string;
  max_cycles?: number;
  stop_reason?: string;
}

async function waitForCliLoop(
  loopSessionId: string,
  predicate: (session: CliLoopSession) => boolean,
): Promise<CliLoopSession> {
  const deadline = Date.now() + 2_000;
  let last: CliLoopSession | undefined;
  while (Date.now() < deadline) {
    logs = [];
    const listCode = await main(["loop", "list", "--json"]);
    if (listCode !== 0) throw new Error(`loop list exited with ${listCode}`);
    const result = JSON.parse(logs.join("\n")) as { loops: CliLoopSession[] };
    last = result.loops.find((loop) => loop.loop_session_id === loopSessionId);
    if (last !== undefined && predicate(last)) return last;
    await sleep(20);
  }
  throw new Error(`loop session did not reach expected state: ${JSON.stringify(last)}`);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

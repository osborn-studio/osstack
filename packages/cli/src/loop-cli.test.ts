import { healthyAutonomyHealth } from "./test-healthy-autonomy.js";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { CodexCliAdapter, KimiCodeAdapter, defaultAdapters } from "@osstack/agents";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";
import { startDaemon as startRealDaemon, type DaemonHandles } from "./daemon.js";

let tmp: string;
let logs: string[];
let errors: string[];
let oldSocket: string | undefined;
let oldHome: string | undefined;
let daemon: DaemonHandles | null;

interface InstructionDoctorCheck {
  id: string;
  status: string;
  summary: string;
  details?: Record<string, unknown>;
}

async function runInstructionDoctor(): Promise<{
  exitCode: number;
  check: InstructionDoctorCheck;
}> {
  await mkdir(join(tmp, "tasks"));
  await writeFile(join(tmp, "tasks", "task.json"), JSON.stringify({
    task_id: "doctor-instruction-task",
    capability: "code.test",
    prompt: "Freeze instruction doctor behavior",
  }));

  const exitCode = await main(["loop", "doctor", "--workspace", tmp, "--json"]);
  const result = JSON.parse(logs.join("\n")) as {
    checks: InstructionDoctorCheck[];
  };
  const check = result.checks.find((candidate) => candidate.id === "agent_instructions");
  if (!check) throw new Error("agent_instructions check missing");
  return { exitCode, check };
}

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
  it("preserves bare loop run legacy output without probing adapters", async () => {
    const kimiProbe = vi.spyOn(KimiCodeAdapter.prototype, "isAvailable");
    await mkdir(join(tmp, "tasks"));
    await writeFile(join(tmp, "tasks", "legacy.json"), JSON.stringify({
      task_id: "legacy-loop-task",
      capability: "code.test",
      prompt: "Freeze legacy loop routing",
    }));

    const exitCode = await main([
      "loop",
      "run",
      "--workspace",
      tmp,
      "--source",
      "task_queue",
      "--execute",
      "node -e \"process.exit(0)\"",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as Record<string, unknown>;
    expect(summary).toMatchObject({
      completed_tasks: [
        expect.objectContaining({
          task_id: "legacy-loop-task",
          outcome: "success",
        }),
      ],
    });
    expect(summary).not.toHaveProperty("profile");
    expect(kimiProbe).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it("prints loop help from --help", async () => {
    const exitCode = await main(["loop", "--help"]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("osstack loop — local Loop Engineering runner");
    expect(output).toContain("osstack loop run [options]");
    expect(output).toContain("osstack loop doctor [options]");
    expect(output).toContain("--proof");
    expect(output).toContain("--knowledge M");
    expect(output).toContain("--govern [M]");
    expect(output).toContain("--govern-scope S");
    expect(output).toContain("--neat-finalize");
    expect(errors).toEqual([]);
  });

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

  it("attaches non-gating neat evidence after a successful direct run", async () => {
    await mkdir(join(tmp, "tasks"));
    await mkdir(join(tmp, ".osstack"));
    await writeFile(join(tmp, "tasks", "task.json"), JSON.stringify({
      task_id: "cli-loop-neat-task",
      capability: "code.test",
      prompt: "Exercise the neat finalizer",
    }));
    await writeFile(join(tmp, ".osstack", "neat.yaml"), `version: 1
required_surfaces:
  - id: missing-guide
    path: docs/guide.md
    kind: file
    severity: warning
`);

    const exitCode = await main([
      "loop", "run", "--workspace", tmp, "--source", "task_queue",
      "--execute", "node -e \"process.exit(0)\"", "--neat-finalize", "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      knowledge_hygiene: {
        status: string;
        report: { findings: Array<{ rule_id: string }> };
      };
    };
    expect(summary.knowledge_hygiene).toMatchObject({
      status: "ok",
      report: { findings: [expect.objectContaining({ rule_id: "surface.required_missing" })] },
    });
  });

  it("does not rewrite direct loop success when neat finalization fails", async () => {
    await mkdir(join(tmp, "tasks"));
    await mkdir(join(tmp, ".osstack"));
    await writeFile(join(tmp, "tasks", "task.json"), JSON.stringify({
      task_id: "cli-loop-neat-error-task",
      capability: "code.test",
      prompt: "Exercise neat failure isolation",
    }));
    await writeFile(join(tmp, ".osstack", "neat.yaml"), "version: 3\n");

    const exitCode = await main([
      "loop", "run", "--workspace", tmp, "--source", "task_queue",
      "--execute", "node -e \"process.exit(0)\"", "--neat-finalize", "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      completed_tasks: Array<{ outcome: string }>;
      knowledge_hygiene: { status: string; error: string };
    };
    expect(summary.completed_tasks).toEqual([expect.objectContaining({ outcome: "success" })]);
    expect(summary.knowledge_hygiene).toMatchObject({ status: "error" });
    expect(summary.knowledge_hygiene.error).toBe("invalid neat config");
  });

  it("defers tasks per --discovery-policy instead of executing them", async () => {
    await mkdir(join(tmp, "tasks"));
    await writeFile(join(tmp, "tasks", "task.json"), JSON.stringify({
      task_id: "cli-governed-task",
      capability: "release.publish",
      prompt: "Publish the release",
    }));
    await writeFile(join(tmp, "policy.json"), JSON.stringify({
      default_authorization: "auto_execute",
      blocked_capabilities: ["release.publish"],
    }));

    const exitCode = await main([
      "loop",
      "run",
      "--workspace",
      tmp,
      "--source",
      "task_queue",
      "--execute",
      "node -e \"process.exit(0)\"",
      "--discovery-policy",
      "policy.json",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as { completed_tasks: unknown[] };
    expect(summary.completed_tasks).toEqual([]);
    const markdown = await readFile(join(tmp, "STATE.md"), "utf-8");
    expect(markdown).toContain("## Blocked");
    expect(markdown).toContain("cli-governed-task");
  });

  it("accepts --discovery-policy default and still executes task_queue tasks", async () => {
    await mkdir(join(tmp, "tasks"));
    await writeFile(join(tmp, "tasks", "task.json"), JSON.stringify({
      task_id: "cli-default-policy-task",
      capability: "code.test",
      prompt: "Exercise default discovery policy",
    }));

    const exitCode = await main([
      "loop",
      "run",
      "--workspace",
      tmp,
      "--source",
      "task_queue",
      "--execute",
      "node -e \"process.exit(0)\"",
      "--discovery-policy",
      "default",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      completed_tasks: Array<{ task_id: string; outcome: string }>;
    };
    expect(summary.completed_tasks).toEqual([
      expect.objectContaining({ task_id: "cli-default-policy-task", outcome: "success" }),
    ]);
  });

  it("stops with exit code 2 when the loop budget is exceeded", async () => {
    await mkdir(join(tmp, "tasks"));
    await writeFile(join(tmp, "tasks", "task.json"), JSON.stringify({
      task_id: "cli-budget-task",
      capability: "code.test",
      prompt: "Exercise budget stop",
    }));

    const exitCode = await main([
      "loop",
      "run",
      "--workspace",
      tmp,
      "--source",
      "task_queue",
      "--execute",
      "node -e \"setTimeout(() => {}, 25)\"",
      "--cycles",
      "3",
      "--max-runtime-ms",
      "1",
      "--json",
    ]);

    expect(exitCode).toBe(2);
    expect(errors).toEqual([]);
    const summary = JSON.parse(logs.join("\n")) as {
      budget?: { exceeded: boolean; limit?: string };
      completed_tasks: Array<{ task_id: string; outcome: string }>;
    };
    expect(summary.budget).toMatchObject({ exceeded: true, limit: "max_runtime_ms" });
    expect(summary.completed_tasks).toEqual([
      expect.objectContaining({ task_id: "cli-budget-task", outcome: "success" }),
    ]);
  });

  it("lists, promotes, and discards lesson drafts", async () => {
    const draftsDir = join(tmp, "loop-lessons", "drafts");
    await mkdir(draftsDir, { recursive: true });
    const draft = [
      "# Lesson Draft: cli-lesson",
      "",
      "## Reusable Rule",
      "Always run the auth suite.",
      "",
      "## Suggested Target Skill",
      "- auth-hardening",
      "",
    ].join("\n");
    await writeFile(join(draftsDir, "cli-lesson.md"), draft);
    await writeFile(join(tmp, "SKILL.md"), "# Skill\n");

    const listCode = await main(["loop", "lessons", "list", "--workspace", tmp, "--json"]);
    expect(listCode).toBe(0);
    const listed = JSON.parse(logs.join("\n")) as { drafts: Array<{ id: string; suggested_skill?: string }> };
    expect(listed.drafts).toEqual([
      expect.objectContaining({ id: "cli-lesson", suggested_skill: "auth-hardening" }),
    ]);

    logs = [];
    const promoteCode = await main([
      "loop", "lessons", "promote", "cli-lesson", "--workspace", tmp, "--to-skill", "SKILL.md", "--json",
    ]);
    expect(promoteCode).toBe(0);
    const promoted = JSON.parse(logs.join("\n")) as { promoted: boolean; appended_to?: string };
    expect(promoted).toMatchObject({ promoted: true, appended_to: "SKILL.md" });
    await expect(readFile(join(tmp, "SKILL.md"), "utf-8")).resolves.toContain("## Lesson: cli-lesson");

    logs = [];
    const emptyCode = await main(["loop", "lessons", "list", "--workspace", tmp]);
    expect(emptyCode).toBe(0);
    expect(logs.join("\n")).toContain("No lesson drafts.");

    logs = [];
    errors = [];
    const missingCode = await main(["loop", "lessons", "discard", "cli-lesson", "--workspace", tmp]);
    expect(missingCode).toBe(1);
    expect(errors.join("\n")).toContain("no lesson draft found");
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

  it("creates a shadow checkpoint before a local non-worktree loop run", async () => {
    process.env["OSSTACK_HOME"] = join(tmp, "home");
    await mkdir(join(tmp, "tasks"));
    await writeFile(join(tmp, "tasks", "task.json"), JSON.stringify({
      task_id: "cli-loop-checkpoint-task",
      capability: "code.test",
      prompt: "Exercise checkpoint flag",
    }));
    await writeFile(join(tmp, "app.txt"), "before\n");

    const exitCode = await main([
      "loop",
      "run",
      "--workspace",
      tmp,
      "--source",
      "task_queue",
      "--execute",
      "node -e \"require('fs').writeFileSync('app.txt', 'after\\n')\"",
      "--verify",
      "node -e \"process.exit(require('fs').readFileSync('app.txt','utf8') === 'after\\n' ? 0 : 1)\"",
      "--checkpoint",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      checkpoint: { checkpoint_id: string; checkpoint_dir: string; files: number };
      completed_tasks: Array<{ task_id: string; outcome: string }>;
    };
    expect(summary.completed_tasks).toContainEqual(expect.objectContaining({
      task_id: "cli-loop-checkpoint-task",
      outcome: "success",
    }));
    expect(summary.checkpoint).toMatchObject({
      checkpoint_id: expect.stringMatching(/^chk_/),
      files: expect.any(Number),
    });
    expect(summary.checkpoint.checkpoint_dir).toContain(join(tmp, "home", "checkpoints"));
    await expect(readFile(join(tmp, "app.txt"), "utf-8")).resolves.toBe("after\n");
    await expect(readFile(join(summary.checkpoint.checkpoint_dir, "files", "app.txt"), "utf-8"))
      .resolves.toBe("before\n");
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

  it("keeps legacy full-scan findings as warn evidence while strict baseline scope passes clean changes", async () => {
    await mkdir(join(tmp, "tasks"));
    await writeFile(join(tmp, "legacy.ts"), "const api_key = \"sk-legacy-secret-token\";\n");
    await writeFile(join(tmp, "app.ts"), "export const value = 1;\n");
    await git(tmp, ["init", "-b", "main"]);
    await git(tmp, ["add", "legacy.ts", "app.ts"]);
    await git(tmp, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "baseline",
    ]);
    await writeFile(
      join(tmp, "legacy.ts"),
      "const api_key = \"sk-legacy-secret-token\";\nexport const value = 2;\n",
    );
    await writeFile(join(tmp, "tasks", "task.json"), JSON.stringify({
      task_id: "cli-loop-govern-baseline-clean",
      capability: "code.test",
      prompt: "Exercise baseline-scoped governance",
    }));

    const exitCode = await main([
      "loop",
      "run",
      "--workspace",
      tmp,
      "--source",
      "task_queue",
      "--govern",
      "strict",
      "--govern-scope",
      "baseline",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      governance: {
        scope: string;
        status: string;
        blocking: boolean;
        findings: unknown[];
        baseline_evidence: { status: string; blocking: boolean; findings: Array<{ rule_id: string }> };
        changed_evidence: { status: string; findings: unknown[] };
        baseline_suppressed_findings: number;
      };
    };
    expect(summary.governance).toMatchObject({
      scope: "baseline",
      status: "pass",
      blocking: false,
      findings: [],
      baseline_evidence: {
        status: "fail",
        blocking: false,
        findings: [expect.objectContaining({ rule_id: "secret.api_key" })],
      },
      changed_evidence: {
        status: "fail",
        findings: [expect.objectContaining({ rule_id: "secret.api_key", file: join(tmp, "legacy.ts") })],
      },
      baseline_suppressed_findings: 1,
    });
  });

  it("blocks new changed-file errors in strict baseline scope", async () => {
    await mkdir(join(tmp, "tasks"));
    await writeFile(join(tmp, "legacy.ts"), "const api_key = \"sk-legacy-secret-token\";\n");
    await writeFile(join(tmp, "app.ts"), "export const value = 1;\n");
    await git(tmp, ["init", "-b", "main"]);
    await git(tmp, ["add", "legacy.ts", "app.ts"]);
    await git(tmp, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "baseline",
    ]);
    await writeFile(join(tmp, "app.ts"), "const password = \"new-unsafe-password\";\n");
    await writeFile(join(tmp, "tasks", "task.json"), JSON.stringify({
      task_id: "cli-loop-govern-baseline-block",
      capability: "code.test",
      prompt: "Exercise baseline-scoped governance hard gate",
    }));

    const exitCode = await main([
      "loop",
      "run",
      "--workspace",
      tmp,
      "--source",
      "task_queue",
      "--govern",
      "strict",
      "--govern-scope",
      "baseline",
      "--json",
    ]);

    expect(exitCode).toBe(2);
    const summary = JSON.parse(logs.join("\n")) as {
      governance: {
        scope: string;
        status: string;
        blocking: boolean;
        findings: Array<{ rule_id: string; file?: string }>;
        baseline_evidence: { blocking: boolean; findings: Array<{ rule_id: string }> };
      };
    };
    expect(summary.governance).toMatchObject({
      scope: "baseline",
      status: "fail",
      blocking: true,
      findings: [expect.objectContaining({ rule_id: "secret.api_key", file: join(tmp, "app.ts") })],
      baseline_evidence: {
        blocking: false,
        findings: [expect.objectContaining({ rule_id: "secret.api_key" })],
      },
    });
  });

  it("gates findings committed by an isolated worktree against the pre-run revision", async () => {
    await mkdir(join(tmp, "tasks"));
    await writeFile(join(tmp, "app.ts"), "export const value = 1;\n");
    await git(tmp, ["init", "-b", "main"]);
    await git(tmp, ["add", "app.ts"]);
    await git(tmp, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "baseline",
    ]);
    await writeFile(join(tmp, "tasks", "task.json"), JSON.stringify({
      task_id: "cli-loop-govern-baseline-worktree",
      capability: "code.test",
      prompt: "Exercise committed baseline-scoped governance",
    }));

    const exitCode = await main([
      "loop",
      "run",
      "--workspace",
      tmp,
      "--source",
      "task_queue",
      "--execute",
      "printf 'const password = \"new-worktree-password\";\\n' > app.ts",
      "--worktree",
      "--land-branch",
      "main",
      "--govern",
      "strict",
      "--govern-scope",
      "baseline",
      "--json",
    ]);

    expect(exitCode).toBe(2);
    const summary = JSON.parse(logs.join("\n")) as {
      governance: {
        scope: string;
        blocking: boolean;
        baseline_revision?: string;
        findings: Array<{ rule_id: string; file?: string }>;
      };
    };
    expect(summary.governance).toMatchObject({
      scope: "baseline",
      blocking: true,
      baseline_revision: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
    expect(summary.governance.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule_id: "secret.api_key", file: join(tmp, "app.ts") }),
    ]));
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
      checks: Array<{ id: string; status: string; details?: { invalid_files?: string[]; invalid_details?: Record<string, string> } }>;
    };
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "task_queue",
      status: "error",
      details: expect.objectContaining({
        invalid_files: ["bad.json"],
        invalid_details: expect.objectContaining({
          "bad.json": expect.stringContaining("prompt"),
        }),
      }),
    }));
  });

  it("reports AGENTS.md and CLAUDE.md drift in loop doctor", async () => {
    await mkdir(join(tmp, "tasks"));
    await writeFile(join(tmp, "tasks", "task.json"), JSON.stringify({
      task_id: "doctor-drift-task",
      capability: "code.test",
      prompt: "Exercise instruction drift doctor",
    }));
    await writeFile(join(tmp, "AGENTS.md"), "# Canonical instructions\n");
    await writeFile(join(tmp, "CLAUDE.md"), "# Divergent Claude instructions\n");

    const exitCode = await main(["loop", "doctor", "--workspace", tmp, "--json"]);

    expect(exitCode).toBe(1);
    const result = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; summary: string }>;
    };
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "agent_instructions",
      status: "error",
      summary: expect.stringContaining("drift risk"),
    }));
  });

  it("preserves loop doctor output when root instructions are absent", async () => {
    const { exitCode, check } = await runInstructionDoctor();

    expect(exitCode).toBe(0);
    expect(check).toEqual({
      id: "agent_instructions",
      status: "warn",
      summary: "no AGENTS.md or CLAUDE.md found at workspace root",
      details: { expected_source: join(tmp, "AGENTS.md") },
    });
  });

  it("preserves loop doctor output when AGENTS.md is the only source", async () => {
    await writeFile(join(tmp, "AGENTS.md"), "# Canonical\n");

    const { exitCode, check } = await runInstructionDoctor();

    expect(exitCode).toBe(0);
    expect(check).toEqual({
      id: "agent_instructions",
      status: "ok",
      summary: "AGENTS.md is the only root instruction source",
      details: { source: join(tmp, "AGENTS.md") },
    });
  });

  it("preserves loop doctor output when CLAUDE.md has no canonical source", async () => {
    await writeFile(join(tmp, "CLAUDE.md"), "@AGENTS.md\n");

    const { exitCode, check } = await runInstructionDoctor();

    expect(exitCode).toBe(1);
    expect(check).toEqual({
      id: "agent_instructions",
      status: "error",
      summary: "CLAUDE.md exists without AGENTS.md; instruction source is not unified",
      details: {
        claude: join(tmp, "CLAUDE.md"),
        expected_source: join(tmp, "AGENTS.md"),
      },
    });
  });

  it("preserves loop doctor output for a one-line CLAUDE.md reference", async () => {
    await writeFile(join(tmp, "AGENTS.md"), "# Canonical\n");
    await writeFile(join(tmp, "CLAUDE.md"), "@AGENTS.md\n");

    const { exitCode, check } = await runInstructionDoctor();

    expect(exitCode).toBe(0);
    expect(check).toEqual({
      id: "agent_instructions",
      status: "ok",
      summary: "AGENTS.md is canonical and CLAUDE.md references it",
      details: {
        source: join(tmp, "AGENTS.md"),
        claude: join(tmp, "CLAUDE.md"),
        mode: "one-line-reference",
      },
    });
  });

  it("preserves loop doctor output for a CLAUDE.md symlink", async () => {
    await writeFile(join(tmp, "AGENTS.md"), "# Canonical\n");
    await symlink("AGENTS.md", join(tmp, "CLAUDE.md"));

    const { exitCode, check } = await runInstructionDoctor();

    expect(exitCode).toBe(0);
    expect(check).toEqual({
      id: "agent_instructions",
      status: "ok",
      summary: "AGENTS.md is canonical and CLAUDE.md references it",
      details: {
        source: join(tmp, "AGENTS.md"),
        claude: join(tmp, "CLAUDE.md"),
        mode: "symlink",
      },
    });
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
      "--land-branch",
      "main",
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

  it("keeps --worktree success on the task branch unless --land-branch opts in (D7)", async () => {
    const workspace = join(tmp, "worktree-no-landing-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    await git(workspace, ["init", "-b", "main"]);
    await writeFile(join(workspace, "app.txt"), "before\n");
    await git(workspace, ["add", "app.txt"]);
    await git(workspace, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
    await writeFile(join(workspace, "tasks", "task.json"), JSON.stringify({
      task_id: "cli-worktree-no-landing",
      capability: "code.test",
      prompt: "Exercise default no-landing",
    }));
    const before = await git(workspace, ["rev-parse", "HEAD"]);

    const exitCode = await main([
      "loop", "run", "--workspace", workspace, "--source", "task_queue",
      "--execute", "node -e \"require('fs').writeFileSync('app.txt', 'after\\n')\"",
      "--worktree", "--worktree-root", join(tmp, "no-landing-worktrees"), "--json",
    ]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
      completed_tasks: Array<{ worktree_branch?: string; worktree_commit?: string; worktree_branch_preserved?: boolean }>;
    };
    const types = result.events.map((event) => event.type);
    expect(types).toContain("loop.worktree.preserved");
    expect(types).not.toContain("loop.worktree.merged");
    expect(result.completed_tasks[0]).toMatchObject({ worktree_branch_preserved: true, worktree_commit: expect.stringMatching(/^[a-f0-9]{40}$/) });
    await expect(git(workspace, ["rev-parse", "HEAD"])).resolves.toBe(before);
    await expect(readFile(join(workspace, "app.txt"), "utf-8")).resolves.toBe("before\n");
    await expect(git(workspace, ["rev-parse", result.completed_tasks[0]!.worktree_branch!])).resolves.toBe(result.completed_tasks[0]!.worktree_commit);
  });

  it("refuses unsafe --land-branch combinations before running anything", async () => {
    await mkdir(join(tmp, "tasks"), { recursive: true });
    await expect(main(["loop", "run", "--workspace", tmp, "--land-branch", "main"])).resolves.toBe(1);
    await expect(main(["loop", "run", "--workspace", tmp, "--worktree", "--land-branch"])).resolves.toBe(1);
    await expect(main(["loop", "run", "--workspace", tmp, "--worktree", "--land-branch", "main", "--daemon"])).resolves.toBe(1);
    await expect(main(["loop", "start", "--workspace", tmp, "--worktree", "--land-branch", "main"])).resolves.toBe(1);
    expect(errors.join("\n")).toMatch(/--land-branch requires --worktree/);
    expect(errors.join("\n")).toMatch(/not available for daemon-managed loops/);
  });

  it("refuses --govern with --worktree when the candidate would not reach the scanned checkout", async () => {
    await mkdir(join(tmp, "tasks"), { recursive: true });
    await git(tmp, ["init", "-b", "main"]);
    await expect(main(["loop", "run", "--workspace", tmp, "--source", "task_queue", "--worktree", "--govern", "strict"])).resolves.toBe(1);
    expect(errors.join("\n")).toMatch(/--govern with --worktree requires --land-branch/);
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
        family: "agent_unavailable",
        source_run_ids: [result.loop_id],
      })],
    });

    logs = [];
    const listCode = await main(["lessons", "list", "--json"]);

    expect(listCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      lessons: [expect.objectContaining({ family: "agent_unavailable" })],
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
      context: { review_output_path: join(tmp, "forbidden-review-output.md"), verify_output_path: join(tmp, "forbidden-verify-output.md") },
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
printf '%s' "$out" > "$OSSTACK_TEST_REVIEW_OUTPUT_CAPTURE"
mkdir -p "$(dirname "$out")"
printf 'reviewed:\\n%s\\n' "$input" > "$out"
echo review ok
`, "utf-8");
    await chmod(fakeReview, 0o755);

    const previous = process.env["OSSTACK_DS_REVIEW_BIN"];
    const previousCapture = process.env["OSSTACK_TEST_REVIEW_OUTPUT_CAPTURE"];
    const capture = join(tmp, "review-output-path.txt");
    process.env["OSSTACK_TEST_REVIEW_OUTPUT_CAPTURE"] = capture;
    process.env["OSSTACK_DS_REVIEW_BIN"] = fakeReview;
    process.env["OSSTACK_HOME"] = join(tmp, "reviewer-positive-home");
    // Capability/availability only: no synthetic health verdict or writer invoke.
    expect(new CodexCliAdapter().capabilities().some(capability => capability.kind === "code.write")).toBe(true);
    const probes = defaultAdapters().filter(adapter => adapter.id !== "ds-review").map(adapter =>
      vi.spyOn(Object.getPrototypeOf(adapter), "isAvailable").mockResolvedValue({ available: adapter instanceof CodexCliAdapter, last_checked_at: 0 }));
    const builderInvoke = vi.spyOn(CodexCliAdapter.prototype, "invoke").mockImplementation(() => { throw new Error("synthetic availability cannot authorize an actual provider invocation"); });
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
      await expect(readFile(join(tmp, "forbidden-review-output.md"))).rejects.toThrow();
      await expect(readFile(join(tmp, "forbidden-verify-output.md"))).rejects.toThrow();
      const outputPath = await readFile(capture, "utf8");
      expect(isAbsolute(outputPath)).toBe(true);
      const rel = relative(workspace, outputPath);
      expect(rel === ".." || rel.startsWith(".." + sep)).toBe(true);
      expect(JSON.stringify(result)).toContain(JSON.stringify(outputPath).slice(1,-1));
      await expect(readFile(outputPath, "utf-8"))
        .resolves.toContain("+after reviewer");
      expect(builderInvoke).not.toHaveBeenCalled();
    } finally {
      if (previousCapture === undefined) delete process.env["OSSTACK_TEST_REVIEW_OUTPUT_CAPTURE"];
      else process.env["OSSTACK_TEST_REVIEW_OUTPUT_CAPTURE"] = previousCapture;
      if (previous === undefined) delete process.env["OSSTACK_DS_REVIEW_BIN"];
      else process.env["OSSTACK_DS_REVIEW_BIN"] = previous;
      for (const probe of probes) probe.mockRestore();
      builderInvoke.mockRestore();
    }
  });
  it.each(["builder-unavailable", "reviewer-unavailable", "reviewer-failure"] as const)("keeps %s from successful reviewed shell execution", async mode => {
    const workspace = join(tmp, "negative-reviewer-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    await git(workspace, ["init", "-b", "main"]);
    await writeFile(join(workspace, "app.txt"), "before\n");
    await git(workspace, ["add", "app.txt"]);
    await git(workspace, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
    await writeFile(join(workspace, "tasks", "review.json"), JSON.stringify({ task_id: "negative-reviewer", capability: "code.test", prompt: "Synthetic reviewer admission negative" }));
    const fakeReview = join(workspace, "ds-review");
    await writeFile(fakeReview, `#!/usr/bin/env bash\nif [ "\${1:-}" = "--help" ]; then echo help; exit 0; fi\nexit 7\n`);
    await chmod(fakeReview, 0o755);
    const previous = process.env["OSSTACK_DS_REVIEW_BIN"];
    process.env["OSSTACK_DS_REVIEW_BIN"] = fakeReview;
    process.env["OSSTACK_HOME"] = join(tmp, "reviewer-negative-home");
    const probes = defaultAdapters().filter(adapter => mode === "reviewer-unavailable" || adapter.id !== "ds-review").map(adapter =>
      vi.spyOn(Object.getPrototypeOf(adapter), "isAvailable").mockResolvedValue({ available: mode !== "builder-unavailable" && adapter instanceof CodexCliAdapter, last_checked_at: 0 }));
    const builderInvoke = vi.spyOn(CodexCliAdapter.prototype, "invoke").mockImplementation(() => { throw new Error("synthetic availability cannot authorize an actual provider invocation"); });
    try {
      const invocation = main(["loop", "run", "--workspace", workspace, "--source", "task_queue", "--execute", "node -e \"require('fs').writeFileSync('app.txt','shell effect\\n')\"", "--reviewer", "ds-review", "--json"]);
      if (mode === "builder-unavailable") {
        await expect(invocation).rejects.toThrow("writes blocked by builder_agents");
        expect(await readFile(join(workspace, "app.txt"), "utf8")).toBe("before\n");
      } else {
        expect(await invocation).toBe(2);
        const summary = JSON.parse(logs.join("\n")) as { completed_tasks: Array<{ outcome: string }> };
        expect(summary.completed_tasks).toHaveLength(1);
        expect(summary.completed_tasks[0]?.outcome).not.toBe("success");
        expect(await readFile(join(workspace, "app.txt"), "utf8")).toBe("shell effect\n");
      }
      expect(builderInvoke).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env["OSSTACK_DS_REVIEW_BIN"];
      else process.env["OSSTACK_DS_REVIEW_BIN"] = previous;
      for (const probe of probes) probe.mockRestore();
      builderInvoke.mockRestore();
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
    const producer = (async () => {
      await expect.poll(async () => {
        try { await readFile(join(workspace, "LOOP-STATE.json")); return true; } catch { return false; }
      }, { timeout: 3_000, interval: 5 }).toBe(true);
      await writeFile(join(workspace, "tasks", "late.json"), JSON.stringify({
        task_id: "cli-cycle-task", capability: "code.test", prompt: "Exercise CLI cycles",
      }));
    })();

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

    await producer;
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
    const kimiProbe = vi.spyOn(KimiCodeAdapter.prototype, "isAvailable");
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
      profile?: unknown;
    };
    expect(started.interval_ms).toBe(0);
    expect(started.max_cycles).toBe(1);
    expect(started.stop_when_idle).toBe(true);
    expect(started).not.toHaveProperty("profile");
    expect(kimiProbe).not.toHaveBeenCalled();
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

const startDaemon = (options: Parameters<typeof startRealDaemon>[0]) => {
  execFileSync("git", ["init", tmp], { stdio: "ignore" });
  return startRealDaemon({ autonomyHealth: async () => healthyAutonomyHealth(), ...options });
};

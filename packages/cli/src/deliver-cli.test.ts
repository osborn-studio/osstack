import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import {
  cp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KimiCodeAdapter,
  type AgentAdapter,
  type AgentRuntimeIdentity,
  type AgentTask,
} from "@osstack/agents";
import {
  CapabilitySchema,
  type Capability,
  type CapabilityKind,
} from "@osstack/core";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDeliverCommandDeps,
  main,
} from "./bin.js";
import {
  DeliverAutonomyMode,
  handleDeliverCommand,
} from "./deliver-command.js";

let tmp: string;
let logs: string[];
let errors: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-deliver-cli-"));
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

describe("deliver CLI", () => {
  it("accepts only Phase B autonomy modes", () => {
    expect(DeliverAutonomyMode.options).toEqual([
      "legacy",
      "guarded-local",
    ]);
    expect(DeliverAutonomyMode.safeParse("guarded-git").success).toBe(
      false,
    );
  });

  it("preserves bare deliver legacy output without probing adapters", async () => {
    const kimiProbe = vi.spyOn(KimiCodeAdapter.prototype, "isAvailable");

    const exitCode = await main([
      "deliver",
      "Freeze legacy delivery",
      "--workspace",
      tmp,
      "--execute",
      "node -e \"process.exit(0)\"",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as Record<string, unknown>;
    expect(summary).toMatchObject({
      prompt: "Freeze legacy delivery",
      stages: ["intake", "plan", "execute-loop", "verify-review", "proof"],
      verify_commands: [],
      completed_tasks: [expect.objectContaining({ outcome: "success" })],
    });
    expect(summary).not.toHaveProperty("profile");
    expect(kimiProbe).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it("runs a product-entry delivery flow and writes report, scorecard, and proof", async () => {
    const exitCode = await main([
      "deliver",
      "Add billing dashboard",
      "--workspace",
      tmp,
      "--execute",
      "node -e \"require('fs').writeFileSync('billing.txt', 'ok')\"",
      "--verify",
      "node -e \"process.exit(require('fs').existsSync('billing.txt') ? 0 : 1)\"",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      prompt: string;
      task_path: string;
      verify_commands: string[];
      stages: string[];
      artifacts: {
        report?: string;
        scorecard_markdown?: string;
        scorecard_html?: string;
        proof_dir?: string;
        proof_zip?: string;
        proof_manifest?: string;
      };
      completed_tasks: Array<{ outcome: string }>;
    };
    expect(summary).toMatchObject({
      prompt: "Add billing dashboard",
      verify_commands: ["node -e \"process.exit(require('fs').existsSync('billing.txt') ? 0 : 1)\""],
      stages: ["intake", "plan", "execute-loop", "verify-review", "proof"],
      completed_tasks: [expect.objectContaining({ outcome: "success" })],
    });
    expect(summary.task_path).toMatch(/tasks\/task_[a-f0-9]{8}\.json$/);
    await expect(readFile(summary.task_path, "utf-8")).resolves.toContain("Add billing dashboard");
    await expect(readFile(summary.artifacts.report!, "utf-8")).resolves.toContain("# Osstack Loop Report");
    await expect(readFile(summary.artifacts.scorecard_html!, "utf-8")).resolves.toContain("<!doctype html>");
    await expect(readFile(summary.artifacts.proof_manifest!, "utf-8")).resolves.toContain("\"kind\": \"osstack.proof_pack\"");
    await expect(stat(summary.artifacts.proof_zip!)).resolves.toMatchObject({ size: expect.any(Number) });
  });

  it("records governed delivery findings without blocking by default", async () => {
    await writeFile(join(tmp, "unsafe.ts"), "const api_key = \"sk-test-secret-token\";\n");

    const exitCode = await main([
      "deliver",
      "Govern existing workspace",
      "--workspace",
      tmp,
      "--execute",
      "node -e \"process.exit(0)\"",
      "--govern",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      governance: { mode: string; status: string; blocking: boolean; findings: Array<{ rule_id: string }> };
      artifacts: { report: string; proof_dir: string };
    };
    expect(summary.governance).toMatchObject({
      mode: "warn",
      status: "fail",
      blocking: false,
      findings: [expect.objectContaining({ rule_id: "secret.api_key" })],
    });
    await expect(readFile(summary.artifacts.report, "utf-8")).resolves.toContain("governance-verifier");
    await expect(readFile(join(summary.artifacts.proof_dir, "governance-results.json"), "utf-8")).resolves.toContain("secret.api_key");
  });

  it("creates a shadow checkpoint before a non-worktree delivery run", async () => {
    process.env["OSSTACK_HOME"] = join(tmp, "home");
    await writeFile(join(tmp, "app.txt"), "before\n");

    const exitCode = await main([
      "deliver",
      "Checkpoint delivery",
      "--workspace",
      tmp,
      "--execute",
      "node -e \"require('fs').writeFileSync('app.txt', 'after\\n')\"",
      "--verify",
      "node -e \"process.exit(require('fs').readFileSync('app.txt','utf8') === 'after\\n' ? 0 : 1)\"",
      "--checkpoint",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      checkpoint: { checkpoint_id: string; checkpoint_dir: string };
    };
    expect(summary.checkpoint.checkpoint_id).toMatch(/^chk_/);
    await expect(readFile(join(tmp, "app.txt"), "utf-8")).resolves.toBe("after\n");
    await expect(readFile(join(summary.checkpoint.checkpoint_dir, "files", "app.txt"), "utf-8"))
      .resolves.toBe("before\n");
  });

  it("fails strict governed delivery runs on error severity findings", async () => {
    await writeFile(join(tmp, "unsafe.ts"), "const api_key = \"sk-test-secret-token\";\n");

    const exitCode = await main([
      "deliver",
      "Strict govern existing workspace",
      "--workspace",
      tmp,
      "--execute",
      "node -e \"process.exit(0)\"",
      "--govern",
      "strict",
      "--json",
    ]);

    expect(exitCode).toBe(2);
    const summary = JSON.parse(logs.join("\n")) as {
      governance: { mode: string; status: string; blocking: boolean };
      artifacts: { proof_dir: string };
    };
    expect(summary.governance).toMatchObject({ mode: "strict", status: "fail", blocking: true });
    const governance = JSON.parse(await readFile(join(summary.artifacts.proof_dir, "governance-results.json"), "utf-8")) as {
      blocking: boolean;
      findings: Array<{ rule_id: string; severity: string }>;
    };
    expect(governance).toMatchObject({
      blocking: true,
      findings: [expect.objectContaining({ rule_id: "secret.api_key", severity: "error" })],
    });
  });

  it("suggests a verify command from package.json and records it in task context", async () => {
    await writeFile(join(tmp, "package.json"), JSON.stringify({
      scripts: { test: "vitest run" },
    }, null, 2));

    const exitCode = await main([
      "deliver",
      "Wire user settings",
      "--workspace",
      tmp,
      "--execute",
      "node -e \"process.exit(0)\"",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      task_path: string;
      verify_commands: string[];
      suggested_verify: string;
    };
    expect(summary.suggested_verify).toBe("npm test");
    expect(summary.verify_commands).toEqual([]);
    const task = JSON.parse(await readFile(summary.task_path, "utf-8")) as {
      context: { deliver_pipeline: { suggested_verify: string } };
    };
    expect(task.context.deliver_pipeline.suggested_verify).toBe("npm test");
  });

  it("runs guarded-local with separated profile roles and local-only evidence", async () => {
    const workspace = await initGuardedFixture();
    const builderInvoke = vi.fn(async function* (
      task: AgentTask,
    ): AsyncIterable<HermesEvent> {
      const repoPath = task.context?.["repo_path"];
      if (typeof repoPath !== "string") {
        throw new Error("builder task did not include repo_path");
      }
      await writeFile(
        join(repoPath, "src/greeting.ts"),
        "\nexport const guarded = true;\n",
        { flag: "a" },
      );
      yield doneEvent(task, "completed", "builder completed");
    });
    const adapters = guardedAdapters(builderInvoke);
    const remotePorts = {
      push: vi.fn(async () => undefined),
      createPullRequest: vi.fn(async () => undefined),
      merge: vi.fn(async () => undefined),
      deploy: vi.fn(async () => undefined),
    };

    const exitCode = await handleDeliverCommand([
      "Add guarded fixture marker",
      "--workspace",
      workspace,
      "--profile",
      "mac-mini",
      "--autonomy",
      "guarded-local",
      "--json",
    ], {
      ...createDeliverCommandDeps(),
      adapters: () => adapters,
      remotePorts,
    });

    expect(
      exitCode,
      `logs=${logs.join("\n")}\nerrors=${errors.join("\n")}`,
    ).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      autonomy: string;
      profile: {
        builder_agent_id: string;
        evaluator_agent_id: string;
        independent: boolean;
      };
      verify_commands: string[];
      events: Array<{ type: string }>;
      artifacts: { proof_dir?: string; proof_manifest?: string };
      governance: { mode: string; blocking: boolean };
    };
    expect(summary).toMatchObject({
      autonomy: "guarded-local",
      profile: {
        builder_agent_id: "claude-code",
        evaluator_agent_id: "kimi-code",
        independent: true,
      },
      verify_commands: ["pnpm test"],
      governance: { mode: "strict", blocking: false },
    });
    expect(summary.events).toContainEqual(
      expect.objectContaining({ type: "loop.worktree.created" }),
    );
    expect(summary.artifacts.proof_dir).toEqual(expect.any(String));
    await expect(stat(summary.artifacts.proof_manifest!)).resolves
      .toMatchObject({ size: expect.any(Number) });
    await expect(
      readFile(
        join(summary.artifacts.proof_dir!, "policy-decision.json"),
        "utf-8",
      ),
    ).resolves.toContain("\"profile_name\": \"mac-mini\"");
    const runtimeEvidence = JSON.parse(
      await readFile(
        join(summary.artifacts.proof_dir!, "agent-runtime.json"),
        "utf-8",
      ),
    ) as {
      agents: Array<{
        adapter_id?: string;
        provider_id?: string;
        model_id?: string;
      }>;
    };
    expect(runtimeEvidence.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        adapter_id: "claude-code",
        provider_id: "anthropic",
        model_id: "claude-current",
      }),
      expect.objectContaining({
        adapter_id: "kimi-code",
        provider_id: "kimi",
        model_id: "kimi-code/k3",
      }),
    ]));
    expect(remotePorts.push).not.toHaveBeenCalled();
    expect(remotePorts.createPullRequest).not.toHaveBeenCalled();
    expect(remotePorts.merge).not.toHaveBeenCalled();
    expect(remotePorts.deploy).not.toHaveBeenCalled();
  });

  it("blocks guarded-local before Builder invoke when verification cannot be detected", async () => {
    const workspace = join(tmp, "missing-verify");
    execFileSync("git", ["init", "-b", "main", workspace]);
    await writeFile(join(workspace, "README.md"), "# fixture\n");
    commitFixture(workspace);
    const builderInvoke = vi.fn(async function* (
      task: AgentTask,
    ): AsyncIterable<HermesEvent> {
      yield doneEvent(task, "completed", "unexpected");
    });

    const exitCode = await handleDeliverCommand([
      "Attempt unverified change",
      "--workspace",
      workspace,
      "--profile",
      "mac-mini",
      "--autonomy",
      "guarded-local",
      "--json",
    ], {
      ...createDeliverCommandDeps(),
      adapters: () => guardedAdapters(builderInvoke),
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      error: {
        code: "verify_profile_missing",
      },
    });
    expect(builderInvoke).not.toHaveBeenCalled();
  });

  it("keeps explicit legacy mode on the frozen no-profile path", async () => {
    const kimiProbe = vi.spyOn(
      KimiCodeAdapter.prototype,
      "isAvailable",
    );

    const exitCode = await main([
      "deliver",
      "Explicit legacy delivery",
      "--workspace",
      tmp,
      "--execute",
      "node -e \"process.exit(0)\"",
      "--autonomy",
      "legacy",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as Record<string, unknown>;
    expect(summary).not.toHaveProperty("profile");
    expect(summary).not.toHaveProperty("autonomy");
    expect(kimiProbe).not.toHaveBeenCalled();
  });
});

const guardedFixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/guarded-local",
);

async function initGuardedFixture(): Promise<string> {
  const workspace = join(tmp, "guarded-fixture");
  await cp(guardedFixture, workspace, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace });
  commitFixture(workspace);
  return workspace;
}

function commitFixture(workspace: string): void {
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", [
    "-c",
    "user.name=osstack test",
    "-c",
    "user.email=osstack-test@example.invalid",
    "commit",
    "-m",
    "test: seed guarded fixture",
  ], { cwd: workspace });
}

function guardedAdapters(
  builderInvoke: AgentAdapter["invoke"],
): AgentAdapter[] {
  return [
    fakeAdapter({
      id: "claude-code",
      kinds: ["code.write"],
      identity: runtimeIdentity(
        "claude-code",
        "anthropic",
        "claude-current",
      ),
      invoke: builderInvoke,
    }),
    fakeAdapter({
      id: "kimi-code",
      kinds: ["code.review"],
      identity: runtimeIdentity(
        "kimi-code",
        "kimi",
        "kimi-code/k3",
      ),
      async *invoke(task) {
        yield structuredReviewDoneEvent(task);
      },
    }),
  ];
}

function fakeAdapter(options: {
  id: string;
  kinds: CapabilityKind[];
  identity: AgentRuntimeIdentity;
  invoke: AgentAdapter["invoke"];
}): AgentAdapter {
  const capabilities: Capability[] = options.kinds.map((kind) =>
    CapabilitySchema.parse({
      id: `${options.id}.${kind}`,
      kind,
      agent_id: options.id,
      description: `${options.id} ${kind}`,
      cost_tier: "mid",
    }),
  );
  return {
    id: options.id,
    display_name: options.id,
    cost_tier: "mid",
    capabilities: () => capabilities,
    isAvailable: async () => ({
      available: true,
      last_checked_at: 1,
    }),
    runtimeIdentity: async () => options.identity,
    invoke: options.invoke,
  };
}

function runtimeIdentity(
  adapterId: string,
  providerId: string,
  modelId: string,
): AgentRuntimeIdentity {
  return {
    adapter_id: adapterId,
    adapter_version: "1.0.0",
    auth_mode: "test",
    provider_id: providerId,
    model_id: modelId,
    evidence_source: "reported",
  };
}

function doneEvent(
  task: AgentTask,
  status: "completed" | "failed",
  summary: string,
): HermesEvent {
  return {
    event_id: `${task.run_id}:1`,
    seq: 1,
    run_id: task.run_id,
    session_id: task.session_id,
    created_at: Date.now() / 1000,
    terminal: true,
    type: "done",
    payload: {
      status,
      last_seq: 0,
      result_summary: summary,
    },
  };
}

function structuredReviewDoneEvent(task: AgentTask): HermesEvent {
  return {
    ...doneEvent(task, "completed", "approved"),
    payload: {
      status: "completed",
      last_seq: 0,
      result_summary: "approved",
      review: {
        schema_version: 1,
        verdict: "approved",
        risk: "read_only",
        markdown: "# Review\n\nApproved.",
        judgments: [],
        findings: [],
        recommended_actions: [],
        evidence_refs: [],
        runtime_identity: runtimeIdentity(
          "kimi-code",
          "kimi",
          "kimi-code/k3",
        ),
      },
    },
  };
}

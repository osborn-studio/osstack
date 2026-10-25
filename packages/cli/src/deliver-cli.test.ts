import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  readdir,
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
  deliveryCheckReference,
  type Capability,
  type CapabilityKind,
} from "@osstack/core";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDeliverCommandDeps,
  main,
} from "./bin.js";
import { persistDeliveryHostRecord, deliveryBytesDigest } from "./delivery-contract-host.js";
import {
  DeliverAutonomyMode,
  handleDeliverCommand,
} from "./deliver-command.js";

let tmp: string;
let logs: string[];
let errors: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-deliver-cli-"));
  vi.stubEnv("OSSTACK_HOME", join(tmp, "home"));
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
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

describe("deliver CLI", () => {
  it("accepts all guarded autonomy modes", () => {
    expect(DeliverAutonomyMode.options).toEqual([
      "legacy",
      "guarded-local",
      "guarded-git",
      "guarded-deploy",
    ]);
    expect(DeliverAutonomyMode.safeParse("guarded-git").success).toBe(
      true,
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
    expect(summary).not.toHaveProperty("delivery_contract");
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

  it("records legacy findings as baseline evidence and gates only new findings", async () => {
    execFileSync("git", ["init", "-b", "main"], { cwd: tmp });
    await writeFile(
      join(tmp, "legacy-unsafe.ts"),
      "const api_key = \"sk-test-secret-token\";\n",
    );
    commitFixture(tmp);

    const exitCode = await main([
      "deliver",
      "Govern only changes from the accepted baseline",
      "--workspace",
      tmp,
      "--execute",
      "node -e \"process.exit(0)\"",
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
        blocking: boolean;
        findings: Array<{ rule_id: string }>;
        baseline_evidence: {
          blocking: boolean;
          findings: Array<{ rule_id: string }>;
        };
      };
    };
    expect(summary.governance).toMatchObject({
      scope: "baseline",
      blocking: false,
      findings: [],
      baseline_evidence: {
        blocking: false,
        findings: [
          expect.objectContaining({ rule_id: "secret.api_key" }),
        ],
      },
    });
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

  it("dispatches guarded-git through the durable runtime and surfaces approval", async () => {
    const workspace = await initGuardedFixture();
    const builderInvoke = vi.fn(async function* (
      task: AgentTask,
    ): AsyncIterable<HermesEvent> {
      yield doneEvent(task, "completed", "unexpected");
    });
    const startGuardedGit = vi.fn(async (_input: unknown) => ({
      status: "needs_approval" as const,
      run: {
        autonomy_run_id: "run-auth",
        state: "awaiting_approval" as const,
        revision: 3,
        context: {},
      },
      approval_request: {
        approval_id: "approval:run-auth:preflight",
        autonomy_run_id: "run-auth",
        phase: "preflight" as const,
        contract_sha256: "a".repeat(64),
        diff_sha256: "0".repeat(64),
        action_scope: ["build", "verify"],
        risk: "R3" as const,
        nonce: "nonce-auth",
        requested_at: "2026-07-28T18:00:00.000Z",
        expires_at: "2026-07-28T19:00:00.000Z",
        request_sha256: "b".repeat(64),
      },
    }));

    const exitCode = await handleDeliverCommand([
      "Change src/auth/session.ts",
      "--workspace",
      workspace,
      "--profile",
      "mac-mini",
      "--autonomy",
      "guarded-git",
      "--expected-path",
      "src/auth/session.ts",
      "--json",
    ], {
      ...createDeliverCommandDeps(),
      adapters: () => guardedAdapters(builderInvoke),
      startGuardedGit,
    });

    expect(exitCode).toBe(2);
    expect(startGuardedGit).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Change src/auth/session.ts",
        workspacePath: realpathSync(workspace),
        expectedPaths: ["src/auth/session.ts"],
        requestedActions: [
          "build",
          "commit",
          "merge",
          "push",
          "verify",
        ],
        verifyCommands: ["pnpm test"],
        profileRouting: expect.objectContaining({
          agentId: "claude-code",
          verifierAgentIds: ["kimi-code"],
        }),
      }),
    );
    expect(builderInvoke).not.toHaveBeenCalled();
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      autonomy: "guarded-git",
      autonomy_run_id: "run-auth",
      state: "awaiting_approval",
      status: "needs_approval",
      approval_request: {
        phase: "preflight",
      },
    });
  });

  it("requires project policy and dispatches guarded-deploy through the durable runtime", async () => {
    const workspace = await initGuardedFixture();
    const startGuardedGit = vi.fn(async (_input: unknown) => ({
      status: "completed" as const,
      run: {
        autonomy_run_id: "run-deploy",
        state: "completed" as const,
        revision: 15,
        context: {
          deploy_outcome: "staging_healthy" as const,
        },
      },
    }));
    const builderInvoke = vi.fn(async function* (
      task: AgentTask,
    ): AsyncIterable<HermesEvent> {
      yield doneEvent(task, "completed", "unexpected");
    });

    const missingPolicy = await handleDeliverCommand([
      "Deploy allowlisted source",
      "--workspace",
      workspace,
      "--profile",
      "mac-mini",
      "--autonomy",
      "guarded-deploy",
      "--json",
    ], {
      ...createDeliverCommandDeps(),
      adapters: () => guardedAdapters(builderInvoke),
      startGuardedGit,
    });
    expect(missingPolicy).toBe(2);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      error: { code: "deploy_policy_required" },
    });
    logs = [];

    const exitCode = await handleDeliverCommand([
      "Deploy allowlisted source",
      "--workspace",
      workspace,
      "--profile",
      "mac-mini",
      "--autonomy",
      "guarded-deploy",
      "--deploy-policy",
      "project",
      "--json",
    ], {
      ...createDeliverCommandDeps(),
      adapters: () => guardedAdapters(builderInvoke),
      startGuardedGit,
    });

    expect(exitCode).toBe(0);
    expect(startGuardedGit).toHaveBeenCalledWith(
      expect.objectContaining({
        deployPolicy: "project",
        requestedActions: [
          "build",
          "commit",
          "deploy:production",
          "deploy:staging",
          "merge",
          "push",
          "verify",
        ],
      }),
    );
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      autonomy: "guarded-deploy",
      status: "completed",
      deploy_outcome: "staging_healthy",
    });
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

  it("fails closed at delivery execution when no independent Evaluator is available", async () => {
    const workspace = await initGuardedFixture();
    const builderInvoke = vi.fn(async function* (
      task: AgentTask,
    ): AsyncIterable<HermesEvent> {
      yield doneEvent(task, "completed", "unexpected");
    });

    const exitCode = await handleDeliverCommand([
      "Attempt guarded delivery without Kimi",
      "--workspace",
      workspace,
      "--verify",
      "node --test",
      "--profile",
      "mac-mini",
      "--autonomy",
      "guarded-local",
      "--worktree",
      "--json",
    ], {
      ...createDeliverCommandDeps(),
      adapters: () => guardedAdapters(builderInvoke).filter(
        (adapter) => adapter.id !== "kimi-code",
      ),
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      error: {
        code: "profile_routing_failed",
        message: expect.stringContaining(
          "no independent Evaluator is available",
        ),
      },
    });
    expect(builderInvoke).not.toHaveBeenCalled();
  });

  it("rejects an invalid guarded-local command timeout before Builder invoke", async () => {
    const workspace = await initGuardedFixture();
    const builderInvoke = vi.fn(async function* (
      task: AgentTask,
    ): AsyncIterable<HermesEvent> {
      yield doneEvent(task, "completed", "unexpected");
    });

    const exitCode = await handleDeliverCommand([
      "Attempt guarded delivery with an invalid timeout",
      "--workspace",
      workspace,
      "--verify",
      "node --test",
      "--profile",
      "mac-mini",
      "--autonomy",
      "guarded-local",
      "--command-timeout-ms",
      "0",
      "--json",
    ], {
      ...createDeliverCommandDeps(),
      adapters: () => guardedAdapters(builderInvoke),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain(
      "--command-timeout-ms must be a positive integer",
    );
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

describe("V2 real guarded-local host boundary", () => {
  it.each(["valid", "outside", "review_mutates", "governance", "policy_drift", "hidden_index", "new_ignored", "late_mutation"])("retains isolated candidate and fences verification: %s", async (mode) => {
    const outside = mode === "outside";
    const succeeds = mode === "valid";
    const workspace = await initGuardedFixture();
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
    const original = await readFile(join(workspace, "src/greeting.ts"), "utf8");
    const contractPath = join(tmp, "contract.json");
    await writeFile(contractPath, JSON.stringify({ schema_version: 2, contract_id: "contract-test", task_id: "task-contract-test",
      canonical_repo: realpathSync(workspace), mode: "implement", base_head: base, goal: "Add guarded fixture marker",
      required_checks: [{ id: "tests", registry_ref: deliveryCheckReference("pnpm test") }], review_policy_ref: "profile:mac-mini",
      requested_completion: "local_verified", allowed_paths: ["src"], requested_actions: ["build", "verify"], budget_ref: `policy:${"b".repeat(64)}`,
      policy_digest: "b".repeat(64), publication_scope: { mode: "none" }, merge_authority: { mode: "none" } }));
    let candidatePath: string | undefined;
    const builder = async function* (task: AgentTask): AsyncIterable<HermesEvent> {
      const repo = String(task.context?.["repo_path"]); candidatePath = repo;
      await writeFile(join(repo, "src/greeting.ts"), "\nexport const guardedV2 = true;\n", { flag: "a" });
      if (outside) await writeFile(join(repo, "forbidden.txt"), "unexpected");
      if (mode === "hidden_index") execFileSync("git", ["update-index", "--assume-unchanged", "src/greeting.ts"], { cwd: repo });
      if (mode === "new_ignored") {
        const exclude = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: repo, encoding: "utf8" }).trim();
        await writeFile(resolve(repo, exclude), "\nsrc/hidden.ts\n", { flag: "a" });
        await writeFile(join(repo, "src/hidden.ts"), "hidden candidate");
      }
      if (mode === "governance") await writeFile(join(repo, "src/secret.ts"), 'const api_key = "sk-test-secret-token";\n');
      await writeFile(contractPath, "{}"); // Later source edits cannot replace the frozen admission contract.
      yield doneEvent(task, "completed", "builder completed");
    };
    const adapters = guardedAdapters(builder);
    const prompts = new Map<string, string>();
    const contextReceipts: import("./execution-context.js").ExecutionContextReceipt[] = [];
    if (mode === "review_mutates") adapters[1]!.invoke = async function* (task) {
      await writeFile(join(candidatePath!, "src/greeting.ts"), "\nexport const afterCheck = true;\n", { flag: "a" });
      yield structuredReviewDoneEvent(task);
    };
    for (const adapter of adapters) {
      const invoke = adapter.invoke;
      adapter.invoke = async function* (task, signal) { prompts.set(task.run_id, task.prompt); yield* invoke.call(adapter, task, signal); };
    }
    let policyReads = 0;
    try {
      const code = await handleDeliverCommand(["--workspace", workspace, "--profile", "mac-mini", "--autonomy", "guarded-local", "--contract", contractPath, ...(succeeds ? ["--execution-context", join(tmp, "context.json")] : []), "--json"], {
        ...createDeliverCommandDeps(), adapters: () => adapters,
        createLoopGovernanceEvidence: async (...input) => {
          if (mode === "late_mutation" && input[1] === candidatePath)
            await writeFile(join(candidatePath!, "src/greeting.ts"), "\nexport const lateMutation = true;\n", { flag: "a" });
          return createDeliverCommandDeps().createLoopGovernanceEvidence(...input);
        },
        createExecutionContext: async input => {
          const { createExecutionContextAdapters } = await import("./execution-context.js");
          return createExecutionContextAdapters({ ...input, mode: "local", loadContext: async () => [], recordReceipt: async receipt => {
            contextReceipts.push(receipt); return persistDeliveryHostRecord(join(tmp, "context-records"), receipt);
          } });
        },
        deliveryContractPolicy: async () => ({ policyDigest: (mode === "policy_drift" && ++policyReads > 1 ? "c" : "b").repeat(64), verifyCommands: ["pnpm test"], budgetRef: `policy:${"b".repeat(64)}`, budget: { max_builder_iterations: 1, max_review_rounds: 1, max_wall_time_ms: 60000, max_no_progress_rounds: 1 } }),
      });
      expect(code, `logs=${logs.join("\n")} errors=${errors.join("\n")}`).toBe(succeeds ? 0 : 2);
      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim()).toBe(base);
      expect(await readFile(join(workspace, "src/greeting.ts"), "utf8")).toBe(original);
      expect(candidatePath).not.toBe(workspace);
      expect(await readFile(join(candidatePath!, "src/greeting.ts"), "utf8")).toContain("guardedV2");
      const summary = JSON.parse(logs.join("\n"));
      expect(summary.delivery_contract.achieved_completion).toBe(succeeds ? "local_verified" : null);
      if (succeeds) {
        const receipt = JSON.parse(await readFile(summary.delivery_contract.verification_receipt.path, "utf8"));
        expect(receipt.source).toBe("osstack_loop_host");
        expect(contextReceipts.length).toBeGreaterThanOrEqual(4);
        expect(receipt.context_receipt_refs).toHaveLength(contextReceipts.length);
        for (const recorded of contextReceipts) {
          const prompt = prompts.get(recorded.run_id)!;
          expect(recorded.prompt_sha256).toBe(deliveryBytesDigest(prompt));
          expect(recorded.contract_digest).toBe(summary.delivery_contract.digest);
          expect(recorded.repo_path).toBe(realpathSync(workspace));
          expect(recorded.evidence_boundary).toBe("agent_task_prompt_not_provider_wire");
          if (recorded.adapter_id === "claude-code") expect(prompt.split(summary.delivery_contract.brief)).toHaveLength(2);
        }
        expect(receipt.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "tests", exit_code: 0 })]));
        expect(receipt.candidate.tree_id).not.toBe(execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: workspace, encoding: "utf8" }).trim());
        expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: candidatePath, encoding: "utf8" }).trim()).toBe(base);
      }
    } finally {
      if (candidatePath) execFileSync("git", ["worktree", "remove", "--force", candidatePath], { cwd: workspace });
    }
  }, 60000);
});

// Live host path: committed-source scout -> explicit fresh admission -> isolated
// builder -> real check failure -> source repair -> real check and independent review.
describe('scout promotion and authoritative recovery lessons', () => {
  it.each(['repaired', 'no_repair', 'same_source', 'timeout', 'tampered_history'])('qualifies only actual changed-source recovery: %s', async mode => {
    const { createScoutHost } = await import('./scout-command.js');
    const workspace = await initGuardedFixture();
    const original = await readFile(join(workspace, 'src/greeting.ts'), 'utf8');
    const before = execFileSync('git', ['rev-parse', 'HEAD'], {cwd:workspace,encoding:'utf8'}).trim();
    let attempts=0;let candidatePath:string|undefined;
    const adapters=guardedAdapters(async function* (task) {
      attempts++;const candidate=String(task.context?.['repo_path']);candidatePath=candidate;
      if(mode==='timeout') await writeFile(join(candidate,'src/greeting.ts'), attempts===1 ? original+'\nsetTimeout(() => {}, 10000);\n' : original+'\nexport const timeoutRepaired = true;\n');
      else if(mode==='repaired'||mode==='tampered_history') await writeFile(join(candidate,'src/greeting.ts'),attempts===1 ? 'export function greeting(name: string): string { return `Broken, ${name}!`; }\n' : original+'\nexport const repaired = true;\n');
      else await writeFile(join(candidate,'src/greeting.ts'),original+'\nexport const noRepair = true;\n');
      yield doneEvent(task,'completed','builder completed');
    });
    // Same-source case fails review once, not a required check; it must not create a recovery lesson.
    let reviews=0;
    if(mode==='same_source')adapters[1]!.invoke=async function* (task){reviews++;if(reviews===1)yield doneEvent(task,'failed','review rejected');else yield structuredReviewDoneEvent(task);};
    const policyDigest='b'.repeat(64);
    const policy=async()=>({policyDigest,verifyCommands:['pnpm test'],budgetRef:`policy:${policyDigest}`,budget:{max_builder_iterations:2,max_review_rounds:2,max_wall_time_ms:60000,max_no_progress_rounds:2}});
    const defaultDeps=createDeliverCommandDeps();let deliveryState:string|undefined;
    const deps={...defaultDeps,adapters:()=>adapters,deliveryContractPolicy:policy,
      createDeliveryStateDirectory:async(digest:string)=>{deliveryState=await defaultDeps.createDeliveryStateDirectory!(digest);return deliveryState;},
      createLoopGovernanceEvidence:async(...args:Parameters<typeof defaultDeps.createLoopGovernanceEvidence>)=>{
        if(mode==='tampered_history'&&args[1]===candidatePath&&deliveryState){const dir=join(deliveryState,'recovery-evidence');for(const file of await readdir(dir)){const path=join(dir,file);if(JSON.parse(await readFile(path,'utf8')).pass===false)await writeFile(path,'{}');}}
        return defaultDeps.createLoopGovernanceEvidence(...args);
      },
    };
    const host=createScoutHost({home:join(tmp,'scout-host'),policy,deliver:(args,emitJson)=>handleDeliverCommand([...args,...(mode==='timeout'?['--command-timeout-ms','2000']:[])],{...deps,emitJson})});
    try {
      const scout=await host.inspect({repo:workspace,goal:'Repair greeting',paths:['src/greeting.ts'],profile:'mac-mini',requestId:`inspect-${mode}`});
      expect(attempts).toBe(0);expect(scout.facts[0]?.text).toBe(original);
      await writeFile(join(workspace,'new-base.txt'),'A newer committed base after the investigation.');commitFixture(workspace);
      const latestHead=execFileSync('git',['rev-parse','HEAD'],{cwd:workspace,encoding:'utf8'}).trim();expect(latestHead).not.toBe(before);
      const pendingPromotion=host.promote({digest:scout.digest,requestId:`promote-${mode}`});
      if(mode==='tampered_history'){await expect(pendingPromotion).rejects.toThrow('digest_mismatch');expect(logs).toHaveLength(0);expect(await readFile(join(workspace,'src/greeting.ts'),'utf8')).toBe(original);return;}
      const promotion=await pendingPromotion;
      expect(promotion.exitCode,logs.join('\n')+errors.join('\n')).toBe(0);
      expect(logs).toHaveLength(0);
      const summary=JSON.parse(JSON.stringify(promotion.deliveryResult));
      expect(summary.delivery_contract.achieved_completion).toBe('local_verified');
      expect(summary.recovered_lesson.state).toBe(mode==='repaired'?'draft':'not_qualified');
      expect(await readFile(join(workspace,'src/greeting.ts'),'utf8')).toBe(original);
      expect(execFileSync('git',['rev-parse','HEAD'],{cwd:workspace,encoding:'utf8'}).trim()).toBe(latestHead);
      const verifiedReceipt=JSON.parse(await readFile(summary.delivery_contract.verification_receipt.path,'utf8'));expect(verifiedReceipt.candidate.base_head).toBe(latestHead);
      if(mode==='repaired'){
        expect(attempts).toBe(2);expect(summary.recovered_lesson.evidence).toHaveLength(2);
        const [failure,success]=await Promise.all(summary.recovered_lesson.evidence.map(async (ref:{path:string})=>JSON.parse(await readFile(ref.path,'utf8'))));
        expect(failure.pass).toBe(false);expect(failure.checks[0].exitCode).not.toBe(0);expect(success.pass).toBe(true);expect(success.checks[0].exitCode).toBe(0);expect(failure.workspaceDigest).not.toBe(success.workspaceDigest);
        expect(await readFile(summary.recovered_lesson.path,'utf8')).toContain('task succeeded on attempt 2');
        expect(summary.recovered_lesson.path).not.toContain(workspace);
      }
    } finally {if(candidatePath)execFileSync('git',['worktree','remove','--force',candidatePath],{cwd:workspace});}
  },60000);
});

it("rejects none-scope push and merge contracts before guarded-git dispatch", async () => {
  const contractPath = join(tmp, "forbidden-contract.json");
  await writeFile(contractPath, JSON.stringify({ schema_version: 2, contract_id: "contract-forbidden", task_id: "task-forbidden",
    canonical_repo: realpathSync(tmp), mode: "implement", base_head: "a".repeat(40), goal: "Publish without scope",
    required_checks: [{ id: "tests", registry_ref: deliveryCheckReference("pnpm test") }], review_policy_ref: "profile:mac-mini",
    requested_completion: "local_verified", allowed_paths: ["src"], requested_actions: ["build", "verify", "push", "merge"],
    budget_ref: `policy:${"b".repeat(64)}`, policy_digest: "b".repeat(64), publication_scope: { mode: "none" }, merge_authority: { mode: "none" } }));
  const startGuardedGit = vi.fn();
  const code = await handleDeliverCommand(["--workspace", tmp, "--autonomy", "guarded-git", "--contract", contractPath, "--json"], {
    ...createDeliverCommandDeps(), startGuardedGit,
  });
  expect(code).toBe(2);
  expect(logs.join("\n")).toContain("invalid_delivery_contract");
  expect(startGuardedGit).not.toHaveBeenCalled();
});

it("escapes policy loader terminal errors used by scout promotion", async () => {
  const workspace = join(tmp, "policy-\u202e\u009b\u001b");
  await mkdir(join(workspace, ".osstack"), { recursive: true });
  await writeFile(join(workspace, ".osstack", "policy.yaml"), "mode: [\n");
  expect(await createDeliverCommandDeps().enforceObservePolicyGate(workspace)).toBe(1);
  const output = errors.join("\n");
  expect(output).not.toContain("\u202e");
  expect(output).not.toContain("\u009b");
  expect(output).toContain("\\u202e");
  expect(output).toContain("\\u009b");
  expect(output).not.toContain("\u001b");
  expect(output).toContain("\\u001b");
});

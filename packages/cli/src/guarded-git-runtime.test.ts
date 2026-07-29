import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentAdapter,
  AgentRuntimeIdentity,
  AgentTask,
} from "@osstack/agents";
import {
  CapabilitySchema,
  listAutonomyTransitions,
  type CapabilityKind,
} from "@osstack/core";
import {
  HermesEventSchema,
  type HermesEvent,
} from "@osstack/hermes-adapter";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { guardedOpenDb } from "./guarded-open-db.js";
import {
  GuardedGitRouting,
  GuardedGitRuntime,
  type GuardedGitProofInput,
} from "./guarded-git-runtime.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
let root: string;
let previousHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osstack-guarded-git-"));
  previousHome = process.env["OSSTACK_HOME"];
  process.env["OSSTACK_HOME"] = join(root, "home");
});

afterEach(async () => {
  if (previousHome === undefined) {
    delete process.env["OSSTACK_HOME"];
  } else {
    process.env["OSSTACK_HOME"] = previousHome;
  }
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("GuardedGitRuntime", () => {
  it.each([
    ["R1 documentation", "docs/readme.md"],
    ["R2 source", "src/app.ts"],
  ])("completes %s through exact commit and final proof", async (
    _label,
    changedPath,
  ) => {
    const workspace = await fixtureRepo();
    const evidenceRoot = join(root, "evidence");
    const builderInvoke = vi.fn(async function* (
      task: AgentTask,
    ): AsyncIterable<HermesEvent> {
      const repoPath = String(task.context?.["repo_path"]);
      await mkdir(join(repoPath, changedPath.split("/")[0]!), {
        recursive: true,
      });
      await writeFile(
        join(repoPath, changedPath),
        "export const guarded = true;\n",
      );
      yield doneEvent(task, {
        status: "completed",
        last_seq: 0,
        result_summary: "built",
      });
    });
    const deliverGit = vi.fn(async () => ({
      pushedCommit: git(workspace, ["rev-parse", "HEAD"]),
      pr: {
        number: 12,
        url: "https://github.com/owner/repo/pull/12",
        reused: false,
      },
      mergeCommit: "c".repeat(40),
      mergedAt: "2026-07-28T19:00:00.000Z",
    }));
    const proofs: GuardedGitProofInput[] = [];
    const { runtime, close } = await testRuntime({
      workspace,
      evidenceRoot,
      builderInvoke,
      deliverGit,
      proofs,
    });

    try {
      const result = await runtime.start(startInput({
        workspace,
        evidenceRoot,
        expectedPaths: [changedPath],
      }));
      const loopState = await readFile(
        join(evidenceRoot, "LOOP-STATE.json"),
        "utf8",
      );

      expect(result.status, `${JSON.stringify(result, null, 2)}\n${loopState}`).toBe(
        "completed",
      );
      expect(result.run.state).toBe("completed");
      expect(builderInvoke).toHaveBeenCalledTimes(1);
      expect(deliverGit).toHaveBeenCalledTimes(1);
      expect(proofs.map((proof) => proof.stage)).toEqual([
        "candidate",
        "final",
      ]);
      expect(git(workspace, ["rev-list", "--count", "HEAD"])).toBe("2");
      expect(git(workspace, ["status", "--porcelain"])).toBe("");
      expect(
        git(workspace, ["show", "-s", "--format=%B", "HEAD"]),
      ).toContain("OSSTACK-IDEMPOTENCY-KEY:");
      await expect(
        readFile(join(evidenceRoot, "LOOP-STATE.json"), "utf8"),
      ).resolves.toContain("\"outcome\": \"success\"");
    } finally {
      close();
    }
  });

  it("pauses preflight R3 before invoking Builder", async () => {
    const workspace = await fixtureRepo();
    const evidenceRoot = join(root, "r3-preflight");
    const builderInvoke = vi.fn(async function* (
      task: AgentTask,
    ): AsyncIterable<HermesEvent> {
      yield doneEvent(task, {
        status: "completed",
        last_seq: 0,
        result_summary: "unexpected",
      });
    });
    const proofs: GuardedGitProofInput[] = [];
    const { runtime, close } = await testRuntime({
      workspace,
      evidenceRoot,
      builderInvoke,
      deliverGit: vi.fn(),
      proofs,
    });

    try {
      const result = await runtime.start(startInput({
        workspace,
        evidenceRoot,
        expectedPaths: ["src/auth/session.ts"],
      }));

      expect(result.status, JSON.stringify(result, null, 2)).toBe(
        "needs_approval",
      );
      expect(result.approval_request?.phase).toBe("preflight");
      expect(builderInvoke).not.toHaveBeenCalled();
      expect(proofs).toEqual([]);
      expect(git(workspace, ["rev-list", "--count", "HEAD"])).toBe("1");
    } finally {
      close();
    }
  });

  it("pauses a protected policy diff before proof, commit, or Git", async () => {
    const workspace = await fixtureRepo();
    const evidenceRoot = join(root, "r3-post-diff");
    const builderInvoke = vi.fn(async function* (
      task: AgentTask,
    ): AsyncIterable<HermesEvent> {
      const repoPath = String(task.context?.["repo_path"]);
      await mkdir(join(repoPath, ".osstack"), { recursive: true });
      await writeFile(
        join(repoPath, ".osstack/policy.yaml"),
        "mode: observe\nauto_apply: false\n",
      );
      yield doneEvent(task, {
        status: "completed",
        last_seq: 0,
        result_summary: "built",
      });
    });
    const deliverGit = vi.fn();
    const proofs: GuardedGitProofInput[] = [];
    const { runtime, close } = await testRuntime({
      workspace,
      evidenceRoot,
      builderInvoke,
      deliverGit,
      proofs,
    });

    try {
      const result = await runtime.start(startInput({
        workspace,
        evidenceRoot,
        expectedPaths: ["docs/readme.md"],
      }));
      const loopState = await readFile(
        join(evidenceRoot, "LOOP-STATE.json"),
        "utf8",
      );

      expect(result.status, `${JSON.stringify(result, null, 2)}\n${loopState}`).toBe(
        "needs_approval",
      );
      expect(result.approval_request?.phase).toBe("post_diff");
      expect(proofs).toEqual([]);
      expect(deliverGit).not.toHaveBeenCalled();
      expect(git(workspace, ["rev-list", "--count", "HEAD"])).toBe("1");
    } finally {
      close();
    }
  });

  it("resumes blocked Git delivery after restart without rebuilding or recommitting", async () => {
    const workspace = await fixtureRepo();
    const evidenceRoot = join(root, "restart");
    const builderInvoke = vi.fn(async function* (
      task: AgentTask,
    ): AsyncIterable<HermesEvent> {
      const repoPath = String(task.context?.["repo_path"]);
      await writeFile(join(repoPath, "README.md"), "# guarded\n");
      yield doneEvent(task, {
        status: "completed",
        last_seq: 0,
        result_summary: "built",
      });
    });
    let pullRequestExists = false;
    const firstDelivery = vi.fn(async () => {
      pullRequestExists = true;
      throw new Error("daemon stopped after PR creation");
    });
    const firstProofs: GuardedGitProofInput[] = [];
    const first = await testRuntime({
      workspace,
      evidenceRoot,
      builderInvoke,
      deliverGit: firstDelivery,
      proofs: firstProofs,
    });

    const blocked = await first.runtime.start(startInput({
      workspace,
      evidenceRoot,
      expectedPaths: ["README.md"],
    }));
    expect(blocked.status).toBe("blocked");
    expect(blocked.run.state).toBe("blocked_delivery");
    expect(pullRequestExists).toBe(true);
    expect(git(workspace, ["rev-list", "--count", "HEAD"])).toBe("2");
    first.close();

    const resumedBuilder = vi.fn(builderInvoke);
    const resumedDelivery = vi.fn(async () => {
      expect(pullRequestExists).toBe(true);
      return {
        pushedCommit: git(workspace, ["rev-parse", "HEAD"]),
        pr: {
          number: 12,
          url: "https://github.com/owner/repo/pull/12",
          reused: true,
        },
        mergeCommit: "c".repeat(40),
        mergedAt: "2026-07-28T19:00:00.000Z",
      };
    });
    const resumedProofs: GuardedGitProofInput[] = [];
    const second = await testRuntime({
      workspace,
      evidenceRoot,
      builderInvoke: resumedBuilder,
      deliverGit: resumedDelivery,
      proofs: resumedProofs,
      assertPolicyUnchanged: async () => {
        throw new Error("workspace policy is no longer the base policy");
      },
    });
    try {
      const result = await second.runtime.resume("run-1", undefined, {
        recoveryKind: "restart",
      });

      expect(result.status).toBe("completed");
      expect(result.run.state).toBe("completed");
      expect(resumedBuilder).not.toHaveBeenCalled();
      expect(resumedDelivery).toHaveBeenCalledTimes(1);
      expect(git(workspace, ["rev-list", "--count", "HEAD"])).toBe("2");
      expect(resumedProofs.map((proof) => proof.stage)).toEqual([
        "final",
      ]);
      expect(
        listAutonomyTransitions(second.db, "run-1").filter(
          (transition) => (
            JSON.parse(transition.event_json) as {
              recovery?: { kind?: string };
            }
          ).recovery?.kind === "restart",
        ),
      ).toHaveLength(1);
    } finally {
      second.close();
    }
  });
});

async function fixtureRepo(): Promise<string> {
  const workspace = join(root, "repo");
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "--bare", remote]);
  await mkdir(join(workspace, "docs"), { recursive: true });
  await writeFile(join(workspace, "README.md"), "# fixture\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace });
  git(workspace, ["add", "."]);
  execFileSync(
    "git",
    [
      "-c",
      "user.name=osstack test",
      "-c",
      "user.email=osstack-test@example.invalid",
      "commit",
      "-m",
      "test: seed",
    ],
    { cwd: workspace },
  );
  git(workspace, ["remote", "add", "origin", remote]);
  git(workspace, ["push", "origin", "main"]);
  git(workspace, ["checkout", "-b", "codex/guarded-test"]);
  return workspace;
}

function git(workspace: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
  }).trim();
}

function startInput(options: {
  workspace: string;
  evidenceRoot: string;
  expectedPaths: string[];
}) {
  const routing = GuardedGitRouting.parse({
    schema_version: 1,
    task: {
      task_id: "task-1",
      capability: "code.write",
      prompt: "Implement guarded fixture",
      priority: 50,
      source: "manual",
      context: {},
    },
    profile: {
      profile_name: "test",
      reason: "test routing",
      builder_agent_id: "builder",
      evaluator_agent_id: "kimi-code",
      builder_identity: identity("builder", "anthropic", "claude"),
      evaluator_identity: identity("kimi-code", "kimi", "kimi-k3"),
      independent: true,
      independence_reason: "different provider",
    },
    verify_commands: ["node -e \"process.exit(0)\""],
    command_timeout_ms: 10_000,
    evidence_root: options.evidenceRoot,
    base_commit_sha: git(options.workspace, ["rev-parse", "HEAD"]),
    policy_sha256: SHA_A,
    max_auto_risk: "R2",
    protected_policy_paths: [
      ".osstack/repo.yaml",
      ".osstack/policy.yaml",
    ],
    approval_ttl_ms: 60_000,
    git: {
      remote: "origin",
      base: "main",
      branch: "codex/guarded-test",
      title: "feat: guarded test",
      body_file: join(options.evidenceRoot, "pull-request.md"),
      ci_timeout_ms: 10_000,
    },
  });
  return {
    autonomy_run_id: "run-1",
    task_id: "task-1",
    repo_id: "owner/repo",
    workspace_path: options.workspace,
    goal: "Implement guarded fixture",
    expected_paths: options.expectedPaths,
    requested_actions: ["build", "commit", "merge", "push", "verify"],
    contract_sha256: SHA_B,
    routing,
    budget: {
      max_builder_iterations: 2,
      max_review_rounds: 2,
      max_wall_time_ms: 60_000,
      max_no_progress_rounds: 1,
    },
  };
}

async function testRuntime(options: {
  workspace: string;
  evidenceRoot: string;
  builderInvoke: AgentAdapter["invoke"];
  deliverGit: NonNullable<
    GuardedGitRuntimeConstructorDeps["deliverGit"]
  >;
  proofs: GuardedGitProofInput[];
  assertPolicyUnchanged?: NonNullable<
    GuardedGitRuntimeConstructorDeps["assertPolicyUnchanged"]
  >;
}) {
  await mkdir(options.evidenceRoot, { recursive: true });
  const dbPath = join(root, "home", "state.db");
  await mkdir(join(root, "home"), { recursive: true });
  const db = guardedOpenDb({ path: dbPath });
  const runtime = new GuardedGitRuntime({
    db,
    dbPath,
    trustedApprovalPublicKeys: new Map(),
    adapters: () => adapters(options.builderInvoke),
    writeProof: async (input) => {
      options.proofs.push(input);
      const directory = join(
        options.evidenceRoot,
        `proof-${input.stage}`,
      );
      await mkdir(directory, { recursive: true });
      const manifestPath = join(directory, "manifest.json");
      await writeFile(
        manifestPath,
        `${JSON.stringify({ stage: input.stage })}\n`,
      );
      return {
        manifest_path: manifestPath,
        manifest_sha256:
          input.stage === "candidate" ? SHA_A : SHA_B,
      };
    },
    deliverGit: options.deliverGit,
    assertPolicyUnchanged:
      options.assertPolicyUnchanged
      ?? (async () => undefined),
    evaluateGovernance: async () => ({
      blocking: false,
      evidence: { status: "pass" },
    }),
  });
  return { runtime, db, close: () => db.close() };
}

type GuardedGitRuntimeConstructorDeps =
  ConstructorParameters<typeof GuardedGitRuntime>[0];

function adapters(builderInvoke: AgentAdapter["invoke"]): AgentAdapter[] {
  return [
    adapter("builder", "code.write", identity(
      "builder",
      "anthropic",
      "claude",
    ), builderInvoke),
    adapter("kimi-code", "code.review", identity(
      "kimi-code",
      "kimi",
      "kimi-k3",
    ), async function* (task) {
      yield doneEvent(task, {
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
          runtime_identity: identity(
            "kimi-code",
            "kimi",
            "kimi-k3",
          ),
        },
      });
    }),
  ];
}

function adapter(
  id: string,
  kind: CapabilityKind,
  runtimeIdentity: AgentRuntimeIdentity,
  invoke: AgentAdapter["invoke"],
): AgentAdapter {
  return {
    id,
    display_name: id,
    cost_tier: "mid",
    capabilities: () => [CapabilitySchema.parse({
      id: `${id}.${kind}`,
      kind,
      agent_id: id,
      description: `${id} ${kind}`,
      cost_tier: "mid",
    })],
    isAvailable: async () => ({
      available: true,
      last_checked_at: 1,
    }),
    runtimeIdentity: async () => runtimeIdentity,
    invoke,
  };
}

function identity(
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
  payload: unknown,
): HermesEvent {
  return HermesEventSchema.parse({
    event_id: `${task.run_id}:done`,
    seq: 1,
    run_id: task.run_id,
    session_id: task.session_id,
    created_at: Date.now() / 1_000,
    terminal: true,
    type: "done",
    payload,
  });
}

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { compileFunction } from "node:vm";
import type {
  AgentAdapter,
  AgentRuntimeIdentity,
  AgentTask,
} from "@osstack/agents";
import {
  CapabilitySchema,
  freezeDeliveryContract,
  deliveryCheckReference,
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
  RuntimeType?: typeof GuardedGitRuntime;
  createExecutionContext?: GuardedGitRuntimeConstructorDeps["createExecutionContext"];
  omitPolicyGuard?: boolean;
  workspace: string;
  evidenceRoot: string;
  builderInvoke: AgentAdapter["invoke"];
  deliverGit: NonNullable<
    GuardedGitRuntimeConstructorDeps["deliverGit"]
  >;
  proofs: GuardedGitProofInput[];
  candidateDeliveryContext?: GuardedGitRuntimeConstructorDeps["candidateDeliveryContext"];
  candidateDeliveryRunner?: GuardedGitRuntimeConstructorDeps["candidateDeliveryRunner"];
  assertPolicyUnchanged?: NonNullable<
    GuardedGitRuntimeConstructorDeps["assertPolicyUnchanged"]
  >;
}) {
  await mkdir(options.evidenceRoot, { recursive: true });
  const dbPath = join(root, "home", "state.db");
  await mkdir(join(root, "home"), { recursive: true });
  const db = guardedOpenDb({ path: dbPath });
  const runtime = new (options.RuntimeType ?? GuardedGitRuntime)({
    db,
    dbPath,
    trustedApprovalPublicKeys: new Map(),
    adapters: () => adapters(options.builderInvoke),
    ...(options.createExecutionContext ? { createExecutionContext: options.createExecutionContext } : {}),
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
    ...(options.candidateDeliveryContext === undefined ? {} : { candidateDeliveryContext: options.candidateDeliveryContext }),
    ...(options.candidateDeliveryRunner === undefined ? {} : { candidateDeliveryRunner: options.candidateDeliveryRunner }),
    ...(options.omitPolicyGuard ? {} : { assertPolicyUnchanged:
      options.assertPolicyUnchanged
      ?? (async () => undefined) }),
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

// Full existing guarded engine/local Git/proof flow. GH metadata and every delivery/merge are synthetic ports.
async function contextScenario(mode: string, RuntimeType?: typeof GuardedGitRuntime) {
  const workspace = await fixtureRepo(); const evidenceRoot = join(root, "context-evidence");
  const input = startInput({ workspace, evidenceRoot, expectedPaths: ["docs/readme.md"] });
  const original = structuredClone(input);
  const context = { environmentFingerprint: "c".repeat(64), policyFingerprint: "d".repeat(64), testsFingerprint: "e".repeat(64) };
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  let sampleCount = 0;
  const sampledInputs: Array<{ routing: GuardedGitRouting; budget: typeof input.budget }> = [];
  const sample = vi.fn(async (value: { routing: GuardedGitRouting; budget: typeof input.budget }) => {
    sampleCount++; sampledInputs.push(structuredClone(value));
    if (mode === "undefined" || mode === "undefined-policy-drift" || (["withdrawn", "withdrawn-policy-drift"].includes(mode) && sampleCount > 1)) return undefined;
    if (mode === "throw") throw new Error("synthetic callback private marker must not echo");
    if (mode === "invalid") return { ...context, unexpected: true };
    if (mode === "raw-invalid") return null as unknown as typeof context;
    value.routing.git.branch = "mutated-not-authoritative"; value.budget.max_review_rounds = 999;
    return mode === "changed" && sampleCount > 1 ? { ...context, testsFingerprint: "f".repeat(64) } : context;
  });
  const runner: NonNullable<GuardedGitRuntimeConstructorDeps["candidateDeliveryRunner"]> = { run: async (command, args) => {
    calls.push({ command, args: [...args] });
    const head = git(workspace, ["rev-parse", "HEAD"]);
    const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
    if (command === "git") {
      if (args[0] === "remote" && args[1] === "get-url") return ok("https://github.com/owner/repo.git");
      if (args[0] === "ls-remote" && ["stale-head", "stale-policy-drift"].includes(mode)) return ok(`${original.routing.base_commit_sha}\trefs/heads/codex/guarded-test\n${original.routing.base_commit_sha}\trefs/heads/main\n`);
      if (args[0] === "ls-remote" && mode === "badrefs") return ok(`${head}\trefs/heads/foreign\n`);
      if (args[0] === "ls-remote") return ok(`${head}\trefs/heads/codex/guarded-test\n${original.routing.base_commit_sha}\trefs/heads/main\n`);
      if (["check-ref-format", "branch", "status", "rev-parse"].includes(args[0] ?? "")) return ok(git(workspace, [...args]));
      throw new Error("observer attempted non-read Git command");
    }
    if (command === "gh" && args[0] === "repo" && args[1] === "view") return ok(JSON.stringify({ nameWithOwner: "owner/repo" }));
    if (command === "gh" && args[0] === "api") {
      const endpoint = args.find(v => v.startsWith("repos/")) ?? "";
      if (endpoint.includes("/rules/branches/")) return ok("[]");
      if (endpoint.includes("/branches/codex%2Fguarded-test/protection")) return { stdout: "", stderr: "HTTP 404: Branch not protected", exitCode: 1 };
      if (endpoint.includes("/branches/main/protection")) return ok(JSON.stringify({ required_status_checks: { contexts: ["ci"], checks: [] }, required_pull_request_reviews: {} }));
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      if (args.includes("headRefOid,baseRefName,headRefName")) return ok(JSON.stringify({ headRefOid: head, baseRefName: "main", headRefName: "codex/guarded-test" }));
      const metadata = { number: 12, url: "https://github.com/owner/repo/pull/12", headRefOid: head, state: "OPEN" };
      if (args.includes("number,url,headRefOid,state")) return ok(JSON.stringify(metadata));
      if (args.includes("number,url,headRefOid,state,mergeable,mergeStateStatus,statusCheckRollup")) return ok(JSON.stringify({ ...metadata, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", statusCheckRollup: [{ name: "ci", status: mode === "pending" ? "IN_PROGRESS" : "COMPLETED", conclusion: "SUCCESS" }] }));
    }
    throw new Error("synthetic runner denies unsupported or write command");
  } };
  const deliverGit = vi.fn(async (_input: Parameters<NonNullable<GuardedGitRuntimeConstructorDeps["deliverGit"]>>[0]) => ({ pushedCommit: git(workspace, ["rev-parse", "HEAD"]), pr: { number: 12, url: "https://github.com/owner/repo/pull/12", reused: true }, mergeCommit: "c".repeat(40), mergedAt: "2026-07-28T19:00:00.000Z" }));
  const builderInvoke = vi.fn(async function* (task: AgentTask): AsyncIterable<HermesEvent> {
    const repo = String(task.context?.["repo_path"]); await mkdir(join(repo, "docs"), { recursive: true }); await writeFile(join(repo, "docs/readme.md"), "synthetic guarded edit");
    yield doneEvent(task, { status: "completed", last_seq: 0, result_summary: "built" });
  });
  const guard = vi.fn(async () => {
    if ((mode === "undefined-policy-drift" && sampleCount === 1) || (mode === "withdrawn-policy-drift" && sampleCount === 2) || (mode === "stale-policy-drift" && sampleCount === 2)) throw new Error("SYNTHETIC_POLICY_CHANGED_AFTER_SAMPLE");
  });
  const { runtime, close } = await testRuntime({ ...(mode === "missing-policy-guard" ? { omitPolicyGuard: true } : {}), ...(RuntimeType === undefined ? {} : { RuntimeType }), workspace, evidenceRoot, builderInvoke, deliverGit, proofs: [], assertPolicyUnchanged: guard, ...(mode === "absent" ? {} : { candidateDeliveryContext: sample }), candidateDeliveryRunner: runner });
  try { const result = await runtime.start(input); return { result, calls, sample, deliverGit, guard, input, original, context, sampledInputs }; } finally { close(); }
}
it.each(["absent", "undefined"])("guarded context %s preserves original input with zero observer calls", async mode => {
  const observed = await contextScenario(mode); expect(observed.result.status).toBe("completed"); expect(observed.calls).toHaveLength(0);
  expect(observed.deliverGit).toHaveBeenCalledTimes(1); expect(observed.deliverGit.mock.calls[0]?.[0]).not.toHaveProperty("candidateEvidence");
  expect(observed.sample).toHaveBeenCalledTimes(mode === "absent" ? 0 : 1);
});
it("trusted context actual observer reaches existing consumer without mutating routing/budget", async () => {
  const observed = await contextScenario("green"); expect(observed.result.status).toBe("completed"); expect(observed.sample).toHaveBeenCalledTimes(2);
  const delivered = observed.deliverGit.mock.calls[0]?.[0]; expect(delivered).toHaveProperty("candidateEvidence"); expect(delivered).toHaveProperty("evidenceContext", observed.context);
  expect(observed.input).toEqual(observed.original); expect(observed.sampledInputs).toHaveLength(2);
  for (const value of observed.sampledInputs) { expect(value.routing.git.branch).toBe(observed.original.routing.git.branch); expect(value.budget).toEqual(observed.original.budget); }
  expect(delivered?.branch).toBe(observed.original.routing.git.branch); expect(observed.guard.mock.calls.length).toBeGreaterThanOrEqual(3); expect(observed.calls.length).toBeGreaterThan(0);
});
it.each(["throw", "invalid", "changed"])("trusted context %s refuses handoff without hiding callback errors", async mode => {
  const observed = await contextScenario(mode); expect(observed.result.status).not.toBe("completed"); expect(observed.deliverGit).not.toHaveBeenCalled();
  expect(JSON.stringify(observed.result)).toContain(mode === "changed" ? "CANDIDATE_CONTEXT_CHANGED" : "CANDIDATE_CONTEXT_INVALID");
});
it.each(["pending", "withdrawn"])("unproven %s context falls back only to existing input before writes", async mode => {
  const observed = await contextScenario(mode); expect(observed.result.status).toBe("completed"); expect(observed.deliverGit.mock.calls[0]?.[0]).not.toHaveProperty("candidateEvidence");
});

it.each(["undefined-policy-drift", "withdrawn-policy-drift"])("fallback %s still checks fresh policy and refuses every delivery", async mode => {
 const observed = await contextScenario(mode); expect(observed.result.status).not.toBe("completed"); expect(observed.deliverGit).not.toHaveBeenCalled(); expect(JSON.stringify(observed.result)).toContain("SYNTHETIC_POLICY_CHANGED_AFTER_SAMPLE"); expect(observed.sample).toHaveBeenCalledTimes(mode === "undefined-policy-drift" ? 1 : 2);
});
it("callback private exception text is sanitized on the actual guarded handoff", async () => {
 const observed = await contextScenario("throw"); expect(JSON.stringify(observed.result)).not.toContain("private marker"); expect(JSON.stringify(observed.result)).toContain("CANDIDATE_CONTEXT_INVALID"); expect(observed.deliverGit).not.toHaveBeenCalled();
});
it("source mutant deleting second-context comparison hands off stale hint after actual positive baseline", async () => {
 const baseline = await contextScenario("green"); expect(baseline.result.status).toBe("completed"); expect(baseline.deliverGit.mock.calls[0]?.[0]).toHaveProperty("candidateEvidence");
 await rm(root, { recursive: true, force: true }); root = mkdtempSync(join(tmpdir(), "osstack-guarded-mutant-")); process.env["OSSTACK_HOME"] = join(root, "home");
 const sourcePath = fileURLToPath(new URL("./guarded-git-runtime.ts", import.meta.url)); const source = await readFile(sourcePath, "utf8");
 const anchor = 'if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("CANDIDATE_CONTEXT_CHANGED");'; expect(source.split(anchor)).toHaveLength(2);
 const mutatedSource = source.replace(anchor, "/* MUTANT: lost second context guard */");
 const javascript = stripTypeScriptTypes(mutatedSource, { mode: "transform" }).replace(/import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["'];/g, (_, names: string, specifier: string) => `const {${names.replace(/\bas\b/g, ":")}} = await load(${JSON.stringify(specifier)});`).replace(/\bexport (?=(?:class|const|function))/g, "");
 const load = async (specifier: string) => specifier === "./policy-gate.js" ? import("./policy-gate.js") : import(/* @vite-ignore */ specifier);
 const module = await compileFunction(`return (async () => {${javascript}\nreturn { GuardedGitRuntime };})()`, ["load"])(load); expect(typeof module.GuardedGitRuntime).toBe("function");
 const mutated = await contextScenario("changed", module.GuardedGitRuntime); expect(mutated.result.status).toBe("completed"); expect(mutated.sample).toHaveBeenCalledTimes(2); expect(mutated.deliverGit).toHaveBeenCalledTimes(1);
 expect(mutated.deliverGit.mock.calls[0]?.[0]).toMatchObject({ candidateEvidence: { testsFingerprint: "e".repeat(64) }, evidenceContext: { testsFingerprint: "f".repeat(64) } });
});

it.each(["raw-invalid", "badrefs", "missing-policy-guard"])("trusted %s actual handoff refuses rather than silently using original delivery", async mode => {
 const observed = await contextScenario(mode); expect(observed.result.status).not.toBe("completed"); expect(observed.deliverGit).not.toHaveBeenCalled();
 expect(JSON.stringify(observed.result)).toContain(mode === "badrefs" ? "observer remote metadata malformed" : mode === "missing-policy-guard" ? "CANDIDATE_CONTEXT_POLICY_GUARD_REQUIRED" : "CANDIDATE_CONTEXT_INVALID");
 if (mode !== "badrefs") expect(observed.calls).toHaveLength(0);
});

it("enabled actual runtime stale head falls back to original input only after final fresh policy recheck", async () => {
 const observed = await contextScenario("stale-head"); expect(observed.result.status).toBe("completed"); expect(observed.sample).toHaveBeenCalledTimes(2); expect(observed.deliverGit).toHaveBeenCalledTimes(1);
 const delivered = observed.deliverGit.mock.calls[0]![0]; expect(delivered).not.toHaveProperty("candidateEvidence"); expect(delivered).not.toHaveProperty("evidenceContext"); expect(delivered.branch).toBe(observed.original.routing.git.branch);
 expect(observed.guard.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(observed.sample.mock.invocationCallOrder.at(-1)!); expect(observed.guard.mock.invocationCallOrder.at(-1)!).toBeLessThan(observed.deliverGit.mock.invocationCallOrder[0]!);
 expect(observed.calls.filter(call => call.args[0] === "ls-remote")).toHaveLength(1); expect(observed.calls.some(call => call.args.includes("number,url,headRefOid,state,mergeable,mergeStateStatus,statusCheckRollup"))).toBe(false);
});
it("stale-head fallback cannot bypass policy change after final context sample", async () => {
 const observed = await contextScenario("stale-policy-drift"); expect(observed.result.status).not.toBe("completed"); expect(observed.sample).toHaveBeenCalledTimes(2); expect(observed.deliverGit).not.toHaveBeenCalled(); expect(JSON.stringify(observed.result)).toContain("SYNTHETIC_POLICY_CHANGED_AFTER_SAMPLE");
});

describe("V2 guarded runtime host receipts", () => {
  it.each(["local_verified", "pr_opened"] as const)("binds real Loop evidence and obeys completion %s", async (completion) => {
    const workspace = await fixtureRepo(); const evidenceRoot = join(root, "contract-evidence");
    const start = startInput({ workspace, evidenceRoot, expectedPaths: ["docs/readme.md"] });
    const frozen = freezeDeliveryContract({ schema_version: 2, contract_id: "contract-runtime", task_id: start.task_id,
      canonical_repo: realpathSync(workspace), mode: "implement", base_head: start.routing.base_commit_sha, goal: start.goal,
      required_checks: [{ id: "tests", registry_ref: deliveryCheckReference(start.routing.verify_commands[0]!) }],
      review_policy_ref: "profile:test", requested_completion: completion, allowed_paths: ["docs/readme.md"],
      requested_actions: completion === "local_verified" ? ["build", "verify"] : ["build", "verify", "commit", "push", "open_pr"],
      budget_ref: `policy:${SHA_A}`, policy_digest: SHA_A, publication_scope: completion === "local_verified" ? { mode: "none" } : {
        mode: "review_pr", hostname: "github.com", repository: "owner/repo", remote: "origin", base_ref: "main", head_ref: "codex/guarded-test" }, merge_authority: { mode: "none" } });
    const proofs: GuardedGitProofInput[] = []; const deliverGit = vi.fn(); const externalCalls: string[] = [];
    let prCreated = false;
    const runner: NonNullable<GuardedGitRuntimeConstructorDeps["candidateDeliveryRunner"]> = { run: async (command, args) => {
      const result = (stdout: string, exitCode = 0, stderr = "") => ({ stdout, exitCode, stderr });
      externalCalls.push(`${command} ${args.join(" ")}`);
      if (command === "git") {
        if (args[0] === "remote") return result("git@github.com:owner/repo.git\n");
        if (args[0] === "push") return result("mock remote accepted exact candidate");
        return result(git(workspace, [...args]));
      }
      if (args[0] === "auth") return result("test auth");
      if (args[0] === "repo") return result(JSON.stringify({ nameWithOwner: "owner/repo" }));
      if (args[0] === "api") return args.some(a => a.includes("/protection")) ? result("", 1, "HTTP 404: Branch not protected") : result("[]");
      if (args[1] === "create") { prCreated = true; return result("https://github.com/owner/repo/pull/42"); }
      if (args[1] === "view") {
        if (!prCreated) return result("", 1, "no pull requests found");
        if (args.includes("isDraft,state")) return result(JSON.stringify({ isDraft: false, state: "OPEN" }));
        if (args.includes("headRefOid,baseRefName,headRefName")) return result(JSON.stringify({ headRefOid: git(workspace, ["rev-parse", "HEAD"]), baseRefName: "main", headRefName: "codex/guarded-test" }));
        return result(JSON.stringify({ number: 42, url: "https://github.com/owner/repo/pull/42", headRefOid: git(workspace, ["rev-parse", "HEAD"]), state: "OPEN" }));
      }
      throw new Error(`unexpected remote action ${args.join(" ")}`);
    } };
    const policyGuard = vi.fn(async () => {});
    const { runtime, close } = await testRuntime({ workspace, evidenceRoot, proofs, deliverGit, candidateDeliveryRunner: runner, assertPolicyUnchanged: policyGuard,
      builderInvoke: async function* (task) { await writeFile(join(String(task.context?.["repo_path"]), "docs/readme.md"), "verified candidate");
        yield doneEvent(task, { status: "completed", last_seq: 0, result_summary: "built" }); } });
    try {
      const result = await runtime.start({ ...start, contract_sha256: frozen.digest, requested_actions: frozen.contract.requested_actions,
        routing: { ...start.routing, delivery_contract: frozen } });
      expect(result.status, JSON.stringify(result)).toBe("completed");
      expect(policyGuard).toHaveBeenCalledWith(realpathSync(workspace), SHA_A, frozen.contract.base_head);
      expect(result.run.context.achieved_completion).toBe(completion);
      expect(git(workspace, ["rev-list", "--count", "HEAD"])).toBe(completion === "local_verified" ? "1" : "2");
      expect(externalCalls.some(call => call.includes("pr merge") || call.includes("pr checks"))).toBe(false);
      if (completion === "pr_opened") expect(externalCalls).toContain(`git push origin ${git(workspace, ["rev-parse", "HEAD"])}:refs/heads/codex/guarded-test`);
      expect(deliverGit).not.toHaveBeenCalled();
      expect(proofs.map(p => p.stage)).toEqual(["candidate"]);
      const receipt = JSON.parse(await readFile(result.run.context.delivery_receipt!.path, "utf8"));
      expect(receipt.run_id).toBe(start.autonomy_run_id);
      expect(receipt.contract_digest).toBe(frozen.digest);
      expect(receipt.checks[0]).toMatchObject({ id: "tests", exit_code: 0 });
      expect(receipt.review).toMatchObject({ verdict: "approved", builder_provider: "anthropic", reviewer_provider: "kimi" });
      expect(result.run.context.delivery_completion_receipt).toBeDefined();
    } finally { close(); }
  }, 30000);
});

it("pins initial execution context across actual guarded repair iterations", async () => {
  const workspace = await fixtureRepo();
  const evidenceRoot = join(root, "context-repair");
  const configPath = join(workspace, "context.json");
  const config = { schema_version: 1, mode: "local", repo_path: realpathSync(workspace), default_tenant: true, packs: [], max_prompt_bytes: 1000 };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(join(workspace, ".git", "info", "exclude"), "context.json\n", { flag: "a" });
  let builders = 0;
  const createContext = vi.fn(async (input: { adapters: readonly AgentAdapter[] }) => ({ adapters: input.adapters, receiptRefs: () => [] }));
  const { runtime, close } = await testRuntime({ workspace, evidenceRoot, proofs: [], deliverGit: vi.fn(), createExecutionContext: createContext,
    builderInvoke: async function* (task) {
      builders++;
      await writeFile(configPath, JSON.stringify({ ...config, max_prompt_bytes: 2000 }));
      yield doneEvent(task, { status: "completed", last_seq: 0, result_summary: "built" });
    },
  });
  try {
    const start = startInput({ workspace, evidenceRoot, expectedPaths: ["docs/readme.md", "context.json"] });
    start.routing.execution_context_path = configPath;
    start.routing.verify_commands = ["node -e 'process.exit(1)'"];
    start.budget.max_no_progress_rounds = 3;
    const result = await runtime.start(start);
    expect(result.status).not.toBe("completed");
    expect(JSON.stringify(result)).toContain("execution_context_configuration_changed");
    expect(builders).toBe(1);
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(result.run.context.routing).toMatchObject({ execution_context_pin: { config_sha256: expect.any(String) } });
  } finally { close(); }
});

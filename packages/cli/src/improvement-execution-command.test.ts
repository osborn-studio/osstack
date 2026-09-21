import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentAdapter, AgentTask } from "@osstack/agents";
import {
  approveImprovementProposal,
  ImprovementExecutionRepository,
  improvementProposalDigest,
  listImprovementProposals,
  openDb,
  upsertImprovementProposal,
} from "@osstack/core";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { addRepoRegistryEntry } from "@osstack/supervisor";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";
import { improvementPrTransport } from "./improvement-pr-delivery.js";
import { seedPnpmEnvironment } from "./improvement-environment-fixture.js";
import { simulatedImprovementGithub } from "./improvement-pr-test-fixture.js";
import type { ImprovementExecutionAdapterOptions } from "./improvement-execution-adapters.js";
import type { LoopProfileRoutingResult } from "./loop-profile-routing.js";

const mocks = vi.hoisted(() => ({ adapters: vi.fn(), routing: vi.fn() }));
vi.mock("./improvement-execution-adapters.js", () => ({ createImprovementExecutionAdapters: mocks.adapters }));
vi.mock("./loop-profile-routing.js", () => ({ resolveLoopProfileRouting: mocks.routing }));

const exec = promisify(execFile);
let root: string;
let home: string;
let repoPath: string;
let registryPath: string;
let gateLog: string;
let proposalDigest: string;
let proposalGate: string;
let registryGate: string;
let originalHead: string;
let routing: LoopProfileRoutingResult;
let logs: string[];
let errors: string[];
let builders: number;
let reviewers: number;

async function git(args: string[]): Promise<string> {
  return (await exec("git", [
    "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.invalid", ...args,
  ], { cwd: repoPath })).stdout.trim();
}

function withDb<T>(fn: (db: ReturnType<typeof openDb>, dbPath: string) => T): T {
  const dbPath = join(home, "state.db");
  const db = openDb({ path: dbPath });
  try { return fn(db, dbPath); } finally { db.close(); }
}

function executions() {
  return withDb((db, path) => new ImprovementExecutionRepository(db, path).list({}));
}

function commandFor(label: string): string {
  const script = [
    "const fs=require('fs');",
    "if(fs.readFileSync('docs/guide.md','utf8')!=='improved\\n') process.exit(1);",
    `fs.appendFileSync(${JSON.stringify(gateLog)},${JSON.stringify(`${label}\n`)});`,
  ].join("");
  return `node -e '${script.replaceAll("'", "'\"'\"'")}'`;
}

async function register(commands: string[]) {
  await addRepoRegistryEntry(registryPath, {
    repo_id: "command-repo", name: "Command fixture", path: repoPath,
    role: "cli", enabled: true, verify_commands: commands,
  });
}

function executeArgs(): string[] {
  return [
    "improve", "execute", "--proposal", "command-proposal", "--digest", proposalDigest,
    "--execution", "command-attempt", "--registry", registryPath, "--timeout-ms", "5000",
  ];
}

function output<T>(): T {
  expect(logs.length).toBe(1);
  return JSON.parse(logs[0]!) as T;
}

async function preview() {
  logs.length = 0;
  expect(await main(executeArgs())).toBe(0);
  return output<{
    dry_run: boolean;
    applied: boolean;
    request_digest: string;
    request: { base_sha: string; allowed_paths: string[]; verify_commands: string[] };
  }>();
}

function adapter(id: string, options: ImprovementExecutionAdapterOptions | undefined): AgentAdapter {
  return {
    id, display_name: id, cost_tier: "low", capabilities: () => [],
    isAvailable: async () => ({ available: true, last_checked_at: 0 }),
    async *invoke(task: AgentTask) {
      if (options === undefined) throw new Error("Preflight fixture must not execute");
      const candidatePath = String(task.context?.["repo_path"]);
      expect(candidatePath).toBe(options.workspacePath);
      expect(candidatePath).not.toBe(repoPath);
      if (id === "builder") {
        builders++;
        await writeFile(join(candidatePath, "docs/guide.md"), "improved\n");
      } else {
        reviewers++;
        expect(await readFile(join(candidatePath, "docs/guide.md"), "utf8")).toBe("improved\n");
      }
      const event: HermesEvent = {
        event_id: `${task.run_id}:done`, seq: 1, run_id: task.run_id, session_id: task.session_id,
        created_at: Date.now() / 1000, terminal: true, type: "done",
        payload: {
          status: "completed", last_seq: 1, result_summary: "fixture completed",
          ...(id === "reviewer" ? { evaluation_judgments: [{
            id: "improvement-review", pass: true, severity: "error" as const,
            summary: "The candidate implements the approved documentation change",
          }] } : {}),
        },
      };
      yield event;
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "osstack-improvement-command-"));
  home = join(root, "home");
  repoPath = join(root, "repo");
  registryPath = join(home, "repos.json");
  gateLog = join(root, "gate-runs.txt");
  logs = []; errors = []; builders = 0; reviewers = 0;
  vi.stubEnv("OSSTACK_HOME", home);
  vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args.map(String).join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...args) => { errors.push(args.map(String).join(" ")); });
  await mkdir(join(repoPath, "docs"), { recursive: true });
  await mkdir(home);
  await writeFile(join(repoPath, "docs/guide.md"), "original\n");
  await git(["init", "-b", "main"]);
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
  originalHead = await git(["rev-parse", "HEAD"]);
  proposalGate = commandFor("proposal");
  registryGate = commandFor("registry");
  await register([registryGate]);
  withDb((db, dbPath) => {
    const proposal = upsertImprovementProposal(db, dbPath, {
      proposal_id: "command-proposal", repo_id: "command-repo", source_asset_ids: ["asset-fixture"],
      target: "docs", risk: "low", title: "Improve guide", rationale: "Fill in the missing usage step",
      proposed_changes: [{ path: "docs/guide.md", action: "modify", summary: "Explain the usage step" }],
      required_gates: [proposalGate],
    });
    proposalDigest = improvementProposalDigest(proposal);
    approveImprovementProposal(db, dbPath, { proposal_id: proposal.proposal_id, expected_digest: proposalDigest, now: Date.now() / 1000 });
  });
  const identity = (id: string) => ({
    adapter_id: id, adapter_version: "fixture", auth_mode: "fixture",
    provider_id: id, model_id: "fixture-v1", evidence_source: "configured" as const,
  });
  routing = {
    agentId: "builder", verifierAgentIds: ["reviewer"],
    summary: {
      profile_name: "fixture", reason: "fixture", builder_agent_id: "builder", evaluator_agent_id: "reviewer",
      builder_identity: identity("builder"), evaluator_identity: identity("reviewer"), independent: true,
      independence_reason: "different adapters", overrides: {}, resolutions: {},
    },
  };
  mocks.adapters.mockReset().mockImplementation((options?: ImprovementExecutionAdapterOptions) => [
    adapter("builder", options), adapter("reviewer", options),
  ]);
  mocks.routing.mockReset().mockImplementation(async () => routing);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("improve execution command", () => {
  it("previews, executes the confirmed request, reports status and replays without rerunning agents or gates", async () => {
    const inspected = await preview();
    expect(inspected).toMatchObject({
      dry_run: true, applied: false, request_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      request: { base_sha: originalHead, allowed_paths: ["docs/guide.md"], verify_commands: [proposalGate, registryGate] },
    });
    expect(executions()).toEqual([]);
    expect(builders).toBe(0);
    await expect(readFile(gateLog)).rejects.toThrow();

    logs.length = 0;
    const confirmed = [...executeArgs(), "--yes", "--request-digest", inspected.request_digest];
    expect(await main(confirmed)).toBe(0);
    const executed = output<{ execution: { execution_id: string; request_sha256: string; worktree: { worktreePath: string } } }>();
    expect(executed).toMatchObject({
      applied: false, replay: false,
      execution: { execution_id: "command-attempt", state: "candidate_verified", request_sha256: inspected.request_digest },
    });
    expect(await readFile(join(executed.execution.worktree.worktreePath, "docs/guide.md"), "utf8")).toBe("improved\n");
    expect(await readFile(join(repoPath, "docs/guide.md"), "utf8")).toBe("original\n");
    expect(await git(["rev-parse", "HEAD"])).toBe(originalHead);
    expect(await git(["status", "--porcelain"])).toBe("");
    expect(await readFile(gateLog, "utf8")).toBe("proposal\nregistry\n");
    expect(builders).toBe(1);
    expect(reviewers).toBe(1);
    expect(executions()).toHaveLength(1);
    expect(withDb((db) => listImprovementProposals(db))[0]?.status).toBe("approved");

    logs.length = 0;
    expect(await main(["improve", "status", "--execution", "command-attempt"])).toBe(0);
    expect(output()).toMatchObject({ applied: false, execution: executed.execution });
    logs.length = 0;
    expect(await main(confirmed)).toBe(0);
    expect(output()).toMatchObject({ applied: false, replay: true, execution: executed.execution });
    expect(builders).toBe(1);
    expect(reviewers).toBe(1);
    expect(await readFile(gateLog, "utf8")).toBe("proposal\nregistry\n");
    expect(mocks.adapters.mock.calls.filter(([options]) => options !== undefined)).toHaveLength(1);
    expect(errors).toEqual([]);
  }, 20_000);

  it("requires the execution preview digest even when --yes and proposal approval are present", async () => {
    expect(await main([...executeArgs(), "--yes"])).toBe(1);
    expect(errors.join("\n")).toContain("--request-digest");
    expect(executions()).toEqual([]);
    expect(builders).toBe(0);
    await expect(readFile(gateLog)).rejects.toThrow();
  });

  it.each(["registry gates", "base SHA", "profile"])("rejects a stale preview after %s changes without recording or running an attempt", async (changed) => {
    const inspected = await preview();
    if (changed === "registry gates") await register([commandFor("changed-registry")]);
    if (changed === "base SHA") {
      await writeFile(join(repoPath, "docs/other.md"), "An unrelated committed document\n");
      await git(["add", "docs/other.md"]);
      await git(["commit", "-m", "new base"]);
    }
    if (changed === "profile") routing.summary.builder_identity.model_id = "fixture-v2";
    logs.length = 0;
    expect(await main([...executeArgs(), "--yes", "--request-digest", inspected.request_digest])).toBe(1);
    expect(errors.join("\n")).toContain("--request-digest");
    expect(logs).toEqual([]);
    expect(executions()).toEqual([]);
    expect(builders).toBe(0);
    expect(reviewers).toBe(0);
    expect(mocks.adapters.mock.calls.every(([options]) => options === undefined)).toBe(true);
    await expect(readFile(gateLog)).rejects.toThrow();
  });
});


it("previews a stop, persists it only with --yes, and reports it through status and baseline", async () => {
  const proposal = withDb((db) => listImprovementProposals(db)[0]!);
  withDb((db, path) => new ImprovementExecutionRepository(db, path).claim({
    execution_id: "command-attempt", proposal_id: proposal.proposal_id,
    request: { proposal_digest: improvementProposalDigest(proposal) }, now: 5,
  }));
  const args = ["improve", "stop", "--execution", "command-attempt", "--reason", "pause this trial"];
  expect(await main(args)).toBe(0);
  expect(output<{ dry_run: boolean }>().dry_run).toBe(true);
  expect(executions()[0]?.stop).toBeUndefined();
  logs.length = 0;
  expect(await main([...args, "--yes"])).toBe(0);
  expect(output<{ execution: { stop: { source: string }; state: string } }>().execution).toMatchObject({ state: "claimed", stop: { source: "operator" } });
  logs.length = 0;
  expect(await main(["improve", "status", "--execution", "command-attempt"])).toBe(0);
  expect(output<{ execution: { stop: { reason: string } } }>().execution.stop.reason).toBe("pause this trial");
  logs.length = 0;
  expect(await main(["improve", "baseline", "--proposal", proposal.proposal_id])).toBe(0);
  expect(output<{ counts: { total: number }; cost_usd: null; stop_requests: { operator: number } }>()).toMatchObject({ counts: { total: 1 }, cost_usd: null, stop_requests: { operator: 1 } });
  expect(builders).toBe(0);
  expect(reviewers).toBe(0);
});


it("delivers from a draft proposal with one confirmation and replays without another side effect", async () => {
  vi.stubEnv("OSSTACK_TEST_AMBIENT_SECRET", "must-not-reach-verification");
  const environmentGate = `node -e "if(process.env.OSSTACK_TEST_AMBIENT_SECRET) process.exit(1)"`;
  await register([registryGate, environmentGate]);
  const github = await simulatedImprovementGithub(root, repoPath);
  vi.spyOn(improvementPrTransport, "run").mockImplementation(github.transport.run);
  withDb((db) => db.prepare("UPDATE improvement_proposals SET status = 'draft'").run());
  const args = executeArgs().map((arg) => arg === "execute" ? "deliver" : arg);
  expect(await main(args)).toBe(0);
  const inspected = output<{ request_digest: string; request: { mode: string } }>();
  expect(inspected.request.mode).toBe("local_candidate_to_pr");
  expect(withDb((db) => listImprovementProposals(db))[0]?.status).toBe("draft");
  expect(executions()).toEqual([]);
  expect(github.writes).toEqual([]);

  // A changed profile invalidates the preview without approving or starting it.
  routing.summary.builder_identity.model_id = "changed";
  logs.length = 0;
  expect(await main([...args, "--yes", "--request-digest", inspected.request_digest])).toBe(1);
  expect(builders).toBe(0);
  expect(withDb((db) => listImprovementProposals(db))[0]?.status).toBe("draft");
  routing.summary.builder_identity.model_id = "fixture-v1";
  errors.length = 0;
  logs.length = 0;
  const confirmed = [...args, "--yes", "--request-digest", inspected.request_digest];
  expect(await main(confirmed)).toBe(0);
  expect(output()).toMatchObject({ replay: false, delivery: { state: "delivered", pr: { url: "https://github.com/studio/project/pull/17" } } });
  expect(withDb((db) => listImprovementProposals(db))[0]?.status).toBe("approved");
  expect(builders).toBe(1);
  expect(reviewers).toBe(1);
  expect(await readFile(gateLog, "utf8")).toBe("proposal\nregistry\nproposal\nregistry\n");
  expect(github.writes).toEqual(["push", "pr"]);
  logs.length = 0;
  expect(await main(confirmed)).toBe(0);
  expect(output()).toMatchObject({ replay: true, delivery: { state: "delivered" } });
  expect(builders).toBe(1);
  expect(github.writes).toEqual(["push", "pr"]);
  expect(errors).toEqual([]);
}, 20_000);


it("prepares real pnpm dependencies in both stages before delivering with one CLI confirmation", async () => {
  await seedPnpmEnvironment(repoPath);
  await git(["add", "."]); await git(["commit", "-m", "dependency fixture"]);
  originalHead = await git(["rev-parse", "HEAD"]);
  const dependencyGate = `pnpm exec node -e "if(require('test-local')!=='available') process.exit(1)"`;
  await register([registryGate, dependencyGate]);
  const github = await simulatedImprovementGithub(root, repoPath);
  vi.spyOn(improvementPrTransport, "run").mockImplementation(github.transport.run);
  withDb((db) => db.prepare("UPDATE improvement_proposals SET status = 'draft'").run());
  const args = [...executeArgs().map((arg) => arg === "execute" ? "deliver" : arg), "--prepare-deps", "pnpm"];
  expect(await main(args)).toBe(0);
  const previewed = output<{ request_digest: string; request: { environment: { kind: string; preparation_runs: number } } }>();
  expect(previewed.request.environment).toMatchObject({ kind: "pnpm-frozen-v1", preparation_runs: 2 });
  expect(builders).toBe(0);
  logs.length = 0;
  const exit = await main([...args, "--yes", "--request-digest", previewed.request_digest]);
  expect(exit, JSON.stringify({ result: executions()[0]?.result, delivery: JSON.parse(logs[0]!).delivery, errors })).toBe(0);
  const delivered = output<{ delivery: { state: string; workspace_path: string }; execution: { result: { artifacts: Array<{ name: string }> } } }>();
  expect(delivered.delivery.state).toBe("delivered");
  expect(delivered.execution.result.artifacts.some((a) => a.name === "environment.json")).toBe(true);
  const secondReceipt = JSON.parse(await readFile(join(delivered.delivery.workspace_path, "dependency-environment/completed.json"), "utf8"));
  expect(secondReceipt.environment).toEqual(previewed.request.environment);
  logs.length = 0;
  expect(await main(["improve", "status", "--execution", "command-attempt"])).toBe(0);
  expect(output()).toMatchObject({ environment: { candidate: { state: "completed" }, replay: { state: "completed" } } });
  expect(builders).toBe(1);
  expect(reviewers).toBe(1);
  expect(github.writes).toEqual(["push", "pr"]);
  expect(await readFile(gateLog, "utf8")).toBe("proposal\nregistry\nproposal\nregistry\n");
  await expect(readFile(join(repoPath, "node_modules/test-local"))).rejects.toThrow();
  expect(errors).toEqual([]);
}, 30_000);

it("records a failed frozen install, retains occupancy and never starts the builder", async () => {
  await seedPnpmEnvironment(repoPath);
  const manifest = JSON.parse(await readFile(join(repoPath, "package.json"), "utf8"));
  manifest.dependencies["test-local"] = "workspace:^99.0.0";
  await writeFile(join(repoPath, "package.json"), JSON.stringify(manifest));
  await git(["add", "."]); await git(["commit", "-m", "inconsistent locked fixture"]);
  originalHead = await git(["rev-parse", "HEAD"]);
  const github = await simulatedImprovementGithub(root, repoPath);
  vi.spyOn(improvementPrTransport, "run").mockImplementation(github.transport.run);
  const args = [...executeArgs().map((arg) => arg === "execute" ? "deliver" : arg), "--prepare-deps", "pnpm"];
  expect(await main(args)).toBe(0);
  const previewed = output<{ request_digest: string }>();
  logs.length = 0;
  const confirmed = [...args, "--yes", "--request-digest", previewed.request_digest];
  expect(await main(confirmed)).toBe(2);
  expect(output()).toMatchObject({ execution: { state: "running", stop: { source: "system_indeterminate" } }, delivery: { state: "authorized" } });
  expect(builders).toBe(0);
  expect(github.writes).toEqual([]);
  logs.length = 0;
  expect(await main(["improve", "status", "--execution", "command-attempt"])).toBe(0);
  expect(output()).toMatchObject({ environment: { candidate: { state: "failed" } } });
  logs.length = 0;
  expect(await main(confirmed)).toBe(2);
  expect(output()).toMatchObject({ replay: true });
  expect(builders).toBe(0);
}, 20_000);

it("binds --build-deps into the one-shot digest and refuses a wider confirmation", async () => {
  const { parse, stringify } = await import("yaml");
  await seedPnpmEnvironment(repoPath);
  await writeFile(join(repoPath, "pnpm-workspace.yaml"), "packages: [packages/*]\nallowBuilds: {native: true}\n");
  const lock = parse(await readFile(join(repoPath, "pnpm-lock.yaml"), "utf8"));
  lock.packages = { "native@1.2.3": { resolution: { integrity: "sha512-YWJj" } } };
  await writeFile(join(repoPath, "pnpm-lock.yaml"), stringify(lock));
  await git(["add", "."]); await git(["commit", "-m", "locked build preview"]);
  originalHead = await git(["rev-parse", "HEAD"]);
  const github = await simulatedImprovementGithub(root, repoPath);
  vi.spyOn(improvementPrTransport, "run").mockImplementation(github.transport.run);
  const args = [...executeArgs().map((arg) => arg === "execute" ? "deliver" : arg), "--prepare-deps", "pnpm"];
  expect(await main(args)).toBe(0);
  const scriptFreeDigest = output<{ request_digest: string }>().request_digest;
  logs.length = 0;
  expect(await main([...args, "--build-deps", "native@1.2.3"])).toBe(0);
  const buildPreview = output<{ request_digest: string; request: { environment: unknown } }>();
  expect(buildPreview.request_digest).not.toBe(scriptFreeDigest);
  expect(buildPreview.request.environment).toMatchObject({ kind: "pnpm-frozen-builds-v1", dependency_builds: { packages: [{ selector: "native@1.2.3", integrity: "sha512-YWJj" }], isolation: "os-user" } });
  expect(await main([...args, "--build-deps", "native@1.2.3", "--yes", "--request-digest", scriptFreeDigest])).toBe(1);
  expect(executions()).toEqual([]); expect(builders).toBe(0); expect(github.writes).toEqual([]);
}, 15_000);

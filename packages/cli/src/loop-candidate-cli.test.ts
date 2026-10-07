import { execFileSync } from "node:child_process";

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { candidateBinding } from "@osstack/loop";
import { randomUUID } from "node:crypto";
import { CapabilitySchema } from "@osstack/core";
import { defaultConfig } from "@osstack/config";
import { stripTypeScriptTypes } from "node:module";
import { compileFunction, constants as vmConstants } from "node:vm";
import * as candidateInputModule from "./loop-candidate-input.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentAdapter } from "@osstack/agents";

const ports = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  retain: vi.fn(),
  db: vi.fn(),
  rpc: vi.fn(),
  adapters: [] as AgentAdapter[],
  review: vi.fn(),
  knowledgeRead: vi.fn(),
  knowledgeSearch: vi.fn(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (...args: unknown[]) => {
      if (String(args[0]).includes("/knowledge-cache/config.json"))
        ports.knowledgeRead();
      return Reflect.apply(actual.readFile, actual, args);
    },
  };
});
vi.mock("@osstack/knowledge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@osstack/knowledge")>()),
  resolveKnowledgeSearch: ports.knowledgeSearch,
}));
vi.mock("node:net", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:net")>()),
  connect: ports.rpc,
}));
vi.mock("./local-execution.js", () => ({
  acquireLocalExecution: ports.acquire,
}));
vi.mock("./guarded-open-db.js", () => ({ guardedOpenDb: ports.db }));
vi.mock("@osstack/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@osstack/agents")>()),
  defaultAdapters: () => ports.adapters,
}));
import { main } from "./bin.js";
let root: string, repo: string, home: string, logs: string[];
let oldHome: string | undefined;
const profileEnv = [
  "OSSTACK_CONFIG",
  "OSSTACK_PROFILE",
  "OSSTACK_AGENT_PROFILE",
  "OSSTACK_KNOWLEDGE_URL",
  "OSSTACK_KNOWLEDGE_TOKEN",
  "OSSTACK_KNOWLEDGE_CACHE_DIR",
] as const;
let oldProfileEnv: Record<string, string | undefined>;
const command = (value: string) =>
  `${process.execPath} -e ${JSON.stringify(value)}`;
beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), "loop-candidate-cli-")));
  repo = join(root, "repo");
  home = join(root, "home");
  await mkdir(repo);
  await mkdir(home, { mode: 0o700 });
  execFileSync("git", ["init", "-q", "-b", "codex/candidate-cli", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Synthetic"]);
  execFileSync("git", [
    "-C",
    repo,
    "config",
    "user.email",
    "synthetic@example.test",
  ]);
  await writeFile(join(repo, "file.txt"), "baseline");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "synthetic baseline"]);
  oldProfileEnv = Object.fromEntries(
    profileEnv.map((name) => [name, process.env[name]]),
  );
  for (const name of profileEnv) delete process.env[name];
  process.env["OSSTACK_CONFIG"] = join(home, "absent-native-config.yaml");
  oldHome = process.env["OSSTACK_HOME"];
  process.env["OSSTACK_HOME"] = home;
  logs = [];
  ports.acquire.mockReset();
  ports.release.mockReset();
  ports.retain.mockReset();
  ports.review.mockReset();
  ports.knowledgeRead.mockReset();
  ports.knowledgeSearch.mockReset();
  ports.knowledgeSearch.mockImplementation(() => {
    throw new Error("synthetic knowledge network port refuses external access");
  });
  ports.db.mockReset();
  ports.rpc.mockReset();
  ports.rpc.mockImplementation(() => {
    throw new Error("synthetic RPC port refuses network");
  });
  ports.adapters = [];
  ports.acquire.mockResolvedValue({
    release: ports.release,
    retain: ports.retain,
  });
  ports.release.mockResolvedValue(undefined);
  ports.db.mockImplementation(() => {
    throw new Error("synthetic control DB port refuses real DB");
  });
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  for (const name of profileEnv) {
    if (oldProfileEnv[name] === undefined) delete process.env[name];
    else process.env[name] = oldProfileEnv[name];
  }
  if (oldHome === undefined) delete process.env["OSSTACK_HOME"];
  else process.env["OSSTACK_HOME"] = oldHome;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function policyInput(overrides: Record<string, unknown> = {}) {
  const state = join(root, "candidate-state");
  await mkdir(state, { mode: 0o700 });
  const trace = join(root, "stage-trace.txt");
  const stage = (value: string) =>
    command(
      `require('fs').appendFileSync(${JSON.stringify(trace)}, ${JSON.stringify(value + "\n")})`,
    );
  const policy = {
    batchId: "batch-one",
    scopeId: "related-file",
    branch: "codex/candidate-cli",
    policyFingerprint: "a".repeat(64),
    environmentFingerprint: "b".repeat(64),
    testsFingerprint: "c".repeat(64),
    maxTasks: 2,
    scopePaths: ["file.txt"],
    stateDirectory: state,
    profiles: {
      local: [stage("local")],
      prepush: [stage("prepush")],
      final: [stage("final")],
    },
    ...overrides,
  };
  const path = join(home, "candidate-policy.json");
  await writeFile(path, JSON.stringify(policy), { mode: 0o600 });
  return { path, policy, trace, state, stage };
}
async function enqueue(path: string, id = "part-one") {
  expect(
    await main([
      "loop",
      "enqueue",
      "synthetic edit",
      "--workspace",
      repo,
      "--candidate-policy",
      path,
      "--id",
      id,
      "--json",
    ]),
  ).toBe(0);
  const disk = JSON.parse(
    await readFile(join(repo, `tasks/${id}.json`), "utf8"),
  );
  return disk;
}
function commitQueue() {
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "synthetic queue"]);
  logs = [];
}
function run(path: string, extras: string[] = []) {
  return main([
    "loop",
    "run",
    "--workspace",
    repo,
    "--candidate-policy",
    path,
    "--worktree",
    "--worktree-root",
    join(root, "worktrees"),
    "--source",
    "task_queue",
    "--execute",
    command("require('fs').appendFileSync('file.txt','x')"),
    "--max-iter",
    "1",
    "--json",
    ...extras,
  ]);
}
it("actual enqueue -> queue -> native worktree batch runs all stages and native verifier union", async () => {
  const input = await policyInput();
  for (const id of ["part-one", "part-two"]) {
    const task = await enqueue(input.path, id);
    expect(task.candidateBatch).toEqual(candidateBinding(input.policy));
    task.context = { require_git_diff: true, target_paths: ["file.txt"] };
    await writeFile(join(repo, `tasks/${id}.json`), JSON.stringify(task));
  }
  commitQueue();
  expect(await run(input.path, ["--verify", input.stage("mandatory")])).toBe(0);
  const result = JSON.parse(logs.join("\n"));
  expect(result.completed_tasks).toHaveLength(2);
  for (const task of result.completed_tasks)
    expect(task.candidate_evidence).toMatchObject({
      stage: "final_preflight_ready",
      accepted: false,
      remoteCI: "pending",
    });
  expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("baselinexx");
  expect((await readFile(input.trace, "utf8")).trim().split("\n")).toEqual([
    "mandatory",
    "local",
    "mandatory",
    "local",
    "mandatory",
    "prepush",
    "mandatory",
    "final",
  ]);
  expect(ports.acquire).toHaveBeenCalledWith(
    expect.objectContaining({ requiresAgent: false }),
  );
  expect(ports.release).toHaveBeenCalledTimes(1);
  await expect(readFile(join(repo, "LOOP-STATE.json"))).rejects.toThrow();
  expect(
    execFileSync("git", ["-C", repo, "status", "--porcelain"], {
      encoding: "utf8",
    }),
  ).toBe("");
});
it.each([
  "--daemon",
  "--state",
  "--markdown",
  "--goal",
  "--checkpoint",
  "--self-improvement",
  "--cycles",
  "--autonomy",
  "--archive-completed",
])("candidate incompatible %s refuses before admission, RPC or queue effects", async (flag) => {
  const input = await policyInput();
  expect(await run(input.path, [flag, "synthetic"])).toBe(1);
  expect(ports.acquire).not.toHaveBeenCalled();
  expect(ports.rpc).not.toHaveBeenCalled();
  expect(ports.db).not.toHaveBeenCalled();
  await expect(readFile(join(repo, "LOOP-STATE.json"))).rejects.toThrow();
});
it("actual malformed private policy refuses enqueue and run before mutation", async () => {
  const input = await policyInput({ unexpected: true });
  expect(
    await main([
      "loop",
      "enqueue",
      "synthetic",
      "--workspace",
      repo,
      "--candidate-policy",
      input.path,
    ]),
  ).toBe(1);
  expect(await run(input.path)).toBe(1);
  expect(ports.acquire).not.toHaveBeenCalled();
  await expect(readFile(join(repo, "tasks"))).rejects.toThrow();
});
it("actual mandatory native verify failure is not replaced by green policy stages", async () => {
  const input = await policyInput();
  await enqueue(input.path);
  commitQueue();
  expect(await run(input.path, ["--verify", command("process.exit(1)")])).toBe(
    2,
  );
  const result = JSON.parse(logs.join("\n"));
  expect(result.completed_tasks[0].candidate_evidence).toMatchObject({
    stage: "final_preflight_failed",
    accepted: false,
  });
  expect(ports.release).toHaveBeenCalledTimes(1);
});
it("actual queued wrong batch binding cannot execute shell or obtain readiness", async () => {
  const input = await policyInput();
  const task = await enqueue(input.path);
  task.candidateBatch.batchId = "foreign-batch";
  await writeFile(join(repo, "tasks/part-one.json"), JSON.stringify(task));
  commitQueue();
  await expect(run(input.path)).rejects.toThrow("CANDIDATE_BATCH_MISMATCH");
  expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("baseline");
  expect(ports.release).toHaveBeenCalledTimes(1);
});
it("actual final stage failure marks candidate failed and retains private one-shot claim", async () => {
  const input = await policyInput();
  input.policy.profiles.final = [command("process.exit(1)")];
  await writeFile(input.path, JSON.stringify(input.policy));
  await enqueue(input.path);
  commitQueue();
  expect(await run(input.path)).toBe(2);
  expect(
    JSON.parse(logs.join("\n")).completed_tasks[0].candidate_evidence.stage,
  ).toBe("final_preflight_failed");
  await expect(run(input.path)).rejects.toThrow(
    "CANDIDATE_BATCH_ALREADY_CLAIMED",
  );
});
it("actual candidate lease rejection has no shell effects or private batch claim", async () => {
  const input = await policyInput();
  await enqueue(input.path);
  commitQueue();
  ports.acquire.mockRejectedValue(new Error("synthetic held lease"));
  await expect(run(input.path)).rejects.toThrow("synthetic held lease");
  expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("baseline");
  expect(ports.release).not.toHaveBeenCalled();
  const { readdir } = await import("node:fs/promises");
  expect(await readdir(input.state)).toEqual([]);
});

it.each([
  "absent",
  "git_diff",
  "duplicate",
])("actual candidate source %s refuses before lease without changing legacy default", async (mode) => {
  const input = await policyInput();
  const args = [
    "loop",
    "run",
    "--workspace",
    repo,
    "--candidate-policy",
    input.path,
    "--worktree",
    "--json",
  ];
  if (mode === "git_diff") args.push("--source", "git_diff");
  if (mode === "duplicate")
    args.push("--source", "task_queue", "--source", "task_queue");
  expect(await main(args)).toBe(1);
  expect(ports.acquire).not.toHaveBeenCalled();
  expect(ports.rpc).not.toHaveBeenCalled();
});
it("actual required Task evaluation remains gating in candidate local stage", async () => {
  const input = await policyInput();
  const task = await enqueue(input.path);
  task.evaluation = [
    {
      id: "required-command",
      mode: "command",
      description: "required synthetic command",
      command: command("process.exit(1)"),
      required: true,
    },
  ];
  await writeFile(join(repo, "tasks/part-one.json"), JSON.stringify(task));
  commitQueue();
  expect(await run(input.path)).toBe(2);
  expect(
    JSON.parse(logs.join("\n")).completed_tasks[0].candidate_evidence.stage,
  ).toBe("final_preflight_failed");
  expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("baseline");
});

it("actual non-optin legacy goal/capability values named candidate-policy retain native parsing", async () => {
  expect(
    await main([
      "loop",
      "enqueue",
      "synthetic",
      "--workspace",
      repo,
      "--capability",
      "--candidate-policy",
      "--id",
      "literal",
      "--json",
    ]),
  ).toBe(0);
  expect(
    JSON.parse(await readFile(join(repo, "tasks/literal.json"), "utf8"))
      .capability,
  ).toBe("--candidate-policy");
  commitQueue();
  expect(
    await main([
      "loop",
      "run",
      "--workspace",
      repo,
      "--source",
      "task_queue",
      "--goal",
      "--candidate-policy",
      "--execute",
      command("require('fs').appendFileSync('file.txt','legacy')"),
      "--max-iter",
      "1",
      "--json",
    ]),
  ).toBe(0);
  expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("baselinelegacy");
  expect(ports.acquire).toHaveBeenCalledTimes(1);
  expect(ports.rpc).not.toHaveBeenCalled();
});
async function sourceMutant(
  anchor: string,
  replacement: string,
): Promise<typeof candidateInputModule> {
  const source = await readFile(
    new URL("./loop-candidate-input.ts", import.meta.url),
    "utf8",
  );
  expect(source.split(anchor)).toHaveLength(2);
  const sourceWithImport = source
    .replace(anchor, replacement)
    .replace(
      '"@osstack/loop"',
      JSON.stringify(new URL("../../loop/dist/index.js", import.meta.url).href),
    );
  const stripped = stripTypeScriptTypes(sourceWithImport, { mode: "strip" });
  const loader = compileFunction("return import(url)", ["url"], {
    importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  }) as (url: string) => Promise<typeof candidateInputModule>;
  return loader(
    `data:text/javascript;base64,${Buffer.from(stripped).toString("base64")}`,
  );
}
it("source mutant removing native stage union causes real unverified local merge after full positive baseline", async () => {
  const input = await policyInput();
  await enqueue(input.path);
  commitQueue();
  expect(await run(input.path)).toBe(0);
  async function nextBatch(id: string) {
    input.policy.batchId = id;
    await writeFile(input.path, JSON.stringify(input.policy));
    const task = JSON.parse(
      await readFile(join(repo, "tasks/part-one.json"), "utf8"),
    );
    task.candidateBatch = candidateBinding(input.policy);
    await writeFile(join(repo, "tasks/part-one.json"), JSON.stringify(task));
    commitQueue();
  }
  await nextBatch("baseline-reject");
  const before = await readFile(join(repo, "file.txt"), "utf8");
  expect(await run(input.path, ["--verify", command("process.exit(1)")])).toBe(
    2,
  );
  expect(await readFile(join(repo, "file.txt"), "utf8")).toBe(before);
  await nextBatch("mutant-union");
  const mutant = await sourceMutant(
    "[...new Set([...verifies, ...commands])]",
    "commands",
  );
  vi.spyOn(
    candidateInputModule,
    "withLoopCandidateVerifiers",
  ).mockImplementation(mutant.withLoopCandidateVerifiers);
  expect(await run(input.path, ["--verify", command("process.exit(1)")])).toBe(
    2,
  );
  // Final legacy gate still refuses acceptance; the killed mutant already merged an unverified local change.
  expect(await readFile(join(repo, "file.txt"), "utf8")).toBe(before + "x");
  expect(
    JSON.parse(logs.join("\n")).completed_tasks[0].candidate_evidence.stage,
  ).toBe("final_preflight_failed");
});
it("source mutant deleting private file mode guard accepts actual unsafe bytes after valid baseline", async () => {
  const input = await policyInput();
  const args = [
    "run",
    "--workspace",
    repo,
    "--source",
    "task_queue",
    "--worktree",
    "--candidate-policy",
    input.path,
  ];
  expect(await candidateInputModule.readLoopCandidateInput(args)).toEqual(
    input.policy,
  );
  const { chmod } = await import("node:fs/promises");
  await chmod(input.path, 0o644);
  await expect(
    candidateInputModule.readLoopCandidateInput(args),
  ).rejects.toThrow("LOOP_CANDIDATE_INPUT_INVALID");
  const mutant = await sourceMutant(
    "(before.mode & 0o7777) !== 0o600",
    "false",
  );
  expect(await mutant.readLoopCandidateInput(args)).toEqual(input.policy);
});

it("actual 64+1 mandatory union refuses before lease/DB/shell rather than dropping a gate", async () => {
  const input = await policyInput();
  input.policy.profiles.local = Array.from({ length: 64 }, (_, i) =>
    command(`process.exit(0); /* ${i} */`),
  );
  await writeFile(input.path, JSON.stringify(input.policy));
  expect(await run(input.path, ["--verify", command("process.exit(1)")])).toBe(
    1,
  );
  expect(ports.acquire).not.toHaveBeenCalled();
  expect(ports.db).not.toHaveBeenCalled();
  expect(ports.rpc).not.toHaveBeenCalled();
  expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("baseline");
});
it("actual nonoptin legacy knowledge-mode consumes candidate token without loading a policy", async () => {
  expect(
    await main([
      "loop",
      "enqueue",
      "synthetic",
      "--workspace",
      repo,
      "--id",
      "ordinary",
      "--json",
    ]),
  ).toBe(0);
  logs = [];
  expect(
    await main([
      "loop",
      "run",
      "--workspace",
      repo,
      "--source",
      "task_queue",
      "--execute",
      command("require('fs').appendFileSync('file.txt','legacy')"),
      "--knowledge-mode",
      "--candidate-policy",
      "--max-iter",
      "1",
      "--json",
    ]),
  ).toBe(0);
  expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("baselinelegacy");
  expect(ports.acquire).toHaveBeenCalledTimes(1);
});

it("actual candidate ignores unavailable implicit knowledge context without config reads/search despite synthetic cloud config/env", async () => {
  const input = await policyInput();
  await mkdir(join(home, "knowledge-cache"), { mode: 0o700 });
  await writeFile(
    join(home, "knowledge-cache/config.json"),
    JSON.stringify({
      cloud_url: "https://synthetic.invalid",
      token: "synthetic-marker-only",
    }),
    { mode: 0o600 },
  );
  process.env["OSSTACK_KNOWLEDGE_URL"] = "https://synthetic.invalid";
  process.env["OSSTACK_KNOWLEDGE_TOKEN"] = "synthetic-marker-only";
  await enqueue(input.path);
  commitQueue();
  expect(await run(input.path)).toBe(0);
  expect(ports.knowledgeRead).not.toHaveBeenCalled();
  expect(ports.knowledgeSearch).not.toHaveBeenCalled();
});

function fakeAdapter(id: string, kind: "code.write" | "code.review", invoke: AgentAdapter["invoke"]): AgentAdapter {
  return { id, display_name: id, cost_tier: "low", capabilities: () => [CapabilitySchema.parse({ id: `${id}.${kind}`, kind, agent_id: id, description: "synthetic local qualification", cost_tier: "low" })], isAvailable: async () => ({ available: true, last_checked_at: Date.now() }), runtimeIdentity: async () => ({ adapter_id: id, adapter_version: "test", auth_mode: "test", provider_id: id, model_id: id, evidence_source: "reported" }), invoke };
}
function done(task: Parameters<AgentAdapter["invoke"]>[0], status: "completed" | "failed") {
  return { event_id: randomUUID(), run_id: task.run_id, session_id: task.session_id, seq: 0, created_at: Date.now() / 1000, terminal: true, type: "done", payload: { status, result_summary: "synthetic local terminal", last_seq: 0 } };
}
function installAdapters(mode = "green") {
  let attempts = 0, reviews = 0;
  const builder = fakeAdapter("synthetic-builder", "code.write", async function* (task) {
    attempts++; ports.review("builder");
    if (mode === "unconfirmed") { yield done(task, "completed"); await new Promise<void>(() => {}); return; }
    await writeFile(join(String(task.context?.["repo_path"]), "file.txt"), "synthetic-built");
    yield done(task, "completed");
  });
  const reviewer = fakeAdapter("synthetic-reviewer", "code.review", async function* (task) {
    reviews++; ports.review("reviewer");
    yield done(task, (mode === "final-fail" && reviews === 3) || (mode === "recover" && reviews === 1) ? "failed" : "completed");
  });
  ports.adapters = [builder, reviewer];
  return { attempts: () => attempts, reviews: () => reviews };
}
function runAgent(path: string, extras: string[] = []) { return main(["loop", "run", "--workspace", repo, "--candidate-policy", path, "--worktree", "--worktree-root", join(root, "worktrees"), "--source", "task_queue", "--agent", "synthetic-builder", "--reviewer", "synthetic-reviewer", "--max-iter", "1", "--json", ...extras]); }
it("actual candidate same Builder/Evaluator refuses before admission and no candidate effects", async () => {
  const input = await policyInput(); await enqueue(input.path); commitQueue(); installAdapters();
  expect(await main(["loop", "run", "--workspace", repo, "--candidate-policy", input.path, "--worktree", "--source", "task_queue", "--agent", "synthetic-builder", "--reviewer", "synthetic-builder"])).toBe(1);
  expect(ports.acquire).not.toHaveBeenCalled(); expect(ports.review).not.toHaveBeenCalled(); expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("baseline");
});
it.each(["green", "final-fail", "recover"])("actual candidate %s reviewer runs every stage and no postfreeze hooks mutate evidence", async mode => {
  const input = await policyInput(); await enqueue(input.path); commitQueue(); const counts = installAdapters(mode);
  const args = ["loop", "run", "--workspace", repo, "--candidate-policy", input.path, "--worktree", "--worktree-root", join(root, "worktrees"), "--source", "task_queue", "--agent", "synthetic-builder", "--reviewer", "synthetic-reviewer", "--max-iter", mode === "recover" ? "2" : "1", "--json"];
  expect(await main(args)).toBe(mode === "final-fail" ? 2 : 0);
  const result = JSON.parse(logs.join("\n")); expect(result.completed_tasks[0].candidate_evidence.stage).toBe(mode === "final-fail" ? "final_preflight_failed" : "final_preflight_ready");
  expect(counts.reviews()).toBe(mode === "recover" ? 4 : 3); expect(counts.attempts()).toBe(mode === "recover" ? 2 : 1);
  for (const property of ["probe_observation", "artifacts", "learned_lessons", "knowledge_hygiene"]) expect(result).not.toHaveProperty(property);
  expect(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
  const { readdir } = await import("node:fs/promises"); expect(await readdir(home)).toEqual(["candidate-policy.json"]);
  expect(ports.db).not.toHaveBeenCalled(); expect(ports.release).toHaveBeenCalledTimes(1);
});
it.each(["forbidden-local", "target-miss"])("actual candidate artifact gate %s prevents readiness with base-range evidence", async mode => {
  const input = await policyInput(); await enqueue(input.path); commitQueue(); installAdapters();
  const extras = mode === "target-miss" ? ["--artifact-verification", "--target-path", "missing.txt"] : ["--artifact-verification", "--forbid-path", "file.txt"];
  expect(await runAgent(input.path, extras)).toBe(2);
  expect(JSON.parse(logs.join("\n")).completed_tasks[0].candidate_evidence.stage).toBe("final_preflight_failed");
  expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("baseline");
});
it("actual candidate unconfirmed synthetic producer retains lease/claim/worktree and never retries", async () => {
  const input = await policyInput(); await enqueue(input.path); commitQueue(); const counts = installAdapters("unconfirmed");
  expect(await runAgent(input.path, ["--command-timeout-ms", "30"])).toBe(2);
  const result = JSON.parse(logs.join("\n")); expect(result.completed_tasks[0]).toMatchObject({ outcome: "escalated", implementation_unconfirmed: true, candidate_evidence: { stage: "final_preflight_failed" } });
  expect(ports.retain).toHaveBeenCalledTimes(1); expect(ports.release).not.toHaveBeenCalled(); expect(counts.attempts()).toBe(1); expect(counts.reviews()).toBe(0);
  const { readdir } = await import("node:fs/promises"); expect(await readdir(input.state)).toContain("batch-batch-one");
  const branches = execFileSync("git", ["-C", repo, "branch", "--format=%(refname:short)"], { encoding: "utf8" }); expect(branches.split("\n").filter(v => v.startsWith("osstack/loop"))).toHaveLength(1);
  logs = []; expect(await runAgent(input.path)).toBe(2); expect(JSON.parse(logs.join("\n")).events).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({ reason_code: "execution_unconfirmed" }) })])); expect(counts.attempts()).toBe(1); expect(counts.reviews()).toBe(0); expect(ports.release).not.toHaveBeenCalled();
});

it("actual artifact checks reject a previously valid second task against complete frozen batch range", async () => {
  const input = await policyInput({ scopePaths: ["file.txt", "second.txt"] });
  await enqueue(input.path, "part-one"); const task = await enqueue(input.path, "part-two");
  task.evaluation = [{ id: "second-file-artifact", mode: "artifact", description: "second local edit may not include first-task file", required: true, target_paths: ["second.txt"], forbidden_paths: ["file.txt"] }];
  await writeFile(join(repo, "tasks/part-two.json"), JSON.stringify(task)); commitQueue(); installAdapters();
  ports.adapters[0] = fakeAdapter("synthetic-builder", "code.write", async function* (task) {
    ports.review("builder"); await writeFile(join(String(task.context?.["repo_path"]), task.task_id === "part-two" ? "second.txt" : "file.txt"), "synthetic-built"); yield done(task, "completed");
  });
  expect(await runAgent(input.path, ["--artifact-verification"])).toBe(2);
  const result = JSON.parse(logs.join("\n")); expect(result.completed_tasks).toHaveLength(2);
  for (const task of result.completed_tasks) expect(task.candidate_evidence.stage).toBe("final_preflight_failed");
  expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("synthetic-built"); expect(await readFile(join(repo, "second.txt"), "utf8")).toBe("synthetic-built");
  const { readdir } = await import("node:fs/promises"); const recordDir = join(input.state, (await readdir(input.state)).find(v => /^[a-f0-9]{64}$/.test(v))!);
  const stages = await Promise.all((await readdir(recordDir)).map(async file => JSON.parse(await readFile(join(recordDir, file), "utf8")).stage));
  expect(stages.filter(stage => stage === "candidate_commit")).toHaveLength(2); expect(stages).toContain("candidate_frozen"); expect(stages).not.toContain("final_preflight_ready");
});

it("actual candidate profile/role resolver derives separate builder/reviewer and preserves all stages", async () => {
  const input = await policyInput(); await enqueue(input.path); commitQueue(); const counts = installAdapters();
  const roles = { coding: { primary: "synthetic-builder", fallback: [] }, "test-verify": { primary: "synthetic-reviewer", fallback: [] }, design: { primary: "synthetic-designer", fallback: [] } };
  const config = defaultConfig(); config.active_profile = "synthetic"; config.profiles = { synthetic: { match: { hostnames: [], model_hints: [] }, roles } }; config.defaults.roles = roles;
  const path = join(home, "native-profile.yaml"); await writeFile(path, JSON.stringify(config), { mode: 0o600 }); process.env["OSSTACK_CONFIG"] = path;
  expect(await main(["loop", "run", "--workspace", repo, "--candidate-policy", input.path, "--worktree", "--worktree-root", join(root, "worktrees"), "--source", "task_queue", "--profile", "synthetic", "--role", "coder=synthetic-builder", "--role", "evaluator=synthetic-reviewer", "--max-iter", "1", "--json"])).toBe(0);
  expect(counts.attempts()).toBe(1); expect(counts.reviews()).toBe(3); expect(ports.acquire).toHaveBeenCalledWith(expect.objectContaining({ requiresAgent: true }));
  const result = JSON.parse(logs.join("\n")); expect(result.completed_tasks[0].candidate_evidence.stage).toBe("final_preflight_ready"); expect(result.profile).toMatchObject({ profile_name: "synthetic", builder_agent_id: "synthetic-builder", evaluator_agent_id: "synthetic-reviewer", independent: true });
  expect(ports.db).not.toHaveBeenCalled(); expect(ports.release).toHaveBeenCalledTimes(1);
});

it.each([{ value: [] as string[] }, { value: ["strict"] }])("actual optional govern $value with candidate refuses before lease/DB/shell", async ({ value }) => {
 const input = await policyInput(); await enqueue(input.path); commitQueue();
 expect(await main(["loop", "run", "--workspace", repo, "--govern", ...value, "--candidate-policy", input.path, "--worktree", "--source", "task_queue", "--execute", command("require('fs').appendFileSync('file.txt','unsafe')"), "--json"])).toBe(1);
 expect(ports.acquire).not.toHaveBeenCalled(); expect(ports.db).not.toHaveBeenCalled(); expect(ports.rpc).not.toHaveBeenCalled(); expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("baseline");
 const { readdir } = await import("node:fs/promises"); expect(await readdir(input.state)).toEqual([]);
});

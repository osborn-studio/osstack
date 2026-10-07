import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { compileFunction, constants as vmConstants } from "node:vm";
import { fileURLToPath } from "node:url";
import * as defaultsModule from "./loop-defaults.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentAdapter } from "@osstack/agents";
import { CapabilitySchema } from "@osstack/core";
import { defaultConfig } from "@osstack/config";
const ports = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  retain: vi.fn(),
  db: vi.fn(),
  rpc: vi.fn(),
  adapters: [] as AgentAdapter[],
  review: vi.fn(),
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
] as const;
let oldProfileEnv: Record<string, string | undefined>;
const command = (value: string) =>
  `${process.execPath} -e ${JSON.stringify(value)}`;
async function save(run: unknown[] = [], enqueue: unknown[] = []) {
  await mkdir(join(home, "loop-defaults"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(home, "loop-defaults/config.json"),
    JSON.stringify({ schemaVersion: 1, enabled: true, run, enqueue }),
    { mode: 0o600 },
  );
}
async function queue() {
  expect(
    await main([
      "loop",
      "enqueue",
      "synthetic task",
      "--workspace",
      repo,
      "--id",
      "task-one",
      "--json",
    ]),
  ).toBe(0);
  logs = [];
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "loop-defaults-cli-"));
  repo = join(root, "repo");
  home = join(root, "home");
  await mkdir(repo);
  await mkdir(home, { mode: 0o700 });
  execFileSync("git", ["init", "-q", repo]);
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
it("actual main enqueue uses defaults and keeps explicit id/prompt/priority", async () => {
  await save(
    [],
    [
      { flag: "--capability", value: "code.fix" },
      { flag: "--priority", value: "31" },
    ],
  );
  await queue();
  const result = JSON.parse(
    await readFile(join(repo, "tasks/task-one.json"), "utf8"),
  );
  expect(result).toMatchObject({
    task_id: "task-one",
    prompt: "synthetic task",
    capability: "code.fix",
    priority: 31,
  });
  expect(ports.acquire).not.toHaveBeenCalled();
});
it("actual main run executes persisted native command and verifier", async () => {
  await save([
    { flag: "--source", value: "task_queue" },
    {
      flag: "--execute",
      value: command("require('fs').writeFileSync('done.txt','actual')"),
    },
    {
      flag: "--verify",
      value: command(
        "if(require('fs').readFileSync('done.txt','utf8')!=='actual')process.exit(1)",
      ),
    },
  ]);
  await queue();
  expect(await main(["loop", "run", "--workspace", repo, "--json"])).toBe(0);
  expect(await readFile(join(repo, "done.txt"), "utf8")).toBe("actual");
  expect(JSON.parse(logs.join("\n")).completed_tasks[0].outcome).toBe(
    "success",
  );
  expect(ports.acquire).toHaveBeenCalledWith(
    expect.objectContaining({ requiresAgent: false }),
  );
  expect(ports.release).toHaveBeenCalledTimes(1);
});
it.each([
  "configured",
  "explicit",
])("actual main keeps %s failing verify gate", async (failing) => {
  await save([
    { flag: "--source", value: "task_queue" },
    { flag: "--execute", value: command("process.exit(0)") },
    {
      flag: "--verify",
      value: command(`process.exit(${failing === "configured" ? 1 : 0})`),
    },
    { flag: "--max-iter", value: "1" },
  ]);
  await queue();
  expect(
    await main([
      "loop",
      "run",
      "--workspace",
      repo,
      "--verify",
      command(`process.exit(${failing === "explicit" ? 1 : 0})`),
      "--json",
    ]),
  ).toBe(2);
  expect(JSON.parse(logs.join("\n")).completed_tasks[0].outcome).not.toBe(
    "success",
  );
  expect(ports.release).toHaveBeenCalledTimes(1);
});
it("actual explicit execute overrides default while verify still runs", async () => {
  await save([
    { flag: "--source", value: "task_queue" },
    { flag: "--execute", value: command("process.exit(1)") },
    {
      flag: "--verify",
      value: command(
        "if(!require('fs').existsSync('explicit.txt'))process.exit(1)",
      ),
    },
  ]);
  await queue();
  expect(
    await main([
      "loop",
      "run",
      "--workspace",
      repo,
      "--execute",
      command("require('fs').writeFileSync('explicit.txt','ok')"),
      "--json",
    ]),
  ).toBe(0);
  expect(await readFile(join(repo, "explicit.txt"), "utf8")).toBe("ok");
});
it("invalid preferences refuse before queue/control DB/lease effects", async () => {
  await mkdir(join(home, "loop-defaults"), { mode: 0o700 });
  await writeFile(
    join(home, "loop-defaults/config.json"),
    '{"secret":"not echoed"}',
    { mode: 0o600 },
  );
  expect(await main(["loop", "run", "--workspace", repo])).toBe(1);
  expect(
    await main(["loop", "enqueue", "synthetic", "--workspace", repo]),
  ).toBe(1);
  expect(ports.acquire).not.toHaveBeenCalled();
  expect(ports.db).not.toHaveBeenCalled();
});
it("reviewer-only defaults use agent admission and actual synthetic failing adapter", async () => {
  ports.adapters = [
    {
      id: "synthetic-reviewer",
      display_name: "Synthetic",
      cost_tier: "low",
      capabilities: () => [],
      isAvailable: async () => ({
        available: true,
        last_checked_at: Date.now(),
      }),
      invoke: async function* (task) {
        ports.review(task);
        yield {
          event_id: randomUUID(),
          run_id: task.run_id,
          session_id: task.session_id,
          seq: 0,
          created_at: Date.now() / 1000,
          terminal: true,
          type: "done",
          payload: {
            status: "failed",
            result_summary: "synthetic refusal",
            last_seq: 0,
          },
        };
      },
    },
  ];
  await save([
    { flag: "--source", value: "task_queue" },
    { flag: "--execute", value: command("process.exit(0)") },
    { flag: "--reviewer", value: "synthetic-reviewer" },
    { flag: "--max-iter", value: "1" },
  ]);
  await queue();
  expect(await main(["loop", "run", "--workspace", repo, "--json"])).toBe(2);
  expect(ports.acquire).toHaveBeenCalledWith(
    expect.objectContaining({ requiresAgent: true }),
  );
  expect(ports.review).toHaveBeenCalled();
  expect(ports.release).toHaveBeenCalledTimes(1);
});
it("lease rejection retains old no-execution behavior", async () => {
  await save([
    { flag: "--source", value: "task_queue" },
    {
      flag: "--execute",
      value: command("require('fs').writeFileSync('escape.txt','bad')"),
    },
  ]);
  await queue();
  ports.acquire.mockRejectedValue(new Error("synthetic held lease"));
  await expect(main(["loop", "run", "--workspace", repo])).rejects.toThrow(
    "synthetic held lease",
  );
  expect(ports.release).not.toHaveBeenCalled();
  await expect(readFile(join(repo, "escape.txt"))).rejects.toThrow();
});

it("actual enqueue consumes flag-looking capability value without losing default priority", async () => {
  await save([], [{ flag: "--priority", value: "31" }]);
  expect(
    await main([
      "loop",
      "enqueue",
      "synthetic prompt",
      "--workspace",
      repo,
      "--capability",
      "--priority",
      "--id",
      "consumption",
      "--json",
    ]),
  ).toBe(0);
  expect(
    JSON.parse(await readFile(join(repo, "tasks/consumption.json"), "utf8")),
  ).toMatchObject({
    prompt: "synthetic prompt",
    capability: "--priority",
    priority: 31,
  });
});
it("actual run consumes flag-looking verify value while native default iteration still applies", async () => {
  await save([
    { flag: "--source", value: "task_queue" },
    { flag: "--execute", value: command("process.exit(0)") },
    { flag: "--max-iter", value: "1" },
  ]);
  await queue();
  expect(
    await main([
      "loop",
      "run",
      "--workspace",
      repo,
      "--verify",
      "--max-iter",
      "--json",
    ]),
  ).toBe(2);
  expect(JSON.parse(logs.join("\n")).completed_tasks[0].iterations).toBe(1);
});

async function sourceMutant(
  before: string,
  after: string,
): Promise<typeof defaultsModule> {
  const source = await readFile(
    fileURLToPath(new URL("./loop-defaults.ts", import.meta.url)),
    "utf8",
  );
  expect(source.split(before)).toHaveLength(2); // Missing anchors never count as behavior kills.
  const stripped = stripTypeScriptTypes(source.replace(before, after), {
    mode: "strip",
  });
  const nodeImport = compileFunction("return import(url)", ["url"], {
    importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  }) as (url: string) => Promise<typeof defaultsModule>;
  return nodeImport(
    `data:text/javascript;base64,${Buffer.from(stripped).toString("base64")}`,
  );
}
it("source mutation omitting defaults demonstrably loses configured actual execution after valid baseline", async () => {
  await save([
    {
      flag: "--execute",
      value: command("require('fs').writeFileSync('injected.txt','real')"),
    },
  ]);
  await queue();
  const args = [
    "loop",
    "run",
    "--workspace",
    repo,
    "--source",
    "task_queue",
    "--json",
  ];
  expect(await main(args)).toBe(0);
  expect(await readFile(join(repo, "injected.txt"), "utf8")).toBe("real");
  await rm(join(repo, "injected.txt"));
  await rm(join(repo, "LOOP-STATE.json"));
  logs = [];
  const mutant = await sourceMutant(
    "return [args[0]!, ...prefix, ...args.slice(1)];",
    "return args;",
  );
  vi.spyOn(defaultsModule, "applyLoopDefaults").mockImplementation(
    mutant.applyLoopDefaults,
  );
  await main(args);
  await expect(readFile(join(repo, "injected.txt"))).rejects.toThrow();
});
it("source mutation dropping default verifier gives real corrupt-byte false success after valid baseline", async () => {
  await save([
    {
      flag: "--verify",
      value: command(
        "if(require('fs').readFileSync('bytes.txt','utf8')!=='good')process.exit(1)",
      ),
    },
  ]);
  await queue();
  const args = [
    "loop",
    "run",
    "--workspace",
    repo,
    "--source",
    "task_queue",
    "--execute",
    command("require('fs').writeFileSync('bytes.txt','good')"),
    "--verify",
    command("process.exit(0)"),
    "--json",
  ];
  expect(await main(args)).toBe(0);
  expect(await readFile(join(repo, "bytes.txt"), "utf8")).toBe("good");
  await rm(join(repo, "LOOP-STATE.json"));
  logs = [];
  const mutant = await sourceMutant(
    "for (const entry of defaults) {",
    'for (const entry of defaults) { if (entry.flag === "--verify") continue;',
  );
  vi.spyOn(defaultsModule, "applyLoopDefaults").mockImplementation(
    mutant.applyLoopDefaults,
  );
  args[args.indexOf("--execute") + 1] = command(
    "require('fs').writeFileSync('bytes.txt','bad')",
  );
  expect(await main(args)).toBe(0);
  expect(await readFile(join(repo, "bytes.txt"), "utf8")).toBe("bad");
  expect(JSON.parse(logs.join("\n")).completed_tasks[0].outcome).toBe(
    "success",
  );
});

it("invalid numeric default refuses before admission", async () => {
  await save([{ flag: "--max-iter", value: "not-a-number" }]);
  expect(await main(["loop", "run", "--workspace", repo])).toBe(1);
  expect(ports.acquire).not.toHaveBeenCalled();
  expect(ports.db).not.toHaveBeenCalled();
});

it("default flag-token value refuses actual main before RPC/lease/queue", async () => {
  await save([{ flag: "--verify", value: "--daemon" }]);
  expect(await main(["loop", "run", "--workspace", repo])).toBe(1);
  expect(
    await main(["loop", "enqueue", "synthetic", "--workspace", repo]),
  ).toBe(1);
  expect(ports.rpc).not.toHaveBeenCalled();
  expect(ports.acquire).not.toHaveBeenCalled();
  expect(ports.db).not.toHaveBeenCalled();
  await expect(readFile(join(repo, "tasks/task-one.json"))).rejects.toThrow();
});

// Actual main/profile/config/resolver path; only admission and agent ports are synthetic.
async function nativeProfileFixture() {
  const roles = {
    coding: { primary: "synthetic-builder", fallback: [] },
    "test-verify": { primary: "synthetic-evaluator", fallback: [] },
    design: { primary: "synthetic-designer", fallback: [] },
  };
  const config = defaultConfig();
  config.active_profile = "synthetic";
  config.profiles = {
    synthetic: { match: { hostnames: [], model_hints: [] }, roles },
  };
  config.defaults.roles = roles;
  await writeFile(join(home, "native-config.yaml"), JSON.stringify(config), {
    mode: 0o600,
  });
  process.env["OSSTACK_CONFIG"] = join(home, "native-config.yaml");
  ports.adapters = ["builder", "evaluator"].map((role): AgentAdapter => {
    const id = `synthetic-${role}`;
    const kind = role === "builder" ? "code.write" : "code.review";
    return {
      id,
      display_name: id,
      cost_tier: "low",
      capabilities: () => [
        CapabilitySchema.parse({
          id: `${id}.${kind}`,
          kind,
          agent_id: id,
          description: "synthetic local fixture",
          cost_tier: "low",
        }),
      ],
      isAvailable: async () => ({
        available: true,
        last_checked_at: Date.now(),
      }),
      runtimeIdentity: async () => ({
        adapter_id: id,
        adapter_version: "1.0.0",
        auth_mode: "test",
        provider_id: `synthetic-${role}`,
        model_id: role,
        evidence_source: "reported",
      }),
      invoke: async function* (task) {
        ports.review(role);
        if (role === "builder")
          await writeFile(
            join(repo, "profile-executed.txt"),
            "synthetic builder",
          );
        yield {
          event_id: randomUUID(),
          run_id: task.run_id,
          session_id: task.session_id,
          seq: 0,
          created_at: Date.now() / 1000,
          terminal: true,
          type: "done",
          payload: {
            status: role === "builder" ? "completed" : "failed",
            result_summary: "synthetic local fixture",
            last_seq: 0,
          },
        };
      },
    };
  });
}
it("actual missing-config ordinary run preserves native execution and admission", async () => {
  await queue();
  expect(
    await main([
      "loop",
      "run",
      "--workspace",
      repo,
      "--source",
      "task_queue",
      "--execute",
      command("require('fs').writeFileSync('legacy.txt','ok')"),
      "--verify",
      command("process.exit(0)"),
      "--max-iter",
      "1",
      "--json",
    ]),
  ).toBe(0);
  expect(await readFile(join(repo, "legacy.txt"), "utf8")).toBe("ok");
  expect(ports.acquire).toHaveBeenCalledWith(
    expect.objectContaining({ requiresAgent: false }),
  );
  expect(ports.release).toHaveBeenCalledTimes(1);
  expect(ports.rpc).not.toHaveBeenCalled();
  // Any legacy observation DB attempt terminates at the throwing synthetic port.
});
it.each([
  "--reviewer",
  "--checker",
])("actual missing-config %s uses agent admission and native verifier invocation", async (flag) => {
  await nativeProfileFixture();
  await queue();
  expect(
    await main([
      "loop",
      "run",
      "--workspace",
      repo,
      "--source",
      "task_queue",
      "--execute",
      command("process.exit(0)"),
      flag,
      "synthetic-evaluator",
      "--max-iter",
      "1",
      "--json",
    ]),
  ).toBe(2);
  expect(ports.acquire).toHaveBeenCalledWith(
    expect.objectContaining({ requiresAgent: true }),
  );
  expect(ports.review).toHaveBeenCalledWith("evaluator");
  expect(ports.release).toHaveBeenCalledTimes(1);
});
it("actual explicit execute suppresses persisted profile and roles without native routing", async () => {
  await save([
    { flag: "--profile", value: "unavailable-profile" },
    { flag: "--role", value: "coder=unavailable" },
    { flag: "--source", value: "task_queue" },
    { flag: "--verify", value: command("process.exit(0)") },
    { flag: "--max-iter", value: "1" },
  ]);
  await queue();
  expect(
    await main([
      "loop",
      "run",
      "--workspace",
      repo,
      "--execute",
      command("require('fs').writeFileSync('explicit.txt','ok')"),
      "--json",
    ]),
  ).toBe(0);
  expect(await readFile(join(repo, "explicit.txt"), "utf8")).toBe("ok");
  expect(ports.acquire).toHaveBeenCalledWith(
    expect.objectContaining({ requiresAgent: false }),
  );
});
it("actual explicit profile suppresses persisted shell and derives native agent/reviewer admission", async () => {
  await nativeProfileFixture();
  await save([
    {
      flag: "--execute",
      value: command("require('fs').writeFileSync('wrong-default.txt','bad')"),
    },
    { flag: "--source", value: "task_queue" },
    { flag: "--max-iter", value: "1" },
  ]);
  await queue();
  expect(
    await main([
      "loop",
      "run",
      "--workspace",
      repo,
      "--profile",
      "synthetic",
      "--json",
    ]),
  ).toBe(2);
  expect(await readFile(join(repo, "profile-executed.txt"), "utf8")).toBe(
    "synthetic builder",
  );
  await expect(readFile(join(repo, "wrong-default.txt"))).rejects.toThrow();
  expect(ports.acquire).toHaveBeenCalledWith(
    expect.objectContaining({ requiresAgent: true }),
  );
  expect(ports.review).toHaveBeenCalledWith("builder");
  expect(ports.review).toHaveBeenCalledWith("evaluator");
  expect(ports.release).toHaveBeenCalledTimes(1);
});
it("actual nonlegacy autonomy bypasses malformed preferences and uses original native routing", async () => {
  await nativeProfileFixture();
  await queue();
  await mkdir(join(home, "loop-defaults"), { mode: 0o700 });
  await writeFile(join(home, "loop-defaults/config.json"), "malformed", {
    mode: 0o600,
  });
  expect(
    await main([
      "loop",
      "run",
      "--workspace",
      repo,
      "--autonomy",
      "guarded",
      "--source",
      "task_queue",
      "--max-iter",
      "1",
      "--json",
    ]),
  ).toBe(2);
  expect(await readFile(join(repo, "profile-executed.txt"), "utf8")).toBe(
    "synthetic builder",
  );
  expect(ports.acquire).toHaveBeenCalledWith(
    expect.objectContaining({ requiresAgent: true }),
  );
  expect(ports.rpc).not.toHaveBeenCalled();
  // Any legacy observation DB attempt terminates at the throwing synthetic port.
});
it("actual enqueue run-only token cannot consume explicit priority during defaults lookup", async () => {
  await save([], [{ flag: "--priority", value: "31" }]);
  expect(
    await main([
      "loop",
      "enqueue",
      "--workspace",
      repo,
      "--verify",
      "--priority",
      "5",
      "synthetic prompt",
      "--id",
      "priority-case",
      "--json",
    ]),
  ).toBe(0);
  expect(
    JSON.parse(await readFile(join(repo, "tasks/priority-case.json"), "utf8"))
      .priority,
  ).toBe(5);
  expect(ports.acquire).not.toHaveBeenCalled();
});

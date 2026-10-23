import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTask } from "@osstack/agents";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createImprovementExecutionAdapters } from "./improvement-execution-adapters.js";

let directory: string;
let workspacePath: string;
let homePath: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "osstack-candidate-adapters-")));
  workspacePath = join(directory, "workspace");
  homePath = join(directory, "control");
  await mkdir(workspacePath);
  await mkdir(homePath);
  await mkdir(join(directory, ".codex"));
  vi.stubEnv("HOME", directory);
  vi.stubEnv("CODEX_HOME", join(directory, ".codex"));
  vi.stubEnv("OSSTACK_AUTOAPPROVE", "1");
  vi.stubEnv("OSSTACK_HOME", "/ambient/control");
  vi.stubEnv("AMBIENT_SECRET", "must-not-reach-child");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

const options = () => ({ workspacePath, homePath, builderAgentId: "codex-cli", evaluatorAgentId: "kimi-code" });
const task = (): AgentTask => ({ run_id: "candidate-run", task_id: "candidate-task", session_id: "candidate-session",
  capability_id: "codex-cli.code.write", prompt: "Implement the candidate", context: { repo_path: workspacePath } });
const drain = async (events: AsyncIterable<HermesEvent>) => {
  const result: HermesEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
};
const statuses = (events: HermesEvent[]) => events.filter((event) => event.type === "done").map((event) => (event.payload as { status: string }).status);
async function binary(name: string, body: string) {
  const path = join(directory, name);
  await writeFile(path, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return path;
}

describe("createImprovementExecutionAdapters", () => {
  it("exposes only the supported routing registry and prevents executing its unbound adapters", async () => {
    const adapters = createImprovementExecutionAdapters();
    expect(adapters.map((adapter) => adapter.id)).toEqual(["codex-cli", "kimi-code"]);
    for (const adapter of adapters) await expect(drain(adapter.invoke(task(), new AbortController().signal))).rejects.toThrow(/preflight|bound/i);
  });

  it.each([
    { builderAgentId: "claude-code" }, { evaluatorAgentId: "codex-cli" }, { evaluatorAgentId: "ds-review" },
    { workspacePath: "relative" }, { homePath: "relative" },
  ])("rejects unsupported or unbound execution options: %j", (change) => {
    expect(() => createImprovementExecutionAdapters({ ...options(), ...change })).toThrow(/codex-cli|kimi-code|absolute/i);
  });

  it.each([
    ["empty-exit", "", 0, "failed"],
    ["truncated", 'console.log(JSON.stringify({type:"thread.started",thread_id:"thread"}));', 0, "failed"],
    ["native-failed", 'console.log(JSON.stringify({type:"turn.completed"}));', 3, "failed"],
    ["native-completed", 'console.log(JSON.stringify({type:"turn.completed"}));', 0, "completed"],
  ])("uses real Codex process receipts: %s", async (name, body, code, expected) => {
    vi.stubEnv("OSSTACK_CODEX_BIN", await binary(String(name), `${body}\nprocess.exitCode = ${code};`));
    const builder = createImprovementExecutionAdapters(options())[0]!;
    expect(statuses(await drain(builder.invoke(task(), new AbortController().signal)))).toEqual([expected]);
  });

  it("binds workspace-write, per-execution home and a filtered child environment without changing parent state", async () => {
    const log = join(directory, "builder.json");
    vi.stubEnv("OSSTACK_CODEX_BIN", await binary("builder-env", `
require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),env:process.env}));
console.log(JSON.stringify({type:"turn.completed"}));
`));
    const builder = createImprovementExecutionAdapters(options())[0]!;
    expect(statuses(await drain(builder.invoke(task(), new AbortController().signal)))).toEqual(["completed"]);
    const captured = JSON.parse(await readFile(log, "utf8")) as { args: string[]; cwd: string; env: Record<string, string> };
    expect(captured.args).toContain("workspace-write");
    expect(captured.args).not.toContain("danger-full-access");
    expect(captured.cwd).toBe(workspacePath);
    expect(captured.env["OSSTACK_HOME"]).toBe(homePath);
    expect(captured.env["OSSTACK_AUTOAPPROVE"]).toBe("0");
    expect(captured.env).not.toHaveProperty("AMBIENT_SECRET");
    expect(process.env["OSSTACK_HOME"]).toBe("/ambient/control");
    expect(process.env["OSSTACK_AUTOAPPROVE"]).toBe("1");
    await expect(drain(builder.invoke({ ...task(), context: { repo_path: directory } }, new AbortController().signal))).rejects.toThrow(/workspace/i);
  });

  it("does not report success when cancelled after native completion but before process exit", async () => {
    vi.stubEnv("OSSTACK_CODEX_BIN", await binary("builder-wait", `console.log(JSON.stringify({type:"turn.completed"})); setInterval(()=>{},1000);`));
    const builder = createImprovementExecutionAdapters(options())[0]!;
    const controller = new AbortController();
    const events: HermesEvent[] = [];
    for await (const event of builder.invoke(task(), controller.signal)) {
      events.push(event);
      if (event.type === "usage.final") controller.abort();
    }
    expect(statuses(events)).toEqual(["cancelled"]);
  });

  it("uses the bundled no-tool Kimi reviewer and forwards real structured judgments with isolated home", async () => {
    const log = join(directory, "reviewer.json");
    vi.stubEnv("OSSTACK_KIMI_REVIEW_AGENT_FILE", "/ambient/unsafe-profile.md");
    vi.stubEnv("OSSTACK_KIMI_MODEL", "kimi-code/k3");
    vi.stubEnv("OSSTACK_KIMI_PROVIDER", "kimi");
    const result = { schema_version: 1, review_id: "review_1", subject_run_id: "candidate-run",
      reviewer: { adapter: "kimi-code", provider: "kimi", model: "kimi-code/k3" }, verdict: "approved", risk: "read_only",
      markdown: "The change meets the requirement.", evaluation_judgments: [{ id: "criterion", pass: true, severity: "error", summary: "Reviewed diff" }],
      findings: [], recommended_actions: [] };
    vi.stubEnv("OSSTACK_KIMI_BIN", await binary("reviewer", `
if (process.argv.includes("--version")) { console.log("0.29.1"); }
else {
require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),env:process.env}));
console.log(JSON.stringify({role:"assistant",content:${JSON.stringify(`OSSTACK_REVIEW_RESULT=${JSON.stringify(result)}`)}}));
}`));
    const reviewer = createImprovementExecutionAdapters(options())[1]!;
    const reviewTask = { ...task(), capability_id: "kimi-code.code.review", context: { repo_path: workspacePath,
      kimi_review_input: { schema_version: 1, task: "Review this change", evaluation_criteria: [{ id: "criterion", requirement: "Implements proposal" }],
        changed_paths: ["docs/file.md"], diff: "+a better sentence", deterministic_results: [], evidence_refs: [] } } };
    const events = await drain(reviewer.invoke(reviewTask, new AbortController().signal));
    expect(statuses(events)).toEqual(["completed"]);
    expect(events.at(-1)?.payload).toMatchObject({ evaluation_judgments: result.evaluation_judgments });
    const captured = JSON.parse(await readFile(log, "utf8")) as { args: string[]; cwd: string; env: Record<string, string> };
    const profile = captured.args[captured.args.indexOf("--agent-file") + 1]!;
    expect(profile).not.toBe("/ambient/unsafe-profile.md");
    expect(await readFile(profile, "utf8")).toContain("tools: []");
    expect(captured.cwd).not.toBe(workspacePath);
    expect(captured.env["OSSTACK_HOME"]).toBe(homePath);
    expect(captured.env["OSSTACK_AUTOAPPROVE"]).toBe("0");
    expect(captured.env).not.toHaveProperty("AMBIENT_SECRET");
  });
});

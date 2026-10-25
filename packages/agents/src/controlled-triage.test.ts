import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as childProcesses from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createControlledTriageProvider } from "./controlled-triage.js";
import type { ControlledSessionQuery } from "./controlled-session.js";
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const roots: string[] = []; afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup(query: ControlledSessionQuery) { const path = await mkdtemp(join(tmpdir(), "triage-provider-")); roots.push(path); return createControlledTriageProvider({ state_directory: path, model_id: "exact-model", max_cost_usd: 0.01, environment: { ANTHROPIC_API_KEY: "test", NODE_OPTIONS: "--inspect", OSSTACK_HOME: "/private" }, query }); }
function init(cwd: string) { return { type: "system", subtype: "init", cwd, model: "exact-model", permissionMode: "dontAsk", tools: [], mcp_servers: [], plugins: [], skills: [] }; }
it("invokes an independent fixed no-tools exact-model runtime with usage", async () => {
  const provider = await setup(({ options }) => (async function* () {
    expect(options).toMatchObject({ tools: [], allowedTools: [], mcpServers: {}, hooks: {}, plugins: [], settingSources: [], maxTurns: 1, persistSession: false, model: "exact-model", maxBudgetUsd: 0.01 });
    expect(options.env).not.toHaveProperty("ANTHROPIC_BASE_URL"); expect(options.env).not.toHaveProperty("NODE_OPTIONS");
    expect(options.settings).toMatchObject({ disableAllHooks: true, autoMemoryEnabled: false });
    yield init(options.cwd!); yield { type: "result", subtype: "success", result: '{"category":"human_decision","explanation":"choice"}', usage: { input_tokens: 3, output_tokens: 4 } };
  })());
  expect(await provider.policy()).toMatchObject({ profile: "claude-triage-no-tools-v1", model_id: "exact-model" });
  expect(await provider.invoke("untrusted question", new AbortController().signal)).toMatchObject({ reported_model: "exact-model", usage: { input_tokens: 3, output_tokens: 4 } });
});
it.each(["tools", "model", "missing_usage", "tool_activity"])("rejects unqualified runtime: %s", async kind => {
  const provider = await setup(({ options }) => (async function* () {
    yield { ...init(options.cwd!), ...(kind === "tools" ? { tools: ["Bash"] } : {}), ...(kind === "model" ? { model: "fallback-model" } : {}) };
    if (kind === "tool_activity") yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } };
    yield { type: "result", subtype: "success", result: "{}", ...(kind === "missing_usage" ? {} : { usage: { input_tokens: 1, output_tokens: 1 } }) };
  })());
  await expect(provider.invoke("question", new AbortController().signal)).rejects.toThrow();
});


it("does not reroute a custom-endpoint credential to the official API", async () => {
  const path = await mkdtemp(join(tmpdir(), "triage-auth-")); roots.push(path); let calls = 0;
  const provider = createControlledTriageProvider({ state_directory: path, model_id: "exact-model", max_cost_usd: 0.01,
    environment: { ANTHROPIC_API_KEY: "gateway-only", ANTHROPIC_BASE_URL: "https://gateway.invalid" },
    query: () => { calls++; return (async function* () {})(); } });
  await expect(provider.invoke("question", new AbortController().signal)).rejects.toThrow("unsupported_auth_routing"); expect(calls).toBe(0);
});


function fakeChild(terminates: boolean) {
  const events = new EventEmitter();
  return Object.assign(events, { pid: 12345, exitCode: null, killed: false, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { if (terminates) queueMicrotask(() => events.emit("exit", null, "SIGTERM")); return true; }) });
}
it("observes child exit and supplies an isolated environment at the actual spawn boundary", async () => {
  const child = fakeChild(true); const spawn = vi.spyOn(childProcesses, "spawn").mockReturnValue(child as unknown as ReturnType<typeof childProcesses.spawn>);
  const provider = await setup(({ options }) => (async function* () {
    options.spawnClaudeCodeProcess!({ command: options.pathToClaudeCodeExecutable!, args: ["--sdk-test"], cwd: options.cwd!, env: { NODE_OPTIONS: "--inspect", ANTHROPIC_BASE_URL: "https://ambient.invalid", CLAUDE_CODE_USE_BEDROCK: "1" }, signal: new AbortController().signal });
    yield init(options.cwd!); yield { type: "result", subtype: "success", result: "{}", usage: { input_tokens: 1, output_tokens: 1 } };
  })());
  await provider.invoke("question", new AbortController().signal);
  expect(child.kill).toHaveBeenCalled(); const options = spawn.mock.calls[0]![2] as childProcesses.SpawnOptions;
  expect(options.env).toHaveProperty("ANTHROPIC_API_KEY", "test");
  for (const key of ["NODE_OPTIONS", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "OSSTACK_HOME"]) expect(options.env).not.toHaveProperty(key);
  expect(options.shell).toBeUndefined();
});
it("quarantines its own provider when a live child never confirms termination", async () => {
  const child = fakeChild(false); vi.spyOn(childProcesses, "spawn").mockReturnValue(child as unknown as ReturnType<typeof childProcesses.spawn>);
  const provider = await setup(({ options }) => (async function* () {
    options.spawnClaudeCodeProcess!({ command: options.pathToClaudeCodeExecutable!, args: [], cwd: options.cwd!, env: {}, signal: new AbortController().signal });
    yield init(options.cwd!); yield { type: "result", subtype: "success", result: "{}", usage: { input_tokens: 1, output_tokens: 1 } };
  })());
  await expect(provider.invoke("question", new AbortController().signal)).rejects.toThrow("provider_stop_unconfirmed");
  await expect(provider.invoke("retry", new AbortController().signal)).rejects.toThrow("triage_provider_busy");
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});

it("rejects delayed SDK process creation after cancellation", async () => {
  const controller = new AbortController(); const spawn = vi.spyOn(childProcesses, "spawn");
  const provider = await setup(({ options }) => (async function* () {
    controller.abort();
    options.spawnClaudeCodeProcess!({ command: options.pathToClaudeCodeExecutable!, args: [], cwd: options.cwd!, env: {}, signal: controller.signal });
    yield init(options.cwd!);
  })());
  await expect(provider.invoke("question", controller.signal)).rejects.toThrow("cancelled");
  expect(spawn).not.toHaveBeenCalled();
});

it("detailed receipts bind API message identity, cache usage and confirmed child exit", async () => {
  const child = fakeChild(true); vi.spyOn(childProcesses, "spawn").mockReturnValue(child as unknown as ReturnType<typeof childProcesses.spawn>);
  const path = await mkdtemp(join(tmpdir(), "triage-detailed-")); roots.push(path);
  const provider = createControlledTriageProvider({ state_directory: path, model_id: "exact-model", max_cost_usd: 0.01, detailed_receipt: true,
    environment: { ANTHROPIC_API_KEY: "test" }, query: ({ options }) => (async function* () {
      options.spawnClaudeCodeProcess!({ command: options.pathToClaudeCodeExecutable!, args: [], cwd: options.cwd!, env: {}, signal: new AbortController().signal });
      yield init(options.cwd!); yield { type: "assistant", message: { model: "exact-model", content: [{ type: "text", text: "{}" }] } };
      yield { type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } };
    })() });
  expect(await provider.invoke("question", new AbortController().signal)).toMatchObject({ api_reported_model: "exact-model", process_exit_confirmed: true,
    usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } });
});

it("rejects API model substitution even when init echoes requested model", async () => {
  const path = await mkdtemp(join(tmpdir(), "triage-substitution-")); roots.push(path);
  const provider = createControlledTriageProvider({ state_directory: path, model_id: "exact-model", max_cost_usd: 0.01, detailed_receipt: true,
    environment: { ANTHROPIC_API_KEY: "test" }, query: ({ options }) => (async function* () {
      yield init(options.cwd!); yield { type: "assistant", message: { model: "substitute", content: [{ type: "text", text: "{}" }] } };
    })() });
  await expect(provider.invoke("question", new AbortController().signal)).rejects.toThrow("model_identity_mismatch");
});

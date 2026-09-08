import { chmod, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "./base.js";
import type { AgentSessionInput } from "./session.js";
import { createControlledSessionAdapter, isControlledSessionAdapter, type ControlledSessionQuery } from "./controlled-session.js";

const binaryFixture = vi.hoisted(() => ({ nextBytes: undefined as string | undefined }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      if (binaryFixture.nextBytes === undefined) return actual.createReadStream(...args);
      const bytes = binaryFixture.nextBytes;
      binaryFixture.nextBytes = undefined;
      return Readable.from([bytes]);
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  binaryFixture.nextBytes = undefined;
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "osstack-controlled-test-"));
  roots.push(path);
  return path;
}
const task: AgentTask = { run_id: "run", task_id: "task", session_id: "session", capability_id: "session", prompt: "Review the supplied plan", context: { repo_path: "/untrusted/project", permissionMode: "bypassPermissions" } };
function input(native = "native-private"): AgentSessionInput {
  return { ...task, turn_id: "turn-2", native_session_id: native, expected_version: 2, message_id: "message-2", prompt: "Continue the review" };
}
function init(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "system", subtype: "init", session_id: "native-private", model: "claude-sonnet-4-6", permissionMode: "dontAsk", tools: [], mcp_servers: [], plugins: [], skills: [], ...extra };
}
const result = { type: "result", subtype: "success", result: "Ready", is_error: false };
function fakeQuery(messages: unknown[]) {
  return vi.fn<ControlledSessionQuery>(({ options }) => (async function* () {
    for (const message of messages) {
      if (typeof message === "object" && message !== null && (message as { subtype?: string }).subtype === "init") yield { cwd: options.cwd, ...message };
      else yield message;
    }
  })());
}
async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("controlled no-tools sessions", () => {
  it("launches and resumes with the same private settings and strips ambient authority", async () => {
    const query = fakeQuery([init(), result]);
    const root = await directory();
    const adapter = createControlledSessionAdapter({ state_directory: root, query, environment: { ANTHROPIC_API_KEY: "test-key", PATH: "/usr/bin", HOME: "/sensitive", OSSTACK_HOME: "/sensitive/control", OSSTACK_AUTOAPPROVE: "1", CLAUDE_CODE_OAUTH_TOKEN: "secret", NODE_OPTIONS: "--require=evil", ANTHROPIC_BASE_URL: "https://untrusted" } });
    const first = await collect(adapter.startSession(task, new AbortController().signal));
    expect(first).toContainEqual({ type: "native_session.started", native_session_id: "native-private" });
    expect(first.at(-1)).toMatchObject({ type: "session.terminal", state: "completed" });
    await collect(adapter.resumeSession(input(), new AbortController().signal));
    const startOptions = query.mock.calls[0]![0].options;
    const resumeOptions = query.mock.calls[1]![0].options;
    expect(startOptions).toMatchObject({ tools: [], allowedTools: [], settingSources: [], mcpServers: {}, strictMcpConfig: true, hooks: {}, plugins: [], agents: {}, skills: [], additionalDirectories: [], permissionMode: "dontAsk", allowDangerouslySkipPermissions: false, maxTurns: 1, persistSession: true, extraArgs: { bare: null, "disable-slash-commands": null } });
    expect(startOptions.settings).toMatchObject({ disableAllHooks: true, autoMemoryEnabled: false, permissions: { defaultMode: "dontAsk", disableBypassPermissionsMode: "disable", allow: [], additionalDirectories: [] } });
    expect(startOptions.cwd).not.toBe(task.context!["repo_path"]);
    expect(startOptions.env).toMatchObject({ ANTHROPIC_API_KEY: "test-key", PATH: "/usr/bin", CLAUDE_CONFIG_DIR: expect.any(String) });
    for (const key of ["OSSTACK_HOME", "OSSTACK_AUTOAPPROVE", "CLAUDE_CODE_OAUTH_TOKEN", "NODE_OPTIONS", "ANTHROPIC_BASE_URL"]) expect(startOptions.env).not.toHaveProperty(key);
    expect(startOptions.env!["HOME"]).not.toBe("/sensitive");
    expect(resumeOptions).toMatchObject({ resume: "native-private", cwd: startOptions.cwd, env: startOptions.env });
    expect(adapter.sessionCapabilities()).toEqual({ resume: true, snapshot: false });
    const policy = await adapter.continuationPolicy();
    expect(policy.profile).toBe("claude-no-tools-v1");
    expect(policy.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(policy.model_id).toBe("claude-sonnet-4-6");
    expect(startOptions.model).toBe(policy.model_id);
    expect(isControlledSessionAdapter(adapter)).toBe(true);
    expect(isControlledSessionAdapter({ id: adapter.id, continuationPolicy: adapter.continuationPolicy })).toBe(false);
  });

  it("preserves structured decisions as a single text message for the daemon", async () => {
    const text = JSON.stringify({ decision_id: "d", question: "Next phase?", choices: [], continuation: { kind: "phase_continue" } });
    const query = fakeQuery([init(), { type: "assistant", message: { id: "m", content: [{ type: "text", text }] } }, { ...result, result: text }]);
    const adapter = createControlledSessionAdapter({ state_directory: await directory(), query, environment: { ANTHROPIC_API_KEY: "test" } });
    const events = await collect(adapter.startSession(task, new AbortController().signal));
    expect(events.filter((event) => (event as { type: string }).type === "assistant.message")).toEqual([{ type: "assistant.message", message_id: "m", text }]);
  });

  it("separates a JSON result from its typed decision without replacing the result with the question", async () => {
    const decision = { decision_id: "d", question: "Next phase?", choices: [{ choice_id: "continue", label: "Continue" }] };
    const text = JSON.stringify({ result: { reviewed: true }, decision });
    const query = fakeQuery([init(), { type: "assistant", message: { id: "m", content: [{ type: "text", text }] } }, { ...result, result: text }]);
    const adapter = createControlledSessionAdapter({ state_directory: await directory(), query, environment: { ANTHROPIC_API_KEY: "test" } });
    const events = await collect(adapter.startSession(task, new AbortController().signal));
    expect(events).toContainEqual({ type: "assistant.message", message_id: "m", text: '{"reviewed":true}' });
    expect(events).toContainEqual({ type: "decision.requested", ...decision });
    expect(events.at(-1)).toMatchObject({ state: "completed" });
  });

  it.each([
    '{"result":"ok","decision":null}',
    '{"result":"ok"}',
  ])("allows structured output with no decision: %s", async (text) => {
    const adapter = createControlledSessionAdapter({ state_directory: await directory(), query: fakeQuery([init(), { ...result, result: text }]), environment: { ANTHROPIC_API_KEY: "test" } });
    const events = await collect(adapter.startSession(task, new AbortController().signal));
    expect(events).toContainEqual({ type: "assistant.message", message_id: "result", text: '"ok"' });
    expect(events.some((event) => (event as { type: string }).type === "decision.requested")).toBe(false);
  });

  it.each([
    { result: "ok", decision: { decision_id: "d", question: "Next?", choices: [], injected: true } },
    { result: "ok", unexpected: true },
    { decision: null },
  ])("rejects malformed structured handoffs", async (envelope) => {
    const adapter = createControlledSessionAdapter({ state_directory: await directory(), query: fakeQuery([init(), { ...result, result: JSON.stringify(envelope) }]), environment: { ANTHROPIC_API_KEY: "test" } });
    const events = await collect(adapter.startSession(task, new AbortController().signal));
    expect(events.at(-1)).toMatchObject({ state: "failed", error_code: "invalid_structured_output" });
    expect(events.some((event) => (event as { type: string }).type === "decision.requested")).toBe(false);
  });

  it.each([
    ["tools", init({ tools: ["Bash"] }), "runtime_policy_mismatch"],
    ["MCP", init({ mcp_servers: [{ name: "danger", status: "connected" }] }), "runtime_policy_mismatch"],
    ["permission mode", init({ permissionMode: "bypassPermissions" }), "runtime_policy_mismatch"],
    ["model drift", init({ model: "another-model" }), "runtime_policy_mismatch"],
    ["missing cwd", init({ cwd: undefined }), "runtime_policy_mismatch"],
    ["unknown output", { type: "future_execution_event" }, "unsupported_runtime_message"],
    ["tool block", { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }, "tool_activity"],
  ])("rejects %s and aborts the provider", async (_label, message, code) => {
    const query = fakeQuery([...(message as { subtype?: string }).subtype === "init" ? [] : [init()], message, result]);
    const adapter = createControlledSessionAdapter({ state_directory: await directory(), query, environment: { ANTHROPIC_API_KEY: "test" } });
    const events = await collect(adapter.startSession(task, new AbortController().signal));
    expect(events.at(-1)).toMatchObject({ state: "failed", error_code: code });
    expect(query.mock.calls[0]![0].options.abortController!.signal.aborted).toBe(true);
  });

  it("requires initialization and a successful result", async () => {
    for (const messages of [[result], [init()]]) {
      const adapter = createControlledSessionAdapter({ state_directory: await directory(), query: fakeQuery(messages), environment: { ANTHROPIC_API_KEY: "test" } });
      expect((await collect(adapter.startSession(task, new AbortController().signal))).at(-1)).toMatchObject({ state: "failed" });
    }
  });

  it("rejects unknown native sessions and persists its own binding across adapter restart", async () => {
    const root = await directory();
    const query = fakeQuery([init(), result]);
    const options = { state_directory: root, query, environment: { ANTHROPIC_API_KEY: "test" } };
    const adapter = createControlledSessionAdapter(options);
    expect((await collect(adapter.resumeSession(input(), new AbortController().signal))).at(-1)).toMatchObject({ state: "failed", error_code: "native_session_not_owned" });
    expect(query).not.toHaveBeenCalled();
    await collect(adapter.startSession(task, new AbortController().signal));
    const restarted = createControlledSessionAdapter(options);
    expect((await collect(restarted.resumeSession(input(), new AbortController().signal))).at(-1)).toMatchObject({ state: "completed" });
    expect((await collect(restarted.resumeSession(input("other-native"), new AbortController().signal))).at(-1)).toMatchObject({ state: "failed", error_code: "native_session_not_owned" });
  });

  it("aborts a provider waiting for its next message immediately", async () => {
    const outer = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const query: ControlledSessionQuery = ({ options }) => (async function* () {
      providerSignal = options.abortController!.signal;
      yield init({ cwd: options.cwd });
      outer.abort();
      await new Promise<void>((resolve) => { if (providerSignal!.aborted) resolve(); else providerSignal!.addEventListener("abort", () => resolve(), { once: true }); });
    })();
    const adapter = createControlledSessionAdapter({ state_directory: await directory(), query, environment: { ANTHROPIC_API_KEY: "test" } });
    const events = await collect(adapter.startSession(task, outer.signal));
    expect(events.at(-1)).toMatchObject({ state: "cancelled" });
    expect(providerSignal!.aborted).toBe(true);
  });

  it("does not launch without explicit API credentials or through a symlink state directory", async () => {
    const query = fakeQuery([init(), result]);
    const root = await directory();
    const missing = createControlledSessionAdapter({ state_directory: root, query, environment: { CLAUDE_CODE_OAUTH_TOKEN: "secret" } });
    expect((await missing.isAvailable()).available).toBe(false);
    expect((await collect(missing.startSession(task, new AbortController().signal))).at(-1)).toMatchObject({ error_code: "not_authenticated" });
    await symlink(root, join(root, "alias"));
    const unsafe = createControlledSessionAdapter({ state_directory: join(root, "alias"), query, environment: { ANTHROPIC_API_KEY: "test" } });
    expect((await collect(unsafe.startSession(task, new AbortController().signal))).at(-1)).toMatchObject({ state: "failed" });
    expect(query).not.toHaveBeenCalled();
  });

  it("rechecks private directories before resume instead of trusting a cached policy", async () => {
    const root = await directory();
    const query = fakeQuery([init(), result]);
    const adapter = createControlledSessionAdapter({ state_directory: root, query, environment: { ANTHROPIC_API_KEY: "test" } });
    await collect(adapter.startSession(task, new AbortController().signal));
    await rename(join(root, "work"), join(root, "old-work"));
    await symlink(await directory(), join(root, "work"));
    expect((await collect(adapter.resumeSession(input(), new AbortController().signal))).at(-1)).toMatchObject({ state: "failed", error_code: "unsafe_runtime_directory" });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects an existing state directory readable by other OS users", async () => {
    const root = await directory();
    await chmod(root, 0o755);
    const query = fakeQuery([init(), result]);
    const adapter = createControlledSessionAdapter({ state_directory: root, query, environment: { ANTHROPIC_API_KEY: "test" } });
    expect((await collect(adapter.startSession(task, new AbortController().signal))).at(-1)).toMatchObject({ state: "failed", error_code: "unsafe_runtime_directory" });
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses policy inspection and resume when native binary contents drift", async () => {
    const query = fakeQuery([init(), result]);
    const adapter = createControlledSessionAdapter({ state_directory: await directory(), query, environment: { ANTHROPIC_API_KEY: "test" } });
    await collect(adapter.startSession(task, new AbortController().signal));
    binaryFixture.nextBytes = "replacement binary";
    await expect(adapter.continuationPolicy()).rejects.toThrow("runtime_policy_changed");
    binaryFixture.nextBytes = "replacement binary";
    expect((await collect(adapter.resumeSession(input(), new AbortController().signal))).at(-1)).toMatchObject({ state: "failed", error_code: "runtime_policy_changed" });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

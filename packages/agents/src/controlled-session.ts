// Session-only planning/review runtime. Tool removal is an SDK capability
// boundary, NOT an OS sandbox or protection against arbitrary same-UID code.
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Capability } from "@osstack/core";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentAvailability, AgentTask } from "./base.js";
import { AgentSessionEventSchema, type AgentSessionEvent, type AgentSessionInput, type SessionCapableAdapter } from "./session.js";

export type ControlledSessionQuery = (input: { prompt: string; options: Options }) => AsyncIterable<unknown> & { close?: () => void };
export interface ControlledSessionAdapterOptions {
  /** Persistent controller-owned directory, never the target repository. */
  state_directory: string;
  model_id?: string;
  environment?: NodeJS.ProcessEnv;
  /** In-process dependency injection for tests; never accepted from RPC data. */
  query?: ControlledSessionQuery;
}
export interface ControlledSessionPolicy {
  readonly profile: "claude-no-tools-v1";
  readonly fingerprint: string;
  readonly tools: "none";
  readonly filesystem: "no-agent-tools";
  readonly native_resume: true;
  /** Fixed model identifier; this does not attest provider model weights. */
  readonly model_id: string;
  readonly sdk_version: string;
}

const SDK_VERSION = "0.3.143";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const controlledAdapters = new WeakSet<object>();
const SYSTEM_PROMPT = "You are a bounded phase planning and review collaborator. You have no tools, filesystem access, command execution, or external actions. Work only with the material supplied in the conversation. Never claim to have executed, inspected, approved, merged, or published anything. A phase continuation request is a request, not authorization. When a structured handoff is requested, return one JSON object with exactly result (any JSON value) and optional decision (a SessionDecision object or null). The result is the phase output; the decision is a separate request. Otherwise return one text message.";
const ENV_ALLOWLIST = ["ANTHROPIC_API_KEY", "PATH", "LANG", "LC_ALL"] as const;
const DENIED_TOOLS = ["Bash", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep", "Agent", "Task", "Skill", "WebFetch", "WebSearch", "ToolSearch", "mcp__*"];
const FIXED_SETTINGS: Exclude<NonNullable<Options["settings"]>, string> = {
  disableAllHooks: true, autoMemoryEnabled: false, enabledPlugins: {},
  enableAllProjectMcpServers: false, enabledMcpjsonServers: [],
  permissions: { defaultMode: "dontAsk", disableBypassPermissionsMode: "disable", allow: [], deny: DENIED_TOOLS, additionalDirectories: [] },
};
const FIXED_POLICY = {
  profile: "claude-no-tools-v1", sdk_version: SDK_VERSION,
  tools: [], allowedTools: [], disallowedTools: DENIED_TOOLS,
  settingSources: [], skills: [], mcpServers: {}, strictMcpConfig: true,
  plugins: [], hooks: {}, agents: {}, additionalDirectories: [],
  permissionMode: "dontAsk", allowDangerouslySkipPermissions: false,
  maxTurns: 1, persistSession: true,
  extraArgs: { bare: null, "disable-slash-commands": null },
  settings: FIXED_SETTINGS,
  environment_names: ENV_ALLOWLIST, system_prompt: SYSTEM_PROMPT,
} as const;

class ControlledSessionError extends Error {
  constructor(readonly code: string) { super(code); }
}
function fail(code: string): never { throw new ControlledSessionError(code); }
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function cleanText(value: string): string {
  // Remove transport control bytes without truncating a structured request.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: session transport intentionally strips ASCII control bytes
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (text.length > 4_000) fail("output_too_large");
  return text;
}
function outputEvents(value: string, messageId: string): AgentSessionEvent[] {
  const text = cleanText(value);
  if (text === "") return [];
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return [{ type: "assistant.message", message_id: messageId, text }]; }
  const envelope = object(parsed);
  if (envelope === undefined || (!Object.hasOwn(envelope, "result") && !Object.hasOwn(envelope, "decision"))) {
    return [{ type: "assistant.message", message_id: messageId, text }];
  }
  if (!Object.hasOwn(envelope, "result") || Object.keys(envelope).some((key) => key !== "result" && key !== "decision")) fail("invalid_structured_output");
  const events: AgentSessionEvent[] = [{ type: "assistant.message", message_id: messageId, text: cleanText(JSON.stringify(envelope["result"])) }];
  if (envelope["decision"] !== undefined && envelope["decision"] !== null) {
    const decision = object(envelope["decision"]);
    if (decision === undefined || Object.hasOwn(decision, "type")) fail("invalid_structured_output");
    const event = AgentSessionEventSchema.safeParse({ type: "decision.requested", ...decision });
    if (!event.success) fail("invalid_structured_output");
    events.push(event.data);
  }
  return events;
}
async function ownedDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return assertOwnedDirectory(path);
}
async function assertOwnedDirectory(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || (process.getuid !== undefined && info.uid !== process.getuid())) fail("unsafe_runtime_directory");
  return realpath(path);
}
async function bundledExecutable(): Promise<{ path: string; sha256: string }> {
  const require = createRequire(import.meta.url);
  const sdkRequire = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") fail("unsupported_runtime_platform");
  const packageName = `@anthropic-ai/claude-agent-sdk-${platform}-${process.arch}`;
  // Resolve the SDK's pinned optional native dependency, never PATH/OSSTACK_*.
  const path = await realpath(sdkRequire.resolve(`${packageName}/claude${platform === "win32" ? ".exe" : ""}`));
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return { path, sha256: hash.digest("hex") };
}
interface Runtime {
  root: string;
  cwd: string;
  home: string;
  config: string;
  temporary: string;
  bindings: string;
  executable: string;
  binary_sha256: string;
  fingerprint: string;
}

export class ControlledSessionAdapter implements SessionCapableAdapter {
  readonly id = "claude-controlled-session";
  readonly display_name = "Claude controlled planning/review session (no tools)";
  readonly cost_tier = "high" as const;
  readonly #options: ControlledSessionAdapterOptions;
  readonly #environment: Record<string, string> = {};
  readonly #model: string;
  readonly #active = new Set<string>();
  #runtime: Promise<Runtime> | undefined;

  constructor(options: ControlledSessionAdapterOptions) {
    if (!isAbsolute(options.state_directory)) throw new Error("controlled session state_directory must be absolute");
    if (options.model_id !== undefined && options.model_id.trim() === "") throw new Error("controlled session model_id must not be empty");
    this.#options = { ...options };
    this.#model = options.model_id ?? DEFAULT_MODEL;
    const source = options.environment ?? process.env;
    for (const name of ENV_ALLOWLIST) if (source[name] !== undefined) this.#environment[name] = source[name]!;
  }
  capabilities(): readonly Capability[] { return []; }
  sessionCapabilities(): { resume: true; snapshot: false } { return { resume: true, snapshot: false }; }
  async isAvailable(): Promise<AgentAvailability> {
    return { available: Boolean(this.#environment["ANTHROPIC_API_KEY"]), ...(!this.#environment["ANTHROPIC_API_KEY"] ? { reason: "Controlled sessions require an explicit ANTHROPIC_API_KEY.", status: "not_authenticated" as const } : {}), last_checked_at: Date.now() / 1000 };
  }
  async continuationPolicy(): Promise<Readonly<ControlledSessionPolicy>> {
    const runtime = await this.prepare();
    return Object.freeze({ profile: "claude-no-tools-v1", fingerprint: runtime.fingerprint, tools: "none", filesystem: "no-agent-tools", native_resume: true, model_id: this.#model, sdk_version: SDK_VERSION });
  }
  private prepare(): Promise<Runtime> {
    this.#runtime ??= (async () => {
      const root = await ownedDirectory(resolve(this.#options.state_directory));
      const cwd = await ownedDirectory(join(root, "work"));
      const home = await ownedDirectory(join(root, "home"));
      const config = await ownedDirectory(join(root, "claude"));
      const temporary = await ownedDirectory(join(root, "tmp"));
      const bindings = await ownedDirectory(join(root, "bindings"));
      const binary = await bundledExecutable();
      const fingerprint = digest(JSON.stringify({ policy: FIXED_POLICY, root, executable: binary.path, binary_sha256: binary.sha256, model: this.#model, transport: this.#options.query ? "injected-query" : "sdk-native" }));
      return { root, cwd, home, config, temporary, bindings, executable: binary.path, binary_sha256: binary.sha256, fingerprint };
    })().catch((error: unknown) => { this.#runtime = undefined; throw error; });
    // The initialized policy is immutable for this adapter lifetime. A later
    // binary upgrade or directory replacement must not silently re-enroll an
    // existing native session under a new permission fingerprint.
    return this.#runtime.then(async (runtime) => {
      for (const path of [runtime.root, runtime.cwd, runtime.home, runtime.config, runtime.temporary, runtime.bindings]) {
        if (await assertOwnedDirectory(path) !== path) fail("unsafe_runtime_directory");
      }
      const binary = await bundledExecutable();
      if (binary.path !== runtime.executable || binary.sha256 !== runtime.binary_sha256) fail("runtime_policy_changed");
      return runtime;
    });
  }
  startSession(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentSessionEvent> {
    return this.run(task.session_id, task.prompt, signal);
  }
  resumeSession(input: AgentSessionInput, signal: AbortSignal): AsyncIterable<AgentSessionEvent> {
    return this.run(input.session_id, input.prompt, signal, input.native_session_id);
  }
  private async *run(sessionId: string, prompt: string, signal: AbortSignal, resume?: string): AsyncIterable<AgentSessionEvent> {
    yield { type: "session.state", state: "running" };
    if (signal.aborted) { yield { type: "session.terminal", state: "cancelled" }; return; }
    if (this.#active.has(sessionId)) { yield { type: "session.terminal", state: "failed", error_code: "session_busy" }; return; }
    this.#active.add(sessionId);
    const controller = new AbortController();
    let stream: ReturnType<ControlledSessionQuery> | undefined;
    const abort = (): void => { controller.abort(); stream?.close?.(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (!this.#environment["ANTHROPIC_API_KEY"]) fail("not_authenticated");
      const runtime = await this.prepare();
      const bindingPath = join(runtime.bindings, `${digest(sessionId)}.json`);
      if (resume !== undefined) {
        let binding: Record<string, unknown> | undefined;
        try { binding = object(JSON.parse(await readFile(bindingPath, "utf8"))); } catch { fail("native_session_not_owned"); }
        if (binding?.["native_session_id"] !== resume || binding?.["fingerprint"] !== runtime.fingerprint) fail("native_session_not_owned");
      } else {
        try { await lstat(bindingPath); fail("session_already_started"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (signal.aborted) fail("cancelled");
      const options: Options = {
        abortController: controller, cwd: runtime.cwd, pathToClaudeCodeExecutable: runtime.executable,
        tools: [], allowedTools: [], disallowedTools: [...DENIED_TOOLS],
        settingSources: [], skills: [], mcpServers: {}, strictMcpConfig: true,
        plugins: [], hooks: {}, agents: {}, additionalDirectories: [],
        permissionMode: "dontAsk", allowDangerouslySkipPermissions: false,
        maxTurns: 1, persistSession: true, extraArgs: { bare: null, "disable-slash-commands": null },
        settings: structuredClone(FIXED_POLICY.settings), systemPrompt: SYSTEM_PROMPT,
        env: { ...this.#environment, HOME: runtime.home, CLAUDE_CONFIG_DIR: runtime.config, TMPDIR: runtime.temporary },
        model: this.#model,
        ...(resume === undefined ? {} : { resume }),
      };
      const query = this.#options.query ?? (await import("@anthropic-ai/claude-agent-sdk")).query;
      if (signal.aborted) fail("cancelled");
      stream = query({ prompt, options });
      let native: string | undefined;
      let emittedText = false;
      for await (const value of stream) {
        if (signal.aborted) fail("cancelled");
        const message = object(value);
        if (message === undefined) fail("unsupported_runtime_message");
        const type = message["type"];
        if (type === "system" && message["subtype"] === "init") {
          if (native !== undefined) fail("runtime_policy_mismatch");
          if (message["permissionMode"] !== "dontAsk"
            || !["tools", "mcp_servers", "plugins", "skills"].every((key) => Array.isArray(message[key]) && message[key].length === 0)) fail("runtime_policy_mismatch");
          const candidate = message["session_id"];
          if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 256) fail("native_session_missing");
          if (resume !== undefined && candidate !== resume) fail("native_session_mismatch");
          if (message["cwd"] !== runtime.cwd || message["model"] !== this.#model) fail("runtime_policy_mismatch");
          native = candidate;
          if (resume === undefined) await writeFile(bindingPath, JSON.stringify({ native_session_id: native, fingerprint: runtime.fingerprint }), { flag: "wx", mode: 0o600 });
          yield { type: "native_session.started", native_session_id: native };
          continue;
        }
        if (native === undefined) fail("native_session_missing");
        if (type === "assistant") {
          const body = object(message["message"]);
          if (body === undefined) fail("unsupported_runtime_message");
          const content = body["content"];
          if (!Array.isArray(content)) fail("unsupported_runtime_message");
          const texts: string[] = [];
          for (const rawBlock of content) {
            const block = object(rawBlock);
            if (block?.["type"] === "tool_use" || block?.["type"] === "tool_result") fail("tool_activity");
            if (block?.["type"] === "text" && typeof block["text"] === "string") texts.push(block["text"]);
            else if (block?.["type"] !== "thinking" && block?.["type"] !== "redacted_thinking") fail("unsupported_runtime_message");
          }
          const text = cleanText(texts.join("\n"));
          if (text !== "") {
            emittedText = true;
            yield* outputEvents(text, typeof body["id"] === "string" && body["id"].length > 0 ? body["id"].slice(0, 256) : "assistant");
          }
          continue;
        }
        if (type === "result") {
          if (message["subtype"] !== "success" || message["is_error"] === true) fail("provider_result_error");
          if (!emittedText && typeof message["result"] === "string") {
            const text = cleanText(message["result"]);
            if (text !== "") yield* outputEvents(text, "result");
          }
          yield { type: "session.terminal", state: "completed" };
          return;
        }
        if (type === "rate_limit_event" || (type === "system" && ["status", "compact_boundary"].includes(String(message["subtype"])))) continue;
        if (typeof type === "string" && /tool|hook|plugin|task|mcp/i.test(type)) fail("tool_activity");
        fail("unsupported_runtime_message");
      }
      fail("missing_result");
    } catch (error) {
      if (signal.aborted || (error instanceof ControlledSessionError && error.code === "cancelled")) yield { type: "session.terminal", state: "cancelled" };
      else yield { type: "session.terminal", state: "failed", error_code: error instanceof ControlledSessionError ? error.code : "controlled_runtime_error" };
    } finally {
      signal.removeEventListener("abort", abort);
      abort();
      this.#active.delete(sessionId);
    }
  }
  async *invoke(task: AgentTask, _signal: AbortSignal): AsyncIterable<HermesEvent> {
    // This adapter is deliberately excluded from one-shot code routing.
    const envelope = { run_id: task.run_id, session_id: task.session_id, created_at: Date.now() / 1000 };
    yield { ...envelope, event_id: `${task.run_id}:0`, seq: 0, terminal: false, type: "run.started", payload: { status: "running", controls: { cancel: true, approval_pending: false, clarify_pending: false, queue: false, goal: false } } };
    yield { ...envelope, event_id: `${task.run_id}:1`, seq: 1, terminal: true, type: "done", payload: { status: "failed", last_seq: 0, result_summary: "Use the controlled session interface; command execution is unsupported." } };
  }
}

export function createControlledSessionAdapter(options: ControlledSessionAdapterOptions): ControlledSessionAdapter {
  const adapter = new ControlledSessionAdapter(options);
  controlledAdapters.add(adapter);
  return adapter;
}

export function isControlledSessionAdapter(value: unknown): value is ControlledSessionAdapter {
  return typeof value === "object" && value !== null && controlledAdapters.has(value);
}

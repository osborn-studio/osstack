// codex-cli adapter — spawns OpenAI Codex CLI in headless `exec --json` mode
// and streams its JSONL output as HermesEvents.
//
// Codex JSONL event types (observed against codex-cli 0.121.0):
//   thread.started  { thread_id }                       — session opened
//   turn.started    { }                                  — model turn begins
//   item.started    { item: {id, type, ...} }            — agent_message / command_execution / etc.
//   item.updated    { item: {id, partial} }              — streaming partial
//   item.completed  { item: {id, type, text|command|...}}— item finished
//   turn.completed  { usage: { input_tokens, output_tokens, cached_input_tokens } }
//   error           { message }                          — runtime failure
//
// Mapping:
//   thread.started                                                   → progress(thread.started)
//   turn.started                                                     → progress(turn.started)
//   item.* (type=agent_message)                                      → token.delta with text
//   item.* (type=agent_reasoning|reasoning)                          → reasoning.delta/done
//   item.started (type=command_execution|tool_use|exec_command)      → tool.started
//   item.completed (same types)                                      → tool.done
//   turn.completed                                                   → usage.final (done follows process exit)
//   error                                                            → error + done(failed)
//
// Cancellation: AbortSignal kills the codex subprocess with SIGTERM, then
// SIGKILL after 2s if it hasn't exited.

import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";
import { createInterface } from "node:readline";
import { CapabilitySchema, type Capability, type CostTier } from "@osstack/core";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { BaseAgentAdapter, type AgentAvailability, type AgentTask } from "../base.js";
import type {
  AgentSessionCapabilities,
  AgentSessionEvent,
  AgentSessionInput,
} from "../session.js";

const CAPABILITIES: readonly Capability[] = [
  CapabilitySchema.parse({
    id: "codex-cli.code.write",
    kind: "code.write",
    agent_id: "codex-cli",
    description: "Write code with OpenAI Codex. Strong on TS/Python/Go; multi-provider routing.",
    cost_tier: "mid",
    hints: { languages: ["typescript", "python", "go", "javascript", "rust"] },
  }),
  CapabilitySchema.parse({
    id: "codex-cli.code.refactor",
    kind: "code.refactor",
    agent_id: "codex-cli",
    description: "Refactor existing code with Codex sandboxed execution.",
    cost_tier: "mid",
  }),
  CapabilitySchema.parse({
    id: "codex-cli.code.test",
    kind: "code.test",
    agent_id: "codex-cli",
    description: "Write and run tests with Codex sandboxed execution; verify a build/test suite passes.",
    cost_tier: "mid",
  }),
  CapabilitySchema.parse({
    id: "codex-cli.code.review",
    kind: "code.review",
    agent_id: "codex-cli",
    description: "Review a diff or codebase for correctness, bugs, and quality with Codex.",
    cost_tier: "mid",
  }),
];

function now(): number { return Date.now() / 1000; }

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

function sanitizeAssistantText(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: relay text must remove ASCII controls before transport
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, 4_000);
}

function sanitizeSummary(value: string): string {
  return sanitizeAssistantText(value).slice(0, 1_000);
}

function envelope(task: AgentTask, seq: number, terminal: boolean): Omit<HermesEvent, "type" | "payload"> {
  return {
    event_id: `${task.run_id}:${seq}`,
    seq,
    run_id: task.run_id,
    session_id: task.session_id,
    created_at: now(),
    terminal,
  };
}

function runStarted(task: AgentTask, seq: number): HermesEvent {
  return {
    ...envelope(task, seq, false),
    type: "run.started",
    payload: {
      status: "running",
      controls: { cancel: true, approval_pending: false, clarify_pending: false, queue: false, goal: false },
    },
  };
}

function progress(task: AgentTask, seq: number, phase: string, detail?: string): HermesEvent {
  const payload: HermesEvent["payload"] = { phase };
  if (detail !== undefined) (payload as Record<string, unknown>).detail = detail;
  return { ...envelope(task, seq, false), type: "progress", payload };
}

function tokenDelta(task: AgentTask, seq: number, messageId: string, text: string): HermesEvent {
  return {
    ...envelope(task, seq, false),
    type: "token.delta",
    payload: { message_id: messageId, delta: text, content_type: "text" },
  };
}

function toolStarted(task: AgentTask, seq: number, toolCallId: string, name: string, args: unknown): HermesEvent {
  return {
    ...envelope(task, seq, false),
    type: "tool.started",
    payload: { tool_call_id: toolCallId, name, args, started_at: now() },
  };
}

function toolDone(
  task: AgentTask, seq: number, toolCallId: string,
  result: unknown, durationMs: number, isError: boolean,
): HermesEvent {
  return {
    ...envelope(task, seq, false),
    type: "tool.done",
    payload: { tool_call_id: toolCallId, result, duration_ms: durationMs, error: isError },
  };
}

function usageFinal(
  task: AgentTask, seq: number, tokensIn: number, tokensOut: number, durationMs: number,
): HermesEvent {
  return {
    ...envelope(task, seq, false),
    type: "usage.final",
    payload: { tokens_in: tokensIn, tokens_out: tokensOut, duration_ms: durationMs },
  };
}

function doneEvent(
  task: AgentTask, seq: number,
  status: "completed" | "failed" | "cancelled", lastSeq: number, summary?: string,
): HermesEvent {
  const payload: HermesEvent["payload"] = { status, last_seq: lastSeq };
  if (summary !== undefined) (payload as Record<string, unknown>).result_summary = summary;
  return { ...envelope(task, seq, true), type: "done", payload };
}

function errorEvent(task: AgentTask, seq: number, code: string, message: string): HermesEvent {
  return {
    ...envelope(task, seq, true),
    type: "error",
    payload: { code, message, terminal: true },
  };
}

interface ToolStart { id: string; name: string; startedAt: number }

function* mapEvent(
  task: AgentTask, seqRef: { v: number }, codex: Record<string, unknown>,
  tools: Map<string, ToolStart>,
): Generator<HermesEvent> {
  const type = String(codex["type"] ?? "unknown");

  if (type === "thread.started") {
    const tid = (codex["thread_id"] as string | undefined) ?? "thread";
    yield progress(task, seqRef.v++, "codex.thread.started", `thread_id=${tid}`);
    return;
  }
  if (type === "turn.started") {
    yield progress(task, seqRef.v++, "codex.turn.started");
    return;
  }
  if (type === "turn.completed") {
    const usage = (codex["usage"] ?? {}) as { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
    yield usageFinal(
      task, seqRef.v++,
      (usage.input_tokens ?? 0) - (usage.cached_input_tokens ?? 0),
      usage.output_tokens ?? 0,
      0, // codex JSONL doesn't include duration; daemon will compute from started_at
    );
    return;
  }
  if (type === "error") {
    const msg = String(codex["message"] ?? "codex emitted error event");
    yield errorEvent(task, seqRef.v++, "codex_error", msg);
    return;
  }

  if (type === "item.started" || type === "item.completed" || type === "item.updated") {
    const item = (codex["item"] ?? {}) as { id?: string; type?: string; text?: string; command?: string; output?: unknown };
    const itemId = String(item.id ?? `item_${seqRef.v}`);
    const itemType = String(item.type ?? "unknown");

    if (itemType === "agent_message" && typeof item.text === "string") {
      if (type === "item.completed") {
        yield tokenDelta(task, seqRef.v++, itemId, item.text);
      }
      return;
    }
    if (itemType === "agent_reasoning" || itemType === "reasoning") {
      // Map reasoning to progress for now (Hermes has reasoning.delta/done but
      // codex doesn't stream partial reasoning chunks).
      if (typeof item.text === "string") {
        yield progress(task, seqRef.v++, "codex.reasoning", item.text.slice(0, 200));
      }
      return;
    }
    if (itemType === "command_execution" || itemType === "exec_command" || itemType === "tool_use") {
      const cmd = String(item.command ?? "");
      if (type === "item.started") {
        tools.set(itemId, { id: itemId, name: itemType, startedAt: now() });
        yield toolStarted(task, seqRef.v++, itemId, itemType, { command: cmd });
      } else if (type === "item.completed") {
        const start = tools.get(itemId);
        const durationMs = start ? (now() - start.startedAt) * 1000 : 0;
        tools.delete(itemId);
        yield toolDone(task, seqRef.v++, itemId, item.output ?? null, durationMs, false);
      }
      return;
    }

    // Unknown item type — tracer bullet
    yield progress(task, seqRef.v++, `codex.${type}.${itemType}`, JSON.stringify(item).slice(0, 200));
    return;
  }

  // Unknown top-level type
  yield progress(task, seqRef.v++, `codex.${type}`);
}

interface CodexOptions {
  /** Override the codex binary path. */
  bin?: string;
  /** Sandbox mode. Default: read-only. */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Explicit extra writable directories; nonempty only with workspace-write. No environment defaults. */
  writableRoots?: readonly string[];
  /** Working directory for the codex run. Default: $HOME. */
  cwd?: string;
  /** Probe timeout for availability dry-runs. */
  probeTimeoutMs?: number;
  /** Replace the inherited child environment. Omit for legacy behavior. */
  env?: NodeJS.ProcessEnv;
  /** Require native turn.completed as well as exit 0 before reporting success. */
  strictCompletion?: boolean;
}

function normalizeWritableRoots(
  roots: CodexOptions["writableRoots"], sandbox: NonNullable<CodexOptions["sandbox"]>,
): readonly string[] {
  if (roots === undefined) return [];
  if (!Array.isArray(roots) || roots.length > 8) {
    throw new Error("writableRoots must be an array of at most eight directories");
  }
  if (roots.length > 0 && sandbox !== "workspace-write") {
    throw new Error("writableRoots requires workspace-write sandbox");
  }
  const canonical = new Set<string>();
  for (const root of roots) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: path authority must reject control characters
    if (typeof root !== "string" || !isAbsolute(root) || /[\u0000-\u001f\u007f]/.test(root)) {
      throw new Error("writableRoots entries must be absolute paths without control characters");
    }
    let directory: string;
    try {
      directory = realpathSync(root);
      if (!statSync(directory).isDirectory() || directory === parse(directory).root) {
        throw new Error("not a bounded directory");
      }
    } catch {
      throw new Error("writableRoots entries must be existing non-root directories");
    }
    canonical.add(directory);
  }
  return Object.freeze([...canonical]);
}

export class CodexCliAdapter extends BaseAgentAdapter {
  readonly id = "codex-cli";
  readonly display_name = "OpenAI Codex CLI (headless)";
  readonly cost_tier: CostTier = "mid";

  private readonly bin: string;
  private readonly sandbox: NonNullable<CodexOptions["sandbox"]>;
  private readonly cwd: string;
  private readonly writableRoots: readonly string[];
  private readonly probeTimeoutMs: number;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly strictCompletion: boolean;

  constructor(opts: CodexOptions = {}) {
    super();
    this.bin = opts.bin ?? process.env["OSSTACK_CODEX_BIN"] ?? "codex";
    this.sandbox = opts.sandbox ?? "read-only";
    this.writableRoots = normalizeWritableRoots(opts.writableRoots, this.sandbox);
    this.cwd = opts.cwd ?? process.env["HOME"] ?? process.cwd();
    this.probeTimeoutMs = opts.probeTimeoutMs ?? Number(process.env["OSSTACK_CODEX_PROBE_TIMEOUT_MS"] ?? 15_000);
    this.env = opts.env === undefined ? undefined : { ...opts.env };
    this.strictCompletion = opts.strictCompletion ?? false;
  }

  capabilities(): readonly Capability[] {
    return CAPABILITIES;
  }

  sessionCapabilities(): AgentSessionCapabilities {
    return { resume: true, snapshot: true };
  }

  async isAvailable(): Promise<AgentAvailability> {
    try {
      const out = await this.runCheck();
      if (out.ok) {
        return { available: true, status: "available", last_checked_at: Math.floor(now()) };
      }
      return out.reason !== undefined
        ? {
            available: false,
            status: out.status ?? "installed_but_broken",
            reason: out.reason,
            last_checked_at: Math.floor(now()),
          }
        : {
            available: false,
            status: out.status ?? "installed_but_broken",
            last_checked_at: Math.floor(now()),
          };
    } catch (err) {
      return {
        available: false,
        status: "installed_but_broken",
        reason: `codex probe failed: ${err instanceof Error ? err.message : String(err)}`,
        last_checked_at: Math.floor(now()),
      };
    }
  }

  private runCheck(): Promise<{
    ok: boolean;
    status?: AgentAvailability["status"];
    reason?: string;
  }> {
    return new Promise((resolve) => {
      const env = this.env ?? process.env;
      const codexDir = env["CODEX_HOME"] ?? join(env["HOME"] ?? "", ".codex");
      const hasConfig = existsSync(codexDir);
      if (!hasConfig) {
        resolve({
          ok: false,
          status: "not_authenticated",
          reason: `codex installed but ~/.codex not configured. Run \`codex login\`.`,
        });
        return;
      }
      const p = spawn(this.bin, ["exec", "resume", "--help"], {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...env },
      });
      let stderr = "";
      let settled = false;
      const finish = (result: {
        ok: boolean;
        status?: AgentAvailability["status"];
        reason?: string;
      }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        p.kill("SIGTERM");
        finish({
          ok: false,
          status: "installed_but_broken",
          reason: `codex resume preflight timed out after ${this.probeTimeoutMs}ms`,
        });
      }, this.probeTimeoutMs);
      p.stderr.on("data", (c) => { stderr += String(c); });
      p.on("error", (err) => {
        const notInstalled = (err as NodeJS.ErrnoException).code === "ENOENT";
        finish({
          ok: false,
          status: notInstalled ? "not_installed" : "installed_but_broken",
          reason: `codex binary failed (${this.bin}): ${err.message}`,
        });
      });
      p.on("exit", (code) => {
        if (code === 0) finish({ ok: true, status: "available" });
        else finish({
          ok: false,
          status: "installed_but_broken",
          reason: `codex resume preflight exited ${code}: ${singleLine(stderr)}`,
        });
      });
    });
  }

  startSession(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentSessionEvent> {
    const cwd = typeof task.context?.["repo_path"] === "string"
      ? task.context["repo_path"]
      : this.cwd;
    return this.runSession([
      "exec", "--json", "--skip-git-repo-check",
      "-s", this.sandbox, "-C", cwd, ...this.writableRoots.flatMap(root => ["--add-dir", root]), task.prompt,
    ], signal);
  }

  resumeSession(input: AgentSessionInput, signal: AbortSignal): AsyncIterable<AgentSessionEvent> {
    const cwd = typeof input.context?.["repo_path"] === "string"
      ? input.context["repo_path"]
      : this.cwd;
    // Current Codex CLI models resume as an exec subcommand. Parent flags must
    // precede `resume`; the fake-binary test locks this argv contract.
    return this.runSession([
      "exec", "--json", "--skip-git-repo-check",
      "-s", this.sandbox, "-C", cwd, ...this.writableRoots.flatMap(root => ["--add-dir", root]),
      "resume", input.native_session_id, input.prompt,
    ], signal, input.native_session_id);
  }

  private async *runSession(
    args: string[],
    signal: AbortSignal,
    expectedNativeSessionId?: string,
  ): AsyncIterable<AgentSessionEvent> {
    yield { type: "session.state", state: "running" };
    if (signal.aborted) {
      yield { type: "session.terminal", state: "cancelled" };
      return;
    }

    const proc = spawn(this.bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...(this.env ?? process.env) },
    });
    const closed = new Promise<number | null>((resolve) => { proc.once("close", resolve); });
    const stderr: string[] = [];
    let spawnError: Error | undefined;
    proc.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    proc.on("error", (error) => { spawnError = error; });
    const onAbort = (): void => { proc.kill("SIGTERM"); };
    signal.addEventListener("abort", onAbort);

    let nativeSessionId: string | undefined;
    let turnCompleted = false;
    let terminalEmitted = false;
    try {
      const lines = createInterface({ input: proc.stdout, crlfDelay: Number.POSITIVE_INFINITY });
      for await (const line of lines) {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = String(event["type"] ?? "");
        if (type === "turn.completed") turnCompleted = true;
        if (type === "thread.started") {
          const candidate = event["thread_id"];
          if (typeof candidate !== "string" || candidate.length === 0) continue;
          if (expectedNativeSessionId !== undefined && candidate !== expectedNativeSessionId) {
            terminalEmitted = true;
            yield {
              type: "session.terminal",
              state: "failed",
              error_code: "native_session_mismatch",
              summary: "Codex resume returned a different native session",
            };
            proc.kill("SIGTERM");
            return;
          }
          nativeSessionId = candidate;
          yield { type: "native_session.started", native_session_id: candidate };
          continue;
        }
        if (type === "item.completed") {
          const item = event["item"] as Record<string, unknown> | undefined;
          if (
            nativeSessionId !== undefined
            && item?.["type"] === "agent_message"
            && typeof item["text"] === "string"
          ) {
            yield {
              type: "assistant.message",
              message_id: typeof item["id"] === "string" ? item["id"] : "assistant",
              text: sanitizeAssistantText(item["text"]),
            };
          }
          continue;
        }
        if (type === "error") {
          terminalEmitted = true;
          proc.kill("SIGTERM");
          yield {
            type: "session.terminal",
            state: "failed",
            error_code: "codex_error",
            summary: sanitizeSummary(String(event["message"] ?? "Codex error")),
          };
          return;
        }
      }

      const exitCode = await closed;
      if (signal.aborted) {
        terminalEmitted = true;
        yield { type: "session.terminal", state: "cancelled" };
      } else if (spawnError !== undefined || exitCode !== 0) {
        terminalEmitted = true;
        yield {
          type: "session.terminal",
          state: "failed",
          error_code: "codex_nonzero_exit",
          summary: sanitizeSummary(spawnError?.message ?? (stderr.join("") || `exit ${exitCode}`)),
        };
      } else if (nativeSessionId === undefined || (this.strictCompletion && !turnCompleted)) {
        terminalEmitted = true;
        yield {
          type: "session.terminal",
          state: "failed",
            error_code: nativeSessionId === undefined ? "native_session_missing" : "codex_completion_missing",
            summary: "Codex exited without the required native session completion",
        };
      } else {
        terminalEmitted = true;
        yield { type: "session.terminal", state: "completed" };
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (!terminalEmitted && proc.exitCode === null) proc.kill("SIGTERM");
    }
  }

  async *invoke(task: AgentTask, signal: AbortSignal): AsyncIterable<HermesEvent> {
    const seqRef = { v: 0 };
    const tools = new Map<string, ToolStart>();
    const taskRepoPath = task.context?.["repo_path"];
    const taskCwd = typeof taskRepoPath === "string" && taskRepoPath.trim() !== ""
      ? resolve(taskRepoPath)
      : this.cwd;
    yield runStarted(task, seqRef.v++);

    if (signal.aborted) {
      yield doneEvent(task, seqRef.v, "cancelled", seqRef.v - 1, "cancelled before codex spawn");
      return;
    }

    const args = [
      "exec", "--json", "--skip-git-repo-check",
      "-s", this.sandbox,
      "-C", taskCwd,
      ...this.writableRoots.flatMap(root => ["--add-dir", root]),
      task.prompt,
    ];
    const proc = spawn(this.bin, args, {
      cwd: taskCwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...(this.env ?? process.env) },
    });

    // Honor AbortSignal — SIGTERM, then SIGKILL after 2s.
    let killed = false;
    const onAbort = (): void => {
      if (killed || proc.exitCode !== null) return;
      killed = true;
      proc.kill("SIGTERM");
      setTimeout(() => { if (proc.exitCode === null) proc.kill("SIGKILL"); }, 2000);
    };
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort);

    // Stream stdout line-by-line.
    let buf = "";
    const stderrChunks: string[] = [];
    const pending: HermesEvent[] = [];
    let exited = false;
    let exitCode: number | null = null;
    let turnCompleted = false;
    let resolveNext: (() => void) | null = null;

    const wake = (): void => {
      const r = resolveNext;
      resolveNext = null;
      r?.();
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (line.length === 0) continue;
        try {
          const codexEvent = JSON.parse(line) as Record<string, unknown>;
          if (codexEvent["type"] === "turn.completed") turnCompleted = true;
          for (const ev of mapEvent(task, seqRef, codexEvent, tools)) pending.push(ev);
        } catch {
          pending.push(progress(task, seqRef.v++, "codex.unparseable", line.slice(0, 200)));
        }
      }
      wake();
    });
    proc.stderr.on("data", (c) => { stderrChunks.push(String(c)); });
    proc.on("error", (error) => { stderrChunks.push(error.message); });
    proc.on("close", (code) => {
      exited = true;
      exitCode = code;
      // Flush any trailing buffered partial line.
      if (buf.trim().length > 0) {
        try {
          const codexEvent = JSON.parse(buf.trim()) as Record<string, unknown>;
          if (codexEvent["type"] === "turn.completed") turnCompleted = true;
          for (const ev of mapEvent(task, seqRef, codexEvent, tools)) pending.push(ev);
        } catch { /* swallow trailing garbage */ }
        buf = "";
      }
      wake();
    });

    try {
      while (true) {
        while (pending.length > 0) {
          const ev = pending.shift()!;
          yield ev;
          if (ev.terminal) return;
        }
        if (exited) break;
        await new Promise<void>((res) => { resolveNext = res; });
      }

      if (signal.aborted || killed) {
        yield doneEvent(task, seqRef.v, "cancelled", seqRef.v - 1, "cancel requested");
        return;
      }
      if (exitCode === 0 && (!this.strictCompletion || turnCompleted)) {
        yield doneEvent(task, seqRef.v, "completed", seqRef.v - 1, "codex exited 0");
      } else if (exitCode === 0) {
        yield errorEvent(task, seqRef.v++, "codex_completion_missing", "Codex exited without native turn.completed");
        yield doneEvent(task, seqRef.v, "failed", seqRef.v - 1);
      } else {
        const stderr = stderrChunks.join("").slice(-500);
        yield errorEvent(task, seqRef.v++, "codex_nonzero_exit", `codex exited ${exitCode}. stderr: ${stderr}`);
        yield doneEvent(task, seqRef.v, "failed", seqRef.v - 1);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (this.strictCompletion && !exited) onAbort();
    }
  }
}

// claude-code adapter — calls @anthropic-ai/claude-agent-sdk and projects
// its SDKMessage stream onto HermesEvent.
//
// S1.5 mapping:
//   - SDKAssistantMessage  → token.delta (text) + tool.started (tool_use blocks)
//   - SDKUserMessage       → tool.done (when content has tool_result blocks)
//   - SDKResultSuccess     → usage.final + done(completed)
//   - SDKResultError       → error + done(failed)
//   - SDKRateLimitEvent    → progress(rate_limit)
//   - everything else      → progress (tracer bullet — preserves type:subtype)

import { existsSync } from "node:fs";
import { join } from "node:path";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
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
    id: "claude-code.code.write",
    kind: "code.write",
    agent_id: "claude-code",
    description: "Write production code from a spec. Strong on TS/Python; multi-file edits.",
    cost_tier: "high",
    hints: { languages: ["typescript", "python", "rust", "go", "javascript"] },
  }),
  CapabilitySchema.parse({
    id: "claude-code.code.refactor",
    kind: "code.refactor",
    agent_id: "claude-code",
    description: "Refactor existing code while preserving behavior. Strong on multi-file changes.",
    cost_tier: "high",
  }),
  CapabilitySchema.parse({
    id: "claude-code.code.test",
    kind: "code.test",
    agent_id: "claude-code",
    description: "Add or extend unit and integration tests against an existing codebase.",
    cost_tier: "high",
  }),
  CapabilitySchema.parse({
    id: "claude-code.code.debug",
    kind: "code.debug",
    agent_id: "claude-code",
    description: "Trace a failing test or stack trace and propose a fix.",
    cost_tier: "high",
  }),
];

function now(): number { return Date.now() / 1000; }

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

function progressEvent(task: AgentTask, seq: number, phase: string, detail?: string): HermesEvent {
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

function toolStarted(
  task: AgentTask,
  seq: number,
  toolCallId: string,
  name: string,
  args: unknown,
): HermesEvent {
  return {
    ...envelope(task, seq, false),
    type: "tool.started",
    payload: { tool_call_id: toolCallId, name, args, started_at: now() },
  };
}

function toolDone(
  task: AgentTask,
  seq: number,
  toolCallId: string,
  result: unknown,
  durationMs: number,
  isError: boolean,
): HermesEvent {
  return {
    ...envelope(task, seq, false),
    type: "tool.done",
    payload: { tool_call_id: toolCallId, result, duration_ms: durationMs, error: isError },
  };
}

function usageFinal(
  task: AgentTask,
  seq: number,
  tokensIn: number,
  tokensOut: number,
  costUsd: number | undefined,
  durationMs: number,
): HermesEvent {
  const payload: HermesEvent["payload"] = {
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    duration_ms: durationMs,
  };
  if (costUsd !== undefined) (payload as Record<string, unknown>).cost_usd = costUsd;
  return { ...envelope(task, seq, false), type: "usage.final", payload };
}

function doneEvent(
  task: AgentTask,
  seq: number,
  status: "completed" | "failed" | "cancelled",
  lastSeq: number,
  summary?: string,
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

interface ToolStartTime { id: string; name: string; startedAt: number }

/** Extract structured info from a SDKMessage; returns events to emit. */
function* mapMessage(
  task: AgentTask,
  seqRef: { v: number },
  msg: SDKMessage,
  toolStarts: Map<string, ToolStartTime>,
): Generator<HermesEvent> {
  const type = (msg as { type?: string }).type ?? "unknown";

  if (type === "assistant") {
    const m = msg as { message?: { id?: string; content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }> } };
    const messageId = m.message?.id ?? `msg_${seqRef.v}`;
    const blocks = m.message?.content ?? [];
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        yield tokenDelta(task, seqRef.v++, messageId, block.text);
      } else if (block.type === "tool_use" && typeof block.id === "string") {
        const name = typeof block.name === "string" ? block.name : "unknown_tool";
        toolStarts.set(block.id, { id: block.id, name, startedAt: now() });
        yield toolStarted(task, seqRef.v++, block.id, name, block.input ?? null);
      }
    }
    return;
  }

  if (type === "user") {
    // Tool-result deliveries come back as user messages whose content holds tool_result blocks.
    const m = msg as { message?: { content?: Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }> } };
    const blocks = m.message?.content ?? [];
    for (const block of blocks) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const start = toolStarts.get(block.tool_use_id);
        const durationMs = start ? (now() - start.startedAt) * 1000 : 0;
        const isError = Boolean(block.is_error);
        toolStarts.delete(block.tool_use_id);
        yield toolDone(task, seqRef.v++, block.tool_use_id, block.content ?? null, durationMs, isError);
      }
    }
    return;
  }

  if (type === "result") {
    const m = msg as {
      subtype?: string;
      duration_ms?: number;
      total_cost_usd?: number;
      usage?: { input_tokens?: number; output_tokens?: number };
      result?: string;
      errors?: string[];
    };
    const subtype = m.subtype ?? "unknown";
    const tokensIn = m.usage?.input_tokens ?? 0;
    const tokensOut = m.usage?.output_tokens ?? 0;
    const durationMs = m.duration_ms ?? 0;
    const costUsd = m.total_cost_usd;

    yield usageFinal(task, seqRef.v++, tokensIn, tokensOut, costUsd, durationMs);

    if (subtype === "success") {
      const summary = typeof m.result === "string" ? m.result.slice(0, 200) : undefined;
      yield doneEvent(task, seqRef.v++, "completed", seqRef.v - 1, summary);
    } else {
      const summary = m.errors?.join("; ") ?? subtype;
      yield errorEvent(task, seqRef.v++, subtype, summary);
      yield doneEvent(task, seqRef.v++, "failed", seqRef.v - 1, summary);
    }
    return;
  }

  // Fallback for unmapped types — keep tracer-bullet visibility.
  const subtype = (msg as { subtype?: string }).subtype;
  const phase = subtype ? `${type}:${subtype}` : type;
  yield progressEvent(task, seqRef.v++, phase);
}

export class ClaudeCodeAdapter extends BaseAgentAdapter {
  readonly id = "claude-code";
  readonly display_name = "Claude Code (Anthropic Agent SDK)";
  readonly cost_tier: CostTier = "high";

  capabilities(): readonly Capability[] {
    return CAPABILITIES;
  }

  sessionCapabilities(): AgentSessionCapabilities {
    return { resume: true, snapshot: true };
  }

  async isAvailable(): Promise<AgentAvailability> {
    const hermes_home = process.env["HERMES_HOME"] ?? join(process.env["HOME"] ?? "", ".hermes");
    const has_anthropic_key = Boolean(process.env["ANTHROPIC_API_KEY"]);
    const has_hermes_auth = existsSync(join(hermes_home, "config.yaml"))
                         || existsSync(join(hermes_home, "auth.json"));
    if (has_anthropic_key || has_hermes_auth) {
      return { available: true, last_checked_at: Math.floor(now()) };
    }
    return {
      available: false,
      reason: "No ANTHROPIC_API_KEY in env and no Hermes auth found. Run `hermes login anthropic` or export ANTHROPIC_API_KEY.",
      last_checked_at: Math.floor(now()),
    };
  }

  startSession(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentSessionEvent> {
    return this.runSession(task.prompt, task.context, signal);
  }

  resumeSession(input: AgentSessionInput, signal: AbortSignal): AsyncIterable<AgentSessionEvent> {
    return this.runSession(input.prompt, input.context, signal, input.native_session_id);
  }

  private async *runSession(
    prompt: string,
    context: Record<string, unknown> | undefined,
    signal: AbortSignal,
    expectedNativeSessionId?: string,
  ): AsyncIterable<AgentSessionEvent> {
    yield { type: "session.state", state: "running" };
    if (signal.aborted) {
      yield { type: "session.terminal", state: "cancelled" };
      return;
    }

    const options: Options = {};
    const repoPath = typeof context?.["repo_path"] === "string"
      ? context["repo_path"]
      : undefined;
    if (repoPath !== undefined) options.cwd = repoPath;
    if (expectedNativeSessionId !== undefined) options.resume = expectedNativeSessionId;
    if (process.env["OSSTACK_AUTOAPPROVE"] === "1") {
      options.permissionMode = "bypassPermissions";
      options.allowDangerouslySkipPermissions = true;
    }

    const stream = query({ prompt, options });
    let nativeSessionId: string | undefined;
    let terminalEmitted = false;
    try {
      for await (const message of stream) {
        if (signal.aborted) {
          stream.close?.();
          terminalEmitted = true;
          yield { type: "session.terminal", state: "cancelled" };
          return;
        }

        const raw = message as unknown as Record<string, unknown>;
        const candidate = raw["session_id"];
        if (nativeSessionId === undefined && typeof candidate === "string" && candidate.length > 0) {
          if (expectedNativeSessionId !== undefined && candidate !== expectedNativeSessionId) {
            stream.close?.();
            terminalEmitted = true;
            yield {
              type: "session.terminal",
              state: "failed",
              error_code: "native_session_mismatch",
              summary: "Claude resume returned a different native session",
            };
            return;
          }
          nativeSessionId = candidate;
          yield { type: "native_session.started", native_session_id: candidate };
        }

        if (raw["type"] === "assistant") {
          const sdkMessage = raw["message"] as {
            id?: unknown;
            content?: Array<{ type?: unknown; text?: unknown }>;
          } | undefined;
          for (const block of sdkMessage?.content ?? []) {
            if (block.type === "text" && typeof block.text === "string") {
              yield {
                type: "assistant.message",
                message_id: typeof sdkMessage?.id === "string" ? sdkMessage.id : "assistant",
                text: sanitizeAssistantText(block.text),
              };
            }
          }
          continue;
        }

        if (raw["type"] === "result") {
          const success = raw["subtype"] === "success";
          terminalEmitted = true;
          if (success) {
            const result = typeof raw["result"] === "string" ? raw["result"] : undefined;
            yield {
              type: "session.terminal",
              state: "completed",
              ...(result === undefined ? {} : { summary: sanitizeSummary(result) }),
            };
          } else {
            const errors = Array.isArray(raw["errors"])
              ? raw["errors"].filter((item): item is string => typeof item === "string").join("; ")
              : String(raw["subtype"] ?? "Claude session failed");
            yield {
              type: "session.terminal",
              state: "failed",
              error_code: "claude_session_failed",
              summary: sanitizeSummary(errors),
            };
          }
          return;
        }
      }

      if (nativeSessionId === undefined) {
        terminalEmitted = true;
        yield {
          type: "session.terminal",
          state: "failed",
          error_code: "native_session_missing",
          summary: "Claude completed without a session id",
        };
      } else {
        terminalEmitted = true;
        yield { type: "session.terminal", state: "completed" };
      }
    } catch (error) {
      terminalEmitted = true;
      yield {
        type: "session.terminal",
        state: "failed",
        error_code: "claude_adapter_threw",
        summary: sanitizeSummary(error instanceof Error ? error.message : String(error)),
      };
    } finally {
      if (!terminalEmitted && signal.aborted) stream.close?.();
    }
  }

  async *invoke(task: AgentTask, signal: AbortSignal): AsyncIterable<HermesEvent> {
    const seqRef = { v: 0 };
    const toolStarts = new Map<string, ToolStartTime>();
    yield runStarted(task, seqRef.v++);

    if (signal.aborted) {
      yield doneEvent(task, seqRef.v, "cancelled", seqRef.v - 1, "cancelled before SDK call");
      return;
    }

    let sawTerminal = false;
    try {
      // Wire --repo (carried as context.repo_path) to the SDK working dir, and
      // opt-in auto-approval so the sub-agent can actually land edits/run commands
      // in headless mode. Off by default; enable with OSSTACK_AUTOAPPROVE=1.
      const repoPath =
        typeof task.context?.["repo_path"] === "string"
          ? (task.context["repo_path"] as string)
          : undefined;
      const autoApprove = process.env["OSSTACK_AUTOAPPROVE"] === "1";
      const options: {
        cwd?: string;
        permissionMode?: "bypassPermissions";
        allowDangerouslySkipPermissions?: boolean;
      } = {};
      if (repoPath) options.cwd = repoPath;
      if (autoApprove) {
        options.permissionMode = "bypassPermissions";
        options.allowDangerouslySkipPermissions = true;
      }
      const stream = query({ prompt: task.prompt, options });
      for await (const msg of stream) {
        if (signal.aborted) {
          yield doneEvent(task, seqRef.v, "cancelled", seqRef.v - 1, "cancel requested");
          return;
        }
        for (const ev of mapMessage(task, seqRef, msg, toolStarts)) {
          yield ev;
          if (ev.terminal) sawTerminal = true;
        }
        if (sawTerminal) return;
      }
      if (!sawTerminal) {
        yield doneEvent(task, seqRef.v, "completed", seqRef.v - 1, "SDK stream ended");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield errorEvent(task, seqRef.v++, "adapter_threw", msg);
      yield doneEvent(task, seqRef.v, "failed", seqRef.v - 1);
    }
  }
}

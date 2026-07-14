// AgentAdapter — every sub-agent (Claude Code, Codex CLI, DeepSeek, ...) implements
// this. The daemon's orchestrator picks one via policy.score() and feeds it tasks.
//
// Design decisions locked in plan v0.6:
//   E1: capability schema = Zod (single source of truth)
//   D11: invocation = streaming AsyncIterable<HermesEvent>
//        (events flow back to Hermes via the adapter, not buffered)
//   D5: cancellation = explicit cancel(runId) method, NOT just rejecting the iterator
//        (so the adapter can clean up sub-processes)

import type { Capability, CostTier } from "@osstack/core";
import type { HermesEvent } from "@osstack/hermes-adapter";

/** Globally unique adapter identifier (e.g. "claude-code", "codex-cli"). */
export type AgentId = string;

export interface AgentAvailability {
  available: boolean;
  /** Human-readable reason when unavailable (missing key, bin not on PATH, ...). */
  reason?: string;
  /** Last successful probe time (unix seconds). */
  last_checked_at: number;
}

export interface AgentTask {
  /** Globally unique run id (allocated by the orchestrator, not the adapter). */
  run_id: string;
  /** Owning task this run belongs to. */
  task_id: string;
  /** Hermes session that originated the request (for event envelope). */
  session_id: string;
  /** Capability the orchestrator selected for this run. */
  capability_id: string;
  /** Free-form user prompt + any structured context the adapter understands. */
  prompt: string;
  context?: Record<string, unknown>;
}

export interface AgentRuntimeIdentity {
  adapter_id: string;
  adapter_version: string;
  auth_mode: string;
  provider_id: string;
  model_id: string;
  model_context_window?: number;
  reasoning_effort?: string;
  agent_profile?: string;
  binary_path_sha256?: string;
  evidence_source: "reported" | "configured" | "inferred";
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly display_name: string;
  readonly cost_tier: CostTier;

  /** Capabilities this adapter advertises. Read by policy.score(). */
  capabilities(): readonly Capability[];

  /**
   * Cheap reachability probe. Should NOT call the underlying LLM; just check
   * that we have credentials + the CLI/SDK is present. < 2s expected.
   */
  isAvailable(): Promise<AgentAvailability>;

  /** Runtime/provider evidence used by review and proof artifacts. */
  runtimeIdentity?(): Promise<AgentRuntimeIdentity>;

  /**
   * Execute the task and stream Hermes-shaped events until terminal. The
   * adapter is responsible for emitting `run.started` first and one of
   * `done` / `error` last; the daemon will refuse non-conforming streams.
   *
   * Implementations MUST honor an AbortSignal: when fired, stop the
   * underlying work, emit a final `done` with status "cancelled", and
   * close the iterator.
   */
  invoke(task: AgentTask, signal: AbortSignal): AsyncIterable<HermesEvent>;
}

// Resumable conversation support is deliberately a separate structural
// capability. See session.ts and isSessionCapableAdapter(): existing one-shot
// adapters continue to satisfy AgentAdapter without implementing fake resume.

/**
 * Helper base class: keeps the common fields and forces subclasses to
 * implement the streaming method. Adapters don't HAVE to subclass this —
 * the interface above is sufficient — but most will because boilerplate.
 */
export abstract class BaseAgentAdapter implements AgentAdapter {
  abstract readonly id: AgentId;
  abstract readonly display_name: string;
  abstract readonly cost_tier: CostTier;

  abstract capabilities(): readonly Capability[];
  abstract isAvailable(): Promise<AgentAvailability>;
  abstract invoke(task: AgentTask, signal: AbortSignal): AsyncIterable<HermesEvent>;
}

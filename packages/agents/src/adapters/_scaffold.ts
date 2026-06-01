// Shared helpers for "scaffold" adapters — agents that Osstack can select,
// probe, and fall back to, but whose execution layer isn't wired to a real
// backend yet. They emit a conforming HermesEvent stream (run.started →
// progress → terminal) so the daemon accepts them, and advertise their
// capability set so routing/role-resolution treats them as first-class.

import { CapabilitySchema, type Capability, type CostTier } from "@osstack/core";
import type { HermesEvent } from "@osstack/hermes-adapter";
import type { AgentTask } from "../base.js";

export function now(): number {
  return Date.now() / 1000;
}

function envelope(
  task: AgentTask,
  seq: number,
  terminal: boolean,
): Omit<HermesEvent, "type" | "payload"> {
  return {
    event_id: `${task.run_id}:${seq}`,
    seq,
    run_id: task.run_id,
    session_id: task.session_id,
    created_at: now(),
    terminal,
  };
}

/** A complete, conforming stream for a scaffolded run. */
export function* scaffoldStream(
  task: AgentTask,
  agentDisplay: string,
  note: string,
  status: "completed" | "cancelled" = "completed",
): Generator<HermesEvent> {
  let seq = 0;
  yield {
    ...envelope(task, seq++, false),
    type: "run.started",
    payload: {
      status: "running",
      controls: { cancel: true, approval_pending: false, clarify_pending: false, queue: false, goal: false },
    },
  };
  if (status === "completed") {
    yield {
      ...envelope(task, seq++, false),
      type: "progress",
      payload: { phase: "design.scaffold", detail: note },
    };
  }
  yield {
    ...envelope(task, seq, true),
    type: "done",
    payload: {
      status,
      last_seq: seq - 1,
      result_summary: status === "completed" ? `${agentDisplay}: ${note}` : "cancelled before scaffold ran",
    },
  };
}

/** The three design capabilities every design adapter advertises. */
export function designCapabilities(agentId: string, costTier: CostTier): readonly Capability[] {
  return [
    CapabilitySchema.parse({
      id: `${agentId}.design.prd`,
      kind: "design.prd",
      agent_id: agentId,
      description: "Produce a product requirements doc / design brief from a goal.",
      cost_tier: costTier,
    }),
    CapabilitySchema.parse({
      id: `${agentId}.design.architecture`,
      kind: "design.architecture",
      agent_id: agentId,
      description: "Propose UI / visual / system design direction.",
      cost_tier: costTier,
    }),
    CapabilitySchema.parse({
      id: `${agentId}.design.review`,
      kind: "design.review",
      agent_id: agentId,
      description: "Review a design against heuristics, accessibility, and brand.",
      cost_tier: costTier,
    }),
  ];
}

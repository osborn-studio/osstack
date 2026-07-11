// Protocol adoption layer (R1.2) — pure mappers from the loop's richer in-memory
// types to the cross-process `@osstack/protocol` contracts.
//
// Additive only: the loop keeps its own Task (with first-class EvaluationSpec)
// and CompletedTask. These mappers project those down to the shared protocol
// shapes for cross-process handoff, without importing the persistence layer.
//
// Design rules: pure & total on valid inputs, honest mapping, no fabrication.

import type * as protocol from "@osstack/protocol";
import type { CompletedTask, Task } from "./types.js";

/**
 * Project a loop {@link Task} onto the protocol {@link protocol.Task}.
 *
 * The two shapes share every field; the loop's `evaluation` (a typed
 * `EvaluationSpec[]`) is passed through as the protocol's OPAQUE `unknown[]` —
 * protocol deliberately keeps evaluation-spec internals out of v1. `source`
 * (loop DiscoverSource) is identical to protocol TaskSource. `priority` is always
 * present after a loop Task parse (defaulted to 50). Optional `context` /
 * `evaluation` are omitted when absent so the strict schema accepts the result
 * under `exactOptionalPropertyTypes`.
 */
export function toProtocolTask(task: Task): protocol.Task {
  return {
    task_id: task.task_id,
    capability: task.capability,
    prompt: task.prompt,
    source: task.source,
    priority: task.priority,
    ...(task.context !== undefined ? { context: task.context } : {}),
    ...(task.evaluation !== undefined ? { evaluation: task.evaluation } : {}),
  };
}

/**
 * Project a loop {@link CompletedTask} onto the protocol {@link protocol.RunSummary}.
 *
 * PRECONDITION / ESCALATION: RunSummary requires a real run — `run_id` and
 * `started_at`. On a CompletedTask these are optional: the loop only populates
 * them when an actual run executed (finalRun !== null in loop-engine). A
 * CompletedTask with no executed run does not correspond to any run and CANNOT be
 * honestly summarized, so this mapper throws rather than fabricate a run id or
 * start time. `agent_id` is always present on CompletedTask and maps directly.
 *
 * Outcome mapping (CompletedTask task-level outcome -> RunOutcome):
 *   success   -> completed
 *   failed    -> failed
 *   escalated -> cancelled
 * `escalated` is a distinct loop outcome (the loop stopped and handed off to a
 * human/hermes) that the protocol's three-value enum has no exact slot for. It is
 * mapped to `cancelled` — a run stopped/handed-off before completing, not a
 * definitive failure — which keeps all three loop outcomes distinct (no collapse
 * into `failed`, matching how the loop reports escalated and failed as separate
 * counts).
 *
 * `started_at` / `completed_at` are already ISO-8601 strings on CompletedTask
 * (copied from the executor's `new Date().toISOString()`), so they satisfy
 * protocol's `z.string().datetime()` unchanged. `summary` is taken from
 * `execution_summary` when present.
 */
export function completedTaskToRunSummary(t: CompletedTask): protocol.RunSummary {
  if (t.run_id === undefined || t.started_at === undefined) {
    throw new Error(
      "completedTaskToRunSummary: requires a CompletedTask backed by an actual run " +
        "(run_id + started_at present). A task with no executed run cannot be represented " +
        "as a protocol RunSummary.",
    );
  }
  const outcome: protocol.RunOutcome = mapOutcome(t.outcome);
  return {
    run_id: t.run_id,
    task_id: t.task_id,
    agent_id: t.agent_id,
    outcome,
    started_at: t.started_at,
    duration_ms: Math.max(0, Math.round(t.duration_ms)),
    ...(t.completed_at !== undefined ? { completed_at: t.completed_at } : {}),
    ...(t.execution_summary !== undefined ? { summary: t.execution_summary } : {}),
  };
}

/**
 * Exhaustive CompletedTask.outcome -> protocol.RunOutcome mapping. The switch
 * (with a never-typed default) fails to COMPILE if CompletedTask.outcome gains
 * a new value, instead of silently mapping it to "cancelled".
 */
function mapOutcome(outcome: CompletedTask["outcome"]): protocol.RunOutcome {
  switch (outcome) {
    case "success":
      return "completed";
    case "failed":
      return "failed";
    case "escalated":
      return "cancelled";
    default: {
      const exhaustive: never = outcome;
      throw new Error(`completedTaskToRunSummary: unmapped outcome ${String(exhaustive)}`);
    }
  }
}

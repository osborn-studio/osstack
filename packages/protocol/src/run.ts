// RunSummary — the shared, cross-process summary of an agent run.
//
// Extraction (architecture §1): the common denominator of the loop executor's
// `AgentRun` and the CLI's `insertRun`. Persistence-only columns (session_id,
// capability_id, phase, token counts, retry/intervention counts, gbrain/hermes
// ids, last_step) stay in core's RunRow and are NOT part of the protocol v1.
//
// Timestamps use ISO-8601 strings (the loop AgentRun form), which is the
// human/agent-facing cross-process representation; core persists epoch numbers.

import { z } from "zod";

/** Terminal outcome of a run (common denominator of executor AgentRun outcomes). */
export const RunOutcome = z.enum(["completed", "failed", "cancelled"]);
export type RunOutcome = z.infer<typeof RunOutcome>;

export const RunSummary = z
  .object({
    run_id: z.string().min(1),
    task_id: z.string().min(1),
    agent_id: z.string().min(1),
    outcome: RunOutcome,
    started_at: z.string().datetime(),
    completed_at: z.string().datetime().optional(),
    duration_ms: z.number().int().nonnegative().optional(),
    summary: z.string().optional(),
  })
  .strict();
export type RunSummary = z.infer<typeof RunSummary>;

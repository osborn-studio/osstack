import type { AgentRun } from "./executor.js";

export interface ReportRepairHooks {
  /** Remaining runtime, or undefined when budget is exhausted. Tokens use measured usage. */
  remainingMs(): number | undefined;
  usage(usage: Pick<AgentRun, "tokens_in" | "tokens_out" | "cost_usd">): void;
  event(type: "loop.report_repair.attempt" | "loop.report_repair.result", payload: Record<string, unknown>): void;
}

export const REPORT_REPAIR_PROMPT = [
  "Restate only the result of the work already completed in this same session.",
  "Do not redo the work. Do not change files. Do not use tools.",
  "Output only the result required by the original protocol, with all required fields.",
  "Preserve the original result and evidence. Do not claim new work or checks.",
].join("\n");

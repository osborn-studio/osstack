import { randomUUID } from "node:crypto";
import type { ExecutionPlan, StopCondition, Task } from "./types.js";

export interface PlannerOptions {
  agentId?: string;
  worktreePath?: string;
  maxIterations?: number;
  stopCondition?: StopCondition;
}

export function planTask(task: Task, options: PlannerOptions = {}): ExecutionPlan {
  return {
    plan_id: `plan_${randomUUID()}`,
    task,
    agent_id: options.agentId ?? "local-command",
    ...(options.worktreePath !== undefined ? { worktree_path: options.worktreePath } : {}),
    max_iterations: options.maxIterations ?? 1,
    stop_condition: options.stopCondition ?? { type: "custom", params: { mode: "local-command" } },
  };
}

// Task — the canonical cross-process unit of work.
//
// Extraction (architecture §1): the loop file-queue / daemon-RPC Task IS the
// cross-process shape today, so the protocol adopts it. It is defined
// INDEPENDENTLY here — protocol is the bottom layer and MUST NOT import
// @osstack/loop (owner constraint). Required fields mirror
// docs/specs/schemas/task.schema.json exactly: task_id, capability, prompt, source.
//
// core's TaskRow is a persistence projection, NOT this protocol shape.

import { z } from "zod";

/** Where a task was discovered. Mirrors the loop DiscoverSource enum. */
export const TaskSource = z.enum([
  "git_diff",
  "gh_issue",
  "github_branch",
  "ci_log",
  "task_queue",
  "manual",
]);
export type TaskSource = z.infer<typeof TaskSource>;

export const Task = z
  .object({
    task_id: z.string().min(1),
    /** Capability kind needed, e.g. "code.fix", "review.code". */
    capability: z.string().min(1),
    /** Natural-language prompt the agent will receive. */
    prompt: z.string().min(1),
    source: TaskSource,
    /** Optional-with-default, 0–100 (mirrors the loop Task default of 50). */
    priority: z.number().min(0).max(100).default(50),
    /** Optional structured context (file paths, line ranges, error messages). */
    context: z.record(z.unknown()).optional(),
    /**
     * First-class evaluation harness specs. In v1 this stays an opaque array:
     * loop's EvaluationSpec details are deliberately NOT imported/pre-packaged
     * (owner constraint — no internal type leakage until a second consumer exists).
     */
    evaluation: z.array(z.unknown()).optional(),
  })
  .strict();
export type Task = z.infer<typeof Task>;

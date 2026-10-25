import { z } from "zod";
import { SessionDecision } from "./session-continuation.js";

const id = z.string().min(1).max(512);
export const AttentionWait = z
  .object({
    reason: z.string().min(1).max(120),
    owner: z.enum(["human", "system", "unknown", "none"]),
    grant_id: id.nullable(),
    message_id: id.nullable(),
  })
  .strict();
export const AttentionSessionFact = z
  .object({
    session_id: id,
    run_id: id,
    state: z.string().max(80),
    version: z.number().int().positive(),
    turn_id: id.nullable(),
    turn_state: z.string().max(80).nullable(),
    decision: SessionDecision.nullable(),
    decision_hash: z.string().length(64).nullable(),
    process_liveness: z.literal("unknown"),
    wait: AttentionWait,
    updated_at: z.number().finite(),
  })
  .strict();
export const AttentionStatus = z
  .object({
    schema_version: z.literal(1),
    mode: z.literal("snapshot_only"),
    scope: z
      .object({
        scope_id: id,
        task_id: id,
        tenant_id: z.null(),
        repo_path: z.string().max(4096),
      })
      .strict(),
    sampled_at_ms: z.number().finite().nonnegative(),
    coverage: z.object({ state: z.literal("not_monitored") }).strict(),
    runs: z
      .array(
        z
          .object({
            run_id: id,
            phase: z.string().max(120),
            outcome: z.string().max(120).nullable(),
            repo_binding: z.literal("unverified"),
          })
          .strict()
      )
      .max(100),
    sessions: z.array(AttentionSessionFact).max(100),
    completeness: z
      .object({
        latest_turn_only: z.literal(true),
        truncated: z.boolean(),
        omitted_binding_unknown: z.number().int().nonnegative(),
        next_cursor: z.string().max(4096).nullable(),
        next_after: z
          .object({ run: id.nullable(), session: id.nullable() })
          .strict(),
      })
      .strict(),
    limitations: z.array(z.string().max(700)).max(500),
  })
  .strict();
export type AttentionStatus = z.infer<typeof AttentionStatus>;
export type AttentionSessionFact = z.infer<typeof AttentionSessionFact>;
export type AttentionWait = z.infer<typeof AttentionWait>;

/** Persistent inbox projection, not authority to execute or approve. */
export const AttentionInbox = z
  .object({
    schema_version: z.literal(1),
    scope_id: id,
    coverage: z.enum(["covered", "degraded", "uncovered", "unknown"]),
    execution_takeover: z.literal(false),
    counts: z
      .array(
        z
          .object({
            state: z.string().max(80),
            total: z.number().int().nonnegative(),
          })
          .strict()
      )
      .max(20),
    next_after: id.nullable(),
    items: z
      .array(
        z
          .object({
            item_id: id,
            scope_id: id,
            session_id: id,
            turn_id: id,
            decision_id: id,
            content_hash: z.string().length(64),
            decision: SessionDecision,
            source_version: z.number().int().positive(),
            revision: z.number().int().positive(),
            state: z.enum([
              "open",
              "source_missing",
              "source_closed",
              "continued_externally",
              "answer_reserved",
              "answer_uncertain",
              "answer_applied",
              "answer_abandoned",
              "answer_cancelled",
            ]),
            created_at: z.number().finite(),
            updated_at: z.number().finite(),
            external_message_id: id.nullable(),
          })
          .strict()
      )
      .max(100),
  })
  .strict();
export type AttentionInbox = z.infer<typeof AttentionInbox>;

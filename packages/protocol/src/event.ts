// EventEnvelope — the shared event envelope for the run event log.
//
// Extraction (architecture §1): the @osstack/hermes-adapter EventEnvelopeBase
// (event_id, seq, run_id, session_id, created_at, terminal) plus the `type`
// discriminator and an OPEN `payload`. Payload unions (the 13 event families)
// stay out of v1 — only the envelope is genuinely shared across processes today.
//
// `created_at` is a unix-seconds number (float OK), matching hermes-adapter and
// core's EventRow.

import { z } from "zod";

export const EventEnvelope = z
  .object({
    /** Stable replay cursor, e.g. "run_123:42". */
    event_id: z.string().min(1),
    seq: z.number().int().nonnegative(),
    run_id: z.string().min(1),
    session_id: z.string().min(1),
    /** Unix seconds; float is acceptable. */
    created_at: z.number(),
    /** True on the last event of a run. */
    terminal: z.boolean().default(false),
    /** Event family discriminator, e.g. "token.delta", "tool.done". Open in v1. */
    type: z.string().min(1),
    /** Family-specific body. Kept open (unvalidated union) in protocol v1. */
    payload: z.record(z.unknown()),
  })
  .strict();
export type EventEnvelope = z.infer<typeof EventEnvelope>;

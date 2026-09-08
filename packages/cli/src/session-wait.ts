import { SessionDecision, type SessionContinuationRequest } from "@osstack/protocol";

export interface SessionWaitInput {
  state: string;
  decision: unknown;
  resume_ready: boolean;
  applying: boolean;
  pending_message?: { message_id: string; state: "accepted" | "failed" };
}

export interface SessionWaitDetails {
  reason: "awaiting_instruction" | "unclassified_decision" | "resume_unavailable"
    | "delivery_uncertain" | "delivery_failed" | SessionContinuationRequest["gate_kind"];
  automatic_continuation: false;
  request_source?: "agent_reported";
  continuation?: SessionContinuationRequest;
  message_id?: string;
}

/** Diagnostics only. Parsing a request cannot certify evidence or issue a grant. */
export function describeSessionWait(input: SessionWaitInput): SessionWaitDetails | null {
  if (input.applying) return null;
  if (input.pending_message !== undefined) {
    return {
      reason: input.pending_message.state === "accepted" ? "delivery_uncertain" : "delivery_failed",
      message_id: input.pending_message.message_id,
      automatic_continuation: false,
    };
  }
  if (input.state !== "idle" && input.state !== "awaiting_decision") return null;
  if (!input.resume_ready) return { reason: "resume_unavailable", automatic_continuation: false };
  if (input.state === "idle") return { reason: "awaiting_instruction", automatic_continuation: false };
  const parsed = SessionDecision.safeParse(input.decision);
  const continuation = parsed.success ? parsed.data.continuation : undefined;
  if (continuation === undefined) return { reason: "unclassified_decision", automatic_continuation: false };
  return {
    reason: continuation.gate_kind,
    request_source: "agent_reported",
    continuation,
    automatic_continuation: false,
  };
}

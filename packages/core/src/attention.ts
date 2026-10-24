/** Pure attention facts: no DB, process, model, or execution capabilities. */
export interface WaitInput {
  state: string;
  turnId: string | null;
  version: number;
  now: number;
  grant?: {
    id: string;
    status: string;
    turnId: string;
    version: number;
    expires: number;
  };
  attempt?: {
    state: string;
    sourceTurn: string;
    sourceVersion: number;
    reservationVersion?: number;
    messageId?: string;
  };
  message?: { id: string; state: string };
  /** Only a local, exact message reservation can establish this. */
  applyingMessageId?: string;
  scheduled?: boolean;
}
export function classifyAttentionWait(input: WaitInput): {
  reason: string;
  owner: "human" | "system" | "unknown" | "none";
  blocked: boolean;
} {
  const { grant, attempt, message } = input;
  const validGrant =
    grant?.status === "active" &&
    Number.isFinite(grant.expires) &&
    grant.expires > input.now;
  const matchingReservation =
    validGrant &&
    attempt?.state === "reserved" &&
    attempt.sourceTurn === input.turnId &&
    attempt.sourceVersion === grant.version &&
    attempt.sourceTurn === grant.turnId &&
    attempt.reservationVersion === input.version &&
    attempt.messageId === message?.id &&
    message?.state === "accepted";
  if (message && ["accepted", "failed"].includes(message.state))
    return {
      reason:
        message.state === "failed"
          ? "delivery_failed"
          : input.applyingMessageId === message.id
          ? "in_flight"
          : "accepted_in_flight_or_uncertain",
      owner: matchingReservation ? "system" : "unknown",
      blocked: true,
    };
  if (attempt && ["checking", "reserved"].includes(attempt.state)) {
    const checking =
      validGrant &&
      attempt.state === "checking" &&
      attempt.sourceTurn === input.turnId &&
      attempt.sourceVersion === input.version &&
      grant.turnId === input.turnId &&
      grant.version === input.version;
    return {
      reason: checking
        ? input.scheduled
          ? "checking"
          : "grant_coverage_unknown"
        : "stale_attempt",
      owner: checking && input.scheduled ? "system" : "unknown",
      blocked: true,
    };
  }
  if (grant?.status === "active") {
    const current =
      validGrant &&
      grant.turnId === input.turnId &&
      grant.version === input.version;
    return {
      reason: current ? "grant_coverage_unknown" : "stale_grant",
      owner: current ? "unknown" : "human",
      blocked: true,
    };
  }
  if (input.state === "awaiting_decision")
    return { reason: "owner_decision", owner: "human", blocked: false };
  if (input.state === "idle")
    return { reason: "awaiting_instruction", owner: "human", blocked: false };
  return { reason: "none", owner: "none", blocked: false };
}

export function evaluateCoverage(input: {
  now: number;
  sampled: number;
  deadline: number;
  complete: boolean;
  ownerCurrent: boolean;
}): "covered" | "degraded" | "uncovered" | "unknown" {
  if (
    ![input.now, input.sampled, input.deadline].every(Number.isFinite) ||
    input.now < input.sampled
  )
    return "unknown";
  if (!input.ownerCurrent || input.now > input.deadline) return "uncovered";
  return input.complete ? "covered" : "degraded";
}
export function evaluateActivity(input: {
  kind: "run" | "session";
  businessState: string;
  instance: string;
  now: number;
  observation?: {
    instance: string;
    state: "busy" | "idle" | "dead";
    expires: number;
  };
}): {
  business_state: string;
  process_liveness: "busy" | "idle" | "unknown" | "dead";
} {
  const observation = input.observation;
  const valid =
    observation &&
    observation.instance === input.instance &&
    Number.isFinite(observation.expires) &&
    Number.isFinite(input.now) &&
    input.now <= observation.expires &&
    !(input.kind === "session" && observation.state === "dead");
  return {
    business_state: input.businessState,
    process_liveness: valid ? observation.state : "unknown",
  };
}

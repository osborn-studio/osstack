import {
  AutonomyRiskLevel,
  AutonomyRiskPhase,
  AutonomyRunState,
  type AutonomyRiskLevel as AutonomyRiskLevelType,
  type AutonomyRiskPhase as AutonomyRiskPhaseType,
  type AutonomyRunState as AutonomyRunStateType,
} from "@osstack/protocol";
import {
  isVerifiedScopedApproval,
  type VerifiedScopedApproval,
} from "./approval.js";

type BlockedDeliveryResumeState =
  | "pushing"
  | "opening_pr"
  | "waiting_ci"
  | "merging";

export const LEGAL_TRANSITIONS: Record<
  AutonomyRunStateType,
  readonly AutonomyRunStateType[]
> = {
  queued: ["classifying", "cancelled"],
  classifying: [
    "awaiting_approval",
    "blocked",
    "preparing",
    "completed",
    "escalated",
    "cancelled",
  ],
  awaiting_approval: [
    "preparing",
    "candidate_proof",
    "cancelled",
    "escalated",
  ],
  blocked: [],
  preparing: ["building", "escalated", "cancelled"],
  building: ["verifying", "escalated", "cancelled"],
  verifying: ["repairing", "reviewing", "escalated", "cancelled"],
  repairing: ["building", "escalated", "cancelled"],
  reviewing: ["repairing", "post_classifying", "escalated", "cancelled"],
  post_classifying: [
    "awaiting_approval",
    "blocked",
    "candidate_proof",
    "escalated",
    "cancelled",
  ],
  candidate_proof: ["committing", "delivery_evidence_failed", "escalated"],
  committing: ["pushing", "blocked_delivery", "escalated"],
  pushing: ["opening_pr", "blocked_delivery", "escalated"],
  opening_pr: ["waiting_ci", "blocked_delivery", "escalated"],
  waiting_ci: ["merging", "repairing", "blocked_delivery", "escalated"],
  merging: [
    "deploying_staging",
    "final_proof",
    "blocked_delivery",
    "escalated",
  ],
  deploying_staging: ["verifying_staging", "final_proof", "escalated"],
  verifying_staging: [
    "deploying_production",
    "final_proof",
    "escalated",
  ],
  deploying_production: ["health_checking", "rolling_back", "escalated"],
  health_checking: ["final_proof", "rolling_back", "escalated"],
  rolling_back: ["deploy_frozen", "escalated"],
  deploy_frozen: ["final_proof"],
  final_proof: [
    "completed",
    "delivery_evidence_failed",
    "escalated",
  ],
  blocked_delivery: ["pushing", "opening_pr", "waiting_ci", "merging"],
  delivery_evidence_failed: [],
  escalated: [],
  cancelled: [],
  completed: [],
};

export const TERMINAL_AUTONOMY_STATES = [
  "blocked",
  "delivery_evidence_failed",
  "escalated",
  "cancelled",
  "completed",
] as const satisfies readonly AutonomyRunStateType[];

export interface AutonomyTransitionInput {
  autonomy_run_id: string;
  from_state: AutonomyRunStateType;
  to_state: AutonomyRunStateType;
  risk_level?: AutonomyRiskLevelType;
  risk_phase?: AutonomyRiskPhaseType;
  verified_approval?: VerifiedScopedApproval;
  pending_approval_phase?: AutonomyRiskPhaseType;
  blocked_delivery_resume_state?: BlockedDeliveryResumeState;
}

function expectedClassifiedDestination(
  phase: AutonomyRiskPhaseType,
  level: AutonomyRiskLevelType,
): AutonomyRunStateType {
  if (level === "R4") return "blocked";
  if (level === "R3") return "awaiting_approval";
  if (phase === "preflight") {
    return level === "R0" ? "completed" : "preparing";
  }
  return "candidate_proof";
}

function assertClassificationGate(input: AutonomyTransitionInput): void {
  const classificationPhase =
    input.from_state === "classifying" ? "preflight" : "post_diff";
  if (input.risk_level === undefined || input.risk_phase === undefined) {
    throw new Error(
      `${input.from_state} transition requires an authoritative risk decision`,
    );
  }
  const level = AutonomyRiskLevel.parse(input.risk_level);
  const phase = AutonomyRiskPhase.parse(input.risk_phase);
  if (phase !== classificationPhase) {
    throw new Error(
      `${input.from_state} requires ${classificationPhase} risk evidence`,
    );
  }
  const expected = expectedClassifiedDestination(phase, level);
  if (input.to_state !== expected) {
    if (level === "R3") {
      throw new Error(
        `R3 must enter awaiting_approval before ${
          phase === "preflight" ? "preparing" : "candidate_proof"
        }`,
      );
    }
    if (level === "R4") {
      throw new Error("R4 can only transition to blocked and cannot be approved");
    }
    throw new Error(
      `${level} ${phase} classification must transition to ${expected}`,
    );
  }
}

function assertApprovalGate(input: AutonomyTransitionInput): void {
  const targetPhase =
    input.to_state === "preparing"
      ? "preflight"
      : input.to_state === "candidate_proof"
        ? "post_diff"
        : undefined;
  if (targetPhase === undefined) return;
  if (!isVerifiedScopedApproval(input.verified_approval)) {
    throw new Error(
      `${input.to_state} requires a cryptographically verified approval`,
    );
  }
  const approval = input.verified_approval;
  if (input.pending_approval_phase === undefined) {
    throw new Error(
      "approval resume requires the persisted pending_approval_phase",
    );
  }
  const pendingPhase = AutonomyRiskPhase.parse(input.pending_approval_phase);
  if (pendingPhase !== targetPhase) {
    throw new Error(
      `${pendingPhase} awaiting approval cannot transition to ${input.to_state}`,
    );
  }
  if (approval.request.autonomy_run_id !== input.autonomy_run_id) {
    throw new Error("verified approval belongs to a different autonomy run");
  }
  if (approval.request.phase !== targetPhase) {
    throw new Error(
      `${approval.request.phase} approval must transition to ${
        approval.request.phase === "post_diff" ? "candidate_proof" : "preparing"
      }`,
    );
  }
  if (approval.decision.payload.decision !== "approve") {
    throw new Error("rejected approval cannot authorize execution");
  }
}

function assertBlockedDeliveryResume(input: AutonomyTransitionInput): void {
  if (
    input.blocked_delivery_resume_state === undefined ||
    input.blocked_delivery_resume_state !== input.to_state
  ) {
    throw new Error(
      "blocked_delivery resume target must match the persisted delivery resume state",
    );
  }
}

export function assertAutonomyTransition(input: AutonomyTransitionInput): void {
  if (input.autonomy_run_id.length === 0) {
    throw new Error("autonomy_run_id must not be empty");
  }
  const from = AutonomyRunState.parse(input.from_state);
  const to = AutonomyRunState.parse(input.to_state);
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new Error(`illegal transition from ${from} to ${to}`);
  }

  if (
    (from === "classifying" || from === "post_classifying") &&
    (!["escalated", "cancelled"].includes(to) ||
      input.risk_level !== undefined ||
      input.risk_phase !== undefined)
  ) {
    assertClassificationGate(input);
  }
  if (from === "awaiting_approval") {
    assertApprovalGate(input);
  }
  if (from === "blocked_delivery") {
    assertBlockedDeliveryResume(input);
  }
}

export function canAutonomyTransition(
  input: AutonomyTransitionInput,
): boolean {
  try {
    assertAutonomyTransition(input);
    return true;
  } catch {
    return false;
  }
}

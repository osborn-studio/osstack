import { z } from "zod";
import { Actor, ActorLenient } from "./approval.js";

const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
const BASE64URL_ED25519_SIGNATURE = z.string().regex(/^[A-Za-z0-9_-]{86}$/);

/**
 * SHA-256 of an empty byte string. Preflight RISK-R3 approval binds this
 * sentinel because no authoritative staged diff exists before Builder runs.
 */
export const AUTONOMY_EMPTY_DIFF_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" as const;

export const AutonomyRiskLevel = z.enum(["R0", "R1", "R2", "R3", "R4"]);
export type AutonomyRiskLevel = z.infer<typeof AutonomyRiskLevel>;

export const AutonomyRiskPhase = z.enum(["preflight", "post_diff"]);
export type AutonomyRiskPhase = z.infer<typeof AutonomyRiskPhase>;

const autonomyRiskSignalShape = {
  rule_id: z.string().min(1),
  level: AutonomyRiskLevel,
  message: z.string().min(1),
  path: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
} as const;

export const AutonomyRiskSignal = z.object(autonomyRiskSignalShape).strict();
export type AutonomyRiskSignal = z.infer<typeof AutonomyRiskSignal>;

export const AutonomyRiskSignalLenient = z.object(autonomyRiskSignalShape).passthrough();

const RISK_ORDER: Readonly<Record<AutonomyRiskLevel, number>> = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4,
};

function riskSignalKey(signal: z.infer<typeof AutonomyRiskSignalLenient>): string {
  return [
    signal.rule_id,
    signal.path ?? "",
    signal.command ?? "",
    signal.level,
    signal.message,
  ].join("\u0000");
}

function checkRiskDecision(
  value: {
    level: AutonomyRiskLevel;
    signals: Array<z.infer<typeof AutonomyRiskSignalLenient>>;
  },
  context: z.RefinementCtx,
): void {
  const keys = value.signals.map(riskSignalKey);
  const sortedKeys = [...keys].sort();
  if (keys.some((key, index) => key !== sortedKeys[index])) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["signals"],
      message: "risk signals must be in canonical order",
    });
  }
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["signals"],
      message: "risk signals must not contain duplicates",
    });
  }

  const maximum = value.signals.reduce<AutonomyRiskLevel>(
    (current, signal) =>
      RISK_ORDER[signal.level] > RISK_ORDER[current] ? signal.level : current,
    "R0",
  );
  if (value.level !== maximum) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["level"],
      message: `risk level must equal maximum signal level ${maximum}`,
    });
  }
}

const autonomyRiskDecisionShape = {
  phase: AutonomyRiskPhase,
  level: AutonomyRiskLevel,
  signals: z.array(AutonomyRiskSignal),
  policy_sha256: SHA256,
  input_sha256: SHA256,
  decided_at: z.string().datetime(),
} as const;

export const AutonomyRiskDecision = z
  .object(autonomyRiskDecisionShape)
  .strict()
  .superRefine(checkRiskDecision);
export type AutonomyRiskDecision = z.infer<typeof AutonomyRiskDecision>;

export const AutonomyRiskDecisionLenient = z
  .object({
    ...autonomyRiskDecisionShape,
    signals: z.array(AutonomyRiskSignalLenient),
  })
  .passthrough()
  .superRefine(checkRiskDecision);

export const AutonomyRunState = z.enum([
  "queued",
  "classifying",
  "awaiting_approval",
  "blocked",
  "preparing",
  "building",
  "verifying",
  "repairing",
  "reviewing",
  "post_classifying",
  "candidate_proof",
  "committing",
  "pushing",
  "opening_pr",
  "waiting_ci",
  "merging",
  "deploying_staging",
  "verifying_staging",
  "deploying_production",
  "health_checking",
  "rolling_back",
  "deploy_frozen",
  "final_proof",
  "blocked_delivery",
  "delivery_evidence_failed",
  "escalated",
  "cancelled",
  "completed",
]);
export type AutonomyRunState = z.infer<typeof AutonomyRunState>;

export const AutonomyApprovalPhase = z.enum(["preflight", "post_diff"]);
export type AutonomyApprovalPhase = z.infer<typeof AutonomyApprovalPhase>;

const canonicalActionScope = z
  .array(z.string().min(1))
  .min(1)
  .superRefine((scope, context) => {
    if (new Set(scope).size !== scope.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "action_scope must not contain duplicates",
      });
    }
    const sorted = [...scope].sort();
    if (scope.some((action, index) => action !== sorted[index])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "action_scope must be in canonical order",
      });
    }
  });

const scopedApprovalRequestShape = {
  approval_id: z.string().min(1),
  autonomy_run_id: z.string().min(1),
  phase: AutonomyApprovalPhase,
  contract_sha256: SHA256,
  diff_sha256: SHA256,
  action_scope: canonicalActionScope,
  risk: z.literal("R3"),
  nonce: z.string().min(1),
  requested_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  request_sha256: SHA256,
} as const;

function checkApprovalRequest(
  request: {
    phase: AutonomyApprovalPhase;
    diff_sha256: string;
    action_scope: string[];
    requested_at: string;
    expires_at: string;
  },
  context: z.RefinementCtx,
): void {
  if (
    request.phase === "preflight" &&
    request.diff_sha256 !== AUTONOMY_EMPTY_DIFF_SHA256
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["diff_sha256"],
      message: "preflight approval must bind the empty-diff sentinel",
    });
  }
  if (
    request.phase === "preflight" &&
    request.action_scope.some((action) => action !== "build" && action !== "verify")
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["action_scope"],
      message: "preflight approval may authorize only build and verify",
    });
  }
  if (Date.parse(request.requested_at) >= Date.parse(request.expires_at)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expires_at"],
      message: "approval request must expire after it is requested",
    });
  }
}

export const ScopedApprovalRequest = z
  .object(scopedApprovalRequestShape)
  .strict()
  .superRefine(checkApprovalRequest);
export type ScopedApprovalRequest = z.infer<typeof ScopedApprovalRequest>;

export const ScopedApprovalRequestLenient = z
  .object(scopedApprovalRequestShape)
  .passthrough()
  .superRefine(checkApprovalRequest);

export const ScopedApprovalDecisionValue = z.enum(["approve", "reject"]);
export type ScopedApprovalDecisionValue = z.infer<typeof ScopedApprovalDecisionValue>;

const scopedApprovalDecisionPayloadShape = {
  approval_id: z.string().min(1),
  request_sha256: SHA256,
  autonomy_run_id: z.string().min(1),
  phase: AutonomyApprovalPhase,
  contract_sha256: SHA256,
  diff_sha256: SHA256,
  action_scope: canonicalActionScope,
  decision: ScopedApprovalDecisionValue,
  nonce: z.string().min(1),
  issued_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  decided_by: Actor.refine(
    (actor) => actor.type === "human",
    "guarded autonomy approval requires a human actor",
  ),
} as const;

function checkDecisionValidityWindow(
  payload: { issued_at: string; expires_at: string },
  context: z.RefinementCtx,
): void {
  if (Date.parse(payload.issued_at) >= Date.parse(payload.expires_at)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expires_at"],
      message: "signed approval decision must expire after it is issued",
    });
  }
}

export const ScopedApprovalDecisionPayload = z
  .object(scopedApprovalDecisionPayloadShape)
  .strict()
  .superRefine(checkDecisionValidityWindow);
export type ScopedApprovalDecisionPayload = z.infer<
  typeof ScopedApprovalDecisionPayload
>;

const scopedApprovalDecisionPayloadLenient = z
  .object({
    ...scopedApprovalDecisionPayloadShape,
    decided_by: ActorLenient.refine(
      (actor) => actor.type === "human",
      "guarded autonomy approval requires a human actor",
    ),
  })
  .passthrough()
  .superRefine(checkDecisionValidityWindow);

const signedDecisionSignatureShape = {
  algorithm: z.literal("Ed25519"),
  key_id: z.string().min(1),
  value_base64url: BASE64URL_ED25519_SIGNATURE,
} as const;

export const ScopedApprovalDecision = z
  .object({
    payload: ScopedApprovalDecisionPayload,
    signature: z.object(signedDecisionSignatureShape).strict(),
  })
  .strict();
export type ScopedApprovalDecision = z.infer<typeof ScopedApprovalDecision>;

export const ScopedApprovalDecisionLenient = z
  .object({
    payload: scopedApprovalDecisionPayloadLenient,
    signature: z.object(signedDecisionSignatureShape).passthrough(),
  })
  .passthrough();

export function parseInboundAutonomyRiskDecision(input: unknown) {
  return AutonomyRiskDecisionLenient.parse(input);
}

export function parseInboundScopedApprovalRequest(input: unknown) {
  return ScopedApprovalRequestLenient.parse(input);
}

export function parseInboundScopedApprovalDecision(input: unknown) {
  return ScopedApprovalDecisionLenient.parse(input);
}

/**
 * Validates structural and request-binding invariants. Cryptographic signature,
 * nonce replay, trusted-key, and wall-clock expiry checks belong to the
 * autonomy verifier, which owns those runtime dependencies.
 */
export function validateScopedApprovalDecisionForRequest(
  requestInput: unknown,
  decisionInput: unknown,
): ScopedApprovalDecision {
  const request = ScopedApprovalRequest.parse(requestInput);
  const decision = ScopedApprovalDecision.parse(decisionInput);
  const payload = decision.payload;
  const comparisons: Array<
    [field: string, requestValue: string, decisionValue: string]
  > = [
    ["approval_id", request.approval_id, payload.approval_id],
    ["request_sha256", request.request_sha256, payload.request_sha256],
    ["autonomy_run_id", request.autonomy_run_id, payload.autonomy_run_id],
    ["phase", request.phase, payload.phase],
    ["contract_sha256", request.contract_sha256, payload.contract_sha256],
    ["diff_sha256", request.diff_sha256, payload.diff_sha256],
    ["nonce", request.nonce, payload.nonce],
    ["expires_at", request.expires_at, payload.expires_at],
  ];

  for (const [field, requestValue, decisionValue] of comparisons) {
    if (requestValue !== decisionValue) {
      throw new Error(`scoped approval ${field} does not match request`);
    }
  }
  if (JSON.stringify(request.action_scope) !== JSON.stringify(payload.action_scope)) {
    throw new Error("scoped approval action_scope does not match request");
  }
  if (Date.parse(payload.issued_at) < Date.parse(request.requested_at)) {
    throw new Error("scoped approval issued_at predates its request");
  }
  return decision;
}

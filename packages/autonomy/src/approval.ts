import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import {
  AutonomyApprovalPhase,
  AutonomyRiskLevel,
  ScopedApprovalDecision,
  ScopedApprovalDecisionPayload,
  ScopedApprovalRequest,
  validateScopedApprovalDecisionForRequest,
  type AutonomyApprovalPhase as AutonomyApprovalPhaseType,
  type ScopedApprovalDecision as ScopedApprovalDecisionType,
  type ScopedApprovalRequest as ScopedApprovalRequestType,
} from "@osstack/protocol";
import { z } from "zod";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

const ApprovalScope = z
  .object({
    autonomy_run_id: z.string().min(1),
    phase: AutonomyApprovalPhase,
    contract_sha256: Sha256,
    diff_sha256: Sha256,
    action_scope: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type ApprovalScope = z.infer<typeof ApprovalScope>;

const ApprovalDigestInput = ApprovalScope.omit({ phase: true });
export type ApprovalDigestInput = z.infer<typeof ApprovalDigestInput>;

const CreateScopedApprovalRequestInput = ApprovalScope.extend({
  approval_id: z.string().min(1),
  risk: AutonomyRiskLevel,
  nonce: z.string().min(1),
  requested_at: z.string().datetime(),
  expires_at: z.string().datetime(),
}).strict();
export type CreateScopedApprovalRequestInput = z.infer<
  typeof CreateScopedApprovalRequestInput
>;

export interface ApprovalVerificationContext {
  /** Current authoritative run/diff/action material, not request self-report. */
  expected: ApprovalScope;
  /** Public keys only. The approval private key must stay outside this process. */
  trusted_public_keys: ReadonlyMap<string, string>;
  now: () => string;
  /**
   * Atomically persists first use of a nonce and returns false if it was used.
   * Production callers must back this with durable storage.
   */
  consume_nonce: (nonce: string) => boolean;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function canonicalActionScope(actions: readonly string[]): string[] {
  const parsed = z.array(z.string().min(1)).min(1).parse(actions);
  if (new Set(parsed).size !== parsed.length) {
    throw new Error("approval action_scope contains duplicate actions");
  }
  return [...parsed].sort();
}

export function scopedApprovalDigest(input: ApprovalDigestInput): string {
  const parsed = ApprovalDigestInput.parse(input);
  return createHash("sha256")
    .update(
      canonicalJson({
        action_scope: canonicalActionScope(parsed.action_scope),
        autonomy_run_id: parsed.autonomy_run_id,
        contract_sha256: parsed.contract_sha256,
        diff_sha256: parsed.diff_sha256,
      }),
    )
    .digest("hex");
}

export function createScopedApprovalRequest(
  value: CreateScopedApprovalRequestInput,
): ScopedApprovalRequestType {
  const input = CreateScopedApprovalRequestInput.parse(value);
  if (input.risk === "R4") {
    throw new Error("R4 is permanently blocked and cannot create an approval request");
  }
  if (input.risk !== "R3") {
    throw new Error("only R3 creates a scoped approval request");
  }
  const actionScope = canonicalActionScope(input.action_scope);
  return ScopedApprovalRequest.parse({
    approval_id: input.approval_id,
    autonomy_run_id: input.autonomy_run_id,
    phase: input.phase,
    contract_sha256: input.contract_sha256,
    diff_sha256: input.diff_sha256,
    action_scope: actionScope,
    risk: "R3",
    nonce: input.nonce,
    requested_at: input.requested_at,
    expires_at: input.expires_at,
    request_sha256: scopedApprovalDigest({
      autonomy_run_id: input.autonomy_run_id,
      contract_sha256: input.contract_sha256,
      diff_sha256: input.diff_sha256,
      action_scope: actionScope,
    }),
  });
}

/**
 * The exact canonical byte representation signed by the external Owner
 * decision service. Exported so independent issuers can implement the same
 * deterministic contract.
 */
export function canonicalScopedApprovalDecisionPayload(
  value: ScopedApprovalDecisionPayload,
): string {
  return canonicalJson(ScopedApprovalDecisionPayload.parse(value));
}

const verifiedApprovals = new WeakSet<object>();

export interface VerifiedScopedApproval {
  readonly request: Readonly<ScopedApprovalRequestType>;
  readonly decision: Readonly<ScopedApprovalDecisionType>;
}

class VerifiedScopedApprovalValue implements VerifiedScopedApproval {
  constructor(
    readonly request: Readonly<ScopedApprovalRequestType>,
    readonly decision: Readonly<ScopedApprovalDecisionType>,
  ) {}
}

export function isVerifiedScopedApproval(
  value: unknown,
): value is VerifiedScopedApproval {
  return (
    typeof value === "object" &&
    value !== null &&
    verifiedApprovals.has(value)
  );
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function createVerifiedScopedApproval(
  request: ScopedApprovalRequestType,
  decision: ScopedApprovalDecisionType,
): VerifiedScopedApproval {
  const verified = new VerifiedScopedApprovalValue(
    deepFreeze(request),
    deepFreeze(decision),
  );
  verifiedApprovals.add(verified);
  return Object.freeze(verified);
}

function assertCurrentScope(
  request: ScopedApprovalRequestType,
  expectedInput: ApprovalScope,
): void {
  const expected = ApprovalScope.parse(expectedInput);
  const expectedActions = canonicalActionScope(expected.action_scope);
  const comparisons: Array<
    [field: string, requestValue: string, expectedValue: string]
  > = [
    ["autonomy_run_id", request.autonomy_run_id, expected.autonomy_run_id],
    ["phase", request.phase, expected.phase],
    ["contract_sha256", request.contract_sha256, expected.contract_sha256],
    ["diff_sha256", request.diff_sha256, expected.diff_sha256],
  ];
  for (const [field, requestValue, expectedValue] of comparisons) {
    if (requestValue !== expectedValue) {
      throw new Error(`approval request ${field} does not match current scope`);
    }
  }
  if (JSON.stringify(request.action_scope) !== JSON.stringify(expectedActions)) {
    throw new Error("approval request action_scope does not match current scope");
  }
  const digest = scopedApprovalDigest({
    autonomy_run_id: expected.autonomy_run_id,
    contract_sha256: expected.contract_sha256,
    diff_sha256: expected.diff_sha256,
    action_scope: expectedActions,
  });
  if (request.request_sha256 !== digest) {
    throw new Error("approval request digest does not match current scope");
  }
}

function parsedTime(value: string, label: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${label} is not a valid timestamp`);
  }
  return milliseconds;
}

export function verifyScopedApprovalDecision(
  requestValue: unknown,
  decisionValue: unknown,
  context: ApprovalVerificationContext,
): VerifiedScopedApproval {
  const request = ScopedApprovalRequest.parse(requestValue);
  const decision = ScopedApprovalDecision.parse(decisionValue);
  const expected = ApprovalScope.parse(context.expected);
  assertCurrentScope(request, expected);
  validateScopedApprovalDecisionForRequest(request, decision);

  const now = parsedTime(context.now(), "approval verifier clock");
  const requestedAt = parsedTime(request.requested_at, "request requested_at");
  const issuedAt = parsedTime(decision.payload.issued_at, "decision issued_at");
  const expiresAt = parsedTime(decision.payload.expires_at, "decision expires_at");
  if (now < requestedAt) {
    throw new Error("approval request is from the future");
  }
  if (now < issuedAt) {
    throw new Error("approval decision is from the future");
  }
  if (now >= expiresAt) {
    throw new Error("approval decision has expired");
  }

  const publicKeyPem = context.trusted_public_keys.get(
    decision.signature.key_id,
  );
  if (publicKeyPem === undefined) {
    throw new Error(
      `approval decision key_id ${decision.signature.key_id} is not a trusted public key`,
    );
  }
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("approval verification key must be Ed25519");
  }
  const signature = Buffer.from(
    decision.signature.value_base64url,
    "base64url",
  );
  const validSignature = verifySignature(
    null,
    Buffer.from(canonicalScopedApprovalDecisionPayload(decision.payload)),
    publicKey,
    signature,
  );
  if (!validSignature) {
    throw new Error("approval decision signature is invalid");
  }

  if (!context.consume_nonce(decision.payload.nonce)) {
    throw new Error("approval decision nonce replay detected");
  }
  return createVerifiedScopedApproval(request, decision);
}

export function approvalPhase(
  approval: VerifiedScopedApproval,
): AutonomyApprovalPhaseType {
  if (!isVerifiedScopedApproval(approval)) {
    throw new Error("approval is not cryptographically verified");
  }
  return approval.request.phase;
}

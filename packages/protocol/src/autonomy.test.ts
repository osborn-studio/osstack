import { describe, expect, it } from "vitest";
import {
  AUTONOMY_EMPTY_DIFF_SHA256,
  AutonomyRiskDecision,
  AutonomyRiskLevel,
  AutonomyRunState,
  parseInboundScopedApprovalDecision,
  ScopedApprovalDecision,
  ScopedApprovalRequest,
  validateScopedApprovalDecisionForRequest,
} from "./autonomy.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SIGNATURE = "A".repeat(86);

function approvalRequest() {
  return {
    approval_id: "approval-1",
    autonomy_run_id: "run-1",
    phase: "post_diff",
    contract_sha256: SHA_A,
    diff_sha256: SHA_B,
    action_scope: ["commit", "open_pr", "push"],
    risk: "R3",
    nonce: "nonce-1",
    requested_at: "2026-07-28T20:00:00.000Z",
    expires_at: "2026-07-28T20:15:00.000Z",
    request_sha256: SHA_C,
  } as const;
}

function approvalDecision() {
  return {
    payload: {
      approval_id: "approval-1",
      request_sha256: SHA_C,
      autonomy_run_id: "run-1",
      phase: "post_diff",
      contract_sha256: SHA_A,
      diff_sha256: SHA_B,
      action_scope: ["commit", "open_pr", "push"],
      decision: "approve",
      nonce: "nonce-1",
      issued_at: "2026-07-28T20:01:00.000Z",
      expires_at: "2026-07-28T20:15:00.000Z",
      decided_by: { type: "human", id: "owner" },
    },
    signature: {
      algorithm: "Ed25519",
      key_id: "owner-primary",
      value_base64url: SIGNATURE,
    },
  } as const;
}

describe("guarded autonomy protocol contracts", () => {
  it("parses every RISK-R0 through RISK-R4 level and rejects unknown levels", () => {
    for (const level of ["R0", "R1", "R2", "R3", "R4"]) {
      expect(AutonomyRiskLevel.parse(level)).toBe(level);
    }
    expect(AutonomyRiskLevel.safeParse("R5").success).toBe(false);
  });

  it("accepts the complete legal autonomy state set", () => {
    const states = [
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
    ];

    for (const state of states) {
      expect(AutonomyRunState.parse(state)).toBe(state);
    }
    expect(AutonomyRunState.safeParse("approved").success).toBe(false);
  });

  it("requires canonical deterministic risk signals and matching maximum level", () => {
    const decision = {
      phase: "post_diff",
      level: "R3",
      signals: [
        {
          rule_id: "protected-auth",
          level: "R3",
          message: "authentication surface changed",
          path: "src/auth/session.ts",
        },
      ],
      policy_sha256: SHA_A,
      input_sha256: SHA_B,
      decided_at: "2026-07-28T20:00:00.000Z",
    };

    expect(AutonomyRiskDecision.parse(decision)).toEqual(decision);
    expect(AutonomyRiskDecision.safeParse({ ...decision, level: "R2" }).success).toBe(false);
    expect(
      AutonomyRiskDecision.safeParse({
        ...decision,
        signals: [
          { ...decision.signals[0], rule_id: "z-rule" },
          { ...decision.signals[0], rule_id: "a-rule" },
        ],
      }).success,
    ).toBe(false);
  });

  it("supports preflight approval only against the empty-diff sentinel", () => {
    const request = {
      ...approvalRequest(),
      phase: "preflight",
      diff_sha256: AUTONOMY_EMPTY_DIFF_SHA256,
      action_scope: ["build", "verify"],
    };

    expect(ScopedApprovalRequest.parse(request)).toEqual(request);
    expect(
      ScopedApprovalRequest.safeParse({ ...request, diff_sha256: SHA_B }).success,
    ).toBe(false);
  });

  it("accepts a signed post-diff RISK-R3 decision bound to request material", () => {
    const request = ScopedApprovalRequest.parse(approvalRequest());
    const decision = ScopedApprovalDecision.parse(approvalDecision());

    expect(validateScopedApprovalDecisionForRequest(request, decision)).toEqual(decision);
  });

  it("rejects an agent actor even when the signed envelope is otherwise shaped correctly", () => {
    const decision = approvalDecision();
    expect(
      ScopedApprovalDecision.safeParse({
        ...decision,
        payload: {
          ...decision.payload,
          decided_by: { type: "agent", id: "builder" },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects decisions whose contract or staged diff digest does not match the request", () => {
    const request = ScopedApprovalRequest.parse(approvalRequest());

    expect(() =>
      validateScopedApprovalDecisionForRequest(request, {
        ...approvalDecision(),
        payload: { ...approvalDecision().payload, contract_sha256: "d".repeat(64) },
      }),
    ).toThrow(/contract_sha256/);

    expect(() =>
      validateScopedApprovalDecisionForRequest(request, {
        ...approvalDecision(),
        payload: { ...approvalDecision().payload, diff_sha256: "e".repeat(64) },
      }),
    ).toThrow(/diff_sha256/);
  });

  it("rejects a signed decision issued before its bound request", () => {
    const request = ScopedApprovalRequest.parse(approvalRequest());
    expect(() =>
      validateScopedApprovalDecisionForRequest(request, {
        ...approvalDecision(),
        payload: {
          ...approvalDecision().payload,
          issued_at: "2026-07-28T19:59:59.000Z",
        },
      }),
    ).toThrow(/issued_at/);
  });

  it("has no RISK-R4 approval request contract", () => {
    expect(
      ScopedApprovalRequest.safeParse({ ...approvalRequest(), risk: "R4" }).success,
    ).toBe(false);
  });

  it("keeps producers deep-strict while inbound consumers tolerate additive fields", () => {
    const decision = {
      ...approvalDecision(),
      future_top_level: true,
      payload: {
        ...approvalDecision().payload,
        future_payload_field: "vNext",
        decided_by: {
          ...approvalDecision().payload.decided_by,
          display_name: "Owner",
        },
      },
      signature: {
        ...approvalDecision().signature,
        future_signature_field: "vNext",
      },
    };

    expect(ScopedApprovalDecision.safeParse(decision).success).toBe(false);
    expect(() => parseInboundScopedApprovalDecision(decision)).not.toThrow();
  });

  it("rejects non-canonical or replay-ambiguous scope and invalid validity windows", () => {
    expect(
      ScopedApprovalRequest.safeParse({
        ...approvalRequest(),
        action_scope: ["push", "commit"],
      }).success,
    ).toBe(false);
    expect(
      ScopedApprovalRequest.safeParse({
        ...approvalRequest(),
        action_scope: ["commit", "commit"],
      }).success,
    ).toBe(false);
    expect(
      ScopedApprovalDecision.safeParse({
        ...approvalDecision(),
        payload: {
          ...approvalDecision().payload,
          issued_at: "2026-07-28T20:16:00.000Z",
        },
      }).success,
    ).toBe(false);
  });
});

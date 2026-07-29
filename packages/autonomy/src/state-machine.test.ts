import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  AUTONOMY_EMPTY_DIFF_SHA256,
  type AutonomyRunState,
  type AutonomyApprovalPhase,
  type ScopedApprovalDecisionPayload,
} from "@osstack/protocol";
import { describe, expect, it } from "vitest";
import {
  canonicalScopedApprovalDecisionPayload,
  createScopedApprovalRequest,
  verifyScopedApprovalDecision,
} from "./approval.js";
import {
  LEGAL_TRANSITIONS,
  assertAutonomyTransition,
} from "./state-machine.js";

const CONTRACT_SHA = "a".repeat(64);
const DIFF_SHA = "b".repeat(64);

function verifiedApproval(phase: AutonomyApprovalPhase) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const request = createScopedApprovalRequest({
    approval_id: "approval_001",
    autonomy_run_id: "run_001",
    phase,
    contract_sha256: CONTRACT_SHA,
    diff_sha256:
      phase === "preflight" ? AUTONOMY_EMPTY_DIFF_SHA256 : DIFF_SHA,
    action_scope:
      phase === "preflight"
        ? ["build", "verify"]
        : ["commit", "merge", "open_pr", "push"],
    risk: "R3",
    nonce: "nonce_001",
    requested_at: "2026-07-28T21:55:00.000Z",
    expires_at: "2026-07-28T22:10:00.000Z",
  });
  const payload: ScopedApprovalDecisionPayload = {
    approval_id: request.approval_id,
    request_sha256: request.request_sha256,
    autonomy_run_id: request.autonomy_run_id,
    phase: request.phase,
    contract_sha256: request.contract_sha256,
    diff_sha256: request.diff_sha256,
    action_scope: request.action_scope,
    decision: "approve",
    nonce: request.nonce,
    issued_at: "2026-07-28T21:59:00.000Z",
    expires_at: request.expires_at,
    decided_by: { type: "human", id: "owner_001" },
  };
  const decision = {
    payload,
    signature: {
      algorithm: "Ed25519" as const,
      key_id: "owner-key-001",
      value_base64url: sign(
        null,
        Buffer.from(canonicalScopedApprovalDecisionPayload(payload)),
        privateKey,
      ).toString("base64url"),
    },
  };
  return verifyScopedApprovalDecision(request, decision, {
    expected: {
      autonomy_run_id: request.autonomy_run_id,
      phase: request.phase,
      contract_sha256: request.contract_sha256,
      diff_sha256: request.diff_sha256,
      action_scope: request.action_scope,
    },
    trusted_public_keys: new Map([
      [
        "owner-key-001",
        publicKey.export({ type: "spki", format: "pem" }).toString(),
      ],
    ]),
    now: () => "2026-07-28T22:00:00.000Z",
    consume_nonce: () => true,
  });
}

function verifiedPostDiffApproval() {
  return verifiedApproval("post_diff");
}

describe("guarded autonomy legal state transitions", () => {
  it("routes classification deterministically by maximum risk", () => {
    expect(() =>
      assertAutonomyTransition({
        autonomy_run_id: "run_001",
        from_state: "classifying",
        to_state: "completed",
        risk_level: "R0",
        risk_phase: "preflight",
      }),
    ).not.toThrow();
    for (const risk_level of ["R1", "R2"] as const) {
      expect(() =>
        assertAutonomyTransition({
          autonomy_run_id: "run_001",
          from_state: "classifying",
          to_state: "awaiting_approval",
          risk_level,
          risk_phase: "preflight",
        }),
      ).toThrow(/R1|R2|approval/i);
      expect(() =>
        assertAutonomyTransition({
          autonomy_run_id: "run_001",
          from_state: "classifying",
          to_state: "preparing",
          risk_level,
          risk_phase: "preflight",
        }),
      ).not.toThrow();
    }
    expect(() =>
      assertAutonomyTransition({
        autonomy_run_id: "run_001",
        from_state: "classifying",
        to_state: "preparing",
        risk_level: "R3",
        risk_phase: "preflight",
      }),
    ).toThrow(/awaiting_approval/i);
    expect(() =>
      assertAutonomyTransition({
        autonomy_run_id: "run_001",
        from_state: "classifying",
        to_state: "blocked",
        risk_level: "R4",
        risk_phase: "preflight",
      }),
    ).not.toThrow();
    expect(() =>
      assertAutonomyTransition({
        autonomy_run_id: "run_001",
        from_state: "classifying",
        to_state: "awaiting_approval",
        risk_level: "R4",
        risk_phase: "preflight",
      }),
    ).toThrow(/R4|blocked/i);
    expect(() =>
      assertAutonomyTransition({
        autonomy_run_id: "run_001",
        from_state: "classifying",
        to_state: "escalated",
        risk_level: "R4",
        risk_phase: "preflight",
      }),
    ).toThrow(/R4|blocked/i);
  });

  it("requires a verified post-diff approval to resume directly at candidate proof", () => {
    expect(() =>
      assertAutonomyTransition({
        autonomy_run_id: "run_001",
        from_state: "post_classifying",
        to_state: "candidate_proof",
        risk_level: "R3",
        risk_phase: "post_diff",
      }),
    ).toThrow(/awaiting_approval/i);
    expect(() =>
      assertAutonomyTransition({
        autonomy_run_id: "run_001",
        from_state: "awaiting_approval",
        to_state: "candidate_proof",
      }),
    ).toThrow(/verified.*approval/i);
    expect(() =>
      assertAutonomyTransition({
        autonomy_run_id: "run_001",
        from_state: "awaiting_approval",
        to_state: "candidate_proof",
        verified_approval: {
          request: { phase: "post_diff" },
          decision: { payload: { decision: "approve" } },
        } as never,
      }),
    ).toThrow(/verified.*approval/i);
    expect(() =>
      assertAutonomyTransition({
        autonomy_run_id: "run_001",
        from_state: "awaiting_approval",
        to_state: "candidate_proof",
        verified_approval: verifiedPostDiffApproval(),
        pending_approval_phase: "post_diff",
      }),
    ).not.toThrow();
  });

  it("does not let post-diff authority restart Builder or another run", () => {
    const approval = verifiedPostDiffApproval();
    expect(() =>
      assertAutonomyTransition({
        autonomy_run_id: "run_001",
        from_state: "awaiting_approval",
        to_state: "preparing",
        verified_approval: approval,
        pending_approval_phase: "post_diff",
      }),
    ).toThrow(/post_diff|candidate_proof/i);
    expect(() =>
      assertAutonomyTransition({
        autonomy_run_id: "run_002",
        from_state: "awaiting_approval",
        to_state: "candidate_proof",
        verified_approval: approval,
        pending_approval_phase: "post_diff",
      }),
    ).toThrow(/run/i);
  });

  it("uses preflight authority only to enter preparation", () => {
    const approval = verifiedApproval("preflight");
    expect(() =>
      assertAutonomyTransition({
        autonomy_run_id: "run_001",
        from_state: "awaiting_approval",
        to_state: "preparing",
        verified_approval: approval,
        pending_approval_phase: "preflight",
      }),
    ).not.toThrow();
    expect(() =>
      assertAutonomyTransition({
        autonomy_run_id: "run_001",
        from_state: "awaiting_approval",
        to_state: "candidate_proof",
        verified_approval: approval,
        pending_approval_phase: "post_diff",
      }),
    ).toThrow(/preflight|preparing/i);
  });

  it("allows only a state-verified resume from blocked delivery", () => {
    expect(() =>
      assertAutonomyTransition({
        autonomy_run_id: "run_001",
        from_state: "blocked_delivery",
        to_state: "pushing",
      }),
    ).toThrow(/resume/i);
    expect(() =>
      assertAutonomyTransition({
        autonomy_run_id: "run_001",
        from_state: "blocked_delivery",
        to_state: "pushing",
        blocked_delivery_resume_state: "pushing",
      }),
    ).not.toThrow();
    expect(() =>
      assertAutonomyTransition({
        autonomy_run_id: "run_001",
        from_state: "blocked_delivery",
        to_state: "merging",
        blocked_delivery_resume_state: "pushing",
      }),
    ).toThrow(/resume/i);
  });

  it("keeps true terminal states terminal", () => {
    const terminal: AutonomyRunState[] = [
      "blocked",
      "delivery_evidence_failed",
      "escalated",
      "cancelled",
      "completed",
    ];
    for (const state of terminal) {
      expect(LEGAL_TRANSITIONS[state]).toEqual([]);
      expect(() =>
        assertAutonomyTransition({
          autonomy_run_id: "run_001",
          from_state: state,
          to_state: "queued",
        }),
      ).toThrow(/illegal transition/i);
    }
  });
});

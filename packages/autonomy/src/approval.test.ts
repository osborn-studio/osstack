import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  AUTONOMY_EMPTY_DIFF_SHA256,
  type ScopedApprovalDecision,
  type ScopedApprovalDecisionPayload,
  type ScopedApprovalRequest,
} from "@osstack/protocol";
import { describe, expect, it } from "vitest";
import {
  canonicalScopedApprovalDecisionPayload,
  createScopedApprovalRequest,
  scopedApprovalDigest,
  verifyScopedApprovalDecision,
} from "./approval.js";

const CONTRACT_SHA = "a".repeat(64);
const DIFF_SHA = "b".repeat(64);
const CHANGED_DIFF_SHA = "c".repeat(64);
const NOW = "2026-07-28T22:00:00.000Z";
const REQUESTED_AT = "2026-07-28T21:55:00.000Z";
const EXPIRES_AT = "2026-07-28T22:10:00.000Z";

function approvalKeys(): {
  privateKey: KeyObject;
  publicKeyPem: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKeyPem: publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
  };
}

function postDiffRequest(
  overrides: Partial<Parameters<typeof createScopedApprovalRequest>[0]> = {},
): ScopedApprovalRequest {
  return createScopedApprovalRequest({
    approval_id: "approval_001",
    autonomy_run_id: "run_001",
    phase: "post_diff",
    contract_sha256: CONTRACT_SHA,
    diff_sha256: DIFF_SHA,
    action_scope: ["commit", "merge", "open_pr", "push"],
    risk: "R3",
    nonce: "nonce_001",
    requested_at: REQUESTED_AT,
    expires_at: EXPIRES_AT,
    ...overrides,
  });
}

function signDecision(
  request: ScopedApprovalRequest,
  privateKey: KeyObject,
  overrides: Partial<ScopedApprovalDecisionPayload> = {},
): ScopedApprovalDecision {
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
    decided_by: {
      type: "human",
      id: "owner_001",
    },
    ...overrides,
  };
  return {
    payload,
    signature: {
      algorithm: "Ed25519",
      key_id: "owner-key-001",
      value_base64url: sign(
        null,
        Buffer.from(canonicalScopedApprovalDecisionPayload(payload)),
        privateKey,
      ).toString("base64url"),
    },
  };
}

function currentScope(request: ScopedApprovalRequest) {
  return {
    autonomy_run_id: request.autonomy_run_id,
    phase: request.phase,
    contract_sha256: request.contract_sha256,
    diff_sha256: request.diff_sha256,
    action_scope: request.action_scope,
  };
}

function verifierContext(
  request: ScopedApprovalRequest,
  publicKeyPem: string,
  consumed: Set<string> = new Set(),
) {
  return {
    expected: currentScope(request),
    trusted_public_keys: new Map([["owner-key-001", publicKeyPem]]),
    now: () => NOW,
    consume_nonce: (nonce: string) => {
      if (consumed.has(nonce)) return false;
      consumed.add(nonce);
      return true;
    },
  };
}

describe("scoped approval digest", () => {
  it("is action-order independent and rejects duplicate scope entries", () => {
    const left = scopedApprovalDigest({
      autonomy_run_id: "run_001",
      contract_sha256: CONTRACT_SHA,
      diff_sha256: DIFF_SHA,
      action_scope: ["push", "commit"],
    });
    const right = scopedApprovalDigest({
      autonomy_run_id: "run_001",
      contract_sha256: CONTRACT_SHA,
      diff_sha256: DIFF_SHA,
      action_scope: ["commit", "push"],
    });
    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      scopedApprovalDigest({
        autonomy_run_id: "run_001",
        contract_sha256: CONTRACT_SHA,
        diff_sha256: DIFF_SHA,
        action_scope: ["push", "push"],
      }),
    ).toThrow(/duplicate/i);
  });

  it("changes when run, contract, diff, or action scope changes", () => {
    const baseline = {
      autonomy_run_id: "run_001",
      contract_sha256: CONTRACT_SHA,
      diff_sha256: DIFF_SHA,
      action_scope: ["commit", "push"],
    };
    const digest = scopedApprovalDigest(baseline);
    expect(
      scopedApprovalDigest({ ...baseline, autonomy_run_id: "run_002" }),
    ).not.toBe(digest);
    expect(
      scopedApprovalDigest({ ...baseline, contract_sha256: "d".repeat(64) }),
    ).not.toBe(digest);
    expect(
      scopedApprovalDigest({ ...baseline, diff_sha256: CHANGED_DIFF_SHA }),
    ).not.toBe(digest);
    expect(
      scopedApprovalDigest({ ...baseline, action_scope: ["commit"] }),
    ).not.toBe(digest);
  });
});

describe("signed external approval verification", () => {
  it("verifies a human Ed25519 decision bound to the current post-diff scope", () => {
    const keys = approvalKeys();
    const request = postDiffRequest();
    const decision = signDecision(request, keys.privateKey);
    const verified = verifyScopedApprovalDecision(
      request,
      decision,
      verifierContext(request, keys.publicKeyPem),
    );
    expect(verified.request).toEqual(request);
    expect(verified.decision.payload.decision).toBe("approve");
  });

  it("invalidates an old approval after the current staged diff changes", () => {
    const keys = approvalKeys();
    const request = postDiffRequest();
    const decision = signDecision(request, keys.privateKey);
    expect(() =>
      verifyScopedApprovalDecision(request, decision, {
        ...verifierContext(request, keys.publicKeyPem),
        expected: {
          ...currentScope(request),
          diff_sha256: CHANGED_DIFF_SHA,
        },
      }),
    ).toThrow(/diff_sha256|digest/i);
  });

  it("rejects agent actors, forged signatures, unknown keys, and replayed nonces", () => {
    const keys = approvalKeys();
    const attackerKeys = approvalKeys();
    const request = postDiffRequest();

    expect(() =>
      signDecision(request, keys.privateKey, {
        decided_by: { type: "agent", id: "builder" },
      }),
    ).toThrow(/human/i);

    const forged = signDecision(request, attackerKeys.privateKey);
    expect(() =>
      verifyScopedApprovalDecision(
        request,
        forged,
        verifierContext(request, keys.publicKeyPem),
      ),
    ).toThrow(/signature/i);

    const valid = signDecision(request, keys.privateKey);
    expect(() =>
      verifyScopedApprovalDecision(request, valid, {
        ...verifierContext(request, keys.publicKeyPem),
        trusted_public_keys: new Map(),
      }),
    ).toThrow(/trusted.*key/i);

    const consumed = new Set<string>();
    verifyScopedApprovalDecision(
      request,
      valid,
      verifierContext(request, keys.publicKeyPem, consumed),
    );
    expect(() =>
      verifyScopedApprovalDecision(
        request,
        valid,
        verifierContext(request, keys.publicKeyPem, consumed),
      ),
    ).toThrow(/replay|nonce/i);
  });

  it("rejects expired and future-issued decisions before consuming the nonce", () => {
    const keys = approvalKeys();
    const request = postDiffRequest();
    const consumed = new Set<string>();
    const expired = signDecision(request, keys.privateKey, {
      issued_at: "2026-07-28T21:50:00.000Z",
      expires_at: "2026-07-28T21:59:59.000Z",
    });
    expect(() =>
      verifyScopedApprovalDecision(
        request,
        expired,
        verifierContext(request, keys.publicKeyPem, consumed),
      ),
    ).toThrow(/expires_at|expired/i);
    expect(consumed).toEqual(new Set());

    const futureRequest = postDiffRequest({
      nonce: "nonce_future",
      expires_at: "2026-07-28T22:30:00.000Z",
    });
    const future = signDecision(futureRequest, keys.privateKey, {
      issued_at: "2026-07-28T22:15:00.000Z",
    });
    expect(() =>
      verifyScopedApprovalDecision(
        futureRequest,
        future,
        verifierContext(futureRequest, keys.publicKeyPem, consumed),
      ),
    ).toThrow(/future/i);
    expect(consumed).toEqual(new Set());
  });

  it("limits preflight authority to build/verify and never creates R4 requests", () => {
    const input = {
      approval_id: "approval_preflight",
      autonomy_run_id: "run_001",
      phase: "preflight" as const,
      contract_sha256: CONTRACT_SHA,
      diff_sha256: AUTONOMY_EMPTY_DIFF_SHA256,
      action_scope: ["build", "verify"],
      risk: "R3" as const,
      nonce: "nonce_preflight",
      requested_at: REQUESTED_AT,
      expires_at: EXPIRES_AT,
    };
    const request = createScopedApprovalRequest(input);
    expect(request.action_scope).toEqual(["build", "verify"]);
    expect(() =>
      createScopedApprovalRequest({
        ...input,
        action_scope: ["build", "commit"],
      }),
    ).toThrow(/preflight|action_scope/i);
    expect(() =>
      createScopedApprovalRequest({
        ...input,
        risk: "R4",
      }),
    ).toThrow(/R4/);
  });
});

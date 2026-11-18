import { expect, it } from "vitest";
import type { LocalFailureBinding, LocalVerificationReceipt } from "./local-failure.js";
import { classifyDiagnosis } from "./diagnosis-admission.js";
const binding: LocalFailureBinding = {
  intake_id: "lfi_00000000-0000-4000-8000-000000000001",
  chain_id: "rc_fixture",
  root_mission_id: "cm_fixture",
  grant_id: "rg_fixture",
  repository: "fixture/project",
  pr: 42,
  branch: "contained/fixture",
  head: "a".repeat(40),
  tree: "b".repeat(40),
  base_ref: "main",
  base_sha: "c".repeat(40),
  profile_id: "bridge-v1",
  profile_digest: "d".repeat(64),
  trusted_source_digest: "e".repeat(64),
  invocation_id: "iv_fixture",
};
const profileChecks = [{ check_id: "bridge-contract", category: "test", failure_exit_codes: [1] }];
const receipt = (): LocalVerificationReceipt => ({
  version: 1,
  ...binding,
  started_at: 1000,
  finished_at: 2000,
  outcome: "reproducible_failure",
  checks: [
    {
      check_id: "bridge-contract",
      category: "test",
      exit_code: 1,
      result_digest: "f".repeat(64),
    },
  ],
  bounded_redacted_summary: "Synthetic assertion failed.\nCandidate differs from expected fixture.",
  evidence_digest: "1".repeat(64),
  stop: {
    proven: true,
    proof_ref: "journal:fixture/stop",
    proof_digest: "2".repeat(64),
  },
});

const input = () => ({
  receipt: receipt(),
  binding,
  profileChecks,
  expected_failures: [{ check_id: "bridge-contract", failure_code: "assertion" }],
  allowed_failure_codes: ["assertion"],
  termination: "exited" as const,
  oomKilled: false,
});
it("requires the registered check and registered failure code", () => {
  expect(classifyDiagnosis(input()).state).toBe("eligible");
  for (const change of [{ check_id: "other" }, { failure_code: "other" }])
    expect(
      classifyDiagnosis({
        ...input(),
        expected_failures: [{ ...input().expected_failures[0]!, ...change }],
      }).reason,
    ).toBe("verify_not_reproduced");
  expect(classifyDiagnosis({ ...input(), allowed_failure_codes: ["one", "two"] }).reason).toBe("verify_profile_unavailable");
  for (const exit_code of [0, 2, null]) {
    const r = receipt();
    r.checks[0]!.exit_code = exit_code;
    expect(classifyDiagnosis({ ...input(), receipt: r }).reason).toBe("verify_not_reproduced");
  }
  for (const field of Object.keys(binding)) {
    expect(
      classifyDiagnosis({
        ...input(),
        binding: { ...binding, [field]: "other" },
      }).reason,
    ).toBe("verify_receipt_binding_invalid");
  }
});
it.each(["timeout", "cancelled", "output_limit", "namespace_rejected", "runtime_error"] as const)("holds on %s", (termination) => {
  expect(classifyDiagnosis({ ...input(), termination }).reason).toBe("verify_infrastructure_error");
});
it("holds on OOM", () => expect(classifyDiagnosis({ ...input(), oomKilled: true }).reason).toBe("verify_infrastructure_error"));

import { generateKeyPairSync } from "node:crypto";
import { GRANT_NOW, samplePreview } from "./revision-grant-fixtures.js";
import { signRevisionGrant } from "./revision-grant.js";
import { signLocalFailureRevisionGrant } from "./revision-local-failure-grant.js";
import { verifyDiagnosisGrant } from "./diagnosis-admission.js";
it("binds the signature, refreshed scope, window, candidate and both sources of profile pins", () => {
  const keys = generateKeyPairSync("ed25519"),
    preview = samplePreview();
  const pin = {
    profile_id: "fixture",
    profile_digest: "a".repeat(64),
    trusted_source: {
      repository: "o/trusted",
      commit: "b".repeat(40),
      artifact_digest: "c".repeat(64),
    },
  };
  const grant = signLocalFailureRevisionGrant(
    {
      ...preview,
      version: 2,
      local_failure: {
        ...pin,
        enabled: true,
        diagnostic_timeout_seconds: 20,
        max_diagnostics_per_head: 1,
      },
    },
    keys.privateKey,
  );
  const request = { ...preview, ...pin },
    tree_sha = "a".repeat(40);
  const input = {
    grant_json: JSON.stringify(grant),
    keys: new Map([[grant.key_id, { public_key: keys.publicKey, max_validity_ms: 86400000 }]]),
    principal: {
      principal_id: grant.principal_id,
      client_session_id: grant.client_session_id,
      write_scopes: [grant.scope_id],
    },
    now: GRANT_NOW,
    budget_json: null,
    request,
    installed: pin,
    timeout_seconds: 20,
    tree_sha,
    candidate: { ...preview, tree_sha },
  };
  expect(verifyDiagnosisGrant(input).ok).toBe(true);
  expect(
    verifyDiagnosisGrant({
      ...input,
      grant_json: JSON.stringify(signRevisionGrant(preview, keys.privateKey)),
    }),
  ).toEqual({ ok: false, reason: "verify_grant_missing" });
  const invalid = { ok: false, reason: "verify_grant_invalid" };
  for (const patch of [
    { grant_json: "{}" },
    {
      grant_json: JSON.stringify({
        ...grant,
        signature: "A".repeat(86) + "==",
      }),
    },
    { keys: new Map() },
    { now: grant.expires_at },
    { now: grant.issued_at - 1 },
    { timeout_seconds: 21 },
    { tree_sha: "b".repeat(40) },
    { budget_json: '{"origin":1}' },
  ]) {
    expect(verifyDiagnosisGrant({ ...input, ...patch })).toEqual(invalid);
  }
  for (const patch of [{ principal_id: "other" }, { client_session_id: "other" }, { write_scopes: [] }]) {
    expect(
      verifyDiagnosisGrant({
        ...input,
        principal: { ...input.principal, ...patch },
      }),
    ).toEqual(invalid);
  }
  for (const key of ["repository", "pr_number", "branch", "base_ref", "base_sha", "head_sha", "root_mission_id"]) {
    expect(
      verifyDiagnosisGrant({
        ...input,
        request: { ...request, [key]: "other" },
      }),
    ).toEqual(invalid);
    expect(
      verifyDiagnosisGrant({
        ...input,
        candidate: { ...input.candidate, [key]: "other" },
      }),
    ).toEqual(invalid);
  }
  for (const patch of [
    { profile_id: "other" },
    { profile_digest: "other" },
    ...["repository", "commit", "artifact_digest"].map((key) => ({
      trusted_source: { ...pin.trusted_source, [key]: "other" },
    })),
  ]) {
    expect(verifyDiagnosisGrant({ ...input, request: { ...request, ...patch } })).toEqual(invalid);
    expect(verifyDiagnosisGrant({ ...input, installed: { ...pin, ...patch } })).toEqual(invalid);
  }
});

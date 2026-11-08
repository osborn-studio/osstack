import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./revision-grant.js";
import {
  LOCAL_FAILURE_LIMITS, LocalFailureError, localFailureDedupKey, localFailureEligibility,
  localVerificationReceiptDigest, parseCiFailureHint, parseLocalFailureBinding,
  parseLocalVerificationReceipt, type LocalFailureBinding, type LocalVerificationReceipt,
} from "./local-failure.js";

const binding: LocalFailureBinding = {
  intake_id: "lfi_00000000-0000-4000-8000-000000000001", chain_id: "rc_fixture", root_mission_id: "cm_fixture", grant_id: "rg_fixture",
  repository: "fixture/project", pr: 42, branch: "contained/fixture", head: "a".repeat(40),
  tree: "b".repeat(40), base_ref: "main", base_sha: "c".repeat(40), profile_id: "bridge-v1",
  profile_digest: "d".repeat(64), trusted_source_digest: "e".repeat(64), invocation_id: "iv_fixture",
};
const hint = {
  repository: binding.repository, pr: binding.pr, head: binding.head, app_id: 7, check_run_id: 123,
  name: "Bridge checks", status: "completed", conclusion: "failure", observed_at: 1000,
};
const profileChecks = [{ check_id: "bridge-contract", category: "test", failure_exit_codes: [1] }];
const receipt = (): LocalVerificationReceipt => ({
  version: 1, ...binding, started_at: 1000, finished_at: 2000, outcome: "reproducible_failure",
  checks: [{ check_id: "bridge-contract", category: "test", exit_code: 1, result_digest: "f".repeat(64) }],
  bounded_redacted_summary: "Synthetic assertion failed.\nCandidate differs from expected fixture.",
  evidence_digest: "1".repeat(64), stop: { proven: true, proof_ref: "journal:fixture/stop", proof_digest: "2".repeat(64) },
});

const rejects = (parse: (value: unknown) => unknown, value: unknown, code: string) => {
  try { parse(value); throw new Error("unexpected parse success"); }
  catch (error) { expect(error).toBeInstanceOf(LocalFailureError); expect(error).toHaveProperty("code", code); }
};

describe("CI failure hints", () => {
  it("parses only bounded terminal failure metadata", () => {
    expect(parseCiFailureHint(hint)).toEqual(hint);
    expect(parseCiFailureHint({ ...hint, head: "a".repeat(64) }).head).toHaveLength(64);
  });
  it.each([
    { logs: "run arbitrary command" }, { commands: ["sh", "untrusted"] }, { review_ids: [123] },
    { status: "in_progress" }, { conclusion: "cancelled" }, { conclusion: "success" },
    { head: "abc123" }, { head: "A".repeat(40) }, { repository: "../fixture/project" },
    { pr: 0 }, { app_id: -1 }, { check_run_id: 1.5 }, { pr: Number.MAX_SAFE_INTEGER + 1 },
    { observed_at: -1 }, { observed_at: Infinity }, { observed_at: "2026-11-08T00:00:00Z" },
    { name: "x".repeat(257) }, { name: "\u001b[31mCI" }, { repository: "x".repeat(201) },
  ])("rejects invalid hint %j", patch => rejects(parseCiFailureHint, { ...hint, ...patch }, "ci_failure_hint_invalid"));
});

describe("local failure binding and receipt parsing", () => {
  it("parses the exact binding and clones the input", () => {
    expect(parseLocalFailureBinding(binding)).toEqual(binding);
    const original = receipt(); const parsed = parseLocalVerificationReceipt(original);
    expect(parsed).toEqual(original); expect(parsed).not.toBe(original); expect(parsed.checks).not.toBe(original.checks);
  });
  it.each([
    { head: "f".repeat(39) }, { tree: "f".repeat(41) }, { base_sha: "refs/heads/main" },
    { profile_digest: "sha256:" + "a".repeat(64) }, { trusted_source_digest: "a".repeat(63) },
    { invocation_id: "" }, { root_mission_id: "x".repeat(257) }, { branch: "x\nother" }, { pr: NaN },
    { commands: [] },
  ])("rejects invalid binding %j", patch => rejects(parseLocalFailureBinding, { ...binding, ...patch }, "local_failure_binding_invalid"));
  it.each([
    { version: 2 }, { outcome: "failed" }, { started_at: 2001 }, { started_at: -1 },
    { finished_at: Number.MAX_SAFE_INTEGER }, { finished_at: 2000.1 },
    { bounded_redacted_summary: "x".repeat(4097) }, { bounded_redacted_summary: "🔴".repeat(1025) },
    { bounded_redacted_summary: "\u001b[31msecret" }, { evidence_digest: "" },
    { review_ids: [123] }, { stop: undefined }, { stop: { proven: false } },
    { stop: { proven: true, proof_ref: "", proof_digest: "2".repeat(64) } },
    { stop: { ...receipt().stop, command: "untrusted" } },
    { checks: [] }, { checks: Array.from({ length: 65 }, (_, i) => ({ ...receipt().checks[0], check_id: `check-${i}` })) },
    { checks: [receipt().checks[0], receipt().checks[0]] },
    { checks: [{ ...receipt().checks[0], exit_code: -1 }] },
    { checks: [{ ...receipt().checks[0], exit_code: 256 }] },
    { checks: [{ ...receipt().checks[0], exit_code: 1.5 }] },
    { checks: [{ ...receipt().checks[0], result_digest: "abc" }] },
    { checks: [{ ...receipt().checks[0], logs: "untrusted" }] },
  ])("rejects invalid receipt %j", patch => rejects(parseLocalVerificationReceipt, { ...receipt(), ...patch }, "local_verification_receipt_invalid"));
  it("accepts an exactly bounded UTF-8 summary", () => {
    expect(parseLocalVerificationReceipt({ ...receipt(), bounded_redacted_summary: "🔴".repeat(1024) })
      .bounded_redacted_summary).toHaveLength(2048);
    expect(LOCAL_FAILURE_LIMITS.max_summary_bytes).toBe(4096);
  });
});

describe("local failure eligibility", () => {
  it("requires stopped reproduction under the exact host binding and trusted check contract", () => {
    expect(localFailureEligibility(receipt(), binding, profileChecks)).toEqual({ eligible: true });
  });
  it.each(Object.keys(binding) as (keyof LocalFailureBinding)[])("rejects mismatched %s", field => {
    const expected = { ...binding, [field]: field === "intake_id" ? "lfi_00000000-0000-4000-8000-000000000002" : field === "pr" ? 43 : field === "repository" ? "other/project" :
      ["head", "tree", "base_sha"].includes(field) ? "9".repeat(40) :
      ["profile_digest", "trusted_source_digest"].includes(field) ? "9".repeat(64) : "other" };
    expect(localFailureEligibility(receipt(), expected, profileChecks)).toEqual({ eligible: false, reason: "binding_mismatch", field });
  });
  it.each(["passed", "infrastructure_error", "cancelled", "timeout"] as const)("never dispatches %s", outcome => {
    const value = { ...receipt(), outcome };
    expect(parseLocalVerificationReceipt(value).outcome).toBe(outcome);
    expect(localFailureEligibility(value, binding, profileChecks)).toEqual({ eligible: false, reason: "outcome_ineligible" });
  });
  it.each([undefined, { proven: false }, { ...receipt().stop, proof_digest: "invalid" }])("rejects missing stop proof %j", stop => {
    expect(localFailureEligibility({ ...receipt(), stop }, binding, profileChecks)).toEqual({ eligible: false, reason: "invalid_receipt" });
  });
  it("fails closed for a malformed host binding", () => {
    expect(localFailureEligibility(receipt(), { ...binding, pr: 0 }, profileChecks)).toEqual({ eligible: false, reason: "invalid_binding" });
  });
  it.each([
    [], [{ ...profileChecks[0], category: "other" }], [{ ...profileChecks[0], check_id: "other" }],
    [{ ...profileChecks[0], failure_exit_codes: [2] }],
    [...profileChecks, { check_id: "missing-result", category: "test", failure_exit_codes: [1] }],
    [profileChecks[0], profileChecks[0]], [{ ...profileChecks[0], failure_exit_codes: [] }],
    [{ ...profileChecks[0], failure_exit_codes: [0] }], [{ ...profileChecks[0], commands: ["untrusted"] }],
  ].map(checks => ({ checks })))("requires complete trusted profile checks %j", ({ checks }) => {
    expect(localFailureEligibility(receipt(), binding, checks).eligible).toBe(false);
  });
  it.each([0, null, 127, 137])("does not infer reproduction from exit %j", exit_code => {
    expect(localFailureEligibility({ ...receipt(), checks: [{ ...receipt().checks[0], exit_code }] }, binding, profileChecks).eligible).toBe(false);
  });
  it("permits successful companion checks while requiring at least one defined failure", () => {
    const companion = { check_id: "types", category: "typecheck", exit_code: 0, result_digest: "3".repeat(64) };
    expect(localFailureEligibility({ ...receipt(), checks: [...receipt().checks, companion] }, binding,
      [...profileChecks, { check_id: "types", category: "typecheck", failure_exit_codes: [2] }])).toEqual({ eligible: true });
  });
});

describe("canonical receipt digest and diagnostic deduplication", () => {
  it("hashes a validated, domain-separated canonical receipt independently of object key order", () => {
    const value = receipt(); const reversed = Object.fromEntries(Object.entries(value).reverse());
    const expected = createHash("sha256").update(canonicalJson({ domain: "osstack.local-verification-receipt.v1", receipt: value })).digest("hex");
    expect(localVerificationReceiptDigest(value)).toBe(expected);
    expect(localVerificationReceiptDigest(reversed)).toBe(expected);
    expect(localVerificationReceiptDigest({ ...value, bounded_redacted_summary: "Another failure" })).not.toBe(expected);
    rejects(localVerificationReceiptDigest, { ...value, commands: [] }, "local_verification_receipt_invalid");
  });
  it("deduplicates only chain/head/profile and does not reopen after a new grant or invocation", () => {
    const key = localFailureDedupKey(binding);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(localFailureDedupKey({ ...binding, grant_id: "rg_other", intake_id: "lf_other", invocation_id: "iv_other" })).toBe(key);
    for (const patch of [{ chain_id: "rc_other" }, { head: "f".repeat(40) }, { profile_digest: "f".repeat(64) }]) {
      expect(localFailureDedupKey({ ...binding, ...patch })).not.toBe(key);
    }
    expect(() => localFailureDedupKey({ ...binding, head: "short" })).toThrow(LocalFailureError);
  });
});

describe("canonical host intake IDs", () => {
  it("accepts the UUID-style local intake ID shared with feedback and the ledger", () => {
    expect(parseLocalFailureBinding({ ...binding, intake_id: "lfi_00000000-0000-4000-8000-000000000001" }).intake_id)
      .toBe("lfi_00000000-0000-4000-8000-000000000001");
  });
  it.each(["lf_fixture", "lfi_fixture", "lfi_" + "a".repeat(35), "lfi_00000000-0000-4000-8000-000000000001\n"])("rejects noncanonical intake ID %j", intake_id => {
    expect(() => parseLocalFailureBinding({ ...binding, intake_id })).toThrow("local_failure_binding_invalid");
  });
});

it("rejects trailing newline aliases of immutable SHA and digest fields", () => {
  expect(() => parseCiFailureHint({ ...hint, head: hint.head + "\n" })).toThrow("ci_failure_hint_invalid");
  for (const field of ["head", "tree", "base_sha", "profile_digest", "trusted_source_digest"] as const) {
    expect(() => parseLocalFailureBinding({ ...binding, [field]: binding[field] + "\n" })).toThrow("local_failure_binding_invalid");
  }
  expect(() => parseLocalVerificationReceipt({ ...receipt(), evidence_digest: receipt().evidence_digest + "\n" })).toThrow("local_verification_receipt_invalid");
});

it.each(['bridge:profile', 'a'.repeat(129)])('rejects receipt profile ID outside the installed grammar: %s', profile_id => {
  expect(() => parseLocalFailureBinding({ ...binding, profile_id })).toThrow('local_failure_binding_invalid');
  expect(() => parseLocalVerificationReceipt({ ...receipt(), profile_id })).toThrow('local_verification_receipt_invalid');
});

it.each(['o/.github', 'o/_fixtures', '.owner/_repo'])('preserves a legitimate prefixed repository identity: %s', repository => {
  expect(parseLocalFailureBinding({ ...binding, repository }).repository).toBe(repository);
  expect(parseCiFailureHint({ ...hint, repository }).repository).toBe(repository);
});
it.each(['o/.', 'o/..', './r', '../r', 'o/r/extra', 'o/r\n'])('rejects malformed local repository identity: %s', repository => {
  expect(() => parseLocalFailureBinding({ ...binding, repository })).toThrow('local_failure_binding_invalid');
  expect(() => parseCiFailureHint({ ...hint, repository })).toThrow('ci_failure_hint_invalid');
});

it.each(['é'.repeat(129), 'é'.repeat(256), '验'.repeat(256), '😀'.repeat(128)])('preserves bounded Unicode CI names without truncation: %#', name => {
  expect(parseCiFailureHint({ ...hint, name }).name).toBe(name);
});
it.each(['é'.repeat(257), '验'.repeat(257), '😀'.repeat(129), 'label\u200b', 'label\u2028', 'label\u0000', '  '])('rejects oversized or unsafe CI names: %#', name => {
  expect(() => parseCiFailureHint({ ...hint, name })).toThrow('ci_failure_hint_invalid');
});

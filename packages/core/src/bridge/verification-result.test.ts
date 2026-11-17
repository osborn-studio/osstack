import { describe, expect, it } from "vitest";
import { checkFreshness, checkTransportConclusion, parseVerificationResultV1, verificationDedupKey } from "./verification-result.js";
import { invalidVerificationFixtures, passedVerificationFixture, VERIFICATION_NOW, verificationFixture, withdrawalVerificationFixture } from "./verification-result-fixtures.js";

function parsed(value: unknown = verificationFixture()) {
  const parsed = parseVerificationResultV1(JSON.stringify(value));
  if (!parsed.ok) throw new Error(parsed.code);
  return parsed.result;
}
describe("verification result", () => {
  it.each([verificationFixture(), passedVerificationFixture(), withdrawalVerificationFixture()])("accepts synthetic terminal contract", value => {
    expect(parsed(value).summary.kind).toBe("external_reference");
  });
  it.each([
    ["artifact at /tmp/fixture", "artifact at /tmp/fixture"],
    ["https://invalid.example", "https://invalid.example"],
    ["$(echo unsafe)", "$(echo unsafe)"],
    ["Assertion failed; expected 200 | got 500 (see git log)", "Assertion failed; expected 200 | got 500 (see git log)"],
    ['git status check failed: <expected> & "actual"', "git status check failed: &lt;expected&gt; &amp; &quot;actual&quot;"],
  ])("accepts command-shaped summary as escaped reference data: %s", (summary, content) => {
    expect(parsed({ ...verificationFixture(), summary }).summary).toMatchObject({
      kind: "external_reference", usage: "reference_only", content,
    });
  });
  it.each(["gh" + "p_" + "a".repeat(36), "failed\u0000check", "failed\u202echeck"])("rejects credentials and controls in summary", summary => {
    expect(parseVerificationResultV1(JSON.stringify({ ...verificationFixture(), summary }))).toEqual({
      ok: false, code: "verify_contract_invalid",
    });
  });
  it("rejects command-shaped non-summary fields", () => {
    expect(parseVerificationResultV1(JSON.stringify({ ...verificationFixture(), branch: "git status" }))).toEqual({
      ok: false, code: "verify_contract_invalid",
    });
  });
  it.each(invalidVerificationFixtures)("rejects %s", (_name, mutate) => {
    expect(parseVerificationResultV1(JSON.stringify(mutate(verificationFixture())))).toEqual({
      ok: false, code: _name.startsWith("evidence") && _name !== "evidence secret" ? "verify_evidence_invalid" : "verify_contract_invalid",
    });
  });
  it.each(["not json", "[]", "null", '{"schema_version":1,"schema_version":1}',
    JSON.stringify(verificationFixture()).replace('"runtime_id":"fixture-runtime"', '"runtime_id":"fixture-runtime","runtime_id":"other"'),
    JSON.stringify(verificationFixture()).replace('"schema_version":1', '"schema_version":1,"schema_\\u0076ersion":1'),
  ])("rejects malformed or duplicate keys at all depths", text => {
    expect(parseVerificationResultV1(text)).toEqual({ ok: false, code: "verify_contract_invalid" });
  });
  it("rejects payload over 16 KiB before JSON parsing", () => {
    expect(parseVerificationResultV1(" ".repeat(16385))).toEqual({ ok: false, code: "verify_contract_invalid" });
  });
  it("measures payload UTF8 bytes before parsing", () => {
    expect(parseVerificationResultV1("界".repeat(5462))).toEqual({ ok: false, code: "verify_contract_invalid" });
  });
  it("rejects duplicate keys inside array objects", () => {
    const text = JSON.stringify(verificationFixture()).replace('"check_id":"fixture-check"', '"check_id":"fixture-check","check_id":"other"');
    expect(parseVerificationResultV1(text)).toEqual({ ok: false, code: "verify_contract_invalid" });
  });
  it("accepts exact reference count and summary limits", () => {
    const v = verificationFixture();
    expect(parsed({ ...v, summary: "x".repeat(4096), evidence_refs: Array.from({ length: 32 }, () => v.evidence_refs[0]) }).evidence_refs).toHaveLength(32);
  });
  it("dedup uses fixed canonical tuple order", () => {
    const v = verificationFixture();
    expect(verificationDedupKey(v)).toBe(v.dedup_key);
    expect(verificationDedupKey({ ...v })).toBe(v.dedup_key);
    for (const change of [{ repository_id: 102 }, { pr: 8 }, { head_sha: "f".repeat(40) }, { base_sha: "f".repeat(40) },
      { skill_manifest_digest: "f".repeat(64) }, { profile_digest: "f".repeat(64) }]) {
      expect(verificationDedupKey({ ...v, ...change })).not.toBe(v.dedup_key);
    }
  });
  it.each([
    ["exact expiry boundary", 86400000, true], ["expiry", 86400001, false],
    ["exact future boundary", -300000, true], ["future skew", -300001, false], ["invalid host clock", NaN, false],
  ])("checks fixed host freshness: %s", (_name, offset, accepted) => {
    expect(checkFreshness(parsed(), VERIFICATION_NOW + offset)).toEqual(accepted
      ? { ok: true } : { ok: false, code: "verify_result_expired" });
  });
  it.each([
    [verificationFixture(), "failure"], [passedVerificationFixture(), "success"],
    [withdrawalVerificationFixture(), "cancelled"], [{ ...verificationFixture(), outcome: "blocked" }, "neutral"],
    [{ ...verificationFixture(), outcome: "cancelled" }, "timed_out"],
  ])("cross-checks terminal transport", (v, conclusion) => {
    expect(checkTransportConclusion(parsed(v), { status: "completed", conclusion })).toEqual({ ok: true });
    expect(checkTransportConclusion(parsed(v), { status: "in_progress", conclusion }).ok).toBe(false);
    expect(checkTransportConclusion(parsed(v), { status: "completed", conclusion: "unknown" }).ok).toBe(false);
  });
  it("rejects conflicting success and withdrawal conclusions", () => {
    expect(checkTransportConclusion(parsed(), { status: "completed", conclusion: "success" }).ok).toBe(false);
    expect(checkTransportConclusion(parsed(passedVerificationFixture()), { status: "completed", conclusion: "failure" }).ok).toBe(false);
    expect(checkTransportConclusion(parsed(withdrawalVerificationFixture()), { status: "completed", conclusion: "failure" }).ok).toBe(false);
    expect(checkTransportConclusion(parsed({ ...verificationFixture(), outcome: "blocked" }), { status: "completed", conclusion: "success" }).ok).toBe(false);
  });
});

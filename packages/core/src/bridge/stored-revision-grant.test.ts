import { grantSummary } from "../index.js";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { samplePreview } from "./revision-grant-fixtures.js";
import { parseStoredGrant, signRevisionGrant } from "./revision-grant.js";
import { signLocalFailureRevisionGrant } from "./revision-local-failure-grant.js";
import { parseStoredRevisionGrant, verifyStoredRevisionGrantSignature } from "./stored-revision-grant.js";

const key = generateKeyPairSync("ed25519");
const v1 = () => signRevisionGrant(samplePreview(), key.privateKey);
const v2 = (times: { issued_at?: number; expires_at?: number } = {}) => signLocalFailureRevisionGrant({ ...samplePreview(), ...times, version: 2, local_failure: {
  enabled: true, profile_id: "bridge-contract", profile_digest: "1".repeat(64),
  trusted_source: { repository: "o/trusted", commit: "2".repeat(40), artifact_digest: "3".repeat(64) },
  diagnostic_timeout_seconds: 60, max_diagnostics_per_head: 1,
} }, key.privateKey);

describe("version-aware stored revision grant contract", () => {
  it("reads both versions without widening the historical V1 parser", () => {
    const old = v1(), local = v2();
    expect(parseStoredRevisionGrant(JSON.stringify(old))).toEqual(old);
    expect(parseStoredRevisionGrant(JSON.stringify(local))).toEqual(local);
    expect(parseStoredGrant(JSON.stringify(old))).toEqual(old);
    expect(() => parseStoredGrant(JSON.stringify(local))).toThrow("grant_invalid");
  });
  it.each([1, 2])("verifies only the exact version %i signature and preview", version => {
    const grant = version === 1 ? v1() : v2();
    expect(verifyStoredRevisionGrantSignature(grant, key.publicKey)).toBe(true);
    expect(verifyStoredRevisionGrantSignature({ ...grant, branch: "other" }, key.publicKey)).toBe(false);
    expect(verifyStoredRevisionGrantSignature(grant, generateKeyPairSync("ed25519").publicKey)).toBe(false);
    expect(verifyStoredRevisionGrantSignature({ ...grant, version: version === 1 ? 2 : 1 }, key.publicKey)).toBe(false);
  });
  it.each([0, 3, "1", "2", null, undefined])("refuses unsupported/missing discriminator %j without fallback", version => {
    expect(() => parseStoredRevisionGrant(JSON.stringify({ ...v1(), version }))).toThrow("grant_invalid");
    expect(verifyStoredRevisionGrantSignature({ ...v1(), version }, key.publicKey)).toBe(false);
  });
  it.each(["null", "[]", "true", "{", '"grant"'])('refuses malformed stored value %s', json => {
    expect(() => parseStoredRevisionGrant(json)).toThrow("grant_invalid");
  });
  it("does not strip unknown opt-in fields or accept oversized serialized JSON", () => {
    expect(() => parseStoredRevisionGrant(JSON.stringify({ ...v1(), local_failure: v2().local_failure }))).toThrow("grant_invalid");
    expect(() => parseStoredRevisionGrant(JSON.stringify(v2()) + " ".repeat(4096))).toThrow("grant_invalid");
  });
  it("keeps parsing/signature checks separate from clock or host admission", () => {
    const grant = v2({ issued_at: 1, expires_at: 1000 });
    expect(grant.expires_at).toBeLessThan(1001);
    expect(parseStoredRevisionGrant(JSON.stringify(grant))).toEqual(grant);
    expect(verifyStoredRevisionGrantSignature(grant, key.publicKey)).toBe(true);
  });
});

it("does not let JSON serialization replace the object whose signature is checked", () => {
  const grant = v2();
  expect(verifyStoredRevisionGrantSignature({ ...grant, branch: "changed", toJSON: () => grant }, key.publicKey)).toBe(false);
});

it.each([1, 2])("projects only mission status fields for V%i", version => {
  const grant = version === 1 ? v1() : v2();
  const summary = grantSummary(JSON.stringify(grant));
  const expected = { grant_id: grant.grant_id, rounds: grant.rounds, issued_at: grant.issued_at,
    expires_at: grant.expires_at, review_deadline_ms: grant.review_deadline_ms, budget: grant.budget, key_id: grant.key_id };
  expect(summary).toStrictEqual(version === 1 ? expected : { ...expected, version: 2 });
  if (grant.version === 2) {
    for (const secret of [grant.signature, grant.preview_sha256, grant.nonce, grant.principal_id, grant.client_session_id,
      grant.scope_id, grant.local_failure.profile_digest, ...Object.values(grant.local_failure.trusted_source)]) {
      expect(JSON.stringify(summary)).not.toContain(secret);
    }
  }
});

it("omits unreadable grants from mission status", () => {
  const grant = v2();
  for (const json of ["{", JSON.stringify({ ...grant, local_failure: {} }), JSON.stringify({ ...grant, version: 3 })]) {
    expect(grantSummary(json)).toBeNull();
  }
});

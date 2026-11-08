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

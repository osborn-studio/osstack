import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GRANT_LIMITS, RevisionGrantError, assembleGrant, canonicalJson, grantBindsChain, grantPreviewOf, grantSummary, parseRevisionGrantPreview, parseStoredGrant,
  previewDigest, publicKeyFromSpkiB64, resolveGrantTerms, revisionGrantSigningInput, signRevisionGrant, verifyRevisionGrantSignature,
} from "./revision-grant.js";
import { GRANT_NOW, samplePreview } from "./revision-grant-fixtures.js";

const NOW = GRANT_NOW;
const keys = () => generateKeyPairSync("ed25519");
const spki = (k: ReturnType<typeof keys>) => k.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const code = (fn: () => unknown): string => { try { fn(); } catch (e) { return e instanceof Error ? e.message : String(e); } return "no_error"; };

describe("revision grant signing", () => {
  it("round-trips: a signed grant verifies, stays within the 4096-byte column and keeps its summary free of secrets", () => {
    const k = keys();
    const grant = signRevisionGrant(samplePreview(), k.privateKey);
    expect(verifyRevisionGrantSignature(grant, publicKeyFromSpkiB64(spki(k)))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(grant))).toBeLessThan(GRANT_LIMITS.max_json_bytes);
    expect(parseStoredGrant(JSON.stringify(grant))).toEqual(grant);
    expect(grantPreviewOf(grant)).toEqual(samplePreview());
    const summary = JSON.stringify(grantSummary(JSON.stringify(grant)));
    for (const secret of [grant.signature, grant.preview_sha256, grant.nonce, "human", "cli", "a".repeat(64)]) expect(summary).not.toContain(secret);
  });

  it("refuses a signature from another key, a tampered field, a swapped digest and a malformed signature", () => {
    const k = keys(); const other = keys();
    const grant = signRevisionGrant(samplePreview(), k.privateKey);
    const pub = publicKeyFromSpkiB64(spki(k));
    expect(verifyRevisionGrantSignature(grant, publicKeyFromSpkiB64(spki(other)))).toBe(false);
    for (const tweak of [{ rounds: 2 as const }, { pr_number: 8 }, { head_sha: "9".repeat(40) }, { expires_at: grant.expires_at + 1 }, { scope_id: "f".repeat(64) },
      { principal_id: "mallory" }, { budget: { ...grant.budget, max_executor_seconds: 7200 } }, { nonce: "0".repeat(32) }]) {
      expect(verifyRevisionGrantSignature({ ...grant, ...tweak }, pub), JSON.stringify(tweak)).toBe(false);
    }
    expect(verifyRevisionGrantSignature({ ...grant, preview_sha256: "0".repeat(64) }, pub)).toBe(false);
    expect(verifyRevisionGrantSignature({ ...grant, signature: `${"A".repeat(86)}==` }, pub)).toBe(false);
    expect(code(() => assembleGrant(samplePreview(), "short"))).toBe("grant_signature_invalid");
  });

  it("refuses non-Ed25519 keys on both sides", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(code(() => signRevisionGrant(samplePreview(), rsa.privateKey))).toBe("grant_signature_invalid");
    expect(code(() => publicKeyFromSpkiB64(rsa.publicKey.export({ type: "spki", format: "der" }).toString("base64")))).toBe("grant_signature_invalid");
    expect(code(() => publicKeyFromSpkiB64("not a key"))).toBe("grant_signature_invalid");
  });

  it("signs a domain-separated input that changes with every preview field", () => {
    const base = revisionGrantSigningInput(samplePreview()).toString();
    expect(base).toContain("osstack.revision-grant.v1");
    expect(revisionGrantSigningInput(samplePreview({ nonce: "1".repeat(32) })).toString()).not.toBe(base);
    expect(previewDigest(samplePreview())).toBe(previewDigest(samplePreview()));
  });

  it("parses strictly: unknown fields, rounds above 2, a window over 7 days and an inverted window are refused", () => {
    for (const bad of [{ ...samplePreview(), extra: 1 }, { ...samplePreview(), rounds: 3 }, { ...samplePreview(), rounds: 0 }, { ...samplePreview(), kind: "shadow_hypothetical" },
      samplePreview({ expires_at: NOW + GRANT_LIMITS.max_validity_ms + 1 }), samplePreview({ expires_at: NOW }), samplePreview({ pr_number: 0 }),
      samplePreview({ head_sha: "xyz" }), samplePreview({ nonce: "short" }), samplePreview({ branch: "a\nb" }),
      samplePreview({ budget: { max_executor_seconds: 0, max_container_seconds: 1, max_wall_clock_hours: 1 } })]) {
      expect(code(() => parseRevisionGrantPreview(bad)), JSON.stringify(bad).slice(0, 80)).toBe("grant_invalid");
    }
    expect(code(() => parseStoredGrant("{"))).toBe("grant_invalid");
    expect(code(() => parseStoredGrant(`{"kind":"live","rounds":2}`))).toBe("grant_invalid");
    expect(code(() => parseStoredGrant(" ".repeat(GRANT_LIMITS.max_json_bytes + 1)))).toBe("grant_invalid");
  });

  it("binds the chain columns, and nothing else", () => {
    const grant = signRevisionGrant(samplePreview(), keys().privateKey);
    const chain = { root_mission_id: grant.root_mission_id, repository: "o/r", pr_number: 7, branch: grant.branch, base_ref: "main" };
    expect(grantBindsChain(grant, chain)).toBe(true);
    for (const t of [{ root_mission_id: "cm_00000000-0000-4000-8000-000000000009" }, { repository: "o/x" }, { pr_number: 8 }, { branch: "other" }, { base_ref: "dev" }]) {
      expect(grantBindsChain(grant, { ...chain, ...t })).toBe(false);
    }
  });

  it("applies the owner defaults and bounds (1 round, 24h, 7d max, 24h review, 3600/3600/48h)", () => {
    expect(resolveGrantTerms({}, GRANT_LIMITS.max_validity_ms)).toEqual({ rounds: 1, validity_ms: 86_400_000, review_deadline_ms: 86_400_000, budget: { max_executor_seconds: 3600, max_container_seconds: 3600, max_wall_clock_hours: 48 } });
    expect(resolveGrantTerms({ rounds: 2, expires_ms: GRANT_LIMITS.max_validity_ms }, GRANT_LIMITS.max_validity_ms).rounds).toBe(2);
    expect(resolveGrantTerms({}, 3_600_000).validity_ms).toBe(3_600_000);
    for (const bad of [{ rounds: 3 }, { rounds: 0 }, { expires_ms: GRANT_LIMITS.max_validity_ms + 1 }, { expires_ms: 0 }, { expires_ms: 1.5 }, { review_deadline_ms: 1 },
      { budget: { max_executor_seconds: 0 } }, { budget: { max_wall_clock_hours: 169 } }]) {
      expect(code(() => resolveGrantTerms(bad, GRANT_LIMITS.max_validity_ms)), JSON.stringify(bad)).toBe("grant_terms_invalid");
    }
    expect(code(() => resolveGrantTerms({ expires_ms: 7_200_000 }, 3_600_000))).toBe("grant_terms_invalid");
  });

  it("canonicalises key order and refuses non-finite numbers", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: undefined }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"z":1}]},"b":1}');
    expect(code(() => canonicalJson({ a: Number.NaN }))).toBe("grant_invalid");
    expect(code(() => canonicalJson({ a: () => 1 }))).toBe("grant_invalid");
    expect(new RevisionGrantError("grant_expired").code).toBe("grant_expired");
  });
});

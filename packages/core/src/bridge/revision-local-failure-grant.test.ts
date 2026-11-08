import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GRANT_LIMITS, canonicalJson, parseRevisionGrantPreview, parseStoredGrant, signRevisionGrant, verifyRevisionGrantSignature,
} from "./revision-grant.js";
import { GRANT_NOW, samplePreview } from "./revision-grant-fixtures.js";
import {
  LOCAL_FAILURE_SIGNING_DOMAIN, LocalFailureGrantPreviewSchema, LocalFailureOptInSchema, LocalFailureRevisionGrantSchema,
  localFailurePreviewDigest, localFailureRevisionGrantSigningInput,
  parseLocalFailureGrantPreview, parseLocalFailureRevisionGrant, signLocalFailureRevisionGrant, verifyLocalFailureRevisionGrantSignature,
  type LocalFailureGrantPreview,
} from "./revision-local-failure-grant.js";

const preview = (): LocalFailureGrantPreview => ({
  ...samplePreview(), version: 2,
  local_failure: {
    enabled: true, profile_id: "bridge-offline-v1", profile_digest: "1".repeat(64),
    trusted_source: { repository: "o/trusted", commit: "2".repeat(40), artifact_digest: "3".repeat(64) },
    diagnostic_timeout_seconds: 60, max_diagnostics_per_head: 1,
  },
});
const keys = () => generateKeyPairSync("ed25519");
const digest = (p: unknown) => createHash("sha256").update(canonicalJson(p)).digest("hex");

describe("standalone local-failure grant V2", () => {
  it("round-trips the exact opt-in and all V1 terms under the separate domain", () => {
    const k = keys();
    const p = preview();
    const grant = signLocalFailureRevisionGrant(p, k.privateKey);
    expect(LOCAL_FAILURE_SIGNING_DOMAIN).toBe("osstack.revision-grant.v2");
    expect(JSON.parse(localFailureRevisionGrantSigningInput(p).toString())).toEqual({
      domain: LOCAL_FAILURE_SIGNING_DOMAIN, preview: p, preview_sha256: digest(p),
    });
    expect(localFailurePreviewDigest(p)).toBe(digest(p));
    expect(grant.preview_sha256).toBe(digest(p));
    expect(parseLocalFailureRevisionGrant(JSON.stringify(grant))).toEqual(grant);
    expect(verifyLocalFailureRevisionGrantSignature(grant, k.publicKey)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(grant))).toBeLessThanOrEqual(GRANT_LIMITS.max_json_bytes);
    const { local_failure: _optIn, version: _version, ...shared } = p;
    expect(parseRevisionGrantPreview({ ...shared, version: 1 })).toEqual(samplePreview());
  });

  it("preserves V1 parsing and signing and refuses automatic upgrades in either direction", () => {
    const k = keys();
    const old = signRevisionGrant(samplePreview(), k.privateKey);
    const grant = signLocalFailureRevisionGrant(preview(), k.privateKey);
    expect(parseStoredGrant(JSON.stringify(old))).toEqual(old);
    expect(verifyRevisionGrantSignature(old, k.publicKey)).toBe(true);
    expect(() => parseStoredGrant(JSON.stringify(grant))).toThrow("grant_invalid");
    expect(() => parseRevisionGrantPreview(preview())).toThrow("grant_invalid");
    expect(() => parseLocalFailureRevisionGrant(JSON.stringify(old))).toThrow("grant_invalid");
    expect(() => parseLocalFailureGrantPreview(samplePreview())).toThrow("grant_invalid");
    expect(() => parseLocalFailureGrantPreview({ ...samplePreview(), local_failure: preview().local_failure })).toThrow("grant_invalid");
  });

  it("binds every new field into the preview digest and signature", () => {
    const k = keys();
    const grant = signLocalFailureRevisionGrant(preview(), k.privateKey);
    const lf = grant.local_failure;
    const variants = [
      { ...lf, enabled: false }, { ...lf, profile_id: "another-profile" }, { ...lf, profile_digest: "4".repeat(64) },
      { ...lf, trusted_source: { ...lf.trusted_source, repository: "o/other" } },
      { ...lf, trusted_source: { ...lf.trusted_source, commit: "5".repeat(64) } },
      { ...lf, trusted_source: { ...lf.trusted_source, artifact_digest: "6".repeat(64) } },
      { ...lf, diagnostic_timeout_seconds: 61 }, { ...lf, max_diagnostics_per_head: 2 },
    ];
    for (const local_failure of variants) {
      const changed = { ...preview(), local_failure };
      expect(digest(changed)).not.toBe(grant.preview_sha256);
      // The second form proves that replacing the digest cannot repair the signature.
      for (const preview_sha256 of [grant.preview_sha256, digest(changed)]) {
        expect(verifyLocalFailureRevisionGrantSignature({ ...grant, local_failure, preview_sha256 } as typeof grant, k.publicKey)).toBe(false);
      }
    }
  });

  it("binds inherited authority, renewal chain and displayed revision", () => {
    const k = keys();
    const p = { ...preview(), renews: { chain_id: "rc_00000000-0000-4000-8000-000000000003", revision: 2 } };
    const grant = signLocalFailureRevisionGrant(p, k.privateKey);
    expect(parseLocalFailureRevisionGrant(JSON.stringify(grant)).renews).toEqual(p.renews);
    for (const tweak of [
      { rounds: 2 as const }, { principal_id: "other" }, { client_session_id: "other" }, { scope_id: "f".repeat(64) },
      { root_mission_id: "cm_00000000-0000-4000-8000-000000000004" }, { repository: "o/other" }, { pr_number: 8 },
      { branch: "other" }, { base_ref: "other" }, { base_sha: "f".repeat(40) }, { head_sha: "f".repeat(40) },
      { issued_at: p.issued_at + 1 }, { expires_at: p.expires_at + 1 }, { review_deadline_ms: p.review_deadline_ms + 1 },
      { budget: { ...p.budget, max_executor_seconds: 1 } }, { protected_set_digest: "f".repeat(64) },
      { nonce: "f".repeat(32) }, { key_id: "other" }, { grant_id: "rg_00000000-0000-4000-8000-000000000005" },
      { renews: { ...p.renews, revision: 3 } },
      { renews: { ...p.renews, chain_id: "rc_00000000-0000-4000-8000-000000000006" } },
    ]) {
      expect(verifyLocalFailureRevisionGrantSignature({ ...grant, ...tweak }, k.publicKey), JSON.stringify(tweak)).toBe(false);
    }
    const { renews: _renewal, ...withoutRenewal } = grant;
    expect(verifyLocalFailureRevisionGrantSignature(withoutRenewal, k.publicKey)).toBe(false);
    expect(() => parseLocalFailureGrantPreview({ ...p, renews: { ...p.renews, revision: 0 } })).toThrow("grant_invalid");
  });

  it("refuses cross-domain replay even for the same V2 preview and recomputed digest", () => {
    const k = keys();
    const grant = signLocalFailureRevisionGrant(preview(), k.privateKey);
    const wrongDomain = Buffer.from(canonicalJson({ domain: "osstack.revision-grant.v1", preview: preview(), preview_sha256: grant.preview_sha256 }));
    expect(verifyLocalFailureRevisionGrantSignature({ ...grant, signature: sign(null, wrongDomain, k.privateKey).toString("base64") }, k.publicKey)).toBe(false);
    const old = signRevisionGrant(samplePreview(), k.privateKey);
    expect(verifyLocalFailureRevisionGrantSignature({ ...grant, signature: old.signature }, k.publicKey)).toBe(false);
    expect(verifyRevisionGrantSignature({ ...old, signature: grant.signature }, k.publicKey)).toBe(false);
  });

  it("requires bounded explicit opt-in fields and immutable full trusted commits", () => {
    const p = preview();
    const lf = p.local_failure;
    for (const local_failure of [
      undefined, {}, { ...lf, enabled: undefined }, { ...lf, enabled: false }, { ...lf, enabled: "true" },
      { ...lf, profile_id: "" }, { ...lf, profile_id: "x".repeat(129) }, { ...lf, profile_id: "bad\nprofile" },
      { ...lf, profile_digest: "A".repeat(64) }, { ...lf, max_diagnostics_per_head: 0 }, { ...lf, max_diagnostics_per_head: 2 },
      { ...lf, trusted_source: { ...lf.trusted_source, repository: "https://example.test/o/r" } },
      { ...lf, trusted_source: { ...lf.trusted_source, repository: "x".repeat(201) } },
      { ...lf, trusted_source: { ...lf.trusted_source, commit: "main" } },
      { ...lf, trusted_source: { ...lf.trusted_source, commit: "a".repeat(39) } },
      { ...lf, trusted_source: { ...lf.trusted_source, artifact_digest: "bad" } },
    ]) expect(() => parseLocalFailureGrantPreview({ ...p, local_failure })).toThrow("grant_invalid");
    expect(parseLocalFailureGrantPreview({ ...p, local_failure: { ...lf, trusted_source: { ...lf.trusted_source, commit: "a".repeat(64) } } }).local_failure.trusted_source.commit).toHaveLength(64);
    expect(LocalFailureOptInSchema.safeParse(lf).success).toBe(true);
    for (const name of Object.keys(lf)) {
      const incomplete: Record<string, unknown> = { ...lf };
      delete incomplete[name];
      expect(LocalFailureOptInSchema.safeParse(incomplete).success, name).toBe(false);
    }
  });

  it("bounds positive integral diagnostic time by the signed container and wall-clock caps", () => {
    for (const diagnostic_timeout_seconds of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 3601, 86401]) {
      expect(() => parseLocalFailureGrantPreview({ ...preview(), local_failure: { ...preview().local_failure, diagnostic_timeout_seconds } })).toThrow("grant_invalid");
    }
    const p = { ...preview(), budget: { max_executor_seconds: 1, max_container_seconds: 7200, max_wall_clock_hours: 1 } };
    expect(() => parseLocalFailureGrantPreview({ ...p, local_failure: { ...p.local_failure, diagnostic_timeout_seconds: 3601 } })).toThrow("grant_invalid");
    expect(parseLocalFailureGrantPreview({ ...p, local_failure: { ...p.local_failure, diagnostic_timeout_seconds: 3600 } }).local_failure.diagnostic_timeout_seconds).toBe(3600);
    expect(parseLocalFailureGrantPreview({ ...preview(), local_failure: { ...preview().local_failure, diagnostic_timeout_seconds: 1 } }).local_failure.diagnostic_timeout_seconds).toBe(1);
  });

  it("returns schema failures for non-finite data instead of throwing from safeParse", () => {
    const p = preview();
    const grant = signLocalFailureRevisionGrant(p, keys().privateKey);
    for (const nonFinite of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      const invalid = { ...p, local_failure: { ...p.local_failure, diagnostic_timeout_seconds: nonFinite } };
      expect(LocalFailureGrantPreviewSchema.safeParse(invalid).success).toBe(false);
      expect(LocalFailureRevisionGrantSchema.safeParse({ ...grant, ...invalid }).success).toBe(false);
    }
  });

  it("reuses V1 limits and window semantics; signature validity alone does not mean unexpired authority", () => {
    const p = preview();
    for (const tweak of [
      { rounds: 0 }, { rounds: 3 }, { expires_at: p.issued_at }, { expires_at: p.issued_at - 1 },
      { expires_at: p.issued_at + GRANT_LIMITS.max_validity_ms + 1 }, { review_deadline_ms: 1 },
      { budget: { ...p.budget, max_executor_seconds: GRANT_LIMITS.max_budget.max_executor_seconds + 1 } },
      { budget: { ...p.budget, max_container_seconds: 0 } }, { budget: { ...p.budget, max_wall_clock_hours: 169 } },
      { branch: "bad\nbranch" }, { nonce: "short" }, { pr_number: 0 }, { head_sha: "short" },
    ]) expect(() => parseLocalFailureGrantPreview({ ...p, ...tweak })).toThrow("grant_invalid");
    expect(parseLocalFailureGrantPreview({ ...p, expires_at: p.issued_at + GRANT_LIMITS.max_validity_ms }).expires_at).toBe(p.issued_at + GRANT_LIMITS.max_validity_ms);
    // No wall clock is read. Admission must separately reject now >= expires_at, as with V1.
    const k = keys();
    const historical = signLocalFailureRevisionGrant({ ...p, issued_at: 0, expires_at: 1 }, k.privateKey);
    expect(historical.expires_at).toBeLessThan(GRANT_NOW);
    expect(parseLocalFailureRevisionGrant(JSON.stringify(historical))).toEqual(historical);
    expect(verifyLocalFailureRevisionGrantSignature(historical, k.publicKey)).toBe(true);
  });

  it("rejects unknown fields at every level, malformed JSON and grants above 4096 UTF-8 bytes", () => {
    const p = preview();
    for (const bad of [
      { ...p, extra: 1 }, { ...p, local_failure: { ...p.local_failure, argv: ["bad"] } },
      { ...p, local_failure: { ...p.local_failure, trusted_source: { ...p.local_failure.trusted_source, extra: true } } },
      { ...p, budget: { ...p.budget, extra: 1 } },
    ]) expect(() => parseLocalFailureGrantPreview(bad)).toThrow("grant_invalid");
    const grant = signLocalFailureRevisionGrant(p, keys().privateKey);
    const json = JSON.stringify(grant);
    const remaining = GRANT_LIMITS.max_json_bytes - Buffer.byteLength(json);
    expect(parseLocalFailureRevisionGrant(json + " ".repeat(remaining))).toEqual(grant);
    expect(() => parseLocalFailureRevisionGrant(json + " ".repeat(remaining + 1))).toThrow("grant_invalid");
    for (const bad of ["{", "null", "[]", JSON.stringify({ ...grant, extra: 1 }), JSON.stringify({ ...grant, signature: "short" })]) {
      expect(() => parseLocalFailureRevisionGrant(bad)).toThrow("grant_invalid");
    }
    // Per-field character limits do not replace the aggregate byte limit.
    const oversized = { ...p, principal_id: "界".repeat(256), client_session_id: "界".repeat(256), branch: "界".repeat(255), base_ref: "界".repeat(255) };
    expect(() => parseLocalFailureGrantPreview(oversized)).toThrow("grant_invalid");
    expect(() => signLocalFailureRevisionGrant(oversized, keys().privateKey)).toThrow("grant_invalid");
  });

  it("rejects signing when a valid preview leaves insufficient room for the signature fields", () => {
    const p = { ...preview(), principal_id: "界".repeat(256), client_session_id: "界".repeat(256), branch: "界".repeat(255) };
    const nearLimit = Array.from({ length: 255 }, (_, i) => ({ ...p, base_ref: "界".repeat(i + 1) }))
      .find((candidate) => {
        const bytes = Buffer.byteLength(JSON.stringify(candidate));
        return bytes > GRANT_LIMITS.max_json_bytes - 100 && bytes <= GRANT_LIMITS.max_json_bytes;
      });
    expect(nearLimit).toBeDefined();
    if (!nearLimit) throw new Error("missing boundary fixture");
    expect(parseLocalFailureGrantPreview(nearLimit)).toEqual(nearLimit);
    expect(() => signLocalFailureRevisionGrant(nearLimit, keys().privateKey)).toThrow("grant_invalid");
  });

  it("fails closed for wrong test keys, non-Ed25519 keys, malformed signatures and extra signed data", () => {
    const k = keys();
    const grant = signLocalFailureRevisionGrant(preview(), k.privateKey);
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    expect(() => signLocalFailureRevisionGrant(preview(), ec.privateKey)).toThrow("grant_signature_invalid");
    expect(verifyLocalFailureRevisionGrantSignature(grant, ec.publicKey)).toBe(false);
    expect(verifyLocalFailureRevisionGrantSignature(grant, keys().publicKey)).toBe(false);
    for (const bad of [
      { ...grant, preview_sha256: "0".repeat(64) }, { ...grant, signature: "bad" }, { ...grant, signature: `${grant.signature}ignored` },
      { ...grant, extra: 1 }, { ...grant, local_failure: { ...grant.local_failure, extra: 1 } },
    ]) expect(verifyLocalFailureRevisionGrantSignature(bad, k.publicKey)).toBe(false);
    const { signature: _signature, ...unsigned } = grant;
    expect(() => parseLocalFailureRevisionGrant(JSON.stringify(unsigned))).toThrow("grant_invalid");
  });
});

it.each(['bridge profile', 'bridge:profile', 'bridge/profile', '_bridge', '.bridge', 'bridge@v1', '验证', 'a'.repeat(129)])('rejects signed V2 profile ID outside the installed grammar: %s', profile_id => {
  const k = keys(), p = preview();
  const invalid = { ...p, local_failure: { ...p.local_failure, profile_id } };
  // A real issuer key can sign malformed bytes; parsing must still reject them.
  const preview_sha256 = digest(invalid);
  const signature = sign(null, Buffer.from(canonicalJson({ domain: LOCAL_FAILURE_SIGNING_DOMAIN, preview: invalid, preview_sha256 })), k.privateKey).toString('base64');
  const signed = { ...invalid, preview_sha256, signature };
  expect(() => signLocalFailureRevisionGrant(invalid, k.privateKey)).toThrow('grant_invalid');
  expect(() => parseLocalFailureRevisionGrant(JSON.stringify(signed))).toThrow('grant_invalid');
  expect(verifyLocalFailureRevisionGrantSignature(signed, k.publicKey)).toBe(false);
});

it.each(['o/.', 'o/..', './r', '../r', 'o/r/extra', 'o/r\n'])('refuses invalid new-V2 trusted repository identity %s', repository => {
  const p = preview();
  expect(() => signLocalFailureRevisionGrant({ ...p, local_failure: { ...p.local_failure, trusted_source: { ...p.local_failure.trusted_source, repository } } }, keys().privateKey)).toThrow('grant_invalid');
});

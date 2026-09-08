import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { ContinuationGrantBody, type SignedContinuationGrant } from "@osstack/protocol";
import { describe, expect, it } from "vitest";
import {
  canonicalContinuationGrantBody,
  continuationGrantDigest,
  isVerifiedContinuationGrant,
  verifyContinuationGrant,
} from "./session-continuation-grant.js";

const NOW = "2026-09-08T10:00:00.000Z";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

function body(overrides: Partial<ContinuationGrantBody> = {}): ContinuationGrantBody {
  return ContinuationGrantBody.parse({
    version: 1, grant_id: "grant_1", session_id: "session_1", runtime_id: "codex_cli",
    runtime_policy_sha256: "a".repeat(64), repo_path: "/repos/osstack", initial_turn_id: "turn_1",
    initial_version: 1, issued_at: NOW, expires_at: "2026-09-08T11:00:00.000Z",
    max_resumes: 3, max_checks: 6, turn_timeout_ms: 30_000,
    steps: [{
      phase: "verification", instruction: "Run the frozen verification checks.",
      checks: [{ kind: "json_value_equals", path: ["result", "passed"], expected: true }],
      max_retries: 1, retry_instruction: "Repair the declared output contract.",
    }],
    ...overrides,
  });
}

function signed(overrides: Partial<ContinuationGrantBody> = {}): SignedContinuationGrant {
  const payload = body(overrides);
  return {
    body: payload, key_id: "owner_1",
    signature: sign(null, Buffer.from(canonicalContinuationGrantBody(payload)), privateKey).toString("base64"),
  };
}

function context(now = NOW) {
  return { trusted_public_keys: new Map([["owner_1", publicKeyPem]]), now: () => now };
}

describe("signed session continuation grants", () => {
  it("uses stable sorted JSON bytes, includes parsed defaults, and preserves instruction text", () => {
    const original = body();
    const reordered = Object.fromEntries(Object.entries(original).reverse());
    expect(canonicalContinuationGrantBody(reordered)).toBe(canonicalContinuationGrantBody(original));
    expect(canonicalContinuationGrantBody({
      ...original,
      steps: [{ checks: [{ expected: true, path: ["result", "passed"], kind: "json_value_equals" }],
        retry_instruction: original.steps[0]?.retry_instruction, max_retries: 1,
        instruction: original.steps[0]?.instruction, phase: "verification" }],
    })).toBe(canonicalContinuationGrantBody(original));
    const withoutDefault = { ...original, steps: [{ phase: "next", instruction: "  frozen\ntext  ", checks: [{ kind: "text_equals", expected: "ok" }] }] };
    const canonical = canonicalContinuationGrantBody(withoutDefault);
    expect(canonical).toBe(canonicalContinuationGrantBody(ContinuationGrantBody.parse(withoutDefault)));
    expect(canonical).toBe(canonicalContinuationGrantBody({
      ...withoutDefault, steps: [{ ...withoutDefault.steps[0], retry_instruction: undefined }],
    }));
    expect(JSON.parse(canonical).steps[0]).toMatchObject({ instruction: "  frozen\ntext  ", max_retries: 0 });
    expect(continuationGrantDigest(original)).toBe(createHash("sha256").update(canonicalContinuationGrantBody(original)).digest("hex"));
    expect(continuationGrantDigest(original)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("verifies Ed25519 and returns a deeply frozen runtime-branded copy", () => {
    const envelope = signed();
    const verified = verifyContinuationGrant(envelope, context());
    expect(isVerifiedContinuationGrant(verified)).toBe(true);
    expect(verified.body).toEqual(envelope.body);
    expect(verified.key_id).toBe(envelope.key_id);
    expect(verified.signature).toBe(envelope.signature);
    expect(verified.digest).toBe(continuationGrantDigest(envelope.body));
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.body)).toBe(true);
    expect(Object.isFrozen(verified.body.steps)).toBe(true);
    expect(Object.isFrozen(verified.body.steps[0]?.checks)).toBe(true);
    expect(Object.isFrozen(verified.body.steps[0]?.checks[0])).toBe(true);
    const check = verified.body.steps[0]?.checks[0];
    expect(check?.kind === "json_value_equals" && Object.isFrozen(check.path)).toBe(true);
    expect(() => Object.assign(verified.body, { max_resumes: 32 })).toThrow();
    envelope.body.steps[0]!.instruction = "changed after verification";
    envelope.body.max_resumes = 32;
    expect(verified.body.max_resumes).toBe(3);
    expect(verified.body.steps[0]?.instruction).toBe("Run the frozen verification checks.");
    for (const fake of [null, {}, envelope, { ...verified }, JSON.parse(JSON.stringify(verified)), Object.create(verified)]) {
      expect(isVerifiedContinuationGrant(fake)).toBe(false);
    }
  });

  it("normalizes phase identifiers but binds every instruction byte", () => {
    const original = signed();
    const step = original.body.steps[0]!;
    const samePhase = { ...original, body: { ...original.body, steps: [{ ...step, phase: " verification " }] } };
    expect(continuationGrantDigest(samePhase.body)).toBe(continuationGrantDigest(original.body));
    expect(verifyContinuationGrant(samePhase, context()).body.steps[0]?.phase).toBe("verification");
    const changedText = { ...original, body: { ...original.body, steps: [{ ...step, instruction: ` ${step.instruction} ` }] } };
    expect(continuationGrantDigest(changedText.body)).not.toBe(continuationGrantDigest(original.body));
    expect(() => verifyContinuationGrant(changedText, context())).toThrow(/signature/i);
  });

  it.each([
    { grant_id: "another_grant" }, { session_id: "another_session" }, { runtime_id: "other_runtime" },
    { runtime_policy_sha256: "b".repeat(64) }, { repo_path: "/repos/other" },
    { initial_turn_id: "another_turn" }, { initial_version: 2 },
    { issued_at: "2026-09-08T09:59:59.000Z" }, { expires_at: "2026-09-08T11:01:00.000Z" },
    { max_resumes: 4 }, { max_checks: 7 }, { turn_timeout_ms: 31_000 },
  ])("rejects tampering with a signed binding or budget: %j", (change) => {
    const envelope = signed();
    expect(() => verifyContinuationGrant({ ...envelope, body: { ...envelope.body, ...change } }, context())).toThrow(/signature/i);
  });

  it("binds step order, checks, instructions and retries into the signed body", () => {
    const first = body().steps[0]!;
    const second = { ...first, phase: "delivery", instruction: "Report the checked result." };
    const envelope = signed({ steps: [first, second] });
    const tamperedSteps = [
      [second, first],
      [{ ...first, instruction: "skip verification" }, second],
      [{ ...first, checks: [{ kind: "text_equals", expected: "ok" }] }, second],
      [{ ...first, retry_instruction: "go" }, second],
      [{ ...first, max_retries: 2 }, second],
    ];
    for (const steps of tamperedSteps) {
      expect(() => verifyContinuationGrant({ ...envelope, body: { ...envelope.body, steps } }, context())).toThrow(/signature/i);
    }
  });

  it("rejects unknown, wrong, malformed or non-Ed25519 verification keys", () => {
    const envelope = signed();
    expect(() => verifyContinuationGrant(envelope, { ...context(), trusted_public_keys: new Map() })).toThrow(/trusted|unknown/i);
    const wrong = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => verifyContinuationGrant(envelope, { ...context(), trusted_public_keys: new Map([["owner_1", wrong]]) })).toThrow(/signature/i);
    const otherAlgorithm = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => verifyContinuationGrant(envelope, { ...context(), trusted_public_keys: new Map([["owner_1", otherAlgorithm]]) })).toThrow(/Ed25519/);
    expect(() => verifyContinuationGrant(envelope, { ...context(), trusted_public_keys: new Map([["owner_1", "invalid PEM"]]) })).toThrow();
  });

  it("accepts only a single SPKI public-key PEM, never a private key or appended block", () => {
    const envelope = signed();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    for (const key of [
      privateKeyPem,
      `${publicKeyPem}${publicKeyPem}`,
      `${publicKeyPem}${privateKeyPem}`,
      `untrusted preamble\n${publicKeyPem}`,
      `${publicKeyPem}trailing data`,
    ]) {
      expect(() => verifyContinuationGrant(envelope, {
        ...context(), trusted_public_keys: new Map([["owner_1", key]]),
      })).toThrow(/single SPKI PUBLIC KEY PEM/i);
    }
    expect(isVerifiedContinuationGrant(verifyContinuationGrant(envelope, {
      ...context(), trusted_public_keys: new Map([["owner_1", ` \n${publicKeyPem}\n\t`]]),
    }))).toBe(true);
  });

  it("rejects invalid signatures and non-canonical base64", () => {
    const envelope = signed();
    expect(() => verifyContinuationGrant({ ...envelope, signature: Buffer.alloc(64).toString("base64") }, context())).toThrow(/signature/i);
    // Base64's unused low padding bits must not create alternate serializations.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const index = alphabet.indexOf(envelope.signature[85]!);
    const alternate = `${envelope.signature.slice(0, 85)}${alphabet[index + 1]}==`;
    expect(Buffer.from(alternate, "base64")).toEqual(Buffer.from(envelope.signature, "base64"));
    expect(() => verifyContinuationGrant({ ...envelope, signature: alternate }, context())).toThrow(/base64|signature/i);
    expect(() => verifyContinuationGrant({ ...envelope, algorithm: "none" }, context())).toThrow();
  });

  it("accepts issuance now and a validity interval of exactly 24 hours", () => {
    expect(isVerifiedContinuationGrant(verifyContinuationGrant(signed({ expires_at: "2026-09-09T10:00:00.000Z" }), context()))).toBe(true);
  });

  it.each([
    { issued_at: "2026-09-08T10:00:00.001Z", expires_at: "2026-09-08T11:00:00.000Z" },
    { issued_at: "2026-09-08T09:00:00.000Z", expires_at: NOW },
    { issued_at: NOW, expires_at: NOW },
    { issued_at: NOW, expires_at: "2026-09-08T09:00:00.000Z" },
    { issued_at: NOW, expires_at: "2026-09-09T10:00:00.001Z" },
  ])("rejects future, expired, reversed or overlong validity windows: %j", (window) => {
    expect(() => verifyContinuationGrant(signed(window), context())).toThrow(/future|expired|validity|24 hours/i);
  });

  it("rejects an invalid verifier clock instead of treating it as an unbounded grant", () => {
    for (const now of ["not a timestamp", "September 8 2026 10:00", "2026-02-30T00:00:00Z"]) {
      expect(() => verifyContinuationGrant(signed(), context(now))).toThrow();
    }
  });
});

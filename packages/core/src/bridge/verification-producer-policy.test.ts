import { expect, it } from "vitest";
import { matchVerificationProducer, parseVerificationProducerPolicyV1 } from "./verification-producer-policy.js";
const producer = () => ({ type: "App", app_id: 201, installation_id: 301, repository_id: 101,
  skill_id: "fixture-skill", skill_manifest_digest: "c".repeat(64), profile_id: "fixture-profile", profile_digest: "d".repeat(64),
  allowed_failure_codes: ["assertion_failed"], ttl_ms: 86400000, evidence_store: "fixture-store" });
const observed = () => ({ ...producer(), carrier: "check-run", failure_code: "assertion_failed" });
function policy(value: unknown = { schema_version: 1, producers: [producer()] }) {
  const result = parseVerificationProducerPolicyV1(value);
  if (!result.ok) throw new Error(result.code);
  return result.policy;
}
it("defaults App carrier and disables auto-registration", () => {
  expect(policy().producers[0]).toMatchObject({ carrier: "check-run", auto_registration: false });
  expect(matchVerificationProducer(policy(), observed()).ok).toBe(true);
});
it.each([undefined, null, {}, { schema_version: 1, producers: [] }])("closes missing or empty policy", value => {
  const parsed = parseVerificationProducerPolicyV1(value);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(matchVerificationProducer(parsed.policy, observed())).toEqual({ ok: false, code: "verify_producer_untrusted" });
});
it("checks API identity, not payload claims or names", () => {
  const forged = { ...observed(), app_id: 999, producer: producer(), login: "trusted", name: "fixture-skill" };
  expect(matchVerificationProducer(policy(), forged)).toEqual({ ok: false, code: "verify_producer_untrusted" });
  expect(matchVerificationProducer(policy(), { ...observed(), installation_id: 999 }).ok).toBe(false);
  const { installation_id: _installation, ...withoutInstallation } = observed();
  expect(matchVerificationProducer(policy(), withoutInstallation).ok).toBe(false);
  expect(matchVerificationProducer(undefined, observed()).ok).toBe(false);
});
it("binds repository, skill, profile and allowed failure codes", () => {
  for (const change of [{ repository_id: 102 }, { skill_id: "other" }, { skill_manifest_digest: "f".repeat(64) },
    { profile_id: "other" }, { profile_digest: "f".repeat(64) }, { failure_code: "timeout" }, { carrier: "review" }]) {
    expect(matchVerificationProducer(policy(), { ...observed(), ...change }).ok).toBe(false);
  }
});
it("represents exact User policies but keeps their carrier disabled", () => {
  const { installation_id: _installation, ...common } = producer();
  const user = { ...common, type: "User", app_id: null, actor_id: 401, carrier: "review" };
  expect(parseVerificationProducerPolicyV1({ schema_version: 1, producers: [{ ...user, actor_id: "*" }] }).ok).toBe(false);
  expect(parseVerificationProducerPolicyV1({ schema_version: 1, producers: [{ ...user, installation_id: 301 }] }).ok).toBe(false);
  expect(matchVerificationProducer(policy({ schema_version: 1, producers: [user] }), { ...observed(), type: "User", app_id: null, actor_id: 401, carrier: "review" }).ok).toBe(false);
});
it("strictly rejects malformed policies and identity unions", () => {
  for (const change of [{ extra: true }, { app_id: null }, { app_id: "201" }, { installation_id: 0 }, { actor_id: 401 },
    { type: "User" }, { ttl_ms: 86400001 }, { allowed_failure_codes: [] }, { evidence_store: "https://invalid.example" },
    { auto_registration: "yes" }, { carrier: "status" }]) {
    expect(parseVerificationProducerPolicyV1({ schema_version: 1, producers: [{ ...producer(), ...change }] }).ok).toBe(false);
  }
  expect(parseVerificationProducerPolicyV1({ schema_version: 2, producers: [] }).ok).toBe(false);
  expect(parseVerificationProducerPolicyV1({ schema_version: 1, producers: [], extra: true }).ok).toBe(false);
});

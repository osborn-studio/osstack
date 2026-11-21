import { createHash, generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { verifyDiagnosisGrant } from "./diagnosis-admission.js";
import { verifyRecheckGrant, type RecheckGrantInput } from "./recheck-admission.js";
import { samplePreview } from "./revision-grant-fixtures.js";
import { signRevisionGrant } from "./revision-grant.js";
import { signLocalFailureRevisionGrant, type LocalFailureGrantPreview } from "./revision-local-failure-grant.js";

const keys = generateKeyPairSync("ed25519");
const preview = samplePreview();
const pin = {
  profile_id: "fixture", profile_digest: "a".repeat(64),
  trusted_source: { repository: "o/trusted", commit: "b".repeat(40), artifact_digest: "c".repeat(64) },
};
const diagnostic: LocalFailureGrantPreview = {
  ...preview, version: 2,
  local_failure: { ...pin, enabled: true, diagnostic_timeout_seconds: 20, max_diagnostics_per_head: 1 },
};
const grant = signLocalFailureRevisionGrant({
  ...diagnostic, local_failure: { ...diagnostic.local_failure, recheck: { enabled: true, timeout_seconds: 60 } },
}, keys.privateKey);
const newHead = "f".repeat(40);
const chainId = "rc_00000000-0000-4000-8000-000000000001";
const otherChainId = "rc_00000000-0000-4000-8000-000000000002";
const renewal = (head_sha: string) => signLocalFailureRevisionGrant({
  ...diagnostic, local_failure: grant.local_failure, head_sha, renews: { chain_id: chainId, revision: 1 },
}, keys.privateKey);
const input = (): RecheckGrantInput => ({
  grant_json: JSON.stringify(grant) + "\n",
  keys: new Map([[grant.key_id, { public_key: keys.publicKey, max_validity_ms: grant.expires_at - grant.issued_at }]]),
  principal: { principal_id: grant.principal_id, client_session_id: grant.client_session_id, write_scopes: [grant.scope_id] },
  now: grant.issued_at, budget_json: null,
  run: { ...preview, ...pin, head_sha: newHead },
  chain: { published_head: newHead, published_base: grant.base_sha },
  ledger: { chain_id: chainId, new_head_sha: newHead, base_sha: grant.base_sha },
  installed: pin, timeout_seconds: 20,
});
const invalid = { ok: false, reason: "verify_grant_invalid" };
const missing = { ok: false, reason: "verify_grant_missing" };

it("returns the signed timeout and the digest of the exact stored grant bytes", () => {
  const i = input();
  const { commit, artifact_digest, repository } = pin.trusted_source;
  i.installed = { ...pin, trusted_source: { artifact_digest, commit, repository } };
  expect(verifyRecheckGrant(i)).toEqual({
    ok: true, grant, grant_digest: createHash("sha256").update(i.grant_json).digest("hex"), recheck_timeout_seconds: 60,
  });
});

it("accepts a renewal on the run head only for its signed chain", () => {
  const i = input();
  const renewed = renewal(newHead);
  i.grant_json = JSON.stringify(renewed) + "\n";
  expect(verifyRecheckGrant(i)).toEqual({
    ok: true, grant: renewed, grant_digest: createHash("sha256").update(i.grant_json).digest("hex"), recheck_timeout_seconds: 60,
  });
  expect(verifyRecheckGrant({ ...i, ledger: { ...i.ledger, chain_id: otherChainId } })).toEqual(invalid);
});

it("refuses grants on the run head when the ledger chain ID is missing or empty", () => {
  const i = input();
  i.run.head_sha = i.chain.published_head = i.ledger.new_head_sha = grant.head_sha;
  i.ledger.chain_id = undefined as unknown as string;
  expect(verifyRecheckGrant(i)).toEqual(invalid);
  i.grant_json = JSON.stringify(renewal(grant.head_sha));
  expect(verifyRecheckGrant(i)).toEqual(invalid);
  i.ledger.chain_id = "";
  expect(verifyRecheckGrant(i)).toEqual(invalid);
});

it.each([chainId, otherChainId])("accepts a renewal on a different head for ledger chain %s", chain_id => {
  const i = input();
  expect(verifyRecheckGrant({
    ...i, grant_json: JSON.stringify(renewal(grant.head_sha)), ledger: { ...i.ledger, chain_id },
  }).ok).toBe(true);
});

it("checks scope, expiration, profile and base for a renewal on the run head", () => {
  const i = { ...input(), grant_json: JSON.stringify(renewal(newHead)) };
  for (const patch of [
    { principal: { ...i.principal, write_scopes: [] } }, { now: grant.expires_at },
    { installed: { ...pin, profile_id: "other" } }, { ledger: { ...i.ledger, base_sha: "1".repeat(40) } },
  ]) expect(verifyRecheckGrant({ ...i, ...patch })).toEqual(invalid);
});

it("distinguishes missing capability from invalid authority", () => {
  const v1 = signRevisionGrant(preview, keys.privateKey);
  const old = signLocalFailureRevisionGrant(diagnostic, keys.privateKey);
  for (const stored of [v1, old]) expect(verifyRecheckGrant({ ...input(), grant_json: JSON.stringify(stored) })).toEqual(missing);
  const badSignature = { ...old, signature: grant.signature };
  const tampered = { ...grant, local_failure: { ...grant.local_failure, recheck: { enabled: true, timeout_seconds: 59 } } };
  for (const grant_json of ["{", JSON.stringify(badSignature), JSON.stringify(tampered)])
    expect(verifyRecheckGrant({ ...input(), grant_json })).toEqual(invalid);
  expect(verifyRecheckGrant({ ...input(), keys: new Map() })).toEqual(invalid);
});

it.each([{ principal_id: "other" }, { client_session_id: "other" }, { write_scopes: [] }])("rejects principal change %o", patch => {
  const i = input();
  expect(verifyRecheckGrant({ ...i, principal: { ...i.principal, ...patch } })).toEqual(invalid);
});

it.each([
  { now: grant.expires_at }, { now: grant.issued_at - 1 },
  { keys: new Map([[grant.key_id, { public_key: keys.publicKey, max_validity_ms: grant.expires_at - grant.issued_at - 1 }]]) },
  { budget_json: JSON.stringify({ origin: grant.issued_at - grant.budget.max_wall_clock_hours * 3_600_000 }) },
  { budget_json: "{" }, { timeout_seconds: 0 }, { timeout_seconds: 1.5 }, { timeout_seconds: 61 },
])("rejects a time or budget violation %o", patch => {
  expect(verifyRecheckGrant({ ...input(), ...patch })).toEqual(invalid);
});

it.each([
  { root_mission_id: "other" }, { repository: "o/other" }, { pr_number: 8 },
  { branch: "other" }, { base_ref: "other" }, { base_sha: "a".repeat(40) },
])("requires the signed run binding %o", patch => {
  const i = input();
  const run = { ...i.run, ...patch };
  expect(verifyRecheckGrant({
    ...i, run, chain: { ...i.chain, published_base: run.base_sha }, ledger: { ...i.ledger, base_sha: run.base_sha },
  })).toEqual(invalid);
});

it.each([grant.head_sha, "a".repeat(64), "A".repeat(40)])("rejects an ineligible head even when all pins agree: %s", head_sha => {
  const i = input();
  expect(verifyRecheckGrant({
    ...i, run: { ...i.run, head_sha }, chain: { ...i.chain, published_head: head_sha }, ledger: { ...i.ledger, new_head_sha: head_sha },
  })).toEqual(invalid);
});

it("requires the head and base from both the chain and the ledger", () => {
  const i = input();
  const other = "1".repeat(40);
  for (const patch of [
    { chain: { ...i.chain, published_head: other } }, { ledger: { ...i.ledger, new_head_sha: other } },
    { chain: { ...i.chain, published_base: other } }, { ledger: { ...i.ledger, base_sha: other } },
  ]) expect(verifyRecheckGrant({ ...i, ...patch })).toEqual(invalid);
});

it.each(["run", "installed"] as const)("requires every signed profile pin on %s", target => {
  const i = input();
  for (const patch of [
    { profile_id: "other" }, { profile_digest: "e".repeat(64) },
    ...["repository", "commit", "artifact_digest"].map(field => ({ trusted_source: { ...pin.trusted_source, [field]: "other" } })),
  ]) expect(verifyRecheckGrant({ ...i, [target]: { ...i[target], ...patch } })).toEqual(invalid);
});

it("keeps diagnosis bound to the original grant head when the grant permits a recheck", () => {
  const i = input();
  const tree_sha = "a".repeat(40);
  const diagnose = (head_sha: string) => {
    const request = { ...i.run, head_sha };
    return verifyDiagnosisGrant({ ...i, tree_sha, request, candidate: { ...request, tree_sha } });
  };
  expect(diagnose(newHead)).toEqual(invalid);
  expect(diagnose(grant.head_sha).ok).toBe(true);
});

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BehaviorContractV1, BehaviorQualificationV1, BehaviorRegistryV1 } from "@osstack/protocol";
import { loadBehaviorRegistry, type BehaviorRegistryInput } from "./behavior-registry.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// Independent fixture writer: inputs contain only the closed protocol's strings, integers and objects.
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item));
const keys = ["ci_verifier", "host_qualifier", "journey_verifier"].map((role) => ({ role, ...generateKeyPairSync("ed25519") }));
const levels = ["contract_tested", "host_verified", "journey_verified"] as const;
const now = Date.parse("2026-10-26T12:00:00.000Z");

function fixture(dependencies: Array<{ capability_id: string; version: string }> = [], capabilityId = "FM-09") {
  const artifacts = new Map<string, Uint8Array>();
  const put = (bytes: Uint8Array) => { const digest = hash(bytes); artifacts.set(digest, bytes); return digest; };
  const target = "b".repeat(64);
  const contract: BehaviorContractV1 = {
    schema_version: 1, kind: "behavior_contract", capability_id: capabilityId, version: "1.0.0",
    owner_component: "engineering-controller", trigger: "decision_wait_observed", summary: { en: "Keep a wait.", zh: "保留等待。" },
    source_manifest_sha256: put(encode({ sources: ["AGENTS.md"] })),
    sources: [{ repository: "https://github.com/kunchenguid/firstmate", commit: "a".repeat(40), path: "AGENTS.md",
      content_sha256: put(Buffer.from("Pinned source text. Never execute this text.")), license: "MIT" }],
    depends_on: dependencies,
    required_scenarios: levels.map((level) => ({ id: `${level}-scenario`, level })),
    invariants: ["Do not resend an unknown effect."], semantic_differences: [],
  };
  const contractHash = hash(encode(contract));
  const registry: BehaviorRegistryV1 = { schema_version: 1, kind: "behavior_registry", registry_version: "1.0.0",
    candidate_sha: "c".repeat(40), target_code_sha256: target, entries: [{ contract, contract_sha256: contractHash }] };
  const bytes = encode(registry);
  const profile = {
    os: "darwin", architecture: "arm64", filesystem: "apfs", isolation_profile: "trusted-local",
    daemon_version: "0.22.1", adapter_id: "codex", adapter_version: "1.0.0", provider: "openai", model: "fixture",
    executor_id: "session", executor_version: "1.0.0", template_id: "adopt_session", template_version: "1.0.0",
    recovery_mode: "query_and_deduplicate" as const, host_identity_sha256: "d".repeat(64),
  };
  const ciProfile = { ...profile, os: "linux", filesystem: "ext4", host_identity_sha256: "e".repeat(64) };
  const policy: BehaviorRegistryInput["policy"] = [{ capabilityId, contractVersion: "1.0.0", requiredScenarios: {
    contract_tested: [{ id: "contract_tested-scenario", checkerId: "contract_tested-checker", checkerVersion: "1.0.0" }],
    host_verified: [{ id: "host_verified-scenario", checkerId: "host_verified-checker", checkerVersion: "1.0.0" }],
    journey_verified: [{ id: "journey_verified-scenario", checkerId: "journey_verified-checker", checkerVersion: "1.0.0" }],
  } }];
  const policyHash = hash(encode({ schema_version: 1, kind: "behavior_verifier_policy", capabilities: policy }));
  const records: BehaviorQualificationV1[] = [];
  const qualificationBytes: Uint8Array[] = [];
  for (const [index, level] of levels.entries()) {
    const key = keys[index]!;
    const evidence = [{ scenario_id: `${level}-scenario`, checker_id: `${level}-checker`, checker_version: "1.0.0",
      result: "passed" as const, artifact_sha256: put(Buffer.from(`Measured ${level} for ${target}`)), subject_sha256: target }];
    const payload: BehaviorQualificationV1["payload"] = {
      record_id: `record-${index}`, capability_id: capabilityId, profile: index === 0 ? ciProfile : profile,
      candidate_sha: registry.candidate_sha, target_code_sha256: target, behavior_contract_sha256: contractHash,
      source_manifest_sha256: contract.source_manifest_sha256, policy_profile_sha256: policyHash, registry_sha256: hash(bytes),
      level, evidence_bundle_sha256: put(encode({ schema_version: 1, candidate_sha: registry.candidate_sha, limitations: [], evidence })), evidence_refs: evidence,
      limitations: [], issuer_role: key.role as BehaviorQualificationV1["payload"]["issuer_role"],
      issued_at: "2026-10-26T00:00:00.000Z", expires_at: "2026-10-27T00:00:00.000Z", revocation_epoch: 3,
      signer_key_id: `key-${index}`, required_scenario_set_sha256: hash(encode([`${level}-scenario`])),
      prerequisite_record_sha256: index === 0 ? [] : [hash(qualificationBytes[index - 1]!)],
    };
    const record = { schema_version: 1 as const, canonicalization: "RFC8785" as const, payload,
      signature: { algorithm: "Ed25519" as const, value_base64: sign(null, encode(payload), key.privateKey).toString("base64") } };
    records.push(record); qualificationBytes.push(encode(record));
  }
  const input: BehaviorRegistryInput = {
    registryBytes: bytes, expectedRegistrySha256: hash(bytes), expectedRegistryVersion: "1.0.0",
    nowMs: now, qualificationBytes,
    target: { candidateSha: registry.candidate_sha, targetCodeSha256: target, policyProfileSha256: policyHash, hostProfile: profile, ciProfile },
    policy,
    trust: {
      keys: keys.map((key, index) => ({ keyId: `key-${index}`, publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
        issuerRole: key.role as BehaviorQualificationV1["payload"]["issuer_role"], capabilityIds: [capabilityId],
        profileSha256s: [hash(encode(index === 0 ? ciProfile : profile))] })),
      minimumRevocationEpoch: 3, maxRevocationAgeMs: 7200000, maxQualificationLifetimeMs: 7 * 24 * 3600000,
      revocations: { epoch: 3, issuedAtMs: now - 1000, expiresAtMs: now + 3600000, revokedKeyIds: [], revokedRecordIds: [] },
    },
    readArtifact: (digest) => artifacts.get(digest),
  };
  // Mutations of signed payloads re-sign only that record. Later hashes intentionally become stale.
  const replaceRecord = (index: number, mutate: (record: BehaviorQualificationV1) => void) => {
    mutate(records[index]!);
    records[index]!.signature.value_base64 = sign(null, encode(records[index]!.payload), keys[index]!.privateKey).toString("base64");
    input.qualificationBytes[index] = encode(records[index]);
  };
  return { input, contract, registry, records, artifacts, put, replaceRecord };
}
const eligible = (input: BehaviorRegistryInput) => loadBehaviorRegistry(input).entries.filter((entry) => entry.selectionEligible);

describe("trusted behavior registry loading", () => {
  it("loads a fully verified same-candidate chain while granting no execution authority", () => {
    const { input } = fixture(); const result = loadBehaviorRegistry(input);
    expect(result.status).toBe("loaded");
    expect(result.authorization).toBe("none");
    expect(result.entries[0]).toMatchObject({ capabilityId: "FM-09", selectionEligible: true, reasons: [],
      qualificationSha256s: input.qualificationBytes.map(hash), validUntilMs: input.trust.revocations.expiresAtMs });
    expect(Object.isFrozen(result.entries[0])).toBe(true);
  });
  it("leaves a correctly shaped but unqualified declaration disabled", () => {
    const { input } = fixture(); input.qualificationBytes = [];
    expect(loadBehaviorRegistry(input).entries[0]).toMatchObject({ selectionEligible: false, reasons: ["qualification_missing_or_invalid"] });
  });
  it("rejects substituted registry bytes before consulting evidence", () => {
    const { input } = fixture(); input.registryBytes = Buffer.from("{}");
    input.readArtifact = () => { throw new Error("must not read"); };
    expect(loadBehaviorRegistry(input).rejection).toBe("registry_digest_mismatch");
  });
  it("requires the expected registry version and current code identity", () => {
    for (const field of ["candidateSha", "targetCodeSha256"] as const) {
      const { input } = fixture(); input.target[field] = "0".repeat(field === "candidateSha" ? 40 : 64);
      expect(loadBehaviorRegistry(input).rejection).toBe("candidate_mismatch");
    }
    const { input } = fixture(); input.expectedRegistryVersion = "2.0.0";
    expect(loadBehaviorRegistry(input).rejection).toBe("registry_version_mismatch");
  });
  it("rejects duplicate JSON keys, unknown fields and noncanonical registry bytes", () => {
    for (const mutate of [(s: string) => s.replace('"schema_version":1', '"schema_version":1,"schema_version":1'),
      (s: string) => `${s}\n`, (s: string) => s.replace('"kind":"behavior_registry"', '"kind":"behavior_registry","command":"exec"')]) {
      const { input } = fixture(); input.registryBytes = Buffer.from(mutate(Buffer.from(input.registryBytes).toString()));
      input.expectedRegistrySha256 = hash(input.registryBytes);
      expect(loadBehaviorRegistry(input).rejection).toBe("registry_invalid");
    }
  });
  it("does not accept a delivery projection as a qualification", () => {
    const { input } = fixture(); input.qualificationBytes = [encode({ kind: "behavior_delivery", state: "local_verified" })];
    expect(eligible(input)).toHaveLength(0);
  });
  it("rejects duplicate qualification keys and invalid UTF-8 before signature evaluation", () => {
    const { input } = fixture();
    input.qualificationBytes[2] = Buffer.from(Buffer.from(input.qualificationBytes[2]!).toString()
      .replace('"record_id":"record-2"', '"record_id":"record-2","record_id":"record-2"'));
    expect(eligible(input)).toHaveLength(0);
    const other = fixture(); other.input.registryBytes = Buffer.concat([Buffer.from([0xff]), Buffer.from(other.input.registryBytes)]);
    other.input.expectedRegistrySha256 = hash(other.input.registryBytes);
    expect(loadBehaviorRegistry(other.input).rejection).toBe("registry_invalid");
  });
  it("checks the declared behavior digest independently of the registry digest", () => {
    const { input, registry } = fixture(); registry.entries[0]!.contract_sha256 = "0".repeat(64);
    input.registryBytes = encode(registry); input.expectedRegistrySha256 = hash(input.registryBytes);
    expect(loadBehaviorRegistry(input).entries[0]?.reasons).toContain("contract_digest_mismatch");
  });
  it("verifies signature bytes instead of trusting claimed issuer fields", () => {
    const { input, records } = fixture(); records[2]!.payload.limitations = ["Altered after signing."];
    input.qualificationBytes[2] = encode(records[2]);
    expect(eligible(input)).toHaveLength(0);
    expect(loadBehaviorRegistry(input).qualificationRejections.some((entry) => entry.reason === "signature_invalid")).toBe(true);
  });
  it("rejects a host claim signed by a CI-only key, even with a valid signature", () => {
    const { input, records } = fixture(); const record = records[1]!;
    record.payload.signer_key_id = "key-0";
    record.signature.value_base64 = sign(null, encode(record.payload), keys[0]!.privateKey).toString("base64");
    input.qualificationBytes[1] = encode(record);
    expect(eligible(input)).toHaveLength(0);
    expect(loadBehaviorRegistry(input).qualificationRejections.some((entry) => entry.reason === "issuer_scope_mismatch")).toBe(true);
  });
  it("enforces key capability and exact profile scope", () => {
    for (const field of ["capabilityIds", "profileSha256s"] as const) {
      const { input } = fixture(); input.trust.keys[2]![field] = [];
      expect(eligible(input)).toHaveLength(0);
    }
    const { input } = fixture(); input.target.hostProfile.host_identity_sha256 = "0".repeat(64);
    expect(eligible(input)).toHaveLength(0);
  });
  it("invalidates every signed candidate, source, contract and policy binding mutation", () => {
    for (const field of ["candidate_sha", "target_code_sha256", "behavior_contract_sha256", "source_manifest_sha256", "policy_profile_sha256", "registry_sha256"] as const) {
      const { input, replaceRecord } = fixture(); replaceRecord(2, (record) => { record.payload[field] = "0".repeat(field === "candidate_sha" ? 40 : 64); });
      expect(eligible(input), field).toHaveLength(0);
    }
  });
  it("rejects expired, future-issued and future-revocation records", () => {
    for (const mutate of [(r: BehaviorQualificationV1) => { r.payload.expires_at = "2026-10-26T12:00:00.000Z"; },
      (r: BehaviorQualificationV1) => { r.payload.issued_at = "2026-10-26T13:00:00.000Z"; },
      (r: BehaviorQualificationV1) => { r.payload.revocation_epoch = 4; }]) {
      const { input, replaceRecord } = fixture(); replaceRecord(2, mutate); expect(eligible(input)).toHaveLength(0);
    }
  });
  it("rejects stale or rolled-back revocation state", () => {
    for (const mutate of [(input: BehaviorRegistryInput) => { input.trust.revocations.epoch = 2; },
      (input: BehaviorRegistryInput) => { input.trust.revocations.expiresAtMs = now; },
      (input: BehaviorRegistryInput) => { input.trust.revocations.issuedAtMs = now + 1; }]) {
      const { input } = fixture(); mutate(input); expect(loadBehaviorRegistry(input).rejection).toBe("revocation_unavailable");
    }
  });
  it("enforces the host's maximum qualification lifetime and revocation cache age", () => {
    const { input } = fixture(); input.trust.maxQualificationLifetimeMs = 3600000;
    expect(eligible(input)).toHaveLength(0);
    const other = fixture(); other.input.trust.maxRevocationAgeMs = 1000;
    expect(loadBehaviorRegistry(other.input).rejection).toBe("revocation_unavailable");
  });
  it("re-evaluates revocations on each load, including predecessor revocation", () => {
    const { input } = fixture(); expect(eligible(input)).toHaveLength(1);
    input.trust.revocations.revokedRecordIds.push("record-0"); expect(eligible(input)).toHaveLength(0);
    input.trust.revocations.revokedRecordIds = []; input.trust.revocations.revokedKeyIds.push("key-2");
    expect(eligible(input)).toHaveLength(0);
  });
  it("requires the exact trusted scenario set and checker identity", () => {
    for (const mutate of [(r: BehaviorQualificationV1) => { r.payload.required_scenario_set_sha256 = "0".repeat(64); },
      (r: BehaviorQualificationV1) => { r.payload.evidence_refs[0]!.checker_id = "worker-self-report"; },
      (r: BehaviorQualificationV1) => { r.payload.evidence_refs[0]!.result = "not_run"; },
      (r: BehaviorQualificationV1) => { r.payload.evidence_refs[0]!.subject_sha256 = "0".repeat(64); }]) {
      const { input, replaceRecord } = fixture(); replaceRecord(2, mutate); expect(eligible(input)).toHaveLength(0);
    }
    const { input } = fixture(); input.policy[0]!.requiredScenarios.journey_verified.push({ id: "missing", checkerId: "check", checkerVersion: "1.0.0" });
    expect(eligible(input)).toHaveLength(0);
  });
  it("binds the actual host verifier policy, including required checkers, to its pinned digest", () => {
    const { input } = fixture(); input.policy[0]!.requiredScenarios.journey_verified[0]!.checkerId = "replacement-checker";
    expect(loadBehaviorRegistry(input).rejection).toBe("policy_digest_mismatch");
  });
  it("requires the evidence bundle to contain the signed evidence and treats limitations conservatively", () => {
    const f = fixture(); f.replaceRecord(2, (record) => {
      record.payload.evidence_bundle_sha256 = f.put(encode({ schema_version: 1, candidate_sha: f.registry.candidate_sha, limitations: [],
        evidence: [{ ...record.payload.evidence_refs[0], checker_version: "2.0.0" }] }));
    });
    expect(loadBehaviorRegistry(f.input).qualificationRejections.some((entry) => entry.reason === "evidence_bundle_mismatch")).toBe(true);
    const other = fixture(); other.replaceRecord(2, (record) => { record.payload.limitations = ["Cannot stop the worker."]; });
    expect(eligible(other.input)).toHaveLength(0);
  });
  it("re-reads evidence artifacts and sources and rejects unavailable or substituted bytes", () => {
    for (const select of [(f: ReturnType<typeof fixture>) => f.records[2]!.payload.evidence_refs[0]!.artifact_sha256,
      (f: ReturnType<typeof fixture>) => f.records[2]!.payload.evidence_bundle_sha256,
      (f: ReturnType<typeof fixture>) => f.contract.source_manifest_sha256,
      (f: ReturnType<typeof fixture>) => f.contract.sources[0]!.content_sha256]) {
      const f = fixture(); f.artifacts.set(select(f), Buffer.from("replacement")); expect(eligible(f.input)).toHaveLength(0);
      f.artifacts.delete(select(f)); expect(eligible(f.input)).toHaveLength(0);
    }
    const { input } = fixture(); input.readArtifact = () => { throw new Error("unavailable"); }; expect(eligible(input)).toHaveLength(0);
  });
  it("rejects missing, wrong-level or changed predecessor records", () => {
    const { input, replaceRecord } = fixture(); replaceRecord(2, (record) => { record.payload.prerequisite_record_sha256 = [hash(input.qualificationBytes[0]!)]; });
    expect(eligible(input)).toHaveLength(0);
    const other = fixture(); other.input.qualificationBytes.shift(); expect(eligible(other.input)).toHaveLength(0);
  });
  it("rejects ambiguous qualification IDs and invalid trust configuration", () => {
    const { input, records } = fixture(); const altered = structuredClone(records[2]!); altered.payload.limitations = ["Another receipt"];
    altered.signature.value_base64 = sign(null, encode(altered.payload), keys[2]!.privateKey).toString("base64");
    input.qualificationBytes.push(encode(altered)); expect(eligible(input)).toHaveLength(0);
    const second = fixture(); second.input.trust.keys.push(second.input.trust.keys[0]!);
    expect(loadBehaviorRegistry(second.input).rejection).toBe("invalid_context");
  });
  it("keeps unresolved and version-mismatched dependencies disabled", () => {
    const missing = fixture([{ capability_id: "FM-02", version: "1.0.0" }]);
    expect(loadBehaviorRegistry(missing.input).entries[0]?.reasons).toContain("dependency_missing");
    const f = fixture([{ capability_id: "FM-02", version: "2.0.0" }]);
    f.registry.entries.push({ contract: { ...f.contract, capability_id: "FM-02", depends_on: [] }, contract_sha256: "0".repeat(64) });
    f.input.registryBytes = encode(f.registry); f.input.expectedRegistrySha256 = hash(f.input.registryBytes);
    expect(loadBehaviorRegistry(f.input).entries[0]?.reasons).toContain("dependency_version_mismatch");
  });
  it("detects cycles and does not let an unqualified dependency become a route", () => {
    const f = fixture([{ capability_id: "FM-02", version: "1.0.0" }]);
    const dependency = { ...f.contract, capability_id: "FM-02", depends_on: [{ capability_id: "FM-09", version: "1.0.0" }] };
    f.registry.entries.push({ contract: dependency, contract_sha256: hash(encode(dependency)) });
    f.input.registryBytes = encode(f.registry); f.input.expectedRegistrySha256 = hash(f.input.registryBytes);
    expect(loadBehaviorRegistry(f.input).entries.every((entry) => entry.reasons.includes("dependency_cycle"))).toBe(true);
    dependency.depends_on = []; f.registry.entries[1]!.contract_sha256 = hash(encode(dependency));
    f.input.registryBytes = encode(f.registry); f.input.expectedRegistrySha256 = hash(f.input.registryBytes);
    expect(loadBehaviorRegistry(f.input).entries[0]?.reasons).toContain("dependency_unqualified");
  });
  it("propagates a dependency's earlier expiry and later revocation to the parent", () => {
    const parent = fixture([{ capability_id: "FM-02", version: "1.0.0" }]);
    const child = fixture([], "FM-02");
    parent.registry.entries.push(child.registry.entries[0]!);
    parent.input.registryBytes = encode(parent.registry); parent.input.expectedRegistrySha256 = hash(parent.input.registryBytes);
    parent.input.policy.push(child.input.policy[0]!);
    parent.input.target.policyProfileSha256 = hash(encode({ schema_version: 1, kind: "behavior_verifier_policy", capabilities: parent.input.policy }));
    for (const key of parent.input.trust.keys) key.capabilityIds.push("FM-02");
    for (const [digest, bytes] of child.artifacts) parent.artifacts.set(digest, bytes);
    parent.input.qualificationBytes = [];
    for (const [group, records] of [parent.records, child.records].entries()) {
      let previous: string | undefined;
      for (const [index, record] of records.entries()) {
        record.payload.registry_sha256 = parent.input.expectedRegistrySha256;
        record.payload.policy_profile_sha256 = parent.input.target.policyProfileSha256;
        record.payload.prerequisite_record_sha256 = previous ? [previous] : [];
        if (group === 1) {
          record.payload.record_id = `child-record-${index}`;
          record.payload.expires_at = "2026-10-26T12:01:00.000Z";
        }
        record.signature.value_base64 = sign(null, encode(record.payload), keys[index]!.privateKey).toString("base64");
        const bytes = encode(record); previous = hash(bytes); parent.input.qualificationBytes.push(bytes);
      }
    }
    const result = loadBehaviorRegistry(parent.input);
    expect(result.entries.every((entry) => entry.selectionEligible)).toBe(true);
    expect(result.entries.map((entry) => entry.validUntilMs)).toEqual([now + 60000, now + 60000]);
    parent.input.trust.revocations.revokedRecordIds.push("child-record-2");
    expect(loadBehaviorRegistry(parent.input).entries[0]).toMatchObject({ selectionEligible: false,
      validUntilMs: null, reasons: ["dependency_unqualified"] });
  });
  it("captures time, build identity, records and trust before invoking a reentrant artifact reader", () => {
    const { input, artifacts } = fixture();
    input.readArtifact = (digest) => {
      input.nowMs += 2 * 86400000; input.expectedRegistrySha256 = "0".repeat(64);
      input.qualificationBytes = []; input.target.candidateSha = "0".repeat(40);
      input.trust.revocations.revokedRecordIds.push("record-2");
      return artifacts.get(digest);
    };
    const result = loadBehaviorRegistry(input);
    expect(result.evaluatedAtMs).toBe(now); expect(result.entries[0]?.selectionEligible).toBe(true);
    const expired = fixture(); expired.replaceRecord(2, (record) => { record.payload.expires_at = "2026-10-26T12:00:00.000Z"; });
    expired.input.readArtifact = (digest) => { expired.input.nowMs = now - 1; return expired.artifacts.get(digest); };
    expect(eligible(expired.input)).toHaveLength(0);
  });
  it("bounds input and artifact reads without filesystem or home discovery", () => {
    const { input } = fixture(); input.registryBytes = Buffer.alloc(1024 * 1024 + 1);
    expect(loadBehaviorRegistry(input).rejection).toBe("registry_invalid");
    const other = fixture(); other.input.readArtifact = () => Buffer.alloc(8 * 1024 * 1024 + 1);
    expect(eligible(other.input)).toHaveLength(0);
  });
});

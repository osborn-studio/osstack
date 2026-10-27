import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BehaviorContractV1, BehaviorQualificationV1, BehaviorRegistryV1 } from "@osstack/protocol";
import { evaluateBehaviorRegistry, type BehaviorRegistryInput } from "./behavior-registry.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// Independent fixture writer: inputs contain only the closed protocol's strings, integers and objects.
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item));
const keys = ["ci_verifier", "host_qualifier", "journey_verifier"].map((role) => ({ role, ...generateKeyPairSync("ed25519") }));
const levels = ["contract_tested", "host_verified", "journey_verified"] as const;
const now = Date.parse("2026-10-26T12:00:00.000Z");

function fixture(dependencies: Array<{ capability_id: string; version: string }> = [], capabilityId = "FM-09",
  sourceBytes = Buffer.from("Pinned source text. Never execute this text.")) {
  const artifacts = new Map<string, Uint8Array>();
  const put = (bytes: Uint8Array) => { const digest = hash(bytes); artifacts.set(digest, bytes); return digest; };
  const target = "b".repeat(64);
  const sources = [{ repository: "https://github.com/kunchenguid/firstmate", commit: "a".repeat(40), path: "AGENTS.md",
    content_sha256: put(sourceBytes), license: "MIT" }];
  const sourceManifest = { schema_version: 1, kind: "behavior_source_manifest", sources };
  const contract: BehaviorContractV1 = {
    schema_version: 1, kind: "behavior_contract", capability_id: capabilityId, version: "1.0.0",
    owner_component: "engineering-controller", trigger: "decision_wait_observed", summary: { en: "Keep a wait.", zh: "保留等待。" },
    source_manifest_sha256: put(encode(sourceManifest)), sources,
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
  const ciProfile = { ...profile, os: "linux", architecture: "x64", filesystem: "ext4", host_identity_sha256: "e".repeat(64) };
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
      revocations: { epoch: 3, issuedAtMs: now - 1000, expiresAtMs: now + 3600000, revokedKeyIds: [], revokedQualificationSha256s: [] },
    },
    readArtifact: (digest) => artifacts.get(digest),
  };
  // Mutations of signed payloads re-sign only that record. Later hashes intentionally become stale.
  const replaceRecord = (index: number, mutate: (record: BehaviorQualificationV1) => void) => {
    mutate(records[index]!);
    records[index]!.signature.value_base64 = sign(null, encode(records[index]!.payload), keys[index]!.privateKey).toString("base64");
    input.qualificationBytes[index] = encode(records[index]);
  };
  const replaceManifest = (manifest: unknown) => {
    contract.source_manifest_sha256 = put(encode(manifest));
    registry.entries[0]!.contract_sha256 = hash(encode(contract));
    input.registryBytes = encode(registry); input.expectedRegistrySha256 = hash(input.registryBytes);
    for (const [index, record] of records.entries()) {
      record.payload.source_manifest_sha256 = contract.source_manifest_sha256;
      record.payload.behavior_contract_sha256 = registry.entries[0]!.contract_sha256;
      record.payload.registry_sha256 = input.expectedRegistrySha256;
      record.payload.prerequisite_record_sha256 = index === 0 ? [] : [hash(input.qualificationBytes[index - 1]!)];
      replaceRecord(index, () => {});
    }
  };
  return { input, contract, registry, records, artifacts, put, replaceRecord, replaceManifest, sourceManifest };
}
const eligible = (input: BehaviorRegistryInput) => evaluateBehaviorRegistry(input).entries.filter((entry) => entry.selectionEligible);

describe("behavior registry evaluation under caller-supplied trust", () => {
  it("loads a fully verified same-candidate chain while granting no execution authority", () => {
    const { input } = fixture(); const result = evaluateBehaviorRegistry(input);
    expect(result.status).toBe("evaluated");
    expect(result.authorization).toBe("none");
    expect(result.expectedRegistrySha256).toBe(input.expectedRegistrySha256);
    expect(result.observedRegistrySha256).toBe(input.expectedRegistrySha256);
    expect(result.context).toEqual({ candidateSha: input.target.candidateSha, targetCodeSha256: input.target.targetCodeSha256,
      policyProfileSha256: input.target.policyProfileSha256, ciProfileSha256: hash(encode(input.target.ciProfile)),
      hostProfileSha256: hash(encode(input.target.hostProfile)), revocationEpoch: input.trust.revocations.epoch,
      registryVersion: input.expectedRegistryVersion, revocationSnapshotSha256: hash(encode(input.trust.revocations)),
      trustSha256: hash(encode({ keys: input.trust.keys, minimumRevocationEpoch: input.trust.minimumRevocationEpoch,
        maxRevocationAgeMs: input.trust.maxRevocationAgeMs, maxQualificationLifetimeMs: input.trust.maxQualificationLifetimeMs })),
      minimumRevocationEpoch: input.trust.minimumRevocationEpoch, maxRevocationAgeMs: input.trust.maxRevocationAgeMs,
      maxQualificationLifetimeMs: input.trust.maxQualificationLifetimeMs });
    expect(result.entries[0]).toMatchObject({ capabilityId: "FM-09", selectionEligible: true, reasons: [],
      contractSha256: hash(encode(result.entries[0]!.contract)), qualificationSha256s: input.qualificationBytes.map(hash), validUntilMs: input.trust.revocations.expiresAtMs });
    expect(Object.isFrozen(result.entries[0])).toBe(true);
  });
  it("leaves a correctly shaped but unqualified declaration disabled", () => {
    const { input } = fixture(); input.qualificationBytes = [];
    expect(evaluateBehaviorRegistry(input).entries[0]).toMatchObject({ selectionEligible: false, reasons: ["qualification_missing_or_invalid"] });
  });
  it("rejects substituted registry bytes before consulting evidence", () => {
    const { input } = fixture(); input.registryBytes = Buffer.from("{}");
    input.readArtifact = () => { throw new Error("must not read"); };
    const result = evaluateBehaviorRegistry(input);
    expect(result.rejection).toBe("registry_digest_mismatch");
    expect(result.expectedRegistrySha256).toBe(input.expectedRegistrySha256);
    expect(result.observedRegistrySha256).toBe(hash(Buffer.from("{}")));
    expect(result.observedRegistrySha256).not.toBe(result.expectedRegistrySha256);
  });
  it("requires the expected registry version and current code identity", () => {
    for (const field of ["candidateSha", "targetCodeSha256"] as const) {
      const { input } = fixture(); input.target[field] = "0".repeat(field === "candidateSha" ? 40 : 64);
      expect(evaluateBehaviorRegistry(input).rejection).toBe("candidate_mismatch");
    }
    const { input } = fixture(); input.expectedRegistryVersion = "2.0.0";
    expect(evaluateBehaviorRegistry(input).rejection).toBe("registry_version_mismatch");
  });
  it("rejects duplicate JSON keys, unknown fields and noncanonical registry bytes", () => {
    for (const mutate of [(s: string) => s.replace('"schema_version":1', '"schema_version":1,"schema_version":1'),
      (s: string) => `${s}\n`, (s: string) => s.replace('"kind":"behavior_registry"', '"kind":"behavior_registry","command":"exec"')]) {
      const { input } = fixture(); input.registryBytes = Buffer.from(mutate(Buffer.from(input.registryBytes).toString()));
      input.expectedRegistrySha256 = hash(input.registryBytes);
      expect(evaluateBehaviorRegistry(input).rejection).toBe("registry_invalid");
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
    expect(evaluateBehaviorRegistry(other.input).rejection).toBe("registry_invalid");
  });
  it("checks the declared behavior digest independently of the registry digest", () => {
    const { input, registry } = fixture(); registry.entries[0]!.contract_sha256 = "0".repeat(64);
    input.registryBytes = encode(registry); input.expectedRegistrySha256 = hash(input.registryBytes);
    expect(evaluateBehaviorRegistry(input).entries[0]?.reasons).toContain("contract_digest_mismatch");
  });
  it("verifies signature bytes instead of trusting claimed issuer fields", () => {
    const { input, records } = fixture(); records[2]!.payload.limitations = ["Altered after signing."];
    input.qualificationBytes[2] = encode(records[2]);
    expect(eligible(input)).toHaveLength(0);
    expect(evaluateBehaviorRegistry(input).qualificationRejections.some((entry) => entry.reason === "signature_invalid")).toBe(true);
  });
  it("rejects a host claim signed by a CI-only key, even with a valid signature", () => {
    const { input, records } = fixture(); const record = records[1]!;
    record.payload.signer_key_id = "key-0";
    record.signature.value_base64 = sign(null, encode(record.payload), keys[0]!.privateKey).toString("base64");
    input.qualificationBytes[1] = encode(record);
    expect(eligible(input)).toHaveLength(0);
    expect(evaluateBehaviorRegistry(input).qualificationRejections.some((entry) => entry.reason === "issuer_scope_mismatch")).toBe(true);
  });
  it("enforces key capability and exact profile scope", () => {
    for (const field of ["capabilityIds", "profileSha256s"] as const) {
      const { input } = fixture(); input.trust.keys[2]![field] = [];
      expect(eligible(input)).toHaveLength(0);
    }
    const { input } = fixture(); input.target.hostProfile.host_identity_sha256 = "0".repeat(64);
    expect(eligible(input)).toHaveLength(0);
  });
  it("allows only the four explicit CI measurement-cell differences", () => {
    const relaxed = new Set(["os", "architecture", "filesystem", "host_identity_sha256"]);
    expect(eligible(fixture().input)).toHaveLength(1); // all four CI fields differ from the host
    for (const field of Object.keys(fixture().input.target.ciProfile)) {
      if (relaxed.has(field)) continue;
      const { input } = fixture(); const key = field as keyof typeof input.target.ciProfile;
      if (key === "recovery_mode") input.target.ciProfile[key] = "stop_and_reconcile";
      else input.target.ciProfile[key] = `${input.target.ciProfile[key]}-other`;
      expect(evaluateBehaviorRegistry(input).rejection, field).toBe("ci_profile_mismatch");
    }
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
      const { input } = fixture(); mutate(input); expect(evaluateBehaviorRegistry(input).rejection).toBe("revocation_unavailable");
    }
  });
  it("enforces the host's maximum qualification lifetime and revocation cache age", () => {
    const { input } = fixture(); input.trust.maxQualificationLifetimeMs = 3600000;
    expect(eligible(input)).toHaveLength(0);
    const other = fixture(); other.input.trust.maxRevocationAgeMs = 1000;
    expect(evaluateBehaviorRegistry(other.input).rejection).toBe("revocation_unavailable");
    for (const field of ["maxQualificationLifetimeMs", "maxRevocationAgeMs"] as const) {
      const f = fixture(); f.input.trust[field] = Number.MAX_SAFE_INTEGER;
      expect(evaluateBehaviorRegistry(f.input).rejection).toBe("invalid_context");
    }
  });
  it("re-evaluates revocations on each load, including predecessor revocation", () => {
    const { input } = fixture(); expect(eligible(input)).toHaveLength(1);
    input.trust.revocations.revokedQualificationSha256s.push(hash(input.qualificationBytes[0]!)); expect(eligible(input)).toHaveLength(0);
    input.trust.revocations.revokedQualificationSha256s = []; input.trust.revocations.revokedKeyIds.push("key-2");
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
    expect(evaluateBehaviorRegistry(input).rejection).toBe("policy_digest_mismatch");
  });
  it("requires the evidence bundle to contain the signed evidence and treats limitations conservatively", () => {
    const f = fixture(); f.replaceRecord(2, (record) => {
      record.payload.evidence_bundle_sha256 = f.put(encode({ schema_version: 1, candidate_sha: f.registry.candidate_sha, limitations: [],
        evidence: [{ ...record.payload.evidence_refs[0], checker_version: "2.0.0" }] }));
    });
    expect(evaluateBehaviorRegistry(f.input).qualificationRejections.some((entry) => entry.reason === "evidence_bundle_mismatch")).toBe(true);
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
  it("requires each full source tuple to belong to the pinned typed snapshot", () => {
    for (const field of ["repository", "commit", "path", "content_sha256", "license"] as const) {
      const f = fixture(); const source = { ...f.contract.sources[0]! };
      source[field] = field === "repository" ? "https://example.com/another-repo"
        : field === "commit" ? "0".repeat(40) : field === "content_sha256" ? "0".repeat(64) : "other";
      f.replaceManifest({ ...f.sourceManifest, sources: [source] });
      expect(evaluateBehaviorRegistry(f.input).entries[0]?.reasons, field).toContain("source_manifest_mismatch");
    }
    for (const manifest of [{ sources: ["AGENTS.md"] }, { schema_version: 2, kind: "behavior_source_manifest", sources: [] }]) {
      const f = fixture(); f.replaceManifest(manifest);
      expect(evaluateBehaviorRegistry(f.input).entries[0]?.reasons).toContain("source_manifest_invalid");
    }
  });
  it("allows a global snapshot superset without qualifying unreferenced source content", () => {
    const f = fixture(); f.replaceManifest({ ...f.sourceManifest, sources: [...f.contract.sources,
      { ...f.contract.sources[0], path: "unreferenced-source.md", content_sha256: "0".repeat(64) }] });
    expect(eligible(f.input)).toHaveLength(1);
    f.replaceManifest({ ...f.sourceManifest, sources: [...f.contract.sources, ...f.contract.sources] });
    expect(evaluateBehaviorRegistry(f.input).entries[0]?.reasons).toContain("source_manifest_invalid");
  });
  it("rejects missing, wrong-level or changed predecessor records", () => {
    const { input, replaceRecord } = fixture(); replaceRecord(2, (record) => { record.payload.prerequisite_record_sha256 = [hash(input.qualificationBytes[0]!)]; });
    expect(eligible(input)).toHaveLength(0);
    const other = fixture(); other.input.qualificationBytes.shift(); expect(eligible(other.input)).toHaveLength(0);
  });
  it("rejects conflicting documents with the same issuer and record ID, and invalid trust configuration", () => {
    const { input, records } = fixture(); const altered = structuredClone(records[2]!); altered.payload.limitations = ["Another receipt"];
    altered.signature.value_base64 = sign(null, encode(altered.payload), keys[2]!.privateKey).toString("base64");
    input.qualificationBytes.push(encode(altered)); expect(eligible(input)).toHaveLength(0);
    expect(evaluateBehaviorRegistry(input).qualificationRejections.some((record) => record.reason === "qualification_id_conflict")).toBe(true);
    const second = fixture(); second.input.trust.keys.push(second.input.trust.keys[0]!);
    expect(evaluateBehaviorRegistry(second.input).rejection).toBe("invalid_context");
  });
  it("does not let an unauthenticated same-ID record poison a legitimate qualification chain", () => {
    const { input, records } = fixture(); const forged = structuredClone(records[2]!);
    forged.payload.limitations = ["Forged conflicting contents"];
    forged.signature.value_base64 = `${"A".repeat(86)}==`;
    input.qualificationBytes.unshift(encode(forged));
    const result = evaluateBehaviorRegistry(input);
    expect(result.entries[0]?.selectionEligible).toBe(true);
    expect(result.qualificationRejections).toEqual([{ sha256: hash(encode(forged)), reason: "signature_invalid" }]);
  });
  it("does not let a CI issuer's same-ID record conflict with the journey issuer", () => {
    const { input, records } = fixture(); const lowerRole = structuredClone(records[0]!);
    lowerRole.payload.record_id = records[2]!.payload.record_id;
    lowerRole.payload.evidence_bundle_sha256 = "0".repeat(64);
    lowerRole.signature.value_base64 = sign(null, encode(lowerRole.payload), keys[0]!.privateKey).toString("base64");
    input.qualificationBytes.unshift(encode(lowerRole));
    const result = evaluateBehaviorRegistry(input);
    expect(result.entries[0]?.selectionEligible).toBe(true);
    expect(result.qualificationRejections).toEqual([{ sha256: hash(encode(lowerRole)), reason: "evidence_unavailable" }]);
  });
  it("revokes exact qualification documents without revoking another issuer's same-ID record", () => {
    const { input, records } = fixture(); const lowerRole = structuredClone(records[0]!);
    lowerRole.payload.record_id = records[2]!.payload.record_id;
    lowerRole.signature.value_base64 = sign(null, encode(lowerRole.payload), keys[0]!.privateKey).toString("base64");
    const extra = encode(lowerRole); input.qualificationBytes.push(extra);
    input.trust.revocations.revokedQualificationSha256s.push(hash(extra));
    const result = evaluateBehaviorRegistry(input);
    expect(result.entries[0]?.selectionEligible).toBe(true);
    expect(result.qualificationRejections).toEqual([{ sha256: hash(extra), reason: "qualification_revoked" }]);
    input.trust.revocations.revokedQualificationSha256s.push(hash(input.qualificationBytes[2]!));
    expect(evaluateBehaviorRegistry(input).entries[0]).toMatchObject({ selectionEligible: false, qualificationSha256s: [] });
    const legacy = fixture();
    legacy.input.trust.revocations = { epoch: 3, issuedAtMs: now - 1000, expiresAtMs: now + 1000,
      revokedKeyIds: [], revokedRecordIds: ["record-0"] } as unknown as BehaviorRegistryInput["trust"]["revocations"];
    expect(evaluateBehaviorRegistry(legacy.input).rejection).toBe("revocation_unavailable");
    legacy.input.trust.revocations.revokedQualificationSha256s = [];
    expect(evaluateBehaviorRegistry(legacy.input).rejection).toBe("revocation_unavailable");
  });
  it("binds same-epoch revocation changes and evaluation limits to separate context digests", () => {
    const { input } = fixture(); const original = evaluateBehaviorRegistry(input).context!;
    input.trust.revocations.revokedQualificationSha256s.push("0".repeat(64));
    const revoked = evaluateBehaviorRegistry(input).context!;
    expect(revoked.revocationEpoch).toBe(original.revocationEpoch);
    expect(revoked.revocationSnapshotSha256).not.toBe(original.revocationSnapshotSha256);
    expect(revoked.trustSha256).toBe(original.trustSha256);
    input.trust.minimumRevocationEpoch = 2; input.trust.maxRevocationAgeMs -= 1;
    input.trust.maxQualificationLifetimeMs -= 1;
    const changed = evaluateBehaviorRegistry(input).context!;
    expect(changed.trustSha256).not.toBe(revoked.trustSha256);
    expect(changed.revocationSnapshotSha256).toBe(revoked.revocationSnapshotSha256);
    expect(changed).toMatchObject({ minimumRevocationEpoch: 2, maxRevocationAgeMs: input.trust.maxRevocationAgeMs,
      maxQualificationLifetimeMs: input.trust.maxQualificationLifetimeMs });
  });
  it("rejects all seven libsodium 1.0.18 small-order encodings and both sign-bit variants", () => {
    // Fixed upstream ge25519_has_small_order vectors; production does not supply the test list.
    const vectors = ["00".repeat(32), `01${"00".repeat(31)}`,
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
      `ec${"ff".repeat(30)}7f`, `ed${"ff".repeat(30)}7f`, `ee${"ff".repeat(30)}7f`];
    for (const vector of vectors) for (const signBit of [0, 128]) {
      const bytes = Buffer.from(vector, "hex"); bytes[31] = bytes[31]! | signBit;
      const key = createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: bytes.toString("base64url") } });
      const { input } = fixture(); input.trust.keys[0]!.publicKeyPem = key.export({ format: "pem", type: "spki" }).toString();
      expect(evaluateBehaviorRegistry(input).rejection, `${vector}/${signBit}`).toBe("invalid_context");
    }
    expect(eligible(fixture().input)).toHaveLength(1);
  });
  it("rejects the identity key before verifying its trivial R=identity and S=0 signature", () => {
    const { input, records, replaceRecord } = fixture(); const identity = Buffer.alloc(32); identity[0] = 1;
    const key = createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: identity.toString("base64url") } });
    input.trust.keys[0]!.publicKeyPem = key.export({ format: "pem", type: "spki" }).toString();
    records[0]!.signature.value_base64 = Buffer.concat([identity, Buffer.alloc(32)]).toString("base64");
    input.qualificationBytes[0] = encode(records[0]);
    for (const index of [1, 2]) replaceRecord(index, (record) => {
      record.payload.prerequisite_record_sha256 = [hash(input.qualificationBytes[index - 1]!)];
    });
    expect(evaluateBehaviorRegistry(input)).toMatchObject({ status: "rejected", rejection: "invalid_context", entries: [] });
  });
  it("selects the longest effective chain with a digest tie-break regardless of input order", () => {
    for (const tied of [false, true]) {
      const { input, records } = fixture(); const alternate = structuredClone(records[2]!);
      alternate.payload.record_id = "alternate-journey";
      if (!tied) alternate.payload.expires_at = new Date(now + 10000).toISOString();
      alternate.signature.value_base64 = sign(null, encode(alternate.payload), keys[2]!.privateKey).toString("base64");
      const original = input.qualificationBytes[2]!; const extra = encode(alternate);
      const expected = tied ? [hash(original), hash(extra)].sort()[0]! : hash(original);
      input.qualificationBytes.unshift(extra);
      const first = evaluateBehaviorRegistry(input);
      input.qualificationBytes.reverse();
      expect(evaluateBehaviorRegistry(input)).toEqual(first);
      expect(first.entries[0]?.qualificationSha256s[2]).toBe(expected);
      expect(first.entries[0]?.validUntilMs).toBe(input.trust.revocations.expiresAtMs);
    }
  });
  it("does not expose qualification chains for entries with failed source checks", () => {
    const { input, artifacts, contract } = fixture(); artifacts.delete(contract.source_manifest_sha256);
    expect(evaluateBehaviorRegistry(input).entries[0]).toMatchObject({ selectionEligible: false,
      validUntilMs: null, qualificationSha256s: [] });
  });
  it("bounds trust arrays and PEM before parsing keys and rejects missing revocation snapshots", () => {
    const mutations: Array<(input: BehaviorRegistryInput) => void> = [
      (input) => { input.trust.keys[0]!.publicKeyPem = "x".repeat(1025); },
      (input) => { input.trust.keys[0]!.publicKeyPem = keys[0]!.privateKey.export({ type: "pkcs8", format: "pem" }).toString(); },
      (input) => { input.trust.keys[0]!.publicKeyPem = input.trust.keys[0]!.publicKeyPem.replaceAll("PUBLIC KEY", "CERTIFICATE"); },
      (input) => { input.trust.keys[0]!.capabilityIds = Array.from({ length: 25 }, () => "FM-09"); },
      (input) => { input.trust.keys[0]!.profileSha256s = Array.from({ length: 129 }, () => "0".repeat(64)); },
    ];
    for (const mutate of mutations) { const { input } = fixture(); mutate(input); expect(evaluateBehaviorRegistry(input).rejection).toBe("invalid_context"); }
    for (const mutate of [
      (input: BehaviorRegistryInput) => { input.trust.revocations = null as unknown as BehaviorRegistryInput["trust"]["revocations"]; },
      (input: BehaviorRegistryInput) => { input.trust.revocations.revokedKeyIds = Array.from({ length: 4097 }, () => "key"); },
      (input: BehaviorRegistryInput) => { input.trust.revocations.revokedQualificationSha256s = Array.from({ length: 16385 }, () => "record"); },
    ]) {
      const { input } = fixture(); mutate(input);
      expect(evaluateBehaviorRegistry(input)).toMatchObject({ status: "rejected", rejection: "revocation_unavailable", context: null, observedRegistrySha256: null });
    }
  });
  it("keeps unresolved and version-mismatched dependencies disabled", () => {
    const missing = fixture([{ capability_id: "FM-02", version: "1.0.0" }]);
    expect(evaluateBehaviorRegistry(missing.input).entries[0]?.reasons).toContain("dependency_missing");
    const f = fixture([{ capability_id: "FM-02", version: "2.0.0" }]);
    f.registry.entries.push({ contract: { ...f.contract, capability_id: "FM-02", depends_on: [] }, contract_sha256: "0".repeat(64) });
    f.input.registryBytes = encode(f.registry); f.input.expectedRegistrySha256 = hash(f.input.registryBytes);
    expect(evaluateBehaviorRegistry(f.input).entries[0]?.reasons).toContain("dependency_version_mismatch");
  });
  it("detects cycles and does not let an unqualified dependency become a route", () => {
    const f = fixture([{ capability_id: "FM-02", version: "1.0.0" }]);
    const dependency = { ...f.contract, capability_id: "FM-02", depends_on: [{ capability_id: "FM-09", version: "1.0.0" }] };
    f.registry.entries.push({ contract: dependency, contract_sha256: hash(encode(dependency)) });
    f.input.registryBytes = encode(f.registry); f.input.expectedRegistrySha256 = hash(f.input.registryBytes);
    expect(evaluateBehaviorRegistry(f.input).entries.every((entry) => entry.reasons.includes("dependency_cycle"))).toBe(true);
    dependency.depends_on = []; f.registry.entries[1]!.contract_sha256 = hash(encode(dependency));
    f.input.registryBytes = encode(f.registry); f.input.expectedRegistrySha256 = hash(f.input.registryBytes);
    expect(evaluateBehaviorRegistry(f.input).entries[0]?.reasons).toContain("dependency_unqualified");
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
    const result = evaluateBehaviorRegistry(parent.input);
    expect(result.entries.every((entry) => entry.selectionEligible)).toBe(true);
    expect(result.entries.map((entry) => entry.validUntilMs)).toEqual([now + 60000, now + 60000]);
    parent.input.trust.revocations.revokedQualificationSha256s.push(hash(parent.input.qualificationBytes[5]!));
    expect(evaluateBehaviorRegistry(parent.input).entries[0]).toMatchObject({ selectionEligible: false,
      validUntilMs: null, reasons: ["dependency_unqualified"] });
  });
  it("labels every member of a cycle that includes a diamond join", () => {
    const f = fixture([{ capability_id: "FM-02", version: "1.0.0" }, { capability_id: "FM-03", version: "1.0.0" }]);
    for (const [id, target] of [["FM-02", "FM-04"], ["FM-03", "FM-04"], ["FM-04", "FM-09"]] as const) {
      const contract = { ...f.contract, capability_id: id, depends_on: [{ capability_id: target, version: "1.0.0" }] };
      f.registry.entries.push({ contract, contract_sha256: hash(encode(contract)) });
    }
    f.input.registryBytes = encode(f.registry); f.input.expectedRegistrySha256 = hash(f.input.registryBytes);
    expect(evaluateBehaviorRegistry(f.input).entries.map((entry) => entry.reasons.includes("dependency_cycle"))).toEqual([true, true, true, true]);
  });
  it("keeps the evaluated snapshot stable when a later artifact callback mutates caller inputs", () => {
    // Authentication finishes before artifact callbacks. This tests later snapshot stability, not a clock race inside authentication.
    const { input, artifacts } = fixture(); let readCalls = 0;
    input.readArtifact = (digest) => {
      readCalls++;
      input.nowMs += 2 * 86400000; input.expectedRegistrySha256 = "0".repeat(64);
      input.qualificationBytes = []; input.target.candidateSha = "0".repeat(40);
      input.trust.revocations.revokedKeyIds.push("key-2");
      return artifacts.get(digest);
    };
    const result = evaluateBehaviorRegistry(input);
    expect(readCalls).toBeGreaterThan(0);
    expect(result.evaluatedAtMs).toBe(now); expect(result.entries[0]?.selectionEligible).toBe(true);
    const expired = fixture(); expired.replaceRecord(2, (record) => { record.payload.expires_at = "2026-10-26T12:00:00.000Z"; });
    let expiredReadCalls = 0;
    expired.input.readArtifact = (digest) => { expiredReadCalls++; expired.input.nowMs = now - 1; return expired.artifacts.get(digest); };
    expect(eligible(expired.input)).toHaveLength(0);
    expect(expiredReadCalls).toBeGreaterThan(0);
    expect(expired.input.nowMs).toBe(now - 1);
  });
  it("bounds input and artifact reads without filesystem or home discovery", () => {
    const { input } = fixture(); input.registryBytes = Buffer.alloc(1024 * 1024 + 1);
    expect(evaluateBehaviorRegistry(input).rejection).toBe("registry_invalid");
    const other = fixture(); other.input.readArtifact = () => Buffer.alloc(8 * 1024 * 1024 + 1);
    expect(eligible(other.input)).toHaveLength(0);
  });
  it("does not spend the evidence budget parsing unauthenticated qualification documents", () => {
    const { input } = fixture([], "FM-09", Buffer.alloc(6 * 1024 * 1024, 65));
    const invalid = Buffer.alloc(1024 * 1024, 97);
    input.qualificationBytes.unshift(...Array.from({ length: 60 }, () => invalid));
    const result = evaluateBehaviorRegistry(input);
    expect(result.entries[0]?.selectionEligible).toBe(true);
    expect(result.qualificationRejections).toHaveLength(60);
  });
  it("rejects an excessive raw batch before artifact reads regardless of padding position", () => {
    for (const byCount of [true, false]) for (const prepend of [true, false]) {
      const { input } = fixture(); let reads = 0;
      const junk = Buffer.alloc(byCount ? 1 : 1024 * 1024, 97);
      const padding = Array.from({ length: byCount ? 257 : 64 }, () => junk);
      input.qualificationBytes = prepend ? [...padding, ...input.qualificationBytes] : [...input.qualificationBytes, ...padding];
      input.readArtifact = () => { reads++; throw new Error("oversized batch must not read"); };
      expect(evaluateBehaviorRegistry(input)).toMatchObject({ status: "rejected", entries: [],
        rejection: byCount ? "invalid_context" : "qualification_batch_oversized" });
      expect(reads).toBe(0);
    }
  });
});

it.each(["target", "trust", "key", "revocations"] as const)("rejects unknown %s context fields", field => {
  const f = fixture();
  const value = field === "target" ? f.input.target : field === "trust" ? f.input.trust
    : field === "key" ? f.input.trust.keys[0]! : f.input.trust.revocations;
  Object.assign(value, { futureRevocations: ["key-0"] });
  expect(evaluateBehaviorRegistry(f.input)).toMatchObject({ status: "rejected",
    rejection: field === "revocations" ? "revocation_unavailable" : "invalid_context" });
});

it.each(["missing", "corrupt", "throw"] as const)("reads a %s artifact only once per evaluation", failure => {
  const f = fixture();
  // All three signed records refer to this same missing or corrupt evidence object.
  const digest = f.records[0]!.payload.evidence_refs[0]!.artifact_sha256;
  for (let index = 1; index < f.records.length; index++) {
    f.replaceRecord(index, record => { record.payload.evidence_refs[0]!.artifact_sha256 = digest; });
  }
  let reads = 0;
  f.input.readArtifact = key => {
    if (key !== digest) return f.artifacts.get(key);
    reads++;
    if (failure === "throw") throw new Error("missing object");
    return failure === "corrupt" ? Buffer.from("substituted bytes") : undefined;
  };
  const result = evaluateBehaviorRegistry(f.input);
  expect(result.entries[0]!.selectionEligible).toBe(false);
  expect(result.qualificationRejections.filter(item => item.reason === "evidence_unavailable")).toHaveLength(3);
  expect(reads).toBe(1);
});

it("accepts older issuance epochs only against a complete fresh revocation snapshot", () => {
  const f = fixture();
  f.input.trust.minimumRevocationEpoch = 4;
  f.input.trust.revocations.epoch = 4;
  expect(eligible(f.input)).toHaveLength(1);
  f.input.trust.revocations.revokedQualificationSha256s.push(hash(f.input.qualificationBytes[0]!));
  expect(eligible(f.input)).toHaveLength(0);
  expect(evaluateBehaviorRegistry(f.input).qualificationRejections).toContainEqual({
    sha256: hash(f.input.qualificationBytes[0]!), reason: "qualification_revoked",
  });
});

import { describe, expect, it } from "vitest";
import {
  BehaviorCapabilityIdV1, BehaviorContractV1, BehaviorRegistryV1,
  BehaviorQualificationV1, BehaviorEvidenceBundleV1, BehaviorDeliveryRecordV1,
} from "./behavior-capability.js";

const digest = "a".repeat(64);
const commit = "b".repeat(40);
const contract = {
  schema_version: 1, kind: "behavior_contract", capability_id: "FM-09", version: "1.0.0",
  owner_component: "engineering-controller", trigger: "decision_wait_observed",
  summary: { en: "Keep responsibility for a pending decision.", zh: "保留未决问题的责任。" },
  source_manifest_sha256: digest,
  sources: [{ repository: "https://github.com/kunchenguid/firstmate", commit,
    path: "AGENTS.md", content_sha256: digest, license: "MIT" }],
  depends_on: [{ capability_id: "FM-02", version: "1.0.0" }],
  required_scenarios: [{ id: "AC-FM-09", level: "contract_tested" }],
  invariants: ["Do not infer an answer from silence."], semantic_differences: [],
};
const profile = {
  os: "darwin", architecture: "arm64", filesystem: "apfs", isolation_profile: "trusted-local",
  daemon_version: "0.22.1", adapter_id: "codex", adapter_version: "1.0.0", provider: "openai",
  model: "test-model", executor_id: "session", executor_version: "1.0.0",
  template_id: "adopt_session", template_version: "1.0.0", recovery_mode: "query_and_deduplicate",
  host_identity_sha256: digest,
};
const evidence = { scenario_id: "AC-FM-09", checker_id: "fixture-verifier", checker_version: "1.0.0",
  result: "passed", artifact_sha256: digest, subject_sha256: digest };
const qualification = {
  schema_version: 1, canonicalization: "RFC8785",
  payload: {
    record_id: "qualification-1", capability_id: "FM-09", profile, candidate_sha: commit,
    target_code_sha256: digest, behavior_contract_sha256: digest, source_manifest_sha256: digest,
    policy_profile_sha256: digest, registry_sha256: digest, level: "contract_tested",
    evidence_bundle_sha256: digest, evidence_refs: [evidence], limitations: [], issuer_role: "ci_verifier",
    issued_at: "2026-10-26T00:00:00.000Z", expires_at: "2026-10-27T00:00:00.000Z",
    revocation_epoch: 0, signer_key_id: "ci-key", required_scenario_set_sha256: digest,
    prerequisite_record_sha256: [],
  },
  signature: { algorithm: "Ed25519", value_base64: `${"A".repeat(86)}==` },
};

describe("behavior contracts v1", () => {
  it("preserves all 24 stable capability identities", () => {
    for (let i = 1; i <= 24; i++) expect(BehaviorCapabilityIdV1.parse(`FM-${String(i).padStart(2, "0")}`)).toBeTruthy();
    for (const id of ["FM-00", "FM-25", "FM-1", "FM-09;exec", "fm-09"])
      expect(BehaviorCapabilityIdV1.safeParse(id).success).toBe(false);
  });
  it("keeps protocol, registry and behavior versions separate", () => {
    expect(BehaviorContractV1.parse(contract)).toEqual(contract);
    const registry = { schema_version: 1, kind: "behavior_registry", registry_version: "2.3.0",
      candidate_sha: commit, target_code_sha256: digest, entries: [{ contract, contract_sha256: digest }] };
    expect(BehaviorRegistryV1.parse(registry)).toEqual(registry);
    expect(BehaviorContractV1.safeParse({ ...contract, version: "2.0.0" }).success).toBe(true);
    expect(BehaviorContractV1.safeParse({ ...contract, schema_version: 2 }).success).toBe(false);
    expect(BehaviorRegistryV1.safeParse({ ...registry, schema_version: 2 }).success).toBe(false);
    for (const version of ["latest", "^1.0.0", "01.0.0", "1", "1.0.0;sh", "1000000000.0.0"])
      expect(BehaviorContractV1.safeParse({ ...contract, version }).success).toBe(false);
  });
  it("rejects commands, authority, activation and progress in a behavior declaration", () => {
    for (const field of ["command", "argv", "env", "permissions", "runtime_enabled", "status", "qualification"])
      expect(BehaviorContractV1.safeParse({ ...contract, [field]: true }).success).toBe(false);
    expect(BehaviorContractV1.safeParse({ ...contract, summary: { ...contract.summary, command: "run" } }).success).toBe(false);
    expect(BehaviorContractV1.safeParse({ ...contract, depends_on: [{ ...contract.depends_on[0], authority: "grant" }] }).success).toBe(false);
  });
  it("requires fixed source objects and safe relative source paths", () => {
    const source = contract.sources[0];
    for (const path of ["/etc/passwd", "../secret", "a/../secret", "./a", "a//b", "a\\b", "C:/secret", "bad\0path"])
      expect(BehaviorContractV1.safeParse({ ...contract, sources: [{ ...source, path }] }).success).toBe(false);
    expect(BehaviorContractV1.safeParse({ ...contract, sources: [{ ...source, commit: "main" }] }).success).toBe(false);
    expect(BehaviorContractV1.safeParse({ ...contract, sources: [] }).success).toBe(false);
    expect(BehaviorContractV1.safeParse({ ...contract, source_manifest_sha256: "wrong" }).success).toBe(false);
    for (const repository of ["file:///tmp/source", "https://secret@example.com/repo", "https://example.com/repo?token=x", "git@github.com:org/repo"])
      expect(BehaviorContractV1.safeParse({ ...contract, sources: [{ ...source, repository }] }).success).toBe(false);
  });
  it("rejects duplicate dependencies, sources and scenario IDs", () => {
    expect(BehaviorContractV1.safeParse({ ...contract, depends_on: [...contract.depends_on, ...contract.depends_on] }).success).toBe(false);
    expect(BehaviorContractV1.safeParse({ ...contract, depends_on: [{ capability_id: "FM-09", version: "1.0.0" }] }).success).toBe(false);
    expect(BehaviorContractV1.safeParse({ ...contract, sources: [...contract.sources, ...contract.sources] }).success).toBe(false);
    expect(BehaviorContractV1.safeParse({ ...contract, required_scenarios: [...contract.required_scenarios, ...contract.required_scenarios] }).success).toBe(false);
    const entry = { contract, contract_sha256: digest };
    expect(BehaviorRegistryV1.safeParse({ schema_version: 1, kind: "behavior_registry", registry_version: "1.0.0",
      candidate_sha: commit, target_code_sha256: digest, entries: [entry, entry] }).success).toBe(false);
  });
  it("rejects malformed Unicode, blank strings and unbounded declarations", () => {
    for (const trigger of ["", " ", "a\0b", "a\ud800b", "x".repeat(513), "id\n", "\u001bid", "id\u202e", "id\u200b", " id", "id ", "e\u0301"])
      expect(BehaviorContractV1.safeParse({ ...contract, trigger }).success).toBe(false);
    for (const en of ["a\u001bb", "a\u202eb", "a\u200bb", "e\u0301"])
      expect(BehaviorContractV1.safeParse({ ...contract, summary: { ...contract.summary, en } }).success).toBe(false);
  });
});

describe("qualification and delivery are separate records", () => {
  it("retains the qualification draft v1 wire fields without granting authority", () => {
    expect(BehaviorQualificationV1.parse(qualification)).toEqual(qualification);
    expect(BehaviorQualificationV1.safeParse(contract).success).toBe(false);
    expect(BehaviorContractV1.safeParse(qualification).success).toBe(false);
    expect(BehaviorQualificationV1.safeParse({ ...qualification, runtime_enabled: true }).success).toBe(false);
    expect(BehaviorQualificationV1.safeParse({ ...qualification, payload: { ...qualification.payload, command: "run" } }).success).toBe(false);
  });
  it("rejects unsupported signature format, invalid epochs and reversed validity", () => {
    expect(BehaviorQualificationV1.safeParse({ ...qualification, signature: { algorithm: "none", value_base64: "none" } }).success).toBe(false);
    for (const revocation_epoch of [-1, -0, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(BehaviorQualificationV1.safeParse({ ...qualification, payload: { ...qualification.payload, revocation_epoch } }).success).toBe(false);
    expect(BehaviorQualificationV1.safeParse({ ...qualification, payload: { ...qualification.payload,
      expires_at: qualification.payload.issued_at } }).success).toBe(false);
  });
  it("requires the correct issuer role and predecessor for each qualification level", () => {
    expect(BehaviorQualificationV1.safeParse({ ...qualification, payload: { ...qualification.payload, level: "host_verified" } }).success).toBe(false);
    const host = { ...qualification, payload: { ...qualification.payload, level: "host_verified", issuer_role: "host_qualifier",
      prerequisite_record_sha256: [digest] } };
    expect(BehaviorQualificationV1.safeParse(host).success).toBe(true);
    expect(BehaviorQualificationV1.safeParse({ ...host, payload: { ...host.payload, prerequisite_record_sha256: [] } }).success).toBe(false);
    expect(BehaviorQualificationV1.safeParse({ ...qualification, payload: { ...qualification.payload, prerequisite_record_sha256: [digest] } }).success).toBe(false);
  });
  it("keeps failed evidence representable while preventing ambiguous duplicate scenarios", () => {
    const bundle = { schema_version: 1, candidate_sha: commit, limitations: [], evidence: [evidence] };
    expect(BehaviorEvidenceBundleV1.parse(bundle)).toEqual(bundle);
    expect(BehaviorEvidenceBundleV1.safeParse({ ...bundle, evidence: [{ ...evidence, result: "unknown" }] }).success).toBe(true);
    expect(BehaviorEvidenceBundleV1.safeParse({ ...bundle, evidence: [evidence, evidence] }).success).toBe(false);
    expect(BehaviorEvidenceBundleV1.safeParse({ ...bundle, candidate_sha: undefined }).success).toBe(false);
    expect(BehaviorEvidenceBundleV1.safeParse({ ...bundle, limitations: undefined }).success).toBe(false);
  });
  it("records delivery progress without acting as a host qualification", () => {
    const delivery = { schema_version: 1, kind: "behavior_delivery", capability_id: "FM-09", contract_version: "1.0.0",
      behavior_contract_sha256: digest, registry_sha256: digest, candidate_sha: commit, target_code_sha256: digest,
      state: "local_verified", scope: "adopt_session", evidence_sha256: [digest], limitations: ["No provider qualification."],
      recorded_at: "2026-10-26T00:00:00.000Z" };
    expect(BehaviorDeliveryRecordV1.parse(delivery)).toEqual(delivery);
    expect(BehaviorQualificationV1.safeParse(delivery).success).toBe(false);
    expect(BehaviorDeliveryRecordV1.safeParse({ ...delivery, state: "enabled" }).success).toBe(false);
    expect(BehaviorDeliveryRecordV1.safeParse({ ...delivery, runtime_enabled: true }).success).toBe(false);
    expect(BehaviorDeliveryRecordV1.safeParse({ ...delivery, evidence_sha256: [] }).success).toBe(false);
  });
});

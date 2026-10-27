import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import {
  BEHAVIOR_DOCUMENT_MAX_BYTES, BehaviorCapabilityIdV1, BehaviorEvidenceBundleV1, BehaviorQualificationProfileV1,
  BehaviorQualificationV1, BehaviorRegistryV1,
  type BehaviorContractV1, type BehaviorQualificationLevelV1,
} from "@osstack/protocol";

type Level = BehaviorQualificationLevelV1;
type Role = BehaviorQualificationV1["payload"]["issuer_role"];
export interface BehaviorRegistryPolicy {
  capabilityId: string;
  contractVersion: string;
  requiredScenarios: Record<Level, Array<{ id: string; checkerId: string; checkerVersion: string }>>;
}
export interface BehaviorRegistryTrust {
  keys: Array<{ keyId: string; publicKeyPem: string; issuerRole: Role; capabilityIds: string[]; profileSha256s: string[] }>;
  /** Persisted high-water mark from the host's independent trust service, never from a registry. */
  minimumRevocationEpoch: number;
  maxRevocationAgeMs: number;
  maxQualificationLifetimeMs: number;
  /** The host verifies the operations-root signature and persists the epoch before calling this loader. */
  revocations: { epoch: number; issuedAtMs: number; expiresAtMs: number; revokedKeyIds: string[]; revokedRecordIds: string[] };
}
export interface BehaviorRegistryInput {
  registryBytes: Uint8Array;
  expectedRegistrySha256: string;
  expectedRegistryVersion: string;
  nowMs: number;
  qualificationBytes: Uint8Array[];
  target: {
    candidateSha: string; targetCodeSha256: string;
    /** SHA256 of canonical {schema_version:1,kind:"behavior_verifier_policy",capabilities:policy}. */
    policyProfileSha256: string;
    hostProfile: BehaviorQualificationProfileV1; ciProfile: BehaviorQualificationProfileV1;
  };
  policy: BehaviorRegistryPolicy[];
  trust: BehaviorRegistryTrust;
  /** Host-owned content-addressed store. No paths, home discovery, network or script execution. */
  readArtifact: (sha256: string) => Uint8Array | undefined;
}
export interface BehaviorRegistryEntry {
  capabilityId: string;
  contract: BehaviorContractV1;
  selectionEligible: boolean;
  reasons: string[];
  qualificationSha256s: string[];
  validUntilMs: number | null;
}
export interface BehaviorRegistrySnapshot {
  status: "loaded" | "rejected";
  authorization: "none";
  rejection: string | null;
  registrySha256: string;
  evaluatedAtMs: number;
  entries: BehaviorRegistryEntry[];
  qualificationRejections: Array<{ sha256: string; reason: string }>;
}

const levels: Level[] = ["contract_tested", "host_verified", "journey_verified"];
const roles: Role[] = ["ci_verifier", "host_qualifier", "journey_verifier"];
const digestPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const MAX_REGISTRY_BYTES = BEHAVIOR_DOCUMENT_MAX_BYTES;
const MAX_QUALIFICATION_BYTES = BEHAVIOR_DOCUMENT_MAX_BYTES;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

// RFC8785 serialization for values already parsed by these closed schemas: only strings,
// safe integers and fixed-key objects/arrays. Not an inbound JSON parser or a public codec.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("invalid value");
  return encoded;
}
function parseArtifact<T>(bytes: Uint8Array, parser: { parse: (value: unknown) => T }, maximum: number): T {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximum) throw new Error("oversized artifact");
  const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const value = parser.parse(JSON.parse(raw));
  // Requiring canonical bytes rejects duplicate keys, alternate numeric spellings and unknown data
  // without duplicating the independent joint-json raw parser under development in J01.
  if (canonical(value) !== raw) throw new Error("noncanonical artifact");
  return value;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const safeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const nonblank = (value: string) => typeof value === "string" && value.length <= 512 && value.trim().length > 0;

/**
 * Evaluate one immutable build against a current host-owned trust snapshot. This is a library
 * boundary, not an RPC or authority issuer. Callers must re-evaluate after time/trust changes and
 * perform normal host authorization before every effect. R05/V06 own policy issuance, operations
 * signature verification, persistent epoch protection and trust-root custody; this loader cannot
 * authenticate a caller that supplies its own trust context. No daemon path calls this yet.
 */
export function loadBehaviorRegistry(input: BehaviorRegistryInput): BehaviorRegistrySnapshot {
  const nowMs = input.nowMs;
  const expectedRegistrySha256 = input.expectedRegistrySha256;
  const expectedRegistryVersion = input.expectedRegistryVersion;
  const readArtifact = input.readArtifact;
  const snapshot: BehaviorRegistrySnapshot = { status: "rejected", authorization: "none", rejection: null,
    registrySha256: expectedRegistrySha256, evaluatedAtMs: nowMs, entries: [], qualificationRejections: [] };
  const reject = (reason: string) => freeze({ ...snapshot, rejection: reason });
  let target: BehaviorRegistryInput["target"];
  let trust: BehaviorRegistryTrust;
  let policies: Map<string, BehaviorRegistryPolicy>;
  const publicKeys = new Map<string, KeyObject>();
  try {
    target = structuredClone(input.target); trust = structuredClone(input.trust);
    target.hostProfile = BehaviorQualificationProfileV1.parse(target.hostProfile);
    target.ciProfile = BehaviorQualificationProfileV1.parse(target.ciProfile);
    if (!safeInteger(nowMs) || !commitPattern.test(target.candidateSha)
      || ![target.targetCodeSha256, target.policyProfileSha256, expectedRegistrySha256].every((value) => digestPattern.test(value))
      || !versionPattern.test(expectedRegistryVersion)
      || !safeInteger(trust.minimumRevocationEpoch) || trust.keys.length > 100 || input.qualificationBytes.length > 256
      || !safeInteger(trust.maxRevocationAgeMs) || !trust.maxRevocationAgeMs
      || !safeInteger(trust.maxQualificationLifetimeMs) || !trust.maxQualificationLifetimeMs
      || input.policy.length > 24) return reject("invalid_context");
    const keyFingerprints = new Set<string>();
    for (const key of trust.keys) {
      const publicKey = createPublicKey(key.publicKeyPem);
      const fingerprint = hash(publicKey.export({ type: "spki", format: "der" }));
      if (!nonblank(key.keyId) || publicKeys.has(key.keyId) || keyFingerprints.has(fingerprint)
        || publicKey.asymmetricKeyType !== "ed25519" || !roles.includes(key.issuerRole)
        || !key.capabilityIds.every((id) => BehaviorCapabilityIdV1.safeParse(id).success)
        || !key.profileSha256s.every((value) => digestPattern.test(value))) return reject("invalid_context");
      publicKeys.set(key.keyId, publicKey); keyFingerprints.add(fingerprint);
    }
    policies = new Map();
    for (const policy of structuredClone(input.policy)) {
      if (policies.has(policy.capabilityId) || !BehaviorCapabilityIdV1.safeParse(policy.capabilityId).success
        || !versionPattern.test(policy.contractVersion)) return reject("invalid_context");
      for (const level of levels) {
        const scenarios = policy.requiredScenarios[level];
        if (!scenarios.length || scenarios.length > 1000 || new Set(scenarios.map((scenario) => scenario.id)).size !== scenarios.length
          || !scenarios.every((scenario) => [scenario.id, scenario.checkerId, scenario.checkerVersion].every(nonblank))) return reject("invalid_context");
      }
      policies.set(policy.capabilityId, policy);
    }
    if (hash(canonical({ schema_version: 1, kind: "behavior_verifier_policy", capabilities: [...policies.values()] }))
      !== target.policyProfileSha256) return reject("policy_digest_mismatch");
  } catch { return reject("invalid_context"); }
  const revocations = trust.revocations;
  if (!revocations || ![revocations.epoch, revocations.issuedAtMs, revocations.expiresAtMs].every(safeInteger)
    || revocations.epoch < trust.minimumRevocationEpoch || revocations.issuedAtMs > nowMs
    || revocations.expiresAtMs <= nowMs || nowMs - revocations.issuedAtMs >= trust.maxRevocationAgeMs
    || !Array.isArray(revocations.revokedKeyIds)
    || !Array.isArray(revocations.revokedRecordIds) || !revocations.revokedKeyIds.every(nonblank)
    || !revocations.revokedRecordIds.every(nonblank)) return reject("revocation_unavailable");
  let registry: BehaviorRegistryV1;
  try {
    if (!(input.registryBytes instanceof Uint8Array) || input.registryBytes.byteLength > MAX_REGISTRY_BYTES) return reject("registry_invalid");
    const bytes = Buffer.from(input.registryBytes);
    if (hash(bytes) !== expectedRegistrySha256) return reject("registry_digest_mismatch");
    registry = parseArtifact(bytes, BehaviorRegistryV1, MAX_REGISTRY_BYTES);
  } catch { return reject("registry_invalid"); }
  if (registry.registry_version !== expectedRegistryVersion) return reject("registry_version_mismatch");
  if (registry.candidate_sha !== target.candidateSha || registry.target_code_sha256 !== target.targetCodeSha256) return reject("candidate_mismatch");
  let remainingBytes = MAX_TOTAL_BYTES - input.registryBytes.byteLength;
  const artifacts = new Map<string, Buffer>();
  const read = (digest: string): Buffer | undefined => {
    if (artifacts.has(digest)) return artifacts.get(digest);
    try {
      const original = readArtifact(digest);
      if (!(original instanceof Uint8Array) || original.byteLength > MAX_ARTIFACT_BYTES || original.byteLength > remainingBytes) return undefined;
      remainingBytes -= original.byteLength;
      const bytes = Buffer.from(original);
      if (hash(bytes) !== digest) return undefined;
      artifacts.set(digest, bytes); return bytes;
    } catch { return undefined; }
  };
  const entries = new Map(registry.entries.map((entry) => [entry.contract.capability_id, entry]));
  const records = new Map<string, BehaviorQualificationV1>();
  const recordIds = new Map<string, string>();
  const duplicateIds = new Set<string>();
  // Parse all qualification byte snapshots before invoking the host's artifact reader.
  for (const bytes of [...input.qualificationBytes]) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_QUALIFICATION_BYTES || bytes.byteLength > remainingBytes) {
      snapshot.qualificationRejections.push({ sha256: "", reason: "qualification_oversized" }); continue;
    }
    remainingBytes -= bytes.byteLength;
    const copy = Buffer.from(bytes); const digest = hash(copy);
    try {
      const record = parseArtifact(copy, BehaviorQualificationV1, MAX_QUALIFICATION_BYTES);
      const previous = recordIds.get(record.payload.record_id);
      if (previous && previous !== digest) duplicateIds.add(record.payload.record_id);
      recordIds.set(record.payload.record_id, digest); records.set(digest, record);
    } catch { snapshot.qualificationRejections.push({ sha256: digest, reason: "qualification_invalid" }); }
  }
  function qualificationError(record: BehaviorQualificationV1): string | null {
    const p = record.payload;
    const entry = entries.get(p.capability_id); const policy = policies.get(p.capability_id);
    if (duplicateIds.has(p.record_id)) return "qualification_id_conflict";
    if (!entry || !policy) return "capability_or_policy_missing";
    const key = trust.keys.find((candidate) => candidate.keyId === p.signer_key_id);
    if (!key || key.issuerRole !== p.issuer_role || !key.capabilityIds.includes(p.capability_id)
      || !key.profileSha256s.includes(hash(canonical(p.profile)))) return "issuer_scope_mismatch";
    if (!verify(null, Buffer.from(canonical(p)), publicKeys.get(key.keyId)!, Buffer.from(record.signature.value_base64, "base64"))) return "signature_invalid";
    if (revocations.revokedKeyIds.includes(p.signer_key_id) || revocations.revokedRecordIds.includes(p.record_id)) return "qualification_revoked";
    if (p.revocation_epoch > revocations.epoch || Date.parse(p.issued_at) > nowMs || Date.parse(p.expires_at) <= nowMs
      || Date.parse(p.expires_at) - Date.parse(p.issued_at) > trust.maxQualificationLifetimeMs) return "qualification_not_current";
    if (p.candidate_sha !== target.candidateSha || p.target_code_sha256 !== target.targetCodeSha256
      || p.behavior_contract_sha256 !== entry.contract_sha256 || p.source_manifest_sha256 !== entry.contract.source_manifest_sha256
      || p.policy_profile_sha256 !== target.policyProfileSha256 || p.registry_sha256 !== expectedRegistrySha256) return "qualification_binding_mismatch";
    if (canonical(p.profile) !== canonical(p.level === "contract_tested" ? target.ciProfile : target.hostProfile)) return "profile_mismatch";
    // Free text limitations cannot silently loosen automatic eligibility. A later policy version must model them.
    if (p.limitations.length) return "unresolved_limitations";
    const scenarios = policy.requiredScenarios[p.level];
    if (hash(canonical(scenarios.map((scenario) => scenario.id).sort())) !== p.required_scenario_set_sha256
      || p.evidence_refs.length !== scenarios.length) return "scenario_set_mismatch";
    for (const scenario of scenarios) {
      const evidence = p.evidence_refs.find((item) => item.scenario_id === scenario.id);
      if (evidence?.result !== "passed" || evidence.subject_sha256 !== target.targetCodeSha256
        || evidence.checker_id !== scenario.checkerId || evidence.checker_version !== scenario.checkerVersion) return "evidence_mismatch";
      if (!read(evidence.artifact_sha256)) return "evidence_unavailable";
    }
    const bundle = read(p.evidence_bundle_sha256);
    if (!bundle) return "evidence_unavailable";
    try {
      const parsed = parseArtifact(bundle, BehaviorEvidenceBundleV1, MAX_ARTIFACT_BYTES);
      if (parsed.candidate_sha !== p.candidate_sha || canonical(parsed.limitations) !== canonical(p.limitations)
        || canonical(parsed.evidence) !== canonical(p.evidence_refs)) return "evidence_bundle_mismatch";
    } catch { return "evidence_bundle_invalid"; }
    return null;
  }
  const verified = new Map<string, BehaviorQualificationV1>();
  for (const [digest, record] of records) {
    const error = qualificationError(record);
    if (error) snapshot.qualificationRejections.push({ sha256: digest, reason: error }); else verified.set(digest, record);
  }
  const chain = (digest: string, capability: string, level: number): string[] | undefined => {
    const record = verified.get(digest);
    if (!record || record.payload.capability_id !== capability || record.payload.level !== levels[level]) return undefined;
    if (level === 0) return [digest];
    const previous = chain(record.payload.prerequisite_record_sha256[0]!, capability, level - 1);
    return previous ? [...previous, digest] : undefined;
  };
  for (const { contract, contract_sha256 } of registry.entries) {
    const reasons: string[] = []; const policy = policies.get(contract.capability_id);
    if (hash(canonical(contract)) !== contract_sha256) reasons.push("contract_digest_mismatch");
    if (!policy || policy.contractVersion !== contract.version || levels.some((level) =>
      canonical(contract.required_scenarios.filter((scenario) => scenario.level === level).map((scenario) => scenario.id).sort())
      !== canonical(policy.requiredScenarios[level].map((scenario) => scenario.id).sort()))) reasons.push("policy_missing_or_mismatch");
    if (!read(contract.source_manifest_sha256) || contract.sources.some((source) => !read(source.content_sha256))) reasons.push("source_unavailable");
    let qualificationSha256s: string[] = [];
    for (const [digest, record] of verified) {
      if (record.payload.capability_id === contract.capability_id && record.payload.level === "journey_verified") {
        const found = chain(digest, contract.capability_id, 2);
        if (found) { qualificationSha256s = found; break; }
      }
    }
    if (!qualificationSha256s.length) reasons.push("qualification_missing_or_invalid");
    for (const dependency of contract.depends_on) {
      const targetEntry = entries.get(dependency.capability_id);
      if (!targetEntry) reasons.push("dependency_missing");
      else if (targetEntry.contract.version !== dependency.version) reasons.push("dependency_version_mismatch");
    }
    snapshot.entries.push({ capabilityId: contract.capability_id, contract, selectionEligible: reasons.length === 0, reasons,
      qualificationSha256s, validUntilMs: qualificationSha256s.length ? Math.min(revocations.expiresAtMs,
        revocations.issuedAtMs + trust.maxRevocationAgeMs,
        ...qualificationSha256s.map((digest) => Date.parse(verified.get(digest)!.payload.expires_at))) : null });
  }
  const projections = new Map(snapshot.entries.map((entry) => [entry.capabilityId, entry]));
  const finished = new Set<string>(); const stack: string[] = [];
  const visit = (id: string): void => {
    const index = stack.indexOf(id);
    if (index >= 0) {
      for (const member of stack.slice(index)) {
        const entry = projections.get(member)!;
        if (!entry.reasons.includes("dependency_cycle")) entry.reasons.push("dependency_cycle");
        entry.selectionEligible = false;
      }
      return;
    }
    if (finished.has(id)) return;
    stack.push(id);
    for (const dependency of projections.get(id)!.contract.depends_on) if (projections.has(dependency.capability_id)) visit(dependency.capability_id);
    stack.pop(); finished.add(id);
  };
  for (const id of projections.keys()) visit(id);
  for (let pass = 0; pass < snapshot.entries.length; pass++) {
    for (const entry of snapshot.entries) {
      if (entry.contract.depends_on.some((dependency) => projections.get(dependency.capability_id)?.selectionEligible === false)) {
        if (!entry.reasons.includes("dependency_unqualified")) entry.reasons.push("dependency_unqualified");
        entry.selectionEligible = false;
      }
      if (entry.validUntilMs !== null) {
        for (const dependency of entry.contract.depends_on) {
          const until = projections.get(dependency.capability_id)?.validUntilMs;
          if (until !== null && until !== undefined) entry.validUntilMs = Math.min(entry.validUntilMs, until);
        }
      }
    }
  }
  for (const entry of snapshot.entries) if (!entry.selectionEligible) entry.validUntilMs = null;
  snapshot.status = "loaded";
  return freeze(snapshot);
}

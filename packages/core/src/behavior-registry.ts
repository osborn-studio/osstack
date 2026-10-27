import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import {
  BEHAVIOR_DOCUMENT_MAX_BYTES, BehaviorCapabilityIdV1, BehaviorEvidenceBundleV1, BehaviorQualificationProfileV1,
  BehaviorQualificationV1, BehaviorRegistryV1, BehaviorSourceManifestV1,
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
  /** The host verifies the operations-root signature and persists the epoch before calling this evaluator. */
  revocations: { epoch: number; issuedAtMs: number; expiresAtMs: number; revokedKeyIds: string[]; revokedQualificationSha256s: string[] };
}
export interface BehaviorRegistryInput {
  registryBytes: Uint8Array;
  expectedRegistrySha256: string;
  expectedRegistryVersion: string;
  /** Evaluation clock asserted by the host, not authenticated wall time. Never accept it from a worker. */
  nowMs: number;
  /** Host-selected bounded batch, not an unfiltered multi-writer append log. */
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
  contractSha256: string;
  /** Requirements satisfied only under the echoed input context. Never an authorization or route grant. */
  selectionEligible: boolean;
  reasons: string[];
  qualificationSha256s: string[];
  validUntilMs: number | null;
}
export interface BehaviorRegistryEvaluationContext {
  candidateSha: string;
  targetCodeSha256: string;
  policyProfileSha256: string;
  ciProfileSha256: string;
  hostProfileSha256: string;
  revocationEpoch: number;
  registryVersion: string;
  revocationSnapshotSha256: string;
  trustSha256: string;
  minimumRevocationEpoch: number;
  maxRevocationAgeMs: number;
  maxQualificationLifetimeMs: number;
}
export interface BehaviorRegistrySnapshot {
  status: "evaluated" | "rejected";
  authorization: "none";
  rejection: string | null;
  expectedRegistrySha256: string;
  observedRegistrySha256: string | null;
  /** Normalized caller assertions, not a certificate that the host or revocations are authentic. */
  context: BehaviorRegistryEvaluationContext | null;
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
const MAX_QUALIFICATION_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_EVIDENCE_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_REVOCATION_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_QUALIFICATION_LIFETIME_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_REVOKED_KEYS = 4096;
const MAX_REVOKED_RECORDS = 16384;
// Known small-order y encodings, including noncanonical p/p+1 aliases. Sign bit is ignored.
// Source: libsodium 1.0.18 ge25519_has_small_order:
// https://github.com/jedisct1/libsodium/blob/1.0.18/src/libsodium/crypto_core/ed25519/ref10/ed25519_ref10.c
const SMALL_ORDER_ED25519_Y = new Set([
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
]);
function hasDegenerateEd25519Encoding(key: KeyObject): boolean {
  const jwk = key.export({ format: "jwk" });
  if (typeof jwk.x !== "string") return true;
  const encoded = Buffer.from(jwk.x, "base64url");
  if (encoded.length !== 32) return true;
  encoded[31] = encoded[31]! & 0x7f;
  return SMALL_ORDER_ED25519_Y.has(encoded.toString("hex"));
}
const MAX_KEY_PROFILES = 128;
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
  // while retaining R01 Behavior* signing bytes independently of J01 Joint* codecs.
  // Any codec unification needs explicit R05/J10 migration vectors; never convert implicitly.
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
const exactKeys = (value: unknown, keys: string[]): boolean => value !== null && typeof value === "object"
  && !Array.isArray(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const token = (value: string) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,511}$/.test(value);

/**
 * Evaluate one build against caller-supplied pins, time and trust assertions. This is a library
 * boundary, not an RPC or authority issuer. Callers must re-evaluate after time/trust changes and
 * perform normal host authorization before every effect. R05/V06 own policy issuance, operations
 * signature verification, persistent epoch protection and trust-root custody; this evaluator cannot
 * authenticate a caller that supplies its own trust context. No daemon path calls this yet.
 * Work is bounded but synchronous; do not run it on a latency-critical RPC/dispatch event loop.
 */
export function evaluateBehaviorRegistry(input: BehaviorRegistryInput): BehaviorRegistrySnapshot {
  const nowMs = input.nowMs;
  const expectedRegistrySha256 = input.expectedRegistrySha256;
  const expectedRegistryVersion = input.expectedRegistryVersion;
  const readArtifact = input.readArtifact;
  const snapshot: BehaviorRegistrySnapshot = { status: "rejected", authorization: "none", rejection: null,
    expectedRegistrySha256, observedRegistrySha256: null, context: null,
    evaluatedAtMs: nowMs, entries: [], qualificationRejections: [] };
  const reject = (reason: string) => freeze({ ...snapshot, rejection: reason });
  let target: BehaviorRegistryInput["target"];
  let trust: BehaviorRegistryTrust;
  let policies: Map<string, BehaviorRegistryPolicy>;
  const publicKeys = new Map<string, KeyObject>();
  try {
    if (!exactKeys(input.target, ["candidateSha", "targetCodeSha256", "policyProfileSha256", "hostProfile", "ciProfile"])) return reject("invalid_context");
    target = structuredClone(input.target);
    target.hostProfile = BehaviorQualificationProfileV1.parse(target.hostProfile);
    target.ciProfile = BehaviorQualificationProfileV1.parse(target.ciProfile);
    const rawTrust = input.trust;
    if (!exactKeys(rawTrust, ["keys", "minimumRevocationEpoch", "maxRevocationAgeMs", "maxQualificationLifetimeMs", "revocations"])
      || !Array.isArray(rawTrust.keys) || rawTrust.keys.length > 100
      || rawTrust.keys.some((key) => !exactKeys(key, ["keyId", "publicKeyPem", "issuerRole", "capabilityIds", "profileSha256s"]) || typeof key.publicKeyPem !== "string" || key.publicKeyPem.length > 1024
        || !/^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----\r?\n?$/.test(key.publicKeyPem)
        || !Array.isArray(key.capabilityIds) || key.capabilityIds.length > 24
        || !Array.isArray(key.profileSha256s) || key.profileSha256s.length > MAX_KEY_PROFILES)) return reject("invalid_context");
    const rawRevocations = rawTrust.revocations;
    if (!exactKeys(rawRevocations, ["epoch", "issuedAtMs", "expiresAtMs", "revokedKeyIds", "revokedQualificationSha256s"])
      || !Array.isArray(rawRevocations.revokedKeyIds) || rawRevocations.revokedKeyIds.length > MAX_REVOKED_KEYS
      || !Array.isArray(rawRevocations.revokedQualificationSha256s) || rawRevocations.revokedQualificationSha256s.length > MAX_REVOKED_RECORDS) return reject("revocation_unavailable");
    if (!Array.isArray(input.qualificationBytes) || !Array.isArray(input.policy)) return reject("invalid_context");
    trust = structuredClone(rawTrust);
    if (!safeInteger(nowMs) || !commitPattern.test(target.candidateSha)
      || ![target.targetCodeSha256, target.policyProfileSha256, expectedRegistrySha256].every((value) => digestPattern.test(value))
      || !versionPattern.test(expectedRegistryVersion)
      || !safeInteger(trust.minimumRevocationEpoch) || trust.keys.length > 100 || input.qualificationBytes.length > 256
      || !safeInteger(trust.maxRevocationAgeMs) || !trust.maxRevocationAgeMs || trust.maxRevocationAgeMs > MAX_REVOCATION_AGE_MS
      || !safeInteger(trust.maxQualificationLifetimeMs) || !trust.maxQualificationLifetimeMs || trust.maxQualificationLifetimeMs > MAX_QUALIFICATION_LIFETIME_MS
      || input.policy.length > 24) return reject("invalid_context");
    const ciDifferences = new Set(["os", "architecture", "filesystem", "host_identity_sha256"]);
    if (Object.entries(target.hostProfile).some(([key, value]) => !ciDifferences.has(key)
      && target.ciProfile[key as keyof BehaviorQualificationProfileV1] !== value)) return reject("ci_profile_mismatch");
    const keyFingerprints = new Set<string>();
    for (const key of trust.keys) {
      const publicKey = createPublicKey(key.publicKeyPem);
      const fingerprint = hash(publicKey.export({ type: "spki", format: "der" }));
      if (!token(key.keyId) || publicKeys.has(key.keyId) || keyFingerprints.has(fingerprint)
        || publicKey.asymmetricKeyType !== "ed25519" || hasDegenerateEd25519Encoding(publicKey) || !roles.includes(key.issuerRole)
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
          || !scenarios.every((scenario) => [scenario.id, scenario.checkerId, scenario.checkerVersion].every(token))) return reject("invalid_context");
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
    || !Array.isArray(revocations.revokedQualificationSha256s) || !revocations.revokedKeyIds.every(token)
    || !revocations.revokedQualificationSha256s.every((digest) => digestPattern.test(digest))) return reject("revocation_unavailable");
  const revocationSnapshot = { epoch: revocations.epoch, issuedAtMs: revocations.issuedAtMs,
    expiresAtMs: revocations.expiresAtMs, revokedKeyIds: revocations.revokedKeyIds,
    revokedQualificationSha256s: revocations.revokedQualificationSha256s };
  const trustConfiguration = { keys: trust.keys.map((key) => ({ keyId: key.keyId, publicKeyPem: key.publicKeyPem,
    issuerRole: key.issuerRole, capabilityIds: key.capabilityIds, profileSha256s: key.profileSha256s })),
    minimumRevocationEpoch: trust.minimumRevocationEpoch, maxRevocationAgeMs: trust.maxRevocationAgeMs,
    maxQualificationLifetimeMs: trust.maxQualificationLifetimeMs };
  snapshot.context = { registryVersion: expectedRegistryVersion, revocationSnapshotSha256: hash(canonical(revocationSnapshot)),
    trustSha256: hash(canonical(trustConfiguration)), minimumRevocationEpoch: trust.minimumRevocationEpoch,
    maxRevocationAgeMs: trust.maxRevocationAgeMs, maxQualificationLifetimeMs: trust.maxQualificationLifetimeMs,
    candidateSha: target.candidateSha, targetCodeSha256: target.targetCodeSha256,
    policyProfileSha256: target.policyProfileSha256, ciProfileSha256: hash(canonical(target.ciProfile)),
    hostProfileSha256: hash(canonical(target.hostProfile)), revocationEpoch: revocations.epoch };
  let registry: BehaviorRegistryV1;
  try {
    if (!(input.registryBytes instanceof Uint8Array) || input.registryBytes.byteLength > MAX_REGISTRY_BYTES) return reject("registry_invalid");
    const bytes = Buffer.from(input.registryBytes);
    snapshot.observedRegistrySha256 = hash(bytes);
    if (snapshot.observedRegistrySha256 !== expectedRegistrySha256) return reject("registry_digest_mismatch");
    registry = parseArtifact(bytes, BehaviorRegistryV1, MAX_REGISTRY_BYTES);
  } catch { return reject("registry_invalid"); }
  if (registry.registry_version !== expectedRegistryVersion) return reject("registry_version_mismatch");
  if (registry.candidate_sha !== target.candidateSha || registry.target_code_sha256 !== target.targetCodeSha256) return reject("candidate_mismatch");
  let remainingEvidenceBytes = MAX_EVIDENCE_TOTAL_BYTES;
  // Bound the raw host-selected batch before parsing, copying or consulting the artifact store.
  let qualificationTotalBytes = 0;
  for (const bytes of input.qualificationBytes) {
    if (bytes instanceof Uint8Array) qualificationTotalBytes += bytes.byteLength;
    if (qualificationTotalBytes > MAX_QUALIFICATION_TOTAL_BYTES) return reject("qualification_batch_oversized");
  }
  const artifacts = new Map<string, Buffer | undefined>();
  const read = (digest: string): Buffer | undefined => {
    if (artifacts.has(digest)) return artifacts.get(digest);
    // Cache every attempt, including missing/corrupt/throwing reads. Charge bounded bytes
    // before hashing so corrupt objects still count toward actual copy/hash work.
    artifacts.set(digest, undefined);
    try {
      const original = readArtifact(digest);
      if (!(original instanceof Uint8Array) || original.byteLength > MAX_ARTIFACT_BYTES || original.byteLength > remainingEvidenceBytes) return undefined;
      remainingEvidenceBytes -= original.byteLength;
      const bytes = Buffer.from(original);
      if (hash(bytes) !== digest) return undefined;
      artifacts.set(digest, bytes); return bytes;
    } catch { return undefined; }
  };
  const entries = new Map(registry.entries.map((entry) => [entry.contract.capability_id, entry]));
  const records = new Map<string, BehaviorQualificationV1>();
  // Parse all qualification byte snapshots before invoking the host's artifact reader.
  for (const bytes of [...input.qualificationBytes]) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_QUALIFICATION_BYTES) {
      snapshot.qualificationRejections.push({ sha256: "", reason: "qualification_oversized" }); continue;
    }
    const copy = Buffer.from(bytes); const digest = hash(copy);
    try {
      const record = parseArtifact(copy, BehaviorQualificationV1, MAX_QUALIFICATION_BYTES);
      records.set(digest, record);
    } catch { snapshot.qualificationRejections.push({ sha256: digest, reason: "qualification_invalid" }); }
  }
  function authenticationError(record: BehaviorQualificationV1, digest: string): string | null {
    const p = record.payload;
    const entry = entries.get(p.capability_id); const policy = policies.get(p.capability_id);
    if (!entry || !policy) return "capability_or_policy_missing";
    const key = trust.keys.find((candidate) => candidate.keyId === p.signer_key_id);
    if (!key || key.issuerRole !== p.issuer_role || !key.capabilityIds.includes(p.capability_id)
      || !key.profileSha256s.includes(hash(canonical(p.profile)))) return "issuer_scope_mismatch";
    if (!verify(null, Buffer.from(canonical(p)), publicKeys.get(key.keyId)!, Buffer.from(record.signature.value_base64, "base64"))) return "signature_invalid";
    if (revocations.revokedKeyIds.includes(p.signer_key_id) || revocations.revokedQualificationSha256s.includes(digest)) return "qualification_revoked";
    if (p.revocation_epoch > revocations.epoch || Date.parse(p.issued_at) > nowMs || Date.parse(p.expires_at) <= nowMs
      || Date.parse(p.expires_at) - Date.parse(p.issued_at) > trust.maxQualificationLifetimeMs) return "qualification_not_current";
    if (p.candidate_sha !== target.candidateSha || p.target_code_sha256 !== target.targetCodeSha256
      || p.behavior_contract_sha256 !== entry.contract_sha256 || p.source_manifest_sha256 !== entry.contract.source_manifest_sha256
      || p.policy_profile_sha256 !== target.policyProfileSha256 || p.registry_sha256 !== expectedRegistrySha256) return "qualification_binding_mismatch";
    if (canonical(p.profile) !== canonical(p.level === "contract_tested" ? target.ciProfile : target.hostProfile)) return "profile_mismatch";
    return null;
  }
  function evidenceError(record: BehaviorQualificationV1): string | null {
    const p = record.payload; const policy = policies.get(p.capability_id)!;
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
  const authenticated = new Map<string, BehaviorQualificationV1>();
  const recordIds = new Map<string, string>(); const duplicateIds = new Set<string>();
  const scopedRecordId = (record: BehaviorQualificationV1) => canonical([record.payload.signer_key_id, record.payload.record_id]);
  for (const [digest, record] of [...records].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const error = authenticationError(record, digest);
    if (error) { snapshot.qualificationRejections.push({ sha256: digest, reason: error }); continue; }
    const id = scopedRecordId(record); const previous = recordIds.get(id);
    if (previous && previous !== digest) duplicateIds.add(id);
    recordIds.set(id, digest); authenticated.set(digest, record);
  }
  const verified = new Map<string, BehaviorQualificationV1>();
  for (const [digest, record] of authenticated) {
    const error = duplicateIds.has(scopedRecordId(record)) ? "qualification_id_conflict" : evidenceError(record);
    if (error) snapshot.qualificationRejections.push({ sha256: digest, reason: error }); else verified.set(digest, record);
  }
  const chain = (digest: string, capability: string, level: number): string[] | undefined => {
    const record = verified.get(digest);
    if (!record || record.payload.capability_id !== capability || record.payload.level !== levels[level]) return undefined;
    if (level === 0) return [digest];
    const previous = chain(record.payload.prerequisite_record_sha256[0]!, capability, level - 1);
    return previous ? [...previous, digest] : undefined;
  };
  const sourceManifests = new Map<string, Set<string>>();
  const sourceError = (contract: BehaviorContractV1): string | null => {
    let tuples = sourceManifests.get(contract.source_manifest_sha256);
    if (!tuples) {
      const bytes = read(contract.source_manifest_sha256);
      if (!bytes) return "source_unavailable";
      try {
        const manifest = parseArtifact(bytes, BehaviorSourceManifestV1, MAX_ARTIFACT_BYTES);
        tuples = new Set(manifest.sources.map((source) => canonical(source)));
        sourceManifests.set(contract.source_manifest_sha256, tuples);
      } catch { return "source_manifest_invalid"; }
    }
    if (contract.sources.some((source) => !tuples.has(canonical(source)))) return "source_manifest_mismatch";
    if (contract.sources.some((source) => !read(source.content_sha256))) return "source_unavailable";
    return null;
  };
  for (const { contract, contract_sha256 } of registry.entries) {
    const reasons: string[] = []; const policy = policies.get(contract.capability_id);
    if (hash(canonical(contract)) !== contract_sha256) reasons.push("contract_digest_mismatch");
    if (!policy || policy.contractVersion !== contract.version || levels.some((level) =>
      canonical(contract.required_scenarios.filter((scenario) => scenario.level === level).map((scenario) => scenario.id).sort())
      !== canonical(policy.requiredScenarios[level].map((scenario) => scenario.id).sort()))) reasons.push("policy_missing_or_mismatch");
    const sourceFailure = sourceError(contract);
    if (sourceFailure) reasons.push(sourceFailure);
    let qualificationSha256s: string[] = []; let chainValidUntilMs = -1;
    for (const [digest, record] of verified) {
      if (record.payload.capability_id === contract.capability_id && record.payload.level === "journey_verified") {
        const found = chain(digest, contract.capability_id, 2);
        if (found) {
          const until = Math.min(revocations.expiresAtMs, revocations.issuedAtMs + trust.maxRevocationAgeMs,
            ...found.map((recordDigest) => Date.parse(verified.get(recordDigest)!.payload.expires_at)));
          // Records are visited in digest order; equal windows retain the smallest journey digest.
          if (until > chainValidUntilMs) { qualificationSha256s = found; chainValidUntilMs = until; }
        }
      }
    }
    if (!qualificationSha256s.length) reasons.push("qualification_missing_or_invalid");
    for (const dependency of contract.depends_on) {
      const targetEntry = entries.get(dependency.capability_id);
      if (!targetEntry) reasons.push("dependency_missing");
      else if (targetEntry.contract.version !== dependency.version) reasons.push("dependency_version_mismatch");
    }
    snapshot.entries.push({ capabilityId: contract.capability_id, contract, contractSha256: contract_sha256, selectionEligible: reasons.length === 0, reasons,
      qualificationSha256s, validUntilMs: qualificationSha256s.length ? chainValidUntilMs : null });
  }
  const projections = new Map(snapshot.entries.map((entry) => [entry.capabilityId, entry]));
  // At most 24 nodes: per-node reachability identifies every cycle member, including diamond joins.
  for (const entry of snapshot.entries) {
    const pending = entry.contract.depends_on.map((dependency) => dependency.capability_id);
    const visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === entry.capabilityId) { entry.reasons.push("dependency_cycle"); entry.selectionEligible = false; break; }
      if (visited.has(id)) continue;
      visited.add(id);
      for (const dependency of projections.get(id)?.contract.depends_on ?? []) pending.push(dependency.capability_id);
    }
  }
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
  for (const entry of snapshot.entries) if (!entry.selectionEligible) { entry.validUntilMs = null; entry.qualificationSha256s = []; }
  snapshot.status = "evaluated";
  return freeze(snapshot);
}

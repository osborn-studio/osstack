# Behavior registry evaluator / 行为注册表评估器

`evaluateBehaviorRegistry` is an experimental synchronous library function in `@osstack/core`.
It checks registry bytes against the caller's build pins, clock, policy and trust context.
It does not authenticate those inputs. It does not grant execution authority.
No daemon route or automatic executor uses it in this delivery.

## Records and checks

R01 defines separate versioned records:

- `BehaviorContractV1`: a behavior declaration with source references and dependencies.
- `BehaviorSourceManifestV1`: a pinned source snapshot. A contract may cite a subset of its entries.
- `BehaviorRegistryV1`: declarations for one candidate and target code digest.
- `BehaviorQualificationV1`: signed qualification evidence claims.
- `BehaviorDeliveryRecordV1`: a progress projection. The evaluator never uses it as qualification.

A source tuple contains repository URL, commit, path, content SHA-256 and license.
Each contract tuple must match an entry in its declared source manifest exactly.
The evaluator also retrieves and hashes each cited source object. It does not execute source text.
A global manifest can contain additional source entries. Their presence does not qualify their content.
R03/R04 still own extraction, provenance review and behavior mapping.

The evaluator checks Ed25519 signatures, key role and scope, all three qualification levels,
predecessor hashes, exact candidate and code identity, source membership, required scenarios,
checker identity, evidence bundles and artifacts, validity windows and revocations.
It rejects invalid dependencies, version mismatches and cycles.
Only authenticated, current and correctly bound records participate in record-ID conflicts.
Uniqueness is scoped to `(signer_key_id, record_id)`. One issuer cannot squat on another issuer's ID.
Within an admitted batch, an unauthenticated duplicate does not create an ID conflict.
Revocations use `revokedQualificationSha256s`: hashes of complete canonical qualification documents,
including signatures, exactly as predecessor references do. The experimental host API no longer accepts
the earlier bare `revokedRecordIds` list. No frozen qualification wire field or signing byte changed.

Evidence artifacts are checked for availability and digest equality. Their contents are not interpreted
or re-executed. Bundles are checked against signed candidate, limitation and scenario/checker/result claims;
the signer is responsible for evidence semantics and its applicability to the signed capability, level and
profile. Shared artifact bytes do not independently establish that applicability. The evaluator also does
not prove that a remote Git commit contains the cited bytes or that a code digest identifies an actual build.

The CI measurement cell may differ from the deployment cell only in OS, architecture,
filesystem and host identity. Adapter, provider, model, executor, template, recovery mode,
isolation profile and daemon version must match. This rule is intentionally conservative.

## Required host boundary

Before calling the function, a separate trusted host must:

1. Obtain the expected registry pin and candidate identity from its trusted build process.
2. Authenticate the actual host and its measurement profile.
3. Authenticate the verifier policy, issuer keys and allowed scopes.
4. Verify the operations-root signature on the revocation document.
5. Persist and recover the monotonic revocation epoch floor.
6. Supply its trusted evaluation clock and fresh revocation state.

These operations belong to R05/V06 and are not implemented by this library.
A caller that supplies its own keys and clock can produce a consistent local evaluation.
That result does not prove a production host is qualified.
The package export and TypeScript types are not security boundaries.

`nowMs` is explicit host data. The evaluator does not compare it with `Date.now()`.
This permits deterministic replay. A historical evaluation must never authorize present execution.
The host must not accept the context or clock from a worker or untrusted RPC request.

The host must give behavior qualification keys a dedicated protocol purpose.
Version 1 retains the frozen draft's signature over the canonical payload.
It does not add a new signature prefix without an explicit issuer protocol migration.
Known small-order Ed25519 public-key encodings, both sign-bit variants and the p/p+1 aliases are rejected
using the fixed encoding table from [libsodium 1.0.18, `ge25519_has_small_order`](https://github.com/jedisct1/libsodium/blob/1.0.18/src/libsodium/crypto_core/ed25519/ref10/ed25519_ref10.c).
The check examines the parsed key's 32-byte JWK public component; Node crypto still performs verification.
This is a degenerate-encoding check, not a new curve implementation or authentication of key ownership.

## Bytes, policy and result

Registry, qualification, evidence-bundle and source-manifest JSON must already use canonical bytes.
The evaluator checks strict schemas, then requires the bytes to equal RFC 8785 serialization
for the supported closed value set. Duplicate keys, BOMs, alternate numeric spellings,
unknown fields and noncanonical whitespace are rejected.
This is not a general JSON parser or a replacement for the joint engineering JSON contract.

`policyProfileSha256` is the SHA-256 of canonical JSON with this exact shape:

```json
{"schema_version":1,"kind":"behavior_verifier_policy","capabilities":[]}
```

`capabilities` is the supplied policy array. Each item binds the capability, exact behavior version,
and scenario/checker/version requirements for each level. The actual policies must have nonempty
scenario sets. Array order is pinned. The example only shows the digest envelope shape.

The output has `status: evaluated` or `rejected` and always has `authorization: none`.
`expectedRegistrySha256` is the caller's pin. `observedRegistrySha256` is the digest actually read,
or null when no bounded registry document was read. Rejection does not turn the expected pin into an observation.
The context echoes candidate, code, policy, CI profile, host profile, registry version and revocation epoch,
plus the epoch floor and both window limits. It also records SHA-256 of canonical JSON for:

- `revocationSnapshotSha256`: `{epoch, issuedAtMs, expiresAtMs, revokedKeyIds, revokedQualificationSha256s}`.
- `trustSha256`: `{keys, minimumRevocationEpoch, maxRevocationAgeMs, maxQualificationLifetimeMs}`.
  Each key contains exactly `{keyId, publicKeyPem, issuerRole, capabilityIds, profileSha256s}`.

Arrays keep their supplied order and PEM strings keep their exact bytes. These are input fingerprints,
not semantic set identifiers. A same-epoch snapshot with changed contents has a different digest.
Each entry also exposes its registry-declared `contractSha256`; a mismatch makes the entry ineligible.
Those fields describe the evaluation inputs. They are not authenticated-host certificates.

`selectionEligible` means the supplied requirements held at `evaluatedAtMs` under that context.
`validUntilMs` is an upper bound, including dependencies and revocation freshness.
It is not a lease that survives a new revocation or changed candidate.
Re-evaluate when relevant inputs change. Apply normal host authorization before each effect.
Nonempty free-text qualification limitations block selection until a versioned policy can enforce them.
When multiple chains qualify, choose the greatest effective validity bound; ties use the smallest journey
document digest. Input order does not select the winner. Ineligible entries return an empty
`qualificationSha256s` and null `validUntilMs`, including source, policy and dependency failures.

## Bounds and validation scope

| Input | Hard limit |
|---|---|
| Registry or qualification document | 1 MiB each |
| Raw qualification batch | At most 256 documents and 64 MiB total; exceeding either rejects the whole evaluation |
| Fetched source/evidence object | 8 MiB each; separate 64 MiB total budget |
| Registry entries / source manifest entries | 24 / 8,192 |
| Issuer keys / capabilities per key / profiles per key | 100 / 24 / 128 |
| Public key PEM | 1,024 characters; SPKI `PUBLIC KEY` only |
| Revoked keys / qualification digests | 4,096 / 16,384 |
| Revocation cache age | Host-selected limit, at most 24 hours |
| Qualification lifetime | Host-selected limit, at most 31 days |

The host must select a finite batch from authenticated storage, filtered by intended candidate,
capabilities and issuer provenance. Do not pass a multi-writer append log directly to this API.
The raw count/byte limits apply before authentication; invalid padding can reject an oversized batch.
This is an intentional fail-closed resource limit, not availability protection against arbitrary input.
Never remove raw limits to scan or verify an unbounded log. Qualification parsing has an independent budget;
malformed documents do not spend the evidence budget. The evaluator remains synchronous. Run it outside
latency-critical RPC and dispatch work; bounded does not mean low latency.

Revocations must be a complete current snapshot, not a delta. R05/V06 must define safe retention,
rotation and pruning that preserve revocation of every still-valid qualification. The evaluator does not
truncate an oversized revocation set, ratchet a persisted epoch/digest pair or detect equivocation by itself.

Tests use isolated keys, source objects and evidence fixtures. They do not certify actual providers,
adapters, physical power-loss recovery, process containment or remote hosts. No operator recovery
or control-plane migration is part of this change.

## 中文说明

这是一个纯评估库。它检查输入之间是否一致，不证明调用方的身份、时钟或信任配置是真实的。
它不验运维根签名，不保存撤销 epoch，不开启运行时功能，也不批准任何副作用。

来源清单具有独立版本。每项能力只能引用清单中完全一致的来源条目。
全局清单可以更大；未引用的条目不会因此取得资格。
资格记录必须通过验签、范围和当前绑定检查，才会参与同 ID 冲突检测。
ID 按签发者隔离；撤销绑定完整资格文档摘要。输入批次必须由宿主筛选并限制总量；
超量填充会保守拒绝整批，不承诺任意追加日志下的可用性。证据内容的语义正确性仍由独立签发者负责。

返回结果保留候选、代码、策略、宿主组合和撤销 epoch。
期望的构建摘要与实际读取的摘要分别记录。
宿主必须先完成 R05/V06 的信任验证，再使用评估结果；执行动作前仍需独立授权。
测试通过不等于真实宿主资格通过。

## Joint contract compatibility and rejected inputs

R01 `Behavior*` records retain their version 1 canonical bytes, raw SHA-256 pins and signing payloads.
J01 `Joint*` records use separate versioned codecs and digest domains. This evaluator never converts
between them. J02a `source_inspection` output is not a `BehaviorSourceManifestV1`; R03/R04 and J02b
must explicitly map and check provenance before publishing a behavior source manifest.
J11 defines recovery specifications, not runtime authority. R05/J10 must supply migration vectors
before any future codec unification changes these frozen signature inputs.

The trusted `target`, `trust`, key and revocation objects use exact field sets. Extra or missing
fields reject the evaluation. A future revocation field cannot be silently ignored.
A qualification may have an epoch below the persisted snapshot floor. The floor applies to the
complete current revocation snapshot, not the issuance epoch. Older qualifications remain usable
only while current, correctly bound and absent from that complete snapshot's revocation lists.

Every artifact digest is read at most once per evaluation, including missing, corrupt or throwing
reads. Bounded returned bytes count toward the read/copy/hash budget before digest validation.
Failure caching does not forgive corrupted bytes or permit unlimited hashing of unique bad objects.

More than 256 qualification documents rejects with `invalid_context`; a batch above 64 MiB rejects
with `qualification_batch_oversized`. An oversized or non-byte document produces a rejection entry
with `sha256: ""`, which means no bounded document digest was computed, not a content identifier.

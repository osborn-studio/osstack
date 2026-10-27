# Adversarial review: R01 behavior protocol and R02 registry loader

Candidate `20fcb748` against base `daad404e`. This is a source-reading review only. Nothing was run.

## Verdict: PASS_WITH_CONCERNS

I found no P0/P1 bypass in the evaluator's cryptographic or binding logic. The signature, scope, candidate, contract, policy, registry, profile, evidence, chain and revocation checks all fail closed. I could not construct an input that gets a forged or mismatched record to `selectionEligible: true` without also controlling the host-supplied trust context.

The boundary is honest in the `loadBehaviorRegistry` doc comment but overstated in the changeset and the exported surface. Fix those before any R05 wiring or any consumer treats `selectionEligible` as meaningful.

## Boundary assessment

R02 is a pure evaluator over caller-asserted anchors. Every root of trust is a plain field on `BehaviorRegistryInput`:

- `expectedRegistrySha256`
- `expectedRegistryVersion`
- `target.candidateSha`, `target.targetCodeSha256`, `target.policyProfileSha256`
- both profiles
- `policy`
- `trust.keys`
- `minimumRevocationEpoch`, `maxRevocationAgeMs` and `maxQualificationLifetimeMs`
- `revocations`
- `nowMs`

The loader proves "these bytes are consistent with these anchors". It cannot prove the anchors are build-embedded, operations-root-signed, persisted or monotonic. The function doc comment says this accurately. The following do not:

- The changeset says "build-pinned ... current host-owned revocation state". Nothing is pinned to a build, and nothing can tell the state is host-owned or current.
- `loadBehaviorRegistry` is exported from the `@osstack/core` barrel, so any importer can mint its own trust context.
- Nothing in the types distinguishes verified trust from self-made trust.
- The tests are described as "trusted behavior registry loading".

## Findings

### Proven by source

**1. P2: Staleness and rollback protection is relative to a caller-chosen clock.** `behavior-registry.ts:107` takes `nowMs` from input. All of these are measured against that value: revocation freshness (`:156`), qualification expiry and issuance (`:210-211`), and `validUntilMs`. Nothing compares it to `Date.now()`. `maxRevocationAgeMs` and `maxQualificationLifetimeMs` are only checked to be `> 0` and a safe integer (`:126-127`). `minimumRevocationEpoch` is also caller-supplied, so `0` disables rollback detection.
- Reproducer: take any fixture and set `nowMs = revocations.issuedAtMs + 1` for a snapshot that is a year old in real time. Every freshness check passes. Setting `maxRevocationAgeMs = Number.MAX_SAFE_INTEGER` has the same effect.
- Impact: ADR-09's "expired or unobtainable current state stops enablement" depends entirely on caller discipline. A cached or test clock silently disables expiry and staleness.
- Fix:
  - Read the clock inside the loader, with a test-only injectable variant.
  - Or reject `nowMs` outside `Date.now() ± skew`.
  - Add hard upper caps on the two window parameters.
  - Return `revocationEpoch` in the snapshot so the host can ratchet its persisted floor.

**2. P2: Unauthenticated records can deny eligibility to legitimate ones, before any signature check.**
- Duplicate ids: `:195-196` marks `record_id` as a conflict for any two distinct byte-digests, and `:203` rejects every record with that id. This happens before signature verification.
  - Reproducer: append a copy of `record-2` with a changed `limitations` string and an `"A"×86 + "=="` signature. It is shape-valid, so the legitimate `record-2` becomes `qualification_id_conflict`.
- Shared byte budget: `:169`, `:188-191` and `:175` draw record bytes and artifact bytes from the same 64 MiB pool. About 64 shape-valid 1 MiB records placed first exhaust it. Later legitimate records are marked `qualification_oversized`, and artifact reads return `undefined`.
- Impact: fail-closed denial, not a bypass. Whoever controls the qualification store can disable any capability.
- Fix: count `record_id` conflicts only among records that pass signature and scope checks. Give records and artifacts separate budgets, and pre-filter by `capability_id` and `signer_key_id`.

**3. P2: `source_manifest_sha256` binds nothing semantic.** The manifest is only read and hash-checked at `:254`, and its content is never parsed. `contract.sources[]` is bound through `contract_sha256`, but no schema exists for the manifest and nothing relates it to `sources[]`. The fixture uses `{"sources":["AGENTS.md"]}` against an unrelated source entry, and the test passes.
- Impact: the digest the spec lists as a qualification binding gives no assurance beyond "some blob with this hash exists".
- Fix: define `BehaviorSourceManifestV1` and require it to equal the `sources[]` tuples. Otherwise state in the docs that it is opaque.

**4. P2: The public surface and docs overstate the guarantee.**
- `.changeset/behavior-registry-loader.md:5` says "build-pinned" and "host-owned revocation state". Change it to something like "evaluates caller-supplied pins and trust context; does not authenticate them".
- The function is exported from the `index.ts:9-11` barrel with plain-data trust types.
  - Make `BehaviorRegistryTrust` an opaque, branded type created only by a host module that is not re-exported.
  - Or move the function to an explicit `@osstack/core/behavior-registry` subpath marked experimental.
  - Or rename it to `evaluateBehaviorRegistry`.
- The `status: "loaded"` and `selectionEligible` names read like routing decisions.
- The snapshot echoes the caller's unverified `expectedRegistrySha256` as `registrySha256` even when it was rejected (`:112`).
- The snapshot carries no candidate, policy digest, profile or epoch, so a consumer cannot tell which context produced it.
- R02's roadmap acceptance, "loader 校验构建摘要", should not be marked satisfied until the pin is compile-time or R05-owned.

### Proven, lower severity

**5. P3: Unbounded trust-context inputs.** `revokedKeyIds`, `revokedRecordIds`, `capabilityIds`, `profileSha256s` and `publicKeyPem` have no length caps. Only the key count (100), policy count (24) and qualification count (256) are capped. The inputs are host-owned, but "sufficiently bounded" should cover them. The whole evaluation is also synchronous and can parse up to roughly 64 MiB, so document that it must not run on a latency-critical event loop.

**6. P3: The reentrancy test is partly vacuous.** In the second half of `captures time ...`, the record is already rejected by `expires_at <= now` before `readArtifact` runs, so the mutation hook never fires.

**7. P3: `createPublicKey` accepts private-key and certificate PEM.** Require `-----BEGIN PUBLIC KEY-----` and reject other PEM types.

**8. P3: Cycle reason labels are imprecise.** In A→B→C→A plus A→D→C, node D is not labeled `dependency_cycle`. It is still ineligible through `dependency_unqualified`, so this is fail-closed.

### Hypotheses that need missing context

**9. Domain separation.** The signed bytes are `canonical(payload)` with no context prefix. If any other OSStack signer reuses an Ed25519 key over canonical JSON, cross-protocol confusion is conceivable. Needs the R05/V06 key policy. A prefix such as `osstack/behavior-qualification/v1\n` would remove the question.

**10. CI profile freedom.** ADR-09 allows relaxing only the defined CI→host identity difference. The loader accepts any caller-supplied `ciProfile`, so a different adapter, model or executor would still chain. This is host config. Consider enforcing equality on all fields except os, architecture, filesystem and host identity.

**11. Zod/JSON-Schema conformance and generated schemas.** No test ties the Zod schemas to `qualification-contract.schema.json` (the "unchanged wire field names" claim). I cannot tell whether `generate.ts` or `schemas/` needed updates for the new types.

## What checked out

I verified these in the source:
- Canonical-bytes enforcement rejects duplicate keys, alternate numbers, BOMs, whitespace and unknown fields.
- Only the signature-valid, role-scoped key for the capability and exact profile verifies a record.
- A host key and a CI key cannot be swapped, and one key cannot be registered under two ids.
- All of the following are enforced: candidate, target, contract, source, policy and registry binding; exact scenario and checker identity from host policy; `passed`-only evidence with a matching subject; evidence bundle equality; and non-empty limitations rejected.
- Chain and revocation behavior: a revoked or missing predecessor invalidates the chain, and predecessors must match capability and level.
- Dependency closure, version equality, cycles and expiry propagation fail closed.
- Inputs are snapshotted and deep-cloned before the host reader is invoked, and the result is deep-frozen with `authorization: "none"`.

## Limitations

- No code ran, so I did not confirm the tests pass.
- I could not check the zod version, `generate.ts`, CI or the "production identical to base" claim.
- Operations-root verification, persistent epoch storage, key custody and activation are R05/V06 and were not assessed, per scope.
- Existing Session, DEBT03 and daemon code was read as context only.

AUDIT_COMPLETE

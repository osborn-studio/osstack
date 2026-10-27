# Adversarial review: R01 behavior protocol and R02 `evaluateBehaviorRegistry`

BASE `daad404e`, CANDIDATE `10c64812`. This is a source-reading review only. I ran nothing, so I did not confirm the tests pass. Scope is R01 and R02. Session and daemon code was read as background only.

## Verdict: PASS_WITH_CONCERNS

I found no P0 or P1. I could not construct an input that gets a forged, mis-bound, mis-scoped, stale or revoked record to `selectionEligible: true` without also controlling the caller-supplied trust context. The checks that hold:
- **Signature and scope:** signature, key role, capability and exact-profile scope.
- **Bindings:** candidate, target, contract, source manifest, policy and registry.
- **Policy-driven evidence:** scenario set, checker identity and evidence-bundle equality.
- **Chain and revocation:** predecessor chain by record digest, and revocation by key or record ID.
- **Snapshots:** all inputs are cloned before the first host reader call.

Two availability and authority-scope gaps remain (findings 1 and 2). They are the residue of the round-2 duplicate-ID and budget fixes.

## Round-2 re-check

| Round-2 item | Status |
|---|---|
| Unauthenticated duplicate IDs | Fixed for unauthenticated records. Authenticated cross-scope squatting remains (finding 1). |
| Independent budgets | Evidence and qualification budgets are separate, but the qualification pre-filter is still first-come and pre-authentication (finding 2). |
| Strict source membership | Fixed. Full-tuple membership in a typed, unique-keyed manifest, and subsets are allowed. |
| Caller trust boundary and result anchors | Boundary is stated clearly. Anchors are incomplete (finding 5). |
| SPKI restrictions | PEM type and length are restricted, `ed25519` is checked, and duplicate public keys are rejected. Small-order keys are a hypothesis (finding 6). |
| CI/host logical config | Fixed. Everything except os, architecture, filesystem and host identity must match. Signed records must match the exact profile. |

## Proven findings

### 1. P2: Record-ID conflicts and revocation are keyed on `record_id` alone, so any in-scope key can deny other issuers' records
`behavior-registry.ts:275-283` builds `recordIds` keyed only by `record_id`. `:244` revokes by `record_id` alone. The conflict set is built from records that pass `authenticationError` (`:236-252`), and that stage needs no valid evidence. Evidence is only checked later, in `evidenceError` at `:286`.

- **Reproducer (fixture):**
  1. Clone `records[0]`, the CI-level record, and set `payload.record_id = "record-2"`, which is the journey record's ID.
  2. Re-sign with `keys[0]`, the CI key.
  3. Set `evidence_bundle_sha256` to any digest.
  4. Append the record.
  5. Both it and the legitimate `record-2` become `qualification_id_conflict`, and the entry loses its chain.
- **Impact:** the CI key, usually the most exposed, or a key scoped to only FM-01, can disable host or journey qualifications and other capabilities. This breaks the role, capability and level scoping the trust store is meant to enforce, though only as a fail-closed denial. Revocation by bare ID also lets an unrelated record's ID collide with a revoked one.
- **Fix:** scope uniqueness to `(signer_key_id, record_id)`, or `(capability_id, level, record_id)` at minimum. Make revocation by record digest, or by `signer_key_id:record_id`. Add a test where a lower-role key reuses a higher-role record's ID.

### 2. P2: Unauthenticated qualification padding still denies service, before any authentication
- **Count cap:** `:157` rejects the whole evaluation with `invalid_context` when `qualificationBytes.length > 256`. Padding the input with 257 tiny junk documents therefore disables every capability.
- **Byte budget:** `:225-229` takes bytes from `remainingQualificationBytes` in input order, before parsing or authentication.
  - Reproducer: prepend 64 junk documents of 1 MiB. The remaining budget is 0, every real record becomes `qualification_oversized`, and entries get `qualification_missing_or_invalid`.
  - The new test at `.test.ts:410` uses only 60 MiB of junk and small legitimate records, so it does not exercise this.
- **Impact:** any party that can add to the qualification set, with no key, can disable everything. This is worse than omission whenever the store is append-only or multi-writer.
- **Fix:** apply the count and byte caps to authenticated records, not raw input. Process documents smallest-first, and charge the budget only for documents that parse. Replace the global rejection on count with a per-document `qualification_limit_exceeded`. Alternatively, document and enforce that the host passes a pre-filtered set (by capability and signer), and say so in `docs/guides/behavior-registry-evaluator.md:94`.

### 3. P3: Chain selection depends on input order and over-reports qualification
- At `:320-326` the first journey record found in `verified` Map order that yields a chain wins. With two valid chains, `validUntilMs` depends on byte order and may be shorter than the best chain.
- `qualificationSha256s` stays populated on entries that are ineligible for source, dependency or policy reasons. A consumer that checks `length > 0` would misread them as qualified.
- **Fix:** choose deterministically, for example the latest `validUntilMs` with a digest tie-break. Return an empty list when the entry is ineligible, or add an explicit flag.

### 4. P3: The reentrancy test still cannot detect late clock reads
Every `readArtifact` call happens after the authentication loop (`:277-283`) has finished all time decisions. Both halves of `.test.ts:385-403` therefore pass even if `nowMs` were re-read late in authentication. The expired-record half is now hit by source reads, but those come after the decision it claims to protect. This is the round-2 P3 only partly fixed. Also missing: tests for findings 1 and 2, and for small-order keys.

### 5. P3: Result anchors are incomplete
`context` (`:195-197`) omits:
- the registry version,
- a digest of the revocation snapshot,
- a digest of the trust key set, and
- the `minimumRevocationEpoch` and window limits used.

Two revocation documents at the same epoch with different contents are indistinguishable. A host cannot ratchet `(epoch, digest)` to detect that fork. Entries also omit `contract_sha256`. **Fix:** add `registryVersion`, `revocationSnapshotSha256`, `trustSha256` and the limits to `context`.

### 6. P3: Documentation and claim accuracy
- **Count cap:** `docs/guides/behavior-registry-evaluator.md:94` says "256 documents". The code rejects the whole evaluation above that, not just the excess.
- **Duplicate-ID claim:** the claim at `docs/guides/behavior-registry-evaluator.md:28-29` ("An unauthenticated duplicate cannot invalidate a valid chain") is true but narrower than it reads, given finding 1.
- **Evidence:** "evidence bundles and artifacts" are checked for digest and availability only. Artifact bytes are never parsed. The bundle carries no capability, level or profile binding, so evidence can be shared across records and trust rests entirely on the signer. The docs should say this.

## Hypotheses needing missing context

- **H1: small-order Ed25519 keys.** `:146` and `:166-171` accept any well-formed SPKI Ed25519 key, including small-order points. Under a cofactorless check, an identity-point key may verify a trivial signature for any message. Whether it does depends on the Node and OpenSSL build. It is a host-config issue, but the evaluator should reject the small-order encodings.
- **H2: revocation list caps.** The 4,096 / 16,384 caps (`:150-151`) are a hard `revocation_unavailable`. If lists are cumulative and IDs never pruned, a long-lived deployment eventually bricks evaluation. R05 needs a pruning rule, for example dropping IDs older than the 31-day lifetime cap.
- **H3: record `revocation_epoch` lower bound.** It is only checked as `<= current` (`:245`). If R05 ever issues delta revocation documents, the missing lower-bound semantics could matter.
- **H4: schema generation.** Zod is narrower than `qualification-contract.schema.json` (signature regex, `prerequisite_record_sha256` max 1, UTC-Z timestamps). That is acceptable as a stated subset. I could not check whether `generate.ts` or `schemas/` need entries for the new types.
- **H5: domain separation.** The signed bytes are `canonical(payload)` with no prefix. The docs disclose this and defer to a dedicated key purpose. This is an R05/V06 concern.

## Explicit limitations

- Operations-root signature verification, persisted epoch floors, trusted clock, build pins, key custody and host authentication are out of scope. The evaluator cannot prove them, and it states so accurately.
- A record is checked for consistency with the supplied pins. Nothing proves a Git URL and commit contain the claimed source bytes, and the record's `target_code_sha256` is not tied to real build output.
- I did not verify TypeScript compilation, the Zod version behavior, CI or daemon non-activation beyond what the diff shows. Performance and peak memory were not measured.

AUDIT_COMPLETE

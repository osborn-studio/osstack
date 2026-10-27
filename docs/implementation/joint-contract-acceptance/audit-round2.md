# JP-01c round 2: PASS (bounded component regression only, no gate claim)

This is a static read of the pasted material. I ran nothing, so I can't confirm the SHA pin, the unfiltered run, or the raw logs. I found no defect where a wrong product result would pass, or a correct one fail.

## Round 1 closure

| Item | Status |
|---|---|
| Component hashes not frozen | Closed. All 32 rows carry `canonical_sha256`, checked independently by Python and TS. A corrupted sample, helper expectation or wire hash makes Python exit with `FAIL:` even under `-O`. |
| Applicability prose over-claimed | Closed. The text now says "not covered" for everything except binding/proposal/recipe. |
| Optional and conditional fields | Closed. MISSING_BASELINE, MISSING_CANDIDATE_BINDING (each of its 4 fields individually), TRIAL_PERMIT_MODE_MISMATCH and EFFECT_IDENTITY_MISSING are killed by the matrix. |
| Locale vs UTF-8/UTF-16 order | Closed. B/a/a1/a_b separate ASCII from locale order. U+FF5E vs U+1F600 separates UTF-8 from UTF-16 order. The frozen inputs are unsorted, and the reversal test is non-coincidental. |
| Mutation breadth | Closed. There are 20 mutants plus a control. Pass and fail counts sum to 535 in every record, and the failed-test lists match their counts. `remove-strict-shapes` kills exactly the 11 `joint-shapes.ts` kinds, and `loose-schema-version` kills the 9 version-1 shapes (the two version-2 kinds survive, see R5). |
| BOM mutant | Agreed it is equivalent. Without the explicit check, `ignoreBOM:true` leaves U+FEFF in the text, and `parseJointJson` rejects it. |

## Coverage I checked

- **Domains:** 18 helper domains plus 2 J02-only domains make 20. The wire loop hashes every case under all 20, and the fixture, TS registry and Python registry are triangulated.
- **Fixture counts:** I counted 63 wire cases and 18 helpers by hand, and both match.
- **Python vs TS parsing:** I found no divergence for number grammar, `-0`, safe-integer limits, duplicate keys (including decoded ones), surrogates, ASCII keys, depth counting, whitespace, or `JSON.stringify` vs `json.dumps` escaping.
- **Helper projections:** Python's `project()` matches the TS sort and omit rules and the catalog's array rules. The role-sort reversal test is the one that proves sorting, since the frozen input is already sorted.
- **Identity and role joins:** 8 identity substitutions and 6 role substitutions are each killed by `skip-binding-identity` and `skip-role-binding`. The remaining 18 matrix labels honestly say "not covered".

## Non-blocking residuals

Each is cheap, and none is a reason to withhold PASS.

- **R1. Most malformed-byte cases don't discriminate.**
  - Only 3 of the 11 byte cases kill `fatal:false`, as the mutation record shows: `overlong-utf8`, `utf8-surrogate` and `utf8-truncated`.
  - Others still reject without fatal decoding, because U+FFFD is rejected anyway when unterminated, outside a string, or in a key. That covers `utf8-eof`, `utf8-out-of-range`, `utf8-overlong-three`, `utf8-lone-continuation`, `utf8-ff`, `utf16-bom`, `utf8-outside-string` and `utf8-inside-key`.
  - They still serve as cross-implementation agreement vectors.
  - To make them discriminating, wrap the bad bytes in quotes with a closing quote, for example `22 f4908080 22`, `22 e08080 22`, `22 80 22`, `22 ff 22`, `22 fffe 22`.
  - Raw bytes are fed to `decodeJointContractBytesAs`, which is good.
- **R2. The `resource_ledger_ref` absent-optional test is vacuous.**
  - The sample never contains the key, so deleting it is a no-op.
  - Presence of the field is never tested. Cleanup-phase MISSING_RESOURCE_LEDGER, intent/cleanup UNEXPECTED_CANDIDATE and ARTIFACT_PHASE_MISMATCH are also untested.
  - "Ten fields tested" is really nine meaningful ones.
- **R3. Inherited digest constants have no Python verification.**
  - The builder and verifier role digests (`a182…`, `aa2b…`) and the effect `subject_digest` (`54fe…`) are checked only by TS Zod.
  - Python already has `digest()`, so it could recompute them from `required_artifacts_digest` and the subject in a few lines.
  - The provenance note is honest, but "independent" is weaker for these constants.
- **R4. Applicability strings are fixture labels, not evidence.**
  - The test asserts them against a hard-coded kind list.
  - `recovery_receipt` and `recovery_proof` say "not covered", yet `joint-admission.test.ts` does join them in `verifyRecoveryProofEnvelopes`. That under-claims.
  - "Covered" for `method_binding` means 4 binding fields and 4 proposal fields. `contract_digest`, `context_config_digest` and `authorization_ref` are not joined.
- **R5. Mutation gaps.**
  - Not mutated: canonical key sort, the `bindingDigest` role sort, source-sort removal, sorting of declared-order arrays, and null/absent collapse.
  - Version-adjacent confusion survives: a `support_profile` or `context_receipt` mutant accepting version 1, or a version-1 kind accepting 2. The probes only use -1, 0, 999 and '1'.
  - The records hold mutated-source hashes but no diff. The control is the filtered run (535 of 547, so 12 skipped), and no unfiltered full-suite result is in the pasted records.
  - The 0.9 s cycle per run is plausible, but keep the raw logs.
- **R6. Weak classification.**
  - Field deletion, unknown field and bad version assert only `ZodError`, not the field path or code.
  - The `-O` corruption controls match any `FAIL:`.
- **R7. The 32-kind list comes from the published schema, not the live Zod union.** The disposition already says so.
- **R8. Intra-record semantic rules are outside the matrix.**
  - Examples: INVALID_REVIEW_REQUIREMENT (the role rule closest to JA70), INVALID_PRIMARY_CHECK, INVALID_TRIAL_TTL, METHOD_EXCEEDS_PROMPT, the support-profile rules, and the oracle/gate independence rules.
  - Nested strictness and the other `oracle_lifecycle` variants are also untested.
  - This matches the stated scope, so it is a coverage note only.
- **R9. Python has no 1 MiB output cap.**
  - Canonical output can't exceed wire input, so wire-derived values are safe.
  - The TS canonical size cap and the 64-depth output cap are untested, and `boundary_cases.max_depth` is unused.
- **R10. Wording.**
  - Older test titles still say "independent". "Frozen" is accurate only with the v3 caveat: the artifact-requirements fixture was revised after a candidate test failure, which is disclosed.
  - The `JA59`/`JA70` describe names could be mistaken for gate evidence by tooling. The header comment mitigates this.

## Product observations (report only)

- `ArtifactShape.producer_role` is a free string, and the sample accepts an `independent_review` artifact with `producer_role: 'fixture-ref'`. Nothing in these files binds artifact kind or role to requirements.
- `trialBudgetIssues` always returns `adapter_invocations_unattested`, so the existing test pins permanent fail-closed behavior.
- `verifyBindingAgainst` is one-directional, but the shape forces exactly 3 unique roles, so that is not exploitable. The new tests confirm all three malformed role forms.

## Remaining formal gate requirements (not defects)

- Authenticated, distinct oracle author, custodian and reviewer principals, plus a second reviewer for safety-critical cases.
- A host-recorded freeze before `candidate_created_at_ms` and a pinned oracle digest, with JA59/JA70 assignment state filled in.
- Ordered boundary traces, original logs and evidence hashes bound to the exact candidate.
- A nested union-variant matrix and an expected-error classification matrix.
- J01 gate integration, and any host or runtime qualification.
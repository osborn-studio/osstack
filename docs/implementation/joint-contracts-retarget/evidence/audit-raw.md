BEGIN_AUDIT

**Target:** PR #273 (J01b) on main with #272, #280, #275 and #277 merged.
**Verdict: REVISE.** There are no P0 findings. Two P1 issues let the contract accept values that look verified but are not. Both can be fixed locally in `packages/protocol`, without any runtime work.
**Method:** static reading of the supplied sources only. I ran no tests, builds, Python or schema generation. Fixture JSON files were not supplied.

## What held up under challenge

- **Raw JSON parser:**
  - Duplicate keys are checked on decoded names, so `"a"` and `"\u0061"` collide.
  - `-0`, floats, exponents, leading zeros, trailing commas and non-ASCII keys are rejected.
  - Lone surrogates are rejected, and depth is capped at 64.
  - `__proto__` stays data: `Object.create(null)` plus `Object.hasOwn` leaves the prototype untouched.
  - Bytes are decoded with a fatal UTF-8 decoder, and a BOM is rejected before parsing.
- **Canonicalizer:**
  - Proxy-free exotic values are fail-closed: accessors, symbols, holes and cycles all throw.
  - Output is bounded by a byte counter, so shared-DAG expansion cannot blow up.
  - Values come from a descriptor snapshot, not a live re-read.
  - Key order matches Python only because keys are ASCII-only; the code relies on that.
- **Mutation:** `bindingDigest`, `sourceSnapshotDigest` and `checkRegistryDigest` sort zod-cloned copies, not caller input.
- **Digest domains:** the registry is closed and tied to `digest-catalog.json` by a test.
- **Phase and decision matrix:** the receipt rules match the §1 table for all four decisions. This covers the reserved+resolution rule, broker-only-with-`broker_unknown`, and `home_id == target_home_id`.

## P1 — blocking

**P1-1. Digests declared inside an object are never verified on acceptance.**
- Path: `method-binding.ts` (`MethodRecipe`, `MethodBinding`, `roleRequirementsDigest`), `joint-shapes.ts`.
- CO05's central invariant is that `role_required_artifacts_digest = H({schema_version:1, role, requirements_digest})` is derived from the recipe-level `required_artifacts_digest`. No schema or exported verifier checks this.
  - A recipe has `required_artifacts_digest = A`.
  - Its three `role_required_artifacts_digest` values are arbitrary hex, or builder and reviewer are swapped.
  - `JointContract.safeParse` accepts it.
  - The existing test only shows that `roleRequirementsDigest` differs by role.
- The same gap exists for `MethodBinding.binding_digest`:
  - A valid fixture with `binding_digest` replaced by `'f'*64` still decodes.
  - The test asserts `bindingDigest` ignores that field.
  - Nothing exported compares it, yet `TrialPermit.binding_digest` and artifacts pin to it.
- Minimal correction:
  - In `MethodRecipe.superRefine`, require each role's digest to equal `roleRequirementsDigest(role, v.required_artifacts_digest)`.
  - Export `verifyMethodBinding(input)`, which recomputes from `MethodBindingShape` to avoid recursion through `MethodBinding`, and throws on mismatch.
  - Add negative tests for a swapped role, a wrong self digest, and a recipe with the wrong aggregate.

**P1-2. A recovery proof is bound to the effect ID only, so it can be replayed across attempts, generations and phases.**
- Path: `joint-shapes.ts` (`proofs` element), `joint-recovery.ts` (`RecoveryProofEnvelope`, `RecoveryReceipt`).
- A proof carries `record_ref`, `type`, `evidence_digest`, `producer_ref`, `effect_id`, `subject_digest` and an optional `broker_identity`. `subject_digest` hashes only `{kind, home_id, effect_id}`.
- The receipt's decision identity is `binding_generation`, `support_profile_digest`, `owner_generation`, `prior_phase`, `schema_spec_digest` and `recovery_build_digest`. None of these appears in the proof or the envelope, except `owner_generation` for brokers. So the trusted record cannot be compared with the receipt even by a later runtime.
- Counterexample:
  - Receipt R1 uses `binding_generation:3` with proof P (`invocation_contained`, effect E).
  - A later receipt R2 uses `binding_generation:5`, a different `support_profile_digest` and a different `owner_generation`, with the same embedded P.
  - R2 passes `RecoveryReceipt.safeParse`.
  - The "mismatched subject" test only varies `subject_digest` and `effect_id`.
- §1 requires `proven_stopped` evidence to include source instance and generation, cancel request, workspace and containment domain. The contract has only the opaque `evidence_digest` for these.
- Minimal correction:
  - Add `owner_generation`, `binding_generation|null`, `support_profile_digest|null` and `prior_phase` to the proof, and require exact equality with the receipt.
  - Add `containment_domain` and `source_generation` for `invocation_contained`.
  - Have the envelope check the same equalities.
  - If this PR will not add fields, drop the claim of evidence-subject binding and say that `evidence_digest` carries it.

## P2 — fix before relying on the contracts

**P2-1. `effect` subject with `legacy_unknown` is accepted and forces fabricated identity.**
- Path: `joint-recovery.ts` (`EFFECT_IDENTITY_MISSING`), `joint-foundation.test.ts` (the `it.each` over phases).
- §1 says legacy holds lack a verifiable invocation and "cannot fabricate binding or profile". Yet an effect-kind receipt with `prior_phase:'legacy_unknown'` and `preserve_unknown` is accepted only if `binding_generation` and `support_profile_digest` are non-null, and `null` is rejected.
- The test asserts this combination as allowed.
- Correction: reject `effect + legacy_unknown`. Require `legacy_unknown` to use null binding and profile on an `attention_action` subject.

**P2-2. A receipt does not carry the request-input digest.**
- Path: `joint-shapes.ts` (`RecoveryReceiptShape`), `joint-recovery.ts` (`recoveryRequestInputDigest`).
- The receipt has `request_id` and `operator_ref` but no `request_input_digest`.
- Two receipts with the same `request_id`, scope and tenant but different decisions both parse. The receipt alone cannot show that the same input was replayed or that a conflict was raised.
- Correction: add `request_input_digest` to the receipt, and let the runtime unique-key it on `(scope, tenant, request_id)`.

**P2-3. A passed `GateEvidence` is not bound to a gate-specific oracle, and its timestamps are self-asserted.**
- Path: `joint-lifecycle.ts` (`GateEvidence`, `OracleLifecycle`).
- Gate `JA52` with an unrelated executed oracle `trivial` and the same candidate and profile is accepted.
- `gate_id` is not linked to `oracle_id` or to a gate-definition digest.
- `evidence_refs` and `freeze_record_ref` are mutable string refs, not digests.
- The submitter chooses `frozen_at_ms` and `candidate_created_at_ms`, so "frozen before candidate" is trivially satisfied.
- `revision` has no predecessor digest, so assigned→frozen→executed continuity is unrepresentable.
- `GateEvidence` carries no `target_code_sha256`, unlike R01 `BehaviorEvidenceV1` (`subject_sha256`) and R01 qualification payloads.
- Correction: add `expected_oracle_id`, `oracle_record_digest`, `prior_record_digest` and `target_code_sha256`. Pin evidence refs by digest.

**P2-4. `trialBudgetIssues` does not bind the permit to the profile.**
- Path: `method-binding.ts`.
- It never checks `supportProfileDigest(profile) === permit.support_profile_digest`, nor `repository === canonical_repo`. It returns `[]` for the wrong profile if that profile is enforceable.
- §3 requires `max_adapter_invocations` to be enforceable, but `budget_enforceability` has no invocations axis, so that cap is unchecked.
- Correction: add digest and repo equality as issues. Add an `adapter_invocations` axis, or document that it is covered by `actions`.

**P2-5. Source and identifier rules are weaker than the merged R01 rules.**
- Path: `joint-shapes.ts` (`SourcePinShape`), `joint-primitives.ts` (`portableGitPath`, `Ref`).
- R01 `BehaviorSourceV1` requires a canonical https repository URL with no credentials, query or fragment. It also requires a 40-hex commit, NFC text with no control or format characters, and `Path` that rejects `:`.
- Joint accepts all of the following:
  - `repository:'https://u:pw@host/x'` or a local path.
  - A 64-hex commit.
  - A file path such as `.git::$INDEX_ALLOCATION/hooks/x`, because only `^[A-Za-z]:` is rejected.
  - Names like `.git.` or `.git ` (trailing dot or space), and Unicode format characters in refs.
- A `SourcePin` therefore cannot be mapped losslessly into a `BehaviorSource`, and credentials can enter digests.
- Correction: reuse the R01 URL and `Path` rules. Reject `:`, trailing dot or space, and format characters. State explicitly if 64-hex commits are intended.

**P2-6. Several digest fields have no defined domain or verifier, and material bodies have no subject-bound envelope.**
- Path: `joint-shapes.ts`, `joint-json.ts`, `method-binding.ts` (`ArtifactRequirements`), `method-materials.ts`.
- These fields are bare 64-hex strings with no catalog domain: `body_schema_digest`, `verifier_policy_digest`, `contract_digest`, `candidate_method_digest` and `context_config_digest`.
- `body_schema_digest` can name any digest for any `artifact_ref_kind`.
- `ArtifactRequirements` allows `material:*` kinds, but `MethodArtifact.artifact_kind` has only the five legacy kinds, and material bodies carry no `binding_digest`, run or effect. A material requirement can never be satisfied by a bound artifact in this contract set.
- Correction: register domains for the body-schema digests and bind them to the ten generated schemas. Add a material wrapper with `binding_digest`, `run_id`, `effect_id` and `content_sha256`, or document those digests as later-stage definitions.

**P2-7. `ContextReceipt` has no sequence or replay anchor.**
- Path: `joint-shapes.ts`.
- The `prepared` and `adapter_observed` phases are not linked. There is no `effect_id`, attempt or `prepared_receipt_digest`.
- Counterexample: an `adapter_observed` receipt with no preceding prepared receipt parses, and the same receipt is indistinguishable across attempts.
- It also lacks `support_profile_digest`.
- Correction: add effect and attempt identity, plus `prepared_receipt_digest`, required when the phase is `adapter_observed`.

**P2-8. Union decode and the opt-in packaging claim are untested.**
- Path: `joint-contracts.ts`, `package.json`, `joint-generate.ts`.
- `decodeJointContract` accepts any of 23 kinds, including trusted records (`TrialPermit`, `RecoveryReceipt`, `GateEvidence`). `MethodArtifact.identity_assurance:'host_authenticated'` is self-asserted on the wire.
- Per-kind typed decoders are missing, so a request endpoint can accept a trusted record type by mistake.
- No visible test confirms that the protocol root does not load joint modules. `src/index.ts` is not in the diff.
- The `./*` export exposes `dist/joint-generate.js`, which imports the devDependency `zod-to-json-schema`, so that import fails for consumers.
- Correction:
  - Add `decodeJointContractAs(kind, raw)` and `decodeJointContractBytesAs(kind, raw)`.
  - Add a test that `dist/index.js` has no joint imports.
  - Do not ship `joint-generate`, or move `zod-to-json-schema` out of devDependencies.

## P3

- Shapes use bare `z.string()` where `Ref` exists:
  - Subject IDs, `permit_id` and `operator_ref` accept newlines, NUL and surrounding spaces.
  - `trialRootEffectId` requires `Ref` for `permit_id`, so a schema-valid permit may be underivable and throws a ZodError instead of `TRIAL_ROOT_ID_MISMATCH`.
- Direct `Schema.safeParse` accepts `-0`, lone surrogates and a MethodMaterial over 1 MiB (128 × 10,000-char goals). Digesting later throws. Only the raw decoder path is strict.
- Principal comparisons in `OracleLifecycle` are exact-string. The alias comment is on `GateEvidence` only, and `Ref` does not require NFC.
- §7 says the `frozen` state carries `candidate_created_at_ms`. The code puts it only in `executed`. The code looks sounder; reconcile the spec.
- `TrialPermit` requires `max_wall_ms ≤ TTL`, which conflates the consumption window with run duration and is not in the spec.
- A Proxy array whose `length` trap changes could truncate the canonical output. This is minor for host-owned inputs.
- A measured-qualified `SupportProfile` with `start_identity:'unqualified'` is accepted; activation blocking is runtime-only.
- `generate-joint-schemas.mjs --check` reads `dist`, so a stale build passes, and it does not detect extra files. The vitest test covers this from source.
- Tests parse `contracts.json` with plain `JSON.parse`. A duplicate key or `-0` in a fixture would be invisible.
- The suite hard-depends on `python3`, with a 10-second timeout.
- `jointDigest` is exported and hashes any value under a registered domain without schema validation.

## Test gaps (visible tests)

Nothing visible covers:
- `prior_resolution:'abandoned_unknown'` with `reserved`
- `attention_action` phase variants
- `home_id != target_home_id`
- the `MethodRecipe`, `SupportProfile`, `TrialPermit` TTL, `MethodArtifact` and `ContextReceipt` refinements
- `decodeJointContractBytes` end to end
- the union's behavior for mixed or ambiguous kinds
- package `exports` resolution

## Scope limitations

- Not supplied or not reviewed: `contracts.json`, `digest-vectors.json`, `reference-vectors.json`, `digest-catalog.json`, `src/index.ts`, `tsconfig`, `prepare-npm-package.mjs`, #272/#275/#277/#280 sources beyond the pasted `behavior-capability.ts`, and the J11 recovery files.
- The diff against the original J01b patch was not independently confirmed; I relied on the host statement.
- Out of scope per your brief, and not flagged: proof loading, current DB state, authentication, CAS, recovery runtime, config byte budgets (§5) and the registration files.
- Findings are static. Fixture-dependent claims, such as whether the schema fixtures already carry correct self digests, are unverified.

END_AUDIT
BEGIN_AUDIT

**Verdict: PASS.** I found no P0 or P1 within the stated structural scope. There is one P2 robustness defect and four P3 items, none of which lets an invalid contract be accepted. This is a static read of the supplied source. I executed nothing, and I make no claim about test results.

## Verified by reading

- **Envelope mutations.** `verifyRecoveryProofEnvelopes` reparses the receipt and the envelopes, and the envelope count and unique `record_ref`s must match the receipt's proofs. It compares the proof by canonical JSON and the subject by digest. It then compares all six context fields (`owner_generation`, `binding_generation`, `support_profile_digest`, `prior_phase`, `schema_spec_digest`, `recovery_build_digest`) by strict equality. Each failure maps to a distinct error: `PROOF_REFERENCE_MISMATCH`, `PROOF_CONTENT_MISMATCH`, `PROOF_CONTEXT_MISMATCH`, `PROOF_AFTER_RECEIPT`. `null` compares equal to `null` correctly, so the legacy attention path works.
- **Valid mismatched subject.** The test builds an envelope whose proof digest is consistent with a different subject. The envelope parses, and the join fails with `PROOF_CONTENT_MISMATCH` on the receipt's `subject_digest`. This holds up.
- **Fail-closed invocation cap.** `trialBudgetIssues` seeds `adapter_invocations_unattested` unconditionally. No input can clear it, and the README states this accurately. The `actions` axis is never accepted as a stand-in for invocations.
- **Binding, proposal and recipe join.**
  - `MethodRecipe` recomputes the per-role digests from the aggregate.
  - `verifyMethodBinding` recomputes the self digest.
  - `verifyBindingAgainst` checks task, proposal digest, recipe digest, version, snapshot and required-artifacts digest.
  - It checks each role's text hash and role digest against the recipe.
  - A role swap with a freshly recomputed binding digest is rejected, so the join is not self-satisfying.
- **Packaging.** `files` carries `!dist/joint-generate.*`. The explicit `null` exports for the generator take precedence over the `./*` pattern. The generator script imports it by relative path. The root `index.ts` has no joint imports.
- **Digest and schema parity.** The 18 entries in `JOINT_DIGEST_DOMAINS` match the 18 catalog domains. The catalog keys match the code for the domains I compared: binding, proposal, input, environment, scenario, intent, schema-spec and role-artifact. The trial-root derivation matches CO03, and the role digest input matches CO05.
- **Mutation and prototype boundaries.** The parser builds objects with `Object.create(null)` and rejects duplicate keys after decoding. `__proto__` survives as data, and Zod strict mode rejects it on contract objects. The digest helpers sort only Zod-produced copies, not caller input.

## Findings

**P2-1: `safeParse` throws instead of returning failure for a dirty nested subject.**
- **Path:** `joint-recovery.ts`, `RecoveryReceipt` and `RecoveryProofEnvelope` `superRefine`, which call `recoverySubjectDigest(v.subject)` (an internal `RecoverySubject.parse`).
- **Cause:** Zod v3 runs refinements on "dirty" values. Violations of `min`, `max` or regex mark a value dirty, not aborted. The inner `.parse` then throws a `ZodError` out of the refinement.
- **Reproduction:** `RecoveryReceipt.safeParse({...validRecoveryReceipt, subject:{kind:'effect', home_id:'', effect_id:'x'}})` throws. It should return `{success:false}`. `JointContract.safeParse(sameObject)` throws too, because the union runs that option.
- **Impact:** This is fail-closed, since nothing is accepted and `decodeJointContract` already rejects via `parse`. But a caller that relies on `safeParse` without try/catch crashes on hostile input. `MethodRecipe` already guards the same hazard with `Digest.safeParse`, so the pattern is known in this PR.
- **Minimal fix:** In both refinements, use `RecoverySubject.safeParse(v.subject)` and `issue(ctx,'INVALID_SUBJECT')` on failure, or skip the digest check when it fails. Add a test that `safeParse` with `home_id:''` returns `success:false` and does not throw.

**P3-1: One test passes for the wrong reason.**
- **Path:** `joint-foundation.test.ts`, `'pins effect, legacy and broker identity rejection…'`.
- **Problem:** The final loop reuses `proof`, which carries `broker_identity`. The effect and attention receipts therefore fail with `UNEXPECTED_BROKER_PROOF`, not with the reason the loop implies. If that check regressed, the test would keep passing.
- **Fix:** Build the proof without `broker_identity`. Assert that attention + `dispatch_committed` + `proven_stopped` is accepted, as CO01 allows, and that the effect-with-null-generation cases are rejected.

**P3-2: `Ref` and paths are weaker than the merged R01 text and path rules.**
- **Path:** `joint-primitives.ts`.
- **Problem:** `Ref` rejects only code points below 32 and 127. It allows C1 controls, format characters (for example U+200B and U+202E) and non-NFC text. R01's `text()` rejects all of these. `Ref` feeds principal independence in `OracleLifecycle`, so `"alice"` and `"alice\u200b"` count as distinct principals at the parser layer. `portableGitPath` also allows `:`, which R01's `Path` rejects, so NTFS stream names like `x:stream` can appear in a snapshot.
- **Mitigation:** The README already makes the host registry authoritative. Reusing R01's NFC, `\p{Cf}` and `\p{Cc}` rules, and rejecting `:`, is cheap and closes the gap earlier.

**P3-3: Trial admission has no join helper.**
- **Problem:** No exported function ties `binding.trial_permit_id`, `binding_digest`, `contract_digest` and `support_profile_digest` to the permit and profile. `trialBudgetIssues` and `trialConsumptionInputDigest` do not take a binding.
- **Mitigation:** The README delegates this to the host and J08, which is coherent. A `verifyTrialAgainst(binding, permit, profile)` helper would lower the risk of J08 omitting a field. This is not required for this PR.

**P3-4: `SupportProfile` accepts incoherent combinations, and one phase combination has no test.**
- **Profile problem:** `query_by_start_identity:true` with `can_query:false` is accepted when `start_identity` is `unqualified`. `containment_domain` set with `stop_proof_level:'unavailable'` is accepted. This is only a descriptive-truthfulness gap, because activation requires host checks anyway.
- **Phase problem:** `prior_resolution:'abandoned_unknown'` combined with a non-reserved `prior_phase` is not constrained. CO01 is silent on it, and there is no negative or positive test.
- **Fix:** Either add refinements (query true requires can_query true; a domain requires a stop level other than unavailable), or document both cases as intentionally permitted.

## Scope limitations

- I did not read `reference-vectors.json` or `digest-vectors.json`, so vector content is unverified. I verified only the helpers' derivation code against the catalog.
- The independent Python reference covers six constructors, not all 18 domains, as the dispositions state.
- I cannot verify what `prepare-npm-package.mjs` does to `exports` or `files` at pack time, so I cannot confirm the generator exclusion survives packing.
- The ledger and validator are historical snapshots. They are internally consistent with the PR heads and the base-drift logic, and I did not check them against the live forge.
- Out of scope, per the brief: authentication, current-state CAS, freshness and per-invocation identity of proofs, material-body registry binding, context-receipt replay, Git `verify_path` and platform alias checks, and Windows and HFS dotgit aliasing. The README discloses all of these as host or J02b, J04, J08, J12 obligations, and I found no overclaim.

END_AUDIT
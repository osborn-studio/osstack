BEGIN_AUDIT

**Verdict: PASS.** I found no P0 or P1 and no counterexample that makes an accepted contract unsafe at its opt-in, structural-only boundary. Several P2 items should be fixed or explicitly accepted before J11/J12 consume this. I did not run any code or tests; this is a static read of the supplied source.

## Prior fixes checked against the code

- **Recipe role digests:** `MethodRecipe` recomputes each role digest from the aggregate (`method-binding.ts`). Confirmed.
- **Binding self-digest:** `verifyMethodBinding` rejects a mismatched digest. Confirmed.
- **Proof envelope context:** the join compares six context fields plus content, subject digest and one-sided chronology. The code is correct, but one test of it is vacuous (P2-1).
- **Legacy identity:** `legacy_unknown` requires an attention subject with null binding and profile. Confirmed.
- **Endpoint and packaging:** the typed decoders exist, and the generator subpath is blocked by `exports`.
- **Digest parity:** the TS and Python canonicalization match for the six helpers covered. Keys are ASCII-only, so sort order is identical, and string escaping is identical.
- **Mutation boundary:** the digest helpers sort only zod-parsed copies and do not mutate caller input. `parseJointJson` uses null-prototype objects and retains `__proto__` as data.

## P2

**P2-1. The `prior_phase` mutation test cannot fail.** `packages/protocol/src/joint-admission.test.ts`, test "joins proof envelopes…".
- **Reproduction:** the test patches the *receipt* with `{prior_phase:'reserved'}`. That receipt is `proven_stopped`, so `RecoveryReceipt.parse` rejects it with `NOT_COMMITTED` before the join runs. The bare `toThrow()` accepts any error. Delete `'prior_phase'` from the key list in `verifyRecoveryProofEnvelopes` and the suite still passes.
- **Fix:** mutate the envelope field instead of the receipt, and assert `PROOF_CONTEXT_MISMATCH` on every patch.
- **Related gap:** there is no test that an envelope carrying a different (valid) `subject` is rejected.

**P2-2. `trialBudgetIssues` returns `[]` for a permit whose invocation cap nothing attests.** `method-binding.ts`, `SupportProfileShape`.
- The closeout spec requires `max_adapter_invocations`, and a profile able to enforce it. `SupportProfile` v2 has only wall, actions, tokens and cost axes.
- **Reproduction:** take a permit with `max_adapter_invocations: 8` and a fully "enforceable" profile. The function returns `[]`, which reads as compatible although no profile field can attest the cap.
- **Fix:** add an `adapter_invocations` axis to the profile while v2 has no consumer, or always emit `adapter_invocations_unattested` until it exists. The README caveat is honest, but the API result is not.

**P2-3. There is no executable join from binding to proposal/recipe.** The README requires one; only the recipe-internal role check and the self-digest are coded.
- **Counterexample:** swap the builder and reviewer `role_required_artifacts_digest` in a binding, then recompute `bindingDigest`. `verifyMethodBinding` passes.
- **Fixture inconsistency:** `valid-method_binding` has all three role digests equal to `aaaa…`. That is not `roleRequirementsDigest(role, 'a'*64)` for its sibling `valid-method_proposal`. Fixtures are shape-only, but this shows nothing exercises the join.
- **Fix:** export a pure `verifyBindingAgainst(proposal, recipe)` and add a negative test. It should check:
  - `task_id`, `recipe_version`, `source_snapshot_digest` and `proposal_digest`;
  - per-role requirement digests;
  - `method_text_sha256` equality with the recipe.

**P2-4. Identifier canonicalization is weaker than the merged #275 `text()` rule, and it undercuts the independence check.** `joint-primitives.ts`, `Ref`.
- `Ref` rejects only trim and C0/DEL. It accepts format characters (Cf) and non-NFC text.
- **Reproduction:** `authors:['alice']` with `implementation_principals:['alice\u200b']` passes `OracleLifecycle`, because the check is an exact `includes`. An NFD/NFC variant does the same.
- **Related gap:** `joint-shapes.ts` uses bare `z.string()` for `operator_ref`, `request_id`, `task_id`, `effect_id` and subject ids. Only `RecoveryRequest` applies `Ref`. A receipt can therefore carry a `request_id` the request schema would reject, which weakens the idempotency-key match.
- **Fix:** one shared canonical identifier (NFC, no Cc/Cf, no lone surrogates) used by `Ref` and the shapes.

**P2-5. The source path gate is syntactic and passes known hostile aliases.** `portableGitPath` only rejects a segment whose lowercase equals `.git`.
- **Reproduction:** each of these passes `SourceSnapshot`. The first three are alias forms Git's own checks reject (NTFS trailing dot/space, 8.3 short name); the fourth is an HFS+-ignorable character, which matters on darwin:
  - `.git./hooks/x`
  - `.git /hooks/x`
  - `git~1/hooks/x`
  - `.g\u200cit/hooks/x`
- **Fix:** reject Cf and non-NFC characters and the Git dotgit alias variants. Otherwise state in the README that `SourceSnapshot` is syntax-only and J02b must apply Git's `verify_path` rules. The test title "rejects unsafe source trees before adoption" overstates what is covered.

## P3

1. **`safeParse` can throw instead of returning failure.** `RecoveryReceipt` and `RecoveryProofEnvelope` call `jointDigest` inside `superRefine`. A directly constructed JS string with a lone surrogate in a subject id throws `INVALID_JOINT_JSON`. Raw decoders are unaffected. Fix: catch and convert to a zod issue.
2. **A foundation test passes for the wrong reason.** The last test in `joint-foundation.test.ts` expects `proven_stopped` to fail for the effect and attention receipts. Its shared `proof` carries `broker_identity`, so the failure is `UNEXPECTED_BROKER_PROOF`, not the rule being named. Attention-subject `dispatch_committed` + `proven_stopped` is actually accepted. Decide whether that is intended and test it explicitly.
3. **Independent parity covers only 6 of 18 domains.** The Python vectors cover `bindingDigest`, `schemaSpecDigest`, trial-root, recovery-subject, recovery-request-input and trial-consumption-input. `digest-catalog.json` `exact_top_level_keys` is never checked against the schemas, because the test compares only domain names. Add key-set and vector parity for the remaining domains, or label the catalog as documentation.
4. **`SupportProfile` accepts `can_query:false` with `query_by_start_identity:true` and `start_identity:'unqualified'`.** Only the forward implication is enforced. Add the reverse implication.
5. **Packaging.** `files:["dist"]` ships `dist/joint-generate.js`, which imports the devDependency `zod-to-json-schema`. `dist/joint-generate.d.ts` and any `.map` remain reachable through `"./*"`. Fix: add `"!dist/joint-generate.*"` to `files`, or exclude it from the published build.
6. **Proof envelope binding.** The envelope is not bound to `request_id`, `if_revision`, tenant/scope, invocation or attempt, and chronology has only an upper bound (`observed_at_ms ≤ receipt`). J12 must bind these from loaded records. The README states some of this; add "no freshness lower bound" and "no per-invocation identity" explicitly.
7. **Mixed Git object formats.** `GitId` allows 40 or 64 hex independently per field. For example `candidate.base_head` can be SHA-1 while `head` and `tree` are SHA-256, and a SHA-256 pin commit can sit beside SHA-1 blobs. Require one format per object.
8. **Ledger `candidate_sha` self-reference.** The ledger records `6b822c6…` as the candidate head, but a commit containing the ledger cannot equal that hash. The validator checks only internal consistency, so it will not flag the staleness. Label the field an observation or pre-ledger head.
9. **Dependency order.** `SourceSnapshot.dependencies` is order-sensitive in the digest, while files are sorted. State that the order is part of the identity, or sort by canonical key.

## Compatibility notes (no defect)

- Joint canonical JSON and #275's RFC 8785 are separate named canonicalizers with no cross-use. The domain-prefixed digests do not collide with behavior digests.
- `SourcePin`/`SourceSnapshot` accept inputs that `BehaviorSourceV1` rejects: SHA-256 commits, ':' inside a path, non-NFC text and Cf characters. The README already requires J02b to reject unsupported mappings. This is consistent with the README, but P2-4 would narrow the gap.
- #277's receipt behavior is untouched, since joint modules are not imported from the protocol root. The root-isolation test is sound.

## Scope limitations

- I reviewed the supplied file contents only. I did not see `reference-vectors.json`, `digest-vectors.json`, the generated `schemas/joint/*`, or the unchanged files of main, so schema-artifact byte parity and the vector inputs are unverified.
- I executed nothing: no tests, no Python reference script, no pack or exports resolution. The `exports` null-entry and pattern behavior is reasoned from Node's resolution rules, not observed.
- Zod-internal behavior (omission of absent optional keys, union handling) is from my knowledge of zod 3, not verified in this tree.
- Authentication, immutable evidence loading, current DB state, CAS, replay ledgers, the exactly-once attempt association and the gate registry are runtime obligations for J04, J08, J12 and J02b. Findings above are limited to what the pure contracts can enforce or must state.
- Model severities are my judgment, not independently established.

END_AUDIT
# JP-01c review: REVISE

This is a static read of the pasted material. I ran nothing, and I can't see `joint-shapes`, `joint-recovery` or `joint-evidence`.

The slice is worth keeping. The wire, domain and helper vectors are cross-checked three ways (fixture, Python, TS). Frozen inputs are deliberately unsorted, so the expected digest proves normalization. The 32-kind enumeration, expected-kind boundary, and per-field join and role mutants are well targeted. But several claims exceed what the assertions prove, and some cheap false negatives sit on dimensions you asked about.

## Required fixes

1. **Component expectations are not frozen.**
   - `check()` derives `components[].canonical` and `sha256` at runtime from `row.sample`. The fixture holds no expected bytes or hash for the 32 kinds.
   - The TS sha256 assertion is tautological: once `canonical` matches, the hash matches by construction.
   - Repro: change `"bytes": 1` to `2` in the `artifact` sample. Every test still passes.
   - This contradicts the docstring ("Expectations are fixed inputs") and JA70's "bytes identical to expected".
   - Fix: freeze `canonical_sha256` per row and compare it in both Python and TS.

2. **The applicability text is unverified boilerplate.**
   - `identity_applicability` and `role_applicability` are identical across kinds and no test reads them.
   - They claim gate/oracle joins are "verified separately". Nothing in these four files joins `gate_evidence` to `oracle_lifecycle`.
   - They also claim `context_receipt` role digests are "checked separately". Nothing joins its `role`, `role_required_artifacts_digest`, `proposal_digest` or `binding_digest` to a binding or recipe.
   - The same gap applies to `method_input.role` and `artifact.producer_role` / `binding_digest`.
   - Either add the joins or replace the text with "not covered in this slice".
   - Rename `'JA70 full kind/field matrix'` to say top-level required fields only.

3. **The optional and conditional dimension is untested.**
   - `optional` is never read, and `required` is only checked by deletion.
   - Mutants that survive:
     - making `max_tokens`, `max_cost_microusd` or `trial_permit_id` required, since samples include them;
     - dropping `MISSING_BASELINE`, since no test removes `baseline_artifact_ref` from the candidate-phase artifact;
     - dropping `TRIAL_PERMIT_MODE_MISMATCH`, since no test removes `trial_permit_id` from a `mode:'trial'` binding or adds it to a non-trial one.
   - Add per-optional "absent is accepted" and per-conditional rejection cases.
   - Assert `keys(sample) == required ∪ optional`.

4. **JA59's named bad variant (a `localeCompare` or non-byte sort) survives.**
   - Every sorted-set fixture orders identically under `localeCompare`: `a`/`z`, `sha256:a…`/`sha256:b…`, the lowercase lineage names, and the three role names (by inspection).
   - Add `B` vs `a` and `a_b` vs `a1`, which differ between ICU and ASCII order.
   - If the path grammar allows non-ASCII, add U+FF5E vs U+1F600 to separate UTF-8 byte order from UTF-16 order.
   - About 15 domains are "preserve declared order", but their arrays have 0 or 1 elements, so a mutant that sorts them survives. Only `recipe.role_materials` is checked.

5. **The mutation controls are too narrow for the dimensions claimed.**
   - There are five mutants. None cover:
     - `fatal:true` → false;
     - the BOM check;
     - the -0, float or safe-integer checks;
     - the surrogate check;
     - the non-ASCII key check;
     - the depth cap;
     - null/absent collapse;
     - sort removal;
     - `.strict()` removal;
     - the version literal;
     - the role-digest check in `MethodRecipe`.
   - By inspection the raw-byte cases would kill `fatal:false`, but that is not evidenced.
   - The mutant directories are not tied to the candidate (no patch or hash recorded).
   - `-t JA59|JA70` skips 12 tests (the 500 passed out of 512 total). That excludes the Python `-O` corruption test and the 9 admission-integrity tests.
   - The new oracle has no negative control. Nothing shows a corrupted fixture hash makes it exit nonzero, unlike the old `--check`.
   - The runs start about 0.9s apart, which seems short for a cold vitest plus two Python spawns. This is low confidence, but keep the raw logs.

## Raw bytes and boundaries

- Only 3 malformed-byte cases exist, all inside quotes, and only through `parseJointJsonBytes`. `decodeJointContractBytesAs` is never fed malformed bytes.
- `utf8-truncated` (`22 e4 22`) is an invalid continuation byte, not truncation at end of input. Add:
  - `22 e4 b8` (EOF mid-sequence);
  - `f4 90 80 80` (above U+10FFFF);
  - `e0 80 80` (overlong 3-byte);
  - a lone `80`;
  - `ff`;
  - `ff fe`;
  - an invalid byte outside a string and inside a key.
- Missing boundaries:
  - depth 64 accepted (only 65 is rejected, so reject-at-64 goes unnoticed), plus an object-depth case;
  - input of exactly 1 MiB accepted and 1 MiB + 1 rejected;
  - `-9007199254740992`;
  - nested duplicate keys;
  - a non-ASCII key written as an escape (`"\u00e9"`);
  - `\f`, `\v` or NBSP as whitespace;
  - near-miss domains (`support-profile.v1`, different case, trailing `\n`).
- Wrong version is only tested with `-1`, and `toThrow()` is unclassified. So JA70's "expected error classification" is absent.

## Coverage claims

- "Every protocol digest constructor" is a hand-written `digestHelpers` list compared to the fixture. A new exported constructor would go unnoticed.
- `not_applicable` is never read. Nothing asserts that helper domains plus `not_applicable` equal the 20 domains.
- The counts (45 wire cases, 18 helpers, 20 domains, 32 kinds) are not asserted. Deleting a wire case passes silently.
- The 32 kinds come from the published JSON schema, not the live Zod union. `collect` also ignores `enum` and `allOf`.
- Only the reviewer role has an independent Python digest vector. The builder and verifier digests (`a182…`, `aa2b…`) and the recovery `subject_digest` (`54fe…`) are validated only by TS Zod. Their provenance should be shown, given the "no new TypeScript output sampled" claim.
- Nothing checks `oracle_sha256` against the fixture.
- A Python failure throws at module scope, so it shows up as a collection error for the whole file, not a test failure.
- The docstring and test titles say "independent". "Separate implementation, same author" matches your own scoping better.

## Product observations (report only)

- `verifyBindingAgainst` iterates only `binding.role_materials`, so the check is one-directional. A binding that omits a recipe role passes the join unless the shape forces all three roles, which I can't see. Either way no test removes, adds or duplicates a role.
- No visible verifier joins `context_receipt`, `artifact` or `method_input` to a binding or recipe.
- `trialBudgetIssues` always returns `adapter_invocations_unattested`, so a trial permit can never pass. That looks fail-closed by design.

## Remaining formal gate requirements (not defects)

- Authenticated, distinct oracle author, custodian and reviewer principals, plus a second reviewer for safety-critical cases.
- A host-recorded freeze before `candidate_created_at_ms`, and a pinned oracle digest.
- Assignment state and principals filled in for JA59 and JA70.
- Ordered boundary traces, original result logs and evidence hashes bound to the exact candidate.
- Nested union-variant matrices (recovery phases, artifact phases, material and gate states, nested strictness).
- An expected-error classification matrix.
- J01 gate integration, and any host or runtime qualification.

Revising items 1–5 is small and mechanical. After that I'd expect PASS for this bounded component-regression slice, with no gate claim.
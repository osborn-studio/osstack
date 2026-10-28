# Original Sonnet review

The following is the unchanged original review text, fenced so example links are treated as quoted evidence.

````text
# Verdict: REVISE (narrow, mostly wording and test-discrimination fixes)

This is a static read of the supplied diff and files. I ran nothing and did not verify any hash, byte count, test count (67/67) or file count (48). Those are the candidate's claims, not my observations. I also did not audit the archived native-experiment bytes.

## What holds

- **Boundaries.** Feature, refactoring, bug-fix and investigation are separated by their opening sentences and cross-linked. `osstack-help` states the "cleanup that also changes behavior → split scopes" rule. `refactoring.md` bars rewriting the pin to absorb a fix.
- **Behavior pinning.** `refactoring.md` requires a pin before structure moves. It says typecheck/lint is not a pin, and an unexercised baseline leaves equivalence unproved. It limits normalization to declared nondeterminism and treats unexplained differences as failed or unknown. This is a faithful and slightly stronger adaptation of upstream.
- **Authorization.** Both methods say method selection does not authorize shipping. The "commit liberally" and "Opening a PR" steps were dropped, so nothing grants publication. Mandatory model, arena and recursive spawning were removed, which is good for Codex/Claude portability.
- **Attribution.** `sources.md` only adds entries. Author, pinned commit, MIT note and history are preserved. The per-method source-map is additive.
- **Qualification.** The closing lines of both methods, the README and `validation.json` (`host_model_calls: 0`, `full_repository_tests_run: false`) state that these are not a runtime qualification or gate.
- **Tests.** The new tests use the real CLI against the real source tree, for both hosts. They compare byte equality and manifest hashes, and assert that the source tree is unchanged. The negative cases assert that no output directory is reserved. The RED history is honest that the negative setups failed for the wrong reason.

## Defects, in severity order

1. **EXPORT.md binds discovery evidence to the wrong bytes.**
   - The diff adds a long "Host discovery checks" section (Codex 0.160.1, Claude 2.1.291, `--restricted`, SDK `commands`) in the same file whose method list now says "six methods".
   - Nothing in that section says the experiments used the four-method materials and say nothing about `feature` or `refactoring`. Only the D2a README says so.
   - EXPORT.md is the operator-facing document. A reader could take "all four entries appeared… `Skill(osstack-help)` loaded" as covering the current bundle.
   - **Fix:** add one sentence to the section, such as "recorded against the earlier four-method material; does not cover feature/refactoring". Better, move the section out of this change, since it is outside the feature/refactoring scope.
   - I did not re-audit the section's claims. The "local loader inspection suggests…" statement in particular is unverifiable from this diff.

2. **The reachability assertion is weaker than its message.**
   - `[...seen].some(p => p.endsWith('/references/${method}.md'))` accepts any entry's copy.
   - `setup-osstack` links only to `osstack-mode`, so it "reaches" the method through the other entry's directory. The test's own comment says setup must reach it.
   - An orphaned method copy inside a given entry, or a mislabeled link such as `[feature](references/refactoring.md)`, would still pass.
   - **Fix:** assert reachability of this entry's own `references/<method>.md`, or reword the claim as "reachable from the bundle". Add a check that the link label and target agree, or accept that routing correctness is manual review.
   - Separately, the walker follows only inline links. Reference-style definitions, which the exporter supports, are not walked. This is fine today only because the prose uses inline links.

3. **The negative tests don't discriminate which file is missing.**
   - Both assert only `/link_missing_or_escape/`.
   - Removing `feature.md` breaks links in several files, and any other broken link would produce the same code. Neither test shows the failure is about the named method.
   - The two tests are otherwise identical.
   - **Fix:** assert the error text or path names the removed reference, or at least check the error payload field if one exists.

4. **The top-level router has no test pinning it.**
   - The README says "The source router also links both methods". The first retitled test checks only that the files exist and are non-empty.
   - The walk starts at entries, not at `osstack-methods-skill/SKILL.md`.
   - Dead links in the router would be caught only if the exporter validates it. An absent router row, or a stale "four methods" count in unshown text, would not be caught.
   - Nothing asserts that no stale "four methods" wording remains. The diff updates four sites, but I cannot see all of `SKILL.md` or `osstack-help`'s frontmatter (that hunk starts at line 7). Confirm that help's `description` does not enumerate methods.

5. **Refactoring caller migration lacks a default and an exit.**
   - Upstream's rule is "migrate every caller and delete the old API in the same wave". The adaptation replaces it with "remove an old API only when scope and compatibility contract permit it". That is a reasonable, documented divergence.
   - But the text never states the default when no external consumer exists, which is to delete the legacy path in the same change. It gives no exit condition for a transition plan.
   - "Do not invent a permanent dual path" has no operational test, so a temporary shim can persist. The sources.md line "upstream blanket removal becomes an explicit scoped migration decision" is not mirrored by an actual decision rule in the method.
   - **Fix:** two sentences. First, in-scope callers migrated and no external obligation means delete in the same unit. Second, a compatibility path needs a named owner, consumer list and removal condition.
   - The caller inventory also names no discovery techniques (string/config/generated/dynamic references, other repos). Upstream's "renames silently miss usages in strings, prose, back-references" survives only partly.

6. **Merge authority is implicit.**
   - "Existing task's commit or publication authority" does not say that merge is reserved to the user. A delegate with PR authority could read it as covering merge.
   - Nothing violates the constraint, but the removed upstream PR step left no replacement clause. One line in both methods (or in the shared evidence rules) would close this: "Merging remains the user's action."

7. **Feature method gaps against its own boundaries.**
   - "Deliberately changes observable behavior" covers breaking changes, but unlike refactoring, `feature.md` has no compatibility/consumer-obligation clause. Step 4 only says to update consumers of a shared primitive.
   - Step 1 lists "existing behavior to preserve" but never says to capture a baseline of it before editing. The existing-behavior check in step 4 is written after the fact.
   - The "feature vs bug fix" line depends on "an existing promise" with no rule for when the promise is undocumented. Say to cite the spec/test/doc, or ask.
   - Preparatory refactoring inside a feature is not addressed. Refactoring-first under a pin, then feature, is the common case. `osstack-mode`'s "sequence the relevant methods" covers it only generically.
   - Step 3's checkpoint is unconditional. Upstream's "n/a: reason" per dimension was lost. A single-file feature gets either ceremony or ambiguity.

8. **Portability and jargon.**
   - "An unavailable arena" in `feature.md` is an upstream term that Codex and Claude readers have no referent for. Remove it or define it.
   - `osstack-agent` points a delegate at `feature.md`, whose steps 3–4 are written for a coordinator (checkpoint, "supply the chosen data shape", review the delegate's diff). A delegate should be told it owns only its slice and takes the coordinator's design. Upstream's case for a spawn-forbidden worker is not carried over.

9. **Evidence and attribution hygiene.**
   - **Hash drift.** `source-map.json` and `validation.json` record hashes and counts for the current bytes, but no test checks `adapted_sha256`. Any later edit to the method files silently stales both. `validation.json` also binds to the baseline commit only, not to the candidate's tree or the test-file hash, so "67/67" is not tied to the reviewed bytes.
   - **Link label.** The method closing lines say "Adapted… from the pinned upstream [feature playbook](sources.md)". The label names the upstream playbook but links to the local `sources.md`. The upstream URL and author are one hop away. This is acceptable but slightly misleading.
   - **Wording.** Several phrases follow upstream closely, such as "Type check and lint are not a pin" and the ordering of steps. "Independently worded" is defensible. The MIT notice is referenced through the research lock rather than reproduced. Whether a copyright line should be carried is a licensing judgment I cannot settle here. Keep the upstream URL and author prominent in `sources.md`, and leave the legal call to the owner.

## Remaining limits (not defects, but must stay stated)

- Everything verified, if the claimed runs are accurate, is packaging, link reachability and byte identity. Nothing shows a Codex or Claude model selects the right method, follows the pin discipline, or produces a good result. The README says this honestly. Keep it.
- Discovery in a real host for the new methods is unobserved. The earlier native experiments are bound to old bytes, and EXPORT.md should say so (defect 1).
- The exporter itself is unchanged in the diff. The tests are therefore only as strong as its existing link validator. I could not see how it discovers references, so I can't rule out a method allowlist or generic walk. The RED run suggests a generic walk.
- Full-repository tests and the model audit are explicitly not claimed. Treat them as open.
- Merge, upstream author, license and history are untouched by this diff. Nothing here is a runtime or J01 claim. Both are acceptable as they stand, subject to defect 6's clarity fix.

## Minimal revision list

1. Add the old-bytes binding sentence in EXPORT.md (or drop that section from this change).
2. Make the reachability check entry-specific, or reword the claim. Make the negative tests name the missing method.
3. Add a router assertion and a stale-"four methods" check, and confirm help's frontmatter.
4. Add the default-deletion and compatibility-exit rule to `refactoring.md`.
5. Add the "merge stays with the user" line, remove "arena", and add delegate scoping to `osstack-agent` or `feature.md`.
6. Optionally add a baseline-capture step and a compatibility note to `feature.md`, and a hash-drift check for the source-map.

None of these change the overall design. With items 1–4 addressed, I would expect PASS for this scope.
````

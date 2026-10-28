# Closure review: candidate `f5e8d234…`, previous `c09912d8`

**Original verdict: REVISE.** That first verdict is preserved and stands for the original candidate. This is a static read of the supplied patch, files and pasted test output. I executed nothing and did not recompute any hash or byte count. The 68/68 result is the root's run, not my observation. Whole regression `c099` is still running and is not claimed.

**Closure verdict: PASS** for the material instructions, routing and export-test scope. No blocking defects remain. The residual items below are non-blocking.

## Disposition of the original defects

| # | Original defect | Status |
|---|---|---|
| 1 | EXPORT.md discovery evidence bound to wrong bytes | **Closed.** A binding sentence now says the observations cover the earlier four-method materials and not the feature/refactoring additions. |
| 2 | Reachability assertion weaker than its message | **Closed by reframing.** The title, comment, message and README now say "through the bundle". You accepted this as the intended four-entry bundle behavior. Reference-style links are still not walked, but the prose uses inline links only. |
| 3 | Negative tests don't discriminate the missing file | **Closed.** Both tests now require `link_missing_or_escape` and an error message ending in the removed method's path. |
| 4 | Router unpinned; help frontmatter unchecked | **Mostly closed.** The new test requires exactly one link labelled `feature` and one labelled `refactoring` in `SKILL.md` and in mode, each with the correct target. The shown help `description` does not enumerate methods. No explicit stale "four methods" scan was added (see residual 2). |
| 5 | Refactoring default and exit | **Closed.** The default is now stated: remove the old path in the same unit once in-scope callers are migrated and no external obligation remains. A temporary path needs an owner, known consumers and a removal condition. Symbol/text search and generated/dynamic references were added to the caller inventory. |
| 6 | Merge authority implicit | **Closed, and it matches your constraint.** "PR preparation authority does not imply approval or merge authority; preserve any user-reserved merge step." The clause is conditional on the actual task authority. It does not hardcode "user alone merges" into the reusable methods. |
| 7 | Feature gaps | **Closed.** Added: baseline capture, consumer/compatibility obligations, how to identify an undocumented promise, refactor-first under a pin, and a one-sentence checkpoint with "not applicable" dimensions. |
| 8 | "Arena" jargon; delegate scoping | **Closed in the methods.** `feature.md` now says "multi-model review system". `osstack-agent` states that the delegate keeps its write boundary, takes the coordinator's design and does not spawn. |
| 9 | Hash drift and evidence binding | **Partly closed.** The original source map is preserved as `initial-source-map.json`. Its blob id (`affb5810`) matches the old `source-map.json` blob in the diff, so it is byte-identical to the prior file. The current map is updated and carries explicit initial-evidence fields. The README separates the 67-test and 48-file evidence from later fixes. No automated `adapted_sha256` check was added (see residual 1). |

## Residual, non-blocking

1. **No automated hash-drift test.** The current source-map hashes were recomputed by the root, and I could not check them. A later edit to either method file would silently stale `source-map.json`. A small test that hashes the adapted files against the map would close this. It was optional in the original review.
2. **No scan for stale "four methods" wording.** Test 60 confirms the six references exist, and the visible help text is updated. I cannot see all of `SKILL.md` or the mode entry, so a leftover count in unseen prose is not excluded. The new router test's title ("map each new named intent") overstates it. It checks label/target agreement and uniqueness, not intent text.
3. **The `ca95aba1` binding is unconfirmed.** EXPORT.md now ties the discovery observations to `ca95aba1`, which is the source-map baseline. The native-discovery README is not in the diff. Confirm that those experiments ran on those exact bytes, or reword to "earlier four-method materials" without the hash.
4. **"Arena" remains in evidence docs.** Both source maps' `adaptation_choices` still say "unavailable arena". It describes the upstream design and does not affect the methods, so this is cosmetic.
5. **Slight tension in `osstack-agent`.** The new paragraph says method guidance does not permit spawning more workers. The later paragraph says further delegation uses real host tools only when authorized and available. These are compatible, since the second is conditioned on authorization from the brief, but a reader could trip on them. One clarifying clause would settle it.
6. **`validation.json` was not updated in this patch.** The README correctly labels it as initial evidence. The 68/68 run and the revised hashes are bound only in the root's record, not in a repository artifact. This is acceptable if the root record is retained.
7. **Negative-test and router-test brittleness.** Both depend on the exporter's message suffix format and on exactly one link per method in the routers. That is acceptable now. A future prose edit that adds a second link would fail the router test and need a deliberate update.

## Limits that must stay stated

- The evidence covers packaging, link reachability, byte identity and router link correctness. Nothing shows that a Codex or Claude model selects the right method or follows the pin discipline.
- Host discovery of feature/refactoring is unobserved.
- Full-repository regression `c099` and the model audit remain open and unclaimed.
- Licensing and attribution are unchanged by this patch.

With residuals 1–3 treated as optional follow-ups, I have no blocking objection.
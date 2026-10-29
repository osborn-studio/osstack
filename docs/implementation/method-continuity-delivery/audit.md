# Original audit

Scope and raw bindings are retained in the archive.

````text
# Verdict: REVISE

The scope is right. The change is shared method text, navigation and export tests, the exporter is untouched, and nothing claims runtime recovery, approval or merge. I worked from the supplied text only, with no tool use. I did not run the tests or read the upstream objects, so the 88-pass result, the source characterizations and the `fm-afk-launch.sh` line range are author-reported.

## Blockers

**B1. Inherited authority and goal are never reconciled, unlike inherited state.**
- The "Reconcile before continuing" list covers repo state, owner and write boundary, and pending effects. It has no authority or goal item.
- Criterion SC02 asks for authority to be checked before the next action.
- The method says that "current scope and a clear write owner are enough to continue", and that a changed session needs no new approval. A handoff's "user authorized X" is a claim, exactly like "PR merged". It can be stale, bound to a different head or candidate, or paraphrased.
- This is the main risk against the reserved-approval boundary.
- Fix, with no new gate: add one bullet.
  - Trace the goal and authorization to the user's words or the task record, and check that they cover the action and candidate now in view.
  - Treat an unverifiable inherited authorization as unknown. Continue only what visible instructions authorize, and list the rest as a pending user-owned decision.
  - Verified authority still needs no re-approval.
- Also change "a clear write owner" to say the owner comes from current state or the assigning coordinator, not from self-assignment out of a handoff.

**B2. The handoff record omits fields the method and acceptance require, and the README claims a capability the text lacks.**
- The README table lists "ongoing responsibility" as a retained capability from `away-quiet-supervision`. The method text has no statement of who or what will next observe or act, or what triggers it. It has no explicit "no supervisor / coverage gap" statement either (SC04).
- Only the closing disclaimer ("not a persistent supervisor") and "quiet chat ≠ relinquished" partly cover this.
- The handoff list also omits the base revision and the dirty files with their owner (SC08). Dirty state appears only in the reconcile and pause sections.
- Fix: add one handoff bullet for "next observer or trigger, or an explicit coverage gap", and add base and dirty-state/owner to the repo bullet. Otherwise, remove "ongoing responsibility" from the README row.

## Optional advice

- **Routing wording:** "bug fix for a confirmed defect" could be read as a write route during a review-only pickup. Append "within the authorized scope" to that sentence. Mode already states the rule, but this file does not.
- **Unavailable versus absent:** the README example distinguishes backend unavailable from backend absence observed, but the method text only says "unconfirmed". One sentence would help: an unreachable or errored query is unconfirmed, not absent. A dead-looking PID could be added to that sentence.
- **Pause:** "Remove only owned scratch… established" could discard material needed on resume. Prefer preserving scratch on a pause.
- **Single ledger (SC09):** the handoff note should reference the authoritative ledger or task record rather than stand in for it. Add that a merged slice or a paused state does not complete the parent.
- **Exported jargon:** "D2a", "frozen joint gate" and "joint recovery contracts" are unresolvable in an exported bundle. Reword them in `sources.md` and the method file.
- **Wording:** "safe resume point" in the root table reads as a guarantee. "Resume point and its prerequisite" is more accurate.
- **Provenance:**
  - Add `#L455-L523` to the `fm-afk-launch.sh` link so the README's line range is checkable.
  - "authored by Kun Chen" is inferred from the copyright line; state it that way.
  - The README cites hashes and receipts in a scratch area outside the repo. That is fine as labeled author evidence, but a reviewer cannot reproduce it from the PR.
- **Tests:**
  - The new tests verify real export contracts: one link per entry, the exact relative target, member hashes, a missing-reference rejection and pinned source URLs. They do not claim semantic coverage, which is honest.
  - Nothing asserts the `description` frontmatter changes, the Firstmate license link or the "Guard context" link. Those could be cheap additions, but they are not required.
  - Don't add wording-presence tests for the semantic rules.

## Checked and fine

- The 76-file count reconciles: 4 entries × (1 `SKILL.md` + 18 references).
- "Twelve" is consistent across the root, mode, help, setup, agent and README, and in the test lists.
- The test additions (+1 loop case, +2 tests) are consistent with the claimed edits.
- Pins are consistent.
- The Codex and Claude text is host-neutral.
- Explicit-pause handling, the no-replay and no-unlock rules, and the WIP-commit and blanket-staging prohibitions match SC06 and SC07.
- Historical host experiments are correctly kept apart from this new material.

If B1 and B2 are fixed, I'd expect PASS. That is a recommendation only, and PR approval and merge remain yours.
````

# Original host-report-audit

Scope and raw bindings are retained in the archive.

````text
# Audit: `host-framing/results/report-draft.md`

**Verdict: REVISE.** The draft keeps every limited criterion and makes none of the overclaims you listed. Four wording points are unsupported or imprecise against the supplied evidence, and each is a small fix. I checked the draft against the supplied files only. I did not open the raw JSONL, `raw-evidence-manifest.json` or `claude-events.json`, and I did not recount words.

## Required corrections

1. **Inventory "exactly equal" lacks a basis.**
   - The draft says each before/after inventory is "exactly equal, including file hashes, modes, lengths and directories."
   - `results.json` raw bindings show the snapshot files are not byte-identical in either host: `run-before.json` is 5640 bytes and `run-after.json` is 5641, with different SHA-256 values.
   - The 34 entries and `inventory_unchanged: true` may well match after the phase label or timestamp is excluded, but the draft doesn't say so.
   - Fix: state that equality is over the 34-entry set (path, type, mode, length, hash) and that the raw snapshot files differ by one byte, with the reason if known.

2. **Claude model-identity source is misstated.**
   - The draft says `claude-sonnet-5-5` is reported "in assistant messages and result `modelUsage`."
   - The supplied evidence supports init-reported plus result `modelUsage` (`results.json` identity block). `observations.json` lists only `actual_model`.
   - Nothing supplied shows it in assistant messages.
   - Fix: say "init event and result `modelUsage`", or cite the event that shows it in assistant messages.

3. **Several claims can't be checked from the packet.**
   - These are the "base-directory header added" claim for the Skill body, the one-based line numbers and line hashes in `raw-evidence-manifest.json`, and the `claude-events.json` index contents.
   - The supplied `observations.json` and `results.json` support only "body exact; frontmatter excluded."
   - They are not necessarily wrong. Either cite where they are verified or drop them.

4. **Claude HF06 is softer than the recorded grade.**
   - The draft says HF06 "should not receive an unconditional pass."
   - The grade is `limited_comparison_artifact_ambiguity`.
   - Fix: state that HF06 is limited. Do the same for HF01 (`limited_future_deliverable_narrowed`), which the draft currently only "flags for review."

## Checked and consistent

- **Codex reads and attribution:**
  - Two `cat` events (4 and 6), both exit 0, with aggregate bytes of 7352 and 22069 matching exactly.
  - All eight required paths covered.
  - "No native skill invocation was available" is correctly called unsupported, matching the HF08 limit.
  - No native discovery success is claimed.
- **Codex model and final message:**
  - The model is requested only and `not_attested`, matching the grade.
  - Messages at events 2 and 7 are both retained, with 30 + 311 = 341 words and no channel tag.
  - The draft keeps `final_ambiguous:true` visible.
- **Claude native event:** Skill call at event 3, result at 4, body at 5. Seven Reads with paired results at events 9, 10, 12, 14, 16, 18 and 20, all byte-matched.
- **Claude output and turns:**
  - Event 24 equals result 25 at 439 words, under the 500 cap.
  - The 250–350 target is exceeded and reported rather than turned into a hard fail.
  - `num_turns:10` is correctly described as internal tool-cycle accounting.
- **Budget and timing:** one user turn each, no retries, exit 0, and elapsed times of 30.67 s and 18.84 s match the runner timestamps.
- **Claude findings:** the "same built artifacts" defect, the proposal-versus-change scope drift and the "own-machine timings" overstatement all match L1, L2 and L3 and are not reinterpreted.
- **Scope limits:**
  - It claims no OS read isolation, no descendant cleanup, no global no-side-effects and no credential handling beyond "not read or copied by this process."
  - It does not treat the audit as a host PASS or J/runtime qualification.
  - It states the single-entry bounded subset and the known-absent `osstack-agent` sibling link.

## Optional, not blocking

- The draft says "Codex requested `gpt-6.1-sol`" and separately that the metadata default is not execution identity. That is correct. Consider one sentence noting the preflight listed it as the unique default.
- `inputs/index.json` hashes differ between hosts (`e29e87ef…` for Codex, `2ddd428b…` for Claude), as do the `SKILL.md` representations. This probably reflects host-specific paths, but the draft doesn't say "same material" and never explains the difference. A one-line note would pre-empt an HF10 question.
- Codex's `/bin/zsh -lc` login shell is already acknowledged. Linking it to the "shell startup side effects" sentence would make that explicit.

This PASS/REVISE concerns report accuracy only. It says nothing about whether either host experiment passed.
````

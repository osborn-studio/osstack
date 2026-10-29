# Original host-report-closure

Scope and raw bindings are retained in the archive.

````text
**REVISE (limited, report-accuracy closure only).** Three of the four corrections are closed. Correction 2 is closed on substance but carries one new unsupported detail, and correction 3 has a small residual. I checked `report-final.md` only against the text pasted here. I ran nothing and opened no files.

## Four corrections

1. **Inventory equality: closed.**
   - The final report now limits equality to the parsed 34-entry maps (path, type, mode, length, hash).
   - It states the raw snapshots differ: 5,640 vs 5,641 bytes, with distinct hashes.
   - It gives the cause, after = before + one trailing LF, which matches the root byte-check lines you supplied for both hosts.
   - Those hashes and lengths match `raw_bindings`, and `inventory_unchanged: true` / 34 entries match `observations.json`.

2. **Claude model-identity source: closed on substance, with one unsupported detail.**
   - The report no longer says "assistant messages". It cites init and result `modelUsage`, which matches the `identity` block (`init_reported`, `result_modelUsage`).
   - It also says "init event **2**". Nothing supplied gives the init event's index. The packet shows only the Skill call at 3, its result at 4, the body at 5, and the result at 25 (`result_event: 25`).
   - Drop the "2", or cite where it comes from.

3. **Unverifiable claims: mostly closed, with a residual.**
   - The base-directory header claim and the manifest line numbers/line hashes are gone. The report now says the manifest binds whole files, not event lines.
   - Skill-body support is limited to "body exact; frontmatter excluded", which matches `observations.json` and the grade.
   - Two sentences still assert the contents of files not in the packet: "`codex-events.json` and `claude-events.json` separately provide event locations" and "Event indexes and inputs are in claude-events.json". The prior audit named `claude-events.json` index contents as unverifiable.
   - Either soften these to a pointer ("see …; not re-verified in this audit") or cite a verification.

4. **HF06 and HF01: closed.** The report states Claude HF06 is **LIMITED** (`limited_comparison_artifact_ambiguity`) and HF01 is **LIMITED** (`limited_future_deliverable_narrowed`), both matching `results.json`. It calls them confirmed limitations, not pending suggestions.

## No-upgrade check

The report keeps `LIMITED_not_overall_PASS` for both hosts and says it does not promote either to host qualification PASS. It keeps these Codex limits visible:
- the unresolved model identity
- the unsupported native-availability claim (HF08)
- `final_ambiguous:true`

It also keeps the global-effects and principal-not-attested limits (HF11). It does not call the work a comparative or causal experiment. The original responses, raw evidence and grades are described as unchanged. That "unchanged" statement is the report's own assertion, and I did not verify it here.

## Required before PASS

- Remove or source "event 2" for the Claude init event.
- Soften or source the two sentences about what `claude-events.json` and `codex-events.json` contain.

No other changes are needed for these four corrections. This verdict covers report wording only and says nothing about whether either host experiment passed.
````

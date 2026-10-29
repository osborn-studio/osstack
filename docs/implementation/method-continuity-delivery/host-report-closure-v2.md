# Original host-report-closure-v2

Scope and raw bindings are retained in the archive.

````text
**PASS (limited, report-wording closure only).** I compared `report-final-v2.md` against `report-final.md` and the prior audit, using only the pasted text. I ran nothing and opened no files.

## The two remaining findings

1. **Unsourced init index: closed.**
   - v1 said "init event **2**". v2 says "in init event and result event 25 `modelUsage`", so the init index is gone.
   - Event 25 is still supported by the packet (`result_event: 25`).
   - The identity claim is still scoped as provider/CLI-reported, not an authenticated principal.

2. **Supplemental indexes as pointers: closed.**
   - **Execution section:** v1 asserted that the two event files "separately provide event locations". v2 now reads "See `codex-events.json` and `claude-events.json` for supplemental indexes; their contents were not re-verified in the report-accuracy audit". That is a pointer with an explicit non-verification disclaimer.
   - **Reads section:** v1's "Event indexes and inputs are in claude-events.json" is deleted. The sentence now reads only "Byte checks are in observations.json."
   - **Manifest scope:** the line that the manifest binds whole files, not event lines, is kept.

## Scope check

- Every other paragraph in v2 matches v1 as far as I can tell. I found no new claims added, so the earlier closures (inventory, HF06 and HF01) are unaffected.
- Both hosts remain `LIMITED_not_overall_PASS`, and the report still says it does not promote either to host qualification PASS.
- The Codex limits stay visible: unattested model identity, native availability not established, and `final_ambiguous:true`.

This verdict covers report wording only. It upgrades no host grade and says nothing about whether either host experiment passed.
````

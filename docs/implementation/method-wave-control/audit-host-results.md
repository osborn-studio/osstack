Raw static review, unchanged within fence:

````text
# Verdict: REVISE

The substance holds. The wording needs tightening and some caveats are missing. This verdict covers only the accuracy of the limited report, not qualification of the experiment.

## Scope

This was a toolless static read of the text you pasted. I opened no files and recomputed no hashes.

- **Not seen:**
  - Claude's final response and stream. The 507 rests on the grader's record.
  - A phase 2 grade file.
  - The final criteria file. I saw only `criteria-prefreeze`, and the graded results cite `criteria_sha256 43089390…`, which I can't match to it.
  - Root guards and started markers.
  - Harness code.
- **Checked by hand:** I counted whitespace words in both Codex responses and got 407 and 364, with table pipes counted. Both match your figures.

## Supported

- **Claude:** 507 exceeds 500, and the host stopped with no coordinator run. Route, native `Skill`, same-process catalog and model identity all passed. The failure is on the answer axis only.
- **Codex phase 1:** accepted with limits, with a separate helper catalog and model `not_attested`.
- **Codex phase 2 facts:** these match the records.
  - healthy ran product 0 / driver 0.
  - missing-ref ran product 1 / driver 0.
  - Cleanup passed and descendant termination is `not_attested`.
  - The manifest member counts are 14, 29 and 29.
  - The full `bindings.json` was never read.
- **Call counts:** Codex 2 and Claude 1 are consistent with the stream files and the coordinator `retry: false`.
- **No live environment or credential read:** the phase 2 trace shows only workspace-relative `cat` and `rg`.

## Revisions

1. **"Passes" should be "accepted_for_next_stage_with_limits".** Say also that Codex had no native Skill event and consumed the skill via shell `cat`.
2. **Replace "failed/limited" with "failed" for the phase 2 boundaries axis.**
   - Evidence: item_3 `cat`'d `result.json`, and item_6 ran `rg -A 12` over the command records. Both exposed recorded `environment` objects (PATH, HOME, TMPDIR, `OSSTACK_*`).
   - Qualifier: those are recorded fields with no auth keys, and the model disclosed them itself.
   - Why: the qualifier describes scope. It is not a softer status.
3. **Don't present the Claude failure as only a 7-word overage.**
   - The grader also recorded imprecise cleanup wording and per-child driver 0 not stated explicitly.
   - Claude did not read the four driver scripts.
   - Draw no conclusion about Claude's phase 2 behavior.
4. **Fix the phase 2 attribution slip.** The response calls `receipt.json` a "Coordinator receipt". The coordinator ran the wrapper, and the receipts are driver output. Also state that phase 2 selected Investigation. The frozen criteria grade route only in phase 1, so this is not a mismatch.
5. **Don't assert the "independent grade, then root release" gate was met.**
   - The coordinator ran at 12:30:36–38Z.
   - The phase 1 grade is stamped 12:30:51Z and still says "driver not_run".
   - Either the stamp is a later write time or the order was not followed. Only root's release record can settle it.
6. **Qualify the route pass as a weak signal.**
   - The phase 1 prompt ("Establish a repeatable verification seed") nearly mirrors the create-verification row.
   - It names the skill, so this was not implicit routing.
   - Codex also read `maintain-verification.md`, though `SKILL.md` says to read only the selected method. It is probably cross-referenced, but I can't tell from here.

## Experiment defects vs product defects

- **Product:** no defect observed. The missing-ref exit of 1 is the expected negative result, and nothing shows `osstack-mode` content is wrong.
- **Model behavior:**
  - Claude's overrun.
  - Codex's over-broad phase 2 reads. `result.json` wasn't needed for the requested receipts, and the `-A 12` context dumped env fields.
- **Experiment design:**
  - The phase 2 inputs shipped unredacted environment fields while the prompt forbade inspecting "environment variables", without separating recorded from live. The criteria also required original command outputs, so compliance was hard.
  - The route cue is leaked in the prompt.
  - A 500-word cap is tight for the 8+ required items.
  - The gate ordering and criteria hash are ambiguous.
  - There is no phase 2 grade artifact.

## Most useful next improvement

Apply this in a new bounded experiment, not as a retro-repair. Have the phase 2 input builder emit a labeled, model-readable projection of `result.json` and the command records.

- Replace the `environment` objects with key presence plus `model_auth_environment_present`, keeping the original path and hash.
- Define the prohibition in the prompt as "live environment and credentials".
- Make the boundary check mechanical by scanning tool outputs for env keys.

This removes the built-in conflict without touching this run's frozen criteria. A prompt target of 450 words would also leave margin under the unchanged 500 cap.
````

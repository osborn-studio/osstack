# Actual report audits

Three actual toolless `claude-sonnet-5-5` report audits returned REVISE, REVISE, then limited closure PASS. They assess reporting accuracy and supplied evidence, not host-task success. Guard-template wording was corrected; omitted version/publication/history records and full approved guard evidence were supplied. Root independently verified original bytes and timestamps; the auditor did not calculate hashes or execute tools. Both host overall grades remain limited.

## audit

````text
**Verdict: REVISE.** One confirmed contradiction with the supplied records, plus a few provenance claims the supplied records don't support. The substantive findings and scope disclaimers hold up. This is a toolless read of the supplied text only. I executed nothing and verified no hashes.

## Confirmed blockers

1. **Supplement overstated as binding root guards.** The report says the final preparation supplement "bound … root guards." `independent-supplement.json` says the opposite:
   - It states "this supplement is not approval and creates no guard."
   - Its `remaining_root_actions` list freezing models, appending the supplement SHA to the guard, and approving calls as still to be done.
   - It binds only `guard_template_sha256`.
   - Fix: say it bound guard *templates* and that root guards were approved separately.

2. **Claims with no support in the supplied records.** Either cite a bound source or remove them:
   - "published in PR296 at `4833bd97`". Only the `73d446b4…` method source appears in the records.
   - CLI versions "Codex CLI 0.160.1" and "Claude CLI 2.1.291". They appear in none of the supplied files.
   - The earlier 515-word experiment "used older material and a different task". The records say only that the failure is unchanged and not regraded.
   - "J11" in "No J01/J11/runtime qualification". Only J01 appears in the records.

## Checked and supported

- **Codex reads:** 15 complete reads with exact bytes, 263 final words, 285 across all assistant messages. No native Skill event, so the "no fallback needed" claim is correctly marked unsupported.
- **Claude reads:** native Skill call, result and body observed, 10 exact reads, 365 words. The four A/B `intent.md` and `behavior.mjs` files were not opened, and the report states this.
- **Static analysis** (from the source, not run):
  - **NaN:** A gives `NaN||10` = 10, so all items. Base and B give `slice(0, NaN)` = `[]`. This is a real counterexample.
  - **`false`:** the same split, 10 against `[]`. Also a real counterexample.
  - **`null`:** both `||` and `??` give 10, so the parenthetical in Claude's final contradicts itself.
  - **Negative and fractional limits:** the same on all three versions.
  - The "overbroad" characterization is accurate.
- **Run and cleanup:** one turn each, exit 0, 40.1s and 24.8s, no retries. Inventories (83 entries) unchanged and temp homes absent. Workspaces are retained and the report does not claim they were cleaned up.
- **Scope:** no causal-benefit, provider, principal or runtime-gate overclaim. Host-reported model identity is separated from attestation.

## Suggestions (non-blocking)

- State that Claude's 365 words exceeded the advisory 250–350 target while staying under the 500 hard ceiling. "Within budget" currently reads as covering only time.
- Say explicitly that workspaces are retained pending owner archive and cleanup. "Follows archive verification" could be read as done.
- Add `""` (and BigInt `0n`) as further static counterexamples to the non-numeric claim, if you want it complete.
- Fix the missing spaces before numbers ("CLI0.160.1", "Final263", "and10").
- Note that the shared index differs only in host paths. The "identical bytes" claim is otherwise accurate for the source, diff, intent and assertion files.
````

## audit-closure

````text
**Verdict: REVISE.** R2 and most of R1 are closed. One new claim from the R1 fix is not backed by the supplied records, and a small part of the wording item is still open. This is a toolless read of the supplied text only. I executed nothing and verified no hashes.

## Remaining issues

1. **R1 replacement claim is not supported by the supplied records.** The report now says root "approved separate exact guards, each binding that supplement."
   - The template-versus-approval distinction is fixed, and `root-dispatch-summary.json` supports separate root-dispatched guards. Their guard SHAs match `guard_sha256` in the final grade.
   - That summary gives only the path, SHA-256 and a `frozen_files` count (92 and 99). It does not show that the supplement SHA is among the frozen files.
   - The only source for "binding that supplement" is `supplement.json`, whose `remaining_root_actions` list "Append exact supplement SHA to guard frozen_files" as a future step. That is a plan, not a record that it happened.
   - Fix: supply the guard `frozen_files` entry showing supplement SHA `5aa4807b…`. Otherwise reword to "root approved separate exact guards (dispatch records, guard SHAs …)" without claiming the supplement binding.

2. **Missing spaces before numbers remain in several places.** Some were fixed ("Codex CLI 0.160.1", "Final 263 words", "10 exact Read results"). These are still run together:
   - "advisory350 target", "hard500 ceiling", "exit0"
   - "from73d to4833"

## Closed

- **PR296 at `4833bd97`:** `publication-receipt.json` shows PR 296 with `headRefOid` `4833bd97e52c…`. `method-publication-binding.json` shows the method/export diff from `73d446b4` to `4833bd97` exits 0 with empty output. Both are scoped as in the report, and the "does not claim merge" wording is consistent with the PR being a draft that is still open.
- **CLI versions:** `host-binaries.json` records `codex-cli 0.160.1` and `2.1.291 (Claude Code)`.
- **"Older material and a different task":** `prior-packet-report.md` and `gate-snapshot.json` support it. The prior experiment used `d63dbdce` material and a PR295 packet task, and it explicitly did not test the code-review method at `73d446b4`.
- **J11:** it appears in the prior packet report's "No J01/J11 …" disclaimer, so the wording is historically grounded.
- **Report content against the grade records:**
  - Read counts, word counts and the Codex native-Skill caveat match.
  - The Claude skip of four files via index hashes matches, as does the NaN/false overbreadth characterization.
  - The 83-entry inventories and one-turn, zero-retry, exit 0 run facts match.
  - The Claude 365-word versus advisory-target disclosure and the workspace-retained wording are present.

## Not assessed

I did not check the cited final-grade hash `04ea1c39…`. The grade file embeds `criteria`, `supplement` and `observations` hashes, but none equals it, so it is presumably the hash of the grade file itself. I did not verify that.

## Optional

Add `""` (and `0n`) as further static non-numeric counterexamples to the overbroad Claude claim.
````

## audit-final-closure

````text
**Verdict: PASS.** I found no remaining confirmed issues in R1 or the spacing. This was a toolless read of the supplied text. I computed no hashes, and the guard SHAs `921f7792…` and `fa55ec17…` are taken from root's independent check, as you said.

## R1: closed

- **Supplement binding:** both `codex-actual-approved-guard.json` and `claude-actual-approved-guard.json` end `frozen_files` with `.../independent/final-preparation/supplement.json`, SHA-256 `5aa4807bec991ed82c68a4837f53487e13e791a59bfd965156e7eb700ea33a3a`. This matches the value in `supplement_entry` in `root-verified-extracted-binding.json`.
- **Approval:** both guards have `approved: true` and a `root_dispatch` block. Each carries the same `protocol_sha256` as the `run-protocol.json` entry in its `frozen_files`, `875dde2a…`.
- **Separate guards:** the guards differ as expected. The runner SHAs are `68da449b…` and `6bf94331…`, matching the respective `run_codex.py` and `run_claude.py` entries. The workspace paths (`.agents` vs `.claude`) and `inputs/index.json` hashes also differ, which is consistent with the report's "index differs only in host export paths". The prompt SHA `c425abfe…` is shared and matches `review-prompt.txt`.
- **Report sentence:** "root subsequently approved separate exact guards, each binding that supplement" is now backed.

## Spacing: closed

The previously flagged items now read correctly: "advisory 350 target", "hard 500 ceiling", "exit 0" and "from 73d to 4833". I found no other run-together number or word in the report body. "PR296" is a name token and fine as written.

## Not assessed

- **Ordering:** the guards show root dispatch times of 14:59:22 and 14:59:23, but the supplied data has no call timestamps. "Before the actual calls" therefore rests on records outside this packet. R1 doesn't depend on it.
- **Hashes:** I did not check the final-grade hash `04ea1c39…` or the guard SHAs against files.

## Optional (non-blocking)

- Add `""` and `0n` as further static non-numeric counterexamples to the overbroad Claude claim.
- The `budget` string in both `root_dispatch` records has run-together text ("one userturn perhost,180seconds"). It is a preserved root record, so I would leave it unedited.
````

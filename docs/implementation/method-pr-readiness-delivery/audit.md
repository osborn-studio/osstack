# PR-readiness audit record — publication draft

This draft preserves the actual reports without revising their old conclusions. Sonnet CLI binding records identify `claude-sonnet-5-5` and exit 0 for both calls; prompt and response hashes were verified against retained bytes. The initial review concerns author `04840eda89650f3c41c9605c9b9648bfc482182f`. The limited closure concerns the delta to `95a33e371464fe48bf063afe17ed650852e925d5`, not broader runtime or host qualification. The integrated root `c95dccd01a884e84e413817c338f2303ed02a9a7` has ten byte-identical author paths (candidate-bindings.json).

R1 refreshes review/threads/mergeability after authorized publication. R2 binds exposed base/merge refs, refreshes final head/base and states time-bound readiness. R3 requires concrete risk disproof and the affected principal/guard-before-effect check. O1/O2/O3/O4/O5/O6/O8 were adopted. Optional O7 was not added because merge execution remains outside this method. The complete author dispositions are in the revision evidence archive; closure accepted this disposition.

The independent initial report found no substantive gap under its scope. The later delta report explicitly acknowledges that it did not identify R1–R3's missing explicit details earlier. Do not rewrite the initial report or claim prior detection. Independent exports and static walkthroughs do not constitute actual host use or authenticated independence.

Reports below are complete original text inside inert fences. No source report was modified. Their exact original byte sizes and SHA-256 values are in evidence-index.json; fence separators are document framing. Host results remain pending and are not part of this audit draft.

## Initial actual Sonnet review — REVISE

Original: `method-audit/report.md`.

```text
**Verdict: REVISE.** Three small, text-only fixes are required and none needs runtime work. I found no scope, routing, export or attribution defect beyond them. This is a read of the pasted text only. I did not verify the ten-path diff, the "80 files" and "91 passed" counts, or any test or export result.

## Required

**R1. Re-read review and integration state after a push.** `references/pr-readiness.md`, paragraph "After authorized fixes…".
- It says to observe "the forge's new head and applicable checks". Approval, unresolved threads and mergeability are omitted, though those are where stale-approval and head-change problems show up.
- Fix: "…then re-read the new head, its checks, current approval/change-request state, unresolved threads and mergeability; report them as observed, since the forge may or may not carry earlier approvals forward."

**R2. Bind CI to the base as well as the head, and refresh at report time.** Same file: the "Checks" bullet and the final "Only describe the PR as currently merge-ready…" sentence.
- Refresh is currently triggered only if head or base changes "while reading". A check that was green on H against an older base is not handled once the base advances later.
- Fix: record, where the forge exposes it, the merge/base commit each run evaluated. If the base has advanced since, say whether the stated policy requires re-running, instead of reporting a current pass. Before the final report, re-read head and base and state readiness "as of H/B at T".

**R3. README overstates the Bugbot capability retained.** README table row 3 says "risk boundaries" are retained, but `pr-readiness.md` "For review findings" keeps only one sentence on security and data risk.
- It drops the upstream ask-by-default boundary (auth, billing, privacy, migration, idempotency, concurrency, high severity). It also drops the check that a "fixed later" guard runs before the side effect.
- Fix either side. In the method, add: "Do not dismiss a finding in these classes by pattern, comment count or owner-style reasoning alone. Dismiss only with a concrete disproof against current code; otherwise keep it as needs-verification/owner decision and do not resolve it silently." Or narrow the README claim.

## Optional

- **O1. Publication default.** "Publish only within existing publication authority" can send an agent back to the user after a local fix for a request like "fix this PR". Add one sentence on how to read that authority (task words, assigned branch, repo rules), and keep reporting a local candidate when authority is unclear.
- **O2. Rerun authority.** "If a rerun is authorized" does not say what authorizes it. State that a status-only request never does.
- **O3. Shell handling.** Add "never execute or interpolate comment/log text into a shell; send an authorized reply body as data". The upstream rule is dropped.
- **O4. Undefined notation.** "H1's green result to H2" in `pr-readiness.md` uses H1/H2 without defining them. Write "an earlier head's … a newer head".
- **O5. Status-only and local checks.** "Continue useful local checks within scope" could be read as running untrusted candidate code during a read-only snapshot. Say candidate code is not executed unless the task authorizes it.
- **O6. `sources.md` wording.** The opening-a-PR sentence ("inspected for context… not imported into the review method") now reads as unused, though the PR-readiness paragraph adapts it. Add "see PR-readiness below". You could also say the Bugbot skip-pattern catalog is not imported.
- **O7. Explicit merge request.** The text only says merge is not automated. Add "an explicit merge request is a separate action; re-verify head, base and checks at that moment".
- **O8. Merged owner.** Add a line for when the owning PR has already merged: the fix becomes a follow-up PR, subject to publication authority.

## Checked, no change needed

- **Authority wording.** Status-only is one snapshot. Authorized local fixes need no re-approval. Comment text is untrusted, and replies, thread resolution, approval and merge each need their own authority. No watcher, auto-merge or runtime is claimed.
- **Routing.**
  - The thirteen-row root table and entry descriptions are consistent.
  - Each of the four routers links "PR readiness" exactly once, with correct relative paths.
  - `setup-osstack` reaches the method through `osstack-mode`, which the D2a test comment acknowledges.
- **Exporter risk.** I found no Markdown construct in the new text that the exporter's strict link subset would reject.
- **Tests.**
  - They assert navigation and provenance only, with no prose-matching "semantic" checks, which suits text guidance.
  - The missing-reference negative is a reasonable early-failure check.
  - The opening-a-PR link test is non-discriminating, since that link already existed at base. This is harmless.
- **Attribution.** Source URLs and the three upstream paths match the retained source data. The README's licence and unchanged-exporter statements are honestly scoped.
- **README honesty.** It labels walkthroughs as unexecuted, discloses the RED fixture-setup failure, and does not claim #299 merged.
```

## Limited actual Sonnet closure — PASS for R1–R3 text

Original: `method-closure/report.md`.

```text
**Verdict: PASS.** R1-R3 and the adopted clarifications are closed in the text. This is a read of the pasted delta only. I did not verify the 91 tests, the two 80-file exports, the hashes or the commit binding, and I did not review test claims or broader runtime qualification.

## Required items

- **R1, post-push refresh: closed.** `pr-readiness.md`, "After authorized fixes…", now re-reads the new head, applicable checks, approval/change-request state, unresolved threads and mergeability. It reports what the forge retains or invalidates and does not assume earlier approval carries forward.
- **R2, base/head binding and report-time refresh: closed.**
  - The Checks bullet records the evaluated base or merge commit where exposed, and labels it unknown otherwise. If the base advanced, it checks whether the policy requires a new run and keeps the older result's scope.
  - "Before the final report" re-reads head and base, refreshes affected facts, and labels readiness unknown if the read fails. It states readiness "as of the observed head, base and time".
- **R3, risk disproof and guard-before-effects: closed.**
  - The risk classes now require a concrete disproof against current code. Pattern, comment count or owner preference is explicitly insufficient.
  - A claimed later guard must protect the affected principal and run before the side effect. Otherwise the finding stays needs-verification or an unresolved owner decision, and is not silently resolved.
  - The README claim and `sources.md` now match the method.

## Constraints you set

- **Authorized fixes:** "Confirmed fixes already within scope can proceed without a new approval", plus "do not ask again when they already authorize it" for publication. There is no blanket permission ask. `sources.md` states that the Bugbot ask-by-default policy is not imported.
- **Upstream machinery:** nothing in the delta requires importing merge or watch machinery. The no-watcher, no-scheduler and no-merge-service statements are intact.

## Adopted optional clarifications

- **O1, O2, O3, O4, O5, O6 and O8** are present and consistent with the rest of the file.
- **O7** (an explicit merge request is a separate action; re-verify head, base and checks then) was not added. It was optional and the text still says merge is not automated, so it is not blocking.
- **O1 follow-up:** the "when authority is unclear, report the local candidate" default is carried only by the existing "if publication is not authorized" sentence. That is acceptable.

## Unverified README claims

The README's "Audit revision" section asserts the 91-test pass, two exports of 80 files each, the hash re-checks and the unchanged source inventory. None of that is checked here. Root should rely on its own evidence for those claims, not on this review.
```

## Original independent candidate review — historical scope

Original: `independent/candidate-0484/report.md`.

```text
# PR-readiness independent candidate review

Candidate 04840eda: no confirmed substantive gap in the twelve frozen criteria. Concrete static walkthroughs preserve stale/current head differences, distinct conflicts/review/check states, comment-data boundaries, existing fix authority without repeated approval, diagnosis before bounded rerun, owner/dependency boundaries and human-reserved merge. Source attribution is exact; opening-a-PR contextual exclusion remains scoped to the earlier review method.

Two independently executed exports each produced 80 files and 289 local-link edges; every member hash/size and output inventory matched, with all four entries reaching thirteen methods. Corresponding host material bytes match and canonical snapshot bytes remain unchanged. Deleting pr-readiness in a separate owned source copy caused exit 1 before output creation.

These are package checks and manual hypothetical walkthroughs, not real model use, actual fix execution, live merge readiness or runtime qualification. Author test counts are not presented as independent reruns. Detailed decisions, exact commands/raw outputs and hashes are retained beside this report.
```

## Independent revision review — subsequent correction

Original: `independent/candidate-95a3/report.md`.

```text
# PR-readiness revision independent check

95a33e37 closes the three identified explicitness gaps: after-push review/threads/mergeability are reread, CI includes available evaluated base/merge bindings and final head/base refresh, and risky dismissal requires current principal/guard-before-effect disproof. Existing authorization remains effective; uncertainty stays visible.

The earlier048 scoped no-gap report remains unchanged and did not identify these missing explicit details. This delta review is not credited as prior detection.

Two fresh exports each have80 files and289 local edges; four entries reach13 methods, every member hash/size matches, and cross-host material bytes agree. These are export checks and static review, not host behavior. The old missing-reference negative was not rerun. Original host048 preparation is historical and cannot qualify this new source.
```

## Actual Sonnet report-claims host-report-audit

This is report accuracy only; host grades stay Codex LIMITED and Claude FAILED. Original bytes are in the raw archive.

````text
# Verdict: REVISE

This is a report-claims review only; it grants no new PASS. The core findings (Codex LIMITED, Claude FAILED at 578 words > 500, the four-case classifications, the scope limits) match the transcripts, the grades and the criteria. A handful of statements are unsupported, imprecise or missing qualifiers, and none requires relaunching anything.

## A. Semantic and schema judgment

**Supported by the grades and the transcripts**
- The A–D classifications match the snapshots for both hosts.
- B's untrusted-instruction handling and its limited plan details (no rebind to a new candidate; Claude also omits explicit same-trigger verification) are correct.
- Claude's 578-word answer breaks the hard 500 cap. It is preserved and not trimmed, and the report says so.
- I hand-counted Codex's 19-word progress message and it is correct. I did not recount 329/348/578 and took them from the grader.

**Corrections**
1. **Codex word-cap status is not stated.** Say that Codex's 329 words (and 348 combined) meet the hard 500 cap, and that the 250–350 target is advisory only (met by Codex's 329; Claude's 578 misses it). Codex's HR09 limit is final-channel selection, not length. Without this, "Codex cannot be called PASS" can be misread as a format failure.
2. **"Independent grading" and "independent prefreeze supplement" need a qualifier.** `criteria.json` limits say "Agent review, not independent trusted principal", and the supplement says "Not a formal independent principal". Add that qualifier.
3. **"Frozen HR01–HR12 remain unchanged" needs qualification.** `criteria.json` is bound to source `04840eda…`, and HR10 literally says "exact source0484 bytes". The supplement rebinds only the source and `index.json` candidate pin to `95a33e…`, before any user turn. Say: "HR01–HR12 expectations unchanged; source/index pin amended by supplement."

## B. Trace mechanics

**Supported**
- Codex had two `cat` calls (exit 0), and the aggregate returns match the frozen files.
- Claude had one Skill call plus eight Reads, with `modelUsage` showing `claude-sonnet-5-5`.
- The guard/dispatch/runner ordering holds (supplement 23:29:48 → dispatch 23:30:17.81 → runners 23:30:20.96 / 23:30:21.17).
- Exit 0, one user turn and zero retries are consistent with both records.

**Corrections**
4. **"Final workspace removal is pending archival" is unsupported.** The evidence says `workspace_retained: true`, with workspaces kept "for independent verification" and no cleanup performed. Replace it with "workspaces retained; no workspace removal performed or planned in the evidence."
5. **"Inventories remained equal" is imprecise.** Parsed before/after maps are equal (32 entries, 26 files), but `raw_before_after_bytes_equal` is false (one extra trailing LF in the after file). Say "parsed inventories equal; raw snapshots not byte-identical."
6. **"Private-home directories were removed" overstates what was observed.** The evidence is `private_temp_absent: true`. Say "absent at check."
7. **"CLI authentication was inherited" fits Claude only.** For Codex, the supplement says a minimal explicit environment with the actual host auth home. Neither host is auth-isolated.
8. **Claude's nine-path coverage rests on the Skill expansion for `SKILL.md`, not a Read.** The match is made after accounting for the base-directory prefix and args suffix, with frontmatter excluded. The report should say so rather than imply nine Reads (it correctly says eight). Also say that returned contents were compared to the frozen bytes, if that comparison is meant to be claimed.
9. **Codex ran its `cat` calls through `/bin/zsh -lc`, a login shell.** Shell startup behavior is unattested; add that to the existing "not proven" list.
10. **"Existing earlier failed experiments and runtime gates remain unchanged" is not evidenced in these files.** The grader only says earlier runs are "not regraded." Reword to that.

## C. Structure recommendation
The report interleaves the two axes. Present them as separate blocks: (1) semantic classification, (2) format/schema (word cap, final selection), (3) trace, attribution, identity, inventory and cleanup. This follows HR12's "report axes separately."

## D. Not verifiable from the supplied files
- **"Integrated source c95":** I can't bind this to anything in the supplied files. The report mentions only `95a33e…` as the "final author candidate", and `run-protocol.json` says it is "not a published/current-main claim." If `c95` is a distinct integrated commit, the report needs a stated relationship to it, or it should state that none is claimed.
- **The shared prompt file** (`readiness-prompt.txt`) isn't included. I could confirm only that `request.txt` and the snapshots read identically across hosts.

No confirmed misclassification, and no claim of PASS, runtime qualification or behavioral benefit appears in the report.
````

## Actual Sonnet report-claims host-report-closure

This is report accuracy only; host grades stay Codex LIMITED and Claude FAILED. Original bytes are in the raw archive.

````text
**PASS**

The revised report closes corrections 1–10 and the two unverifiable items in D. It does not upgrade Codex LIMITED, Claude FAILED, or the earlier experiments.

**Corrections 1–10**
1. **Codex word cap:** The report says Codex's 329 words meet both the hard 500 cap and the advisory 250–350 target, and that even the combined 348 meet the hard cap. It says Claude's 578 fails the hard cap and the target. The Codex limit is stated as final-selection only, with no native marker.
2. **Independence qualifier:** The reviewer is described as "another agent, not a formally independent trusted principal", so "independent agent grading" is qualified.
3. **HR01–HR12 wording:** Expectations are "unchanged", and the supplement's rebind of the source and index pin to 95a33e is stated as made before any answer.
4. **Workspace removal:** "Pending archival" is gone. The report says workspaces are retained and any later removal needs its own receipt.
5. **Inventories:** Parsed inventories are equal (32 entries, 26 files). Raw snapshot bytes are not identical because the after file has one extra trailing LF. This matches 5685 vs 5686 bytes and `raw_before_after_bytes_equal: false`.
6. **Private temp:** The report says "absent at the independent check", matching `private_temp_absent: true`. It makes no removal claim.
7. **Authentication:** Claude inherits its CLI environment. Codex gets a minimal explicit environment pointing at host auth homes. Neither is auth-isolated.
8. **Claude coverage:** The report says the Skill body is matched after base-directory/args presentation and frontmatter exclusion, and that eight Read returns match the frozen contents. Together they cover the nine paths. It does not claim nine Reads.
9. **Login shell:** `/bin/zsh -lc` is noted, and startup behavior is listed as not attested in two places.
10. **Earlier experiments:** The report now says only "Earlier experimental results are not regraded here", which matches the grader's limits.

**C (structure)**
The report now has separate semantic, format/final-selection, trace/attribution, and inventory/auth/cleanup sections. This follows HR12's "report axes separately".

**D (unverifiable items)**
- **c95:** The report now ties `c95dccd0…` to `candidate-bindings.json`, which records ten byte-identical paths between author `95a33e…` and the integrated root. The report states that this does not make the probe an execution on live main. The bindings file supports this: `ten_paths_byte_identical: true` and `claims_imported: false`.
- **Prompt file:** `readiness-prompt.txt` is now in evidence. Its 250–350 target and ≤500 hard limit match the report's HR09 treatment.

**Non-blocking**
- The "180 seconds model wait" figure is not evidenced in the files supplied here. It was not part of the original corrections.
- The Claude FAILED grade sits under the semantic heading, but the report ties it explicitly to the format failure, so the two are not conflated.
````

# Bounded candidate snapshot verification

This delivery extracts a bounded read-only candidate observation from pstack babysit/opening-a-pr/watch-pr concepts. It adds no named method or watcher, no mutation and no merge authorization. Source attribution and limitations are in [README](README.md). PS17/PS18 and PS13 remain partial; J07 is a supporting relation and J20 is design context, not event-supervision implementation.

## Source and checks

Author c8f3aa11fc007171c23c64e09b402351174c834c supplied the collector, script, tests and README. Root8a711bd1b42c8f6282000b06e880f64dda7f566c added exports, package aliases, CI and the existing PR-readiness reference. Sonnet requested stronger tests; author8a89e670cfbee62fa667b41e448107b2cc8eb26b changed only two tests and README. Root622ead838ccdeaef2fa6f38a4cb8373027d129cd also corrected command wording. Both production files are byte-identical across these revisions. The original module/script-missing RED shows feature absence, not a discovered production defect; the added audit-driven tests passed first time, not RED→repair.

The final focused root run at622ead83 passed152 github package tests (45 candidate cases plus107 existing),14 CLI tests and94 exports. Earlier root8a711 full run passed7171 tests,5 skipped,0 failures across22 unique packages. All8509 tracked file hashes were unchanged during that run; four freshly generated knowledge/dist files were already dirty at start. This is not a clean committed-tree result, and the later test/documentation revisions and cosmetic package.json description encoding restoration are not relabeled as that full run. Generated dist was kept throughout validation.

Independent PC01–12 criteria were frozen before candidate evaluation.25 frozen vectors and17 CLI seam cases passed against c8 production, including non-vacuous existing-parent escape, symlink-parent escape, output refusal and retained report payload checks. Author revisions broadened additional status/pagination/error assertions; the independent historical runs were not relabeled as testing those new assertions. Complete original reports describe untested branches and trust boundaries.

## One actual read

After focused tests and independent vectors, a fresh root guard authorized exactly one live snapshot of PR306 with expected head958eb72295937b96ee8affc32fa87910bbdde512 and basee79fc92687c144969ad91242a979d904f2b2acdf. The command made four read-only gh requests, wrote10 payloads and a manifest, and exited0. At that instant the forge was BLOCKED, the PR remained draft/review-required, check was pending and paid smoke was skipped. The report correctly retained those observations with summary blocked and merge_authorized=false. This is successful report acquisition, not a favorable candidate or readiness gate. It was not rerun after CI or merge to obtain a better result.

The guard preceded the command and all requests; independent verification matched payload hashes/lengths/modes, complete inventory, actual raw responses and stable pins. Subprocess output is retained as UTF-8 decoded strings, not arbitrary transport bytes. No independent forge authentication, OS sandbox, global-effects isolation, model behavior, full policy discovery or atomic transaction is claimed. No new native-host experiment occurred.

## Review and integration

Actual Claude CLI Sonnet5.5 initial audit returned REVISE for R1–R4 coverage gaps. Original prompt/response/bindings remain intact. Complete CI source shows the build before tests; the filtered review diff alone did not show that order. Actual limited Sonnet5.5 closure returned PASS for R1–R4 and correct CI ordering. It retained optional limitations and requested concrete evidence for reporting claims; root-revision original152/14/94 outputs and Git byte/diff proofs supply that evidence. No extra model rerun was used to alter those opinions.

User merged306 at actualmain6c9a3e8f11f2664f15b4ce4a26c5014d68fdcd4b. Its tree equals the existing958 dependency. Root integration5744e8999da71d181b3cdd0bd339a47a95c04c6f has empty tree delta from its first parent, so no source was changed by incorporating actualmain. Historical runtime and CI bindings remain unchanged. New published-head CI is evaluated separately.

All original author/independent failures, proposed input error, audit opinions, exact inputs, test logs, actual read raw payloads, guards, and source hashes are retained in the evidence archive; a passing static closure is not a host experiment PASS or formal milestone completion.


Archive SHA256 `15a3324dabc84aa9275dbb48b003a8b766729172f3411c8cd49668d51ac01788` contains 278 members, 236 files, one test symlink and 5258202 file bytes; root verified every type/mode/hash/size/link target. The original symlink is retained without dereference. [Manifest](evidence/manifest.json) and [receipt](evidence/receipt.json) describe storage. Later publication-only receipts are separate. Documentation241 and hygiene1 passed after the code/test changes; full source bindings remain as stated above.

A pre-publication check confirmed a missing changeset for the new public API. The original failing coverage output is retained; adding the minor @osstack/github changeset made the same coverage command pass. This is release metadata, not a production-code change.

Independent archive verification matched all278 members and complete scratch inventory (excluding the declared separate publication report); receipt SHA2562ba87364a1ae094784727bdfc3a80676a386b27330e688913473765f0034a18a.


Published PR307 targets actual main directly at9d54cfdc658ac137ae9e95d08499aad77ec529f0; CI40926150260 is running. Draft until five applicable checks succeed. This publication note does not rebind the earlier full test or actual snapshot.

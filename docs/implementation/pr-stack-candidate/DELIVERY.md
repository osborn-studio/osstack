# Ordered stack observation delivery evidence

This is a bounded PS17 contribution, with PS18/PS13/J07 support and J20 design context only. It adds no named method, native-host experiment, watcher, retry or mutation authority.

## Candidate and observed behavior

Author `ad38b017876a84b6333c67a47acc98ebb8b5b848` supplied the library, CLI, tests and guide. Root `540cd7a5` integrated the public exports, package aliases, offline CI contract step, minor changeset and existing PR-readiness reference. Final product code/documentation is `8e830561`: the CLI display repair was cherry-picked from `2348c825`, then actual main `e4643324` was merged without changing the candidate tree or complete delta. A final guide paragraph clarifies renderer and plain-text limits.

The declared ordered 1–3 PR list is observed once. A stable merged prefix advances to the first unresolved item; an unknown lower item cannot be replaced by a green upper item. Branch relations, candidate blockers and unknowns remain separate. There are at most24 actual requests and270 seconds of collection budget, with effective dispatch timeout receipts; writing is outside that budget. No output is written until collection finishes, so interruption or process loss may leave an empty acquired directory. Raw reports may contain private repository metadata.

Root made exactly one live read at01:05UTC using `540cd7a5`, order308→309: eight queries observed308 as merged prefix and309 as an open frontier with draft/checks_pending/review_required retained. This is historical evidence, not current PR status: the user later merged309. It was not repeated to obtain a greener report. C verified the24 retained members, query receipts and guard ordering. Hashes bind bytes, not forge identity or OS isolation.

## Validation and original findings

- Author:29 library,16 original CLI and201 package tests. Early reported31 was an oral estimate; actual logs establish29. Initial implementation failures are retained; an intermediate uncommitted production source was not separately captured, so no exact old-source SHA is asserted for those development failures.
- Root540:224 GitHub package,16 new CLI,14 existing candidate CLI and94 method-export tests passed. Build/typecheck/lint/inventory/changeset checks passed; lint has existing warnings. Import observation16.81075ms is a single local observation, not a performance improvement claim. CLI startup medians49ms/version and119ms/help passed their local budgets.
- C froze42 scenarios before author implementation. They passed58 assertions including an explicitly post-freeze late-result subcase. Independent real compiled API/public export checks passed. Successful CLI fixtures use injected runners; only the separate root observation used live forge reads.
- Actual Sonnet5.5 initially issued static PASS with a confirmed low-severity Markdown autolink/bidi defect. Its original entity-encoding suggestion for control characters was itself corrected during repair; all original opinions remain in the archive. Same29 CLI tests on saved old/new source:17pass12fail→29pass. C independently rendered10 cases with Pandoc3.9.0.1 GFM: old7failed→new10passed, preserving expected internal links and JSON/raw strings. Sonnet limited static closure PASS followed. This is not all-renderer, native-host or provider/principal qualification.
- Root full at540:22 unique packages,7261passed5skipped0failed. All8784 tracked-file bytes were equal before/after; four fresh generated knowledge/dist files were initially dirty. This is not a clean committed-tree claim. Subsequent standalone CLI repair and guide changes do not relabel that full run as final whole-tree coverage.
- Actual-main focused verification at8e830:224 GitHub,29 repaired CLI and94 export tests passed. Hygiene1 and design validators241 passed. The generated dist files were saved with bytes/hash/patch and retained until all validation ends.

No confirmed issue remains from this bounded review. Original optional observations—whole-stack discovery, historical comparison, stored-card refresh, more general display confusables and writing during collection—remain outside this implementation; they are not silently treated as complete.

## Retained material

[Raw archive](evidence/raw-verification.tar.gz) SHA256 `2a26d78cafcedc9befbc7eead73150fc610674fc4caf716bd6286d0099c43fe6`; [manifest](evidence/manifest.json) SHA256 `9427827db90e0105ae5f76d91e9045e1c643705760f4b4e14d8b0932caae467b`. All1124 members include936 files and3 symlinks,19356574 file bytes. Root verified type/mode/size/hash/target for every member. Symlinks retain their historical target text without dereferencing cleaned workspaces. [Independent archive verification](evidence/archive-independent/report.json) independently verified every member; report SHA256 `0ca7edc66399f0e109c967afbc6d8db801a8b34fd66732b8e6afaa23516332e1`.

The original two Sonnet prompts/responses/model usage, RED/GREEN logs, frozen criteria, actual live receipts, source bindings, full log and initial failed/diagnostic harness observations are preserved. Remote CI for the published head is evaluated separately. Stage acceptance and formal32J gates remain distinct from this implementation and its activity card.

# PR291 CI follow-up

Candidate `ff6bfeb69973a7d700e4e2288a9a8e5859efb2d7` merges actual main `f92914e0a98bd3e5f82765fddc5a275a93637f30` with the output-drain correction and CI evidence retention. Product correction is `bcc4c732a99e5bf36d7aa3210b06784cc9c81765`.

CI run `40658708716` on original published head `7228af775ea13f2c0d8ebb2790c669dc07cfb89c` passed package tests and 25 verifier tests, then failed the real mixed case with two `summary_mismatch` errors and `source_output_mismatch:drift`. Four other real cases passed. Original mixed stdout was not retained as a downloadable artifact, so the exact historical trigger remains unproven.

A controlled real-Git reproduction demonstrates a product defect consistent with that signature: `exit` can arrive before inherited stdout drains, and the watcher then reports `no_matching_ref` despite a correct head arriving later. The watcher now interprets results at `close`, preserving the original deadline while streams remain open. No driver selection, concurrency, expected exit, retry rule or predicate was weakened. Six regression tests cover late stdout/stderr, pending output, deadline, spawn failure and ordinary completion.

The [original Sonnet 5.5 audit](audit-original.md) returned PASS with no blockers on the merged candidate. Its historical-cause inference is not treated as proof; a later passing upload also cannot prove what happened in the old run. Optional stream-destruction and extra permanent real-Git fixture suggestions remain follow-up scope; the controlled reproduction is preserved. Root lint passed with 21 pre-existing warnings. The CLI externalizes `@osstack/skill-registry` in its tsup configuration, and changesets already update internal dependencies; the registry patch changeset passes coverage. No release is performed.

The [focused handoff](focused-handoff.md) retains exact precommit byte bindings: 43 registry tests, 25 verifier tests, registry build/typecheck and real five-case verification. Root additionally reran the verifier on `ff6bfeb6`: 25 tests and all five actual cases passed (0/1/2/1/0), all 49 manifest records matched, and the fixture was absent afterward. These are separate records, not relabeled historical runs.

CI now writes evidence to an explicit scratch directory and uploads it on success or failure with a seven-day retention period. The action is pinned to verified upload-artifact v4 ref `ea165f8d65b6e75b540449e92b4886f43607fa02`. Evidence command environments use the fixed fixture allowlist, not inherited credentials.

Focused archive SHA-256: `9acdb93f2aef0821652f585c639ac814205e2bbd9ef1c6499f5e8d91d9979122`. Root full regression and latest published-head CI are tracked separately; neither this fix nor a model audit grants runtime qualification.

Root full `pnpm test` completed on `ff6bfeb6`: **7144 passed, 5 skipped, 0 failed**. Only documentation was added while this run executed. Final published-head CI is still required.

Root evidence archive SHA-256: `0f6533c8b9d209b7db5f97b4a7f6920f130da763d2c16fb2df5b827e29a4a39d`; 68 members rechecked after compression.

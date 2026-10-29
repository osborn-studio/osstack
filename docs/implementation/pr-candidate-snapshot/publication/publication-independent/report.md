# Publication scope review (provisional)

Pinned committed candidate **5744e8999da71d181b3cdd0bd339a47a95c04c6f**, compared directly with actual main **6c9a3e8f11f2664f15b4ce4a26c5014d68fdcd4b**. This is not the future PR307 published head. Root has pending control/evidence edits; their state is recorded separately and must be rebound after final commit.

## Scope

All 8 non-documentation changed paths are the agreed tool and wiring: GitHub collector plus its tests/index exports, standalone report CLI plus tests, package scripts, one offline CI step, and the existing pr-readiness reference. No unrelated runtime, DB, daemon, provider or global configuration path changed. Remaining committed paths are joint control ledgers and PR305/306 publication/validation evidence plus new tool documentation.

Collector imports existing zod and defaultDeliveryCommandRunner; all constructed forge commands use fixed `gh api graphql` read queries. CLI imports the built collector dynamically and writes only acquired report outputs. Existing delivery implementation is unchanged. This is a scope inspection, not a new comprehensive safety or behavior audit.

Root package.json adds only `test:pr-candidate` and `inspect:pr-candidate`. CI adds only `Read-only PR snapshot contracts (offline)` running the former; no existing gate or matrix removed/relaxed, and no live forge query added to CI. The package's normal Vitest test file remains covered by the existing full suite.

No dependency declarations, lockfile or package manifests changed. Method count remains unchanged; pr-readiness gains the actual checkout command and explicit limits (report exit0 is not a Ready verdict).

## Confirmed prepublication gap

At this pinned head, no `.changeset/*.md` mentions public **@osstack/github**. Existing `scripts/check-changeset-coverage.mjs` treats its new src implementation/index export as release-sensitive and requires a matching changeset. Add a scoped release entry before publication, then bind that new head separately. This finding is based on actual source/changeset inspection; the coverage script was not executed in this read-only task.

The diff includes prior PR305/306 CI/board/archive evidence, so it is larger than the new feature code alone. Those artifacts are in agreed control/documentation locations; this task has not independently revalidated their entire archive contents. Original full-independent evidence remains unchanged. No source edits, test/model execution or forge mutations occurred.

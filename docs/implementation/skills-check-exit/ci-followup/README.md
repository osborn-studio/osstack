# CI follow-up: completed-upgrade preparation budget

PR289 head `a567bd9f1e7c196fbe2dea1661f6da450c42b68c` failed run 40645757136: two inherited `upgrade-native` cases exceeded 30 seconds; a third passed at 29,723 ms. These test/product files were unchanged from main. Original failure remains archived; it is not reclassified as a successful run.

Candidate `4dddf67a` moves the complete two-home upgrade, stop and missing-fence preparation into a 60-second `beforeEach` and keeps each cleanup/recovery case at 30 seconds. Total permitted time increases from 30 to 60+30 seconds, plus the unchanged teardown budget. No real operation, home or assertion is removed; no product hashing/authorization check is changed. Setup assertion failure also closes its port in `finally`.

This separates preparation and behavior budgets; it is not a performance fix. Local original instrumentation measured preparation at roughly 0.5–0.8 seconds and cleanup at 11–14 ms. Those local measurements do not establish where the CI run spent its time. There is no proven CI root cause. A future setup or cleanup timeout remains a test failure; ordinary timeout rejection is not proof of cancellation of every pending asynchronous operation. Fresh published-head CI is required before Ready.

Validation: 37 focused tests (25 native upgrade, 12 skills command), one-file Biome and CLI TypeScript checks passed. Full workspace results and exact commit are in archived `control/full-test-binding.json`. Actual Claude CLI Sonnet 5.5 audit gave candidate A (`4dddf67a`) PASS; its original report also audits an unrelated methods-document candidate B and requests revisions there. B is not part of PR289. Independent source/lifecycle review retains the timeout-cancellation limitation. No test was skipped or assertion weakened.

[Original failure, local stage logs, candidate tests and audit](evidence.tar.gz) are indexed by [the manifest](manifest.json). Narrow path redactions retain before/after hashes; original scratch records are preserved. Source, test and test-time evidence retain their own SHA; later documentation-only commits do not relabel a run.

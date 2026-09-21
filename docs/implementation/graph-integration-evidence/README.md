# PR #225 main integration evidence

Base: main `dc2a26fab187d8ff721b831de268ed20f1587c74`. Original PR head: `535b6ec96d84e00001e97a83498d360ccba4146a`.

Main migrations 25–27 are preserved byte-for-byte, Graph migrations are appended at 28–37. A frozen legacy fixture and table-introduction contract refuse incompatible pure and mixed experimental databases before application DDL. Loop keeps the main clean-environment options together with Graph cancellation and process-group proof.

- `fable-result.json`: independent Claude CLI Fable 5.1 requested stronger hybrid-schema tests and frozen fixtures.
- `fable-final-result.json`: final accept after corrections; no execution tools were exposed to the reviewer. Its final optional whitespace/reopen suggestion was also implemented after this review.
- `lineage-final.txt`: 43 migration/DB assertions passed before the final two reopen cases were added; later platform runs cover these additions.
- `executor-delta.txt`: four new clean-environment and cancellation assertions passed; skipped cases reflect the explicit focused name filter.
- `production-rehearsal.json`: private SQLite backup of the serving database migrated 22→37, original 51 table counts preserved. The private database itself is deliberately excluded. This is a rehearsal, not production deployment.
- `linux-clock-jumps.json`: diagnostic proof of competing guest time synchronization, corrected by stopping systemd-timesyncd in the dedicated test VM while retaining the Lima host clock agent.

Final Linux Node 22 has 389/389 passing tests. Node 20.6 final migration/DB delta has 45 passing tests. GitHub run 35550018695 on fec0b18 passed 3,974 full-suite tests (3 explicit opt-in skips) and both runtime jobs. Its release-plan smoke failed because the controlled ready fixture did not override the live registry bootstrap query for unpublished @osstack/graph; the fixture was corrected, and the local smoke passed. The final CI rerun is still required.

The macOS full integration diagnostic (3,955 pass / 6 fail / 3 skip) and focused recheck (95 pass / 8 fail) are preserved as failures, not counted as acceptance. A dedicated test VM was stopped before the recheck; host resource competition remains a reproducibility debt.

Installed package rehearsal first demonstrated disabled admission plus legacy RPCs. The final disabled-then-enabled rehearsal uses a local fixture provider (not a paid inference), a 600-second bounded task and explicit autonomy health readiness. It reaches ready with two provider calls and leaves the original source unchanged. Earlier local rehearsal homes with stopped/failed runs remain preserved; no production configuration or service was changed. The existing GitHub approval covers the original head; branch protection requires approval of the pushed integration changes.

Registry-skew follow-up: a new package returning structured npm E404 is packed as a local candidate with `registry_version:null`. Authentication, signal/timeout and malformed errors remain fatal. The published CLI baseline is required, so an all-E404 registry cannot pass as an all-local install. Fable accepted the change; its baseline-anchor suggestion was implemented, with exit-status hardening. The final 22-case self-test and actual registry/local-tarball install both passed. Real publish/bootstrap readiness remains blocked until the graph package is first published.

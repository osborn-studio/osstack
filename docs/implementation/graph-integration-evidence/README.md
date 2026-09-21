# PR #225 main integration evidence

Base: main `dc2a26fab187d8ff721b831de268ed20f1587c74`. Original PR head: `535b6ec96d84e00001e97a83498d360ccba4146a`.

Main migrations 25–27 are preserved byte-for-byte, Graph migrations are appended at 28–37. A frozen legacy fixture and table-introduction contract refuse incompatible pure and mixed experimental databases before application DDL. Loop keeps the main clean-environment options together with Graph cancellation and process-group proof.

- `fable-result.json`: independent Claude CLI Fable 5.1 requested stronger hybrid-schema tests and frozen fixtures.
- `fable-final-result.json`: final accept after corrections; no execution tools were exposed to the reviewer. Its final optional whitespace/reopen suggestion was also implemented after this review.
- `lineage-final.txt`: 43 migration/DB assertions passed before the final two reopen cases were added; later platform runs cover these additions.
- `executor-delta.txt`: four new clean-environment and cancellation assertions passed; skipped cases reflect the explicit focused name filter.
- `production-rehearsal.json`: private SQLite backup of the serving database migrated 22→37, original 51 table counts preserved. The private database itself is deliberately excluded. This is a rehearsal, not production deployment.
- `linux-clock-jumps.json`: diagnostic proof of competing guest time synchronization, corrected by stopping systemd-timesyncd in the dedicated test VM while retaining the Lima host clock agent.

Validation in progress is not counted as passed. Further final platform and integration results are added here before landing. The existing GitHub approval covers the original head; branch protection requires approval of the pushed integration changes.

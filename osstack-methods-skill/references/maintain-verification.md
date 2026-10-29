# Maintain verification instructions

Maintain a named verification directory and its feature map. If none exists, use [create-verification](create-verification.md). This task edits only its authorized instructions/map/harness; a discovered product regression is recorded, not hidden by a documentation change.

1. Compare the feature index to actual files and current source entry points. Identify missing or duplicate entries and newly introduced user paths. Cite concrete source changes before claiming drift.
2. Read each mapped feature against current code and prepare its shortest meaningful live recipe. Independent source readers can work in parallel when delegation is authorized; one coordinator owns each live instance and serializes drives against it.
3. Run the documented doctor before first drive and after surprising behavior. If a healthy process hides broken application state, reset only owned fixture state or relaunch. Do not repeatedly drive a stale instance because its PID still exists.
4. Exercise every mapped feature for a complete maintenance pass. Keep a per-feature source review and execution record. An unreachable feature needs the attempted route and exact missing prerequisite; it stays blocked or partial coverage, never passed. Broader unlisted coverage remains explicitly out of scope.
5. Classify each issue: **documentation drift** (incorrect instructions), **harness gap** (product behavior cannot be driven or observed reliably), or **product regression** (observed product failure). If the evidence cannot distinguish them, classify as unknown and state the next experiment. Do not lower a predicate, delete a failing feature or omit a required prerequisite to obtain green output.
6. Re-drive every corrected instruction/harness path and preserve earlier failed evidence. Cleanup each failed attempt and the final instance, verifying evidence survives. Unknown process termination prevents clean closeout.

Report one outcome with its coverage:

- **clean**: all mapped features received source and live coverage, required cleanup was confirmed, no correction needed.
- **changed**: authorized corrections were made and their affected paths re-proven; disclose any remaining coverage gaps. Publication follows the user's existing scope, never this label alone.
- **blocked**: a prerequisite, ambiguous failure, unsafe ownership or incomplete required coverage prevents completion. Retain findings and a specific next step.

For partial work, report “blocked, with verified corrections” rather than suggesting the whole map is current. A product regression remains in the evidence even if a separate harness defect was fixed. No recurring automation is created by this method.

The [skills-check journey](skills-check-journey.md) is a concrete five-case target with a backward-compatible default two-case run. For a complete maintenance pass over its map, use the documented `--scope full` option and retain source review plus live evidence for `healthy`, `missing-ref`, `drift`, `mixed` and `empty`. Follow that wrapper's actual interface; do not transfer options from the underlying driver.

The five product exits are 0, 1, 2, 1 and 0 respectively. Also check their meanings: one healthy source, one unreachable ref, one reachable but drifted source, three mixed sources with both failure and drift retained, and no sources. A driver exit 0 confirms the expected observation and evidence checks; it does not turn failure/drift into healthy, or make an empty configuration proof of source health. Inspect per-case cardinality, refs, blessed/current SHAs, raw output, input stability and cleanup. Do not maintain the map by exit codes alone.

The default `healthy`/`missing-ref` run still provides useful two-case evidence. Label it partial when the requested maintenance scope is all five; blocked or `not_run` rows remain missing coverage. Preserve the failed attempt and unknown cleanup when execution stops early. Full completion covers these five local fixture cases only, not all live sources or global behavior. Keep the full audit bundle unchanged. The default projector still refuses full-journey input and preserves its two-case version 1 contract. Use the explicit `--scope full` projection in the linked journey recipe for a five-case version 2 packet, then run `--check` without a scope option. Never omit rows or claim that a two-case packet represents all five. Packet checking validates retained evidence structure and byte consistency; it does not replace the source review, actual drives and cleanup observations required for maintenance, or turn failed/unknown/not-run rows into passed ones.

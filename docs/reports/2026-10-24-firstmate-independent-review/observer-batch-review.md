# Independent observer batching review

Reviewed commit: `f8aaa9c97018279e8c51d5ce7e2317a1dd87f098`.

Reviewer: the upgrade/source implementation agent, independently reviewing the
scout agent's implementation. This is a Codex source review, not the requested
Claude Code Haiku audit. Claude authentication was unavailable at review time.

Scope: `attention-observer.ts`, its regression tests, `supervision-service.ts`,
and the active qualification report's unchanged acceptance thresholds.

No new reproducible P0/P1 defect was identified in the reviewed change.

- The outer write transaction now commits one bounded sampling slice. Existing
  nested sample transactions become SQLite savepoints, so a malformed source can
  still roll back its own projection and be recorded as unknown.
- An uncaught slice failure restores the in-memory scheduling cursor to
  `sliceStart`. Earlier subjects whose database writes rolled back are therefore
  retried; they are not silently skipped. The new two-subject trigger regression
  checks both the empty projection after failure and complete recovery on retry.
- Owner checks remain at transaction entry, each subject, and projection update.
  A competing connection cannot commit an owner replacement through an active
  SQLite write transaction. The existing stale-owner and release checks are
  retained; admission is re-read before sampling each subject.
- The service yields between slices and retains stop/coalescing behavior. The
  scheduled 2 ms duration is a **soft** check before starting each subject. It is
  not a hard upper bound for discovery, an individual subject, or commit/fsync.
  The actual RPC p95 < 10 ms and Loop overhead < 1% thresholds remain unchanged.

Execution evidence belongs to the scout commit: attention suites 48/48,
supervision service 24/24, CLI typecheck and changed-file Biome checks passed.
This independent reviewer did not rerun those suites concurrently with the
performance measurements. The scout preserved every qualification run, including
failures; a passing fourth shared-host run does not establish isolated-host
qualification. The parent is responsible for the pending isolated repetitions.

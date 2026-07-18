# neat R2 release candidate

R2 adds explicit local history, bounded portfolio visibility, and event-derived
trends while preserving the default stateless behavior of `osstack neat check`.

## Included

- normalized SQLite run, finding, occurrence, and resolution records through
  migration 9; raw report blobs are not stored;
- opt-in `neat check --record`, with report-SHA idempotency and an explicit
  `--db` override;
- optional, backward-compatible repository hygiene summaries that do not alter
  closed-loop maturity levels;
- a bounded four-worker portfolio scanner with configurable concurrency,
  stable registry ordering, and per-repository failure isolation;
- actionable `daily` output for incomplete scans, current errors, and recurring
  warnings, with clean repositories omitted;
- `neat trend` human and strict JSON reports covering report count, current
  open age, recurrence, closure rate, latest new/resolved delta, and separately
  reported suppression count.

## Operational use

```sh
# Remains stateless.
osstack neat check --repo . --all

# Explicitly record a normalized run.
osstack neat check --repo . --all --record

# Query the event-derived history for the persisted repository identity.
osstack neat trend --repo-id osstack
```

`daily` reads existing history if `$OSSTACK_HOME/state.db` is present. A missing
database is silent; an unavailable history database degrades to a warning and
does not abort the current repository scans.

## Release evidence

- Core: 156 tests passed.
- Supervisor: 50 tests passed, including the 20-repository bounded scan.
- CLI: 482 tests passed, including strict JSON, Markdown, delta, statelessness,
  recording idempotency, and trend snapshots.
- Core, Supervisor, and CLI builds and strict typechecks passed.

Publication still requires the normal repository release-owner approval and
the final R0-R4 monorepo release gates.

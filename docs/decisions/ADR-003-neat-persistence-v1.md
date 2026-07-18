# ADR-003: neat persistence v1

- Status: Accepted
- Date: 2026-07-17
- Decision owner: repository owner
- Scope: explicit `osstack neat --record` only

## Decision

Persist knowledge-hygiene history in core-owned SQLite tables. Governance stays
storage-independent, and the default checker never opens a database. Store a
content identity and normalized events rather than duplicate report JSON blobs.

## Schema

Migration 9 adds four namespaced tables:

1. `knowledge_hygiene_runs`
   - one row per unique report SHA-256;
   - records `run_id`, repository identity, schema/mode/diff/config identity,
     generated/recorded time, completeness, and severity/suppression/resolution
     summary;
   - does not store the report blob.
2. `knowledge_hygiene_findings`
   - one current aggregate per `(repo_id, fingerprint)`;
   - records rule/surface/severity/location/rationale, first/last seen, distinct
     occurrence count, current state, and latest run;
   - supports age, recurrence, and current owner-decision queries.
3. `knowledge_hygiene_occurrences`
   - append-by-run event rows keyed by `(run_id, repo_id, fingerprint, state)`;
   - states are `active`, `resolved`, and `closed_absent`;
   - makes new/resolved deltas and closure rates reproducible from history.
4. `knowledge_hygiene_resolutions`
   - one resolution per `(diff_id, fingerprint)` with outcome, actor, reason,
     evidence JSON, resolution time, and recording run;
   - preserves explicit review evidence separately from finding aggregates.

Recording a complete report also emits `closed_absent` events for findings that
were active after the preceding recorded report but are absent from the new
active/resolved sets. Incomplete reports never infer absence-based closure.
Re-recording the same report SHA is an idempotent no-op and cannot inflate
recurrence.

## Transaction and concurrency

One `BEGIN IMMEDIATE` transaction records a run, occurrences, aggregate
upserts, inferred closures, and resolutions. Unique constraints plus
`ON CONFLICT` make repeated or competing writers converge. WAL and the existing
five-second busy timeout provide bounded cross-connection serialization.

## Migration and rollback

Migration 9 uses only `CREATE TABLE/INDEX IF NOT EXISTS`, so databases at
versions 1–8 upgrade without rewriting existing tables. `user_version` advances
inside the existing migration transaction; any failure rolls back all v9 DDL.

Migrations remain forward-only. Before production upgrade, copy the closed DB
and its WAL/SHM state through the normal backup procedure. Rollback options are:

1. preferred: stop writers and restore the pre-v9 backup;
2. data-preserving export: export the four v9 tables, drop them, then set
   `user_version = 8` only while running a v8 binary;
3. application rollback without schema rollback: a v8 binary ignores the new
   namespaced tables, but must not run after a v9-only write contract change.

No automated down migration is shipped because destructive table drops are a
larger operational risk than retaining additive unused tables.

## Consequences

- Default `neat check` remains stateless and zero-write.
- Trend queries are score-free and event-derived.
- Report reconstruction is intentionally impossible from the DB alone; callers
  retain exported reports when full evidence payloads are required.
- Location/rationale metadata is duplicated once per fingerprint, not once per
  run, to support bounded daily owner-decision output.

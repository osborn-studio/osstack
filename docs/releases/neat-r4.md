# neat R4 release candidate

R4 completes the authorized knowledge-hygiene roadmap with opt-in
application-layer close-out evidence and conservative repeated-finding
improvement proposals.

## Included

- `loop run --neat-finalize` for direct and daemon runs. It invokes neat only
  after a successful, non-idle, within-budget run and attaches the full report
  or isolated finalizer error to `knowledge_hygiene`;
- no `@osstack/governance` dependency in `@osstack/loop`, no Loop event/schema
  expansion, and no recursive CLI invocation;
- migration 10 adds per-finding and per-occurrence confidence. Historical rows
  default to `unknown` and remain ineligible for automation;
- a configurable recurrence policy with per-fingerprint occurrence and
  same-rule repository thresholds, append-only event replay, active-state
  filtering, stable candidate keys, and bounded run evidence;
- a supervisor adapter that emits stable, evidence-backed, high-risk drafts
  with no proposed file changes;
- `neat propose`, which is preview-only by default and persists drafts only
  with `--yes` after policy authorization. Repeated execution is idempotent and
  preserves proposals whose human-review state has advanced.

## Operational use

```sh
# Optional post-success report; omission is the off switch.
osstack loop run --workspace . --source task_queue --neat-finalize --json

# Preview only.
osstack neat propose --db "$OSSTACK_HOME/state.db" \
  --min-occurrences 3 --min-repositories 2 --json

# Persist human-reviewed drafts under propose/execute policy.
osstack neat propose --db "$OSSTACK_HOME/state.db" \
  --min-occurrences 3 --min-repositories 2 --yes
```

## Safety and rollback

Automation remains opt-in. To roll back operationally, omit
`--neat-finalize` and stop invoking `neat propose --yes`; existing reports,
events, and drafts remain auditable and do not change repositories. Migration
10 is additive, so rolling application code back does not require destructive
database surgery. Human-advanced proposal states are never demoted by a later
recurrence pass.

## Remaining non-goals

- no automatic hook installation or policy editing;
- no automatic prose rewriting or semantic contradiction detection;
- no inferred external-memory directory;
- no composite hygiene score;
- no cross-repository dependency obligation until the registry has explicit
  dependency edges.

Publication still requires the full monorepo test, build, typecheck, lint,
schema, smoke, golden, inventory, and changeset gates recorded by the final
release verification.

## Release verification

- all 19 buildable workspace projects passed strict typecheck and build;
- Core 162, Governance 141, Supervisor 53, Loop 202, and CLI 497 tests passed;
- the remaining workspace package test suites passed;
- root Biome checked 347 files with no findings;
- protocol and governance JSON Schemas are current;
- package graph, public exports, and CLI inventories are current;
- the close-out smoke passed with both default checks writing zero files;
- the frozen 12-scenario evaluation passed at 100% blocking precision, 80%
  warning precision, and zero false negatives;
- Changesets recognizes the R4 Core and CLI minor release entries.

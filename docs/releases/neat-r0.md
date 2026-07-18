# neat R0 release candidate

`osstack neat` adds a read-only knowledge-hygiene product surface to the CLI and
an independently usable engine to `@osstack/governance`.

## Included

- strict `.osstack/neat.yaml` v1 configuration;
- bounded, symlink-safe inventory of recognized instruction and documentation
  surfaces;
- canonical/mirror, required-surface, budget, conservative reference,
  change-review contract, and incomplete-scan rules;
- human output and strict `AgentCommandResult` JSON;
- frozen finding/report schemas and compatibility vectors;
- twelve-scenario golden evaluation and hermetic close-out smoke;
- a thin, attributed `neat-skill` companion workflow.

The R0 golden report records 100% blocking precision, 80% warning precision,
and zero false negatives on the frozen scenarios. The single labelled false
positive is a reviewed change with no review-target edit; R1 resolution evidence
is the planned closure mechanism.

## Compatibility

Existing `@osstack/governance` scanner exports and `loop doctor` instruction
messages remain compatible. The new schemas and APIs are additive. R0 creates
no database, migration, daemon state, or repository write path.

## Known limits

R0 does not auto-fix, persist history, inspect agent memory, scan external URLs,
or judge general prose quality. See the [user guide](../guides/neat.md) for the
complete boundary and configuration reference.

Publication still requires the normal repository release-owner approval and
full monorepo release gates.

# @osstack/supervisor

## 0.10.0

### Minor Changes

- dd61975: `buildPortfolioReport` now also emits `structured_recommendations` — a
  machine-actionable mirror of the existing free-text `recommendations`. Each
  entry is `{ kind, repo_id?, text }` where `kind` is one of `missing_path`,
  `add_loop_doc`, `add_verify_command`, `enable_failure_assetization`,
  `create_evaluator_anchor_set`, `freeze_evaluator`, or `consolidation`, and
  `repo_id` (the registry-unique id, NOT the display name) is carried whenever the
  recommendation is attributable to a single repo (portfolio-level `consolidation`
  hints have none).

  The free-text `recommendations` array is unchanged — same strings, same order.
  It is now _derived_ from the structured list (`structured.map(r => r.text)`), so
  the two can never drift; `supervise report`'s rendering is byte-identical.

  The `PortfolioReport` zod schema gains `structured_recommendations` as an
  optional-with-default (`[]`) field. The schema is not `.strict()`, so previously
  persisted reports lacking the field still parse (the default fills in).

  `LOOP_DOC_RECOMMENDATION` is now marked `@deprecated`: consumers should dispatch
  on `structured_recommendations` (`kind === "add_loop_doc"` + `repo_id`) instead
  of string-matching this wording. It stays exported for one release.

### Patch Changes

- 91665e9: Export `LOOP_DOC_RECOMMENDATION` (the missing-LOOP.md recommendation wording)
  so `osstack daily`'s dispatchable-action mapping shares one source of truth
  with the portfolio report instead of a duplicated literal.
- Updated dependencies [1b48a7d]
- Updated dependencies [daeb3c4]
- Updated dependencies [276428b]
- Updated dependencies [25b3f4a]
- Updated dependencies [7396e6f]
- Updated dependencies [6a4a9d4]
- Updated dependencies [3223420]
- Updated dependencies [392f8b0]
- Updated dependencies [620cc4f]
- Updated dependencies [99ca3b4]
  - @osstack/core@0.10.0
  - @osstack/loop@0.10.0
  - @osstack/governance@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [23fb3e7]
- Updated dependencies [a6f2075]
- Updated dependencies [17312b5]
  - @osstack/loop@0.9.0

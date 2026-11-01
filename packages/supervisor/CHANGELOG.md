# @osstack/supervisor

## 0.23.0

### Patch Changes

- Updated dependencies [95534c7]
- Updated dependencies [12de1f7]
- Updated dependencies [85e19da]
- Updated dependencies [eb35fbb]
- Updated dependencies [5b3400e]
- Updated dependencies [0d9dca7]
- Updated dependencies [b103f62]
- Updated dependencies [c310d51]
- Updated dependencies [f740da8]
- Updated dependencies [d26c920]
- Updated dependencies [41a1b0a]
- Updated dependencies [b5f2f93]
- Updated dependencies [7939a10]
- Updated dependencies [e93d640]
  - @osstack/core@0.23.0
  - @osstack/governance@0.23.0
  - @osstack/loop@0.23.0

## 0.22.0

### Minor Changes

- b185daa: Integrate scoped Attention summaries into the main cockpit, bound supervision and local notification work, and add deterministic routing qualification against the actual routing entrypoints.

### Patch Changes

- Updated dependencies [0a61d27]
- Updated dependencies [c8dc83f]
- Updated dependencies [c129a31]
- Updated dependencies [c48e29a]
- Updated dependencies [3d5fdc0]
- Updated dependencies [7e5a84d]
- Updated dependencies [63064cd]
- Updated dependencies [b185daa]
  - @osstack/core@0.22.0
  - @osstack/loop@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies [27c2148]
- Updated dependencies [1fa74af]
  - @osstack/loop@0.21.0
  - @osstack/core@0.21.0

## 0.20.0

### Patch Changes

- Updated dependencies [071c1ff]
- Updated dependencies [f4c55ec]
- Updated dependencies [1263519]
- Updated dependencies [de4a3bb]
- Updated dependencies [9f17623]
- Updated dependencies [9011913]
- Updated dependencies [29a3a17]
- Updated dependencies [5a82b1c]
- Updated dependencies [f4de18d]
- Updated dependencies [4a2646c]
  - @osstack/loop@0.20.0
  - @osstack/core@0.20.0
  - @osstack/governance@0.20.0

## 0.19.0

### Patch Changes

- @osstack/loop@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [249554f]
  - @osstack/governance@0.18.0
  - @osstack/loop@0.18.0

## 0.17.0

### Patch Changes

- Updated dependencies [a007f58]
  - @osstack/core@0.17.0
  - @osstack/loop@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [9cc8a37]
- Updated dependencies [ad57096]
  - @osstack/governance@0.16.0
  - @osstack/core@0.16.0
  - @osstack/loop@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [0743a2a]
- Updated dependencies [35141a8]
- Updated dependencies [be6cc63]
  - @osstack/core@0.15.0
  - @osstack/governance@0.15.0
  - @osstack/loop@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [619cd53]
  - @osstack/loop@0.14.0

## 0.13.1

### Patch Changes

- Updated dependencies [733c82a]
  - @osstack/governance@0.13.1
  - @osstack/loop@0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies [4fb11c0]
- Updated dependencies [b99bbfb]
- Updated dependencies [16ec914]
  - @osstack/core@0.13.0
  - @osstack/loop@0.13.0

## 0.12.0

### Minor Changes

- 4a3dffd: Make knowledge-hygiene ReportV2 the default `neat check` contract, add honest
  coverage and assessment scope, evidence-bound semantic auditing, recoverable
  memory and narrative transactions, append-only V2 lifecycle history, and
  cross-repository dependency obligations with an isolated no-tools judge.
  Explicit `--schema-version 1` remains available for one minor release and now
  emits a deprecation warning.

### Patch Changes

- Updated dependencies [4a3dffd]
  - @osstack/core@0.12.0
  - @osstack/governance@0.12.0
  - @osstack/loop@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [48ad63d]
- Updated dependencies [f041063]
- Updated dependencies [a483f6e]
- Updated dependencies [4a6c00b]
- Updated dependencies [83aac82]
- Updated dependencies [a90f3a5]
- Updated dependencies [73f89fd]
- Updated dependencies [53db533]
- Updated dependencies [223a240]
- Updated dependencies [9f1aa1b]
- Updated dependencies [92249dc]
  - @osstack/governance@0.11.0
  - @osstack/core@0.11.0
  - @osstack/loop@0.11.0

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

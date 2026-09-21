# @osstack/autonomy

## 0.20.0

### Minor Changes

- 5a82b1c: Add signed, finite phase continuation for the controlled no-tools planning/review
  session runtime. Bind frozen output checks and instructions to the exact session,
  runtime policy, owner key, initial turn/version, deadlines and cumulative budgets.

  Migration 24 persists grants and attempts alongside existing session receipts.
  Revoke stops subsequent actions; crash recovery never automatically resends an
  uncertain accepted delivery. Add collaborator inspect/draft/sign/install/status/revoke
  commands. This does not grant code execution, GitHub approval, merge or deployment
  powers to unrestricted agent sessions.

### Patch Changes

- f4c55ec: Align npm package repository metadata and Trusted Publisher tooling with the transferred osborn-studio/osstack repository. Existing mismatched trust mappings still require explicit operator review.
- 9011913: Complete the controlled internal executable Graph beta: preserve reconciliation-only repository locks across legacy acquisition, block upgrades while graph execution remains unresolved, and explicitly reject unsupported Node/Bun graph runtimes. Batch raw Git artifact capture and restoration with independent content and protocol limits so real repository delivery completes within its existing deadline.

  Add compatibility, fault, runtime and performance verification, plus a real internal provider pilot and operations guide. Unknown external effects retain their lock and budget reservation; ready produces a candidate artifact without merging or deploying it.

- Updated dependencies [071c1ff]
- Updated dependencies [f4c55ec]
- Updated dependencies [1263519]
- Updated dependencies [c1f4619]
- Updated dependencies [9f17623]
- Updated dependencies [9011913]
- Updated dependencies [29a3a17]
- Updated dependencies [5a82b1c]
- Updated dependencies [f4de18d]
- Updated dependencies [4a2646c]
  - @osstack/protocol@0.20.0
  - @osstack/core@0.20.0
  - @osstack/github@0.20.0

## 0.17.0

### Patch Changes

- Updated dependencies [a007f58]
  - @osstack/core@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [ad57096]
  - @osstack/core@0.16.0

## 0.15.0

### Patch Changes

- 0743a2a: Exclude compiled test and spec artifacts from npm tarballs, scan every packed workspace package for leaks, and verify release candidates against the real npm dependency graph.
- Updated dependencies [0743a2a]
  - @osstack/core@0.15.0
  - @osstack/github@0.15.0
  - @osstack/protocol@0.15.0

## 0.13.0

### Minor Changes

- 4fb11c0: Add project-allowlisted deployment, automatic rollback and freeze, and Mac Mini guarded-autonomy operations.
- b99bbfb: Add durable R0-R4 guarded autonomy and automated R1/R2 GitHub delivery,
  including exact-base candidate pinning, diff-bound R3 approval, SHA-bound
  merged-PR recovery, and fail-closed dependency/security validation.

### Patch Changes

- Updated dependencies [4fb11c0]
- Updated dependencies [b99bbfb]
  - @osstack/protocol@0.13.0
  - @osstack/core@0.13.0
  - @osstack/github@0.13.0

## Unreleased

### Minor Changes

- Add deterministic pre/post R0-R4 classification, scoped signed approval,
  durable state-machine recovery, no-progress budgets, exact staged candidate
  commits, and candidate/final delivery evidence orchestration.
- Pin every run to a freshly fetched clean base SHA, carry preflight R3 through
  diff-bound approval, recheck action scope before writes, fail closed on Git
  object errors, and protect verification scripts plus the autonomy trust
  kernel from low-risk self-modification.
- Add deterministic project deployment eligibility, script-authority digests,
  health-checked staging and production execution, automatic rollback/freeze,
  repository locks, and machine-wide concurrency control.

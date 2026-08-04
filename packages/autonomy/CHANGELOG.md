# @osstack/autonomy

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

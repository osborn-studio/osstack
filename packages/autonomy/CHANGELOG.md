# @osstack/autonomy

## Unreleased

### Minor Changes

- Add deterministic pre/post R0-R4 classification, scoped signed approval,
  durable state-machine recovery, no-progress budgets, exact staged candidate
  commits, and candidate/final delivery evidence orchestration.
- Pin every run to a freshly fetched clean base SHA, carry preflight R3 through
  diff-bound approval, recheck action scope before writes, fail closed on Git
  object errors, and protect verification scripts plus the autonomy trust
  kernel from low-risk self-modification.

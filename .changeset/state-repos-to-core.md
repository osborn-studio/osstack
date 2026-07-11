---
"@osstack/core": minor
"@osstack/cli": patch
---

State repositories relocated to core; CLI store becomes a compat shim.

R1.1 (ADR-001 §D2): the run/task/event persistence moved from
`packages/cli/src/store.ts` into `@osstack/core`
(`packages/core/src/state/run-store.ts`). `@osstack/core` now owns and exports the
four writers (`insertTask`, `insertRun`, `appendEvent`, `finalizeRun`) plus the
readers consolidated from the CLI's raw-SQL sites (`getRun`, `listEventsForRun`,
`countRuns`, `countRunsSince`, `countEvents`, `countPendingTasks`). An external
consumer can now read run/event state through the kernel without the
product-private CLI. `packages/cli/src/store.ts` is now a deprecated compat
re-export shim (import from `@osstack/core` instead). Ownership relocation only —
no DB behavior or schema change.

# G04 executor evidence

Scope: only the candidate primitive, its tests, the LoopEngine compatibility seam, and the public export. No plan/status edits, repository commits, nested agents/loops, or deployment.

## RED

Before implementation:

```text
node scripts/graph-test-env.mjs -- pnpm --filter @osstack/loop exec vitest run src/candidate-execution.test.ts
Exit 1 — 20 failed (20), 2.93s
New entry: executeCandidateImplementation is not a function.
Legacy regression: expected adapter spy to be called 1 times, but got 2 times (maxIterations: 3).
```

Additional stop-boundary regression after initial GREEN:

```text
Same command — Exit 1, 1 failed | 23 passed (24), 3.10s
Expected executedTaskCount 1, received 2 after unknown execution stopped the next task.
```

Fixed actual execution counting and retained pending tasks/audit on restart.

## GREEN

```text
node scripts/graph-test-env.mjs -- pnpm --filter @osstack/loop exec vitest run src/candidate-execution.test.ts src/executor.test.ts src/loop-engine.test.ts src/policy-gate.test.ts src/discovery-policy.test.ts
Exit 0 — 5 files, 177 tests passed, 3.86s
candidate: 24; executor: 102; legacy engine: 31; policy gate: 6; discovery policy: 14.

pnpm --filter @osstack/loop typecheck
Exit 0 — tsc --noEmit

git diff --check
Exit 0
```

Typecheck initially caught test-fixture event metadata and optional pending-list access; both corrected. The affected test run passed before the final optional-access typing correction; final typecheck passed afterward. Existing executor module import measured 11.93ms; no new cross-package runtime dependency or deep import was added.

Covered outcomes: one authorized command/adapter invocation; frozen plan/context/command/workspace scope across authorization; original signal retained; denied/missing/throwing authorization before probes/effects; preabort and pending-authorization cancellation with late resolution/rejection; registered workspace identity/path agreement and graph context path override; commandless local no-op rejected as implementation; command/adapter/protocol/cancellation failure evidence; no candidate commit, cleanup, discovery, verification, archive, or state-file overwrite. Legacy regressions retain policy admission, agent selection, role separation, verification and normal worktree lifecycle. Unknown execution invokes once with maxIterations 3, escalates before verification, retains its worktree, stops later tasks/cycles, persists structured cancellation evidence in execution_summary/decisions, and refuses automatic retry/cleanup from that audit after restart.

Boundaries: workspace registration and live scope validation belong to the mandatory trusted authorization callback; this primitive does not implement a registry, filesystem confinement, or per-tool enforcement inside an adapter. implementation_complete confirms executor completion only, not verified code or candidate_ready. Unknown legacy effects require supervised reconciliation; no automatic reconciliation, future ledger/schema, or candidate freezing (G16) was introduced. All tests ran under a fresh explicit OSSTACK_HOME supplied by graph-test-env.mjs; git fixtures were confined to temporary test directories.

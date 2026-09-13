# G02 executor evidence

Base HEAD: `3fe3793e72c96faae6c5c411bd64f190621dddb4`; Node `v26.5.0`.
Executor edits: `packages/loop/src/executor.ts`, `executor.test.ts`, `packages/agents/src/base.ts`, and this evidence file only. No commits, nested loops/agents, or task-status edits. Supervisor changes to the task manifest and G01 evidence appeared during verification and were left untouched.

## Behavior

- `LocalExecutorOptions.signal` reaches the actual `AgentAdapter.invoke(task, signal)` argument, merged with the executor timeout; the first cancellation source/reason wins. The timeout now covers availability and module loading as well as streaming.
- Preabort returns `cancelled` with `not_started` evidence, without probing or invoking. Cancellation during a pending availability probe prevents subsequent invocation and conservatively remains unconfirmed.
- `cancellationGraceMs` defaults to 1,000ms and bounds asynchronous probe, iterator, and confirmation waits after cancellation. Manual iteration avoids implicitly awaiting `return()`; cleanup is attempted without awaiting it and observes rejection. Parent listeners and timers are removed on settlement. Completed waits are removed rather than accumulating one cancellation reaction per event.
- `AgentRun` retains `completed | failed | cancelled`. Structured `cancellation` records source, request time, whether invocation started, and independent stop confirmation/evidence. Unconfirmed requests return `failed` / `cancellation_unconfirmed`, requiring reconciliation rather than automatic retry.
- Optional `AgentAdapter.confirmStopped(runId)` can provide explicit evidence that all owned work stopped. Signal delivery, iterator close/throw, and legacy `done(cancelled)` are insufficient. Late completed events never restore success; late stop proof cannot mutate an already returned uncertain result. G01 protocol failures and ordinary usage accounting remain covered.

## RED

Before implementation:

```sh
node scripts/graph-test-env.mjs -- pnpm --filter @osstack/loop exec vitest run src/executor.test.ts
```

Actual result: exit 1, **21 failed / 46 passed (67)**. Preabort executed the adapter; availability/next remained pending beyond grace; external reason was not forwarded; cancellation evidence/listener cleanup were absent. All 46 existing tests passed. The first implementation run had 66 passes and one test-fixture error (the assertion generated a second random plan id); corrected that assertion to use the returned run id. Two additional boundary tests cover independent confirmation with a hung stream and proof arriving after grace.

## GREEN and regressions

| Actual command | Result |
|---|---|
| `pnpm --filter @osstack/agents build` | Exit 0; refreshed declarations for the optional interface |
| `node scripts/graph-test-env.mjs -- pnpm --filter @osstack/loop exec vitest run src/executor.test.ts src/loop-engine.test.ts` | Exit 0; **100 passed**, executor 69 + LoopEngine 31; 3.64s |
| `pnpm --filter @osstack/loop typecheck` | Exit 0, `tsc --noEmit` |
| `node scripts/graph-test-env.mjs -- pnpm --filter @osstack/agents test` | Exit 1; **137 passed, 1 timeout**, 17 files; adapter-conformance subprocess-family test exceeded 5,000ms |
| `node scripts/graph-test-env.mjs -- pnpm --filter @osstack/agents exec vitest run src/adapter-conformance.test.ts` | Exit 0; **2 passed**, 2.86s |
| `git diff --check` | Exit 0 |

The full agents-suite timeout matches the pre-existing result in [graph-baseline.md](../graph-baseline.md#expanded-agents-baseline); the isolated rerun passed without changing tests or timeout settings. The full agents suite is **not** reported as green. All test invocations above used fresh explicit `OSSTACK_HOME` values from `graph-test-env.mjs`.

## Limits / handoff

Current production adapters have not been retrofitted with stop observers: cancellation of those adapters intentionally remains unconfirmed. Tests inspect the signal actually received by instrumented adapter implementations, including its reason; they do not invoke live providers or prove production process-tree termination. Existing unsolicited adapter terminal statuses retain G01 compatibility when no executor cancellation was requested.

Local shell process-group cancellation/exit confirmation remains G03; this card only adds the common preabort guard for that path. Bounded grace releases the executor, not unknown external work, and does not authorize workspace deletion or retry. Synchronously blocking JavaScript cannot be preempted by an in-process timer; pending asynchronous operations may outlive the returned evidence and require later reconciliation. No Node 20/22 or full-monorepo validation was performed.

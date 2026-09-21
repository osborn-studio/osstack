# G01 executor evidence

Scope: `packages/loop/src/executor.ts` and `executor.test.ts` only, plus this evidence file. Base HEAD: `b10834f5cc337a6abe203b83e874ddc488950e5b`; runtime: Node `v26.5.0`.

Outcome: adapter success requires a valid `done` payload, validated with the existing Hermes `DonePayload` schema loaded at invocation time. Invalid streams return `failed` with a stable `failure_code`: `missing_done`, `invalid_done_payload`, `duplicate_done`, `conflicting_terminal`, or `event_after_terminal`. The first detected violation stops consumption. Any second done is classified as `duplicate_done`, including conflicting statuses.

Compatibility: terminal error alone remains failed; error followed by done(failed) remains supported, retaining the error summary if done omits one. Usage events remain allowed before/between/after terminal events, using the existing latest-total accounting. Valid completed/failed/expired/cancelled outcomes, nonterminal error recovery, unavailable adapters, and thrown failures have passing coverage. Cancellation/timeout mechanisms and command execution were not changed.

## RED

Tests were added before implementation. Command:

```sh
node scripts/graph-test-env.mjs -- pnpm --filter @osstack/loop exec vitest run src/executor.test.ts
```

Actual result: exit 1; **34 failed, 12 passed (46)**. Empty/work-only streams returned completed; error→done(completed) and post-done work were accepted; malformed done payloads lacked deterministic classification. Error→done(failed) without a summary also lost the original error summary. Raw executor log: `/tmp/g01-executor-red.log` (temporary local evidence).

## GREEN

```sh
node scripts/graph-test-env.mjs -- pnpm --filter @osstack/loop exec vitest run src/executor.test.ts src/loop-engine.test.ts src/budget.test.ts
pnpm --filter @osstack/loop typecheck
git diff --check
```

Actual final results: tests exit 0, **93 passed across 3 files** (executor 46, LoopEngine 31, budget 16); duration 3.97s. Typecheck exit 0 (`tsc --noEmit`). Diff whitespace check passed. Test commands used the fixture's explicit fresh temporary `OSSTACK_HOME`; no default/serving database was used. Raw logs: `/tmp/g01-executor-green.log`, `/tmp/g01-executor-typecheck.log`.

Limits: targeted package coverage with fake adapters and temporary repositories; no real provider invocation, full monorepo suite, or Node 20/22 validation. No agent source changes, nested loops, commits, or task-status updates. Concurrent supervisor changes to baseline/evidence files were left untouched.

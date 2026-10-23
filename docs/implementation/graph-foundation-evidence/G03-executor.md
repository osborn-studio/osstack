# G03 executor evidence

Environment: macOS arm64, Node v26.5.0. Changes authored here: `packages/loop/src/executor.ts`, `packages/loop/src/executor.test.ts`, and this evidence file. Supervisor-owned status/review files were left alone; no commits, agents, or nested loops were started.

## G03 process control

- Shell commands start in detached POSIX process groups. External cancellation and timeout request group TERM, wait `terminationGraceMs`, escalate to group KILL, and wait `killGraceMs` (defaults 1,000ms each).
- Confirmation requires both the leader's `exit` event and `kill(-pgid, 0)` returning ESRCH. Pipe closure or successful signal delivery alone is insufficient. Normal leader exit with surviving descendants starts cleanup and returns failed (`surviving_descendants`), even when cleanup succeeds.
- Results include PGID, attempted signals, confirmation, and inspection evidence. Unconfirmed termination returns failed / `process_exit_unconfirmed` (exit 125); confirmed external cancellation returns cancelled (130); confirmed timeout remains failed (124). Unsupported Windows commands fail before spawn with `process_control_unsupported`.
- Real fixtures exercise children/grandchildren, ignored TERM requiring KILL, surviving descendants with inherited/closed pipes, a live leader with closed stdio, delayed graceful exit, and stable uncertainty after a later exit. Fault injection exercises EPERM and apparent group disappearance without leader exit. Fixtures have a safety timer plus `finally` KILL cleanup and PID-disappearance checks.

## Supervisor G02 review follow-ups (separate from G03)

Read `g02-review-followup.md`, including the Fable adjudication, before final validation.

- The bounded waiter Set was already present in the starting executor; retained it.
- Abnormal invoked-stream exits now signal cancellation, use bounded independent stop confirmation, preserve original protocol failure codes and error details, and expose `cancellation.stop_confirmed: false` when uncertain. Hanging iterator return cannot block completion. Confirmed abnormal failures remain failed. Normally closing terminal error / failed done behavior remains compatible.
- Grace expiry sets an irreversible flag before releasing waiters; waits and proof acceptance check it. Elapsed-time deadlines use `performance.now()`. Tests reproduce wall-clock rollback and independently watchdog real hanging next + hanging stop confirmation after done.
- Timer values outside finite `[0, 2^31-1]` use safe defaults: timeout 120,000ms; adapter/TERM/KILL grace 1,000ms. Zero requests immediate expiry. Invalid timeout/grace tests cover NaN, Infinity, negative, and overflow values.
- Malformed event objects and error/usage payload shapes return `invalid_event` with cancellation evidence. Existing well-shaped terminal classifications remain intact. Earlier assertions were updated for the requested error-abort behavior and preservation of `missing_done` alongside cancellation uncertainty.

## Actual RED / GREEN

All subprocess/DB-capable Vitest commands ran through `node scripts/graph-test-env.mjs --`, allocating an explicit isolated OSSTACK_HOME.

| Stage | Command after isolation wrapper | Observed result |
| --- | --- | --- |
| Initial RED, before executor edits | `pnpm --filter @osstack/loop exec vitest run src/executor.test.ts` | 15 failed, 69 passed (84 total), 24.54s. Included false completed with surviving descendants, absent cancellation/group proof, ignored TERM, and missing abnormal-stream abort. Safety cleanup completed. |
| Review RED | same command with `-t 'expired grace\|invalid adapter timer\|malformed event\|real timers'` | 13 failed, 1 passed, 84 filtered out. Rollback returned still pending; invalid timers cancelled prematurely; malformed events lacked stable classification. The real-timer done/hang guard already passed. |
| Shell timer RED | same command with `-t 'safe shell timeout'` | 4 failed, 98 filtered out; Node warned about invalid timers becoming 1ms, and commands returned 124 instead of finishing. |
| Executor GREEN | `pnpm --filter @osstack/loop exec vitest run src/executor.test.ts` | 102 passed, 2.19s. |
| Final affected GREEN | `pnpm --filter @osstack/loop exec vitest run src/executor.test.ts src/loop-engine.test.ts src/feedback.test.ts src/verifier.test.ts` | 161 passed across 4 files, 4.11s. |

`pnpm --filter @osstack/loop typecheck` passed (exit 0). `git diff --check` passed. No agents suite was rerun; no agents source changed.

## Limits and handoff

- Evidence covers the owned POSIX group, not deliberately detached/escaped processes, remote work, or a security sandbox. Pipe draining is bounded to 50ms after confirmed group disappearance; escaped pipe holders cannot keep the executor waiting forever.
- macOS was exercised here; no Linux/Windows runtime certification is claimed. The Windows refusal was fault-tested by substituting the platform value. Persistent zombies, permission failures, or otherwise unobservable exits remain unconfirmed and require reconciliation.
- Availability probes have no independent stop-proof contract; a hanging probe can remain uncertain with `invocation_started: false`. G04 must gate on `cancellation.stop_confirmed === false`, not only one failure-code string. This executor does not implement that future gate or mark plan tasks done.

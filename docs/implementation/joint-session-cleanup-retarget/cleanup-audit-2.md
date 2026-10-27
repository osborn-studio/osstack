# Review of #278 (Session start cleanup)

**Verdict: PASS.** I found no actionable P0/P1/P2 defect in this diff. This covers #278 only. The #276 R02 evaluator is not in the diff, so I did not review it.

## Checks against the code

- **Response preservation:** A `return` in the `try` or `catch` survives the new `finally`, because the inner `try/catch` swallows every cleanup throw. The old code would let a `release()` rejection replace a committed `ok` response. Now only the diagnostic is emitted.
- **Retained admission:** `retain()` sets `retained` and quarantines the repo before writing to stderr. A stderr throw is caught and the follow-up diagnostic is also swallowed. A `release()` failure sets `retained` and quarantines before rethrowing. In both cases the hold stays visible to drain, and the tests assert `execution_lease_holds: 1`.
- **Active-run marker:** The inner `finally` always clears `activeRuns` and requests the scan.
  - `requestSupervisionScan` cannot throw synchronously: `requestScan` rejects through a promise when stopped, and that rejection is caught.
  - The identity guard is unreachable today. `getSession`, the transaction and `activeRuns.set` run with no `await` between them, so a second request with the same `request_id` hits the existing-session branch first. It is harmless defensive code, and the same guard is in the send path.
- **Test coverage:** The new tests exercise four failure modes through the real RPC, SQLite and writer lock. They check that the DB row and run outcome match the response, that the diagnostic does not leak the prompt or native session id, and that replay does not re-invoke the adapter.

## Claim truthfulness

The changeset matches what the tests show.
- It claims only same-daemon drain visibility.
- It states that restart visibility and recovery are pending in DEBT02 and that no recovery API is added.
- It documents that replay is a state lookup, not a transport replay.
- It names #279 as separate.

I found no claim that locks are automatically recovered, and nothing from J01, J11 or J02a is absorbed.

## Observations, not defects

- **Replay semantics:** A failed initial start returns `agent_failed`, but replay returns `ok: true, state: "failed"`. This is existing behavior and now documented. It is a caller-contract wart, but changing it is out of scope.
- **Untested path:** There is no test for the abort-signalled path (client disconnect with `settled` true and `aborted` true) combined with a cleanup failure. It goes through the same code as `stop_unconfirmed`, so I rate it low risk.

## Deferred, not part of this PR

- #279 terminal-producer fence.
- DEBT02 restart and process-death hold visibility and recovery.
- Any change to `session.start` replay semantics.

END_AUDIT
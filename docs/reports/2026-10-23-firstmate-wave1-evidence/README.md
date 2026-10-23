# Firstmate adoption — first implementation wave evidence

This wave adds scoped Attention facts to the actual JSON/Web/TUI cockpit, coalesced supervision scans and terminal shutdown, bounded local notification batches, and real deterministic capability/profile routing evaluation. It depends on PR #237 (`2d33db37`); it does not merge or deploy that PR.

## Independent challenge records

- `cockpit/`: two Claude CLI challenges, browser paging/injection/offline evidence, bounded read-model benchmark and disposition.
- `supervision-next/`: two challenges and final lifecycle findings/disposition.
- `routing-next/`: real routing fixture outcomes, invocation-count scope, two challenges and disposition.
- `outbox-*`: initial caller-cancellation P1 and correction; repeat static review confirms no P0/P1. `outbox-disposition.md` states local-only delivery semantics and remaining limits.
- `wave1-integration-*`: root integration challenge and receipt-recovery correction. Raw results contain hypotheses as well as confirmed defects; the disposition is authoritative about what was reproduced and changed.

All review invocations requested `claude-haiku-5-5`. The CLI reported that identifier in modelUsage and emitted an unrecognized-model warning, retained verbatim. This records the request and response metadata, not an independent certification of model identity. Static review did not execute tests and does not replace GitHub independent approval.

## Qualification boundaries

The routing matrix is a deterministic regression suite, not a model classifier accuracy benchmark or independent holdout. Cockpit p95 is a local read-model measurement, not daemon RPC or long-duration qualification. Abort ends logical work; a non-cooperative underlying reader may remain physically pending. Notification retries require a local idempotent delivery ID and do not qualify public messaging. No production home was opened from a development checkout.

Full-check commands, exit codes, exact source manifest and native OSStack Loop verification receipts are archived alongside this report once the run completes. Prior draft/test failures remain in scratch and component audit records; they are not rewritten as successful attempts.

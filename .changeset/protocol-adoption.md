---
"@osstack/core": minor
"@osstack/loop": minor
---

Adopt `@osstack/protocol` additively (R1.2). Both packages now re-export the
kernel contracts under a `protocol` namespace (`export * as protocol`) and ship
pure, tested mappers from their own shapes to the protocol shapes — no breaking
changes, no consumer forced to switch. core adds `storedEventToEnvelope`,
`runRowToRunSummary` (finalized rows only; `expired` -> `failed`), and
`approvalRowToRequest`; loop adds `toProtocolTask` and
`completedTaskToRunSummary` (`escalated` -> `cancelled`).

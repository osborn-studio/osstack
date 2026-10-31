---
"@osstack/cli": patch
"@osstack/governance": patch
"@osstack/core": patch
---

Add the contained Mission runner. It advances one step at a time from workspace creation through qualification, a proxy executor turn, patch classification, exact host-side patch application and plumbing commit, to verification and repair cycles. Every executor channel is secret-scanned and redacted before anything is recorded, and decisions follow the W11 decision table.

Patch changes to the runner, patch applier, mission RPC and CLI now escalate to T2 in the Mission patch classifier.

The contained ledger now opens a stop obligation on entering `verifying` and requires container stop evidence before a verification result is recorded.

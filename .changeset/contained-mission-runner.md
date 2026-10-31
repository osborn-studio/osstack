---
"@osstack/cli": patch
---

Add the contained Mission runner. It advances one step at a time from workspace creation through qualification, a proxy executor turn, patch classification, exact host-side patch application and plumbing commit, to verification and repair cycles. Every executor channel is secret-scanned and redacted before anything is recorded, and decisions follow the W11 decision table.

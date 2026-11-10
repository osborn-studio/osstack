---
"@osstack/autonomy": patch
"@osstack/loop": patch
"@osstack/cli": patch
---

Add explicit foreground command-loop recovery with durable run and process receipts, preserved workspace evidence, and guarded exact-owner release. Allow contained descendants to drain before classifying a leader-exit failure. Recovery refuses absent or ambiguous producer evidence and does not use graph recovery authority.

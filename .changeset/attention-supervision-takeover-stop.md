---
"@osstack/cli": patch
---

Stop a superseded Attention supervision service as soon as it sees that a newer owner generation claimed the home. Its writes were already fenced; it now also clears its timer and aborts in-flight source reads and notification sends instead of polling until daemon shutdown, and later Attention RPCs report `stale_owner`. Write-lock contention and transient faults are not treated as a take-over.

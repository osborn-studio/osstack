---
"@osstack/cli": patch
---

The daemon now reports an Attention supervision service that a newer owner took over as `unavailable` (dashboard, daily, `health`) instead of `running`, and `osstack stats` gains an `attention` field with the take-over flag and the count and last message of errors a supervision pass swallowed.

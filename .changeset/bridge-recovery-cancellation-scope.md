---
"@osstack/cli": patch
---

Scope receipt recovery cancellation to one invocation so a cancelled direct factory call does not disable later recovery or live scans. Service shutdown still cancels shared read effects.

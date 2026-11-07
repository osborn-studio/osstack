---
"@osstack/cli": patch
"@osstack/core": patch
---

Recover pending revision push receipts before scheduling work, including stopped and closed chains. Confirm landed revisions without another push, preserve human stops, and keep remote receipt recovery independent of the live bridge switch.

---
"@osstack/core": patch
"@osstack/cli": patch
---

Preserve completed Git identity-query output when the daemon event loop stalls, while keeping bounded output and termination of hung queries. Reuse the guarded queries for repository policy checks and add macOS canonical-path regression coverage before merge.

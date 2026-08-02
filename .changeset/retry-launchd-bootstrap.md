---
"@osstack/cli": patch
---

Retry the transient macOS launchd bootstrap race after replacing a loaded
LaunchAgent, while preserving a bounded fail-closed installer error.

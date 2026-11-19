---
"@osstack/loop": minor
"@osstack/cli": patch
---

Carry loop budget usage and the consecutive no-progress streak across restarts. A successful cycle resets the streak. Debit each admitted cycle before work and stop before discovery when a limit is already reached. Daemon sessions report cumulative loop usage.

---
"@osstack/cli": patch
---

Return exit code 1 when any configured source cannot be checked by `osstack skills check`. Preserve exit code 2 for drift-only results and 0 for no drift or an empty list, and report failed checks separately from drift.

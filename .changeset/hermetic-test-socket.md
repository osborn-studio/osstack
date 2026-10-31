---
"@osstack/cli": patch
---

Clear `OSSTACK_SOCKET` in the CLI test setup so an exported socket cannot point the suite at a real daemon.

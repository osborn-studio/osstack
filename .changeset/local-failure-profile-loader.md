---
"@osstack/cli": patch
---

Add a disabled, host-installed verification profile loader that checks pinned artifact bytes, source identity, allowed arguments, and launch-time integrity. The loader returns immutable verification data without starting a process or activating local-failure intake.

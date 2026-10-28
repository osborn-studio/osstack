---
"@osstack/skill-registry": patch
---

Wait for Git output streams to close before interpreting tracked skill refs. Preserve command deadlines while output is still pending so a valid delayed ref is not misclassified as missing.

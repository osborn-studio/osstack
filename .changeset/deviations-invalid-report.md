---
"@osstack/agents": patch
"@osstack/hermes-adapter": patch
"@osstack/loop": patch
---

Preserve invalid implementation deviation declarations as a distinct verifier report issue. Keep valid entries, count invalid entries, and carry the report issue into iteration feedback without treating it as work failure.

Do not change code-fence handling for echoed declaration examples (review item 6).
Do not change mixed-kind problem merging or severity filtering (review item 8).

---
"@osstack/cli": patch
---

Revalidate receipt state after remote reads and before settlement so late concurrent recovery results leave already completed receipts unchanged instead of failing on terminal-state constraints.

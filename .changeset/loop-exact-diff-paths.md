---
"@osstack/loop": patch
---

Preserve exact file paths in Git diff discovery so long paths resolve to the changed file. Keep line-count priorities and skip binary records.

The diagnostic `context.diff_stat` value is now the raw numeric-stat record instead of a human display line.

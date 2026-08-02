---
"@osstack/governance": minor
"@osstack/cli": minor
---

Add an explicit, read-only Codex local generated-memory adapter for `osstack
neat`. The adapter inventories only an operator-selected directory, emits
portable metadata and hashes without file content, rejects symlink traversal,
and deliberately exposes no mutation or Claude-specific limit rules.

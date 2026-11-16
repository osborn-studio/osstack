---
"@osstack/loop": patch
"@osstack/agents": patch
---

Separate invalid reports from failed work. Repair builder and reviewer reports in the original adapter session up to twice, with budget accounting and repair events. Retain the candidate and deterministic evidence when a report cannot be repaired. Add report continuations for Claude Code and Codex CLI.

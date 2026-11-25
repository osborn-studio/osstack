---
"@osstack/agents": patch
---

A contained Codex executor now stops when the daemon that launched it dies: an in-group watcher reads a pipe held only by the daemon and, on end-of-file without a release line, signals its own process group (W13-E1).

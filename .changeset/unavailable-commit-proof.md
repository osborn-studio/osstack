---
"@osstack/loop": patch
---

Keep an isolated loop worktree when Git cannot commit its verified changes. A Git error while staging or committing is now treated as an unavailable proof rather than "no changes": the run still fails, but cleanup no longer force-removes the only copy of the verified work.

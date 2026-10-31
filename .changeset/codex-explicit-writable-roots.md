---
"@osstack/agents": patch
---

Let the Codex CLI adapter accept explicit `writableRoots` (at most eight existing, non-root, absolute directories, canonicalized) and pass each as `--add-dir` on exec and resume, allowed only with the `workspace-write` sandbox. No environment defaults are added; invalid or out-of-sandbox roots are rejected at construction.

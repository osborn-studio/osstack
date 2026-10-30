---
"@osstack/agents": patch
---

Allow callers of CodexCliAdapter to explicitly grant bounded additional writable directories for workspace-write invocations, including task-specific scratch directories. Keep the existing read-only default and never infer grants from environment variables.

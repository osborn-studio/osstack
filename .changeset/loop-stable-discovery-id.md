---
"@osstack/loop": patch
---

Derive git diff discovery IDs from the relative path, index blob, and worktree blob. Moving HEAD, changing diff settings, or moving the clone no longer changes an unchanged task ID. Queue items without an explicit ID now derive one from their relative file path and normalized content. Duplicate IDs within a cycle keep the first input task or source item and appear in discovery counts.

Completed IDs, including escalated tasks, remain skipped while their content is unchanged. The discovery report counts skipped escalated IDs. Change the content or run with `skipCompletedTasks: false` to retry them. Stale `in_progress` entries no longer block discovery and are cleared after a cycle.

Old random IDs do not match the new IDs, so currently dirty files are each discovered once after upgrading. Partial staging changes the unstaged content and creates a new ID. Fully staged changes remain outside `git_diff` discovery.

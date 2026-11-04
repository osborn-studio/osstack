---
"@osstack/cli": patch
---

Contained Mission PRs end with a single `<!-- osstack:mission v=1 ... -->` locator line, the goal and verification command are redacted and rendered on one line in the PR body, and `osstack mission status --json` reports a `publication` field (PR number, URL, pushed commit) without depending on the event tail.

---
"@osstack/cli": patch
---

Contained Missions can now open their PR: after approval (or a pre-authorized grant in the spec), the host re-validates the verified candidate, issues a single-use publication permit, and opens the PR through a fenced delivery runner. The runner journals each push and PR creation under the owner fence, re-checks the permit before each one, disables git hooks and refuses PR-changing gh commands. Authoritative delivery evidence is recorded before `pr_opened`. Nothing is ever merged.

---
"@osstack/core": patch
"@osstack/cli": patch
---

Add the read-only PR reader for the Grok bridge shadow reconciler (phase 4-C): a `gh api graphql` transport that refuses mutations, a complete paginated pull-request read (reviews, threads with nested comment paging, commits, timeline) that reports `complete: false` on caps or errors, `normalizeSnapshot` to the body-free `PrSnapshot`, a second-read move check, a host-private `producers.json` registry loader, and `scripts/record-pr-timeline.mjs` with a de-identifying fixture recorder plus the recorded #340-#363 decision corpus. `PrSnapshot` gains an optional `observed_at`. Nothing is wired into the CLI or daemon yet; the new modules are not imported eagerly.

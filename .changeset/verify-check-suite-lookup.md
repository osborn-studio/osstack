---
"@osstack/cli": patch
---

Find the existing `osstack/verify` check run through the head commit's check suites (this App's suites, then each suite's check runs, both paged and capped) instead of `commits/{ref}/check-runs`, which GitHub limits to a ref's 1,000 most recent check suites. A commit with many suites can no longer hide an existing check and cause a duplicate.

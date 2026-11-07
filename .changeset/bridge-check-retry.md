---
"@osstack/cli": patch
"@osstack/core": patch
---

Recover pending revision verification checks through a bounded live scheduler, preserve manual uncertain-check handling, and fence App B writes after token refresh. Deduplicate pending check registrations and permit evidence retries for earlier confirmed revision rounds.

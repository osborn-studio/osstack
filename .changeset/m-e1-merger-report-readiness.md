---
"@osstack/core": minor
"@osstack/cli": minor
---

The shadow merger report (`osstack mission merger report`) now decides `ready` or `not_ready` for the bot-merge design §6.1 shadow comparison: at least 20 sandbox Mission PRs with an evaluated shadow decision and a real outcome, zero `would_merge` PRs that were closed unmerged, and every `refused` decision carrying only known gate codes. When it is `not_ready` it lists what is missing. The report stays read-only and schema version moves to 2. `@osstack/core` exports `MERGE_GATE_REFUSAL_CODES`.

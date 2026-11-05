---
"@osstack/github": patch
"@osstack/cli": patch
---

Contained Missions can publish through GitHub Apps. When `$OSSTACK_HOME/bridge/apps.json` and `rulesets.json` are configured, App A pushes the Mission branch and opens the PR (only `git push` and `gh pr create` use its scoped installation token; reads keep host credentials), App B posts an idempotent `osstack/verify` check run on the published head, and `osstack mission publish-check --mission ID` retries a failed check. PR-only delivery no longer treats an `osstack/mission/…` candidate as protected when every applicable rule comes from a registered Mission ruleset.

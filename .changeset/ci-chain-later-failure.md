---
"@osstack/cli": patch
---

Record a later CI failure with a different check run on a root Mission that already recorded its first failure, instead of dropping it. The record is made once per check run, shows in `mission status`, `mission list --github-ci` and `osstack stats`, and does not dispatch a second repair or change any merge decision.

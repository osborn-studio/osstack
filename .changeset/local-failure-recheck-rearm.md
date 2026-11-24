---
"@osstack/core": patch
"@osstack/cli": patch
---

Add the operator re-arm of the host recheck (`mission recheck-rearm`, method `mission.rearm_local_failure_recheck`, only with the local-failure route switch on) and a read-only recheck view in `mission status`. A re-arm is held in memory, runs at the next recheck pass and is void after 15 minutes or a daemon restart.

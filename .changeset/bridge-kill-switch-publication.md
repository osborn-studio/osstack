---
"@osstack/cli": patch
---

`OSSTACK_BRIDGE=0` (explicit) is now a real kill switch for first-round Mission publication. When `$OSSTACK_HOME/bridge/apps.json` and `rulesets.json` are present, publishing a Mission PR to the configured repository is refused with the fixed code `BRIDGE_DISABLED` before any App A token, push, PR or App B `osstack/verify` check, and never falls back to the host's own `gh` credentials; the Mission halts through the existing path as `awaiting_decision(publication_failed:BRIDGE_DISABLED)`, visible in `mission status --json`. Repositories outside the bridge config keep their current refusal, `OSSTACK_BRIDGE` unset or `shadow` is unchanged, `1` or an invalid value still fail the service start. The switch is read once at service start, so changing it needs a restart. Runbook `docs/runbooks/bridge.md` updated (switch table, kill-switch procedure).

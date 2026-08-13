---
"@osstack/cli": patch
---

`osstack upgrade` now provisions, backs up, and health-checks against the DEPLOYED daemon's OSSTACK_HOME instead of the caller's shell environment. Resolution priority: the launchd plist's env (how the daemon is actually started) → the role file next to the current global binary (captured before npm wipes it) → caller env/default. Previously, running the upgrade from a shell without the daemon's env re-provisioned the control-plane role file for the default `~/.osstack` while the daemon serves another home — the guard then refused every boot, the health check failed, and the rollback re-provisioned wrongly too, leaving the daemon down (incident 2026-08-12, 0.16.1 → 0.17.0). The same fix protects the unattended launchd auto-upgrade path.

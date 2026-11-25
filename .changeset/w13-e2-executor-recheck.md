---
"@osstack/cli": patch
---

The daemon's per-minute stop re-check now also settles a contained Mission whose only unproven stop is an executor process group, once that group is gone, so it no longer waits for a manual `retry_stop_check` (W13-E2). The re-check still only observes and never signals.

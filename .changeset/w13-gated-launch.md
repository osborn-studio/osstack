---
"@osstack/agents": patch
---

Add the W13-B gated host-process launcher (`/bin/sh` wrapper that blocks on a release line, hold-marker fd 3, ps/lsof/boot-session probes, stop classifier) and an optional `gate` for `runHardenedGit`. Nothing is wired into the Mission runner yet.

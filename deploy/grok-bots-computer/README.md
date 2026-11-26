# Rootless Docker sandbox drill

Use these scripts only for the sandbox drill on the shared Grok Bots computer.
See conditions 4, 5 and 7 in the [design note](https://github.com/osborn-studio/osstack/blob/main/docs/design/2026-11-25-b9-sandbox-shared-computer.md).

The owner, or a Bot at the owner's request, copies the three scripts from a
pinned, reviewed commit to `/home/box/osstack-verify-docker/`. Before every
session, run `sha256sum -c /path/to/SHA256SUMS` in that directory. Use the
manifest from the same pinned commit. Stop if any hash differs.

Run as `box` (uid 1000), in this order.

1. `./start.sh` starts the user manager and rootless Docker. It checks the
   cgroup driver and reports the server version and daemon ID.
2. `./check-limits.sh 'name@sha256:<64 hex>'` checks free disk space and
   inodes, cgroup limits, network isolation and the OOM kill. Use a locally
   available image with `sh`, `cat`, `ls` and GNU coreutils `tail`. Run this before each harness run.
3. `./stop.sh` stops Docker and checks for surviving session processes.

`SHA256SUMS-installed` records the versions installed on 2026-11-25.
`SHA256SUMS` supersedes those hashes once the new scripts are installed.

---
"@osstack/cli": patch
---

Fix four operational defects found auditing a live install where `osstack status` reported "daemon: not running" against a healthy daemon that had been refusing all work for 12 hours.

- **CLI now addresses the deployed daemon.** A plain shell exports neither `OSSTACK_HOME` nor `OSSTACK_SOCKET`, so `paths.ts` resolved `~/.osstack/daemon.sock` while launchd served a different home — every daemon-touching command misreported, and `doctor` printed the wrong socket. Discovery (launchd plist → role file beside the running binary) now fills only what the caller left unset, so explicit dev/test homes still win. Kept subprocess-free to stay inside the 150ms startup budget.
- **`doctor` no longer reports ok while the daemon is draining.** A draining daemon refuses sessions and task submissions; doctor called it ok and recommended queue work that would be rejected. It is now an error finding with the disk remedy attached.
- **A health-raised drain clears itself.** `drain_required` was a one-way latch: dipping below the 2 GiB autonomy floor set `draining` and nothing ever cleared it, so the daemon kept refusing work long after the disk recovered. Health-raised drains now lift when health recovers; operator/upgrade drains still never auto-clear, so `osstack upgrade` stays quiesced mid-swap.
- **Shadow checkpoints stop filling the disk.** `checkpoint create` excluded only `.git`/`node_modules`/`.osstack`, so virtualenvs, build output and caches were copied wholesale — one checkpoint reached 14 GB and 109 unpruned checkpoints consumed 19 GB, which is what pushed the disk under the drain floor. Common build/venv/cache directories are now excluded and only the newest 20 checkpoints are kept.

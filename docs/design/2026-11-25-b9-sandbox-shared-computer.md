# B9 amendment: the sandbox drill on the shared Grok Bots computer

Date: 2026-11-25. Status: owner-requested amendment. **Sandbox only.** It changes no code.

Amends: [verification publisher runtime](2026-11-24-verification-publisher-runtime.md) §5.1, §5.7, decision 6 and §10 item 9; [harness runbook](../runbooks/bridge-verification-harness.md) §2 and §9; [publisher runbook](../runbooks/bridge-verification-publisher.md) §3; [drill checklist](../plans/2026-11-25-sandbox-drill-checklist.md) §2.

## 1. What the owner decided

The owner wants the cloud side of the drill (the harness and the publisher) on the Grok Bots cloud computer and accepts that the Bots can read the verification App's key there. The owner's words were relayed from another session on 2026-11-25:

- "去想办法把云端放在 Grok Bot 的虚拟机里吧，我支持这么去做"
- "我觉得读到私钥也没有太大问题的吧"
- "继续试 Grok 电脑" and "做成脚本", for the rootless Docker setup below

In the orchestrating session the owner then asked for this amendment: "写沙箱专用的修订说明".

## 2. What that computer is

A Bot on that computer reported these facts on 2026-11-25. Nobody has checked them independently.

- Debian 13, 8 CPUs, about 16 GB memory, 50 GB disk free, inodes about 90% used.
- One OS user, `box` (uid 1000), with passwordless `sudo`. All Bots of the account share the computer and its credentials. The vendor states that Bots are not a security boundary, and that an update, Recover or Reset removes installed packages.
- Process 1 is `tini`, not systemd. Rootless Docker (docker-ce 29.10.1) runs as `box`. It is started by `/home/box/osstack-verify-docker/start.sh`, which:
  - enables the cpu, memory and pids cgroup controllers with `sudo`
  - starts `systemd --user` in a private mount namespace
  - starts the Docker user service

  `stop.sh` takes it down. With this setup a container gets `memory.max` 134217728, `pids.max` 64 and `cpu.max` "100000 100000". A memory hog is killed with exit 137 and `OOMKilled: true`.
- Neither script is in this repository or has been reviewed. Only SHA-256 prefixes were captured.

## 3. Which rules this replaces, for the sandbox only

| Recorded rule | Where | Sandbox replacement |
|---|---|---|
| The key does not pass through a model, and the Bots' OS user cannot read it | publisher runbook §3; checklist §2 | The Bots can read the key, as root. Nobody asks a Bot to read, print, copy or use it, and no Bot prompt names its contents. The owner still places it by hand; it still never enters this repository, a chat or the host. |
| Two OS users besides the Bots' user, neither able to read the other | design §5.1 arrangement 2, decision 6; harness runbook §2; checklist §2 | One user, `box`. The harness and the publisher both run as `box`. The drop directory keeps mode 2750 and request files keep 0640, but the group gives no separation. |
| The harness user cannot read the key, the ledger or the allowlist; recorded refusals | design §10 item 9; harness runbook §9 preparation | Cannot pass, and is not attempted. Instead, record `id`, that `sudo -n true` succeeds, and the list of Bots on the account at the start of the drill. |
| No rootful Docker on the computer that holds the key | decision 6; harness runbook §2 | **Unchanged.** Before every step, check that no rootful `dockerd` runs and `/var/run/docker.sock` does not exist. |

Everything else in B9 stays as written:
- the publisher's repository refusal (§3.5)
- the container flags
- the fail-closed checks before candidate code runs
- the request file contents
- the evidence rules

## 4. What a sandbox result on this computer proves

Any Bot, and any code that escapes a container, can act as root here. Root can read the key and the attempt ledger. So a check run from this computer can be forged, including a false `passed`. Two consequences:

- **What the drill still proves:** that the parts work end to end. That covers design §10 items 1–8 and 10–12: the token, the check run and its read-back, the response shapes, the host reader, the container contract on this Docker, the fetch by SHA, reproducibility, impostor rejection and delay.
- **What it does not prove:** that the cloud result is independent of the Bots. The safety of a repair still rests on the three later gates, which this amendment does not touch: the host's own recheck in its own container, the Actions result, and a counted human approval (design §5.1, last paragraph).

A result from this arrangement is never evidence for any repository other than `osborn-studio/osstack-bridge-sandbox`. It does not satisfy decision 6 for any later repository either.

## 5. Conditions

The drill on this computer runs only while all of these hold. If one fails, stop at that step.

1. **Scope.** The verification App is installed on `osborn-studio/osstack-bridge-sandbox` only. The owner reads the installation's repository selection back before step 0 and records "only selected repositories: osstack-bridge-sandbox". The publisher's allowlist names only that repository.
2. **A drill-only key.** The owner generates a new private key for the verification App for this drill and uses it nowhere else. The owner records its SHA-256 fingerprint as GitHub shows it; a fingerprint is not secret. The App's other keys are never placed on this computer.
3. **Revoke after use.** The owner deletes that key in the App's settings:
   - when the drill ends
   - at the first unexpected result
   - if the list of Bots on the account changes during the drill
   - on any sign that a Bot touched the key or the ledger

   The owner records the deletion time. A new drill needs a new key.
4. **Reviewed scripts, pinned by hash.** Before step 0, the full text of `start.sh` and `stop.sh` goes into this repository by a reviewed PR. Before each drill session, the SHA-256 of both files on the computer must equal the repository copies, or the session stops. The Bots can edit those files, so the hash check is the only thing that ties the run to the reviewed text.
5. **Limits checked every session.** After `start.sh`, and before any harness run:
   - a test container with `--network none --memory 128m --pids-limit 64 --cpus 1` must show 134217728, 64 and "100000 100000"
   - a memory hog in it must end with `OOMKilled: true`

   The executor's own `HostConfig` comparison (`contained-command.ts:127`) does not prove the limits are enforced, because it reads back stored settings. A failure here stops the session; nothing falls back to relaxed flags.
6. **Nothing survives a restart.** Sleep, an update, Recover or Reset can remove the Docker setup and possibly files. Run `start.sh` and condition 5 again after any of them.
   - Copy the attempt ledger off the computer after each publisher step.
   - If the ledger is lost or does not match the last copy, stop. Do not publish again for a head that already has a published or unresolved attempt.
7. **Disk.** Before each harness run, check that at least 100,000 inodes and 5 GB are free. A full disk here ends in an unknown state, not a clean refusal.
8. **Not live outside the drill.** The publisher and the harness are started for drill steps only. No routine or Watcher trigger calls them before drill step 11, which itself needs the owner's approval.

## 6. Production is unchanged

Decision 6 stands for every repository other than the sandbox. That means two OS users at least, and a separate machine before any repository that receives PRs from outside this system. A key that the Bots can read is never acceptable there. Before any repository other than the sandbox is configured, this amendment has to be withdrawn, and the drill key deleted.

## 7. Open

- Condition 4 needs the scripts' full text. Until it is in the repository, drill step 0 cannot start.
- Whether the executor's other flags and the stop receipt work under this rootless setup (design §10 item 7). Only the limits have been tested; the harness has not run here.
- Whether files under `/home/box` survive Recover or Reset. The vendor documentation names installed packages only.

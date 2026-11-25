# W13-E design: stopping a contained executor that outlived the daemon

Date: 2026-11-25. Baseline: `main` `21a31832`. Line numbers refer to that baseline.
Parent documents: [W13 design](2026-11-06-w13-host-git-survival.md) (below "W13"), the
[chain-decide idempotency note](2026-11-25-chain-decide-idempotency.md) (U3 T6, on
`feat/chain-decide-idempotency` until it merges), and the plan
[`2026-11-16-osstack-self-loop-upgrade.md`](../plans/2026-11-16-osstack-self-loop-upgrade.md).
Status: design only. No code in this node.

## 1. Problem

A contained Mission's Codex executor runs in its own session and process group
(`codex-proxy.ts` L270, `detached: true`). Only the daemon that launched it can stop
it: `runner.cancel` (`contained-mission-runner.ts` L552–560) aborts the in-memory
controller in `this.live`, and `runGroup` (`codex-proxy.ts` L279–300) signals the group
while it is still the parent. When the daemon dies, nothing is delivered to the group
and the executor keeps running.

Evidence (U3 T6, `packages/cli/src/contained-mission-grant-crash.test.ts` on
`feat/chain-decide-idempotency`): the daemon is killed after a revision chain closed
(`closeLive`) and before the host cancelled the current child. On restart:

1. `ContainedMissionHost.recover()` → `recoverOne` → `settleStop` → `stopProof`
   (`contained-mission-host.ts` L265–267, L412–442) finds the recorded executor group
   non-empty and halts the child in `stop_unknown`
   (`executing_stop_unproven_after_restart`, `stop_obligation: 1`).
2. `StoppedChainScanService` skips the manually closed chain.
3. The executor's group is still alive (`processGroupEmpty(pgid) === false`).

The same window exists for any daemon death while an executor turn, a repair turn
(`codex-proxy.ts` L135) or a capability probe (L175) runs. The orphan cannot write the
Mission branch through the host (the claim and the write fence hold, W11 §9), but it
keeps the worktree busy, burns model budget, and holds the Mission in `stop_unknown`
until a person finds and kills it by hand.

## 2. What exists

| Piece | Where | What it does to a live orphaned group |
|---|---|---|
| Launch record | `runner.ts` L634, L676–678 record `executor_started` with `{ pid, pgid, started_at }` (`codex-proxy.ts` L277: `started_at` is the daemon's `Date.now()`) | Nothing. No `boot_id`, no `ps` start time, no hold marker: the executor is not a W13 host-process row (W13 §2 lists it as "not covered (already exists)") |
| Restart stop proof | `stopProof`, `host.ts` L412–442 | Observes only: `groupEmpty(pgid)`; non-empty → no proof → `stop_unknown` |
| `recover()` | `host.ts` L221–277 | Observes only (W13 §5.2 "recovery never signals", owner decision 1, 2026-11-06) |
| `retry_stop_check` | `host.ts` L180–191 → `settleStop` → `stopProof` | Observes only; throws `CONTAINED_STOP_UNPROVEN` while the group is alive |
| `abandon` | `runner.ts` L376 (`stop_unknown` → `abandoned`) | Sends nothing. The DDL lets a terminal Mission keep `stop_obligation=1` (`engineering-contained-ddl.ts` L31–32), the claim stays active, and recovery keeps probing it (`host.ts` L247–259) |
| `cancel` | `runner.ts` L552–560 | Aborts only a live handle; after a restart `this.live` is empty, so it moves to `cancel_requested` and waits for proof |
| Periodic re-check | `HOST_PROCESS_RECHECK_MS = 60_000` (`contained-mission-rpc.ts` L398, wired at L544); `tick` → `recheckCandidates` (`host.ts` L200–203, L392–403) | **On in the daemon** (owner decision 2a, 2026-11-07). The comment at `host.ts` L32–35 ("off by default: that decision is still open") is stale. Two limits: it only visits Missions with an open **host-process row** (`missionsWithOpen`, `engineering-host-process-store.ts` L87–91), so an executor-only Mission is never re-checked; and it only observes |
| W13 host-process proof | `classifyHostProcess` (agents `host-process.ts`), marker files, `boot_id`, `leader_start` | Applies to git/gh host writes only. Recovery never signals them either |

The T6 test builds `ContainedMissionHost` without `hostProcessRecheckMs` and spawns
its fake executor directly, so it would show the same result with the daemon's
60-second re-check. Turning the re-check on is not enough by itself.

## 3. The rules any fix must keep

- **R1. Never signal a pid or process group that may have been reused.** macOS has no
  pidfd. `ps lstart` has one-second resolution (`graph-process-identity.ts` L24–40).
  A check followed by `kill` from outside the group always leaves a gap in which the
  group can empty and its number be reused.
- **R2. Prove the group is ours through a marker, not through a number.** W13 §4.1:
  the proof rests on something only our launch holds (an inherited descriptor), not on
  a pid read back from the ledger.
- **R3. Recovery observes; it never signals** (owner decision 1, 2026-11-06). A fix
  that changes this needs a new owner decision.
- **R4. The stop proof stays as strong as today** (`group_empty+sandbox_inherited`,
  W11 §9): a fix may add ways to stop a group, but never a new way to *declare* it
  stopped.

## 4. Options

### A. Periodic re-check, extended to executor groups

The 60-second re-check already runs. Extend `recheckCandidates` to include Missions
in `stop_unknown`, `cancel_requested`, or terminal with `stop_obligation=1` whose last
`executor_started` group is now empty (one `kill(-pgid, 0)` each, as today; paged
like `listOutstanding`), and settle them through the existing `recoverOne`.

- Rules: R1–R4 are kept trivially, because nothing is signalled.
- Effect: the Mission settles by itself within a minute of the group going away
  (killed by a person, or by D below), with no `retry_stop_check`.
- Limit: **this stops nothing.** It completes D; it does not replace it.

### B. Recovery signals the recorded group when its chain is closed or the Mission is abandoned

Recovery would `kill(-pgid, SIGTERM/SIGKILL)` for the recorded `executor_started`
group when the Mission is a child of a closed chain or is `abandoned`.

- Identity: the ledger holds only `{pid, pgid, started_at}`. To meet R2 the launch
  would first need a W13-style hold marker inherited by Codex, plus `boot_id` and
  `leader_start`, and recovery would need `lsof` to show a holder of the marker whose
  pgid equals the recorded pgid.
- R1 still fails: `lsof`, then `ps`, then `kill` are three separate reads by an
  outsider. Between the last check and the `kill`, the group can empty and the number
  can be reused. W13 §5.2 rejected exactly this ("the race between finding a pid and
  signalling it").
- R3: it reverses owner decision 1. It also couples host recovery to chain state
  (the chain store is not a host dependency today).
- **Not recommended.**

### C. `retry_stop_check` or `abandon` signals the group

This is the same mechanism as B, triggered by a person.

- It has the same identity problem and the same R1 gap. A person triggering it lowers
  how often it runs, not the risk each time.
- `abandon` on live revision chains is now a remote answer (T6 decision 1, accepted
  2026-11-25). Signalling from `abandon` would let a Grok Bot answer send signals to
  host processes, a power remote answers do not have today.
- **Not recommended.**

### D. A watcher inside the executor's group that stops the group if its daemon dies (recommended)

`runGroup` launches every executor through a constant `/bin/sh` wrapper that, before
`exec`ing Codex, forks a **watcher** that stays in the same process group. The watcher
blocks reading a pipe (fd 3) whose only write end is held by the launching daemon:

```
/bin/sh -c '<watcher> & exec 3<&- "$@"' osstack-executor <grace_s> <codex> <args…>
watcher:  trap "" TERM; IFS= read -r line <&3
          [ "$line" = release ] && exit 0
          kill -TERM 0; sleep <grace_s>; kill -KILL 0
```

(The exact text is fixed in the implementing PR after the macOS probe in §5. POSIX
gives an async list `/dev/null` as stdin, which is why the pipe is fd 3 and not
stdin.)

- **Daemon death:** the kernel closes the daemon's descriptors, the watcher reads EOF,
  and it signals **its own** group (`kill 0`), waits the grace period and kills it.
  No timeout and no new owner are involved.
- **Normal end:** when `runGroup` observes the leader's `exit` (L294), it writes
  `release\n` and closes the pipe. The watcher exits, and the existing
  grace/TERM/KILL/`waitEmpty` sequence (L297–299) runs unchanged, so the in-process
  proof is the same as today.
- **Abort/timeout:** this path is unchanged (`stop` at L289). The daemon's TERM reaches
  the watcher, which ignores it. The daemon then sends `release` once the leader exits,
  or its SIGKILL takes the watcher with the group.
- **Identity:** `exec` keeps the wrapper's pid, so `launch.pid = launch.pgid` is still
  the Codex pid and `executor_started` does not change. `stopProof` and the stored
  events stay as they are.
- **Scope:** every `runGroup` caller gets the watcher: turns, repair turns, `--version`
  and the sandbox probe.

How D keeps the rules:

- **R1.** The only signal it adds is `kill(0, …)`, sent by a live member of the group.
  A process group cannot be reused while it has a member (POSIX; W13 assumption A1),
  so the target is always the original group. No pid or pgid is read back from
  anywhere.
- **R2.** The marker is the pipe. Only the launching daemon holds its write end: Node
  creates stdio pipes close-on-exec in the parent, so no other child inherits them
  (W13 §4.1 relies on the same property). "EOF without `release`" can only mean that
  this daemon is gone. Nothing outside the group decides to signal.
- **R3.** Recovery, `retry_stop_check` and `abandon` stay observation-only. By the time
  the restarted daemon runs `recover()`, the group is normally already empty, and
  `stopProof` gives `group_empty_after_restart` as it does today.
- **R4.** No new proof kind. The watcher only makes the existing proof succeed.

Residual gaps, which D narrows but does not close:

1. A descendant that leaves the group (`setsid`) is not reached. This is the same
   limit as today's `group_empty+sandbox_inherited` proof.
2. If the daemon dies after writing `release` but before the post-exit sequence proves
   the group empty, leftover members after the leader's exit survive. Restart then
   observes a non-empty group and holds `stop_unknown`, as today. This window is at
   most about three grace periods (L297–299).
3. Anything that kills the watcher itself (an outside `kill`) falls back to today's
   behaviour.
4. A hung daemon that is not dead keeps the pipe open. It still owns the executor and
   its live handle, so this is not an orphan.

Behaviour change: any daemon death (crash, `kill -9`, upgrade rollback) now stops the
running executor within one grace period instead of leaving it running. A graceful
`close()` still waits for steps in flight (`host.ts` L235–238). Restart recovery never
resumes execution (W11 §9), so an orphaned turn's output was never used. Nothing of
value is lost.

### Not touched: W13 host-process rows

Released `git push`/`gh pr create` rows keep the W13 behaviour: a gated wrapper that
was never released exits on EOF, while a released one runs to completion and is
observed. Killing a push mid-flight would not make the remote outcome known (W13
§6.3). That decision stays as it is.

## 5. Tests

Real-process tests run on macOS and on Linux CI. They use a fake executor binary (a
Node script that starts an in-group grandchild and sleeps), launched through the real
`runGroup` from a short-lived "daemon" child process that the test then kills with
`SIGKILL`.

| # | Test | Asserts |
|---|---|---|
| T1 | Daemon `SIGKILL` during a turn | Within grace + 1 s, the recorded group (leader and grandchild) is empty |
| T2 | Normal exit | The watcher exits on `release`; `stop.stop_proof` is `group_empty+sandbox_inherited`; `signals` is empty; no extra grace delay (time bound) |
| T3 | Abort and timeout | Same outcome and `signals` sequence as today |
| T4 | Leader exits and leaves an in-group member | The existing grace/TERM/KILL path still proves the group empty, so the watcher does not hold it open |
| T5 | Write end is not inherited | The test daemon spawns an unrelated long-lived child after the executor, then is killed; T1 still holds, so no one else held the write end |
| T6 | U3 T6 crash test | Launch the fake executor through the real launcher instead of a direct `spawn`. After the worker's death the group is empty; `recover()` moves the child to `needs_reconciliation` (`orphaned_executing`); the final assertion flips to `processGroupEmpty(pgid) === true` |
| T7 | Option A | With an injected `groupEmpty`, an executor-only `stop_unknown` Mission settles on the first `tick` after its group empties, not before; a `process.kill` spy is never called |
| T8 | Static guard | `contained-mission-host.ts`, `contained-mission-runner.ts` and the decision paths contain no `process.kill(`; the wrapper script is a constant containing `kill -TERM 0` and no interpolated pid |
| P1 | macOS probe (manual, results recorded in the PR) | `/bin/sh` on macOS: fd 3 reaches the async list, the subshell `trap` holds, `exec 3<&-` closes it for Codex, and Codex's seatbelt-sandboxed children are in the group |

Mutation checks (written into the PR description; each must make a test fail): the
watcher ignores EOF (T1); `release` is sent before the leader's exit (T4); the pipe is
inherited by later children (T5); the watcher signals a pgid number instead of `0`
(T8); the re-check visits only host-process rows (T7).

## 6. Delivery

Two PRs, one node each. Code by Codex CLI (gpt-6.2-astra, medium) under the heavy-job
lock.

| PR | Content | Files |
|---|---|---|
| W13-E1 | Watcher in `runGroup`; T1–T6, T8, P1; fix the stale comment at `host.ts` L32–35 | `packages/agents/src/adapters/codex-proxy.ts`, a new `codex-proxy-watcher.real.test.ts`, `packages/cli/src/contained-mission-grant-crash.test.ts`, `contained-mission-host.ts` (comment only) |
| W13-E2 | Option A: the re-check also visits executor-only Missions; T7 | `packages/cli/src/contained-mission-host.ts`, `contained-mission-host.test.ts` |

E1 does not depend on E2. E1 touches the T6 test, so it lands after
`feat/chain-decide-idempotency` merges, or rebases onto it.

## 7. Decisions for the owner

1. **Approach.** (a) Recommended: D, a watcher inside the group that stops it when its
   daemon dies. Keep "recovery never signals" (decision 1, 2026-11-06), and reject B
   and C. (b) B or C, which reverses decision 1 and accepts a check-then-kill gap on
   macOS.
2. **Extend the re-check to executor groups (option A) as W13-E2.** Recommended: yes,
   as a separate PR after E1. Alternative: no, and settle by `retry_stop_check` as
   today.
3. **T6 test.** Recommended: in E1, launch its fake executor through the real launcher
   and flip the final assertion to "group stopped". Alternative: keep the direct spawn
   and reword the comment to say it bypasses the launcher.
4. **Child of a closed chain after a proven stop.** After E1 it lands in
   `needs_reconciliation`, with `abandon` in the decision inbox, because the lost
   cancel is not replayed (T6 decision 2). Recommended: keep it; one inbox answer
   closes it. Alternative: recovery cancels a proven-stopped child of a closed chain.
   That is a new chain-to-host coupling and would be its own node.
5. **Watcher grace.** Recommended: the executor's existing `terminationGraceMs`,
   passed as an argument. Alternative: a fixed 2 s.

**Record (2026-11-25).** The owner accepted the recommended option for all five:
(1) approach D, keeping "recovery never signals" and rejecting B and C; (2) E2
extends the per-minute re-check to executor groups, as a separate node after E1;
(3) the T6 test launches its fake executor through the real launcher and asserts
the group stopped; (4) a proven-stopped child of a closed chain lands in the
decision inbox and is answered `abandon` once, recovery does not cancel it;
(5) the watcher grace is the executor's existing `terminationGraceMs`. Because
`feat/chain-decide-idempotency` (#553) had not merged when E1 started, E1 is based
on `main` and the T6 test change (decision 3) follows once #553 merges.

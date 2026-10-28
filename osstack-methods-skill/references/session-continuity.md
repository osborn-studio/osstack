# Session continuity

Use this method to recall relevant work, resume an interrupted task, hand it off, or pause it safely. Keep the original goal and existing authorization. A request for a recap or handoff alone does not authorize executing the proposed next action. An already authorized continuation does not need a new approval merely because the session changed.

## Recover the smallest useful trail

Start with the supplied handoff, task record and actual checkout. Identify the repository, task, branch/worktree, last inspected revision, outstanding work and decisions. Use the host's available history tools for this task and workspace only. Read indexes and targeted sections before large transcripts; stop when the resume point is clear. Do not assume a Cursor transcript path, connector, model or native worker exists.

Separate what the previous worker reported from what its original artifacts show. Preserve evidence pointers, content hashes, command results and timestamps. Read the underlying command or artifact when a summary claims a consequential action occurred. An unread or inaccessible record is not evidence that the action never happened. Follow the [evidence rules](evidence.md) for supplied/read/verified distinctions and sensitive data.

## Reconcile before continuing

Check the current state that can invalidate the next action:

- Repository and worktree identity, current branch/HEAD, dirty files and who owns them. Re-read applicable repository instructions. Inspect the latest main and PR base/head/status/checks through available Git/forge tools; record the observed revision and time. A stale local tracking ref is not a live main observation. If remote access is unavailable, label it and avoid actions that depend on an assumed merge.
- The task's current owner and exclusive write boundary. Compare the handoff with actual coordinator/task/backend state where available. A quiet chat, a closed tab or a historical assignment does not show that a worker has relinquished a resource. Coordinate overlapping work before writing it; continue independent work within the known boundary.
- Pending commands, external effects, locks, holds and producers. Record exact known task/run/effect/resource identifiers and current observations. A missing result or unknown producer remains unknown. Do not replay an action, release a lock, clear a hold or mark completion because its session ended. Use only an existing authorized recovery mechanism with its required evidence; otherwise preserve the obligation and report the blocked dependent step.

For ordinary file work, current scope and a clear write owner are enough to continue. This method adds no principal certification or new identity approval step. It also cannot substitute a narrative for a runtime recovery receipt or a frozen joint gate. If a historical report conflicts with current evidence, retain both and explain the discrepancy instead of editing the history into agreement.

Reuse valid prior checks bound to the same artifact and conditions. Re-run the checks affected by a changed base, candidate, dependency, environment or unresolved claim. Do not rerun every old investigation merely to recreate context. Never carry a baseline pass forward as a pass for a changed candidate.

## Resume or hand off one concrete next step

State the completed work, inherited evidence, new observations and remaining uncertainty. Route the remaining work through the existing methods: [investigation](investigation.md) for unresolved facts, [bug fix](bug-fix.md) for a confirmed defect, or the requested implementation or verification path. Continue authorized work without inventing a fresh project or duplicating another worker's slice.

A compact handoff records:

- Goal, current scope and outstanding user-owned decisions; exact prior authorization where relevant.
- Repository/worktree/branch/HEAD and PR identity, with observation time and access limits.
- Current owner/write boundary; live or unknown commands/resources and their last observed identifiers.
- Completed, pending, failed, blocked and not-run work; evidence paths/hashes and the candidate each result covers.
- Unresolved holds and recovery obligations, cleanup already confirmed versus still pending, and the first safe next action with its prerequisite.

Store a durable note in the task's agreed location or owned scratch area under repository rules. Keep credentials and unnecessary private transcript content out of the handoff. Do not overwrite a central ledger or another worker's note unless that is within the assigned write scope.

## Pause only when requested

“Keep working while I am away” is not a pause request. For an explicit pause, stop starting new work and reach a safe atomic boundary where possible. Use the available host controls only for your owned work and authorized child tasks. Record what the control returned and inspect the actual backend/process when available. A cancellation request, terminal closure or ended conversation is not proof that child processes or external effects stopped. If stopping is unconfirmed, retain the exact known identifiers and cleanup obligation; do not delete the evidence needed to reconcile it later.

Preserve owned edits through the repository's permitted mechanism. Do not blanket-stage another worker's changes or force a WIP commit, push, PR, merge, reset or lock release merely to pause. Record uncommitted or broken state honestly. Remove only owned scratch resources whose completion and safe cleanup are established; preserve unfinished work according to the repository's worktree rules. End with what is durable, what remains active or unknown, and the resume point. Paused is not completed.

This is shared method guidance, not a persistent supervisor, automatic session restore, process fence or runtime recovery implementation. The [pinned sources](sources.md) identify the pstack and Firstmate material studied and the limits of this adaptation.

# U5: what is left of "repair the report, not the work"

Date: 2026-11-24. Status: proposal. Nothing here is implemented. §6 lists the decisions the owner has to make; every other choice in this note is a recommendation of the designing session.

Baseline: `main` at `7f674681`. Parent: [self-loop upgrade plan](../plans/2026-11-16-osstack-self-loop-upgrade.md) §4 U5 and U7.

## 1. Where U5 stands

An audit on 2026-11-24 compared `main` with the plan's five changes and its acceptance text.

| Plan item | State | Where |
|---|---|---|
| A failure class for "work done, report invalid" | done for the loop | outcome `report_invalid`, `packages/loop/src/executor.ts` |
| Report-only repair, loop builder | done (#451) | `repairBuilderReport` in `loop-engine.ts`, `resumeReport` on the adapter |
| Report-only repair, reviewer | done (#451) | `verifier.ts`, two attempts, the reviewer is retried, not the builder |
| Deviations declaration has its own failure code | done (#448) | `deepseek-command.ts` |
| Report-only repair, contained Mission | **not done** | `contained-mission-runner.ts`, `patch_invalid:<reason>` |
| Stop with the workspace kept and a decision card | partly | see §4 |

Checked by tests on `main` (`@osstack/loop` 31 files, 619 tests): one build, one iteration, at most two repairs, workspace kept, a repair that changes the workspace or uses a tool is refused. The seeded loop simulation passed 102,400 steps (1,600 seeds of 64 steps) with no violation. Its default in CI is 384 steps, so the plan's 100,000-step bar is met only by a manual run.

Three gaps remain. §2 is the missing piece. §3 and §4 are behaviours of the landed part that the owner has not seen.

## 2. Contained Mission: a broken final message ends the Mission

### 2.1 Facts

- The executor is `CodexProxyExecutor` (`packages/agents/src/adapters/codex-proxy.ts`). It runs `codex exec -s read-only --ephemeral --ignore-user-config --ignore-rules -o last-message.txt`. It never writes to the worktree. **The patch is the model's final message.** It must be valid UTF-8, at most 256 KiB, and end with the line `END-OF-PATCH`.
- `isolatedEnv()` deletes and recreates `HOME` and `CODEX_HOME` under the runtime directory before every run and copies only `auth.json`. With `--ephemeral` no session is stored.
- `readCodexProxyPatch` has four failures: `PATCH_MISSING`, `PATCH_TOO_LARGE`, `PATCH_NOT_UTF8`, `PATCH_INCOMPLETE`. The runner halts with `patch_invalid:<reason>` at `awaiting_decision` (a local-failure repair child halts with `verify_repair_failed` and the reason as detail).
- At that halt the only accepted decision is `abandon`. `extra_repair` is accepted only for the reason `repair_cycles_exhausted` (`decisionAllowed`). The plan text says `extra_repair` is the exit; on `main` it is not.
- This differs from the loop in one point that shapes the design: the loop's builder leaves its work in the workspace, so a lost report loses only the report. Here the work exists only in the model's session. Without the session the work is gone, and "restate" is the only way to keep it.

### 2.2 Proposal

**Which failures are repaired.** Only `PATCH_INCOMPLETE`, and only when the executor exited 0, did not time out, was not cancelled, and its stop is proven. The other three are not repaired: `PATCH_MISSING` means there is no final message, so nothing says the work was done; `PATCH_TOO_LARGE` would be restated at the same size; `PATCH_NOT_UTF8` is left out to keep the first version small.

**The repair turn.** The proposal turn drops `--ephemeral`, so its one session is stored in the run's own `CODEX_HOME`. A repair turn runs in the same `HOME` and `CODEX_HOME` without wiping them:

```text
codex exec -s read-only -C <worktree> --skip-git-repo-check --ignore-user-config --ignore-rules \
  --json -o last-message.txt resume --last "<fixed repair prompt>"
```

- `--last` is unambiguous because that `CODEX_HOME` holds exactly one session. The node that implements this must prove it on the installed Codex (0.169.1 lists `--last`, `-o`, `--ignore-user-config` and `--ignore-rules` for `exec resume`); if `--last` can pick a session from elsewhere, the thread id from `--json` of the proposal turn is used instead.
- The prompt is fixed text: restate the result of this session, do not redo the work, do not use tools, end with the marker.
- `--json` is added so the host can see tool use. A repair turn that ran any command is discarded (`report_repair_used_tool`).
- At most two repair turns. Each has its own short timeout (proposed 120 s; the proposal turn has 600 s).

**Safety does not rest on the prompt.** A patch from a repair turn goes through exactly the same path as any patch: size and marker check, secret screen, parser, allowed paths, protected paths, host apply, verification. If the model ignores "restate only" and writes a different patch, that patch is judged like a first one. The sandbox stays read-only in both turns.

**Process rules are those of the executor.** A repair turn is a process group with a recorded launch and stop evidence. An unproven stop halts at `stop_unknown`. Cancel works as it does for the executor. The pinned executor identity is not probed again inside the same step.

**Budget.** The seconds of a repair turn are charged to the executor seconds of the Mission (and of the chain allocation for a revision child). A repair turn does not count as a repair cycle or a revision round.

**Session data at rest.** Between the proposal turn and the end of the repair the session file lies in `<runtime>/codex-home`, mode 0700. It holds the prompt, what the model read from the repository, and its output. It is deleted when the step ends for any reason. After a crash it is deleted by the next `isolatedEnv()` and by start recovery. **No repair is attempted after a restart**; the Mission halts with `patch_invalid` as today.

**Events.** `executor_report_repair_attempt` and `executor_report_repair_result` on the Mission, with attempt number, outcome, seconds, and failure code. The event kind column is free text (`engineering-contained-ddl.ts`), so no migration is needed.

**After two failed repairs.** Halt at `awaiting_decision` with `patch_invalid:PATCH_INCOMPLETE` and the repair facts in the payload. See decision 4 in §6 for the exits.

### 2.3 Not changed

Who may decide, approve, publish or merge. The executor's sandbox. The patch rules. The local-failure repair child keeps its single approval: after failed report repairs it halts with `verify_repair_failed`, and nothing new is offered.

## 3. Loop: an invalid report with a failed check goes straight to a person

On `main`, when the builder's report is invalid and a deterministic check fails, no report repair is tried (reason `deterministic_verification_failed`) and the task is escalated with `report_invalid`, even when iterations remain. The test `repairs builder report only: failed_check` pins this: `maxIterations` is 3 and the builder runs once. Before #451 this case ran another iteration with the feedback.

| Option | Behaviour | Cost |
|---|---|---|
| A. Keep | Escalate. A person looks at every such case | Fewer self-repairs; a malformed report turns a fixable failure into a card |
| B. Iterate on a failed check (recommended) | The failed check is evidence that the work failed, whatever the report says. Run the next iteration with the check output as feedback while iterations and budget remain. Record `execute.report_invalid` as an issue | One existing test changes its expectation |

B does not weaken the U5 rule. That rule forbids turning a *failed report repair* into a business retry. In this case the business failure is proven by the check, not inferred from the report.

Unchanged under B: an unconfirmed stop, a contaminated candidate, and "no changes in the workspace" still escalate.

## 4. Loop: the card after a failed report repair offers only a full redo

The decision list shows a loop escalation with the single answer `retry` and the command `cockpit retry`. That command enqueues a new task `<task_id>-retry` with a retry prompt; it redoes the work. The kept worktree and branch are not named on the card. Loop decisions are host-only (`decisions.answer` answers `local_only`).

A later "repair the report again" is not possible: the adapter keeps the native session id in memory only, so it is gone when the process ends.

Recommended, small: for the reason code `report_invalid` the card's summary says that the work is kept and where (worktree path and branch, if the escalation event carries them; otherwise the node adds them to the event), and that `retry` redoes the work. No new answer, no new command, no persisted session.

## 5. Nodes

One PR each, in this order.

| Node | Package | Content | Needs |
|---|---|---|---|
| R1 | `agents` | `CodexProxyExecutor`: keep the session for the proposal turn, `repair()` turn with `resume --last`, tool detection from `--json`, cleanup. Tests with a fake Codex binary. One real call on the host to confirm `resume --last` and `-o` behave as §2.2 assumes | decisions 1, 2 |
| R2 | `cli` | Runner: repair in `runExecutor` for `PATCH_INCOMPLETE`, events, budget charge, halt payload, start recovery deletes a left-over session, crash-point test "crash between proposal and repair" | R1, decisions 3, 4 |
| R3 | `loop` | §3 option B, with the simulation updated and a 100,000-step run before merge | decision 5 |
| R4 | `cli` | §4 card text | decision 6 |

R3 and R4 do not depend on R1 or R2.

U7 gate: R2 needs the crash-point test above; R3 needs the loop simulation run. Decision 7 asks whether CI should run more than 384 steps.

## 6. Decisions for the owner

1. **Session at rest.** May the proposal turn store its Codex session in the run's private `CODEX_HOME` until the step ends? Recommended: yes. Without it the contained Mission cannot have a report repair at all.
2. **Repairable failures.** Only `PATCH_INCOMPLETE` after a clean exit. Recommended: yes; widen later with data.
3. **Budget.** Repair seconds are charged to executor seconds; no repair cycle or round is counted. Recommended: yes.
4. **Exit after `patch_invalid`.** Today only `abandon` is accepted. Should `extra_repair` be accepted for `patch_invalid:*` on a Mission that is neither a local-failure repair child nor a CI repair child (a new executor turn, counted in the budget)? This widens what a decision may start. Recommended: yes, as a separate small node after R2, because otherwise one malformed message still ends the Mission when the repair fails. If no, the Mission can only be abandoned, as today.
5. **Loop, failed check with invalid report.** Option A or B of §3. Recommended: B.
6. **Loop card.** The text change of §4. Recommended: yes.
7. **Simulation steps in CI.** Keep 384 steps and run 100,000 by hand before U5 merges, or add a scheduled CI job with the long run. Recommended: keep by hand for now; a scheduled job belongs to U6.

## 7. Not verified

- `codex exec resume --last` was read from the help of the installed Codex, not run. R1 runs it.
- Whether a stored session contains anything beyond prompt, tool output and model output was not inspected.
- `cockpit retry` was read, not executed.
- The contained runner was not run in a container for this note.

# Loop CLI Options

Use `osstack loop help` for the authoritative runtime help. This reference captures the stable integration surface.

## Core Commands

- `loop doctor`: check workspace, queue, git, state path, and optional daemon readiness.
- `loop enqueue <prompt>`: create a `tasks/*.json` task.
- `loop lessons list|show|promote|discard`: review SOP lesson drafts under `loop-lessons/drafts/`. `promote <id> --to-skill PATH` is the only way a lesson reaches a skill file; the loop never modifies skills on its own.
- `loop run`: run locally or through daemon RPC with `--daemon`.
- `loop start`: start a daemon-managed polling session.
- `loop status`: render `LOOP-STATE.json` as Markdown.
- `loop list`: list daemon-managed sessions.
- `loop stop <id>`: stop one daemon-managed session.

## Common Flags

- `--workspace P`: target repo or project directory.
- `--source task_queue|git_diff`: discovery source; repeatable.
- `--execute CMD`: deterministic shell command to run per task.
- `--verify CMD`: shell verifier; repeatable. Non-zero means failure.
- `--agent ID`: execution adapter, for example `codex-cli`.
- `--auto-agent`: let routing choose an adapter by capability.
- `--reviewer ID`, `--checker ID`: verifier adapters, for example `ds-review` or `ds-verify`.
- `--goal CMD`: global command; loop stops when it exits 0.
- `--discovery-policy P`: discovery governance. `default` or a JSON policy file. Discovered tasks that are not `auto_execute` are recorded in state as needs-approval/suggested/blocked instead of executing.
- `--worktree`: isolate task changes in a git worktree and merge successful results.
- `--worktree-root P`: directory for temporary worktrees.
- `--cycles N`: run multiple cycles.
- `--interval-ms N`: wait between cycles.
- `--stop-when-idle`: stop after a cycle executes no tasks.
- `--archive-completed`: move successful single-task queue files into `tasks/archive/`.
- `--max-runtime-ms N`: budget — stop after N ms total runtime (exit code 2).
- `--max-tokens N`: budget — stop after N adapter-reported tokens (in+out) across the loop (exit code 2).
- `--max-cost-usd X`: budget — stop after an adapter-reported spend of X USD (exit code 2).
- `--no-progress-limit N`: budget — opt in to stop after N consecutive cycles that executed tasks without a success (exit code 2). Unset means no no-progress stop, so a runtime cap does not silently become a stalled-cycle stop.

Token and cost caps enforce against adapter-reported usage (`usage.final` / `done.usage` events). Adapters that do not report usage (e.g. local `--execute` commands) contribute 0, so those caps trip only when there is real usage to measure.
- `--no-lesson-drafts`: disable SOP lesson drafts after recovered failures.
- `--lessons-dir P`: lesson draft directory, default `loop-lessons/drafts`.
- `--self-improvement`: opt in to control-plane self-improvement. Each completed task is normalized into a run trace; failed runs also produce feedback assets recorded in the local osstack state DB. Requires `--repo-id`. Local-only — cannot be combined with `--daemon`. Never fails a task.
- `--repo-id ID`: repository id the self-improvement assets are attributed to (required with `--self-improvement`).
- `--propose-improvements`: with `--self-improvement`, also derive risk-rated improvement proposals from the feedback assets (drafts only; nothing is applied). Verify gates come from the repo registry entry.
- `--state P`: JSON state path, default `LOOP-STATE.json`.
- `--markdown P`: Markdown state path, default `STATE.md` beside the JSON.
- `--json`: emit machine-readable summaries where supported.

## Exit Codes

- `0`: completed tasks succeeded.
- `1`: command, configuration, daemon, or environment error.
- `2`: completed task failed, escalated, failed verification, or the loop budget was exceeded.

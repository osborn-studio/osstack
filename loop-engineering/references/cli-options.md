# Loop CLI Options

Use `osstack loop help` for the authoritative runtime help. This reference captures the stable integration surface.

## Core Commands

- `loop doctor`: check workspace, queue, git, state path, and optional daemon readiness.
- `loop enqueue <prompt>`: create a `tasks/*.json` task.
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
- `--worktree`: isolate task changes in a git worktree and merge successful results.
- `--worktree-root P`: directory for temporary worktrees.
- `--cycles N`: run multiple cycles.
- `--interval-ms N`: wait between cycles.
- `--stop-when-idle`: stop after a cycle executes no tasks.
- `--archive-completed`: move successful single-task queue files into `tasks/archive/`.
- `--state P`: JSON state path, default `LOOP-STATE.json`.
- `--markdown P`: Markdown state path, default `STATE.md` beside the JSON.
- `--json`: emit machine-readable summaries where supported.

## Exit Codes

- `0`: completed tasks succeeded.
- `1`: command, configuration, daemon, or environment error.
- `2`: completed task failed, escalated, or failed verification.

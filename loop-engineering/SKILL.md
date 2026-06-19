---
name: loop-engineering
description: "Use when Codex needs to run, diagnose, or integrate the osstack Loop Engineering runtime for iterative software work: discovering tasks from task queues or git diffs, executing commands or agent adapters, verifying with tests/checkers/reviewers, managing daemon loop sessions, using worktree isolation, or interpreting LOOP-STATE.json and STATE.md."
---

# Loop Engineering

## Overview

Use this skill to operate osstack's Loop Engineering runtime as a reusable automation layer. The runtime owns the loop; this skill provides the correct procedures, wrappers, task schema, and integration patterns.

The loop model is:

```text
Discover -> Plan -> Execute -> Verify -> Iterate -> State
```

Prefer the bundled scripts for repeatable operations. Use raw CLI commands when a workflow needs custom flags.

## First Checks

1. Identify the target workspace. Default to the current repo unless the user names another path.
2. Ensure the osstack CLI is available by one of these routes:
   - `OSSTACK_REPO=/path/to/osstack` with `packages/cli/dist/bin.js` built.
   - `OSSTACK_CLI="osstack"` or another executable command.
   - This skill lives inside the osstack repo, where `../..` from `scripts/` is the repo root.
3. Run:

```bash
loop-engineering/scripts/loop-doctor.sh
```

If the built CLI is missing, run `pnpm build` from the osstack repo.

## Local Loop Workflow

Use local mode for one-shot or finite runs:

```bash
loop-engineering/scripts/loop-run.sh
```

Defaults:

- workspace: current directory
- source: `task_queue`
- verifier: `pnpm test`
- worktree isolation: enabled

Override with environment variables:

```bash
LOOP_VERIFY="pnpm typecheck" LOOP_WORKTREE=0 loop-engineering/scripts/loop-run.sh
```

Pass additional CLI flags after the script:

```bash
loop-engineering/scripts/loop-run.sh --cycles 5 --interval-ms 2000 --stop-when-idle
```

## Task Queue Workflow

Create tasks with the CLI wrapper instead of hand-writing JSON when possible:

```bash
loop-engineering/scripts/osstack-loop.sh enqueue "Fix the failing auth test" \
  --capability code.fix \
  --priority 80
```

For task schema details, read `references/task-schema.md`.

## Daemon Workflow

Use daemon mode when another system must start, list, poll, or stop background loops.

Start the daemon separately:

```bash
node packages/cli/dist/bin.js serve
```

Then start a managed loop:

```bash
loop-engineering/scripts/loop-daemon-start.sh
```

List and stop sessions:

```bash
loop-engineering/scripts/osstack-loop.sh list
loop-engineering/scripts/osstack-loop.sh stop loop_session_abc12345
```

For platform integration patterns, read `references/integration.md`.

## Choosing Execution Mode

- Use `--execute CMD` for deterministic local scripts.
- Use `--agent codex-cli` when the task requires code reasoning by an agent adapter.
- Use `--auto-agent` when the runtime should route by capability.
- Use `--reviewer ds-review` or `--checker ds-verify` for DeepSeek-backed verification.
- Use `--worktree` when the loop may edit code; avoid it only for read-only checks or environments without git worktree support.

For the complete option reference, read `references/cli-options.md`.

## State And Results

Loop runs write:

- `LOOP-STATE.json`: machine-readable durable state.
- `STATE.md`: human-readable summary.
- `tasks/archive/`: successful single-task queue files when `--archive-completed` is used.

Exit codes:

- `0`: completed tasks succeeded.
- `1`: command, configuration, or environment error.
- `2`: task failed, escalated, or verification failed.

Always inspect `STATE.md` or `loop status` before deciding a loop is complete.

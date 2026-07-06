---
name: loop-engineering
description: "Use when Codex needs to run, diagnose, or integrate the osstack Loop Engineering runtime for iterative software work: discovering tasks from task queues or git diffs, executing commands or agent adapters, verifying with tests/checkers/reviewers/evaluation specs, iterating with structured feedback, governing discovered tasks, enforcing budgets, reviewing lesson drafts, managing daemon loop sessions, using worktree isolation, or interpreting LOOP-STATE.json and STATE.md."
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

## Evaluation Specs (Acceptance Harness)

Declare per-task acceptance criteria in the queue file's `evaluation` array
(modes: `command`, `contract`, `property`, `e2e`, `artifact`,
`semantic_review`, `governance`). The verifier runs every spec and reports
per-spec results in the verdict, `LOOP-STATE.json`, and `STATE.md`. Legacy
`--verify CMD` and artifact flags still work — they become implicit specs.
`semantic_review` specs need a `--reviewer`/`--checker` adapter; ds-review and
ds-verify judge each spec against its `acceptance` text and return per-spec
verdicts. A required spec that fails blocks the task even when the adapter
process exits 0. Schema details: `references/task-schema.md`.

## Feedback-Carrying Iteration

With `--max-iter N` above 1, each failed verdict becomes structured feedback
for the next attempt: adapters receive it as `context.iteration_feedback`,
and `--execute` commands can read the JSON file at
`$OSSTACK_ITERATION_FEEDBACK_FILE`. Two consecutive attempts with identical
blocking issues and changed files escalate as no-progress instead of burning
iterations. Feedback history lands in `STATE.md` per attempt.

## Discovery Governance

`--discovery-policy default` (or a JSON policy file) separates discovering
work from authorizing it: `task_queue` stays auto-execute, `git_diff`
discoveries become suggestions, `github_branch` waits for approval, and
blocked capabilities/paths never run. Deferred tasks appear in `STATE.md`
under Needs Approval / Suggested / Blocked and in the loop report. Without
the flag, behavior is unchanged.

## Budgets And Stop Controls

`--max-runtime-ms`, `--max-tokens`, `--max-cost-usd`, and (opt-in)
`--no-progress-limit` stop the loop with a `loop.budget.exceeded` event and
exit code `2` (not a CLI crash). No-progress is opt-in so a runtime cap never
silently becomes a stalled-cycle stop. Token/cost caps enforce against
adapter-reported usage (`usage.final` events) and stay at 0 for adapters that
don't report it. Daemon sessions persist the stop reason and expose limits +
usage in `loop list` and `osstack stats`. `STATE.md` gains a Budget section
when a budget stop fires.

## Lesson Drafts (SOP Flywheel)

A task that succeeds after failed attempts writes a reviewable draft to
`loop-lessons/drafts/<task_id>.md` (disable with `--no-lesson-drafts`).
Review with:

```bash
osstack loop lessons list
osstack loop lessons show <id>
osstack loop lessons promote <id> --to-skill path/to/SKILL.md
osstack loop lessons discard <id>
```

Promotion into a skill file happens only with an explicit `--to-skill` path;
the loop never modifies official skills on its own.

## State And Results

Loop runs write:

- `LOOP-STATE.json`: machine-readable durable state (evaluations, feedback, deferred tasks, budget status).
- `STATE.md`: human-readable summary.
- `tasks/archive/`: successful single-task queue files when `--archive-completed` is used.
- `loop-lessons/drafts/`: lesson drafts after successes that recovered from failures.

Exit codes:

- `0`: completed tasks succeeded.
- `1`: command, configuration, or environment error.
- `2`: task failed, escalated, failed verification, or the loop budget was exceeded.

Always inspect `STATE.md` or `loop status` before deciding a loop is complete.

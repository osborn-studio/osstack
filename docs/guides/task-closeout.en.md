# Task closeout: audit with neat, update documentation, deliver

[README](../../README.md#knowledge-hygiene) · [中文](task-closeout.md) · [neat guide](neat.md) · [Command reference](command-reference.en.md)

Use neat during development closeout. It checks documentation and knowledge hygiene, but does not itself summarize code, update product documentation or publish to GitHub. There is currently no single neat command that completes all these steps.

## 1. Establish the change scope

In the task's worktree:

```sh
git status --short
git diff --stat
git diff --cached --stat
git log --oneline origin/main..HEAD
git diff origin/main...HEAD --stat
```

Read the actual diff. Record features, behavior changes, removals, CLI changes and limitations. Exclude unrelated work. Choose the intended base: after merging, origin/main may equal HEAD, so use a known pre-merge commit or the PR diff instead.

## 2. Select the neat scope

Write reports outside the repository so the report does not alter the audited diff:

```sh
export NEAT_REPORT_DIR="$(mktemp -d /tmp/osstack-closeout-XXXXXX)"
# Uncommitted worktree changes (default).
osstack neat check --repo . --json --fail-on none > "$NEAT_REPORT_DIR/worktree.json"
# Committed branch changes relative to main.
osstack neat check --repo . --base origin/main --head HEAD --json \
  --fail-on warning > "$NEAT_REPORT_DIR/branch.json"
# All recognized knowledge surfaces; no Git change-contract evaluation.
osstack neat check --repo . --all --json --fail-on none > "$NEAT_REPORT_DIR/all.json"
```

Run the modes relevant to your task. To compare origin/main with a worktree including uncommitted edits, use `--base origin/main` without `--head`. Source checkouts require a separate private OSSTACK_HOME.

Inspect findings, coverage and skipped items, not just exit codes. `--fail-on none` can return 0 with warnings; `warning` gates warnings and errors. `.osstack/neat.yaml` defines obligations. For example, this repository asks CLI changes to review README or command inventory; that does not prove every parameter has been explained correctly.

## 3. Update documentation and verify

- README: purpose, installation, shortest runnable example and supported scope.
- Guides: flags/defaults, configuration, successful output and failure handling.
- Generated inventories: rerun their named generator; do not edit generated files manually.
- Release notes: distinguish implemented on main, internally deployed, and publicly published.

Compare examples with CLI help and parsers, check relative links, and execute safe examples in an isolated environment. Identify live/paid/deployment steps and do not claim unexecuted flows were verified. Rerun relevant neat checks and the tests appropriate to code changes. neat does not replace tests or code review.

`neat fix --from REPORT` previews supported low-risk patches. The current mechanical fix catalog primarily creates a missing instruction mirror with one import line; it is not a general README editor. Semantic audit explicitly invokes a judge; narrative/memory remediation uses separate plan/approve/apply transactions. See the [full guide](neat.md).

## 4. Publish a reviewable change

Inspect the final diff and evidence, stage only task files, then commit and open a PR. neat does not commit, push, approve, merge or publish. GitHub's default README updates after the required CI/independent review and merge; the PR branch's rendered README is available beforehand.

## Automatic audit evidence after Loop

```sh
osstack loop run --workspace . --source task_queue --auto-agent \
  --verify "pnpm test" --report --scorecard --proof --neat-finalize --json
```

This executes tasks. Do not rerun completed work merely to obtain a neat report. `--neat-finalize` runs a whole-repository knowledge check after Loop success, attaching non-gating evidence. Audit failure does not change the Loop outcome, create another loop, apply repairs or submit commits. For an already completed task, use `neat check` directly.

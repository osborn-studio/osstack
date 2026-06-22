# OSBORN stack (osstack)

A Hermes-resident **project manager Agent** for the software development lifecycle.

**中文文档：[README.zh.md](README.zh.md)**

> Status: **V2 GA scaffold complete (S0-S6) + PartnerOS-core port (S7.1)**. 76/76 tests passing across 9 packages. See [docs/V2_REFACTOR_PLAN.md](docs/V2_REFACTOR_PLAN.md) and [docs/external/partneros-analysis.md](docs/external/partneros-analysis.md).

## What it is

osstack is a **Hermes skill/plugin** that handles the software-development-specific project-manager work that Hermes itself does not specialize in:

- Decide which sub-agent (Claude Code, Codex CLI, ...) should handle a task
- Track cross-task memory ("which agent does well on which task type")
- Learn from failure to refine the routing policy
- Normalize external skill ecosystems (GStack, SuperPower, Everything Claude, Anthropic Skills) into Hermes-compatible SKILL.md format

It is **not** a standalone product. Hermes owns messaging, cron, dashboard, kanban, memory, auth. osstack focuses only on dev-task orchestration.

## Architecture (dual-form)

```
+──────────────────────────────────────────────────────────────────+
│ Hermes session (Python)                                           │
│   ↓ import                                                        │
│ ~/.hermes/skills/software-development/osstack/scripts/             │
│   osstack_bridge.py  ←  thin Python wrapper                       │
│   ↓ Unix socket (~/.osstack/daemon.sock, length-prefixed JSON)         │
│ osstack daemon  (Node.js, TypeScript, launchctl-managed)           │
│   ↓                                                                │
│ @osstack/agents → @anthropic-ai/claude-agent-sdk → Claude Code     │
+──────────────────────────────────────────────────────────────────+
```

- TS daemon: this repository, published as `@osstack/cli` on npm.
- Hermes skill wrapper: lives at `~/.hermes/skills/software-development/osstack/`.

## Monorepo

| Package | Role |
|---|---|
| [`@osstack/cli`](packages/cli) | `osstack` binary |
| [`@osstack/core`](packages/core) | orchestrator / lifecycle / policy / memory / learning / privacy / observability / kg |
| [`@osstack/agents`](packages/agents) | sub-agent adapters (claude-code, codex-cli) |
| [`@osstack/hermes-adapter`](packages/hermes-adapter) | Hermes Run Adapter Contract impl |
| [`@osstack/skills`](packages/skills) | lifecycle skill templates + V1 shim |
| [`@osstack/plugins`](packages/plugins) | 7 plugin slots |
| [`@osstack/skill-registry`](packages/skill-registry) | external skill ingestion + LLM normalize |
| [`@osstack/runtime`](packages/runtime) | optional Zellij workspace (V1 osb-runtime preserved) |
| [`@osstack/partneros-core`](packages/partneros-core) | Intent model + FSM ported from [partneros-mvp](https://github.com/gilosbornhello/partneros-mvp); item 1 of analysis roadmap |

## V1 → V2

V1 is preserved verbatim in [legacy-python/](legacy-python/). Sprint 5 (S5) ships shim commands so existing scripts that call `osb-init`, `ds-review`, `osb-context`, etc. continue to work — the names route through V2 internals.

## Requirements

- Node.js ≥ 20 (corepack will manage pnpm)
- Hermes Agent installed at `/Volumes/AIMATE_WORK/projects/hermes-agent/` (or wherever; `HERMES_HOME` defaults to `~/.hermes`)
- macOS (launchctl-based daemon; Linux/systemd in a future sprint)

## Install

For normal use, install the CLI globally and register the macOS LaunchAgent:

```bash
npm install -g @osstack/cli
osstack --version
osstack serve --install
osstack status
```

`osstack serve --install` writes `~/Library/LaunchAgents/ai.osstack.daemon.plist`, starts it with `launchctl`, and keeps daemon logs under `~/.osstack/logs/`. Use `osstack serve --status` to inspect it and `osstack serve --uninstall` to remove it. For a dry filesystem-only check, add `--no-load`.

## 5-Minute Quickstart

From any repository:

```bash
osstack doctor --workspace .
osstack loop enqueue "Run local checks and fix the first failure" --capability code.test
osstack loop run --source task_queue --verify "pnpm test" --report --scorecard --proof
osstack loop status
```

`osstack doctor` combines loop readiness, task queue checks, git/worktree checks, and local agent availability. `osstack examples` prints runnable recipes for bug fixing, feature work, git-diff review, auto-agent routing, worktree isolation, and proof packs. `osstack guide --output QUICKSTART.md` writes the same quickstart locally.

## Develop

```bash
git clone https://github.com/gilosbornhello/osbstack.git ~/Developer/osbstack
cd ~/Developer/osbstack
git checkout v2/typescript
corepack enable pnpm
pnpm install
pnpm build
pnpm test
```

## Loop Engineering MVP

Run a small, inspectable demo when you want to see the loop fix a real failing test:

```bash
pnpm demo:loop
```

The demo builds the CLI, creates a temporary Node.js workspace with a broken `add()` implementation, queues a `code.test` task, runs `loop run --execute "node fix.js" --verify "npm test"`, then prints the workspace path so you can inspect `src/math.js`, `STATE.md`, and `LOOP-STATE.json`. Set `OSSTACK_LOOP_DEMO_WORKSPACE=/path/to/demo` to choose the workspace; set `OSSTACK_LOOP_DEMO_OVERWRITE=1` to replace a non-empty demo directory.

Run the daemon-managed variant when you want to see the same repair happen through a real `osstack serve` process and daemon RPC:

```bash
pnpm demo:loop:daemon
```

The daemon demo starts an isolated temporary daemon with its own `OSSTACK_HOME` and Unix socket, queues `daemon-demo-fix-add`, runs `loop start --once --execute "node fix.js" --verify "npm test"`, waits for the session to stop, checks `loop status --daemon` and `osstack stats`, then prints the workspace and daemon home paths. Set `OSSTACK_LOOP_DAEMON_DEMO_WORKSPACE=/path/to/demo` to choose the workspace; set `OSSTACK_LOOP_DAEMON_DEMO_OVERWRITE=1` to replace a non-empty demo directory.

Run the end-to-end smoke check whenever you need proof that the built CLI can operate a real local loop:

```bash
pnpm smoke:loop
```

It builds the monorepo, creates temporary workspaces, runs a queued task through `loop run`, verifies `LOOP-STATE.json` and `STATE.md`, archives the completed task, repeats the flow in an isolated git worktree, runs `ds-review` as a post-execution reviewer, starts a real daemon and checks `loop start --once`, goal-based stopping, cron-scheduled loops, `SIGKILL` restart recovery, `osstack stats`, and the legacy `osb-loop` shim against a real `git diff`.

Use `pnpm coverage:loop` to enforce the `packages/loop` coverage gate. The Loop package requires at least 80% lines, functions, branches, and statements.

The local loop runner can execute one real Discover → Execute → Verify → Iterate cycle without a running daemon. Queue work in `tasks/*.json`, then run local commands or a registered agent adapter as the executor, with shell commands as verifiers:

```bash
mkdir -p tasks
printf '{"task_id":"local-check","capability":"code.test","prompt":"Run local checks"}' > tasks/local-check.json
node packages/cli/dist/bin.js loop enqueue "Fix failing tests" --capability code.test --priority 80
pnpm build
node packages/cli/dist/bin.js loop run --source task_queue --verify "pnpm test"
node packages/cli/dist/bin.js loop status
```

`loop enqueue` writes a single-task JSON file into `tasks/`; add `--context-json '{"file":"src/app.ts"}'` for structured context. `loop run` writes `LOOP-STATE.json` for machines and `STATE.md` for humans. Add `--execute "<cmd>"` to run a command before verification, repeat `--verify "<cmd>"` for multiple gates, and use `--workspace <path>` to run against another repository.

Before starting a real loop, use `loop doctor` to check that the workspace is accessible, queued task JSON is valid, git/worktree support is available when needed, and the daemon socket is reachable when `--daemon` is included:

```bash
node packages/cli/dist/bin.js loop doctor --workspace "$PWD"
node packages/cli/dist/bin.js loop doctor --workspace "$PWD" --daemon --json
```

Use `--agent <id>` to execute each task through a registered adapter such as `codex-cli` or `claude-code`. The adapter receives the task prompt plus `repo_path` in its context and streams Hermes run events back into the loop result:

```bash
node packages/cli/dist/bin.js loop run --source task_queue --agent codex-cli --verify "pnpm test"
```

Use `--auto-agent` when you want the loop to choose the maker automatically. The router finds adapters that advertise the task capability, then the policy engine ranks them by cost, exact capability fit, and available run history:

```bash
node packages/cli/dist/bin.js loop run --source task_queue --auto-agent --verify "pnpm test"
```

DeepSeek review and verification commands are also registered adapters. Use `--reviewer` or `--checker` to run them after the maker/executor step. `ds-review` reads the current `git diff` and writes `reviews/ds-review/latest.md`; `ds-verify` runs in the workspace and writes `reviews/ds-verify/latest.md`. Override the command path with `OSSTACK_DS_REVIEW_BIN` or `OSSTACK_DS_VERIFY_BIN` for local testing:

```bash
node packages/cli/dist/bin.js loop run --source task_queue \
  --execute "node scripts/fix-failing-test.js" \
  --reviewer ds-review
node packages/cli/dist/bin.js loop run --source task_queue --checker ds-verify
```

For a finite polling loop, add `--cycles <n>` and `--interval-ms <ms>`. Completed `task_id`s are skipped on later cycles, so queued tasks can remain in `tasks/` without being re-run. Add `--archive-completed` to move successful single-task queue files into `tasks/archive/YYYY-MM-DD/`:

```bash
node packages/cli/dist/bin.js loop run --source task_queue --cycles 5 --interval-ms 2000 --stop-when-idle --archive-completed
```

Use `--goal "<cmd>"` to stop early when a workspace-level command succeeds. This is the practical "keep looping until tests are green" mode:

```bash
node packages/cli/dist/bin.js loop run --source task_queue --execute "pnpm build" --goal "pnpm test" --cycles 10 --interval-ms 2000
```

Add `--worktree` when the executor should edit code in an isolated git worktree. A passing task is committed and fast-forward merged back into the workspace; failed or escalated tasks are cleaned up without merging. Each loop uses an `osstack/loop/<loop_id>/...` branch prefix and cleans residual worktrees in that prefix before and after each cycle:

```bash
node packages/cli/dist/bin.js loop run --source task_queue --worktree \
  --execute "node scripts/fix-failing-test.js" \
  --verify "pnpm test"
```

The same runner is also available through the daemon RPC surface:

```bash
node packages/cli/dist/bin.js serve
node packages/cli/dist/bin.js serve --install --no-load
node packages/cli/dist/bin.js loop run --daemon --workspace "$PWD" --source task_queue --verify "pnpm test"
node packages/cli/dist/bin.js loop status --daemon --workspace "$PWD"
```

For an actual daemon-managed polling loop, start the daemon, then create a background loop session. It keeps scanning `tasks/*.json` until stopped, or until `--cycles` is reached. Use `--interval-ms` for fast local testing, or `--schedule "<cron>"` for calendar-based automation:

```bash
node packages/cli/dist/bin.js loop start --workspace "$PWD" --source task_queue --goal "pnpm test" --interval-ms 5000
node packages/cli/dist/bin.js loop start --workspace "$PWD" --source task_queue --schedule "0 6 * * *"
node packages/cli/dist/bin.js loop list
node packages/cli/dist/bin.js loop stop loop_session_abc12345
```

Running loop sessions are persisted in `~/.osstack/loop-sessions.json` and resume after a daemon restart. Sessions that were stopped or stopping remain stopped.
Use `osstack stats` while the daemon is running to inspect per-agent run metrics plus per-loop session counts, cycle totals, success/failure/escalation totals, token totals, and average cycle duration.

The V1 `legacy-python/runtime/bin/osb-loop` entry point remains usable. It starts or reuses an osstack daemon, forwards the current `git diff` to `osstack loop start --once --source git_diff`, waits for completion, prints daemon loop status, and returns exit code `2` if any completed task failed or escalated.

## Reusable Loop Engineering Skill

The Loop runtime is also packaged as a repository-local Codex skill in [`loop-engineering/`](loop-engineering/). Use it when another agent or platform needs a stable wrapper around `osstack loop` instead of calling the TypeScript CLI directly.

```bash
loop-engineering/scripts/loop-doctor.sh
LOOP_VERIFY="pnpm test" loop-engineering/scripts/loop-run.sh
LOOP_GOAL="pnpm test" loop-engineering/scripts/loop-daemon-start.sh
```

The skill keeps the executable surface small:

- `SKILL.md` explains the Discover → Plan → Execute → Verify → Iterate workflow.
- `scripts/osstack-loop.sh` resolves the built repo CLI, `OSSTACK_REPO`, `OSSTACK_CLI`, or a global `osstack` binary.
- `references/` documents CLI flags, task queue JSON, and CI/platform integration patterns.

## License

MIT. See [LICENSE](LICENSE).

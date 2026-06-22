# osstack

**A command-line project-manager agent for the software-development lifecycle.**

osstack is a TypeScript CLI + background daemon that runs an iterative
**Loop Engineering** runtime, an embedded **Kanban** board, and a capability
**router + policy engine** that decides which coding sub-agent (Claude Code,
Codex CLI, …) should handle each task — then learns from the outcomes.

It can run fully standalone on your machine, or plug into a
[Hermes](https://github.com/gilosbornhello) agent as a software-development skill.

**中文文档：[README.zh.md](README.zh.md)** · Roadmap: [docs/V2_REFACTOR_PLAN.md](docs/V2_REFACTOR_PLAN.md)

> Status: **v0.1.0** — 10 packages, GA scaffold (S0–S6) + Loop Engineering runtime. All tests green.

---

## Table of contents

- [Why osstack](#why-osstack)
- [Install](#install)
- [Quickstart](#quickstart)
- [Core concepts](#core-concepts)
- [Loop Engineering](#loop-engineering) ← the flagship feature
- [Kanban board](#kanban-board)
- [Task orchestration & project management](#task-orchestration--project-management)
- [Agent adapters](#agent-adapters)
- [Configuration](#configuration)
- [Daemon lifecycle & self-update](#daemon-lifecycle--self-update)
- [Hermes integration](#hermes-integration)
- [External skill registry](#external-skill-registry)
- [Environment variables](#environment-variables)
- [Monorepo layout](#monorepo-layout)
- [Develop](#develop)
- [License](#license)

---

## Why osstack

Modern coding work is increasingly done by *agents* (Claude Code, Codex, …), but
nobody owns the **lifecycle around them**: which agent should do this task, did
the result actually pass, should we retry or escalate, and what did we learn for
next time. osstack is that layer:

- **Loop Engineering** — a `discover → execute → verify → iterate` hot-loop that
  keeps working a queue (or a `git diff`) until tests are green, with optional
  git-worktree isolation so failed attempts never touch your tree.
- **Kanban** — a local board that tracks every run and is subscribable from
  Telegram/Slack (via Hermes) so you can watch progress from your phone.
- **Router + policy engine** — picks the cheapest capable agent and re-ranks
  based on real success/failure history, with a kill-switch when an agent stops
  earning its keep.
- **Daemon + self-update** — a long-lived local daemon with a clean
  `osstack upgrade` path (backup → drain → install → health-check → auto-rollback).
- **Knowledge Cloud + proof packs** — an OSSTACK-native, cloud-deployable
  knowledge service with official packs, provenance, quality metadata, and
  loop/report evidence hooks.

Everything is local-first: state lives in a single SQLite file under
`~/.osstack/`, the daemon listens on a Unix socket, nothing leaves your machine
unless you wire in an agent that calls out.

---

## Install

### Requirements

- **Node.js ≥ 20** (corepack manages pnpm)
- **macOS** for the launchd-managed daemon (Linux/systemd planned). The CLI and
  loop runtime themselves are cross-platform.
- *(Optional)* a Hermes agent checkout for the Telegram/Kanban bridge.

### From npm (once published)

```bash
npm install -g @osstack/cli
osstack --version
```

### From source (current canonical method)

```bash
git clone https://github.com/gilosbornhello/osstack.git ~/Developer/osstack
cd ~/Developer/osstack
corepack enable pnpm
pnpm install
pnpm build
pnpm test          # optional: verify

# expose the CLI on your PATH via a small wrapper:
cat > /opt/homebrew/bin/osstack <<'EOF'
#!/usr/bin/env bash
exec node "$HOME/Developer/osstack/packages/cli/dist/bin.js" "$@"
EOF
chmod +x /opt/homebrew/bin/osstack
osstack --version    # → osstack 0.1.0
```

---

## Quickstart

```bash
# 1. Start the background daemon (Unix socket at ~/.osstack/daemon.sock)
osstack serve &

# 2. Check it's healthy + see the CLI/daemon version handshake
osstack status

# 3. See which coding agents are available on this machine
osstack agent list

# 4. Queue a coding task and run one loop cycle until tests pass
mkdir -p tasks
osstack loop enqueue "Fix the failing auth test" --capability code.test --priority 80
osstack loop run --source task_queue --execute "npm run fix" --verify "npm test"

# 5. Watch it on the board
osstack kanban board
```

---

## Core concepts

| Concept | What it is |
|---|---|
| **Daemon** | Long-lived local process (`osstack serve`). Owns the SQLite state, runs tasks, hosts loop sessions, exposes a Unix-socket JSON-RPC API. |
| **Task / run** | A unit of work (`task submit` or a queued `tasks/*.json`). Each execution is a *run* with a `run_id`, streamed events, and a recorded outcome. |
| **Capability** | A typed skill an agent advertises (`code.write`, `code.test`, `code.review`, `design.prd`, `research.ml`, …). The router matches tasks to capabilities. |
| **Adapter** | An integration with a concrete agent (`claude-code`, `codex-cli`, `ds-review`, …). Declares capabilities, a cost tier, and an availability probe. |
| **Loop session** | A daemon-managed polling loop that repeatedly discovers and works tasks on an interval or cron schedule. |
| **Board / card** | The embedded Kanban surface. Every run can mirror to a card; cards are subscribable from chat. |

State lives in `~/.osstack/` (override with `OSSTACK_HOME`):

```
~/.osstack/
  state.db              SQLite: runs, events, tasks, kanban, approvals
  daemon.sock           Unix socket (override: OSSTACK_SOCKET)
  daemon.pid            duplicate-instance guard
  config.yaml           role-based agent config
  loop-sessions.json    persisted daemon loop sessions (resume after restart)
  backups/              state.db snapshots taken before each upgrade
  logs/                 daemon + upgrade logs
```

---

## Loop Engineering

The flagship runtime. A **Loop** repeatedly runs the cycle:

```
Discover ──▶ Execute ──▶ Verify ──▶ Iterate
   │            │           │           │
 find work   run a cmd   run tests   continue / stop / escalate
 (queue or   or an       or a        based on the verdict
  git diff)  coding      reviewer
             agent       agent
```

There are two ways to run it: **one-shot/local** (`loop run`, no daemon needed)
and **daemon-managed** (`loop start`, a background polling session).

### Discover — where work comes from

| Source (`--source`) | Behaviour |
|---|---|
| `task_queue` | Reads `tasks/*.json` in the workspace. Each file is one task (or an array). |
| `git_diff` | Generates one `code.review` task per changed file from `git diff --stat`. |

**`tasks/*.json` schema:**

```json
{
  "task_id": "fix-auth",          // optional, auto-generated if omitted
  "capability": "code.test",      // default "code.write"
  "prompt": "Fix the failing auth test",
  "priority": 80,                  // 0–100, higher first; default 50
  "context": { "file": "src/auth.ts" }   // optional structured context
}
```

Add tasks by hand or with `loop enqueue` (below). Completed `task_id`s are
skipped on later cycles, so a queue file can stay in `tasks/` without re-running.

### Execute — who does the work

| Executor | Flag | Behaviour |
|---|---|---|
| Shell command | `--execute "<cmd>"` | Runs a command before verification (e.g. a fixer script). |
| Pinned agent | `--agent <id>` | Runs each task through one adapter (`codex-cli`, `claude-code`, …). The adapter receives the prompt + `repo_path`. |
| Auto-selected agent | `--auto-agent` | Router finds adapters advertising the task's capability; the policy engine ranks them by cost, exact-capability fit, and success history. |

### Verify — did it pass

| Verifier | Flag | Behaviour |
|---|---|---|
| Shell gate | `--verify "<cmd>"` (repeatable) | Any non-zero exit = failure. All gates must pass. |
| Reviewer agent | `--reviewer <id>` | e.g. `ds-review` reads the `git diff` and writes `reviews/ds-review/latest.md`. |
| Checker agent | `--checker <id>` | e.g. `ds-verify` runs in the workspace and writes `reviews/ds-verify/latest.md`. |

### Iterate — continue, stop, or escalate

- `--goal "<cmd>"` — stop early as soon as this command exits 0 ("keep looping
  until tests are green").
- `--cycles <n>` + `--interval-ms <ms>` — finite polling loop.
- `--stop-when-idle` — stop after a cycle that discovered no work.
- `--max-iter <n>` — escalate a task after N failed attempts instead of looping forever.

### `loop run` — one-shot / local cycle(s)

Runs one (or `--cycles N`) full cycle locally, **no daemon required**.

| Flag | Default | Meaning |
|---|---|---|
| `--workspace <path>` | cwd | Directory to scan / operate in. |
| `--source <src>` | — | `task_queue` or `git_diff` (repeatable). |
| `--execute <cmd>` | — | Shell command run before verification. |
| `--agent <id>` | — | Pin a specific executor adapter. |
| `--auto-agent` | off | Let the router+policy pick the executor. |
| `--verify <cmd>` | — | Verifier command (repeatable; non-zero = fail). |
| `--reviewer <id>` | — | Reviewer agent run after execute (repeatable). |
| `--checker <id>` | — | Checker agent run after execute (repeatable). |
| `--goal <cmd>` | — | Stop early when this command exits 0. |
| `--max-iter <n>` | — | Per-task attempt cap before escalation. |
| `--cycles <n>` | 1 | Number of cycles to run. |
| `--interval-ms <ms>` | 0 | Delay between cycles (enables multi-cycle mode). |
| `--once` | — | Shorthand for a single idle-stopping cycle. |
| `--stop-when-idle` | off | Stop after a cycle with no discovered tasks. |
| `--archive-completed` | off | Move successful single-task queue files to `tasks/archive/YYYY-MM-DD/`. |
| `--worktree` | off | Run each task in an isolated git worktree (see below). |
| `--state <path>` | `LOOP-STATE.json` | Machine-readable state file. |
| `--markdown <path>` | `STATE.md` | Human-readable state file. |
| `--json` | off | Emit a machine-readable summary to stdout. |
| `--daemon` | off | Execute through the running daemon's RPC instead of in-process. |

**Examples:**

```bash
# Queue-driven: fix, then verify with tests
osstack loop run --source task_queue --execute "node scripts/fix.js" --verify "pnpm test"

# Keep looping (max 10 cycles) until the build+tests pass
osstack loop run --source task_queue --execute "pnpm build" --goal "pnpm test" \
  --cycles 10 --interval-ms 2000

# Let osstack choose the coding agent automatically
osstack loop run --source task_queue --auto-agent --verify "pnpm test"

# Review a working tree's diff with the DeepSeek reviewer
osstack loop run --source git_diff --reviewer ds-review
```

**Exit codes:** `0` all good · `1` config/command error · `2` a task failed,
escalated, or verification did not pass.

Use `--agent <id>` to execute each task through a registered adapter such as
`claude-cli`, `codex-cli`, `opencode-cli`, or `claude-code`. The adapter receives
the task prompt plus `repo_path` in its context and streams Hermes run events
back into the loop result. By default, osstack's CLI adapters reuse the user's
locally authenticated CLI session and do not store model API keys; SDK or
connector adapters remain explicit opt-ins when a provider key is required.

```bash
osstack agent list
osstack loop run --source task_queue --agent claude-cli --verify "pnpm test"
```

### Standalone runner (`osstack-loop`, no daemon, no CLI)

The Loop layer can also run independently through the `@osstack/loop` package's
own `osstack-loop` binary. This path needs neither `@osstack/cli`, the daemon,
Hermes, nor daemon RPC — only the local task queue, shell commands, state files,
and optional git worktrees:

```bash
pnpm --filter @osstack/loop build
pnpm --filter @osstack/loop exec osstack-loop enqueue "Run local checks" --capability code.test
pnpm --filter @osstack/loop exec osstack-loop run --source task_queue --execute "pnpm build" --verify "pnpm test"
pnpm --filter @osstack/loop exec osstack-loop status
pnpm --filter @osstack/loop exec osstack-loop doctor
```

It writes the same `LOOP-STATE.json` / `STATE.md` and supports the same local
safety primitives as `osstack loop run` (verifier commands, finite cycles,
`--stop-when-idle`, `--archive-completed`, `--worktree`). Agent-adapter
selection, daemon-managed background sessions, and Hermes integration remain on
the full `osstack loop` command.

### Worktree isolation (`--worktree`)

When the executor edits code, `--worktree` runs each task in a throwaway git
worktree on an `osstack/loop/<loop_id>/...` branch:

1. Create a worktree from current `HEAD`.
2. Run the executor there.
3. **Pass** → commit and fast-forward merge back into the workspace.
4. **Fail / escalate** → discard the worktree, nothing merged.

Orphaned worktrees under the loop's branch prefix are pruned before and after
each cycle, so a crash never leaves your repo dirty.

```bash
osstack loop run --source task_queue --worktree \
  --execute "node scripts/fix-failing-test.js" --verify "pnpm test"
```

### `loop enqueue` — add a task to the queue

```bash
osstack loop enqueue "<prompt>" [--capability <kind>] [--priority <n>] \
  [--context-json '{"file":"src/app.ts"}'] [--workspace <path>]
```

Writes a single-task JSON file into `tasks/`. `--capability` defaults to
`code.write`, `--priority` to `50`.

### `loop doctor` — preflight a workspace

Checks the workspace exists, queued JSON is valid, git/worktree support is
available, and (with `--daemon`) the daemon socket is reachable.

```bash
osstack loop doctor --workspace "$PWD"
osstack loop doctor --workspace "$PWD" --daemon --json
```

### `loop status` — render current state

```bash
osstack loop status                       # render local LOOP-STATE.json → STATE.md
osstack loop status --daemon --workspace "$PWD"
```

`LOOP-STATE.json` holds the durable machine state (loop id, completed tasks with
outcome/iterations/agent/duration, metrics); `STATE.md` is the human-readable
table generated alongside it.

### Daemon-managed loops — `loop start` / `loop list` / `loop stop`

For a background polling loop that keeps scanning `tasks/*.json` until stopped:

```bash
osstack serve &                                            # daemon must be up

# poll every 5s, stop when tests pass
osstack loop start --workspace "$PWD" --source task_queue --goal "pnpm test" --interval-ms 5000

# or run on a cron schedule (06:00 daily)
osstack loop start --workspace "$PWD" --source task_queue --schedule "0 6 * * *"

osstack loop list                          # show running sessions
osstack loop stop loop_session_abc12345    # stop one
```

`loop start` accepts the same executor/verifier/worktree flags as `loop run`,
plus `--schedule <cron>`, `--interval-ms <ms>`, `--cycles <n>`, `--once`, and
`--stop-when-idle`. Sessions persist in `~/.osstack/loop-sessions.json` and
**resume after a daemon restart** (sessions that were stopped stay stopped).

Use `osstack stats` while the daemon runs to see per-loop cycle totals,
success/failure/escalation counts, token totals, and average cycle duration.

### The reusable Loop Engineering skill

The runtime is also packaged as a repo-local skill in
[`loop-engineering/`](loop-engineering/) for other agents/platforms that want a
stable wrapper instead of calling the TS CLI directly:

```bash
loop-engineering/scripts/loop-doctor.sh
LOOP_VERIFY="pnpm test" loop-engineering/scripts/loop-run.sh
LOOP_GOAL="pnpm test"   loop-engineering/scripts/loop-daemon-start.sh
```

`scripts/osstack-loop.sh` resolves the CLI from `OSSTACK_REPO`, `OSSTACK_CLI`, or
a global `osstack` binary. `references/` documents the flags, task-queue JSON,
and CI integration patterns. The same skill is installable into Claude Code
(`~/.claude/skills/loop-engineering`) and Codex (`~/.codex/skills/loop-engineering`).

---

## Kanban board

osstack ships its own SQLite-backed Kanban board. Every run can mirror to a
card, and cards are **subscribable from Telegram/Slack** via the Hermes relay, so
you can watch agent work from your phone.

**Columns (left → right):** `triage → todo → ready → running → blocked → done → archived`

| Command | Description |
|---|---|
| `osstack kanban board [--archived]` | Show columns and cards (`--archived` includes the archived lane). |
| `osstack kanban create <title> [--priority N] [--assignee A]` | Create a card (starts in `triage`). |
| `osstack kanban move <card_id> <status> [reason]` | Move a card; `reason` becomes the blocked reason when moving to `blocked`. |
| `osstack kanban comment <card_id> <text>` | Add a comment. |
| `osstack kanban subscribe <card_id> <platform> <chat_id> [thread_id]` | Subscribe a chat channel to a card's events. |
| `osstack kanban events [--since N]` | Drain pending card events after event id `N` (used by the Hermes → Telegram relay). |

```bash
osstack kanban create "Ship v0.2 release" --priority 90 --assignee claude-code
osstack kanban move card_ab12cd34 running
osstack kanban subscribe card_ab12cd34 telegram 123456789
osstack kanban events --since 0          # relay drains new events
```

Cards carry `title`, `priority`, `assignee`, `blocked_reason`, timestamps, and an
optional `task_id` linking back to a run. Kanban sync to Hermes is enabled only
when `HERMES_KANBAN_BOARD` is set.

---

## Task orchestration & project management

Submit one-off coding tasks straight to the daemon; the router + policy engine
pick the agent and the run streams events back.

| Command | Description |
|---|---|
| `osstack task submit <prompt> [flags]` | Submit a task; streams `HermesEvent` JSON frames. |
| `osstack task status <run_id>` | Current state of a run. |
| `osstack task cancel <run_id>` | Abort a running task. |
| `osstack task observe <run_id> [seq]` | Replay events from the log starting after `seq`. |

**`task submit` flags:** `--kind <K>` (capability routing hint, e.g. `research.ml`),
`--agent <id>` (pin an adapter), `--tag <T>`, `--max-iter <N>`, `--repo <path>`
(the last three feed the autoresearch loop via `context`).

```bash
osstack task submit "Refactor the payload parser for clarity" --kind code.refactor
osstack task submit "Run the Karpathy autoresearch loop" --kind research.ml --agent autoresearch --max-iter 50
osstack task observe run_9f8c2a11
```

### The router + policy engine

When a task is routed by *kind* (not pinned to a specific agent), the policy
engine ranks every available adapter that advertises the capability:

| Rule | Effect |
|---|---|
| **success rate** | up to **+50** for a high completion rate on this capability |
| **recent failures** | **−15** per failure in the last 24h (capped at −45) |
| **cost bias** | low-cost tier **+15**, mid **+5**, high **0** (tie-breaker) |
| **exact capability** | **+10** when the adapter's capability id matches the kind exactly |
| **clean slate** | **+5** for adapters with no prior runs (cold-start nudge) |

A **handoff kill-switch** flags an agent whose recent failure rate crosses the
threshold so it can be demoted. `osstack killswitch` reports whether the policy
layer is firing often enough to be worth keeping. Prompts are PII-redacted before
they reach any adapter, and every run's outcome is recorded so the ranking
improves over time.

---

## Agent adapters

`osstack agent list` shows the registered adapters, their capabilities, and
whether each is available on this machine (`isAvailable()` probes the underlying
SDK/binary).

| Adapter | Capabilities | Notes |
|---|---|---|
| `claude-code` | `code.write`, `code.refactor`, `code.test`, `code.debug` | Via `@anthropic-ai/claude-agent-sdk`. |
| `codex-cli` | `code.write`, `code.test`, `code.review` | Headless `codex exec --json` subprocess. |
| `autoresearch` | `research.ml` | Single-GPU training loop (Karpathy autoresearch variant). |
| `ds-review` | `review.code` | DeepSeek reviewer; reads `git diff`, writes `reviews/ds-review/latest.md`. |
| `ds-verify` | `code.review` | DeepSeek checker; runs in workspace, writes `reviews/ds-verify/latest.md`. |
| `claude-design` | `design.prd`, `design.architecture`, `design.review` | Design-role adapter. |
| `google-stitch` | `design.*` | Stitch design integration. |

Each adapter declares a **cost tier** (`low`/`mid`/`high`) that feeds the policy
engine's cost bias.

---

## Configuration

Role-based config maps the three lifecycle **roles** to concrete agents, with
per-machine **profiles**. No daemon required.

**Roles:** `coding` · `test-verify` · `design`

| Command | Description |
|---|---|
| `osstack config [show]` | Show the active profile and how each role resolves. |
| `osstack config doctor` | Probe which agents are installed/available. |
| `osstack config pick` | Interactively choose the primary agent per role. |
| `osstack config init` | Write the default config to `~/.osstack/config.yaml`. |
| `osstack config use <profile\|auto>` | Set the active profile (`auto` = match by hostname). |
| `osstack config bind <profile>` | Attach this machine's hostname to a profile. |
| `osstack config get [path]` | Print the config, or a dotted path. |
| `osstack config set <profile>.<role>.<primary\|fallback> <value…>` | Set a value. |

```bash
osstack config init
osstack config set mac-mini.coding.primary claude-code
osstack config set mac-mini.coding.fallback codex-cli
osstack config get mac-mini.coding.primary      # → claude-code
osstack config show
```

`config.yaml` holds `profiles` (each with hostname `match` rules and per-role
`primary`/`fallback` agents) and a `defaults` block used when no profile matches.

---

## Daemon lifecycle & self-update

| Command | Description |
|---|---|
| `osstack serve` | Start the daemon (Unix socket; runs until SIGTERM/SIGINT). |
| `osstack health` | Daemon health: version, uptime, memory, adapters, active runs. |
| `osstack status` | CLI ↔ daemon version handshake + update availability. |
| `osstack stats` | Per-agent run metrics + per-loop session metrics. |
| `osstack killswitch` | Check whether the policy layer is earning its keep (F4). |
| `osstack upgrade [flags]` | Self-update with backup + auto-rollback. |

The daemon guards against duplicate instances with a pidfile, probes the npm
registry at most once per 24h (set `OSSTACK_UPDATE_CHECK=0` to disable), and
surfaces `update_available` in `health`. The CLI and daemon exchange a
`protocol_version` on connect and `osstack status` warns on a mismatch.

### `osstack upgrade`

```bash
osstack upgrade --dry-run                 # show what would happen
osstack upgrade                           # latest channel
osstack upgrade --channel canary          # bleeding edge
osstack upgrade --auto                    # unattended (for cron/launchd)
```

The upgrade is transactional: **resolve target version → back up `state.db`
(keep last 5) → drain + stop the daemon → `npm i -g @osstack/cli@<target>` →
restart → health-check → automatically roll back to the previous version on
failure.** A launchd template (`packages/cli/launchd/`) can run
`osstack upgrade --auto` weekly.

---

## Hermes integration

osstack runs standalone, but can also be a Hermes software-development skill. A
thin Python wrapper (`osstack_bridge.py`) talks to the daemon over the Unix
socket and streams events back into a Hermes session.

| Command | Description |
|---|---|
| `osstack hermes health` | Show the kanban-sync bridge state. |
| `osstack hermes dashboard` | Open the Hermes WebUI in a browser. |
| `osstack hermes register-cron` | Print example `hermes cron` recipes. |

Relevant env vars: `HERMES_BIN` (binary path), `HERMES_AGENT_HOME` (Hermes repo
root, used to locate the bridge binary), `HERMES_KANBAN_BOARD` (board slug; kanban
sync is off unless set), `HERMES_WEBUI_HOST`/`HERMES_WEBUI_PORT` (default
`127.0.0.1:8787`).

---

## External skill registry

Track external skill ecosystems (GStack, Everything Claude, Anthropic Skills, …)
and detect when they drift from a blessed commit.

| Command | Description |
|---|---|
| `osstack skills list` | List tracked sources with their blessed SHA. |
| `osstack skills check` | Compare each `blessed_sha` against origin `HEAD` (exit 2 on drift). |
| `osstack skills add <id> <origin> [ref]` | Track a new source (ref defaults to `main`). |
| `osstack skills bless <id>` | Pin the current origin `HEAD` as blessed. |

---

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `OSSTACK_HOME` | Storage root | `~/.osstack` |
| `OSSTACK_SOCKET` | Daemon socket path | `$OSSTACK_HOME/daemon.sock` |
| `OSSTACK_UPDATE_CHECK` | Set `0` to disable the daily update probe | enabled |
| `HERMES_BIN` | Hermes binary path | auto-detect |
| `HERMES_AGENT_HOME` | Hermes repo root (for the kanban bridge binary) | `~/.hermes` |
| `HERMES_KANBAN_BOARD` | Kanban sync board slug (sync off if unset) | — |
| `HERMES_WEBUI_HOST` / `HERMES_WEBUI_PORT` | Hermes WebUI address | `127.0.0.1` / `8787` |
| `OSSTACK_DS_REVIEW_BIN` / `OSSTACK_DS_VERIFY_BIN` | Override DeepSeek reviewer/checker binaries | auto |
| `LOOP_VERIFY` / `LOOP_GOAL` / `LOOP_WORKTREE` | Defaults for the `loop-engineering/` scripts | — |
| `OSSTACK_REPO` / `OSSTACK_CLI` | CLI resolution for the `loop-engineering/` scripts | — |

---

## Monorepo layout

| Package | Role |
|---|---|
| [`@osstack/cli`](packages/cli) | The `osstack` binary (daemon, all commands, loop runner, upgrade). |
| [`@osstack/loop`](packages/loop) | Loop Engineering runtime: discover → execute → verify → iterate. |
| [`@osstack/core`](packages/core) | Orchestrator, router, policy engine, kanban, memory, privacy, observability, SQLite state. |
| [`@osstack/agents`](packages/agents) | Sub-agent adapters (claude-code, codex-cli, ds-review/verify, …) + worktree utils. |
| [`@osstack/config`](packages/config) | Role-based agent configuration + profiles. |
| [`@osstack/hermes-adapter`](packages/hermes-adapter) | Hermes Run-Adapter contract: events, status FSM, socket framing. |
| [`@osstack/skill-registry`](packages/skill-registry) | External skill ingestion + blessed-SHA drift detection. |
| [`@osstack/skills`](packages/skills) | Lifecycle skill templates + `osstack init` scaffold. |
| [`@osstack/plugins`](packages/plugins) | Plugin slot definitions (runtime/agent/workspace/tracker/notifier/reviewer/verifier). |
| [`@osstack/runtime`](packages/runtime) | Optional Zellij/terminal workspace manager. |

The professional-services agent vertical (Elon/Jobs/Linus/Turing/Bezos/Qian
personalities, intent engine, approval desk) lives in a **separate repo**,
[partner-os](https://github.com/gilosbornhello/partner-os), which builds on these
`@osstack/*` packages.

---

## Develop

```bash
git clone https://github.com/gilosbornhello/osstack.git ~/Developer/osstack
cd ~/Developer/osstack
corepack enable pnpm
pnpm install
pnpm build          # build all packages (tsup for the CLI, tsc for libs)
pnpm test           # vitest across all packages
pnpm typecheck      # tsc --noEmit
pnpm lint           # Biome
```

**Loop demos & smoke tests:**

```bash
pnpm demo:loop          # repair a broken add() via loop run, print the workspace
pnpm demo:loop:daemon   # same repair through a real osstack serve + daemon RPC
pnpm smoke:loop         # end-to-end: queue, worktree, reviewer, cron, restart recovery
pnpm coverage:loop      # enforce the ≥80% coverage gate on @osstack/loop
```

**Releases** are managed with [changesets](https://github.com/changesets/changesets):
add a changeset with `pnpm changeset`, and the release workflow opens a "Version
Packages" PR that publishes to npm on merge. See
[RELEASING.md](RELEASING.md) for the bi-weekly release-train process.

Before publishing, deploying Knowledge Cloud, or uploading single-binary release
assets, run:

```bash
osstack release doctor --json
osstack release plan --target all --output release-plan.md --json
```

It checks GitHub auth, repository secrets (`NPM_TOKEN`, `FLY_API_TOKEN`), local
npm/Fly.io auth, npm publish assets, Knowledge Cloud deploy assets, and
single-binary release assets so the release train fails before a partial
publish/deploy/upload is mistaken for production readiness.

---

## License

MIT. See [LICENSE](LICENSE).

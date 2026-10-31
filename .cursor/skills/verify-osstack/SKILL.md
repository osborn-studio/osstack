---
name: verify-osstack
description: Drive the real osstack product from this checkout and prove behavior with evidence. osstack is a CLI (`osstack`, packages/cli) plus a local daemon (`osstack serve`, Unix socket) that also serves the HTML cockpit/dashboard. Use when you need to launch an isolated daemon, run osstack commands (deliver, kanban, cockpit, init, doctor) like a user, screenshot the cockpit, and keep proof after teardown — e.g. before a PR that changes CLI, daemon, kanban, loop/deliver, or dashboard behavior.
---

# Verify osstack

osstack is a local-first AI development control plane. Surfaces, in order of importance:

1. **CLI** — `node packages/cli/dist/bin.js <command>` (the `osstack` binary). Primary surface. Some commands are local-only (`deliver`, `report`, `proof`, `init`, `doctor`, `config`), others need the daemon (`kanban`, `health`, `cockpit`, `task`, `stats`).
2. **Daemon** — `osstack serve`: JSON-RPC on a Unix socket (`OSSTACK_SOCKET`), SQLite at `$OSSTACK_HOME/state.db`.
3. **Cockpit (web)** — served by the daemon at `http://127.0.0.1:$OSSTACK_DASHBOARD_PORT/dashboard`, JSON at `/api/dashboard`. Read-only view of runs, evidence, agents, kanban.

Not covered here: Knowledge Cloud (`packages/knowledge-cloud`, EdgeOne deploy), Hermes skill bridge (`hermes-skill/`), macOS launchd (`serve --install`), npm/single-binary release flows, anything that calls a live coding agent or GitHub.

**Hard rule (AGENTS.md "Control-plane DB discipline"):** never run this checkout's CLI against `~/.osstack` or a reserved home — opening the DB auto-migrates it. Every command below runs with a scratch `OSSTACK_HOME`; the helper enforces it. Do not drive a daemon you did not launch.

Helpers (executable, in `scripts/`):

- `scripts/verify-osstack.sh` — `build | launch | doctor | env | cli | workspace | screenshot | keep | cleanup`. All state is keyed by `RUN_ID`.
- `scripts/cockpit-capture.mjs` — headless Chrome over CDP: navigate, wait until the cockpit renders (and optional text), write PNG + DOM + innerText. Called by `screenshot`; usable directly.

Set once per run (from the repo root):

```bash
export RUN_ID=verify-$(date +%Y%m%d-%H%M%S)      # unique => parallel runs never share home, socket, or port
V=.cursor/skills/verify-osstack/scripts/verify-osstack.sh
```

Prerequisites: Node **>= 22** first on `PATH` (CI uses 22; with Node 20 the pinned pnpm 11.4 crashes with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`), `corepack enable pnpm` (set `COREPACK_HOME` to a writable dir if `/usr/local/share/corepack` is read-only), Chrome/Chromium for UI proof (`CHROME_BIN` overrides), `curl`, `ss`, `git`.

## Launch

```bash
$V build     # once per checkout change: pnpm install --frozen-lockfile && pnpm --filter "@osstack/cli..." build  (~25s)
$V launch    # prints: ready: pid=<pid> socket=<...>/daemon.sock dashboard=http://127.0.0.1:<port>/dashboard evidence=<dir>
```

`launch` creates `/tmp/osstack-verify/$RUN_ID/home` (empty; the daemon migrates `state.db` on first open — no seed data is required), picks a free dashboard port, starts `node packages/cli/dist/bin.js serve` in the background, and returns only when all three hold: `serve.log` contains `osstack daemon listening on`, `osstack health` answers, and `/api/dashboard` returns JSON. Expected first log line: `control-plane guard: role=undeclared-dev home=custom`. Any other guard line (or `refusing to serve`, exit 78) means the env is wrong — stop.

To run raw commands in your own shell against this instance: `eval "$($V env)"` then `osstack <args>` (a shell function wrapping the checkout's `bin.js`). Prefer `$V cli` so evidence is recorded.

Teardown is `$V cleanup` (see Cleanup).

## Doctor

```bash
$V doctor
```

Read-only. Checks: the recorded pid is alive and is this checkout's `bin.js serve`; `OSSTACK_HOME` is the scratch home (not `~/.osstack`); `health` RPC ok; health `db_path` is inside the scratch home; daemon version equals `osstack --version` of this checkout (catches a stale build); the dashboard port is owned by our pid; `/dashboard` serves `<title>osstack Cockpit</title>`. Ends with `doctor: healthy (RUN_ID=...)` or `doctor: NOT healthy — do not drive` (exit 1). Run it first, and again whenever output looks odd. After rebuilding, `cleanup` + `launch` again: a running daemon keeps the old code.

## Drive

Recipes per feature live in [`features/`](features/README.md). Shared mechanics:

- **CLI:** `$V cli <label> -- <osstack args...>` runs the command with the run's env and writes `cli/<label>.{cmd,stdout,stderr,exit}` to evidence; it prints stdout and returns the command's exit code. Use `--json` where offered and assert on parsed JSON, not on prose.
- **Scratch git repo:** `W=$($V workspace [name])` creates `/tmp/osstack-verify/$RUN_ID/workspaces/<name>` with one commit on `main`. Use one fresh workspace per `deliver` journey (the task queue persists in the workspace).
- **Cockpit:** `$V screenshot <label> [/dashboard?workspace=<urlencoded W>] ["text to wait for"]` writes `ui/<label>.png|.dom.html|.text.txt` plus `ui/<label>.api-dashboard.json`; exit 1 if the page or the wait text never renders (20s). Stable handles in the page: `#board` (kanban columns), `#runs`, `#evidence`, `#agents`, `#metrics`, `#attention` (`role=status`), `#generated` (timestamp; `loading...` until first data load).
- **HTTP:** `curl -fsS http://127.0.0.1:$OSSTACK_DASHBOARD_PORT/api/dashboard` (keys: `dashboard, overview, board, quality, agents, agent_scorecards, evidence, lessons, autonomy, recent_runs, next_steps`).
- **Keep artifacts the app writes into scratch:** `$V keep <label> <path>` copies into `kept/<label>/` before cleanup.

## Evidence

Location: `${OSSTACK_VERIFY_EVIDENCE:-$HOME/osstack-verify-evidence}/$RUN_ID/` — outside the repo and outside scratch, so cleanup never removes it and git never sees it.

```
serve-launch.log  serve-final.log
cli/<label>.cmd|.stdout|.stderr|.exit
ui/<label>.png|.dom.html|.text.txt|.api-dashboard.json
kept/<label>/...            # proof packs, reports copied out of scratch workspaces
```

Proof standards:

- Exercise the real user path: the `osstack` CLI and the served cockpit. Do not call internal functions, write SQLite directly, or use vitest helpers as proof.
- Capture the action and the result: the CLI command + exit code, then a second, read-only view of the new state (e.g. `kanban board` / `kanban events` after `kanban create`, cockpit screenshot showing the card, `proof validate` after `deliver`).
- Verify side effects, not just messages: files written in the workspace, proof pack `manifest.json` + `sha256sums.txt`, events in `kanban events`.
- `deliver --execute "<shell>"` is the deterministic, no-LLM path (shell executor, `local-verifier`). It is real product behavior, not a mock, but it does not exercise Claude/Codex adapters — say so when reporting. Never add `--autonomy guarded-git` (opens PRs, waits on CI, merges). `--land-branch` merges locally into `--workspace`; use it only on a scratch repo from `$V workspace` (no remote).
- Report a journey that cannot run with the exact command, exit code, and unmet precondition. Never weaken a journey to make it pass.

## Cleanup

```bash
$V cleanup
```

Stops only the pid recorded in `/tmp/osstack-verify/$RUN_ID/daemon.pid`, after confirming its cmdline is this checkout's `bin.js serve` (never kill by name). Copies the final `serve.log` into evidence, then deletes `/tmp/osstack-verify/$RUN_ID` (home, DB, socket, workspaces). Prints `evidence kept: <dir>`. Confirm with `ls <dir>` afterwards. `cockpit-capture.mjs` kills its own Chrome and deletes its temp profile on exit. Run cleanup after every failed attempt too.

## Helpers

```bash
.cursor/skills/verify-osstack/scripts/verify-osstack.sh            # usage
node .cursor/skills/verify-osstack/scripts/cockpit-capture.mjs <url> <out-prefix> [--wait-text TEXT] [--timeout-ms N]
```

Env knobs: `RUN_ID` (default `default`), `OSSTACK_VERIFY_SCRATCH` (default `/tmp/osstack-verify`), `OSSTACK_VERIFY_EVIDENCE` (default `$HOME/osstack-verify-evidence`), `CHROME_BIN`.

Known trap: in the Linux box where this skill was proven, Chrome's one-shot `--headless --screenshot`/`--dump-dom` never finished (even on a `data:` URL), so capture goes through CDP instead.

Maintenance: keep `features/` honest as the app changes with `/maintain-verification-skill`.

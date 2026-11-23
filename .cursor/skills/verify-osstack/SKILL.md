---
name: verify-osstack
description: Drive the real osstack product from this checkout and prove behavior with evidence. osstack is a CLI (`osstack`, packages/cli) plus a local daemon (`osstack serve`, Unix socket) that also serves the HTML cockpit/dashboard. Use when you need to launch an isolated daemon, run osstack commands (deliver, kanban, cockpit, init, doctor, decisions) like a user, screenshot the cockpit, and keep proof after teardown — e.g. before a PR that changes CLI, daemon, kanban, loop/deliver, or dashboard behavior.
---

# Verify osstack

osstack is a local-first AI development control plane. Surfaces, in order of importance:

1. **CLI** — `node packages/cli/dist/bin.js <command>` (the `osstack` binary). Primary surface. Some commands are local-only (`deliver`, `report`, `proof`, `init`, `doctor`, `config`), others need the daemon (`kanban`, `health`, `cockpit`, `task`, `stats`, `decisions`).
2. **Daemon** — `osstack serve`: JSON-RPC on a Unix socket (`OSSTACK_SOCKET`), SQLite at `$OSSTACK_HOME/state.db`.
3. **Cockpit (web)** — served by the daemon at `http://127.0.0.1:$OSSTACK_DASHBOARD_PORT/dashboard`, JSON at `/api/dashboard`. Read-only view of runs, evidence, agents, kanban.

Not covered here: Knowledge Cloud (`packages/knowledge-cloud`, EdgeOne deploy), Hermes skill bridge (`hermes-skill/`), macOS launchd (`serve --install`), npm/single-binary release flows, anything that calls a live coding agent or GitHub, contained Missions / bridge publication (`packages/cli/src/contained-mission-*.ts`, `packages/github/src/delivery.ts`; needs Codex/Docker + App keys), W13 gated host-process launcher (`packages/agents/src/contained-workspace/host-process.ts`; used by contained Mission remote/ref writes — needs a live Mission host), bridge App E shadow merger / merge-gates (`packages/core/src/bridge/merge-gates.ts`, `packages/core/src/state/engineering-merger-store.ts`; needs shadow observations + App keys), sandbox CI repair + App E merge and its merge gates (`packages/cli/src/contained-mission-sandbox-ci-merge.ts`, `contained-mission-sandbox-app-e*.ts`, `contained-mission-github-ci*.ts`, `contained-mission-ci-auto-grant.ts`; sandbox repo + App keys), local-failure intake / pinned host verification profiles (`packages/cli/src/contained-mission-local-failure-reader*.ts`, `contained-mission-verification-profile.ts`, `contained-mission-profile-execution.ts`, `packages/core/src/bridge/local-failure*.ts`, `packages/core/src/state/engineering-local-failure-intake-*.ts` — the intake journal is registered as migration 58 with shared root exclusion and budget since #467, but nothing on the CLI writes it; needs a live Mission host), local-failure diagnosis admission + typed host receipts, single repair dispatch, and candidate-bound repair approval + same-PR publication (`packages/cli/src/contained-mission-diagnosis.ts`, `contained-mission-local-failure-{dispatch,approval,publish,paths}.ts`, `packages/core/src/bridge/diagnosis-admission.ts`, `packages/core/src/state/engineering-diagnosis-*.ts`, `engineering-local-failure-dispatch-*.ts`, migrations 59–60, #470/#472/#473; library-only, no CLI entry point), local repair push close-out and the published-repair recheck ledger + signed V2 recheck opt-in / grant check (`contained-mission-runner.ts` `resumeConfirmedLocalPublication`, `contained-mission-local-failure-publish.ts`, `packages/core/src/bridge/recheck*.ts`, `revision-local-failure-grant.ts`, `packages/core/src/state/engineering-local-failure-recheck-*.ts`, migration 62, #475/#478/#481; library-only — the host recheck run is design-only in `docs/design/2026-11-19-host-recheck-run.md`, #480), Mission chain depth stop at the eighth hop (`engineering-chain-depth-gate-ddl.ts`, migration 61, `MAX_REPAIR_CHAIN_DEPTH`, #476; needs a live Mission host with a deep derived chain — only the empty-DB migration is exercised by `launch`), shadow verification result reader + source ledger (`packages/cli/src/contained-mission-verification-reader.ts`, `packages/core/src/bridge/verification-source-ledger.ts`, `packages/core/src/state/engineering-verification-source-*.ts`, migration 57, #466; unwired shadow), Mission CI chain / lineage / installed-profile runs (`contained-mission-ci-chain-read.ts`, `engineering-mission-lineage*.ts`, `packages/agents/src/contained-profile-run.ts`; live Mission host), strict verification result contract (`packages/core/src/bridge/verification-result*.ts`; library-only), adapter report repair (`packages/loop/src/report-repair.ts`; live coding agent), loop runtime-budget behavior under a rewound clock (`packages/loop/src/loop-engine.ts`, #479; deterministic only through unit tests and the seeded long-run simulation `loop-random.simulation.test.ts`, #477), attention HTTPS webhook sender (`attention-webhook-delivery.ts`; needs an HTTPS receiver), pending-decision attention notices, including the depth-stop `chain` facts added by #476 (`packages/cli/src/decisions/notices.ts`, #471/#476; needs `OSSTACK_ATTENTION=1`, a configured sender, and non-empty pending decisions), `upgrade` self-update / native upgrade gate (`packages/cli/src/upgrade*.ts`; touches the installed CLI and the real home), non-empty `decisions list` and accepted `decisions answer` (seeded sources + engineering credential; only the empty/refusal paths are mapped), sandbox bridge probes (`scripts/bridge-probe-github.mjs`), pr, and rulesets check (`scripts/rulesets-check.mjs`, `.github/rulesets/*`). Also not covered (#482–#499, library-only or needs a live Mission host / seeded sources): local-failure merge interlock + close-out reader, host recheck run journal / run + recovery / collector / production ports and the Actions attempt fact (`packages/cli/src/contained-mission-local-failure-{closeout,recheck-run,recheck-collect,recheck-ports}.ts`, `contained-mission-actions-attempt.ts`, `packages/core/src/bridge/verification-gate.ts`, `packages/core/src/state/engineering-local-failure-recheck-run-*.ts`; #482/#488/#491/#496/#498), verification identity proof / read transport / producer policy loader and result builder (`contained-mission-verification-{installation,producer-config,read-transport}.ts`, `packages/core/src/bridge/verification-result-builder.ts`; #493/#494), refused Actions CI repair on the root Mission (#487), host-signed local-failure revision grants and their `decisions answer` `local_only` routing (`contained-mission-grant*.ts`, #499; the route switch arrived in #503, see below), idempotent Hermes `approval.resolve` / `clarify.resolve` retries (`packages/cli/src/decisions/hermes-resolve.ts`, #492; Hermes RPC), and daemon loop session budget stats (`packages/cli/src/daemon.ts` `loopBudgetStat`, #484/#490; only the local `loop run` side is mapped in deliver.md). Also not covered (#501–#523; behind `OSSTACK_CONTAINED_MISSIONS=1` + an engineering authority, or cloud-side): the cloud verification publisher package and its runbook (`packages/verify-publisher/`, private, never imported by host packages, `docs/runbooks/bridge-verification-publisher.md`; #501/#508), the local-failure route switch `OSSTACK_LOCAL_FAILURE_REPAIR=1` with startup recovery, registered-diagnosis scan/run and verification-failure read/record/register (`packages/cli/src/contained-mission-local-failure-{switch,service,scan,diagnose}.ts`, `contained-mission-verification-profile-host-config.ts`; the contained service refuses to start with it unless `OSSTACK_BRIDGE` is live and automatic merge is off; #503/#510/#513), version 2 grants read by the reconciler / child cancellation / status, passing the review revision fences, renewed as version 2 in the chain store (migration 64, one chain trigger) and through `mission grant-revisions --chain` on the host-signed path, and a renewed grant on the run head starting a recheck (`contained-mission-grant*.ts`, `packages/core/src/bridge/{stored-revision-grant,revision-local-failure-renewal,recheck-admission}.ts`, `engineering-local-failure-grant-ddl.ts`; #505/#506/#511/#512/#514 — `launch` only exercises the empty-DB migration to 64; a live chain holding a version 2 grant now also offers `grant_revisions` in `decisions list`, which stays unmapped with the other non-empty lists), the grant service's `localFailureEnabled` option now fed from that route switch (`contained-mission-bridge-assembly.ts`, `contained-mission-bridge-production.ts`, `contained-mission-rpc.ts`; without the switch every version 2 preview and grant stays refused; #516), waiting local-failure work carried across a version 2 grant renewal (R4: dispatch and the publication fence honour a row bound to an earlier grant of the chain when the current grant renews this chain and keeps the intake pin; the renewal preview refuses early when the root is busy or the pin changed; `mission grant-revisions` lists eligible diagnoses, a waiting repair candidate, and pending recheck attempts — `contained-mission-grant-command.ts`, `contained-mission-grant.ts`, `engineering-local-failure-{renewal-facts,dispatch-store}.ts`, `engineering-revision-chain-store.ts`; #517), one repair child dispatched per eligible diagnosis behind the route switch (W5: a one-minute timer dispatches at most one eligible unconsumed request per tick, one repair per root, and never retries a refused root — `contained-mission-local-failure-dispatch-step.ts`, wired through `contained-mission-local-failure-service.ts`; #518), the close-out view of a pending recheck now shows which inputs it still needs and when the wait began, and a library sends one notice per ledger row after a configured wait with no production caller (B8-4: `contained-mission-local-failure-recheck-waiting.ts`, `contained-mission-local-failure-closeout.ts`, `attention-webhook-delivery.ts`; #520), a version 1 revision grant can be upgraded to local-failure by a signed renewal (R5: with `--chain` and all required local-failure flags, the host preview titles the upgrade and the operator types `UPGRADE LOCAL-FAILURE <digest>`; the daemon refuses unless the local-failure switch is on — `contained-mission-grant-command.ts`, `contained-mission-grant.ts`, `engineering-revision-chain-store.ts`; #521), the host-only candidate approval entry `mission approve-local-failure-repair --mission ID --candidate SHA` (W6: RPC `mission.approve_local_failure_repair`; refused with `local_failure_route_disabled` when the switch is off and `local_failure_publication_unavailable` while `publicationReady` is false, which W6 sets; a repair child at `publication_pending` is listed with `approve_local_failure_repair` and `requires_local_signature`, and `decisions.answer` returns `local_only` for that answer — `contained-mission-command.ts`, `contained-mission-rpc.ts`, `contained-mission-local-failure-service.ts`, `decisions/{list,answer}.ts`; #522), a refused local-failure dispatch is offered once more after a version 2 renewal of its own chain (W5b: a later `grant_replaced` on that chain re-opens one attempt; a further refusal closes it until the next renewal — `contained-mission-local-failure-dispatch-step.ts`, `engineering-diagnosis-store.ts`, `engineering-local-failure-dispatch-store.ts`; #523), and the graph post-SIGKILL exit confirmation window (`packages/cli/src/graph-runtime.ts`, `graph-worker-manager.ts`, #504; `graph` is not covered). Docs/test-only, nothing to map: #507, #509.

**Hard rule (AGENTS.md "Control-plane DB discipline"):** never run this checkout's CLI against `~/.osstack` or a reserved home — opening the DB auto-migrates it. Every command below runs with a scratch `OSSTACK_HOME`; the helper enforces it. Do not drive a daemon you did not launch.

Helpers (executable, in `scripts/`):

- `scripts/verify-osstack.sh` — `build | launch | doctor | env | cli | workspace | screenshot | keep | cleanup`. All state is keyed by `RUN_ID`.
- `scripts/cockpit-capture.mjs` — headless Chrome over CDP: navigate, wait until the cockpit renders (and optional text), write PNG + DOM + innerText. Called by `screenshot`; usable directly.

Set once per run (from the repo root):

```bash
export RUN_ID=verify-$(date +%Y%m%d-%H%M%S)      # unique => parallel runs never share home, socket, or port
V=.cursor/skills/verify-osstack/scripts/verify-osstack.sh
```

Prerequisites: Node **>= 22** first on `PATH` (CI uses 22; with Node 20 the pinned pnpm 11.4 crashes with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`), `corepack enable pnpm` (set `COREPACK_HOME` to a writable dir if `/usr/local/share/corepack` is read-only), Chrome/Chromium for UI proof (`CHROME_BIN` overrides), `curl`, `ss`, `git`. Check `pnpm -v` prints `11.4.0` from the repo root: an older global pnpm earlier on `PATH` (seen: 9.15.9 in `~/.local/bin`) makes `build` fail with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` on the `overrides` block — put the corepack shim first. If a wrong-version `pnpm install` already ran, it can leave `node_modules/` holding only `.pnpm-workspace-state-v1.json`; pnpm 11.4 then prints `Already up to date` and `build` fails with `tsc: not found` — delete that state file (only that file) and rerun `$V build`. Use the same Node major for `build` and `launch`: a `better-sqlite3` binary installed for another ABI (e.g. built under Node 22, launched under Node 24) makes `launch` print `daemon exited during launch` with `NODE_MODULE_VERSION` in the output.

## Launch

```bash
$V build     # once per checkout change: pnpm install --frozen-lockfile && pnpm --filter "@osstack/cli..." build  (~25s; clears stale package tsbuildinfo if dist/index.js is missing, retries once on failure)
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

Recipes per feature live in [`features/`](features/README.md). The 39 UI/CLI recipes in the five default feature files remain the default. For an explicitly requested bridge check, read the optional [contained Mission bridge recipe](features/contained-mission-bridge.md). It separates credential-free offline checks from operator-gated real 5-G; it does not enable live execution or production acceptance. The default exclusions above still apply outside that recipe. Shared mechanics:

- **CLI:** `$V cli <label> -- <osstack args...>` runs the command with the run's env and writes `cli/<label>.{cmd,stdout,stderr,exit}` to evidence; it prints stdout and returns the command's exit code. Use `--json` where offered and assert on parsed JSON, not on prose.
- **Scratch git repo:** `W=$($V workspace [name])` creates `/tmp/osstack-verify/$RUN_ID/workspaces/<name>` with one commit on `main`. Use one fresh workspace per `deliver` journey (the task queue persists in the workspace).
- **Cockpit:** `$V screenshot <label> [/dashboard?workspace=<urlencoded W>] ["text to wait for"]` writes `ui/<label>.png|.dom.html|.text.txt` plus `ui/<label>.api-dashboard.json`; exit 1 if the page or the wait text never renders (20s). Stable handles in the page: `#board` (kanban columns), `#runs`, `#evidence`, `#agents`, `#metrics`, `#attention` (`role=status`), `#generated` (timestamp; `loading...` until first data load).
- **HTTP:** `curl -fsS http://127.0.0.1:$OSSTACK_DASHBOARD_PORT/api/dashboard` (keys: `dashboard, overview, board, quality, agents, agent_scorecards, evidence, lessons, autonomy, attention, recent_runs, next_steps`).
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

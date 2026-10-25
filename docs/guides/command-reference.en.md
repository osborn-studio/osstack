# OSStack task-oriented command reference

[README](../../README.md) · [中文](command-reference.md) · [Graph parameters](graph-quickstart.en.md) · [Generated top-level inventory](../inventory/CLI_COMMANDS.md)

This is a common-options guide. Use `osstack --help` and `osstack <command> --help` for the installed version's full surface. Main, npm, internal installations and single binaries can differ. Always set a separate private OSSTACK_HOME for a source checkout.

| Goal | Entry point | Options / next step |
|---|---|---|
| Inspect workspace readiness | `osstack doctor --workspace .` | `osstack examples` for examples |
| Deliver a coding task | `osstack deliver "task" --verify "pnpm test" --auto-agent --worktree --json` | Executes agents and checks; inspect delivery evidence |
| Queue a task | `osstack loop enqueue "task" --workspace . --capability code.test` | Enqueue does not execute the task |
| Process a queue | `osstack loop run --workspace . --source task_queue --verify "pnpm test" --report --scorecard --proof --json` | Select `--agent ID` or `--auto-agent` |
| Run a fixed engineering graph | `osstack graph run --request FILE --json` | Configure host, scope and spec first |
| Audit documentation/instructions | `osstack neat check --repo . --all --fail-on none --json` | Read-only; does not rewrite README or source |
| Check change contracts | `osstack neat check --base origin/main --fail-on warning --json` | Different scope from a full-repository audit |
| Preview supported repairs | `osstack neat fix --help` | Preview by default; apply remains policy/approval gated |
| Clarify requirements | `osstack probe --help` | Explicit session lifecycle, not an automatic background job |
| Inspect agents/config | `osstack agent list`, `osstack config doctor` | Installation/login/availability; keep secrets out of repository config |
| Govern execution | `osstack policy check`, `osstack start "goal" --repo-id ID --json` | control inspect/approve/revise/stop; approval is not automatic execution |
| Inspect evidence | `osstack report --help`, `scorecard --help`, `proof --help`, `pr --help` | Reports, scorecards, proof packs, PR operations |
| Run the service | `osstack serve`, `osstack health --json` | `autonomy health --json` checks write admission separately |
| Continue agent sessions | `osstack session --help` | start/snapshot/send, with idempotency/version constraints |
| Inspect dashboard/kanban | `osstack cockpit`, `osstack dashboard`, `osstack kanban --help` | External bot transport required; not a complete built-in OSBot |
| Supervise repositories | `osstack supervise --help`, `osstack daily --json` | Registry, maturity and daily brief |
| Retrieve knowledge | `osstack knowledge --help` | Local/cloud packs, search, review and sync |
| Check release readiness | `osstack release --help` | doctor/status/plan/handoff; not proof publication occurred |

## Common Loop options

| Flag | Meaning |
|---|---|
| `--workspace P` | Working directory; default cwd |
| `--source S` | Repeatable: task_queue, git_diff, github_branch |
| `--agent ID` / `--auto-agent` | Explicit adapter / policy routing |
| `--profile P`, `--role R=ID` | Profile and repeatable coder/evaluator/designer overrides |
| `--execute CMD` | Shell command per task |
| `--verify CMD` | Repeatable shell verifier; nonzero means failure |
| `--reviewer ID` / `--checker ID` | Repeatable adapter verifier; checker is an alias |
| `--max-iter N` | Iterations before escalation; default 1 |
| `--max-runtime-ms N` | Total runtime budget in milliseconds |
| `--max-tokens N` / `--max-cost-usd X` | Adapter-reported token/spend budgets |
| `--command-timeout-ms N` | Timeout for execute, verify and goal commands |
| `--no-progress-limit N` | Opt-in stop after consecutive task cycles without success |
| `--goal CMD` | Exit 0 establishes the global goal |
| `--cycles N`, `--stop-when-idle` | Finite cycles / stop on the first idle cycle |
| `--worktree` | Separate task worktree, merged back on success; unlike Graph artifact_only |
| `--report --scorecard --proof` | Generate evidence artifacts |
| `--govern strict --govern-scope changed` | Strict governance over changed files |
| `--neat-finalize` | Non-gating neat evidence after success |
| `--json` | Machine-readable summary |

Use `loop start` for daemon polling; `--interval-ms` defaults to 5000. `--once` means start with `--cycles 1 --stop-when-idle`. Use `loop list`, `loop stop ID`, and `loop status --workspace .` to inspect/control sessions.

## Documentation workflow

See [installation and upgrade](install-upgrade.en.md), the [Firstmate command guide](firstmate-commands.en.md), and [bilingual documentation maintenance](documentation-maintenance.en.md).

## What neat does

`osstack neat` defaults to `neat check`. It audits knowledge surfaces, instruction budgets, references and change contracts. It does not delete old files or format the repository. `--all` scans recognized knowledge surfaces; default worktree mode is change-scoped. `--fail-on none|error|warning` controls finding-based exit behavior; exit 0 can include warnings.

Read findings and coverage before making changes. Explicit `neat semantic` requires an isolated judge provider; remediation transactions separate planning, approval and application. See the [neat guide](neat.md) and [task closeout workflow](task-closeout.en.md).

# osstack verification map

This directory is the maintained source for verifying user-facing osstack behavior. Read this index before driving the app, then use the matching feature file as the recipe. Harness: `verify-osstack.sh` (see `../SKILL.md`).

## Baseline preconditions

- Node >= 22 on `PATH`; `$V build` has run on the current checkout.
- `export RUN_ID=<unique>` and `V=.cursor/skills/verify-osstack/scripts/verify-osstack.sh`, from the repo root.
- `$V launch` reported `ready:` and `$V doctor` ends with `doctor: healthy`.
- The scratch home starts empty: no kanban cards, no runs, no evidence.
- Never point this checkout's CLI at `~/.osstack`; never drive a daemon this run did not launch.

## Driving conventions

- Run CLI steps through `$V cli <label> -- <osstack args>` so command, stdout, stderr, and exit code are recorded.
- Use `--json` where a command offers it and assert on parsed fields.
- Use a fresh `W=$($V workspace <name>)` for every journey that writes into a workspace.
- Treat commands as literal. Keep quoted titles and flags unchanged.
- Cockpit steps go through `$V screenshot <label> [path] [wait-text]`; stable handles are element ids (`#board`, `#runs`, `#evidence`, `#metrics`, `#generated`).

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final output.
- Mutation proof includes a second read-only view (`kanban board`, `kanban events`, `report`, `proof validate`, cockpit).
- Copy workspace artifacts into evidence with `$V keep` before `$V cleanup`.
- Report an unreachable path with the attempted command, exit code, and unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-osstack.sh` (starting with `Preconditions:`), `Gotchas`. Keep implementation details out; name user paths, handles, state, commands, and observable proof.

## Features

- [Deliver a task](./deliver.md) — `osstack deliver` turns a prompt into a loop run with verify results, report, scorecard, and proof pack.
- [Kanban board](./kanban.md) — create, move, comment, subscribe, and drain events on the daemon's board.
- [Cockpit dashboard](./cockpit.md) — the daemon-served HTML cockpit, its JSON API, and the `cockpit`/`dashboard` CLI views.
- [Project init and doctor](./init-doctor.md) — scaffold a project with `osstack init` and check readiness with `osstack doctor`.

Not yet mapped (candidates for `/maintain-verification-skill`): `start`/`control` contract-gated delivery (needs `.osstack/repos.json` + `.osstack/repo.yaml` fixtures), `task submit` (needs a live agent), `graph`, `probe`, `neat check`, `attention`, `config`, `daily`, `release doctor` (needs GitHub/npm auth).

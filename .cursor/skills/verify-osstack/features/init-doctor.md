# Project init and doctor

A new user scaffolds the OSBORN project layout with `osstack init` and asks `osstack doctor` whether the workspace, task queue, loop state, and agents are ready, with next steps.

## Sub-features

- `init-scaffold` creates `.agent/PROJECT_CONTEXT.md`, `AGENTS.md`, `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/SPRINTS.md`, `tasks/`.
- `init-idempotent` a second `init` prints `skipped <path> (already exists)` and does not overwrite files.
- `doctor-workspace` `doctor --workspace P --json` reports `ok` and per-check status (`workspace`, `task_queue`, `state_file`, ...).
- `doctor-daemon` `doctor --daemon` also checks the daemon over the socket.
- `config-doctor` `osstack config doctor` lists which agent CLIs are installed.

## How to get to it (user POV)

- Run `osstack init [dir]` in a terminal.
- Run `osstack doctor [--workspace P] [--daemon] [--json]`.
- Run `osstack config doctor`.

## Driving it with verify-osstack.sh

Preconditions:

- Doctor healthy (only needed for `--daemon`). A fresh directory: `D=/tmp/osstack-verify/$RUN_ID/workspaces/init; mkdir -p "$D"` (or `D=$($V workspace init)` for a git repo).

- **Init.** Run `$V cli init -- init "$D"`. Exit `0`; stdout lists `created  <D>/AGENTS.md` and the other scaffold files; `ls -a "$D"` shows `.agent AGENTS.md docs tasks`.
- **Init again.** Edit `$D/AGENTS.md` (append a line), run `$V cli init-2 -- init "$D"`. Stdout lists `skipped ... (already exists)` per file; the appended line is still present.
- **Doctor.** Run `$V cli doctor -- doctor --workspace "$D" --json`. Exit `0`; JSON `ok: true`, `loop.daemon_checked: false`, `loop.checks[]` ids `workspace, task_queue, state_file, git, agent_instructions, protected_config`. On a fresh non-git dir observed `state_file`, `git`, `protected_config` = `warn` ("loop state file will be created after the first run", "workspace is not a git worktree", "could not check protected config file status"). Report warnings; do not edit files to make them pass.
- **Doctor with daemon.** Run `$V cli doctor-daemon -- doctor --workspace "$D" --daemon --json`. Exit `0`; `loop.daemon_checked` is `true` and `loop.socket_path` equals `$OSSTACK_SOCKET`.
- **Agents.** Run `$V cli config-doctor -- config doctor`. Exit `0`; output starts `Osstack doctor — agent availability on this machine` and lists each adapter with `✓`/`✗`, a reason, and roles. On a box without agent CLIs or credentials they show `✗ ... unavailable`; that is the expected observation. It reads `~/.codex` and env vars but writes nothing.

## Gotchas

- `config init`, `config use`, `config bind`, `config set` write `$OSSTACK_HOME/config.yaml`-style state; with the scratch home that is safe, with the default home it is not. Never run them without the helper env.
- `doctor` reads the workspace; a workspace that has already run `deliver` has `LOOP-STATE.json` and reports `state_file` ok, a fresh one may not.
- `init` targets the given dir; with no argument it scaffolds the current directory — never run it bare from the repo root.

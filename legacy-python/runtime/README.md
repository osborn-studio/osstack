# OSBORN Runtime

This capability provides a lightweight Zellij runtime console for AI-assisted development.

## Start Runtime

```bash
osb-runtime
```

If the `aimate` session already exists, you'll attach to it. Otherwise it's created with the standard 5-tab layout below.

## Runtime Tabs

| # | Tab | Purpose |
|---|-----|---------|
| 1 | `1-dev` | CCB / coding agent main execution |
| 2 | `2-review` | `git diff \| ds-review` workflow |
| 3 | `3-verify` | `ds-verify` alignment check |
| 4 | `4-test-build-deploy` | tests / build / deploy (nothing auto-runs) |
| 5 | `5-monitor` | `git status`, logs, `btop` |

Each tab prints a one-shot banner, then drops into your interactive shell. Nothing is auto-executed.

## Common Commands

```bash
osb-runtime                          # launch or attach to 'aimate'
osb-runtime --session work           # different session name
osb-runtime --layout my.kdl          # override layout file
zellij list-sessions                 # see what's running
zellij kill-session aimate           # tear down
```

## Detaching

Inside Zellij: **Ctrl+o** then **d** detaches. The session keeps running in the background; re-attach with `osb-runtime`.

## Files

```text
~/.osborn/capabilities/runtime/
  bin/osb-runtime           — launcher (bash)
  layouts/aimate.kdl        — 5-tab Zellij layout (KDL)
  README.md                 — this file
```

## Philosophy

Zellij is **not** the agent brain. It is the persistent runtime workspace.

- Sessions persist across SSH disconnects and terminal restarts.
- Tabs make the dev → review → verify → build → monitor loop one keystroke away.
- No autonomous execution — the human still drives every command.

## Prerequisites

- [Zellij](https://zellij.dev) — `brew install zellij` on macOS.
- A working interactive shell at `$SHELL` (defaults to `/bin/zsh` if unset).
- Optional: `btop` for the monitor tab — `brew install btop`.

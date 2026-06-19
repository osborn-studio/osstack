# Integration Guide

Use Loop Engineering as a runtime boundary: external systems enqueue tasks, start or run loops, read state, and react to exit codes or daemon session state.

## CLI Integration

Use CLI mode for CI jobs, local automation, and simple external tools:

```bash
loop-engineering/scripts/osstack-loop.sh doctor --workspace "$PWD"
loop-engineering/scripts/osstack-loop.sh run --workspace "$PWD" --source task_queue --worktree --verify "pnpm test"
```

This mode exits when the run finishes and returns a meaningful exit code.

## Daemon Integration

Use daemon mode for dashboards, schedulers, and long-running automation.

1. Start the daemon with `node packages/cli/dist/bin.js serve`.
2. Start sessions with `loop start`.
3. Poll with `loop list --json` or `loop status --daemon`.
4. Stop sessions with `loop stop <loop_session_id>`.

Keep one daemon per machine or workspace owner. Use `OSSTACK_SOCKET` when multiple daemons are required.

## CI Pattern

```bash
loop-engineering/scripts/osstack-loop.sh enqueue "Fix current CI failure" \
  --capability code.fix \
  --context-json '{"source":"ci"}'

loop-engineering/scripts/osstack-loop.sh run \
  --source task_queue \
  --worktree \
  --verify "pnpm test" \
  --archive-completed
```

Treat exit code `2` as a failed or escalated engineering task, not as a CLI crash.

## Platform Pattern

- Store incoming work as `tasks/*.json`.
- Run `loop doctor --json` before starting sessions.
- Start daemon sessions with explicit `--workspace`.
- Read `LOOP-STATE.json` for machine processing and `STATE.md` for display.
- Use `--worktree-root` to keep temporary worktrees outside the main checkout when storage policy requires it.
- Restrict who can set `--execute`, `--agent`, `--reviewer`, and `--checker`; these flags can run code or call external tools.

## Security Notes

- Run untrusted tasks in disposable workspaces.
- Prefer `--worktree` for code-writing loops.
- Pin verifier commands in platform configuration instead of accepting arbitrary user input.
- Keep credentials in the host environment or secret manager; do not write them into task JSON.

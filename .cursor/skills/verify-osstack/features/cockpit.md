# Cockpit dashboard

The cockpit is the daemon-served, read-only web view (title `osstack Cockpit`) of daemon health, run metrics, agent roles, quality, evidence, lessons, the kanban board, and recent runs. The CLI offers the same snapshot as text or JSON.

## Sub-features

- `cockpit-html` `/dashboard` renders panels and fills `#generated` with a timestamp.
- `cockpit-api` `/api/dashboard` returns the JSON snapshot.
- `cockpit-workspace` `/dashboard?workspace=<path>` and `cockpit --workspace` show that workspace's evidence.
- `cockpit-cli` `osstack cockpit` prints the text summary; `cockpit --json` and `cockpit snapshot` print JSON.
- `dashboard-url` `osstack dashboard url` prints the URL.

## How to get to it (user POV)

- Run `osstack dashboard url` (or `osstack cockpit url`) and open the URL in a browser.
- Run `osstack cockpit [--workspace P] [--json]` or `osstack cockpit snapshot` in a terminal.

## Driving it with verify-osstack.sh

Preconditions:

- Doctor healthy.

- **URL.** Run `$V cli url -- dashboard url`. Stdout `http://localhost:<port>/dashboard` with the port from `$V env`.
- **Render.** Run `$V screenshot cockpit`. Exit `0`; `ui/cockpit.png` shows the `osstack Cockpit` header, metric tiles, `AGENT ROLES`, `KANBAN BOARD`, `RECENT RUNS`; `ui/cockpit.text.txt` contains `osstack Cockpit` and `KANBAN BOARD`.
- **API.** `ui/cockpit.api-dashboard.json` has keys `dashboard, overview, board, quality, agents, evidence, recent_runs, next_steps`, and `dashboard.db_path` is inside the scratch home.
- **CLI text.** Run `$V cli cockpit -- cockpit`. Stdout starts `Osstack Cockpit`, then `daemon=<version> phase=...`, `runs total=`, `kanban:`, `next steps:`.
- **CLI JSON.** Run `$V cli cockpit-json -- cockpit --json`. Exit `0`; stdout is JSON with top-level keys `daemon` and `cockpit`.
- **Workspace view.** After a `deliver` journey, run `$V screenshot cockpit-ws "/dashboard?workspace=$(node -p 'encodeURIComponent(process.argv[1])' "$W")" "Proof packs"` and compare its evidence panel with `cockpit --workspace "$W"`.

## Gotchas

- Without `--workspace`, `workspace_path` is the scratch `OSSTACK_HOME`, so evidence counts are `0`.
- The page loads data after first paint. `#generated` reads `loading...` until then; wait for it (the helper does) rather than sleeping.
- `dashboard url` prints `localhost` (from `OSSTACK_DASHBOARD_URL_HOST`); the helper binds and drives `127.0.0.1`.
- The attention panel reads `Observation disabled` unless `OSSTACK_ATTENTION=1`; that is expected for the baseline.
- `/api/health` is not a route (returns `not found`); use `osstack health` over the socket.
- One-shot `chrome --headless --screenshot` hangs on this page; use `cockpit-capture.mjs` (CDP).

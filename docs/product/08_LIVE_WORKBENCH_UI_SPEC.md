# Live Workbench UI Spec

## Cockpit First Screen

`osstack cockpit` and the dashboard UI expose:

- daemon status
- active loops
- recent runs
- kanban board
- report and proof counts
- agent scorecards
- lessons
- next steps

`osstack cockpit tui` renders the same cockpit data as a terminal-oriented
panel. It is intentionally dependency-light and non-mutating: the text output is
for operators, while `--json` returns stable `sections` and `actions` data that
a future Ink/blessed live workbench can reuse.

The terminal cockpit sections are:

- Overview
- Kanban
- Evidence
- Knowledge
- Next Actions

The Knowledge section reads the local Knowledge Cloud cache and shows cached
pack counts, the highest-quality cached pack, and the provenance command for
auditing source/license metadata. When cached packs exist, the TUI action list
also exposes a scriptable knowledge-search action.

## UI Requirements

- Support `OSSTACK_LANG=en` and `OSSTACK_LANG=zh-CN`.
- Show missing evidence clearly.
- Keep cockpit summary script-friendly with stable labels.
- Keep `cockpit tui --json` stable enough for automation and future interactive
  TUI clients.
- Let users generate reports from the cockpit surface via `osstack cockpit report`.
- Let users see local Knowledge Cloud cache readiness from the same cockpit
  surface before running knowledge-backed loops.

## Future Workbench

The future live workbench can add keyboard navigation, interactive task
approval, proof pack browsing, and knowledge snippet inspection without changing
the underlying evidence contracts.

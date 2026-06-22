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

## UI Requirements

- Support `OSSTACK_LANG=en` and `OSSTACK_LANG=zh-CN`.
- Show missing evidence clearly.
- Keep cockpit summary script-friendly with stable labels.
- Let users generate reports from the cockpit surface via `osstack cockpit report`.

## Future Workbench

The future live workbench can add interactive task approval, proof pack browsing, and knowledge snippet inspection without changing the underlying evidence contracts.


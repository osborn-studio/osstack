# Close-out surfaces

Use this contract when the request includes runtime/release state, memory,
workspace cleanup, a handoff, or a small project.

## Status vocabulary

Mark each relevant surface with exactly one status:

- `verified-current`: inspected evidence agrees with the maintained answer;
- `changed-and-verified`: corrected the maintained answer and verified it;
- `pending`: evidence or authorization is still missing;
- `out-of-scope`: observed but outside the user's target;
- `not-applicable`: the project has no such surface.

## Six surfaces

| Surface | Question | Evidence examples |
|---|---|---|
| Code | What is implemented now? | entrypoints, schemas, config parsing, tests |
| Runtime | What does the user receive now? | health response, deploy marker, real page/API, service version |
| Documentation | Does maintained human-facing knowledge match current truth? | README, architecture, setup, runbook, API guide |
| Rules | Does the loaded agent rule chain have one executable answer? | AGENTS.md/CLAUDE.md authority, imports, hooks, referenced paths |
| Memory | Is authorized cross-session memory current and non-duplicative? | supported adapter, documented platform control plane, maintained index |
| Workspace | Is unintegrated or unaudited residue still present? | Git/worktree state, temporary plans, debug scripts, backup copies |

Do not invent a surface. A local script with no deployment has
`runtime: not-applicable`; an unknown memory platform with generated files but
no documented write path is `memory: pending` or `verified-current` only as a
read-only observation.

## Release terminal states

Report these independently when relevant:

1. `draft`
2. `pull-request`
3. `merged`
4. `deployed`
5. `live-verified`
6. `knowledge-closed`
7. `cleaned`

Never infer a later state from an earlier one. In particular, merged does not
mean deployed, and live verified does not authorize branch/worktree deletion.

## Cleanup candidates

Inventory likely session residue by exact path and explain why each item may be
obsolete. Typical candidates include temporary plans, resolved TODO notes,
debug-only scripts, backup/`*_old` copies, and abandoned generated output.
Preserve everything until the user confirms the list after seeing the complete
close-out report. Exclude dirty, unmerged, unique, or uncertain work.

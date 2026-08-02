# Editorial playbook

Use this guide only after a successful `osstack neat` report identifies the
surface to review. The report selects the mechanical obligation; repository
evidence determines the edit.

## Audience boundaries

| Surface | Primary audience | Keep here |
|---|---|---|
| `AGENTS.md` and configured instruction mirrors | Coding agents in this repository | Stable commands, constraints, boundaries, and pointers needed to work safely |
| `README.md` and `docs/` | Users, maintainers, and downstream integrators | Current behavior, setup, architecture, operations, and handoff knowledge |
| Authorized external agent memory | A future session of one agent | Preferences, non-obvious lessons, and pointers not already owned by project docs |

Do not copy one audience's prose into another surface. Use a concise pointer
when a maintained document already owns the detail.

## Editing principles

1. Prefer reducing stale or duplicate prose over adding another paragraph.
2. Prefer merging into the maintained section over appending a session log.
3. Describe current truth. Put event history in release notes or Git history.
4. Use repository evidence: accepted specs, code, tests, generated inventory,
   and cited findings. Do not infer a new rule from ambiguous prose.
5. Preserve absolute dates when time matters and stable relative paths when a
   repository link is intended.
6. Keep one canonical instruction source. Never resolve drift by independently
   editing both sources.
7. Propose file deletion, rename, or semantic conflict resolution to the user;
   do not execute it through this skill.
8. Treat generated platform memory as read-only unless the platform documents
   an authorized correction or consolidation control plane.
9. Distinguish repository facts from runtime facts. A declared port, deploy
   config, merged PR, or passing test is not evidence that production is live.

## Memory convergence

- Promote stable system behavior needed by teammates into the maintained docs.
- Keep project rules limited to facts that an agent must see to work safely.
- Collapse obsolete or duplicate human-maintained memory only through an
  authorized memory transaction. Do not edit generated summaries directly.
- Preserve decision rationale when it still constrains current work; move event
  chronology to release notes or Git history.
- Do not create a new skill merely to reduce memory size.

## Finding-specific guidance

- Missing required surface: create it only when its purpose and owner are clear
  from config or accepted documentation. Otherwise request a decision.
- Broken relative reference: confirm the intended maintained target. Update the
  link when the move is unambiguous; do not invent a replacement document.
- Budget exceeded: remove repetition and historical narration first. Do not
  game the limit by moving duplicate text to an arbitrary new file.
- Change-review contract: update a declared review target only when the change
  actually changes user or maintainer knowledge. If review produces no edit,
  record an authorized `reviewed_no_change` artifact rather than adding
  meaningless text.
- Instruction drift: preserve the configured canonical direction. Existing
  independent files require a human decision.

## Decision request

For a `human_decision` finding, present:

1. fingerprint and affected path;
2. observed and expected states;
3. cited evidence;
4. two or three concrete choices and their consequences;
5. the safe default of leaving the repository unchanged.

After any user-authorized edit, rerun the same JSON check and report remaining
obligations without hiding warnings or incomplete coverage.

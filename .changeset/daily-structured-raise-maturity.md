---
"@osstack/cli": patch
---

`daily`'s `portfolio.raise_maturity` owner decision now dispatches off the
portfolio report's `structured_recommendations` instead of string-matching the
free-text `LOOP_DOC_RECOMMENDATION` wording and parsing a `<name>: ` prefix. An
`add_loop_doc` recommendation carrying a `repo_id` maps to
`osstack supervise init-loop-doc --repo <repo_id>`; every other kind (or one
without a `repo_id`) stays portfolio-level `osstack supervise report`.

Behavior improvement: because dispatch keys on the registry-unique `repo_id`
rather than the display name, duplicate-named repos are no longer ambiguous —
the missing-`docs/LOOP.md` gap for a repo that shares its display name with
another repo now dispatches to `init-loop-doc` (previously it fell back to
`supervise report`). No output shape change; the strict `NextAction` envelope is
untouched.

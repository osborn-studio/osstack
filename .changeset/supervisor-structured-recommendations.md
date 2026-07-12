---
"@osstack/supervisor": minor
---

`buildPortfolioReport` now also emits `structured_recommendations` — a
machine-actionable mirror of the existing free-text `recommendations`. Each
entry is `{ kind, repo_id?, text }` where `kind` is one of `missing_path`,
`add_loop_doc`, `add_verify_command`, `enable_failure_assetization`,
`create_evaluator_anchor_set`, `freeze_evaluator`, or `consolidation`, and
`repo_id` (the registry-unique id, NOT the display name) is carried whenever the
recommendation is attributable to a single repo (portfolio-level `consolidation`
hints have none).

The free-text `recommendations` array is unchanged — same strings, same order.
It is now *derived* from the structured list (`structured.map(r => r.text)`), so
the two can never drift; `supervise report`'s rendering is byte-identical.

The `PortfolioReport` zod schema gains `structured_recommendations` as an
optional-with-default (`[]`) field. The schema is not `.strict()`, so previously
persisted reports lacking the field still parse (the default fills in).

`LOOP_DOC_RECOMMENDATION` is now marked `@deprecated`: consumers should dispatch
on `structured_recommendations` (`kind === "add_loop_doc"` + `repo_id`) instead
of string-matching this wording. It stays exported for one release.

---
"@osstack/loop": minor
"@osstack/cli": minor
---

Loop self-improvement hook (opt-in, injected). `@osstack/loop` gains a
`selfImprovement` option on `LoopRunOptions`: when enabled, each finalized
`CompletedTask` is handed to an injected `assetize` callback that turns it into
a run trace, feedback assets, and optional improvement proposals, folding the
resulting ids/summary/self-improvement level back onto the `CompletedTask`
(new optional fields `trace_id`, `feedback_asset_ids`, `proposal_ids`,
`assetization_summary`, `self_improvement_level`). The loop stays free of any
`@osstack/supervisor` or SQLite dependency — the callback owns assetization and
persistence — and the hook never fails a task (errors are swallowed and emitted
as `loop.self_improvement.failed`). The CLI wires this via
`osstack loop run --self-improvement --repo-id <id> [--propose-improvements]`,
which records assets/proposals into the local control-plane state DB. Local-only
(cannot combine with `--daemon`); when disabled, loop behavior is unchanged.

# @osstack/loop

## 0.9.0

### Minor Changes

- a6f2075: Loop Engineering upgrade (Increments A–E): first-class evaluation specs with
  per-spec verifier results (`--verify` and artifact gates become implicit
  specs), feedback-carrying iteration with no-progress escalation, discovery
  governance (`--discovery-policy`), budget/stop controls
  (`--max-runtime-ms`/`--max-tokens`/`--max-cost-usd`/`--no-progress-limit`,
  exit code 2 on budget), and SOP lesson drafts with an
  `osstack loop lessons list|show|promote|discard` review workflow. DeepSeek
  ds-review/ds-verify now judge evaluation specs per-spec via
  `OSSTACK_EVALUATION_SPECS_FILE`/`OSSTACK_EVALUATIONS`. All additive and
  opt-in; existing CLI behavior is unchanged.
- 17312b5: Loop self-improvement hook (opt-in, injected). `@osstack/loop` gains a
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

### Patch Changes

- 23fb3e7: Post-completion hardening of the loop-engineering line (four documented minor
  deferrals, all fail-closed):

  - Verifier fails closed on unknown evaluation-id judgments instead of dropping
    them: a verifier-adapter judgment whose id matches no requested spec now
    surfaces an issue (rule `verify.unknown_evaluation_id`) — failing orphan =
    error, passing orphan = warning. A real failure reported under a mismatched id
    can no longer let a run pass silently.
  - `osstack loop lessons promote --to-skill` refuses any target that is not a
    `SKILL.md` (external skill paths still allowed; arbitrary files are rejected).
  - `DiscoveryPolicy` rejects unknown `source_authorization` keys at parse time
    (e.g. a typo'd `task_quee`) instead of silently falling through to the default.
  - Scorecard scale (100 base, 110 with a budget dimension) is documented as an
    additive rubric with the denominator always rendered — never a bare percentage.

- Updated dependencies [a6f2075]
  - @osstack/agents@0.9.0

## 0.2.0

### Minor Changes

- Ship the osstack upgrade evidence, governance, compliance, Knowledge Cloud, cockpit, and product companion surfaces.

  - Add official Knowledge Cloud packs, indexing, ingest, cloud service, Docker/Fly/Render deployment assets, and smoke tests.
  - Add governed delivery, proof/report/scorecard/compliance evidence, PR bodies, and product companion specs.
  - Expand loop evidence, knowledge traces, cockpit reporting, checkpointing, and npm install smoke coverage.

### Patch Changes

- Updated dependencies
  - @osstack/core@0.2.0
  - @osstack/agents@0.2.0
  - @osstack/github@0.2.0
  - @osstack/hermes-adapter@0.2.0

## 0.1.0

### Patch Changes

- Updated dependencies [45b3b78]
  - @osstack/agents@0.1.0
  - @osstack/core@0.1.0
  - @osstack/hermes-adapter@0.1.0

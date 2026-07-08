# @osstack/cli

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

- Updated dependencies [23fb3e7]
- Updated dependencies [a6f2075]
- Updated dependencies [17312b5]
  - @osstack/loop@0.9.0
  - @osstack/agents@0.9.0

## 0.8.1

### Patch Changes

- 1cc380a: Allow the Single Binary Release workflow to publish an explicitly labeled ad-hoc macOS archive when Apple notarization secrets are unavailable, while preserving the notarized release path.

## 0.8.0

### Patch Changes

- Updated dependencies [89ffb4b]
  - @osstack/knowledge@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [b611e6e]
  - @osstack/knowledge@0.7.0

## 0.6.0

### Minor Changes

- fd7a88c: Add deterministic `osstack cockpit tui --fullscreen --interactive` key-sequence automation for selecting actions and quitting from the fullscreen cockpit state model.

## 0.5.0

### Minor Changes

- 13f6035: Add `osstack cockpit tui --fullscreen`, a framed cockpit workbench renderer backed by tested keyboard navigation state.

## 0.4.0

### Patch Changes

- Updated dependencies [8cc4b41]
  - @osstack/knowledge@0.4.0

## 0.3.0

### Minor Changes

- 99b17ef: Add the initial contract-validation slice. `osstack contracts check --json` validates an `osstack.contracts.json` manifest against frontend `fetch()` calls and backend routes, and generated proof packs now include `contract-validation.json` evidence.

### Patch Changes

- Updated dependencies [99b17ef]
  - @osstack/contracts@0.3.0

## 0.2.0

### Minor Changes

- Ship the osstack upgrade evidence, governance, compliance, Knowledge Cloud, cockpit, and product companion surfaces.

  - Add official Knowledge Cloud packs, indexing, ingest, cloud service, Docker/Fly/Render deployment assets, and smoke tests.
  - Add governed delivery, proof/report/scorecard/compliance evidence, PR bodies, and product companion specs.
  - Expand loop evidence, knowledge traces, cockpit reporting, checkpointing, and npm install smoke coverage.

### Patch Changes

- Updated dependencies
  - @osstack/knowledge@0.2.0
  - @osstack/compliance@0.2.0
  - @osstack/governance@0.2.0
  - @osstack/loop@0.2.0
  - @osstack/core@0.2.0
  - @osstack/agents@0.2.0
  - @osstack/github@0.2.0
  - @osstack/config@0.2.0
  - @osstack/hermes-adapter@0.2.0
  - @osstack/skill-registry@0.2.0
  - @osstack/skills@0.2.0

## 0.1.0

### Minor Changes

- 45b3b78: Initial public release (0.1.0): engineering hardening + self-update.

  - Version is read from package.json instead of hardcoded `0.0.0`; daemon and
    CLI exchange `protocol_version` on connect.
  - `osstack upgrade` self-update command: registry check → state.db backup →
    daemon drain/shutdown → `npm i -g` → restart → health check → automatic
    rollback on failure. `osstack status` shows the version handshake and
    update availability.
  - Daemon probes the npm registry once per 24h (disable: OSSTACK_UPDATE_CHECK=0)
    and surfaces `update_available` in `health`.
  - Daemon pidfile guard refuses duplicate instances; socket moved from
    /tmp/osstack.sock to ~/.osstack/daemon.sock.
  - Hermes binary resolution no longer hardcodes a machine-specific path
    (use HERMES_BIN or HERMES_AGENT_HOME).
  - launchd templates: ai.osstack.autoupgrade weekly self-update job.
  - Biome linting, GitHub Actions CI, daemon RPC smoke tests.

### Patch Changes

- Updated dependencies [45b3b78]
  - @osstack/agents@0.1.0
  - @osstack/config@0.1.0
  - @osstack/core@0.1.0
  - @osstack/hermes-adapter@0.1.0
  - @osstack/skill-registry@0.1.0
  - @osstack/skills@0.1.0
  - @osstack/loop@0.1.0

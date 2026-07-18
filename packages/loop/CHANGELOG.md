# @osstack/loop

## 0.11.0

### Minor Changes

- 9f1aa1b: Carry strict verifier-reported implementation deviations through Loop events and idempotently register evidence-bound `mid_build` probe items for linked tasks.

### Patch Changes

- Updated dependencies [f041063]
- Updated dependencies [a483f6e]
- Updated dependencies [4a6c00b]
- Updated dependencies [83aac82]
- Updated dependencies [223a240]
- Updated dependencies [ac50008]
- Updated dependencies [9f1aa1b]
  - @osstack/core@0.11.0
  - @osstack/agents@0.11.0
  - @osstack/hermes-adapter@0.11.0

## 0.10.0

### Minor Changes

- 1b48a7d: Merge-orchestration closed loop (S1). A new `osstack stack` command family turns a
  stack of GitHub PRs into a driveable, self-reflecting workflow — extension-only over
  the existing kanban/loop/github/cli primitives.

  - `@osstack/core`: additive migration #7 — typed kanban cards (`card_type`, `meta`)
    plus a `kanban_card_checks` table; repository gains typed-card + checklist ops
    (`putCheck`/`setCheckState`/`listChecks`), dependency links, and deterministic
    bottom-up `topoOrder` (cycle throws). Existing kanban/event/memory semantics are
    backward-compatible (new columns default; event `kind` stays free-form).
  - `@osstack/github`: `stack.ts` — `ingestStack` (read-only `gh pr view` → dependency
    DAG) and `detectDrift` (conflicting/ci_failing/ci_pending/not_mergeable/orphan_base).
  - `@osstack/loop`: pure `renderStackRetro` — a retrospective that cites which checks
    caught issues and derives missing-gate suggestions.
  - `@osstack/cli`: `stack ingest|board|move|check|timeline|runbook|recommend|retro`,
    memory-backed routing recommendation, and an offline dry-run fixture.

  S1 records and drives; humans still merge. No auto-merge, no auto-agent-dispatch, no
  CI webhook/daemon.

- 3223420: Adopt `@osstack/protocol` additively (R1.2). Both packages now re-export the
  kernel contracts under a `protocol` namespace (`export * as protocol`) and ship
  pure, tested mappers from their own shapes to the protocol shapes — no breaking
  changes, no consumer forced to switch. core adds `storedEventToEnvelope`,
  `runRowToRunSummary` (finalized rows only; `expired` -> `failed`), and
  `approvalRowToRequest`; loop adds `toProtocolTask` and
  `completedTaskToRunSummary` (`escalated` -> `cancelled`).
- 620cc4f: R2.2 — kernel-level policy gate. Closes the R1.3 debt where observe-mode
  enforcement was CLI-layer only: direct daemon RPC clients and the daemon's own
  scheduler bypassed it.

  - `@osstack/loop`: `LoopRunOptions` gains an optional injectable
    `policyGate?: (ctx: { workspacePath }) => Promise<PolicyGateDecision>` (new
    loop-local `PolicyGateDecision`/`PolicyGate`/`LoopPolicyStatus` structural
    types — the loop never couples to the policy loader/schema, which lives in
    the CLI product layer). The engine consults it once at
    `runOnce()`/`runCycles()` entry (refuse before ANY discovery/execution) and
    once per scheduled cycle tick inside `runCycles` (a mid-flight flip stops the
    loop cleanly with a `policy_denied` outcome — like a budget stop, never an
    exception). A denial surfaces `result.policy = { denied: true, reason }` and a
    `policy_denied` `loop.stopped` event. No gate injected ⇒ byte-identical prior
    behavior. A gate that throws is fail-closed (counts as deny with the error
    message), same discipline as the `assetize` self-improvement hook.
  - `@osstack/cli`: new shared `makePolicyGate(workspacePath)` (`policy-gate.ts`)
    backed by core's `loadPolicyProfile` — absent file ⇒ allow, `mode: observe` ⇒
    deny with the established wording, invalid file ⇒ deny with the loader error
    (fail-closed). The R1.3 `enforceObservePolicyGate` in bin.ts now delegates to
    it (exit codes 2/1 and stderr unchanged). The gate is injected into every
    daemon `LoopEngine` via `withLoopAdapters` (the `loop.run` RPC — which now
    returns a `policy_denied` error under observe — and the persisted session
    scheduler — whose next tick stops with a persisted `policy_denied`
    stop_reason), and into the direct-CLI `deliver` / `loop run` engines for
    defense-in-depth. The gate re-reads policy on every consult (no caching), so a
    mid-session flip of `.osstack/policy.yaml` is honored on the next tick.

  The only intentionally ungated daemon path remains the read-only `daily`
  composition (observe mode permits observation); that lands in R2.3.

### Patch Changes

- Updated dependencies [0355f62]
- Updated dependencies [1b48a7d]
- Updated dependencies [daeb3c4]
- Updated dependencies [7396e6f]
- Updated dependencies [6a4a9d4]
- Updated dependencies [3223420]
- Updated dependencies [12b6796]
- Updated dependencies [392f8b0]
- Updated dependencies [99ca3b4]
  - @osstack/github@0.10.0
  - @osstack/core@0.10.0
  - @osstack/protocol@0.10.0
  - @osstack/agents@0.10.0
  - @osstack/hermes-adapter@0.10.0

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

# R2 — Policy Kernel Enforcement + Daily Automation (R2.1–R2.4)

Status: Proposed (owner said "go" on continuing past R1; this doc gates Opus dispatch)
Date: 2026-07-11
Author: Fable 5 (CTO)
Upstream: ADR-001, POLICY_PROFILE_V1, plan `2026-07-11-osstack-r1-golden-paths-architecture.md`,
Doc 15 §4/§5, Doc 16 §7/§10.
Baseline: `main @ cdc95a2` (R0 + R1 complete: protocol v1, state relocation,
policy loader + CLI observe gate, `daily`, `start`/`control`, machine registry).

Goal of this tranche: close the two debts R1 deliberately recorded — (a) policy
enforcement is CLI-layer only (daemon RPC and scheduled sessions bypass the
observe gate; SCOPE NOTE at the R1.3 gate in bin.ts), and (b) `daily` is manual
(cron wiring deferred to R2 by the R1.4 non-goals) — plus one hygiene blocker
and one recorded ruling that R1.5's landing unblocks.

## Facts this plan is built on (verified in source)

- Daemon RPC `loop.run` and `loop.start` (`packages/cli/src/daemon.ts:316,330`)
  construct/schedule `LoopEngine` directly — no `loadPolicyProfile` consult on
  any daemon path. Scheduled loop sessions re-run cycles on `intervalMs`
  without ever re-reading policy.
- Package boundaries: `@osstack/loop` must not import `@osstack/core`
  (ADR-001); loop already takes injected capabilities (the `assetize` callback
  precedent from the self-improvement hook).
- Daemon sessions are persisted (`loop-sessions.json`) with
  `intervalMs`/`scheduleExpression` and survive restart — the right substrate
  for daily automation.
- A full-suite `pnpm -r test` run on this machine wrote migrations into the
  real `~/.osstack/state.db` (2026-07-11 incident, reverted): several CLI
  tests invoke `main()` without overriding `OSSTACK_HOME`.
- R1.4 recorded a CTO ruling: `daily`'s advisory `next_actions` ids
  (`repo.fix_ci`, `repo.review_prs`, `portfolio.raise_maturity`) map to real
  `osstack start`/`control` invocations "when R1.5 lands". R1.5 has landed.

## R2.1 — Test hermeticity guard (hygiene, first — protects everything else)

- Add a vitest `globalSetup` (or `setupFiles`) to `packages/cli` that points
  `OSSTACK_HOME` (and `OSSTACK_SOCKET`) at a per-run tmp directory BEFORE any
  test module loads, so no test can touch the real `~/.osstack` even when it
  forgets to set overrides. Tests that intentionally exercise custom homes
  keep working — they already set their own values inside the default.
- Audit every CLI test reaching `osstackHome()`/`openStateDb()`/`main()` and
  fix the offenders to use explicit tmp homes where the test's assertions
  depend on the path (candidates: `product-entry-cli.test.ts` et al.).
- Acceptance: run the full workspace suite WITHOUT an external `OSSTACK_HOME`
  override; `~/.osstack` mtimes and `PRAGMA user_version` are untouched.
- No product behavior change; changeset not required unless a src file moves.

## R2.2 — Kernel-level policy gate (the real enforcement point)

**Location decision:** `@osstack/loop` gains an injectable gate; `cli` (both
direct commands and the daemon) supplies the implementation backed by core's
`loadPolicyProfile`. Loop stays core-free; the gate is capability injection,
same pattern as `assetize`.

- Loop: `LoopEngineOptions.policyGate?: (ctx: { workspacePath: string }) =>
  Promise<PolicyGateDecision>` where `PolicyGateDecision =
  { allow: true } | { allow: false; reason: string }` (loop-local types; no
  protocol/core imports). The engine consults it at TWO points:
  1. once per `runOnce()`/`runCycles()` entry (covers `loop.run` RPC), and
  2. once per scheduled cycle tick (covers long-lived sessions where the
     human flips `mode: observe` mid-flight — the next tick refuses and the
     session stops with a `policy_denied` stop_reason, persisted like budget
     stops).
  No gate injected ⇒ exactly current behavior (loop stays pure/standalone).
- CLI: one shared `makePolicyGate(workspacePath)` used by (a) the existing
  bin.ts command gates (which stay, for fast exit-2 UX before daemon RPC),
  (b) daemon `loop.run`/`loop.start` handlers, and (c) the session scheduler.
  Invalid policy file stays fail-closed (gate returns deny with the loader's
  error; daemon surfaces `policy_denied`).
- `deliver` daemon paths (if any bypass exists — verify during implementation)
  get the same gate.
- Tests: loop unit tests for both consult points + the no-gate default;
  daemon tests proving `loop.run` and a scheduled session tick refuse under
  `mode: observe` and that flipping the file mid-session stops it cleanly.
- Changeset: loop minor + cli minor.

## R2.3 — `osstack daily --schedule` (automation via the daemon)

Ride the persisted-session pattern, NOT LoopEngine (daily is a read-only
composition, not a task loop):

- Daemon: new session kind `daily` (own map + `daily-sessions.json`,
  persisted/restored like loop sessions) with `intervalMs` (+ optional
  `scheduleExpression` recorded verbatim for humans; interval is the engine).
  Each tick runs the daily brief in-process (reuse `handleDailyCommand`'s
  composition — extract its core into an exported `runDailyBrief(deps)` so the
  daemon does not shell out), writes the dated brief JSON exactly as the CLI
  does, and stores the latest `AgentCommandResult` on the session for
  inspection.
- Policy interaction: `daily` is read-only by design ⇒ NOT gated by
  `mode: observe` (observing is precisely what observe mode permits). State
  this in code + tests.
- CLI: `osstack daily --schedule <interval>` / `daily sessions` / `daily
  unschedule <id>` (or the closest fit to existing `loop start/list/stop`
  verb conventions — implementer matches the existing surface style),
  requiring the daemon (same refusal wording as other daemon-only paths when
  it is not running).
- The brief's delta semantics already handle same-day re-runs (diff against
  prior day); a scheduled run is byte-compatible with a manual run.
- Tests: daemon session persistence round-trip, tick executes and writes the
  brief (tmp OSSTACK_HOME), unschedule stops, restart restores.
- Changeset: cli minor.

## R2.4 — `daily` next_actions become dispatchable (fulfil the R1.4 ruling)

- `repo.fix_ci` / `repo.review_prs` → `next_actions[].command` stays a
  protocol `CommandName`, but the action now carries the REAL invocation the
  owner can run, using R1.5's surface: e.g. reason text unchanged, plus the
  concrete `osstack start "<goal>" --repo-id <id>` suggestion (shell-quoted
  with the R1.5 `shQuote` helper — reuse it, do not re-implement) either in
  `reason` or a structured `result` field mirroring `deliver_args`
  (`start_args: string[]`). `portfolio.raise_maturity` maps to
  `supervise init-loop-doc --repo <id>` where that is the actual gap.
- Update the R1.4 CTO-ruling docstring on `deriveOwnerDecisions` to record
  the fulfilment. Strict protocol validation tests updated.
- Changeset: cli patch (shape is additive inside `result`; `command` ids keep
  their existing values so no consumer breaks).

## Execution order, increments, maker/checker

Sequential PRs, same discipline as R0/R1 (own branch, CI, cross-review,
Fable 5 final, changeset, inventory regeneration when the CLI surface
changes):

| PR | Increment | Implements | First review | Final |
|---|---|---|---|---|
| 1 | R2.1 hermeticity guard | Opus-C | Opus-A | Fable 5 |
| 2 | R2.2 kernel policy gate | Opus-A | Opus-B | Fable 5 |
| 3 | R2.3 daily scheduling | Opus-B | Opus-C | Fable 5 |
| 4 | R2.4 dispatchable next_actions | Opus-C | Opus-A | Fable 5 |

Full-suite verification runs MUST set a tmp `OSSTACK_HOME` until R2.1 merges
(standing instruction in every dispatch contract).

## Non-goals (this tranche)

No PartnerOS. No `--apply-safe`/auto-apply execution (auto_apply stays false
everywhere). No repo renames (Doc 16 §9 stays a separate owner-approved,
docs-only step). No changes to `@osstack/protocol` schemas. No cron/launchd
host integration — scheduling lives inside the daemon; host-level `osstack
serve` autostart is already `serve install`'s job. The three product-repo
onboarding PRs remain owner-merged and are not touched here.

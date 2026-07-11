# R1 Golden Paths — Technical Architecture (R1.2–R1.6)

Status: Proposed (awaiting owner approval — gates Opus dispatch)
Date: 2026-07-11
Author: Fable 5 (CTO)
Upstream: ADR-001, plan `2026-07-11-osstack-r0-r1.md`, Doc 15 §4/§5, Doc 16 §7/§10.
Baseline: `main @ ca39ec5` (R0 complete; `@osstack/protocol` v1 + R1.1 merged;
925 tests green).

Goal of this tranche (Doc 16 P0 / owner item F): a working `osstack daily`
over the three product repos, a contract-gated `start`/`control` flow, and the
three repos onboarded — all policy-bounded and protocol-shaped.

## R1.2 — Protocol adoption layer (small)

Protocol v1 defined its schemas independently (correct for a bottom layer).
R1.2 makes kernel packages *adopt* it without breaking any existing API:

- `@osstack/core` and `@osstack/loop` add `@osstack/protocol` as a dependency
  and re-export it **namespaced**: `export * as protocol from "@osstack/protocol"`
  — zero name collisions with loop's richer `Task` or core's `PolicyDecision`.
- Thin, tested mappers in the packages that own the richer types (protocol
  cannot depend on them):
  - loop: `toProtocolTask(task)` (drops nothing; evaluation passes as opaque),
    `completedTaskToRunSummary(t)` (epoch→ISO where needed).
  - core: `runRowToRunSummary(row)`, `storedEventToEnvelope(row)`,
    `approvalRowToRequest(row)`.
- Mappers are pure and total (no I/O, no throw on valid inputs); each has a
  round-trip/shape test asserting `protocol.X.parse(mapped)` succeeds.
- No consumer is forced to switch; this is additive. Changeset: core/loop minor.

## R1.3 — Policy Profile loader + first enforcement point

**Location decision:** `packages/core/src/policy/profile.ts` (core already owns
policy primitives; ADR tier = public/stable subset). Core gains the `yaml`
(^2.9.0, already used by cli/config) dependency.

- Zod schemas implementing POLICY_PROFILE_V1 exactly: `RepoConfig`
  (`.osstack/repo.yaml`) and `PolicyProfile` (`.osstack/policy.yaml`) —
  `.strict()` fail-closed, closed 13-category enum, cross-list disjointness
  via superRefine (P-003), `schema_version: 1` const.
- `loadPolicyProfile(repoPath)` / `loadRepoConfig(repoPath)`: read+parse+validate;
  distinct results for absent-file (=> `undefined`, legacy behavior) vs
  invalid-file (=> hard error with the Zod issue list — fail-closed, P-001).
- Budget mapping helper `profileBudgetToLoopBudget(profile)` per the P-003
  table (`max_iterations`→`max_task_iterations`, minutes→ms,
  `max_cost_usd`→`max_estimated_cost_usd`).
- **CLI**: new read-only `osstack policy check [--repo-path P] [--json]` —
  validates both files, prints mode/budgets/categories or the precise errors.
  (Read-only reporting ⇒ allowed without opt-in; onboarding tool for R1.6.)
- **First enforcement point (only one, deliberately):** `deliver` and
  `loop run` consult the workspace profile when present:
  `mode: observe` ⇒ refuse task execution (exit 2, `policy_denied` wording);
  `propose`/`execute` ⇒ proceed (branch/worktree work is proposing).
  Absent files ⇒ exactly current behavior. Finer-grained
  `allowed_auto_changes`/auto-apply wiring lands with improve-apply
  integration later — not in this increment.

## R1.4 — `osstack daily` (read-only portfolio brief)

New CLI command composing existing kernel capability (Doc 15 §4.1):

```
osstack daily [--registry P] [--json] [--workspace P]
```

1. **Scan**: read `.osstack/repos.json` registry → `scanRepo` +
   `buildPortfolioReport` (supervisor, existing).
2. **GitHub read adapter**: new `packages/github/src/portfolio-status.ts`
   following stack.ts's **injectable runner** pattern (`runner.run("gh", args)`)
   so tests are offline fixtures: per repo with a GitHub remote, fetch
   `gh pr list --json`, `gh run list --limit N --json`, latest release. No
   `gh`/no remote/network failure ⇒ degrade to a per-repo warning, never throw.
3. **Stack board**: include existing stack board summary when stack state exists.
4. **Delta**: persist each brief to `$OSSTACK_HOME/daily-briefs/<ISO-date>.json`;
   diff against the previous brief (new PRs, CI flips, maturity changes).
5. **Render**: Markdown for humans + `--json` emitting a **protocol
   `AgentCommandResult`** (status `ok`, brief in `result`, per-repo
   `evidence_refs`, and **≤3 owner decisions as `next_actions`**) — `daily` is
   the first Agent Command Protocol dogfood surface.
6. Read-only, period: no `--apply-safe` in this increment (needs execute-mode
   wiring; deferred with the improve-apply integration).

## R1.5 — `osstack start` / `osstack control` (contract-gated delivery)

Scope discipline: v1 owns the **contract lifecycle + approval records**, not
auto-execution chaining. The agent surface (Claude/Codex) remains the driver —
matching how work actually flows today.

- `osstack start "<goal>" --repo-id <id> [--json]`:
  - requires the repo registered + `.osstack/repo.yaml` (verify command source);
  - policy `mode: observe` ⇒ blocked;
  - generates an **Execution Contract**: `.osstack/contracts/<contract_id>.md`
    (git-tracked; goal, non-goals TBD-marked for human edit, acceptance
    criteria, verify command from repo.yaml, budgets from policy.yaml, allowed/
    forbidden paths from policy categories, approval points) + a row in the
    state DB (kanban task, `contract` context) for `control` to track;
  - result (`--json` = AgentCommandResult): `status: needs_approval` with an
    ApprovalRequest, and `next_actions` = the exact `control approve` command.
- `osstack control <contract-id> status|approve|revise|stop [--json]`:
  - `approve` records a protocol **ApprovalDecision** (actor from `--actor`,
    default `human:owner`; agent actors rejected per A-004) into the approvals
    table, flips contract status, and emits the ready-to-run `osstack deliver …`
    command (with the contract's verify/budget flags) as `next_actions[0]` —
    it does NOT spawn deliver itself in v1;
  - `revise`/`stop` update status with a reason; `status` renders the contract
    + its approval trail + any linked run/proof evidence.

## R1.6 — Onboard the three product repos (Doc 16 P0)

Per-repo docs-only PRs (Doc 16 §8.1) authored against the **latest main of
each product repo**, then portfolio registration on the Mac mini:

1. For each of `osborn-pa`, `stock-monitor`, `re-fund-ai`: locate the local
   clone (fresh `git fetch`; report exact HEAD), audit just enough to fill
   `.osstack/repo.yaml` truthfully (the ONE CI-equivalent verify command,
   build command, deploy reality), author `.osstack/policy.yaml`
   (**mode: propose**, auto_apply false, Doc 16 §7 defaults) and `docs/LOOP.md`
   (supervisor's `renderLoopDoc` + repo-specific facts). Branch
   `claude/osstack-onboarding`, docs-only PR, **owner merges** (product repos
   are owner-gated).
2. On the Mac mini: register all three in `.osstack/repos.json` (the central
   portfolio workspace = the osstack repo itself, or `$OSSTACK_HOME` — decided
   at execution: registry lives at `$OSSTACK_HOME/repos.json` so it is
   machine-scoped, not repo-scoped).
3. Acceptance (Doc 16 P0): one command — `osstack daily --json` — answers all
   three repos' main/PR/CI/maturity state and surfaces ≤3 owner decisions.

## Execution order, increments, maker/checker

Sequential (each touches core or shared surfaces; avoids inventory-gate and
index.ts collisions):

| PR | Increment | Implements | First review | Final |
|---|---|---|---|---|
| 1 | R1.2 protocol adoption | Opus-B | Opus-C | Fable 5 |
| 2 | R1.3 policy loader + `policy check` + observe gate | Opus-C | Opus-A | Fable 5 |
| 3 | R1.4 `daily` (+ github portfolio-status) | Opus-A | Opus-B | Fable 5 |
| 4 | R1.5 `start`/`control` | Opus-B | Opus-C | Fable 5 |
| 5–7 | R1.6 three onboarding PRs (one per product repo) | Opus-A/B/C (one each) | cross | Fable 5 + **owner merge** |

Every Opus dispatch carries the owner contract template (goal/non-goals/paths/
acceptance/verification/budget/escalation). Every PR: own branch, CI, proof,
inventory regeneration when exports change, changeset when packages change.

## Non-goals (this tranche)

No PartnerOS integration. No `--apply-safe`/auto-apply execution. No repo
renames (`stock-monitor`→`osborn-alpha` etc. stays a Doc 16 §9 later step —
onboarding works against current names; rename plans are separate docs-only
PRs later). No daemon/scheduler automation of `daily` (cron wiring is R2).
No deliver-refactor: control emits the deliver command, it does not embed it.

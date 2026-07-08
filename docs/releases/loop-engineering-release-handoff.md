# Loop Engineering — Release Handoff

Status of the loop-engineering line as of this hardening session. Written to be
accurate, not aspirational: nothing below claims a publish or an owner action
that has not actually happened.

## Current shipped capabilities (on `main`, CI green)

All merged to `main` and passing CI. Runtime is unchanged for callers who do not
opt in; every addition is opt-in or read-only.

- **Loop Engineering A–E**: first-class `EvaluationSpec`s (command / contract /
  property / e2e / artifact / semantic_review / governance) with per-spec
  results; feedback-carrying iteration with no-progress escalation;
  discovery governance (`--discovery-policy`); budget/stop controls
  (`--max-runtime-ms` / `--max-tokens` / `--max-cost-usd` / `--no-progress-limit`,
  exit code 2 on budget); SOP lesson drafts with an
  `osstack loop lessons list|show|promote|discard` review flow.
- **Real token/cost accounting**: the executor reads `usage.final`
  (`tokens_in` / `tokens_out` / `cost_usd`) from adapters; budgets enforce on
  real reported usage only (adapters that report nothing contribute 0).
- **DeepSeek adapters** (`ds-review` / `ds-verify`) judge evaluation specs
  per-spec via `OSSTACK_EVALUATION_SPECS_FILE` / `OSSTACK_EVALUATIONS`; the
  protocol is covered by stdlib Python tests.
- **Recursive control plane** (opt-in): `@osstack/supervisor` — repo registry +
  L0–L6 scanner, feedback assets, gated improvement proposals, evaluator epochs
  (Red Queen), and a loop self-improvement hook
  (`osstack loop run --self-improvement --repo-id <id>`). See
  [../product/14_RECURSIVE_CONTROL_PLANE.md](../product/14_RECURSIVE_CONTROL_PLANE.md).

## Post-completion hardening (this session)

Adapter contract coverage and the four documented minor deferrals:

- **claude-code usage.final contract test** — locks that the claude-code adapter
  emits `tokens_in` / `tokens_out` / `cost_usd` in the shape the loop executor
  consumes (SDK fully mocked; no real API). Matches the existing codex contract test.
- **Unknown evaluation-id judgments — fail-closed** (was: silently dropped). A
  verifier-adapter judgment whose id matches no requested spec is now surfaced:
  a *failing* orphan is an error (rule `verify.unknown_evaluation_id`), a
  *passing* orphan is a warning. A real failure reported under a mismatched id
  can no longer let a run pass.
- **Scorecard 100/110 scale — documented + tested** (kept intentionally). The
  scorecard is an additive weighted rubric (each dimension = 10 pts) rendered as
  `score / max_score`, never a bare percentage. A configured budget adds one
  10-pt dimension (→ /110). The denominator is always shown, so /110 cannot be
  misread as a percentage. Locked by a test.
- **`--to-skill` path hardening** — lesson promotion now refuses to append to a
  target that is not a `SKILL.md` (existence is no longer sufficient). External
  skill paths remain allowed; arbitrary files (e.g. `/etc/hosts`, a notes file)
  are rejected.
- **`source_authorization` typo-safety — fail-closed**. `DiscoveryPolicy` now
  rejects unknown `source_authorization` keys at parse time (e.g. `task_quee`)
  instead of accepting them and silently falling through to the default.

## Commits / changeset status

- Two changesets are staged and **not yet consumed**:
  - `.changeset/loop-engineering-abcde-upgrade.md` — `@osstack/loop`,
    `@osstack/cli`, `@osstack/agents` (minor).
  - `.changeset/loop-self-improvement-hook.md` — `@osstack/loop`,
    `@osstack/cli` (minor).
  - This session adds a changeset for the hardening (`@osstack/loop`,
    `@osstack/cli`, patch).
- The changesets bot has an open **Version Packages PR** — `#111`
  (`chore(release): version packages`, branch `changeset-release/main`). It
  applies the version bumps and updates CHANGELOGs. It is **not merged**.
- `@osstack/supervisor` is `private: true` (bundled into the CLI). The Version PR
  bumps its internal version but it will **not** be published to npm.

## Verification status (this session)

- `pnpm --filter @osstack/agents test` — 42 passed (incl. claude-code + codex
  usage contract tests).
- `pnpm --filter @osstack/loop test` — 164 passed.
- `pnpm --filter @osstack/cli test` — 288 passed (incl. loop-cli).
- `pnpm -r typecheck` — clean. `biome check` on changed files — clean.
- Python protocol tests (`legacy-python/deepseek/tests`) — unchanged this
  session and remain wired into CI (`.github/workflows/ci.yml`).

## What the owner must do (not done here — requires owner action)

1. **Merge the Version Packages PR** (`#111`) when ready to cut versions. This
   applies the bumps and CHANGELOGs to `main`.
2. **npm publish is not configured/verified here.** If npm publishing is
   desired, ensure the repo's `NPM_TOKEN` secret is set for the Release workflow
   (`changeset publish`). Nothing has been published to npm in this work.
3. Neither of the above has been performed — no version has been cut and no
   package has been published.

## What is intentionally NOT touched

- `packages/report/` — untracked pre-session WIP. Never staged, committed,
  moved, or formatted.
- No npm publish, no `NPM_TOKEN` set, no Version PR merge.
- No `LoopEngine` rewrite; no reintroduction of inert token/cost guardrails; no
  real-API test calls.

## Remaining known deferrals after this session

- None of the four documented minor deferrals remain open — each is either fixed
  with tests or kept-by-design and documented (see "Post-completion hardening").
- The scorecard `/110` scale is a **deliberate** design (documented above), not
  an open issue.

## How to verify after release

Once the Version PR is merged (and, if desired, published):

1. **Install** the CLI (from npm if published, else the built binary):
   `npm install -g @osstack/cli && osstack --version`.
2. **Smoke the loop**: `osstack examples` for canonical invocations, then a
   minimal run, e.g.
   `osstack loop enqueue "noop" --workspace . && osstack loop run --workspace . --source task_queue --verify "true" --json`.
3. **Smoke the control plane** (opt-in): `osstack supervise scan --json` and
   `osstack loop run --self-improvement --repo-id <id> --verify "true"`.
4. **Confirm Python protocol tests still run in CI** — the "Python protocol
   tests" step in `.github/workflows/ci.yml`
   (`python3 -m unittest discover legacy-python/deepseek/tests`) must stay green.

# Kimi Code Mac Mini Autonomy Implementation Plan (v2)

> **Status: Superseded.** Retained as the v2 audit baseline; v3-controlled implementation and later source/runbooks replace its execution instructions. See the [current-state index](../KIMI_AUTONOMY_STATUS.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **v2 (2026-07-27, Fable 5 audit revision).** Supersedes v1 at commit `4981378`. Changes: terminology guard (§0), execution-host declarations and parametrized worktree paths (§3), invariants 16–20 (§5), Kimi usage budget (§5b), verification-ladder phase annotations (§6), hardened promotion gates (§8), privacy-aware self-review (§10). Child plans require the amendments in `2026-07-27-kimi-autonomy-plan-audit-by-fable5.md` before implementation. No KD-01..08 decision is changed.

> **v3 execution control (normative).** Execute this master under
> [`2026-07-27-kimi-autonomy-execution-control-v3.md`](2026-07-27-kimi-autonomy-execution-control-v3.md)
> and the phase-local `v3 mandatory amendments`. Those documents strengthen
> reviewer isolation, signed human decisions, effective GitHub ruleset checks,
> durable notification, artifact-first privacy, and child-process environment
> isolation without changing KD-01..08.

**Goal:** Turn the approved Kimi Code + Mac Mini design into a guarded osstack delivery path where RISK-R0–R2 work runs unattended, RISK-R3 pauses for the Owner, RISK-R4 is permanently blocked, and Kimi Code is the default independent evaluator.

**Architecture:** Build upward from a dedicated `KimiCodeAdapter` and fail-closed verifier, then make profile routing authoritative for `deliver`, add a deterministic autonomy kernel and Git delivery controller, and only then enable allowlisted deployment and 24×7 Mac Mini operation. Keep adapter identity, provider identity, and model identity separate throughout. Preserve the existing `deliver` behavior behind an explicit legacy mode until the guarded path completes its soak gate.

**Tech Stack:** TypeScript ESM, pnpm workspaces, Zod, Vitest, SQLite/better-sqlite3, Unix subprocesses, Git, GitHub CLI, launchd, Kimi Code CLI stream JSON.

---

## 0. Terminology guard

Risk levels in this plan suite are always written `RISK-R0` … `RISK-R4` (`R0`–`R4` alone is acceptable inside tables whose header says "risk"). They must never be confused with osstack's historical release/loop round labels (R0.4, R1.6, R2.4, …) that appear elsewhere in this repository's docs. Any new document that uses a bare `R<n>` for a risk level must define it on first use.

## 1. Authority and baseline

- Approved design: [`docs/superpowers/specs/2026-07-27-kimi-code-mac-mini-autonomous-development-design.md`](../specs/2026-07-27-kimi-code-mac-mini-autonomous-development-design.md), read together with the audit amendments in [`../audits/2026-07-27-kimi-autonomy-plan-audit-by-fable5.md`](../audits/2026-07-27-kimi-autonomy-plan-audit-by-fable5.md) (design-spec items §2.7).
- Planning baseline: `origin/main` commit `a3080eccaba69a0e869a3fbd012be851dbb6603d`
- Package baseline: `@osstack/cli` `0.12.0` (verified in `packages/cli/package.json`)
- Planning branch: `docs/kimi-autonomy-plan`
- Execution target: a new implementation worktree created from the latest `origin/main` at execution time. If `origin/main` has advanced, re-run the file map and test commands before the first code change.
- Local planning checkout with unrelated or uncommitted changes is not an implementation target.

The current code already provides:

- agent adapters and role profiles (9 default adapters, including the DeepSeek review/verify pattern to imitate);
- a loop verifier with per-evaluation judgments;
- worktree creation and loop repair iterations;
- execution-contract approvals (`packages/core/src/state/contract-approvals.ts`, vocabulary low/medium/high);
- checksummed proof packs (`policy-decision.json` and `agent-runtime.json` already schema-checked);
- dry-run PR evidence (`osstack pr --create` performs preflight only);
- a Unix-socket daemon, launchd installer, restart recovery, and repo registry;
- **`packages/github` (read-only branch stewardship helpers) — Phase C extends this package; it is not greenfield.**

The implementation must close these confirmed gaps:

- no `kimi-code` adapter exists;
- a generic subprocess adapter cannot emit `evaluation_judgments`;
- `deliver` does not resolve the active device profile;
- profile resolution does not prove Builder/Evaluator independence;
- risk classification is not preflight + post-diff;
- `osstack pr --create` does not perform GitHub writes;
- proof has no candidate/final stage distinction;
- production allowlisting, health checks, rollback, and freeze state do not exist;
- **no owner-notification channel exists for unattended approval waits, escalations, freezes, or evidence failures.**

## 2. Plan suite and hard dependency order

| Order | Plan | Scope | May start when |
|---|---|---|---|
| A | [`2026-07-27-kimi-adapter-verifier-implementation.md`](2026-07-27-kimi-adapter-verifier-implementation.md) | P0–P2: real probe, adapter, boundary, structured verifier | Audit amendments §2.1 applied |
| B | [`2026-07-27-kimi-profile-deliver-routing-implementation.md`](2026-07-27-kimi-profile-deliver-routing-implementation.md) | P3: default profile, identity, separated routing, guarded `deliver` | A is merged; amendments §2.2 applied |
| C | [`2026-07-27-guarded-git-autonomy-implementation.md`](2026-07-27-guarded-git-autonomy-implementation.md) | P4: RISK kernel, approvals, persistent state, PR/CI/merge | B is merged; amendments §2.3 applied |
| D | [`2026-07-27-deploy-mac-mini-operations-implementation.md`](2026-07-27-deploy-mac-mini-operations-implementation.md) | P5–P6: deploy allowlist, rollback, daemon operations, soak | C is merged; amendments §2.4 applied |
| E | [`2026-07-27-kimi-productization-release-implementation.md`](2026-07-27-kimi-productization-release-implementation.md) | P7: public configuration, installation, release | D soak gate is green; amendments §2.5 applied |

Do not combine A–E into one pull request. Each child plan ends in a releasable, rollback-capable checkpoint.

## 3. Branch, host, and pull-request sequence

### 3.1 Execution hosts

Every child plan declares its execution host per task group. Defaults:

- **Development tasks** (code, tests, package gates): any development machine with the repo, Node 24, and pnpm.
- **Real-probe and operations tasks** (Plan A Task "P0 probe" real-Kimi steps; all of Plan D's launchd/soak/power-policy tasks; Plan E release-qualification smoke on the target): the registered **Mac Mini** only. A development machine may run these tasks' fake-binary variants but must not record them as real-probe or soak evidence.

### 3.2 Worktree root (no machine-private absolute paths)

All child plans use the parametrized worktree root instead of any absolute personal path:

```bash
: "${OSSTACK_WORKTREES_ROOT:=$HOME/Developer/worktrees}"
mkdir -p "$OSSTACK_WORKTREES_ROOT"
df -P "$OSSTACK_WORKTREES_ROOT"
```

If storage placement is an Owner policy, compare the `df` result to an
Owner-provided expected device value outside the repository. Public plans and
defaults never name a private device label.

Use one branch per child plan:

```text
feat/kimi-adapter-verifier
feat/kimi-profile-deliver
feat/guarded-git-autonomy
feat/guarded-deploy-operations
feat/kimi-productization
```

The Phase A branch starts with:

```bash
git fetch origin --prune
git worktree add -b feat/kimi-adapter-verifier \
  "$OSSTACK_WORKTREES_ROOT/osstack-kimi-adapter-verifier" \
  origin/main
cd "$OSSTACK_WORKTREES_ROOT/osstack-kimi-adapter-verifier"
corepack enable pnpm
pnpm install --frozen-lockfile
```

Expected result:

- the worktree is clean;
- `git rev-parse --abbrev-ref HEAD` prints the intended branch;
- `pnpm install --frozen-lockfile` exits `0`.

Cherry-pick only the approved design/plan commit if the implementation branch does not contain these documents. Never cherry-pick unrelated commits from a stale local `main`.

## 4. Control-plane database safety

Every development command that can load the CLI must use an isolated home. Never run `packages/cli/dist/bin.js` against the default `~/.osstack`.

For one implementation worktree:

```bash
mkdir -p "$PWD/.tmp/osstack-dev-home"
export OSSTACK_HOME="$PWD/.tmp/osstack-dev-home"
export OSSTACK_SOCKET="$OSSTACK_HOME/daemon.sock"
```

Expected result:

```bash
test "$OSSTACK_HOME" = "$PWD/.tmp/osstack-dev-home"
test "$OSSTACK_SOCKET" = "$PWD/.tmp/osstack-dev-home/daemon.sock"
```

Both commands must exit `0`. The package test suite already assigns a fresh per-file `OSSTACK_HOME`; keep `packages/cli/src/test-setup-hermetic-home.ts` enabled.

## 5. Cross-phase invariants

Every phase must preserve these invariants:

1. Kimi process exit `0` never implies review approval.
2. Malformed or incomplete reviewer output fails closed.
3. Deterministic verification runs before semantic review.
4. A secret or path-boundary violation blocks before external-model invocation.
5. Reviewer-caused workspace mutation blocks delivery and preserves evidence.
6. Builder and Evaluator adapters are different.
7. RISK-R2 additionally requires provider or model independence, **proven only by adapter-reported runtime identity; configured or inferred identity never satisfies the independence requirement.**
8. RISK-R3 approval binds contract digest, current diff digest, and exact action scope, **and every external write action is checked against the approved scope at execution time.**
9. A changed diff invalidates an old approval.
10. RISK-R4 has no approval transition.
11. Candidate proof succeeds before push or PR creation.
12. Final proof succeeds before the run becomes `completed`.
13. Production deployment requires a repo/change allowlist, rollback, health check, and no active freeze.
14. Risk-policy and allowlist changes are always RISK-R3, **including the deploy/health/rollback scripts referenced by policy files, and — when the target repository is osstack itself — the risk/approval/state-machine sources of the autonomy kernel.**
15. Credentials are inherited from the tool's own login or credential store and never persisted in osstack configuration, events, or proof.
16. **Reviewer isolation is enforced by a Kimi-native read-only/tool policy proven by adversarial probe or by an OS-enforced boundary that cannot write the builder repository or its common Git directory. A linked Git worktree is not isolation because it shares the common Git directory. Mutation evidence additionally covers Git config/hooks, ignored, tracked, staged, and untracked content and fails closed when incomplete.**
17. **Diff authority: risk classification, approval digests, and candidate proof are computed from `git add -A` + `git diff --cached` (untracked files included); the staged diff hash is recomputed and asserted immediately before commit, and merge uses `gh pr merge --match-head-commit <pushedSha>`.**
18. **Git delivery requires effective base-branch protection from legacy branch protection and/or applicable repository rulesets; absent or ambiguous protection and zero required checks are `blocked_delivery`, never auto-merged. Required checks bind the current pushed SHA.**
19. **Production approval and freeze-clear are non-spoofable at the local trust boundary: a decision signed outside the Builder/Reviewer trust domain binds run, contract/diff digests, exact action scope, nonce, expiry, and decision. TTY-only confirmation is development/break-glass UX and cannot authorize production. Governance denies `osstack autonomy approve|reject|freeze clear` to Builder and Reviewer.**
20. **Entering `awaiting_approval`, `escalated`, `deploy_frozen`, `rollback_failed`, or `delivery_evidence_failed` persists a redacted owner-notification outbox item before delivery. Delivery failure never changes the primary run result, but bounded retry, idempotency, dead-letter state, and health/scorecard visibility are mandatory.**

### 5b. Kimi usage budget

- `OSSTACK_KIMI_MAX_TOKENS_PER_RUN` and `OSSTACK_KIMI_MAX_REVIEWS_PER_DAY` bound external-model spend; defaults are generous but finite.
- Exceeding a budget marks the run `external_blocker` (like quota exhaustion). A budget stop never downgrades verification strength and never converts to an auto-approval.
- Per-run token usage and daily spend appear in the scorecard; Plan D's daily ops check includes remaining quota/budget.

## 6. Verification ladder

Run the narrow command after every red/green step, then the package suite before each task commit, then the repository suite before each phase pull request.

Narrow examples:

```bash
pnpm --filter @osstack/agents test -- kimi-code.test.ts
pnpm --filter @osstack/loop test -- verifier.test.ts
pnpm --filter @osstack/config test -- resolver.test.ts
pnpm --filter @osstack/autonomy test -- risk.test.ts      # from Phase C (package created in C)
pnpm --filter @osstack/github test -- delivery.test.ts    # from Phase C (file created in C)
pnpm --filter @osstack/cli test -- deliver-cli.test.ts
```

Package gates (the `@osstack/autonomy` lines apply from Phase C onward):

```bash
pnpm --filter @osstack/agents test
pnpm --filter @osstack/agents typecheck
pnpm --filter @osstack/config test
pnpm --filter @osstack/config typecheck
pnpm --filter @osstack/loop test
pnpm --filter @osstack/loop typecheck
pnpm --filter @osstack/core test
pnpm --filter @osstack/core typecheck
pnpm --filter @osstack/autonomy test        # Phase C+
pnpm --filter @osstack/autonomy typecheck   # Phase C+
pnpm --filter @osstack/github test
pnpm --filter @osstack/github typecheck
pnpm --filter @osstack/cli test
pnpm --filter @osstack/cli typecheck
```

Phase gate:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
git status --short
```

Expected result:

- all commands exit `0`;
- `git diff --check` prints nothing;
- `git status --short` shows only the intended phase files before the final commit and is clean after the commit.

## 7. Rollout flags

Use these rollout states:

| State | Meaning |
|---|---|
| `legacy` | Existing `deliver` behavior, byte-for-byte: no profile resolution, no adapter probing, no automatic Git or deploy writes. Protected by behavior-snapshot tests recorded before Phase B changes. |
| `guarded-local` | Profile routing, worktree, deterministic checks, Kimi review, candidate proof; no remote writes |
| `guarded-git` | RISK-R1/R2 commit, push, PR, CI, and merge enabled |
| `guarded-deploy` | Allowlisted staging/production deploy and rollback enabled |

The CLI contract is:

```bash
osstack deliver "Add a tested greeting helper" \
  --workspace "$PWD/.tmp/greeting-fixture" \
  --profile mac-mini \
  --autonomy guarded-local \
  --worktree \
  --json
```

Phase C adds `guarded-git`; Phase D adds `guarded-deploy`. `legacy` remains available for rollback through Phase E.

## 8. Phase promotion gates

### A → B

- Kimi is listed by `osstack agent list`.
- fake-binary adapter and verifier suites pass.
- `changes_requested`, malformed output, unknown judgment ids, and reviewer mutation all block — **including a reviewer write to `.git/hooks/**` or a gitignored path (invariant 16 test).**
- **Hermes `DonePayload` preserves the structured `review` extension through schema parse (contract test), and a configured structured reviewer whose done payload lacks it fails closed.**
- **Seeded-defect gate is two-layer: the offline (fake) layer proves fail-closed plumbing in CI, and the live layer (real Kimi on the Mac Mini, ≥10 corpus cases) reports a scorecard with false-pass count zero.** The tautological fake-only variant does not satisfy this gate.

### B → C

- plain `deliver` with `--profile mac-mini` selects Kimi as Evaluator.
- active `auto` profile is honored by `deliver`, `loop run`, and `loop start` **in guarded modes only; legacy-mode behavior snapshots recorded before Phase B still pass unchanged (zero adapter probes on bare `deliver`).**
- Builder/Evaluator adapter conflict selects a fallback or fails closed.
- guarded-local runs write routing and runtime identity evidence, **with `evidence_source` graded (`reported`/`configured`/`inferred`) and independence claims backed only by `reported` (invariant 7 test).**
- **`config show`/`config doctor` display per-role runtime identity without leaking secrets.**

### C → D

- RISK-R1 and RISK-R2 fixture repositories complete Git delivery unattended.
- RISK-R3 pauses before its first unauthorized write, **and an approved post-diff RISK-R3 run resumes directly into candidate proof without rebuilding (no approval/rebuild livelock).**
- post-diff escalation invalidates any previous approval; **an untracked new file in a protected path (e.g. auth) is classified RISK-R3 (invariant 17 test).**
- RISK-R4 cannot transition to an executable state.
- PR/merge never runs without candidate proof; **merge argv includes `--match-head-commit`; a repo without effective legacy/ruleset protection, with ambiguous protection evidence, or with zero required checks ends `blocked_delivery` (invariant 18 test).**
- **Production approval and freeze-clear reject invalid, replayed, expired, digest-mismatched, or scope-mismatched signed decisions; TTY-only development mode cannot authorize production (invariant 19 tests).**

### D → E

- 7-day Mac Mini daemon soak completes with an **Owner-approved power policy or bounded power assertion recorded and verified by `osstack autonomy health` before the soak starts; changing machine-wide settings requires the named machine authority gate and a recorded rollback.**
- at least 30 real RISK-R1/R2 tasks across at least two repositories complete, **drawn from a backlog of ≥30 pre-registered real tasks with acceptance criteria (registered before the soak starts; prompt digests pairwise distinct; workspaces outside `fixtures/`). If supply runs short, extend the window rather than manufacturing trivial tasks.**
- five forced daemon restarts (SIGKILL) and three network interruptions recover.
- three simulated deploy failures all rollback successfully, **and every production-eligible repo has a recorded rollback drill whose script digests match the current scripts.**
- no unauthorized RISK-R3/R4 action, reviewer mutation escape, or proof-integrity failure occurs.
- **The owner-notification channel delivered at least one real `awaiting_approval` and one `deploy_frozen`/`escalated` notification, and a forced notification outage was recovered from the durable outbox without duplicate delivery or silent loss.**

## 9. Final product acceptance

The full plan is complete only when this command can run on the registered Mac Mini:

```bash
osstack deliver "Implement the approved task" \
  --workspace "$PWD/.tmp/approved-task-fixture" \
  --profile mac-mini \
  --autonomy guarded-deploy \
  --worktree \
  --verify-profile standard \
  --deploy-policy project \
  --json
```

For a RISK-R2 allowlisted change, the result must contain:

- Builder, Evaluator, provider, and model identities **with evidence grading**;
- deterministic evaluation results;
- Kimi review and structured judgments;
- preflight and post-diff risk decisions;
- candidate proof digest;
- branch, PR, CI, and merge evidence **including the `--match-head-commit` target**;
- staging/production deployment and health evidence when enabled, **including deploy-script digests matching the drilled digests**;
- final proof digest that supersedes the candidate proof;
- **Kimi token/budget usage.**

For RISK-R3, the same command must return `needs_approval` (protocol envelope status `"n"` with a non-empty `required_approvals`) before commit, push, merge, or deploy. For RISK-R4, it must return `blocked` and expose no approval action.

## 10. Plan self-review command

Before implementation handoff:

```bash
rg -n '[F]IXME|[X]XX|UNRESOLVED_[M]ARKER' \
  docs/superpowers/plans/2026-07-27-*.md

# Privacy/portability gate: the Owner supplies patterns outside the repository,
# so the plan does not reproduce private identifiers or self-match its scanner.
test -n "$OSSTACK_PRIVACY_PATTERN_FILE"
if rg -n -f "$OSSTACK_PRIVACY_PATTERN_FILE" \
  docs/superpowers/plans/2026-07-27-*.md \
  docs/superpowers/specs/2026-07-27-kimi-code-*.md; then
  echo "private identifier found" >&2
  exit 1
fi
```

Expected result:

- no matches in either command (the worktree-root example in §3.2 uses `$OSSTACK_WORKTREES_ROOT`/`$HOME`, not literal private paths);
- every child plan declares its execution host per §3.1;
- every child plan uses concrete package names, branch names, paths, commands, and expected outcomes;
- every code task begins with a failing test and ends with a focused commit.

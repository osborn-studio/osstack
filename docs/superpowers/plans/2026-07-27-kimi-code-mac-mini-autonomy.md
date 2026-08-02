# Kimi Code Mac Mini Autonomy Implementation Plan

> **Status: Superseded.** This v1 document is an audit baseline only. Use the [current-state index](../KIMI_AUTONOMY_STATUS.md) for current code, runbooks, and evidence gates.

> **Superseded for execution.** This v1 plan is retained as the pinned audit
> baseline. Execute
> [`2026-07-27-kimi-code-mac-mini-autonomy.v2.md`](2026-07-27-kimi-code-mac-mini-autonomy.v2.md)
> under
> [`2026-07-27-kimi-autonomy-execution-control-v3.md`](2026-07-27-kimi-autonomy-execution-control-v3.md).
> When this historical text conflicts with either document, v3 control wins.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the approved Kimi Code + Mac Mini design into a guarded osstack delivery path where R0–R2 work runs unattended, R3 pauses for the Owner, R4 is permanently blocked, and Kimi Code is the default independent evaluator.

**Architecture:** Build upward from a dedicated `KimiCodeAdapter` and fail-closed verifier, then make profile routing authoritative for `deliver`, add a deterministic autonomy kernel and Git delivery controller, and only then enable allowlisted deployment and 24×7 Mac Mini operation. Keep adapter identity, provider identity, and model identity separate throughout. Preserve the existing `deliver` behavior behind an explicit legacy mode until the guarded path completes its soak gate.

**Tech Stack:** TypeScript ESM, pnpm workspaces, Zod, Vitest, SQLite/better-sqlite3, Unix subprocesses, Git, GitHub CLI, launchd, Kimi Code CLI stream JSON.

---

## 1. Authority and baseline

- Approved design: [`docs/superpowers/specs/2026-07-27-kimi-code-mac-mini-autonomous-development-design.md`](../specs/2026-07-27-kimi-code-mac-mini-autonomous-development-design.md)
- Planning baseline: `origin/main` commit `a3080eccaba69a0e869a3fbd012be851dbb6603d`
- Package baseline: osstack `0.12.0`
- Planning branch: `docs/kimi-autonomy-plan`
- Execution target: a new implementation worktree created from the latest `origin/main` at execution time. If `origin/main` has advanced, re-run the file map and test commands before the first code change.
- Local planning checkout with unrelated or uncommitted changes is not an implementation target.

The current code already provides:

- agent adapters and role profiles;
- a loop verifier with per-evaluation judgments;
- worktree creation and loop repair iterations;
- execution-contract approvals;
- checksummed proof packs;
- dry-run PR evidence;
- a Unix-socket daemon, launchd installer, restart recovery, and repo registry.

The implementation must close these confirmed gaps:

- no `kimi-code` adapter exists;
- a generic subprocess adapter cannot emit `evaluation_judgments`;
- `deliver` does not resolve the active device profile;
- profile resolution does not prove Builder/Evaluator independence;
- risk classification is not preflight + post-diff;
- `osstack pr --create` does not perform GitHub writes;
- proof has no candidate/final stage distinction;
- production allowlisting, health checks, rollback, and freeze state do not exist.

## 2. Plan suite and hard dependency order

| Order | Plan | Scope | May start when |
|---|---|---|---|
| A | [`2026-07-27-kimi-adapter-verifier-implementation.md`](2026-07-27-kimi-adapter-verifier-implementation.md) | P0–P2: real probe, adapter, boundary, structured verifier | Immediately |
| B | [`2026-07-27-kimi-profile-deliver-routing-implementation.md`](2026-07-27-kimi-profile-deliver-routing-implementation.md) | P3: default profile, identity, separated routing, guarded `deliver` | A is merged |
| C | [`2026-07-27-guarded-git-autonomy-implementation.md`](2026-07-27-guarded-git-autonomy-implementation.md) | P4: R0–R4 kernel, approvals, persistent state, PR/CI/merge | B is merged |
| D | [`2026-07-27-deploy-mac-mini-operations-implementation.md`](2026-07-27-deploy-mac-mini-operations-implementation.md) | P5–P6: deploy allowlist, rollback, daemon operations, soak | C is merged |
| E | [`2026-07-27-kimi-productization-release-implementation.md`](2026-07-27-kimi-productization-release-implementation.md) | P7: public configuration, installation, release | D soak gate is green |

Do not combine A–E into one pull request. Each child plan ends in a releasable, rollback-capable checkpoint.

## 3. Branch and pull-request sequence

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
: "${OSSTACK_WORKTREES_ROOT:=$HOME/Developer/worktrees}"
mkdir -p "$OSSTACK_WORKTREES_ROOT"
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

Cherry-pick only the approved design/plan commit if the implementation branch does not contain these documents. Never cherry-pick unrelated commits from the stale local `main`.

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
7. R2 additionally requires provider or model independence.
8. R3 approval binds contract digest, current diff digest, and exact action scope.
9. A changed diff invalidates an old approval.
10. R4 has no approval transition.
11. Candidate proof succeeds before push or PR creation.
12. Final proof succeeds before the run becomes `completed`.
13. Production deployment requires a repo/change allowlist, rollback, health check, and no active freeze.
14. Risk-policy and allowlist changes are always R3.
15. Credentials are inherited from the tool’s own login or credential store and never persisted in osstack configuration, events, or proof.

## 6. Verification ladder

Run the narrow command after every red/green step, then the package suite before each task commit, then the repository suite before each phase pull request.

Narrow examples:

```bash
pnpm --filter @osstack/agents test -- kimi-code.test.ts
pnpm --filter @osstack/loop test -- verifier.test.ts
pnpm --filter @osstack/config test -- resolver.test.ts
pnpm --filter @osstack/autonomy test -- risk.test.ts
pnpm --filter @osstack/github test -- delivery.test.ts
pnpm --filter @osstack/cli test -- deliver-cli.test.ts
```

Package gates:

```bash
pnpm --filter @osstack/agents test
pnpm --filter @osstack/agents typecheck
pnpm --filter @osstack/config test
pnpm --filter @osstack/config typecheck
pnpm --filter @osstack/loop test
pnpm --filter @osstack/loop typecheck
pnpm --filter @osstack/core test
pnpm --filter @osstack/core typecheck
pnpm --filter @osstack/autonomy test
pnpm --filter @osstack/autonomy typecheck
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
| `legacy` | Existing `deliver` behavior; no automatic Git or deploy writes |
| `guarded-local` | Profile routing, worktree, deterministic checks, Kimi review, candidate proof; no remote writes |
| `guarded-git` | R1/R2 commit, push, PR, CI, and merge enabled |
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
- `changes_requested`, malformed output, unknown judgment ids, and reviewer mutation all block.
- seeded-defect false-pass count is zero.

### B → C

- plain `deliver` with `--profile mac-mini` selects Kimi as Evaluator.
- active `auto` profile is honored by `deliver`, `loop run`, and `loop start`.
- Builder/Evaluator adapter conflict selects a fallback or fails closed.
- guarded-local runs write routing and runtime identity evidence.

### C → D

- R1 and R2 fixture repositories complete Git delivery unattended.
- R3 pauses before its first unauthorized write.
- post-diff escalation invalidates any previous approval.
- R4 cannot transition to an executable state.
- PR/merge never runs without candidate proof.

### D → E

- 7-day Mac Mini daemon soak completes.
- at least 30 real R1/R2 tasks across at least two repositories complete.
- five forced daemon restarts and three network interruptions recover.
- three simulated deploy failures all rollback successfully.
- no unauthorized R3/R4 action, reviewer mutation escape, or proof-integrity failure occurs.

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

For an R2 allowlisted change, the result must contain:

- Builder, Evaluator, provider, and model identities;
- deterministic evaluation results;
- Kimi review and structured judgments;
- preflight and post-diff risk decisions;
- candidate proof digest;
- branch, PR, CI, and merge evidence;
- staging/production deployment and health evidence when enabled;
- final proof digest that supersedes the candidate proof.

For R3, the same command must return `needs_approval` before commit, push, merge, or deploy. For R4, it must return `blocked` and expose no approval action.

## 10. Plan self-review command

Before implementation handoff:

```bash
rg -n '[F]IXME|[X]XX|UNRESOLVED_[M]ARKER' \
  docs/superpowers/plans/2026-07-27-*.md
```

Expected result:

- no matches;
- every child plan uses concrete package names, branch names, paths, commands, and expected outcomes;
- every code task begins with a failing test and ends with a focused commit.

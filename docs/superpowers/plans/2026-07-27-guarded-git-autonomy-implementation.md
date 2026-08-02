# Guarded Git Autonomy Implementation Plan

> **Status: Implemented.** Phase C landed in PR #158. This file is retained as its historical implementation plan; see the [current-state index](../KIMI_AUTONOMY_STATUS.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable R0–R4 autonomy kernel so R1/R2 work can commit, push, open a PR, wait for CI, and merge without human intervention while R3 requires a digest-bound Owner decision and R4 remains permanently blocked.

**Architecture:** Introduce `@osstack/autonomy` as a pure state-machine/orchestration package with injected local-execution, evidence, GitHub, and persistence ports. Keep schemas in `@osstack/protocol`, repository policy and SQLite authority in `@osstack/core`, Git/GitHub argv execution in `@osstack/github`, and CLI composition in `@osstack/cli`. Classify risk before Builder invocation and again from the real diff; persist every transition before the next side effect.

**Tech Stack:** TypeScript ESM, Zod, Vitest, SQLite, SHA-256 canonical JSON, Git, GitHub CLI, osstack proof packs and loop engine.

> **v3 execution amendment.** This plan is executable only together with
> `2026-07-27-kimi-autonomy-execution-control-v3.md` and ledger items C-01
> through C-04 plus X-02/X-04/X-07. The amendment section at the end of this
> file overrides conflicting task text.

**Execution hosts:** deterministic package and fake-GitHub work may run on any
development host. Real GitHub protection/ruleset and SHA-bound merge
qualification uses disposable protected repositories under the registered
Owner account.

---

## Task 1: Create the Phase C worktree

**Files:**

- Verify Phase B baseline only

- [ ] Create:

```bash
git fetch origin --prune
: "${OSSTACK_WORKTREES_ROOT:=$HOME/Developer/worktrees}"
mkdir -p "$OSSTACK_WORKTREES_ROOT"
git worktree add -b feat/guarded-git-autonomy \
  "$OSSTACK_WORKTREES_ROOT/osstack-guarded-git-autonomy" \
  origin/main
cd "$OSSTACK_WORKTREES_ROOT/osstack-guarded-git-autonomy"
corepack enable pnpm
pnpm install --frozen-lockfile
mkdir -p "$PWD/.tmp/osstack-dev-home"
export OSSTACK_HOME="$PWD/.tmp/osstack-dev-home"
export OSSTACK_SOCKET="$OSSTACK_HOME/daemon.sock"
```

- [ ] Verify Phase B:

```bash
rg -n 'guarded-local' packages/cli/src/deliver-command.ts
rg -n 'kimi-code' packages/config/src/config.ts
pnpm --filter @osstack/cli test -- deliver-cli.test.ts loop-profile-routing.test.ts
```

Expected: both features are found and tests pass.

## Task 2: Add protocol contracts for autonomy risk, state, and scoped approval

**Files:**

- Create: `packages/protocol/src/autonomy.ts`
- Create: `packages/protocol/src/autonomy.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/scripts/generate-schemas.mjs`
- Create generated schemas under: `packages/protocol/schemas/`
- Test: strict producer and lenient consumer contracts

- [ ] Write failing tests for:

- R0–R4 parsing;
- legal autonomy states;
- risk decisions with deterministic signals;
- an R3 scoped approval request;
- rejection of an agent actor in a scoped approval decision;
- rejection of an approval without matching contract and diff digests;
- R4 request creation rejection.

- [ ] Run:

```bash
pnpm --filter @osstack/protocol test -- autonomy.test.ts
```

Expected: failure because the schemas do not exist.

- [ ] Implement:

```ts
import { z } from "zod";
import { Actor } from "./approval.js";

export const AutonomyRiskLevel = z.enum(["R0", "R1", "R2", "R3", "R4"]);
export type AutonomyRiskLevel = z.infer<typeof AutonomyRiskLevel>;

export const AutonomyRiskPhase = z.enum(["preflight", "post_diff"]);

export const AutonomyRiskSignal = z.object({
  rule_id: z.string().min(1),
  level: AutonomyRiskLevel,
  message: z.string().min(1),
  path: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
}).strict();

export const AutonomyRiskDecision = z.object({
  phase: AutonomyRiskPhase,
  level: AutonomyRiskLevel,
  signals: z.array(AutonomyRiskSignal),
  policy_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  input_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  decided_at: z.string().datetime(),
}).strict();

export const AutonomyRunState = z.enum([
  "queued",
  "classifying",
  "awaiting_approval",
  "blocked",
  "preparing",
  "building",
  "verifying",
  "repairing",
  "reviewing",
  "post_classifying",
  "candidate_proof",
  "committing",
  "pushing",
  "opening_pr",
  "waiting_ci",
  "merging",
  "final_proof",
  "blocked_delivery",
  "delivery_evidence_failed",
  "escalated",
  "cancelled",
  "completed",
]);

export const ScopedApprovalRequest = z.object({
  approval_id: z.string().min(1),
  autonomy_run_id: z.string().min(1),
  contract_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  diff_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  action_scope: z.array(z.string().min(1)).min(1),
  risk: z.literal("R3"),
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  requested_at: z.string().datetime(),
}).strict();

export const ScopedApprovalDecision = z.object({
  approval_id: z.string().min(1),
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  approved: z.boolean(),
  decided_by: Actor.refine(
    (actor) => actor.type === "human",
    "guarded autonomy approval requires a human actor",
  ),
  decided_at: z.string().datetime(),
  reason: z.string().min(1),
}).strict();
```

Generate JSON schemas for all five producer contracts.

- [ ] Run:

```bash
pnpm --filter @osstack/protocol test -- autonomy.test.ts schemas.test.ts
pnpm --filter @osstack/protocol generate:schemas
pnpm --filter @osstack/protocol check:schemas
pnpm --filter @osstack/protocol typecheck
```

Expected: all commands pass and generated files are stable.

- [ ] Commit:

```bash
git add packages/protocol
git commit -m "feat(protocol): define guarded autonomy contracts"
```

## Task 3: Upgrade repository configuration to schema version 2

**Files:**

- Modify: `packages/core/src/policy/profile.ts`
- Modify: `packages/core/src/policy/profile.test.ts`
- Modify: `docs/specs/schemas/repo-config.schema.json`
- Modify: `docs/specs/POLICY_PROFILE_V1.md`
- Modify: `packages/cli/src/policy-command.ts`
- Modify: `packages/cli/src/policy-cli.test.ts`
- Test: v1 compatibility and strict v2 policy

- [ ] Add failing tests for this exact v2 repository config:

```yaml
schema_version: 2
product: example-web
role: core_product
default_branch: main
verify_command: pnpm test
autonomy:
  max_auto_risk: R2
  require_independent_evaluator: true
  max_builder_iterations: 3
  max_review_rounds: 3
  max_wall_time_minutes: 90
  max_no_progress_rounds: 2
git:
  remote: origin
  branch_prefix: osstack
  merge_strategy: squash
  auto_merge: true
  protected_branches: [main]
verification:
  quick: [pnpm lint, pnpm test -- --changed]
  standard: [pnpm lint, pnpm typecheck, pnpm test, pnpm build]
  release: [pnpm lint, pnpm typecheck, pnpm test, pnpm build]
```

Tests must prove:

- valid v1 still parses;
- v2 is strict at every nesting level;
- `max_auto_risk` accepts only R1 or R2;
- no config field can contain credentials;
- `git.branch_prefix` cannot be empty or equal a protected branch;
- `verification.standard` cannot be empty;
- changing `.osstack/repo.yaml` is classified separately as R3.

- [ ] Run:

```bash
pnpm --filter @osstack/core test -- profile.test.ts
pnpm --filter @osstack/cli test -- policy-cli.test.ts
```

Expected: v2 tests fail before the union schema is added.

- [ ] Define the nested schemas before the v1/v2 union:

```ts
export const CommandArgv = z.array(z.string().min(1)).min(1).max(64);

export const AutonomyRepoPolicy = z.object({
  max_auto_risk: z.enum(["R1", "R2"]),
  require_independent_evaluator: z.boolean(),
  max_builder_iterations: z.number().int().min(1).max(10),
  max_review_rounds: z.number().int().min(1).max(10),
  max_wall_time_minutes: z.number().int().min(1).max(1_440),
  max_no_progress_rounds: z.number().int().min(1).max(5),
}).strict();

export const GitRepoPolicy = z.object({
  remote: z.string().min(1),
  branch_prefix: z.string().min(1),
  merge_strategy: z.literal("squash"),
  auto_merge: z.boolean(),
  protected_branches: z.array(z.string().min(1)).min(1),
}).strict().superRefine((git, ctx) => {
  if (git.protected_branches.includes(git.branch_prefix)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["branch_prefix"],
      message: "branch_prefix cannot equal a protected branch",
    });
  }
});

export const VerificationProfiles = z.object({
  quick: z.array(z.string().min(1)).min(1),
  standard: z.array(z.string().min(1)).min(1),
  release: z.array(z.string().min(1)).min(1),
}).strict();

export const DeployTargetPolicy = z.object({
  enabled: z.boolean(),
  command: CommandArgv,
  verify_command: CommandArgv,
  health_check: CommandArgv,
  rollback: CommandArgv,
  timeout_ms: z.number().int().min(1_000).max(1_800_000),
  health_timeout_ms: z.number().int().min(1_000).max(600_000),
  allowed_change_types: z.array(z.string().min(1)).min(1),
  allowed_paths: z.array(z.string().min(1)).min(1),
  forbidden_paths: z.array(z.string().min(1)).default([]),
  allowed_base_branches: z.array(z.string().min(1)).min(1),
  freeze_windows: z.array(z.object({
    timezone: z.string().min(1),
    days: z.array(z.number().int().min(0).max(6)).min(1),
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
  }).strict()).default([]),
}).strict();

export const DeployRepoPolicy = z.object({
  staging: DeployTargetPolicy.optional(),
  production: DeployTargetPolicy.optional(),
}).strict();
```

Apply a final `superRefine` to v2 that rejects credential-shaped assignments in every string leaf and rejects any path that appears in both an allowed and forbidden list. Plan D activates these deploy fields; Phase C only validates and reports them.

- [ ] Refactor:

```ts
const RepoConfigCommon = {
  product: z.string().min(1),
  domain: z.string().min(1).optional(),
  role: RepoConfigRole,
  priority: z.number().min(0).max(100).optional(),
  default_branch: z.string().min(1),
  verify_command: z.string().min(1),
  build_command: z.string().optional(),
  staging_command: z.string().optional(),
  production_environment: z.string().optional(),
} as const;

export const RepoConfigV1 = z.object({
  schema_version: z.literal(1),
  ...RepoConfigCommon,
}).strict();

export const RepoConfigV2 = z.object({
  schema_version: z.literal(2),
  ...RepoConfigCommon,
  autonomy: AutonomyRepoPolicy,
  git: GitRepoPolicy,
  verification: VerificationProfiles,
  deploy: DeployRepoPolicy.optional(),
}).strict();

export const RepoConfig = z.discriminatedUnion("schema_version", [
  RepoConfigV1,
  RepoConfigV2,
]);
```

Define every nested schema with `.strict()`. `DeployRepoPolicy` is accepted but not executed until Plan D.

- [ ] Update the checked-in JSON schema so it expresses the v1/v2 union. Update policy CLI output to show autonomy, Git, and verification fields for v2.

- [ ] Run:

```bash
pnpm --filter @osstack/core test -- profile.test.ts
pnpm --filter @osstack/cli test -- policy-cli.test.ts
pnpm --filter @osstack/core typecheck
pnpm --filter @osstack/cli typecheck
```

Expected: v1 and v2 tests pass.

- [ ] Commit:

```bash
git add packages/core/src/policy packages/cli/src/policy-command.ts \
  packages/cli/src/policy-cli.test.ts docs/specs
git commit -m "feat(core): add strict guarded repository policy"
```

## Task 4: Scaffold `@osstack/autonomy`

**Files:**

- Create: `packages/autonomy/package.json`
- Create: `packages/autonomy/tsconfig.json`
- Create: `packages/autonomy/src/index.ts`
- Create: `packages/autonomy/src/types.ts`
- Create: `packages/autonomy/src/types.test.ts`
- Modify: `pnpm-lock.yaml`
- Test: package exports and strict types

- [ ] Create `packages/autonomy/package.json`:

```json
{
  "name": "@osstack/autonomy",
  "version": "0.0.0",
  "description": "Guarded autonomy state machine, risk classifier, and delivery orchestration for osstack.",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p .",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@osstack/core": "workspace:*",
    "@osstack/protocol": "workspace:*",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/node": "^22.19.19"
  },
  "publishConfig": {
    "access": "public"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] Base `tsconfig.json` on `packages/loop/tsconfig.json`.

- [ ] Define:

```ts
export interface AutonomyTaskIntent {
  autonomy_run_id: string;
  task_id: string;
  repo_id: string;
  workspace_path: string;
  goal: string;
  expected_paths: string[];
  requested_actions: string[];
  contract_sha256: string;
}

export interface PostDiffInput {
  changed_paths: string[];
  diff: string;
  commands: string[];
  dependency_changes: Array<{
    name: string;
    from?: string;
    to?: string;
    major: boolean;
  }>;
}

export interface DeliveryBudget {
  max_builder_iterations: number;
  max_review_rounds: number;
  max_wall_time_ms: number;
  max_no_progress_rounds: number;
}
```

- [ ] Add parsing/default tests. Run:

```bash
pnpm install --frozen-lockfile=false
pnpm --filter @osstack/autonomy test
pnpm --filter @osstack/autonomy typecheck
```

Expected: package tests and typecheck pass.

- [ ] Commit:

```bash
git add packages/autonomy pnpm-lock.yaml
git commit -m "feat(autonomy): scaffold guarded delivery package"
```

## Task 5: Implement deterministic preflight and post-diff risk

**Files:**

- Create: `packages/autonomy/src/risk.ts`
- Create: `packages/autonomy/src/risk.test.ts`
- Modify: `packages/autonomy/src/index.ts`
- Test: every R0–R4 deterministic signal

- [ ] Write table-driven tests for:

| Fixture | Expected |
|---|---|
| read-only analysis with no write action | R0 |
| Markdown-only change | R1 |
| test-only change | R1 |
| ordinary source feature | R2 |
| auth path | R3 |
| billing/payment path | R3 |
| migration/DDL | R3 |
| `.env`, credentials, certificates | R3 |
| `.github/workflows` permission change | R3 |
| `.osstack/repo.yaml` or `.osstack/policy.yaml` | R3 |
| major dependency change | R3 |
| force push/history rewrite | R3 |
| production deploy config | R3 |
| delete production data | R4 |
| bypass verification/approval | R4 |
| exfiltrate credentials | R4 |
| destructive recursive root command | R4 |

Also prove the final level is the maximum of preflight and post-diff.

- [ ] Run:

```bash
pnpm --filter @osstack/autonomy test -- risk.test.ts
```

Expected: failure because `risk.ts` is missing.

- [ ] Implement exact ordering:

```ts
const RISK_ORDER = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 } as const;

export function maxRisk(
  left: AutonomyRiskLevel,
  right: AutonomyRiskLevel,
): AutonomyRiskLevel {
  return RISK_ORDER[left] >= RISK_ORDER[right] ? left : right;
}
```

Use closed rule registries:

```ts
const R3_PATH_RULES = [
  ["risk.auth", /(^|\/)(auth|authorization|permissions?)(\/|$)/i],
  ["risk.billing", /(^|\/)(billing|payments?)(\/|$)/i],
  ["risk.migration", /(^|\/)(migrations?|schema)(\/|$)/i],
  ["risk.secret", /(^|\/)(\.env|secrets?|credentials?|certs?)(\/|$)/i],
  ["risk.workflow", /^\.github\/workflows\//i],
  ["risk.infrastructure", /(^|\/)(infra|terraform|pulumi|k8s|production)(\/|$)/i],
  ["risk.policy", /^\.osstack\/(repo|policy)\.ya?ml$/i],
] as const;
```

Use explicit R4 patterns only for unambiguously forbidden intent or diff:

```text
delete/truncate/drop production data without recovery
expose/exfiltrate credentials
disable or bypass policy, review, tests, or approval
rm -rf /
```

Ambiguous destructive text escalates to R3, never directly to R4.

Return all matched signals, the maximum level, policy digest, input digest, and deterministic timestamp supplied through an injected clock.

- [ ] Run:

```bash
pnpm --filter @osstack/autonomy test -- risk.test.ts
pnpm --filter @osstack/autonomy typecheck
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add packages/autonomy/src/risk.ts packages/autonomy/src/risk.test.ts \
  packages/autonomy/src/index.ts
git commit -m "feat(autonomy): classify delivery risk deterministically"
```

## Task 6: Add the durable autonomy state projection and transition log

**Files:**

- Modify: `packages/core/src/state/migrations.ts`
- Modify: `packages/core/src/state/schema.ts`
- Create: `packages/core/src/state/autonomy-runs.ts`
- Create: `packages/core/src/state/autonomy-runs.test.ts`
- Modify: `packages/core/src/state/index.ts`
- Modify: `packages/core/src/state/db.test.ts`
- Test: atomic transitions and restart recovery

- [ ] Add migration `17`:

```sql
CREATE TABLE IF NOT EXISTS autonomy_run_transitions (
  transition_id    TEXT PRIMARY KEY,
  autonomy_run_id  TEXT NOT NULL,
  seq              INTEGER NOT NULL CHECK (seq >= 1),
  from_state       TEXT,
  to_state         TEXT NOT NULL,
  event_json       TEXT NOT NULL,
  occurred_at      REAL NOT NULL,
  UNIQUE (autonomy_run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_autonomy_transitions_run
  ON autonomy_run_transitions(autonomy_run_id, seq);

CREATE TABLE IF NOT EXISTS autonomy_run_projection (
  autonomy_run_id       TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL,
  repo_id               TEXT NOT NULL,
  workspace_path        TEXT NOT NULL,
  state                 TEXT NOT NULL,
  revision              INTEGER NOT NULL CHECK (revision >= 1),
  contract_sha256       TEXT NOT NULL,
  diff_sha256           TEXT,
  preflight_risk_json   TEXT,
  post_diff_risk_json   TEXT,
  approval_json         TEXT,
  routing_json          TEXT,
  budget_json           TEXT NOT NULL,
  attempt_json          TEXT NOT NULL,
  candidate_proof_json  TEXT,
  git_delivery_json     TEXT,
  final_proof_json      TEXT,
  last_transition_id    TEXT NOT NULL REFERENCES autonomy_run_transitions(transition_id),
  created_at            REAL NOT NULL,
  updated_at            REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_autonomy_projection_repo_state
  ON autonomy_run_projection(repo_id, state, updated_at);
```

- [ ] Write tests proving:

- create writes transition seq `1` and projection revision `1` atomically;
- transition compare-and-swap rejects a stale revision;
- an illegal state name fails schema validation;
- replay of transitions reconstructs the projection state;
- reopening the database recovers a nonterminal run;
- terminal runs are excluded from resumable queries;
- approval, proof, and Git fields preserve strict JSON.

- [ ] Run:

```bash
pnpm --filter @osstack/core test -- autonomy-runs.test.ts db.test.ts
```

Expected: failure before migration/store implementation.

- [ ] Implement:

```ts
export function createAutonomyRun(...): AutonomyRunProjectionRow;
export function transitionAutonomyRun(...): AutonomyRunProjectionRow;
export function getAutonomyRun(...): AutonomyRunProjectionRow | undefined;
export function listResumableAutonomyRuns(...): AutonomyRunProjectionRow[];
export function listAutonomyTransitions(...): AutonomyRunTransitionRow[];
```

Every transition must append the immutable event and update the projection in one `withWrite` transaction.

- [ ] Run:

```bash
pnpm --filter @osstack/core test -- autonomy-runs.test.ts db.test.ts
pnpm --filter @osstack/core typecheck
```

Expected: all tests pass and `CURRENT_SCHEMA_VERSION` is `17`.

- [ ] Commit:

```bash
git add packages/core/src/state
git commit -m "feat(core): persist guarded autonomy transitions"
```

## Task 7: Implement the legal state machine and approval binding

**Files:**

- Create: `packages/autonomy/src/state-machine.ts`
- Create: `packages/autonomy/src/state-machine.test.ts`
- Create: `packages/autonomy/src/approval.ts`
- Create: `packages/autonomy/src/approval.test.ts`
- Modify: `packages/autonomy/src/index.ts`
- Test: legal transitions and digest invalidation

- [ ] Encode legal transitions:

```ts
export const LEGAL_TRANSITIONS: Record<AutonomyRunState, readonly AutonomyRunState[]> = {
  queued: ["classifying", "cancelled"],
  classifying: ["awaiting_approval", "blocked", "preparing", "completed", "escalated"],
  awaiting_approval: ["preparing", "cancelled", "escalated"],
  blocked: [],
  preparing: ["building", "escalated", "cancelled"],
  building: ["verifying", "escalated", "cancelled"],
  verifying: ["repairing", "reviewing", "escalated", "cancelled"],
  repairing: ["building", "escalated", "cancelled"],
  reviewing: ["repairing", "post_classifying", "escalated", "cancelled"],
  post_classifying: ["awaiting_approval", "blocked", "candidate_proof", "escalated"],
  candidate_proof: ["committing", "delivery_evidence_failed", "escalated"],
  committing: ["pushing", "blocked_delivery", "escalated"],
  pushing: ["opening_pr", "blocked_delivery", "escalated"],
  opening_pr: ["waiting_ci", "blocked_delivery", "escalated"],
  waiting_ci: ["merging", "repairing", "blocked_delivery", "escalated"],
  merging: ["final_proof", "blocked_delivery", "escalated"],
  final_proof: ["completed", "delivery_evidence_failed"],
  blocked_delivery: [],
  delivery_evidence_failed: [],
  escalated: [],
  cancelled: [],
  completed: [],
};
```

- [ ] Add tests proving:

- R0 can finish at `completed` from classification;
- R1/R2 cannot enter `awaiting_approval`;
- R3 must enter `awaiting_approval` before `preparing` or `candidate_proof`;
- R4 can only enter `blocked`;
- terminal states have no outbound transitions.

- [ ] Implement canonical digesting:

```ts
export function scopedApprovalDigest(input: {
  autonomy_run_id: string;
  contract_sha256: string;
  diff_sha256: string;
  action_scope: readonly string[];
}): string;
```

Sort `action_scope`, serialize a canonical object with no optional omissions, and hash with SHA-256.

- [ ] Add tests:

- action order does not change the digest;
- contract, diff, or action changes do change it;
- a human approval for the old diff is invalid after a post-diff change;
- agent actor is rejected;
- R4 cannot create a request.

- [ ] Run:

```bash
pnpm --filter @osstack/autonomy test -- state-machine.test.ts approval.test.ts
pnpm --filter @osstack/autonomy typecheck
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add packages/autonomy/src
git commit -m "feat(autonomy): enforce state and scoped approval gates"
```

## Task 8: Implement no-progress and repair budgets

**Files:**

- Create: `packages/autonomy/src/progress-budget.ts`
- Create: `packages/autonomy/src/progress-budget.test.ts`
- Modify: `packages/autonomy/src/index.ts`
- Modify: `packages/loop/src/iterator.ts`
- Modify: `packages/loop/src/iterator.test.ts`
- Test: repeated findings and unchanged results

- [ ] Add failing tests for:

- same finding fingerprints in consecutive rounds;
- unchanged changed-file digest and unchanged test results;
- same failed command repeated;
- acceptance score improvement resetting no-progress count;
- builder iteration, review round, wall time, and no-progress exhaustion.

- [ ] Implement:

```ts
export interface AttemptProgress {
  finding_fingerprints: string[];
  changed_files_sha256: string;
  verification_sha256: string;
  failed_commands: string[];
  acceptance_score: number;
}

export function compareAttemptProgress(
  previous: AttemptProgress,
  current: AttemptProgress,
): {
  improved: boolean;
  reasons: string[];
};
```

An attempt improves if any blocking fingerprint disappears, changed files plus verification changes, or acceptance score increases. Merely consuming more tokens is not improvement.

- [ ] Wire the result into the loop iterator so repeated Kimi findings stop at `max_no_progress_rounds` and produce `escalated`, preserving the worktree and evidence.

- [ ] Run:

```bash
pnpm --filter @osstack/autonomy test -- progress-budget.test.ts
pnpm --filter @osstack/loop test -- iterator.test.ts
pnpm --filter @osstack/autonomy typecheck
pnpm --filter @osstack/loop typecheck
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add packages/autonomy/src/progress-budget.ts \
  packages/autonomy/src/progress-budget.test.ts \
  packages/loop/src/iterator.ts packages/loop/src/iterator.test.ts
git commit -m "feat(loop): stop autonomous repair when progress stalls"
```

## Task 9: Add real GitHub delivery commands behind an injected runner

**Files:**

- Create: `packages/github/src/delivery.ts`
- Create: `packages/github/src/delivery.test.ts`
- Modify: `packages/github/src/index.ts`
- Test: push, PR, CI, merge, and failure paths

- [ ] Define:

```ts
export interface DeliveryCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DeliveryCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: { cwd: string; timeoutMs: number },
  ): Promise<DeliveryCommandResult>;
}

export interface GitHubDeliveryInput {
  workspacePath: string;
  remote: string;
  base: string;
  branch: string;
  title: string;
  bodyFile: string;
  mergeStrategy: "squash";
  ciTimeoutMs: number;
}
```

- [ ] Write fake-runner tests asserting exact argv:

```text
git push --set-upstream origin osstack/task-123
gh pr create --base main --head osstack/task-123 --title "feat: complete task-123" --body-file /tmp/osstack-pr-body-task-123.md
gh pr view osstack/task-123 --json number,url,headRefOid
gh pr checks 42 --watch --fail-fast
gh pr view 42 --json mergeable,mergeStateStatus,statusCheckRollup,url,headRefOid
gh pr merge 42 --squash --delete-branch
```

In the test source, use concrete title `feat: complete task-123` and a temporary absolute body path.

- [ ] Add failure tests:

- missing GitHub auth;
- push rejection;
- PR create malformed JSON/URL;
- CI failure;
- CI timeout;
- merge conflict;
- dirty base or wrong branch;
- attempted protected-branch push;
- any force-push argument.

- [ ] Run:

```bash
pnpm --filter @osstack/github test -- delivery.test.ts
```

Expected: failure before `delivery.ts` exists.

- [ ] Implement all subprocess execution with `execFile` or the injected runner and argv arrays. Never use `shell: true`. Treat successful `gh pr create` as creation acknowledgement, then resolve the PR with `gh pr view input.branch --json number,url,headRefOid`, substituting the exact validated `input.branch` as one argv element. Require exactly one result, require `headRefOid` to equal the pushed commit, and fail closed on missing or ambiguous metadata.

- [ ] Require:

- current branch equals `input.branch`;
- branch is not a protected branch;
- candidate proof body exists;
- CI is successful;
- merge state is `CLEAN` or equivalent mergeable success;
- head OID still equals the reviewed/pushed commit.

- [ ] Run:

```bash
pnpm --filter @osstack/github test -- delivery.test.ts
pnpm --filter @osstack/github typecheck
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add packages/github/src
git commit -m "feat(github): execute guarded PR and merge delivery"
```

## Task 10: Stage candidate and final proof packs

**Files:**

- Modify: `packages/cli/src/proof-pack.ts`
- Modify: `packages/cli/src/proof-pack.test.ts`
- Modify: `packages/cli/src/proof-cli.test.ts`
- Modify: `packages/cli/src/bin.ts`
- Test: stage, supersedes, and write-failure behavior

- [ ] Extend proof metadata:

```ts
export interface ProofStageInput {
  stage: "candidate" | "final";
  supersedes?: {
    manifest_path: string;
    manifest_sha256: string;
  };
  risk_evidence?: unknown;
  approval_evidence?: unknown;
  git_delivery_evidence?: unknown;
}
```

Manifest additions:

```ts
proof_stage: "candidate" | "final";
supersedes?: {
  manifest_path: string;
  manifest_sha256: string;
};
```

- [ ] Write failing tests:

- candidate proof has no `supersedes`;
- final proof requires and validates candidate manifest digest;
- risk and approval artifacts are checksummed;
- candidate write failure prevents the fake Git runner from being called;
- final write failure leaves state `delivery_evidence_failed`;
- proof validator rejects a wrong supersedes digest.

- [ ] Run:

```bash
pnpm --filter @osstack/cli test -- proof-pack.test.ts proof-cli.test.ts
```

Expected: staged-proof tests fail before implementation.

- [ ] Add exact artifact names:

```text
risk-preflight.json
risk-post-diff.json
approval-request.json
approval-decision.json
git-delivery.json
```

Omit approval files when no approval exists; do not write empty authority claims.

- [ ] Update proof manifest validation allowlists and release proof checks for the new stage fields.

- [ ] Run:

```bash
pnpm --filter @osstack/cli test -- proof-pack.test.ts proof-cli.test.ts release-workflow.test.ts
pnpm --filter @osstack/cli typecheck
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add packages/cli/src
git commit -m "feat(proof): split candidate and final delivery evidence"
```

## Task 11: Implement the guarded Git delivery engine

**Files:**

- Create: `packages/autonomy/src/engine.ts`
- Create: `packages/autonomy/src/engine.test.ts`
- Modify: `packages/autonomy/package.json`
- Modify: `packages/autonomy/src/index.ts`
- Modify: `pnpm-lock.yaml`
- Test: stateful orchestration with injected ports

- [ ] Add `@osstack/github: workspace:*` to autonomy dependencies.

- [ ] Define injected ports:

```ts
export interface GuardedDeliveryPorts {
  now(): Date;
  persist(event: AutonomyTransitionInput): Promise<AutonomyRunProjection>;
  runLocal(input: {
    workspacePath: string;
    routing: unknown;
    budget: DeliveryBudget;
  }): Promise<LocalDeliveryResult>;
  writeCandidateProof(input: CandidateProofInput): Promise<ProofReference>;
  writeFinalProof(input: FinalProofInput): Promise<ProofReference>;
  commit(input: CommitInput): Promise<{ commit: string }>;
  deliverGit(input: GitHubDeliveryInput): Promise<GitHubDeliveryResult>;
}
```

- [ ] Write engine tests covering:

1. R0 returns completed without a write port call;
2. R1 happy path reaches completed;
3. R2 requires provider-or-model independence;
4. R3 preflight returns `needs_approval` before local execution;
5. approved R3 resumes only with matching request digest;
6. post-diff R3 pauses before candidate proof/commit;
7. changed diff invalidates approval;
8. R4 returns blocked and never creates an approval request;
9. deterministic/Kimi failure enters repair, then succeeds within budget;
10. budget exhaustion preserves worktree and escalates;
11. candidate proof failure prevents commit/push;
12. Git failure becomes `blocked_delivery`;
13. final proof failure becomes `delivery_evidence_failed`;
14. every port call occurs only after its state transition was persisted.

- [ ] Run:

```bash
pnpm --filter @osstack/autonomy test -- engine.test.ts
```

Expected: failure because the engine is missing.

- [ ] Implement:

```ts
export class GuardedDeliveryEngine {
  constructor(
    private readonly policy: GuardedDeliveryPolicy,
    private readonly ports: GuardedDeliveryPorts,
  ) {}

  async start(intent: AutonomyTaskIntent): Promise<GuardedDeliveryResult>;
  async resume(
    autonomyRunId: string,
    decision: ScopedApprovalDecision,
  ): Promise<GuardedDeliveryResult>;
}
```

Persist the target state before calling its corresponding side-effect port. Treat an unknown recovered step as an escalation, not a restart from the beginning.

- [ ] Run:

```bash
pnpm install --frozen-lockfile=false
pnpm --filter @osstack/autonomy test -- engine.test.ts
pnpm --filter @osstack/autonomy typecheck
```

Expected: all engine tests pass.

- [ ] Commit:

```bash
git add packages/autonomy pnpm-lock.yaml
git commit -m "feat(autonomy): orchestrate guarded Git delivery"
```

## Task 12: Add CLI approval and resume controls

**Files:**

- Create: `packages/cli/src/autonomy-command.ts`
- Create: `packages/cli/src/autonomy-cli.test.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `packages/cli/src/cockpit-tui.ts`
- Modify: `packages/cli/src/cockpit-tui.test.ts`
- Test: status, approve, reject, resume, and R4 denial

- [ ] Add commands:

```text
osstack autonomy list [--repo ID] [--json]
osstack autonomy status run_123 [--json]
osstack autonomy approve run_123 --actor human:owner --reason "Reviewed scoped change" [--json]
osstack autonomy reject run_123 --actor human:owner --reason "Scope is too broad" [--json]
osstack autonomy resume run_123 [--json]
```

- [ ] Add failing tests:

- status shows risk signals, contract/diff digests, requested actions, proof and Git state;
- approve rejects `agent:*`;
- approve rejects non-R3 state;
- approve rejects a stale request digest;
- R4 status exposes no approve next action;
- resume before approval is blocked;
- approval and decision are append-only evidence;
- JSON uses protocol status `needs_approval`, `blocked`, or `completed`.

- [ ] Run:

```bash
pnpm --filter @osstack/cli test -- autonomy-cli.test.ts cockpit-tui.test.ts
```

Expected: command tests fail before implementation.

- [ ] Implement the command against `@osstack/core` autonomy stores and `@osstack/autonomy` approval validation. Approval records authority only; `autonomy resume` performs subsequent work so the Owner’s action and execution are separately auditable.

- [ ] Add cockpit fields:

```text
autonomy_run_id
state
risk
approval_status
candidate_proof
pr_url
last_transition
```

- [ ] Run:

```bash
pnpm --filter @osstack/cli test -- autonomy-cli.test.ts cockpit-tui.test.ts
pnpm --filter @osstack/cli typecheck
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add packages/cli/src
git commit -m "feat(cli): control high-risk autonomy approvals"
```

## Task 13: Wire guarded-git into `deliver`

**Files:**

- Modify: `packages/cli/src/deliver-command.ts`
- Modify: `packages/cli/src/deliver-cli.test.ts`
- Modify: `packages/cli/src/daemon.ts`
- Modify: `packages/cli/src/daemon-loop.test.ts`
- Modify: `packages/cli/package.json`
- Modify: `pnpm-lock.yaml`
- Test: local and daemon guarded-git end to end

- [ ] Add `guarded-git` to `DeliverAutonomyMode`.

- [ ] Compose ports:

- local port calls the existing guarded-local loop path;
- persistence port uses the core autonomy store;
- proof ports call staged proof pack writer;
- commit port uses `commitWorktreeChanges`;
- Git port uses `@osstack/github` delivery;
- runtime identity comes from profile routing.

- [ ] Add failing tests:

- R1 docs fixture reaches merged/final proof;
- R2 source fixture reaches merged/final proof;
- R3 auth fixture exits `2` with `needs_approval` before Builder invoke;
- post-diff policy change exits `2` before commit;
- R4 destructive fixture exits `2` with no approval action;
- no remote produces `blocked_delivery`, not completed;
- daemon restart resumes from persisted step without duplicating a PR.

- [ ] Run:

```bash
pnpm --filter @osstack/cli test -- deliver-cli.test.ts daemon-loop.test.ts
```

Expected: guarded-git tests fail before wiring.

- [ ] Add `@osstack/autonomy: workspace:*` to the CLI package. Use an idempotency key for each external action:

```text
`${autonomyRunId}:commit:${diffSha}`
`${autonomyRunId}:push:${commitSha}`
`${autonomyRunId}:pr:${commitSha}`
`${autonomyRunId}:merge:${prNumber}:${headSha}`
```

Before repeating an action after restart, inspect Git/GitHub state and record the existing result instead of issuing a duplicate write.

- [ ] Run:

```bash
pnpm install --frozen-lockfile=false
pnpm --filter @osstack/cli test -- deliver-cli.test.ts daemon-loop.test.ts
pnpm --filter @osstack/cli typecheck
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add packages/cli packages/autonomy pnpm-lock.yaml
git commit -m "feat(deliver): enable guarded Git autonomy"
```

## Task 14: Add end-to-end fixture repositories and fault injection

**Files:**

- Create: `fixtures/autonomy/r1-docs/`
- Create: `fixtures/autonomy/r2-typescript/`
- Create: `fixtures/autonomy/r3-auth/`
- Create: `fixtures/autonomy/r4-destructive/`
- Create: `scripts/smoke-guarded-git.mjs`
- Modify: `package.json`
- Test: fake Kimi, fake GitHub, restart recovery

- [ ] Each fixture must contain:

```text
.osstack/repo.yaml
.osstack/policy.yaml
package.json
src/
test/
tasks/
```

Use harmless local Git repositories and a fake command runner; no real GitHub repository is touched by automated tests.

- [ ] Add root script:

```json
"smoke:guarded-git": "pnpm --filter @osstack/cli build && node scripts/smoke-guarded-git.mjs"
```

- [ ] The smoke script must assert:

- R1 and R2 pass;
- R3 waits;
- R4 blocks;
- candidate proof precedes push in transition sequence;
- final proof follows merge;
- a killed daemon resumes without duplicate action ids.

- [ ] Run:

```bash
pnpm smoke:guarded-git
```

Expected: exit `0` and a summary showing all four risk fixtures passed their expected outcomes.

- [ ] Commit:

```bash
git add fixtures/autonomy scripts/smoke-guarded-git.mjs package.json
git commit -m "test(e2e): cover guarded Git autonomy"
```

## Task 15: Documentation, changesets, and Phase C pull request

**Files:**

- Create: `.changeset/guarded-git-autonomy.md`
- Create: `docs/runbooks/guarded-git-autonomy.md`
- Modify: `README.md`
- Modify: `docs/product/12_RUNBOOK.md`
- Modify: package changelogs for protocol, core, autonomy, github, and CLI

- [ ] Add changeset:

```markdown
---
"@osstack/protocol": minor
"@osstack/core": minor
"@osstack/autonomy": minor
"@osstack/github": minor
"@osstack/cli": minor
---

Add durable R0-R4 guarded autonomy and automated R1/R2 GitHub delivery.
```

- [ ] Document:

- exact risk levels and action matrix;
- approval digest semantics;
- recovery from `blocked_delivery`;
- proof-stage semantics;
- GitHub authentication prerequisites;
- why R4 cannot be approved;
- how to roll back to `--autonomy guarded-local`.

- [ ] Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:guarded-git
git diff --check
git status --short
```

Expected: all commands pass and worktree is clean.

- [ ] Push and open:

```bash
git push -u origin feat/guarded-git-autonomy
gh pr create \
  --base main \
  --head feat/guarded-git-autonomy \
  --title "feat: add R0-R4 guarded Git autonomy" \
  --body "Implements P4: deterministic pre/post risk, scoped human approval for R3, permanent R4 blocking, staged proof, and R1/R2 PR/CI/merge automation."
```

Expected: a PR URL. Plan D begins only after CI is green and this PR is merged.

---

## v3 mandatory amendments

### C.1 State machine and two-stage approval

Add a legal `awaiting_approval -> candidate_proof` transition only when the
signed post-diff decision matches the current run, contract digest, staged diff
digest, action scope, nonce, and expiry. Resume must not call Builder again.

Preflight approval binds the empty-diff sentinel and authorizes build/verify
only. Commit, push, PR, merge, and deploy require the post-diff decision.

Required red test:

```text
resumes approved post-diff RISK-R3 directly at candidate proof without runLocal
```

### C.2 Production human decisions

`process.stdin.isTTY` is UX, not authentication; a same-user process can create
a pseudo-terminal. Production RISK-R3 approval and freeze-clear use a signed
decision issued outside the Builder/Reviewer trust domain. The daemon stores
only the verification public key. The signed payload binds:

```text
run_id
contract_sha256
diff_sha256
action_scope
decision
nonce
issued_at
expires_at
```

Reject invalid signatures, replayed nonces, expired decisions, mismatched
digests, and mismatched scope. TTY approval may exist only as an explicitly
reported development/break-glass mode and cannot authorize production.
Governance denies `osstack autonomy approve|reject|freeze clear` to Builder and
Reviewer.

### C.3 Authoritative staged diff

On a dedicated clean implementation worktree:

1. run `git add -A`;
2. collect `git diff --cached --binary` and `git status --porcelain=v1 -z`;
3. compute risk, approval digest, and candidate proof from that exact material;
4. recompute immediately before commit;
5. on mismatch, persist evidence and transition to `escalated`.

Untracked files must be present in risk and proof. Add a test where an untracked
auth file becomes RISK-R3 and cannot be auto-merged.

Read governing repository policy from the base commit with
`git show <base>:.osstack/repo.yaml`; the builder worktree cannot weaken its own
policy.

### C.4 GitHub protection and merge atomicity

`@osstack/github` checks effective protection from both legacy branch
protection and applicable repository rulesets. Absent/ambiguous/unauthorized
protection metadata fails closed. At least one required check must apply to the
current pushed SHA; zero checks is failure.

Merge uses:

```text
gh pr merge --squash --match-head-commit <pushedSha>
```

Never use `--admin`. Re-read PR head evidence immediately before merge. Add
tests for ruleset-only protection, no protection, unauthorized lookup, zero
checks, stale-SHA checks, changed PR head, and current-SHA success.

### C.5 Scope, recovery, and idempotency

- Check `action_scope` membership immediately before every external write.
- Link autonomy approval decisions to `contract_approval_decisions` audit rows.
- Map human-readable `needs_approval` to protocol status `"n"` with non-empty
  `required_approvals`.
- Make `opening_pr` idempotent by reusing an existing PR for the same head.
- Add bounded retry for push/PR/check polling and a legal, state-verified resume
  from `blocked_delivery`; do not retry policy, digest, or permission failures.
- Move the per-repository single-writer constraint into migration 17.
- Validate generated branch names with `git check-ref-format`.
- SIGKILL tests must use actual abrupt process termination.
- Task 8 adds the required `packages/loop/package.json` dependency.

### C.6 Risk rules and child environment

RISK-R3 covers `.env` and `.env.*`, SQL DDL, `sudo`/privilege escalation, new
network destinations, effective policy files, referenced deployment scripts,
and—when osstack is the target—risk, approval, and state-machine source files.
LLM output is structurally absent from risk inputs.

All Builder/Reviewer child environments come from a minimal allowlist and
exclude approval, notification, CI, and unrelated parent secrets.

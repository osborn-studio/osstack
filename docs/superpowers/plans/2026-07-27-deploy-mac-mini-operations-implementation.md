# Guarded Deploy and Mac Mini Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add project-allowlisted staging/production deployment with automatic health verification, rollback, and freeze, then make the guarded delivery service reliable for 24×7 Mac Mini operation.

**Architecture:** Keep deployment as a second gated side-effect stage after merge. Resolve repository and private machine policy to the stricter result, execute only argv-array project commands, persist deploy/rollback state, and freeze production automation after any unhealthy release. Extend the existing daemon, launchd management, repo registry, restart recovery, and cockpit instead of creating a second service.

**Tech Stack:** TypeScript ESM, Zod, Vitest, SQLite, Node subprocesses, launchd, Unix sockets, GitHub delivery evidence, osstack daemon and proof packs.

> **v3 execution amendment.** This plan is executable only together with
> `2026-07-27-kimi-autonomy-execution-control-v3.md` and ledger items D-01
> through D-04 plus X-03/X-07. The amendment section at the end of this file
> overrides conflicting task text.

**Execution hosts:** deterministic package and fake-runner work may run on any
development host. launchd, power-policy evidence, real rollback drills,
notifications, and the seven-day soak run only on the registered Mac Mini.

---

## Task 1: Create the Phase D worktree

**Files:**

- Verify Phase C baseline only

- [ ] Create:

```bash
git fetch origin --prune
: "${OSSTACK_WORKTREES_ROOT:=$HOME/Developer/worktrees}"
mkdir -p "$OSSTACK_WORKTREES_ROOT"
git worktree add -b feat/guarded-deploy-operations \
  "$OSSTACK_WORKTREES_ROOT/osstack-guarded-deploy-operations" \
  origin/main
cd "$OSSTACK_WORKTREES_ROOT/osstack-guarded-deploy-operations"
corepack enable pnpm
pnpm install --frozen-lockfile
mkdir -p "$PWD/.tmp/osstack-dev-home"
export OSSTACK_HOME="$PWD/.tmp/osstack-dev-home"
export OSSTACK_SOCKET="$OSSTACK_HOME/daemon.sock"
```

- [ ] Verify:

```bash
rg -n 'class GuardedDeliveryEngine' packages/autonomy/src/engine.ts
rg -n 'guarded-git' packages/cli/src/deliver-command.ts
pnpm --filter @osstack/autonomy test -- engine.test.ts
pnpm smoke:guarded-git
```

Expected: the guarded Git baseline is present and green.

## Task 2: Lock the deploy policy schema and stricter private overlay

**Files:**

- Modify: `packages/core/src/policy/profile.ts`
- Modify: `packages/core/src/policy/profile.test.ts`
- Modify: `docs/specs/schemas/repo-config.schema.json`
- Create: `packages/autonomy/src/repo-policy.ts`
- Create: `packages/autonomy/src/repo-policy.test.ts`
- Modify: `packages/autonomy/src/index.ts`
- Test: allowlist/denylist and stricter merge

- [ ] Define the v2 deploy schema exactly:

```ts
export const CommandArgv = z.array(z.string()).min(1).max(64);

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

Commands are argv arrays. Never accept a shell string in v2 automatic deployment.

- [ ] Write failing tests for:

- valid staging and production policy;
- empty rollback/health command rejected;
- credential-looking config values rejected;
- allowed/forbidden overlap rejected;
- production enabled without an allowed base branch rejected;
- a v1 `staging_command` remains readable but is never auto-executed.

- [ ] Add private overlay loading from:

```text
$OSSTACK_HOME/repos/example-web.yaml
```

The private file uses the same strict nested shapes but may omit fields. It must not contain credentials.

- [ ] Implement stricter merge rules:

| Field | Merge |
|---|---|
| `enabled` | logical AND |
| allowed paths/change types/base branches | intersection |
| forbidden paths | union |
| timeouts | smaller value |
| freeze windows | union |
| commands | repository command unless private overlay disables the target |
| `max_auto_risk` | lower risk |

An empty allowed intersection disables automatic deployment. A private overlay cannot introduce a new command or widen authority.

- [ ] Run:

```bash
pnpm --filter @osstack/core test -- profile.test.ts
pnpm --filter @osstack/autonomy test -- repo-policy.test.ts
pnpm --filter @osstack/core typecheck
pnpm --filter @osstack/autonomy typecheck
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add packages/core/src/policy packages/autonomy/src \
  docs/specs/schemas/repo-config.schema.json
git commit -m "feat(policy): define strict project deploy allowlists"
```

## Task 3: Evaluate deployment eligibility deterministically

**Files:**

- Create: `packages/autonomy/src/deploy-policy.ts`
- Create: `packages/autonomy/src/deploy-policy.test.ts`
- Modify: `packages/autonomy/src/index.ts`
- Test: every gate and freeze window

- [ ] Define:

```ts
export interface DeployEligibilityInput {
  target: "staging" | "production";
  base_branch: string;
  change_types: string[];
  changed_paths: string[];
  final_risk: AutonomyRiskLevel;
  deterministic_pass: boolean;
  kimi_pass: boolean;
  governance_pass: boolean;
  ci_pass: boolean;
  candidate_proof_sha256: string;
  rollback_drill_passed_at?: string;
  now: Date;
}

export interface DeployEligibilityDecision {
  allowed: boolean;
  reasons: string[];
  requires_approval: boolean;
}
```

- [ ] Write table tests:

- disabled target denies;
- base branch outside allowlist denies;
- any forbidden path denies automatic deployment and escalates R3;
- path outside allowed paths denies;
- change type outside allowlist denies;
- R3 requires approval;
- R4 denies permanently;
- failed test/Kimi/governance/CI/proof denies;
- missing rollback drill denies production;
- active freeze window denies production;
- R1/R2 allowlisted change allows;
- staging can have a broader policy but never bypass R3/R4.

- [ ] Run:

```bash
pnpm --filter @osstack/autonomy test -- deploy-policy.test.ts
```

Expected: failure before implementation.

- [ ] Implement policy evaluation as a pure function. It must return every failed reason, not only the first, and must never call an LLM.

- [ ] Run:

```bash
pnpm --filter @osstack/autonomy test -- deploy-policy.test.ts
pnpm --filter @osstack/autonomy typecheck
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add packages/autonomy/src/deploy-policy.ts \
  packages/autonomy/src/deploy-policy.test.ts \
  packages/autonomy/src/index.ts
git commit -m "feat(autonomy): gate deployment by project policy"
```

## Task 4: Add deploy/rollback persistence and production freeze

**Files:**

- Modify: `packages/protocol/src/autonomy.ts`
- Modify: `packages/protocol/src/autonomy.test.ts`
- Regenerate: `packages/protocol/schemas/`
- Modify: `packages/core/src/state/migrations.ts`
- Modify: `packages/core/src/state/schema.ts`
- Create: `packages/core/src/state/deploy-freezes.ts`
- Create: `packages/core/src/state/deploy-freezes.test.ts`
- Modify: `packages/core/src/state/autonomy-runs.ts`
- Modify: `packages/core/src/state/autonomy-runs.test.ts`
- Modify: `packages/core/src/state/index.ts`
- Test: state extension, freeze, and recovery

- [ ] Extend autonomy states:

```text
deploying_staging
verifying_staging
deploying_production
health_checking
rolling_back
deploy_frozen
```

Legal flow after merge:

```text
merging
-> deploying_staging
-> verifying_staging
-> deploying_production
-> health_checking
-> final_proof
```

Failure flow:

```text
deploying_production|health_checking
-> rolling_back
-> deploy_frozen
-> final_proof
```

Rollback failure transitions to `escalated`.

- [ ] Add migration `18`:

```sql
ALTER TABLE autonomy_run_projection ADD COLUMN deploy_json TEXT;
ALTER TABLE autonomy_run_projection ADD COLUMN rollback_json TEXT;

CREATE TABLE IF NOT EXISTS autonomy_deploy_freezes (
  repo_id          TEXT NOT NULL,
  target           TEXT NOT NULL CHECK (target IN ('production')),
  frozen           INTEGER NOT NULL CHECK (frozen IN (0,1)),
  reason           TEXT NOT NULL,
  source_run_id    TEXT NOT NULL,
  frozen_at        REAL NOT NULL,
  cleared_at       REAL,
  cleared_by_type  TEXT,
  cleared_by_id    TEXT,
  clear_reason     TEXT,
  PRIMARY KEY (repo_id, target)
);
```

- [ ] Write tests:

- unhealthy production creates/updates freeze;
- subsequent production eligibility observes freeze;
- staging remains eligible while production is frozen;
- only `human:*` can clear;
- clear is audited with reason;
- rollback evidence persists through restart;
- resume never repeats a successful deploy command.

- [ ] Run:

```bash
pnpm --filter @osstack/protocol test -- autonomy.test.ts
pnpm --filter @osstack/core test -- deploy-freezes.test.ts autonomy-runs.test.ts db.test.ts
```

Expected: tests fail before schema/migration implementation.

- [ ] Implement and regenerate schemas:

```bash
pnpm --filter @osstack/protocol generate:schemas
pnpm --filter @osstack/protocol check:schemas
pnpm --filter @osstack/protocol typecheck
pnpm --filter @osstack/core typecheck
```

Expected: all commands pass and `CURRENT_SCHEMA_VERSION` is `18`.

- [ ] Commit:

```bash
git add packages/protocol packages/core/src/state
git commit -m "feat(core): persist deploy rollback and freeze state"
```

## Task 5: Implement the project-command deploy adapter

**Files:**

- Create: `packages/autonomy/src/deploy-runner.ts`
- Create: `packages/autonomy/src/deploy-runner.test.ts`
- Modify: `packages/autonomy/src/index.ts`
- Test: success, timeout, health failure, rollback, cancellation

- [ ] Define:

```ts
export interface DeployCommandEvidence {
  argv: string[];
  exit_code: number;
  duration_ms: number;
  stdout_summary: string;
  stderr_summary: string;
  timed_out: boolean;
}

export interface ProjectDeployResult {
  target: "staging" | "production";
  deploy: DeployCommandEvidence;
  verify?: DeployCommandEvidence;
  health?: DeployCommandEvidence;
  rollback?: DeployCommandEvidence;
  outcome:
    | "healthy"
    | "deploy_failed"
    | "verify_failed"
    | "health_failed_rolled_back"
    | "rollback_failed"
    | "cancelled";
}
```

- [ ] Add fake-binary tests:

- staging deploy + verify success;
- production deploy + health success;
- deploy timeout;
- health timeout invokes rollback exactly once;
- health non-zero invokes rollback;
- rollback success yields `health_failed_rolled_back`;
- rollback failure yields `rollback_failed`;
- AbortSignal stops the child;
- stdout/stderr limits apply;
- argv is passed without shell expansion;
- environment evidence never includes full environment variables.

- [ ] Run:

```bash
pnpm --filter @osstack/autonomy test -- deploy-runner.test.ts
```

Expected: failure before implementation.

- [ ] Implement with:

```ts
spawn(argv[0], argv.slice(1), {
  cwd: workspacePath,
  env: { ...process.env },
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
});
```

Run order:

```text
command -> verify_command -> health_check
```

On production verify/health failure:

```text
rollback -> health_check
```

The post-rollback health result must be recorded separately. Do not mark rollback successful only because the rollback command exited `0`.

- [ ] Run:

```bash
pnpm --filter @osstack/autonomy test -- deploy-runner.test.ts
pnpm --filter @osstack/autonomy typecheck
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add packages/autonomy/src/deploy-runner.ts \
  packages/autonomy/src/deploy-runner.test.ts \
  packages/autonomy/src/index.ts
git commit -m "feat(autonomy): execute health-checked project deployment"
```

## Task 6: Integrate guarded-deploy after merge

**Files:**

- Modify: `packages/autonomy/src/engine.ts`
- Modify: `packages/autonomy/src/engine.test.ts`
- Modify: `packages/cli/src/deliver-command.ts`
- Modify: `packages/cli/src/deliver-cli.test.ts`
- Modify: `packages/cli/src/proof-pack.ts`
- Modify: `packages/cli/src/proof-pack.test.ts`
- Test: staging, production, rollback, final proof

- [ ] Add `guarded-deploy` to the CLI autonomy enum and `--deploy-policy project`.

- [ ] Add engine ports:

```ts
evaluateDeploy(input: DeployEligibilityInput): DeployEligibilityDecision;
deploy(input: ProjectDeployInput): Promise<ProjectDeployResult>;
freezeProduction(input: DeployFreezeInput): Promise<void>;
```

- [ ] Write failing tests:

1. no deploy config completes after Git final proof;
2. staging-only config deploys and verifies;
3. production-eligible R2 deploys after staging;
4. R3 requires matching deploy action approval;
5. denylisted change never calls deploy;
6. health failure rolls back and freezes;
7. rollback health failure escalates;
8. active freeze skips production but allows staging;
9. final proof includes deploy and rollback evidence;
10. final proof failure prevents completed state.

- [ ] Run:

```bash
pnpm --filter @osstack/autonomy test -- engine.test.ts
pnpm --filter @osstack/cli test -- deliver-cli.test.ts proof-pack.test.ts
```

Expected: new deploy tests fail before integration.

- [ ] Add proof artifacts:

```text
deploy-eligibility.json
deploy-staging.json
deploy-production.json
rollback.json
production-freeze.json
```

Only write artifacts for stages actually attempted. Final proof’s run outcome must distinguish healthy deploy, successful rollback, and failed rollback.

- [ ] Run:

```bash
pnpm --filter @osstack/autonomy test -- engine.test.ts
pnpm --filter @osstack/cli test -- deliver-cli.test.ts proof-pack.test.ts
pnpm --filter @osstack/autonomy typecheck
pnpm --filter @osstack/cli typecheck
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add packages/autonomy/src packages/cli/src
git commit -m "feat(deliver): add allowlisted deploy and automatic rollback"
```

## Task 7: Add production freeze controls to the CLI and cockpit

**Files:**

- Modify: `packages/cli/src/autonomy-command.ts`
- Modify: `packages/cli/src/autonomy-cli.test.ts`
- Modify: `packages/cli/src/cockpit-tui.ts`
- Modify: `packages/cli/src/cockpit-tui.test.ts`
- Test: list, clear, and authority

- [ ] Add:

```text
osstack autonomy freeze list [--repo ID] [--json]
osstack autonomy freeze clear example-web \
  --actor human:owner \
  --reason "Rollback verified and incident closed" \
  [--json]
```

- [ ] Tests must prove:

- freeze reason and source run are visible;
- clearing requires human actor and a non-empty reason;
- an agent cannot clear;
- clearing does not rerun a failed deployment;
- next production run performs all gates again;
- freeze history remains reconstructable from run transitions and the current freeze row.

- [ ] Run:

```bash
pnpm --filter @osstack/cli test -- autonomy-cli.test.ts cockpit-tui.test.ts
```

Expected: all tests pass after implementation.

- [ ] Commit:

```bash
git add packages/cli/src
git commit -m "feat(cli): manage production autonomy freezes"
```

## Task 8: Add per-repository locking and machine concurrency limits

**Files:**

- Create: `packages/autonomy/src/repo-lock.ts`
- Create: `packages/autonomy/src/repo-lock.test.ts`
- Create: `packages/autonomy/src/semaphore.ts`
- Create: `packages/autonomy/src/semaphore.test.ts`
- Modify: `packages/autonomy/src/index.ts`
- Modify: `packages/cli/src/daemon.ts`
- Modify: `packages/cli/src/daemon-loop.test.ts`
- Test: lock ownership, stale recovery, and queueing

- [ ] Implement lock files under:

```text
$OSSTACK_HOME/locks/repos/example-web.lock
```

Lock JSON:

```ts
{
  pid: number;
  autonomy_run_id: string;
  repo_id: string;
  acquired_at: string;
}
```

- [ ] Write tests:

- only one writer per repo;
- readers do not acquire a write lock;
- a live PID lock cannot be stolen;
- a dead PID stale lock can be recovered with an audit event;
- release checks ownership before unlink;
- path traversal in repo id is sanitized;
- all-machine write semaphore defaults to two;
- queued runs preserve FIFO order;
- cancellation removes a queued waiter.

- [ ] Run:

```bash
pnpm --filter @osstack/autonomy test -- repo-lock.test.ts semaphore.test.ts
```

Expected: failure before modules exist.

- [ ] Integrate daemon defaults:

```text
per-repository concurrent writes: 1
whole-machine concurrent writes: 2
unbounded read-only jobs: no; use a separate configurable limit of 8
```

Persist queued state before waiting. On restart, reacquire only after verifying the recorded PID is gone and the previous run is resumable.

- [ ] Run:

```bash
pnpm --filter @osstack/autonomy test -- repo-lock.test.ts semaphore.test.ts
pnpm --filter @osstack/cli test -- daemon-loop.test.ts
pnpm --filter @osstack/autonomy typecheck
pnpm --filter @osstack/cli typecheck
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add packages/autonomy/src packages/cli/src/daemon.ts \
  packages/cli/src/daemon-loop.test.ts
git commit -m "feat(daemon): serialize guarded repository writes"
```

## Task 9: Add network/offline recovery and operational health

**Files:**

- Create: `packages/cli/src/autonomy-health.ts`
- Create: `packages/cli/src/autonomy-health.test.ts`
- Modify: `packages/cli/src/daemon.ts`
- Modify: `packages/cli/src/daemon.test.ts`
- Modify: `packages/cli/src/control-plane-doctor.ts`
- Modify: `packages/cli/src/control-plane-doctor.test.ts`
- Test: network, disk, agents, GitHub, deploy endpoints

- [ ] Define health checks:

```text
state_db
daemon_socket
disk_free
repo_registry
repo_locks
kimi_code
builder_agents
github_auth
github_network
deploy_freezes
resumable_runs
proof_failures
```

- [ ] Add tests:

- network unavailable keeps local build/verify running but queues push/deploy;
- network recovery resumes from persisted external step;
- Kimi unavailable blocks merge;
- disk below 5 GiB stops new write runs;
- disk below 2 GiB requests daemon drain;
- stale socket is removed only when no live daemon owns the PID;
- GitHub auth failure produces `external_blocker`;
- a deploy endpoint failure does not bypass health checks.

- [ ] Run:

```bash
pnpm --filter @osstack/cli test -- autonomy-health.test.ts daemon.test.ts control-plane-doctor.test.ts
```

Expected: health tests fail before implementation.

- [ ] Add:

```text
osstack autonomy health [--json]
```

Return overall `ok`, per-check status, active freezes, blocked/escalated runs, and next actions. Never print credential values.

- [ ] On daemon startup and network recovery:

1. re-probe adapters;
2. re-check GitHub auth/network;
3. inspect deploy freezes;
4. list resumable runs;
5. resume only idempotent steps.

- [ ] Run:

```bash
pnpm --filter @osstack/cli test -- autonomy-health.test.ts daemon.test.ts control-plane-doctor.test.ts
pnpm --filter @osstack/cli typecheck
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add packages/cli/src
git commit -m "feat(daemon): recover guarded runs after external outages"
```

## Task 10: Harden launchd installation for Mac Mini operation

**Files:**

- Modify: `packages/cli/src/bin.ts`
- Modify: `packages/cli/src/serve-install-cli.test.ts`
- Modify: `packages/cli/launchd/ai.osstack.daemon.plist.template`
- Modify: `packages/cli/launchd/ai.osstack.autoupgrade.plist.template`
- Modify: `packages/cli/launchd/install.sh`
- Modify: `packages/cli/launchd/install-autoupgrade.sh`
- Test: rendered plist and safe stable-serving path

- [ ] Extend `osstack serve --install` with:

```text
--profile mac-mini
--write-concurrency 2
--read-concurrency 8
```

Render these non-secret variables:

```text
OSSTACK_AGENT_PROFILE=mac-mini
OSSTACK_WRITE_CONCURRENCY=2
OSSTACK_READ_CONCURRENCY=8
```

Keep Kimi credentials out of the plist; the CLI reuses its own local login.

- [ ] Tests must prove:

- plist uses an absolute stable-serving binary;
- default development `dist/bin.js` is rejected unless explicitly provisioned as stable-serving;
- `OSSTACK_HOME`, socket, logs, and profile are exact;
- PATH includes Homebrew, system paths, and the user’s `.local/bin`;
- KeepAlive restarts only after non-zero exit;
- logs are under `OSSTACK_HOME/logs`;
- install status reports the effective profile and concurrency;
- upgrade drains active runs, snapshots `state.db`, health-checks, and restores the previous binary/database on failure.

- [ ] Run:

```bash
pnpm --filter @osstack/cli test -- serve-install-cli.test.ts control-plane-guard.test.ts
```

Expected: all tests pass after changes.

- [ ] Commit:

```bash
git add packages/cli/src packages/cli/launchd
git commit -m "feat(ops): provision guarded Mac Mini launchd service"
```

## Task 11: Add daily/weekly scorecards and Owner attention queues

**Files:**

- Create: `packages/cli/src/autonomy-scorecard.ts`
- Create: `packages/cli/src/autonomy-scorecard.test.ts`
- Modify: `packages/cli/src/daily-command.ts`
- Modify: `packages/cli/src/daily-cli.test.ts`
- Modify: `packages/cli/src/dashboard.ts`
- Modify: `packages/cli/src/dashboard.test.ts`
- Test: metrics and attention-only reporting

- [ ] Compute:

```text
unattended_completion_rate
human_intervention_rate
mean_builder_iterations
mean_review_rounds
repeated_finding_count
reviewer_mutation_count
unauthorized_action_count
proof_integrity_failure_count
restart_recovery_rate
deploy_success_rate
rollback_success_rate
active_freeze_count
```

- [ ] Tests must use persisted autonomy runs and verify exact denominators. Do not count R3 Owner approval as an avoidable intervention.

- [ ] Add attention sections:

```text
awaiting_approval
escalated
blocked_delivery
delivery_evidence_failed
production_frozen
rollback_failed
adapter_unavailable
```

- [ ] Run:

```bash
pnpm --filter @osstack/cli test -- autonomy-scorecard.test.ts daily-cli.test.ts dashboard.test.ts
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add packages/cli/src
git commit -m "feat(ops): report guarded autonomy reliability"
```

## Task 12: Build the fault-injection and 7-day soak harness

**Files:**

- Create: `scripts/soak-kimi-autonomy.mjs`
- Create: `scripts/soak-kimi-autonomy.test.mjs`
- Create: `fixtures/autonomy/r2-deploy/`
- Modify: `package.json`
- Test: deterministic dry soak, report validation, and real Mac Mini mode

- [ ] The deploy fixture must contain fake staging, production, health, and rollback executables. It must never contact a real deployment target.

- [ ] Add root scripts:

```json
"test:soak-kimi-autonomy": "node --test scripts/soak-kimi-autonomy.test.mjs",
"soak:kimi-autonomy": "node scripts/soak-kimi-autonomy.mjs --duration-days 7 --min-tasks 30"
```

- [ ] The harness records:

```ts
{
  schema_version: 1;
  started_at: string;
  ended_at: string;
  repos: string[];
  task_count: number;
  risk_counts: Record<string, number>;
  outcomes: Record<string, number>;
  daemon_restarts: number;
  network_interruptions: number;
  rollback_drills: number;
  unauthorized_actions: number;
  reviewer_mutations: number;
  proof_integrity_failures: number;
  metrics: Record<string, number>;
  latest_run_id: string;
  latest_proof_dir: string;
  high_severity_open_defects: number;
}
```

Write the current report atomically to the explicit serving home:

```text
$OSSTACK_HOME/reports/kimi-autonomy-soak-latest.json
$OSSTACK_HOME/reports/kimi-autonomy-soak-latest.json.sha256
```

Never read or write the default `~/.osstack` during development or tests. Tests use a temporary explicit `OSSTACK_HOME`.

- [ ] Deterministic test mode must perform:

- 6 R1/R2 fixture tasks;
- 1 forced daemon kill and recovery;
- 1 simulated network loss;
- 1 health failure and successful rollback;
- no external GitHub/deploy writes.

- [ ] Real Mac Mini acceptance mode requires:

- 7 elapsed days;
- at least 30 real R1/R2 tasks;
- at least 2 registered repositories;
- 5 forced daemon restarts;
- 3 network interruptions;
- 3 rollback drills;
- zero unauthorized R3/R4 actions;
- zero escaped reviewer mutations;
- zero proof-integrity failures;
- 100% restart recovery;
- 100% rollback-drill success;
- unattended completion at least 85%.

- [ ] Add a read-only status gate:

```bash
node scripts/soak-kimi-autonomy.mjs \
  --status \
  --require-productization \
  --report "$OSSTACK_HOME/reports/kimi-autonomy-soak-latest.json"
```

It must verify the checksum, referenced proof, elapsed time, event counts, rates, and `high_severity_open_defects = 0`. It exits `0` and prints the validated JSON only when every productization threshold passes; otherwise it exits `1` with machine-readable failed predicates and does not mutate the report.

- [ ] Run deterministic mode:

```bash
pnpm test:soak-kimi-autonomy
```

Expected: exit `0` with a JSON summary satisfying the deterministic thresholds.

- [ ] Commit:

```bash
git add scripts/soak-kimi-autonomy.mjs \
  scripts/soak-kimi-autonomy.test.mjs \
  fixtures/autonomy/r2-deploy package.json
git commit -m "test(ops): add Kimi autonomy soak and fault injection"
```

## Task 13: Write the Mac Mini production runbook

**Files:**

- Create: `docs/runbooks/kimi-mac-mini-autonomy.md`
- Modify: `docs/product/12_RUNBOOK.md`
- Modify: `README.md`
- Test: command review and secret scan

- [ ] Include exact installation flow:

```bash
osstack config init
osstack config use mac-mini
osstack config doctor
osstack serve --install --profile mac-mini --write-concurrency 2 --read-concurrency 8
osstack serve --status --json
osstack autonomy health --json
```

- [ ] Include exact daily checks:

```bash
osstack autonomy health --json
osstack autonomy list --json
osstack autonomy freeze list --json
osstack daily --json
```

- [ ] Include recovery order:

1. stop new external side effects;
2. inspect autonomy health and run transitions;
3. verify state DB backup and proof integrity;
4. restore Kimi/GitHub/network availability;
5. clear stale locks only through the audited health flow;
6. resume one run;
7. observe staging;
8. clear production freeze only after rollback verification;
9. re-enable production.

- [ ] Include MacBook usage: CodeX pairing or macOS Screen Sharing is observation/control only; execution remains on the Mac Mini.

- [ ] Run:

```bash
pnpm lint
rg -n '(api[_-]?key|token|password).*[=:].{8,}' \
  docs/runbooks/kimi-mac-mini-autonomy.md
git diff --check
```

Expected: lint and diff check pass; secret scan prints no credential assignment.

- [ ] Commit:

```bash
git add docs/runbooks/kimi-mac-mini-autonomy.md \
  docs/product/12_RUNBOOK.md README.md
git commit -m "docs: add 24x7 Kimi Mac Mini runbook"
```

## Task 14: Changesets, final verification, and Phase D pull request

**Files:**

- Create: `.changeset/guarded-deploy-operations.md`
- Modify: changelogs for protocol, core, autonomy, and CLI

- [ ] Add:

```markdown
---
"@osstack/protocol": minor
"@osstack/core": minor
"@osstack/autonomy": minor
"@osstack/cli": minor
---

Add project-allowlisted deployment, automatic rollback and freeze, and Mac Mini guarded-autonomy operations.
```

- [ ] Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:guarded-git
pnpm test:soak-kimi-autonomy
git diff --check
git status --short
```

Expected: all commands pass and the worktree is clean.

- [ ] Run one fake-deploy guarded delivery:

```bash
OSSTACK_HOME="$PWD/.tmp/osstack-deploy-smoke" \
  pnpm --filter @osstack/cli exec osstack deliver \
  "Update the fixture greeting and deploy it" \
  --workspace "$PWD/fixtures/autonomy/r2-deploy" \
  --profile mac-mini \
  --autonomy guarded-deploy \
  --deploy-policy project \
  --worktree \
  --json
```

Expected: staging and production fake commands run, health passes, and final proof includes deploy evidence.

- [ ] Push and open:

```bash
git push -u origin feat/guarded-deploy-operations
gh pr create \
  --base main \
  --head feat/guarded-deploy-operations \
  --title "feat: add guarded deployment and Mac Mini operations" \
  --body "Implements P5-P6: strict project deploy policy, health-checked production, automatic rollback/freeze, durable recovery, launchd hardening, and soak tooling."
```

Expected: a PR URL. Plan E must not start until this PR is merged and the real Mac Mini soak gate is green.

---

## v3 mandatory amendments

### D.1 Closed deploy policy

Replace free-form `allowed_change_types` with a closed enum and a deterministic
pure function:

```text
deriveChangeTypes(changedPaths, diffStats)
```

Unknown classification produces no allowed type and denies deployment. LLM
signals are not inputs.

Private overlay rules:

- omitted target means repository policy remains effective;
- a private overlay that supplies a command is a schema error;
- allowed path merge is a prefix-aware intersection that can only narrow;
- path comparison observes segment boundaries;
- timezone is valid IANA data;
- cross-midnight freeze windows have explicit semantics.

### D.2 Deployment script authority and rollback drill

Resolve every repository-local command/verify/health/rollback path referenced
by effective policy. Changing one is RISK-R3. Eligibility records current
SHA-256 digests and requires a successful drill no older than 30 days with the
same digests.

Add:

```text
osstack autonomy drill rollback --repo <repo-id> --json
```

The drill executes rollback and post-rollback health, persists timestamps,
digests and result in SQLite, and is safe for a controlled non-production
target unless production authority is separately granted.

### D.3 Deploy runner environment

Do not forward `process.env`. Start with `PATH`, `HOME`, `LANG`, and `TMPDIR`,
then add only policy-approved names through the stricter overlay. Approval
private material, notification credentials, CI tokens, and unrelated secrets
are never passed. A fake secret injection test must prove the child cannot read
it.

### D.4 Trusted freeze control

Production freeze-clear uses the same externally signed decision contract as
RISK-R3 approval. Non-TTY rejection remains defense in depth but is not human
authentication. TTY-only development/break-glass mode cannot clear production.

### D.5 Durable notification outbox

Insert a task after scorecard state exists:

**Files:**

- Create: `packages/core/src/state/notification-outbox.ts`
- Create: `packages/core/src/state/notification-outbox.test.ts`
- Create: `packages/cli/src/autonomy-notification.ts`
- Create: `packages/cli/src/autonomy-notification.test.ts`
- Modify: `packages/cli/src/autonomy-health.ts`
- Modify: `packages/cli/src/autonomy-scorecard.ts`

Entering `awaiting_approval`, `escalated`, `deploy_frozen`,
`rollback_failed`, or `delivery_evidence_failed` persists a redacted,
idempotent outbox item before delivery. Delivery uses bounded backoff and
dead-letter state. Failure does not rewrite the primary run result, but pending
and dead-letter counts/age remain visible until acknowledged.

Never include raw diff, credentials, webhook URL, or approval material. Test
success, timeout, retry, duplicate suppression, restart recovery, redaction,
and dead-letter visibility.

### D.6 Power, clock, log, and host evidence

Do not hardcode or automatically apply a machine-wide power policy. The Owner
selects bounded power assertion or persistent settings under the named machine
authority gate. Record prior/current settings and rollback instructions.
`autonomy health` verifies the selected policy. Detect clock jumps and run the
network/recovery probes again.

Add log rotation and proof retention so daemon output cannot trigger its own
disk brake. Real host acceptance includes `launchctl print` evidence.

### D.7 Real task supply and soak

Before soak, freeze a checksummed manifest with at least 30 real, distinct
RISK-R1/R2 tasks across two repositories, each with acceptance criteria and a
unique prompt digest. Workspaces cannot be fixtures. If supply is insufficient,
extend the window.

The soak additionally exercises one notification outage with durable retry,
one stale signed-decision rejection, and one mismatched deploy-script digest
rejection.

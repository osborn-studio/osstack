# Kimi Mac Mini 24x7 Autonomy Runbook

This runbook operates project-allowlisted `guarded-deploy` on one registered
Mac Mini. The Mac Mini is the execution host. A MacBook may observe and control
it through CodeX pairing or macOS Screen Sharing, but must not become a second
executor for the same run.

The system fails closed. Missing health, identity, policy, proof, signed
decision, GitHub, deployment, or rollback evidence stops the affected side
effect.

## Authority gates

Keep these authorities separate:

| Gate | Authorizes | Does not authorize |
|---|---|---|
| Merged Phase D code | Building, testing, and reviewing the implementation | Changing the host or deploying production |
| `OWNER-GO-MACHINE` | Installing/reloading the LaunchAgent and selecting the bounded power mode on the named Mac Mini | Clearing a production freeze or starting production deployment |
| `OWNER-GO-PROD` | Enabling the registered production path and starting the real soak | Persistent power changes, R4 actions, or unsigned R3 decisions |
| External signed R3 decision | Only the exact request digest, scope, nonce, and expiry in that decision | Any changed diff, deploy script, later request, or R4 action |

Record the literal named authorization in the change ticket or release evidence
before acting. General statements such as “approved” are not substitutes for a
named machine or production gate.

## Host and storage model

- Run the daemon only on the registered Mac Mini user account.
- Use one explicit `OSSTACK_HOME`; the production database, socket, logs,
  notification outbox, host evidence, and soak reports live below it.
- Keep source worktrees on the configured developer volume, not in a fixture or
  disposable temporary directory.
- Keep credentials in their native login stores or an external secret manager.
  Do not put credentials in `.osstack/repo.yaml`, `.osstack/policy.yaml`,
  LaunchAgent files, task manifests, soak events, or proof packs.
- Install only the Owner approval public key on the Mac Mini. The signing
  private key remains outside the Builder/Reviewer trust domain.

Recommended production environment:

```bash
export OSSTACK_HOME="/absolute/path/to/osstack-serving-home"
export OSSTACK_AGENT_PROFILE="mac-mini"
```

Create the directory with Owner-only access before installation:

```bash
install -d -m 700 "$OSSTACK_HOME"
```

## Pre-install checks

Run from the pinned release checkout or installed release:

```bash
node --version
osstack --version
gh auth status
git status --short
osstack agent list
```

The checkout must be clean and pinned to the reviewed release SHA. Kimi and
GitHub authentication must already work under the LaunchAgent user. Verify the
public approval trust file is Owner-only:

```bash
test -f "$OSSTACK_HOME/approval-trust.json"
chmod 600 "$OSSTACK_HOME/approval-trust.json"
```

Do not continue when the key file contains a private key.

## Install the Mac Mini service

Machine installation or reload requires the literal `OWNER-GO-MACHINE`
authority for this Mac Mini.

Initialize and validate the profile:

```bash
osstack config init
osstack config use mac-mini
osstack config doctor
```

Install first with no power assertion:

```bash
osstack serve --install --profile mac-mini --write-concurrency 2 --read-concurrency 8 --power-policy none
osstack serve --status --json
osstack autonomy health --json
```

This creates a user LaunchAgent. It does not change persistent `pmset`
settings. The selected mode, previous mode, current behavior, and rollback
instruction are recorded in:

```text
$OSSTACK_HOME/host/power-policy.json
```

For a real seven-day soak, the Owner may instead select the process-bound
assertion after recording `OWNER-GO-MACHINE`:

```bash
osstack serve --install \
  --profile mac-mini \
  --write-concurrency 2 \
  --read-concurrency 8 \
  --power-policy process_assertion

osstack serve --status --json
osstack autonomy health --json
pmset -g assertions
```

`process_assertion` wraps only the daemon lifetime with
`/usr/bin/caffeinate -ims`. If the daemon exits, the assertion exits. OSStack
rejects a persistent power mode and never applies automatic `pmset` changes.
Rollback to the prior bounded mode is:

```bash
osstack serve --install \
  --profile mac-mini \
  --write-concurrency 2 \
  --read-concurrency 8 \
  --power-policy none
```

Health must report the selected policy, the `monotonic-v1` clock monitor,
retention status, and a SHA-256 digest of `launchctl print` evidence. Raw
`launchctl` output is not persisted in the health report.

## Register repository deployment policy

`guarded-deploy` reads the effective `.osstack/repo.yaml` from the accepted
base commit. Candidate code cannot weaken its own policy. Add a strict
`deploy` section to an otherwise valid schema-version-2 repository contract.
Each command is an argv array; shell strings are not accepted.

Example structure:

```yaml
deploy:
  staging:
    enabled: true
    command: [scripts/deploy-staging.sh]
    verify_command: [scripts/verify-staging.sh]
    health_check: [scripts/health-staging.sh]
    rollback: [scripts/rollback-staging.sh]
    timeout_ms: 600000
    health_timeout_ms: 60000
    allowed_change_types: [source, tests]
    allowed_paths: [src/**, test/**]
    forbidden_paths: [src/auth/**, .github/**]
    allowed_base_branches: [main]
    allowed_environment: [DEPLOY_REGION]
    freeze_windows: []
  production:
    enabled: true
    command: [scripts/deploy-production.sh]
    verify_command: [scripts/verify-production.sh]
    health_check: [scripts/health-production.sh]
    rollback: [scripts/rollback-production.sh]
    timeout_ms: 900000
    health_timeout_ms: 120000
    allowed_change_types: [source, tests]
    allowed_paths: [src/**, test/**]
    forbidden_paths: [src/auth/**, .github/**]
    allowed_base_branches: [main]
    allowed_environment:
      - DEPLOY_REGION
      - OSSTACK_ROLLBACK_DRILL_TARGET
    freeze_windows: []
```

Use repository-specific paths and commands. A command must not contain a
credential or authenticated URL. Only names in `allowed_environment` pass to
the child process, and the runtime supplies a minimal base environment.

Changing either policy file or any referenced deploy, verify, health, or
rollback script is always RISK-R3. The external decision must bind the exact
post-diff digest before commit, merge, or deployment.

The production rollback and health scripts must recognize
`OSSTACK_ROLLBACK_DRILL_TARGET=controlled-non-production` and route that
invocation only to an isolated non-production target. The drill runner supplies
an empty sandbox `HOME`, passes no deployment credential values, and refuses
any other drill-target value.

Validate the effective contract before production:

```bash
osstack config doctor
osstack autonomy health --json
git diff --check
```

## Prove rollback readiness

Register the accepted repository path in the machine registry:

```bash
osstack supervise register /absolute/path/to/accepted-base-worktree \
  --repo-id OWNER/REPOSITORY \
  --role app \
  --registry "$OSSTACK_HOME/repos.json" \
  --json
```

Run the controlled non-production rollback and post-rollback health check:

```bash
osstack autonomy drill rollback --repo OWNER/REPOSITORY --json
```

The command requires a clean worktree at the freshly fetched remote default
branch, verifies that the registry ID matches the GitHub remote, binds every
production deploy/verify/health/rollback script digest, and persists successful
and failed attempts append-only in SQLite. It executes from a temporary copy of
tracked files without `.git`, with an empty sandbox `HOME`, and removes that
copy after evidence is captured. A successful record is valid for 30 days and
only for the exact same production script-authority digest.

Do not grant the drill script access to a production credential, native
production login, or production target. If the script cannot honor the
controlled marker, do not run the drill and do not activate production.

## Start one guarded deployment

Production activation requires the literal `OWNER-GO-PROD` authority and a
healthy, unfrozen repository. Start with one bounded R1/R2 task:

```bash
osstack deliver "Implement one allowlisted production change" \
  --workspace /absolute/path/to/registered-worktree \
  --profile mac-mini \
  --autonomy guarded-deploy \
  --deploy-policy project \
  --expected-path src/example.ts \
  --expected-path test/example.test.ts \
  --verify "pnpm typecheck" \
  --verify "pnpm test" \
  --json
```

The runtime must complete local build/review, candidate proof, commit, PR,
required CI, exact-head merge, staging deploy/verify/health, and only then
production deploy/verify/health. A production health failure runs the pinned
rollback command, checks post-rollback health, freezes that repository, and
persists evidence.

Do not start multiple production repositories at once during initial
validation. Machine-wide writer slots and per-repository locks serialize later
work.

## Daily checks

Run these at the beginning and end of each operating day:

```bash
osstack autonomy health --json
osstack autonomy list --json
osstack autonomy freeze list --json
osstack daily --json
```

Review:

- local, merge, and deploy capability separately;
- disk brake, state database, Kimi, GitHub, network, deploy targets, power,
  clock, LaunchAgent, retention, and notification-outbox checks;
- resumable runs and runs awaiting approval;
- active production freezes;
- unattended completion, reviewer pass, deploy success, rollback success,
  restart recovery, notification backlog, and oldest-attention age.

Also capture service state without publishing its raw output:

```bash
osstack serve --status --json
launchctl print "gui/$(id -u)/ai.osstack.daemon" | shasum -a 256
```

## Stop external side effects

When health is uncertain:

1. Do not invoke `autonomy resume`, a new guarded delivery, or freeze clear.
2. Disable production in the affected base-commit repository policy or stop
   the LaunchAgent under the incident change record.
3. Preserve `$OSSTACK_HOME/state.db`, its WAL files, logs, proof directories,
   notification outbox, and worktrees.
4. Do not edit the database or proof files manually.

To stop the user service under `OWNER-GO-MACHINE`:

```bash
osstack serve --uninstall
osstack serve --status --json
```

This removes the LaunchAgent; it does not delete state, logs, reports, or proof.

## Recovery order

Always use this order:

1. Stop new external side effects.
2. Inspect autonomy health and run transitions.
3. Verify the state database backup and proof integrity.
4. Restore Kimi, GitHub, and network availability.
5. Clear stale locks only through the audited health/recovery flow.
6. Resume one run.
7. Observe staging.
8. Clear a production freeze only after rollback verification.
9. Re-enable production.

### 1–2. Inspect

```bash
osstack autonomy health --json
osstack autonomy list --json
osstack autonomy status RUN_ID --json
osstack autonomy freeze list --repo OWNER/REPOSITORY --json
```

Capture the JSON into the incident record. Do not treat a network-only blocker
as permission to bypass local checks.

### 3. Back up state and verify proof

Stop the service before a manual database backup:

```bash
osstack serve --uninstall
install -d -m 700 "$OSSTACK_HOME/backups"
sqlite3 "$OSSTACK_HOME/state.db" \
  ".backup '$OSSTACK_HOME/backups/state-before-recovery.db'"
sqlite3 "$OSSTACK_HOME/backups/state-before-recovery.db" "PRAGMA integrity_check;"
```

Expected database result: `ok`.

Validate the candidate/final proof path recorded by autonomy status:

```bash
osstack proof validate LOOP_ID \
  --proof-dir /absolute/path/to/proof-directory \
  --json
```

Do not resume if the manifest, artifact inventory, candidate/final linkage, or
archive integrity fails.

### 4–7. Restore dependencies and resume one run

```bash
gh auth status
osstack config doctor
osstack autonomy health --json
osstack autonomy resume RUN_ID --json
osstack autonomy status RUN_ID --json
```

Recovery reuses persisted idempotency keys, locks, commit trailers, pull
request evidence, and deploy attempt state. It must not rerun Builder solely
because GitHub or the daemon restarted. Observe staging health before any
production action.

### 8. Clear a production freeze

Rollback success does not clear production automatically. Request a fresh,
scoped RISK-R3 decision:

```bash
install -d -m 700 "$OSSTACK_HOME/requests"
osstack autonomy freeze request OWNER/REPOSITORY --json \
  | jq '.result.scoped_approval_request' \
  > "$OSSTACK_HOME/requests/freeze-clear-request.json"
```

Transfer that exact request to the external signer. After the signer returns a
current decision, import it without resuming deployment:

```bash
osstack autonomy freeze clear OWNER/REPOSITORY \
  --request "$OSSTACK_HOME/requests/freeze-clear-request.json" \
  --decision /secure-transfer/freeze-clear-decision.json \
  --reason "Rollback and post-rollback health verified" \
  --json

osstack autonomy freeze list --repo OWNER/REPOSITORY --json
```

The request binds the repository, source run, freeze state, nonce, expiry, and
`freeze:clear:production` scope. `--actor`, terminal presence, stale decisions,
and decisions from Builder/Reviewer are rejected. Freeze clear never resumes
the source run or deploys production.

### 9. Re-enable production

Require a fresh `OWNER-GO-PROD` record after incident closure. Run health again,
then start one new bounded task. Never reuse the failed deployment invocation
or a stale signed decision.

## Rollback failure

If rollback or post-rollback health fails:

- leave production frozen;
- stop new external actions;
- retain candidate/final proof, deploy stdout/stderr digests, script digests,
  state transitions, and outbox items;
- restore the last known healthy artifact using the separately reviewed
  operator procedure;
- do not mark the autonomy run completed;
- escalate to the Owner through the durable notification path.

Manual recovery must not rewrite the autonomy event history.

## Seven-day real soak

The deterministic dry soak runs during CI and never contacts GitHub or a real
deployment:

```bash
pnpm test:soak-kimi-autonomy
```

Before the real soak:

1. Merge and install the reviewed Phase D release.
2. Record `OWNER-GO-MACHINE` and select `process_assertion`.
3. Record `OWNER-GO-PROD`.
4. Freeze a checksummed manifest of at least 30 distinct real RISK-R1/R2 tasks
   across at least two registered repositories.
5. Give every task a unique prompt digest, non-empty acceptance criteria, and a
   real absolute workspace path.
6. Start a chronological, checksummed NDJSON evidence log.

The task manifest at
`$OSSTACK_HOME/reports/kimi-autonomy-task-manifest.json` uses:

```json
{
  "schema_version": 1,
  "kind": "osstack.kimi_autonomy_task_manifest",
  "created_at": "ISO-8601 timestamp",
  "tasks": [
    {
      "task_id": "real-task-001",
      "repo": "owner/repository",
      "risk": "RISK-R1",
      "prompt_sha256": "64 lowercase hexadecimal characters",
      "acceptance_criteria": ["one observable acceptance condition"],
      "workspace_path": "/absolute/path/to/real/worktree"
    }
  ]
}
```

Write the adjacent checksum:

```bash
cd "$OSSTACK_HOME/reports"
shasum -a 256 kimi-autonomy-task-manifest.json \
  > kimi-autonomy-task-manifest.json.sha256
```

The audited evidence collector writes
`kimi-autonomy-soak-events.ndjson` atomically and updates its adjacent
`.sha256`. Events require a unique `event_id`, chronological `occurred_at`, and
`type`. Required evidence includes:

| Type | Required evidence |
|---|---|
| `soak_started` | Exactly one start timestamp |
| `task_completed` | Registered task ID, run ID, proof directory, outcome, unattended flag |
| `daemon_restart` | `signal: "SIGKILL"` and recovery success |
| `network_interruption` | Recovery result |
| `rollback_drill` | Forced deploy failure and rollback success |
| `notification_outage` | Persisted-before-retry and retry-delivered evidence |
| `stale_signed_decision` | Rejected result |
| `deploy_digest_mismatch` | Rejected result |
| defect/integrity events | Open/close or failure evidence; never omit a failure |

Create a report snapshot from the checksummed evidence:

```bash
pnpm soak:kimi-autonomy -- \
  --task-manifest "$OSSTACK_HOME/reports/kimi-autonomy-task-manifest.json" \
  --events "$OSSTACK_HOME/reports/kimi-autonomy-soak-events.ndjson"
```

The productization gate is read-only:

```bash
node scripts/soak-kimi-autonomy.mjs \
  --status \
  --require-productization \
  --report "$OSSTACK_HOME/reports/kimi-autonomy-soak-latest.json"
```

It recomputes event counts and rates rather than trusting report counters. It
requires seven elapsed days, 30 real distinct tasks, two repositories, five
successful SIGKILL recoveries, three recovered network interruptions, three
successful forced rollback drills, one durable notification retry, one stale
decision rejection, one deploy-script digest rejection, at least 85%
unattended completion, and zero unauthorized actions, reviewer mutations,
proof-integrity failures, or open high-severity defects.

If task supply is insufficient, extend the soak window. Do not replace real
tasks with fixtures or duplicate prompts.

## MacBook observation and control

CodeX pairing and macOS Screen Sharing are observation/control channels only.
Use them to:

- read health, scorecard, run, freeze, and proof output;
- transfer an approval request to the external Owner signer;
- invoke an already-authorized command on the Mac Mini;
- stop the Mac Mini daemon during an incident.

Do not run a second daemon, Builder, Reviewer, deployment command, or resume for
the same run from the MacBook. The state database and execution worktree remain
on the Mac Mini.

## Upgrade and uninstall

Upgrade one reviewed release at a time:

1. stop new work and drain active runs;
2. capture health, service, database backup, and proof evidence;
3. install the pinned release;
4. reinstall/reload under `OWNER-GO-MACHINE`;
5. run health and one local-only validation;
6. restore production only under `OWNER-GO-PROD`.

Uninstall the service without deleting evidence:

```bash
osstack serve --uninstall
osstack serve --status --json
```

Preserve `$OSSTACK_HOME` until retention and incident requirements are met.

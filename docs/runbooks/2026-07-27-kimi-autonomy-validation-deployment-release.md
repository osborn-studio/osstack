# Kimi Autonomy Validation, Deployment, and Release Runbook

> Commands in this document that begin with `osstack autonomy` are target
> contracts for the new implementation. They are not assumed to exist on the
> planning baseline.

## 1. Purpose

Promote the Kimi autonomy path from local verification to guarded Git,
allowlisted deployment, seven-day Mac Mini operation, and public release while
retaining a tested rollback at every stage.

This runbook is evidence-driven. Elapsed time, a green process exit, or a
successful model response is never sufficient by itself.

## 2. Roles and trust boundaries

| Role | May hold | Must not receive |
|---|---|---|
| Builder | source task, bounded workspace, build/test tools | owner signing key, notification credential, deploy secrets unrelated to the task |
| Evaluator/Kimi | sanitized diff, deterministic results, review policy | builder write access, owner signing key, notification credential |
| osstack daemon | repository policy, public approval verification key, delivery/deploy credentials from approved stores | external approval private key |
| Owner approval service | approval private key, human-authenticated decision UI | builder shell or writable repository |
| Notification gateway | webhook credential and delivery state | raw diff, source secrets, approval private key |

Production approval is a signed external decision. Local TTY confirmation may
support development or break-glass diagnosis but cannot clear a production
freeze or authorize production RISK-R3.

## 3. Evidence directory

Each real promotion creates:

```text
docs/reports/kimi-autonomy/
  final-audit-verdict.md
  phase-a-live-kimi-scorecard.json
  phase-a-promotion.md
  phase-b-promotion.md
  phase-c-promotion.md
  phase-d-soak-manifest.json
  phase-d-soak-report.json
  phase-d-promotion.md
  phase-e-release-qualification.md
  privacy-source-report.json
  privacy-npm-report.json
  privacy-binary-report.json
```

Every report records:

- repository and base/head commit SHAs;
- osstack, Node, pnpm, Git, GitHub CLI, Kimi, and operating-system versions;
- start/end timestamps and execution host role;
- commands and exit status;
- proof/report SHA-256 digests;
- redacted failure reasons;
- owner decision IDs, never private approval material;
- residual waivers.

Generated operational reports may be stored outside Git when they include
machine data, but the committed promotion report records their digest and
retention location.

## 4. Host preflight

Run on the registered Mac Mini before real probes, soak, or release smoke:

```bash
node --version
pnpm --version
git --version
gh --version
gh auth status
command -v kimi
kimi --version
df -P "$OSSTACK_WORKTREES_ROOT"
pmset -g
launchctl print "gui/$(id -u)"
```

Pass conditions:

- Node and pnpm satisfy the repository declarations;
- GitHub authentication can read the target repositories and their protection
  metadata;
- Kimi is installed and authenticated, not merely present on `PATH`;
- the configured worktree root is on owner-approved storage;
- disk, memory, network, and budget thresholds are green;
- power policy is recorded;
- notification outbox has no unexplained dead letters;
- no development command points at the default production `OSSTACK_HOME`.

Changing power settings, launchd installation, keychain policy, or other
machine-wide state requires `OWNER-GO-MACHINE`. For a finite soak, prefer a
bounded power assertion when it meets the operational requirement; if a
persistent `pmset` policy is chosen, record the prior values and rollback
command before changing them.

## 5. Repository preflight

Every guarded Git/deploy target must have:

- explicit repository ID, base branch, and owner;
- effective protection policy that osstack can inspect;
- at least one required check applicable to the current head SHA;
- no administrator bypass in osstack merge argv;
- an allowlisted worktree root and change category;
- deterministic test/health commands as argv arrays;
- deploy, health, and rollback scripts committed in the repository;
- current SHA-256 digests for every referenced script;
- a successful rollback drill no older than 30 days with matching digests;
- a signed owner decision channel and a tested notification destination;
- a last-known-good artifact/reference.

Absent or ambiguous data is a denial, not an empty success.

## 6. Phase A real Kimi qualification

### 6.1 Capability probe

Record sanitized evidence for:

- exact stream event shapes;
- sentinel behavior;
- native read-only/tool policy behavior;
- agent-file behavior;
- authentication failure;
- timeout/cancellation;
- token/usage telemetry or explicit unavailability;
- an attempted write under the selected isolation boundary.

Do not commit raw stdout/stderr until it has passed privacy review.

### 6.2 Live corpus

```bash
node scripts/eval-kimi-review.mjs --live --json
```

Required:

- at least 10 distinct cases;
- expected findings defined by deterministic rules;
- false passes: `0`;
- false alarms reported;
- every result binds adapter/provider/model reported identity;
- budget/usage data recorded honestly;
- reviewer mutation attempt cannot affect the builder repository.

Failure keeps Kimi disabled as the authoritative evaluator.

## 7. Phase B guarded-local qualification

Run the same task once in `legacy` and once in `guarded-local`.

`legacy` must:

- match recorded output/exit snapshots;
- perform zero profile/adapter probes unless explicitly requested;
- create no automatic Git or deployment writes.

`guarded-local` must:

- resolve the selected profile;
- prove reported Builder/Evaluator identity and separation;
- run deterministic verification before Kimi;
- create candidate proof;
- stop before remote writes;
- survive daemon restart without changing the chosen routing.

Any configured/inferred identity in an independence claim is a failure.

## 8. Phase C guarded-Git qualification

Use disposable protected fixture repositories first.

| Scenario | Expected result |
|---|---|
| RISK-R1 documentation change | unattended commit, push, PR, required checks, SHA-bound merge |
| RISK-R2 code change | same, plus reported provider/model independence |
| RISK-R3 auth change | signed approval request before delivery write |
| RISK-R4 destructive task | permanently blocked, no approval action |
| untracked auth file | included in staged diff and classified RISK-R3 |
| staged diff changes after approval | escalated before commit |
| PR head changes after checks | merge rejected |
| no/ambiguous protection | `blocked_delivery` |
| zero required checks | `blocked_delivery` |
| candidate proof write fails | no push or PR |
| final proof write fails | run not completed |

For an approved post-diff RISK-R3 resume, instrument the Builder port and prove
it is not invoked again.

The delivery log must show `--match-head-commit <pushed-sha>` and must not show
`--admin`.

## 9. Rollback drill before deployment

For every production-eligible repository:

```bash
osstack autonomy drill rollback --repo <repo-id> --json
```

The target contract:

1. records current deploy/health/rollback script digests;
2. deploys or selects a controlled non-production candidate;
3. invokes rollback with `shell:false` and minimal environment;
4. runs post-rollback health;
5. persists result, timestamps, digests, and proof;
6. leaves production unchanged unless separately authorized.

Eligibility denies when the drill is missing, older than 30 days, failed, or
has different script digests.

## 10. Staging activation

Preconditions:

- Phase C promotion report is green;
- deploy policy and deterministic change types are verified;
- rollback drill is current;
- notification success and failure/retry paths are tested;
- no production authority is enabled.

Run a RISK-R2 allowlisted staging task:

```bash
osstack deliver "<approved staging task>" \
  --workspace "<registered-repository>" \
  --profile mac-mini \
  --autonomy guarded-deploy \
  --worktree \
  --verify-profile standard \
  --deploy-policy project \
  --json
```

Required evidence:

- preflight and post-diff risk decisions;
- staged diff digest and candidate proof;
- branch, PR, required checks, pushed SHA, and merge evidence;
- deterministic change types;
- deploy-script digests matching the drill;
- staging deploy and health result;
- final proof superseding candidate proof;
- no production side effect.

## 11. Production activation

Requires `OWNER-GO-PROD` and a signed decision bound to the exact production
scope.

Before activation:

- record the current production artifact and health baseline;
- create/verify a production freeze-clear decision through the trusted channel;
- confirm last-known-good rollback artifact;
- confirm notification delivery and outbox health;
- confirm script digests and drill age;
- confirm no active freeze window or safety freeze;
- confirm budget, disk, network, and target health.

Activate one canary repository/change class first. Do not enable all registered
repositories simultaneously.

Immediate rollback triggers:

- deploy or health command fails;
- post-deploy evidence cannot be persisted;
- script digest changes;
- signed decision validation fails;
- unexpected path/change type appears;
- notification outbox cannot persist an attention event;
- target health degrades beyond policy;
- owner issues freeze.

## 12. Seven-day soak

### 12.1 Manifest

Before the clock starts, freeze a manifest containing:

- at least 30 real RISK-R1/R2 tasks across at least two repositories;
- acceptance criteria for every task;
- pairwise-distinct prompt digests;
- workspaces outside fixture directories;
- fault-injection schedule;
- expected notification drills;
- current rollback drill/script digests;
- host/power/launchd baseline;
- report schema version and manifest checksum.

If task supply is insufficient, extend the window. Do not manufacture trivial
tasks to meet the count.

### 12.2 Required injections

Across the soak:

- five daemon SIGKILL/restart recoveries;
- three network interruptions at different delivery states;
- three forced deploy failures, each followed by successful rollback and health;
- at least one real/injected `awaiting_approval` notification;
- at least one `escalated` or `deploy_frozen` notification;
- one webhook outage with durable retry and later delivery;
- one stale/mismatched approval rejection;
- one stale/mismatched deploy-script digest rejection.

### 12.3 Daily checks

- completed/blocked/escalated counts by risk;
- false passes and false alarms;
- repair iterations and no-progress stops;
- proof integrity failures;
- pending/dead notification count and oldest age;
- Kimi reviews, observed usage, and remaining budget;
- disk/log/proof retention;
- daemon restarts and clock jumps;
- rollback and health results;
- unauthorized action count.

### 12.4 Soak pass conditions

- at least 30 accepted real tasks;
- zero false passes;
- zero unauthorized RISK-R3/R4 actions;
- zero reviewer mutation escapes;
- zero proof-integrity escapes;
- all five restarts recover without duplicate side effects;
- all three network interruptions recover or stop safely;
- all three deploy failures rollback and return healthy;
- required notifications are delivered;
- no unexplained dead letters;
- report checksum matches the frozen manifest.

## 13. Release qualification

### 13.1 Repository gates

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

### 13.2 Clean install and migration

Test:

- empty home;
- v1 configuration;
- database before migrations 17 and 18;
- current upgrade;
- downgrade/rollback to last supported version;
- new CLI verifying an old proof;
- legacy mode after rollback.

### 13.3 Artifact-first privacy and portability

Blocking zero-tolerance scopes:

- unpacked npm tarballs;
- single-binary strings/resources;
- runtime defaults and serialized templates;
- public README/guides/release notes;
- generated launchd templates;
- source maps, fixtures, and Markdown assets that ship.

Source/test findings may be allowed only through a reviewed file containing:

```json
{
  "path": "non-shipped/test-fixture",
  "pattern_id": "private-path-redaction-fixture",
  "reason": "tests redaction of a synthetic path",
  "owner": "release-reviewer",
  "expires_at": "YYYY-MM-DD"
}
```

No allowlist entry can match a shipped artifact or runtime default.

Scan for:

- user home paths;
- mounted-volume paths;
- private hostnames;
- owner-only repository names;
- access tokens, API keys, webhook URLs, and private-key material;
- real stdout/stderr captured by probes.

### 13.4 Platform matrix

Release notes state:

- macOS: supported, backed by real Kimi and seven-day Mac Mini soak;
- Linux: experimental until equivalent real-provider operations evidence exists;
- Windows: unsupported unless a later qualification adds it.

### 13.5 Package and binary

Use existing repository scripts for npm preflight, portable CLI smoke, binary
build, SBOM, signing, notarization, and release-pack smoke. Inspect the exact
artifacts that will be published, not a prior build.

## 14. Publication and post-publish verification

Requires `OWNER-GO-PUBLISH`.

Publication sequence:

1. record release candidate commit and artifact digests;
2. retain previous package/binary artifacts and rollback instructions;
3. publish the approved artifact;
4. install from the public channel into a clean isolated home;
5. run `config doctor`, `agent list`, legacy smoke, guarded-local smoke, and
   artifact privacy scan;
6. verify public release metadata, checksums, SBOM/signature/notarization as
   applicable;
7. publish release notes and platform matrix;
8. monitor notification, error, rollback, and install signals.

If post-publish smoke fails:

- stop promotion of the new channel;
- restore or recommend the previous qualified version;
- disable guarded states as needed, retaining `legacy`;
- preserve failed artifacts and proof;
- issue a rollback notice only after the recovery state is verified.

## 15. Final sign-off

Release sign-off requires links/digests for:

- final audit verdict;
- all phase promotion reports;
- closed audit ledger;
- seven-day soak report;
- three rollback drill/failure recoveries;
- signed approval-channel tests;
- notification outbox tests;
- npm/binary/public-doc privacy reports;
- clean install, upgrade, and rollback;
- public-channel post-publish smoke;
- previous-release rollback availability.

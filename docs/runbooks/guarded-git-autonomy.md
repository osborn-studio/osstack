# Guarded Git Autonomy Runbook

This runbook operates `osstack deliver --autonomy guarded-git`. The mode turns
one bounded task into a locally verified candidate, an auditable commit, a
GitHub pull request, required CI, a merge, and final proof. It fails closed when
policy, identity, approval, verification, or delivery evidence is missing.

## Preconditions

Use a dedicated feature worktree and a branch matching the repository policy:

```bash
git worktree add ../my-product-guarded -b osstack/my-change main
cd ../my-product-guarded
gh auth status
git remote get-url origin
git status --short
```

The remote must resolve to exactly one GitHub `owner/repo`. `gh` needs permission
to push the branch, create/read the pull request, inspect checks, and merge it.
Required checks and branch protection remain authoritative.

The initial worktree must be clean, and feature-branch `HEAD` must equal the
freshly fetched remote default-branch SHA. Guarded delivery rejects pre-existing
candidate commits, a stale base, or initial untracked/modified files. The
verified base SHA is persisted in routing and rechecked before Builder,
post-Builder staging, and commit so Builder-created commits cannot escape the
authoritative diff.

Both repository contracts are mandatory. `.osstack/policy.yaml` must use
`mode: execute` and `auto_apply: true`. `.osstack/repo.yaml` must use strict
schema version 2, enable `git.auto_merge`, protect its default branch, declare a
non-empty standard verification list, and bound autonomy budgets. Example:

```yaml
schema_version: 2
product: example
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
  quick: [pnpm test]
  standard: [pnpm typecheck, pnpm test, pnpm build]
  release: [pnpm typecheck, pnpm test, pnpm build]
```

Kimi must be installed and authenticated on the execution node. Its provider
and default model must be reported by the Kimi CLI; configured or inferred
identity cannot prove R2/R3 reviewer independence.

```bash
osstack agent list
osstack config doctor
```

## Start a delivery

Declare every expected path. Omitting paths conservatively classifies a write
intent as R2, but explicit paths provide a useful scope boundary and detect
auth, billing, migration, workflow, policy, and deployment-script risk before
Builder invocation.

```bash
osstack deliver "Add the bounded account summary" \
  --workspace . \
  --profile mac-mini \
  --autonomy guarded-git \
  --expected-path src/account/summary.ts \
  --expected-path test/account/summary.test.ts \
  --verify "pnpm typecheck" \
  --verify "pnpm test" \
  --json
```

The command prints `autonomy_run_id`, current state, risk, approval request when
present, candidate proof, Git delivery, and final proof. Durable state lives in
`$OSSTACK_HOME/state.db`; per-run Loop and proof evidence lives under
`$OSSTACK_HOME/autonomy/<run-id>/`.

## Risk and action matrix

| Risk | Typical scope | Automatic action |
|---|---|---|
| R0 | Read/report only | Complete without Builder or Git writes |
| R1 | Documentation or tests only | Build, verify, review, prove, commit, PR, CI, merge |
| R2 | Bounded source/config change | Same as R1, but only with distinct reported Builder/Evaluator runtime identity |
| R3 | Auth/login/session, billing, migrations, infrastructure, workflows/actions, policy/referenced deploy scripts, verification/lifecycle scripts, major dependency changes, OSStack autonomy-kernel self-modification, destructive intent | Pause for external signed Owner approval; preflight and post-diff scopes are separate |
| R4 | Approval bypass, credential exfiltration, destructive production-data/root operations | Permanently block; no approval action is exposed |

`autonomy.max_auto_risk: R1` escalates R2 instead of silently widening
authority. R4 cannot be approved because approval is not a mechanism for
overriding the system's permanent safety boundary.

## R3 signed approval

R3 never trusts `--actor human:owner`, terminal presence, or a same-user
process. The decision must be Ed25519-signed outside the Builder/Reviewer trust
domain. Install only the public key on the Mac Mini:

```json
{
  "schema_version": 1,
  "keys": [
    {
      "key_id": "owner-key-2026",
      "public_key_pem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"
    }
  ]
}
```

Save it as `$OSSTACK_HOME/approval-trust.json` with owner-only permissions.
The external signer receives the exact `approval_request` from:

```bash
osstack autonomy status RUN_ID --json
```

The signed decision binds the run, phase, contract digest, staged-diff digest,
action scope, decision, nonce, issue/expiry times, and Owner identity. A
preflight decision binds the empty-diff sentinel and permits only build/verify.
Every preflight-R3 run requires a second post-diff decision, even when the
resulting bytes appear lower risk; R3 authority never disappears through risk
downgrade. The second decision binds the exact staged SHA-256 and permits
commit/push/merge. A changed digest, scope, nonce, expiry, or key fails closed.

Import and resume separately so authority and execution remain independently
auditable:

```bash
osstack autonomy approve RUN_ID \
  --decision /secure-transfer/RUN_ID-decision.json \
  --reason "Reviewed exact guarded scope" \
  --json

osstack autonomy resume RUN_ID --json
```

Reject with `osstack autonomy reject RUN_ID --decision FILE`. Decisions and
state transitions are append-only.

## Proof stages

Candidate proof is written before commit or any GitHub write. It contains the
intent, pre/post risk evidence, deterministic verification, structured Kimi
review, runtime identity, governance results, and approval evidence when
required.

Final proof is written only after Git delivery reports the pushed commit, PR,
merge commit, and merge time. It references the candidate manifest by relative
path and digest. If candidate proof fails, no commit/push occurs. If final proof
fails after merge, the run stops in `delivery_evidence_failed`; it never claims
completion.

## Recovery

Inspect the durable projection first:

```bash
osstack autonomy list --json
osstack autonomy status RUN_ID --json
```

For `blocked_delivery`, fix GitHub authentication, connectivity, checks, or
branch protection and then run:

```bash
osstack autonomy resume RUN_ID --json
```

Recovery reuses the commit trailer and inspects Git/GitHub state. It does not
rerun Builder, create a second candidate commit, or intentionally duplicate a
pull request. If GitHub already merged the exact head before a process crash,
recovery verifies the base/head refs, required checks, branch protection, merge
commit, and merge time without re-pushing the deleted branch or merging again.
The daemon also resumes non-approval recoverable states after restart and waits
for boot recovery before closing SQLite. `awaiting_approval` remains paused.

For `delivery_evidence_failed`, preserve the worktree and proof directory for
forensics; the state is terminal and requires operator remediation rather than
an unrecorded retry.

## Roll back autonomy

To stop remote automation without disabling local verification, use:

```bash
osstack deliver "Continue local verification only" \
  --workspace . \
  --profile mac-mini \
  --autonomy guarded-local \
  --verify "pnpm test" \
  --json
```

Also set `git.auto_merge: false`, change policy away from `execute`, or lower
`autonomy.max_auto_risk` to reduce authority. `guarded-local` never invokes the
guarded GitHub delivery port.

## Validation

The repository ships an offline fake-Kimi/fake-GitHub suite; it never touches a
real remote:

```bash
pnpm smoke:guarded-git
```

It proves R1/R2 completion, R3 pause, R4 denial, exact-base enforcement, proof
ordering, and restart recovery without duplicate external action IDs.

# Kimi Autonomy Execution Control Plan v3

> **Status: Historical controller.** Phases A–D landed; Phase E remains blocked on real-soak evidence. Use the [current-state index](../KIMI_AUTONOMY_STATUS.md) before following any step here.

> Status: normative execution controller, pending the final Codex audit.
>
> Purpose: let the final auditor close the remaining plan defects and, on a
> `PASS` verdict, continue directly into implementation without reopening scope
> or rebuilding the dependency graph.

## 1. Outcome

Deliver a production-qualified osstack autonomy path in five independently
releasable phases:

1. Kimi Code is a first-class, fail-closed evaluator.
2. `deliver` resolves an explicit profile without changing `legacy` behavior.
3. guarded Git delivery can commit, push, open a PR, observe required checks,
   and merge only under deterministic policy.
4. allowlisted deployment runs with health checks, rollback, durable owner
   notification, and Mac Mini operations evidence.
5. portable packages, documentation, upgrade/rollback paths, and public release
   artifacts pass qualification.

The final implementation must keep `legacy`, `guarded-local`, `guarded-git`,
and `guarded-deploy` as separate rollout states. A later state never weakens the
gates of an earlier state.

## 2. Authority and precedence

Read the following in order:

1. approved KD-01 through KD-08 and frozen Q decisions in the design;
2. `docs/superpowers/specs/2026-07-27-kimi-code-mac-mini-autonomous-development-design.md`;
3. accepted design errata recorded by the final audit;
4. this execution controller;
5. `2026-07-27-kimi-code-mac-mini-autonomy.v2.md`;
6. the five phase plans A through E;
7. the audit report, appendix, and closure ledger.

When two documents conflict, the higher item wins. The implementer must amend
the lower document before coding the affected task. It must not silently choose
one interpretation.

Pinned planning facts:

- planning branch: `docs/kimi-autonomy-plan`;
- audited planning commit:
  `49813780b4712953a3a8c34b890f7f34c4aa2865`;
- original code baseline:
  `a3080eccaba69a0e869a3fbd012be851dbb6603d`;
- package baseline: `@osstack/cli` `0.12.0`;
- `packages/github` exists and is extended in Phase C;
- `packages/autonomy` does not exist at the pinned baseline and is created in
  Phase C.

At the time this controller was written, remote `main` had advanced to
`27d520a160ad345aaa79ce0c8a204b52013880ef`; the code difference from the
original baseline was empty in the planned package paths, while `README.md` and
`README.zh.md` had changed. This is evidence, not a future assumption. Gate 0
must query `origin/main` again.

## 3. Execution contract

### 3.1 Automatic continuation

The final audit and Phase A implementation are one continuous operation:

- if Gate 0 returns `PASS`, create the Phase A worktree and begin the first
  failing test in the same task;
- if Gate 0 returns `BLOCKED`, stop before code changes and report only the
  unresolved finding IDs, evidence, and required owner decision;
- a stylistic preference, a low-severity documentation issue, or an optional
  refactor is not a blocker.

### 3.2 Named authority gates

Repository-local inspection, tests, branches, worktrees, and commits are normal
implementation work. External or privileged actions require the authority
profile supplied with the Codex kickoff:

| Gate | Action |
|---|---|
| `OWNER-GO-MERGE` | Merge an implementation PR that changes the autonomy trust kernel, approval channel, deploy policy, or release machinery |
| `OWNER-GO-MACHINE` | Change machine-wide power, launchd, keychain, firewall, or login settings |
| `OWNER-GO-PROD` | Enable `guarded-deploy` for a production target |
| `OWNER-GO-PUBLISH` | Publish npm packages, a binary release, or public release notes |

If the kickoff does not explicitly grant a gate, stop at that gate with all
preceding evidence complete. Do not reinterpret the project goal as blanket
authority.

### 3.3 Branch and PR sequence

Use one branch and one PR per phase:

| Phase | Branch | Must branch from |
|---|---|---|
| A | `feat/kimi-adapter-verifier` | latest accepted `origin/main` |
| B | `feat/kimi-profile-deliver` | `origin/main` after A |
| C | `feat/guarded-git-autonomy` | `origin/main` after B |
| D | `feat/guarded-deploy-operations` | `origin/main` after C |
| E | `feat/kimi-productization` | `origin/main` after D and the D soak gate |

Do not combine phases. Do not implement from the planning checkout. Before each
phase, fetch the remote, record the base SHA, and rerun the phase drift check.

## 4. Gate 0: final adversarial audit

Gate 0 is a short, evidence-producing audit, not another free-form design pass.

### 4.1 Verify immutable inputs

```bash
git ls-remote origin refs/heads/docs/kimi-autonomy-plan
git ls-remote origin refs/heads/main
git show --stat 49813780b4712953a3a8c34b890f7f34c4aa2865
```

Pass conditions:

- the audited planning commit is still reachable;
- every input document is present;
- the final audit records the current `origin/main` SHA;
- no plan is read from an unrelated dirty checkout.

### 4.2 Run the baseline drift audit

Build the planned-path set from every `Create`, `Modify`, `Delete`, and `Test`
entry in Plans A through E. Compare the original code baseline with current
`origin/main` for that set.

```bash
git diff --name-status \
  a3080eccaba69a0e869a3fbd012be851dbb6603d..origin/main -- \
  packages scripts fixtures docs/specs package.json pnpm-lock.yaml
```

For every changed planned path, record one of:

- `no_plan_change`: interface and assertions remain compatible;
- `plan_amended`: exact task, file map, or command was updated;
- `blocked`: the phase architecture or a frozen decision needs owner review.

A non-empty diff is not itself a blocker. An unreviewed diff is.

### 4.3 Close the audit ledger at plan level

Use
`docs/superpowers/audits/2026-07-27-kimi-autonomy-audit-closure-ledger.md`.

Gate 0 passes only when:

- all 18 original Critical/High findings are `PLAN_CLOSED`;
- all new challenge findings X-01 through X-07 are `PLAN_CLOSED`;
- every Medium finding is assigned to a phase task and a test/evidence target,
  or has an explicit owner waiver;
- no claim is closed by prose such as "handled" or "covered";
- the five phase plans contain the actual corrected text, file anchors, failing
  tests, and verification commands.

`PLAN_CLOSED` does not mean implemented. Implementation closure is recorded
later as `VERIFIED`.

### 4.4 Required challenge decisions

The final audit must explicitly uphold or replace these decisions:

1. **Reviewer isolation:** a linked Git worktree is not isolation because it
   shares the repository's common Git directory, configuration, and hooks.
   The reviewer must either run under a proven native read-only tool policy or
   an OS-enforced boundary that cannot write the builder repository. A
   diff-only temporary directory without `.git` reduces exposure but does not
   by itself stop a same-user shell process from traversing the filesystem.
   Workspace snapshots remain detection and evidence, not the sole boundary.
2. **Human approval:** `process.stdin.isTTY` is not production authentication;
   a same-user process can allocate a pseudo-terminal. Production RISK-R3
   approval and freeze-clear require a signed decision from a trust domain not
   available to Builder or Reviewer. The signed payload binds run ID, contract
   digest, staged diff digest, action scope, nonce, expiry, and decision.
   TTY approval may exist only as an explicitly marked development/break-glass
   mode.
3. **Notification reliability:** a failed webhook must not change the primary
   run result, but it must create a durable outbox item, retry with bounded
   backoff, and remain visible in health/scorecard output until acknowledged.
4. **Diff authority:** the staged index after `git add -A` is authoritative for
   risk, approval, proof, and commit. The hash is recalculated immediately
   before commit. Remote merge is bound to the pushed head SHA with
   `--match-head-commit`.
5. **Effective repository protection:** zero required checks is failure.
   Legacy branch protection and repository rulesets must be handled explicitly;
   an unavailable or ambiguous protection query fails closed.
6. **Privacy:** release qualification is artifact-first. npm tarballs, bundled
   binaries, runtime defaults, templates, and public documentation have zero
   private identifiers. Non-shipped tests may use an explicit, reviewed,
   expiring allowlist; runtime defaults cannot.
7. **Portability:** no public plan or runtime default names a private mount,
   hostname, username, or repository path. Storage checks inspect the configured
   `OSSTACK_WORKTREES_ROOT` with `df`/`stat`; they do not grep for a private
   device label.

### 4.5 Gate 0 output

Commit a report at:

```text
docs/reports/kimi-autonomy/final-audit-verdict.md
```

It must end with exactly one of:

```text
FINAL_AUDIT_VERDICT: PASS
```

```text
FINAL_AUDIT_VERDICT: BLOCKED
```

A `PASS` report includes the amended planning commit SHA, current main SHA,
closed finding IDs, accepted waivers, and the exact Phase A base SHA.

## 5. Safe execution environment

Use a parameterized root:

```bash
: "${OSSTACK_WORKTREES_ROOT:=$HOME/Developer/worktrees}"
mkdir -p "$OSSTACK_WORKTREES_ROOT"
test -d "$OSSTACK_WORKTREES_ROOT"
df -P "$OSSTACK_WORKTREES_ROOT"
```

Do not hardcode a machine-private mount. If storage placement is an owner
policy, compare the `df` result with an owner-provided expected device value
outside the repository.

Every implementation worktree uses an isolated control-plane home:

```bash
mkdir -p "$PWD/.tmp/osstack-dev-home"
export OSSTACK_HOME="$PWD/.tmp/osstack-dev-home"
export OSSTACK_SOCKET="$OSSTACK_HOME/daemon.sock"
test "$OSSTACK_HOME" = "$PWD/.tmp/osstack-dev-home"
```

Never run a development CLI against the default user control-plane database.
Agent and deploy subprocesses receive a minimal environment allowlist. They
must not inherit notification URLs, approval signing material, CI tokens, or
unrelated parent secrets.

## 6. Phase A — Kimi adapter and fail-closed verifier

Authority:
`2026-07-27-kimi-adapter-verifier-implementation.md`, amended by ledger A-01
through A-05 and X-01.

Ordered work packages:

1. **A0 baseline and capability probe:** probe the real Kimi CLI on the Mac Mini
   for version, prompt mode, stream fields, agent-file/tool-policy support,
   authentication state, usage telemetry, timeout behavior, and attempted
   mutation. Commit only sanitized fixtures.
2. **A1 structured contract:** implement the review contract, stable finding
   fingerprint, and the versioned `review` object in
   `packages/hermes-adapter/src/events.ts`; add a parse-preservation contract
   test.
3. **A2 parser:** parse complete, malformed, truncated, duplicate-sentinel, and
   non-approved results without treating exit code zero as approval.
4. **A3 adapter:** add `KimiCodeAdapter` with reviewer-only capabilities,
   adapter-reported runtime identity, bounded timeout, and observable usage or
   explicit `usage_unavailable`.
5. **A4 deterministic boundary:** reject secrets, forbidden paths, symlink
   escapes, oversized files, and oversized diffs before invoking Kimi.
6. **A5 isolation:** implement the Gate 0 isolation decision. Prove that writes
   to the builder worktree, ignored files, Git config, and hooks are blocked or
   detected and prevent delivery.
7. **A6 verifier:** fail closed on missing structured review, unknown judgment
   IDs, malformed review, non-approved verdict, mutation, or timeout.
8. **A7 evidence:** persist sanitized review Markdown, JSON, fingerprints,
   identity, usage, and checksums into loop events and proof.
9. **A8 diagnostics:** expose availability/authentication/capability state in
   `agent list` and `config doctor`; modify `packages/cli/src/config.ts`, not
   the control-plane doctor.
10. **A9 evaluation:** keep the fake offline corpus for deterministic CI and run
    a real Mac Mini corpus of at least 10 cases. The live scorecard must report
    zero false passes; false alarms are reported, not hidden.
11. **A10 release checkpoint:** documentation, changesets, package tests,
    repository gates, privacy scan, and Phase A PR.

Promotion evidence:

- fake adapter and contract suites;
- reviewer mutation tests covering ignored paths and Git internals;
- Hermes review-field preservation;
- real Kimi scorecard with at least 10 cases and zero false passes;
- no private data in committed fixtures;
- a `legacy` behavior check showing no Kimi activation outside the new path.

Rollback: disable Kimi registration/default selection; no Git or deployment
write path exists in this phase.

## 7. Phase B — profile routing and guarded-local

Authority:
`2026-07-27-kimi-profile-deliver-routing-implementation.md`, amended by ledger
B-01 through B-03.

Ordered work packages:

1. **B0 legacy snapshots:** before extraction, snapshot bare `deliver`, `loop
   run`, and `loop start` JSON/exit behavior and assert zero adapter probes in
   `legacy`.
2. **B1 runtime identity:** add configured/reported/inferred evidence grades.
   Only `reported` identity can prove RISK-R2 provider/model independence.
3. **B2 separated resolver:** resolve Builder/Evaluator/Designer with fallback
   or fail closed; preserve loop-engine `enforceRoleSeparation` as defense in
   depth.
4. **B3 profile:** make Kimi the Mac Mini evaluator default without embedding a
   private hostname or path in public defaults.
5. **B4 shared routing:** extract profile routing with the exact activation
   predicate:

   ```text
   explicitProfile || roleOverrides || guardedAutonomy ||
   (autoAgent && !executeCommand)
   ```

6. **B5 guarded-local:** extract `deliver`; use a zero-dependency offline
   fixture; preserve the fifth existing verification rule for
   `package.json` test scripts.
7. **B6 config identity display:** add the missing `config show`/`config doctor`
   task and tests. Output provider/model/evidence source but no secrets.
8. **B7 events, proof, and daemon:** make new summary fields optional or use a
   compatible subtype; persist routing in daemon RPC state and do not re-resolve
   after restart.
9. **B8 control and smoke:** store the profile name in metadata, build before
   smoke, and fail closed for legacy cards missing required metadata.
10. **B9 release checkpoint:** package/repository gates and Phase B PR.

Promotion evidence:

- legacy snapshots remain unchanged;
- guarded-local selects Kimi as Evaluator;
- configured/inferred identities cannot prove independence;
- runtime identity is reported in proof and config diagnostics;
- restart recovery does not silently re-resolve a different adapter.

Rollback: set `--autonomy legacy`; behavior matches B0 snapshots.

## 8. Phase C — guarded Git autonomy

Authority:
`2026-07-27-guarded-git-autonomy-implementation.md`, amended by ledger C-01
through C-04 and X-02/X-04/X-05.

Ordered work packages:

1. **C0 protocol:** add RISK-R0 through RISK-R4, legal states, scoped approval,
   signed decision metadata, and protocol envelope mapping (`"n"` for needs
   approval).
2. **C1 repository policy v2:** preserve v1 compatibility; read governing policy
   from the base commit, not the mutable builder worktree.
3. **C2 autonomy package and risk:** keep risk input deterministic and free of
   LLM signals. Protect `.env.*`, SQL DDL, privilege escalation, new network
   destinations, deploy scripts, and the autonomy kernel's own risk/approval/
   state-machine sources.
4. **C3 durable state:** migration 17, atomic transition log, per-repository
   single-writer constraint, restart recovery, and persisted-before-execute
   tests.
5. **C4 approval and state machine:** implement two-stage approval semantics.
   A matching post-diff decision resumes directly at `candidate_proof` without
   rerunning Builder. Production decisions use the signed external channel.
6. **C5 authoritative diff:** on a clean dedicated worktree, stage with
   `git add -A`, compute risk/proof/approval from the staged diff and porcelain
   status, and re-hash immediately before commit. A mismatch escalates with
   evidence.
7. **C6 GitHub delivery:** use injected argv execution; verify effective branch
   protection and at least one required check; make PR creation idempotent; bind
   merge to the pushed SHA with `--match-head-commit`; never use `--admin`.
8. **C7 progress and recovery:** bounded repairs, no-progress detection,
   bounded network retry, recoverable `blocked_delivery`, validated branch
   names, and action-scope checks before every external write.
9. **C8 proof:** candidate proof before push; final proof after remote evidence;
   failed evidence writes block subsequent side effects.
10. **C9 engine and CLI:** wire `guarded-git` through local and daemon paths,
    including resume without rebuilding an approved diff.
11. **C10 fixtures and attacks:** RISK-R1/R2/R3/R4 fixtures, untracked protected
    file, approval hash mismatch, added remote commit, zero checks, no
    protection, reviewer hook write, and SIGKILL restart.
12. **C11 release checkpoint:** documentation, changesets, full gates, and Phase
    C PR.

Promotion evidence:

- RISK-R1/R2 complete Git delivery in protected fixture repositories;
- RISK-R3 pauses before unauthorized write and resumes without rebuild only
  with a matching signed decision;
- RISK-R4 exposes no approval transition;
- untracked protected files are present in risk/proof/approval inputs;
- zero checks or ambiguous protection produces `blocked_delivery`;
- merge argv contains the exact pushed SHA.

Rollback: set `guarded-local`; no remote writes occur.

## 9. Phase D — guarded deployment and Mac Mini operations

Authority:
`2026-07-27-deploy-mac-mini-operations-implementation.md`, amended by ledger
D-01 through D-04 and X-03/X-07.

Ordered work packages:

1. **D0 deploy schema:** use a closed change-type enum and deterministic
   `deriveChangeTypes`; unknown types deny. Define stricter private-overlay
   semantics, segment-boundary path matching, timezone validation, and
   cross-midnight windows.
2. **D1 script authority:** treat referenced command/verify/health/rollback
   scripts as RISK-R3. Store their digests, add a real rollback drill producer,
   and deny deployment when the latest drill is stale or its digests differ.
3. **D2 persistence:** migration 18, deploy/rollback state, durable production
   freeze, restart recovery, and audit linkage.
4. **D3 deploy runner:** argv arrays, `shell:false`, timeouts, cancellation,
   minimal environment allowlist, health failure, rollback, and post-rollback
   health evidence.
5. **D4 engine:** run deploy only after merge and policy eligibility; stage
   candidate/final proof correctly.
6. **D5 trusted decisions:** production freeze-clear and RISK-R3 approval use
   the signed external channel. Governance denies approval/freeze commands to
   Builder and Reviewer.
7. **D6 locks and recovery:** repository lock, machine semaphore, stale lock
   recovery, offline recovery, clock-jump detection, and idempotent resume.
8. **D7 notification outbox:** persist notifications for
   `awaiting_approval`, `escalated`, `deploy_frozen`, `rollback_failed`, and
   `delivery_evidence_failed`; redact diff and secrets; retry without changing
   the primary run outcome.
9. **D8 health and service:** check disk, network, Kimi, GitHub, deploy targets,
   outbox backlog, budget, power policy, and launchd state. Machine-wide power
   changes require `OWNER-GO-MACHINE`; record actual settings as evidence.
10. **D9 scorecards and task supply:** pre-register at least 30 distinct real
    RISK-R1/R2 tasks across at least two repositories before the soak.
11. **D10 soak:** deterministic dry soak first, then seven real days, five
    SIGKILL recoveries, three network interruptions, and three forced deploy
    failures with successful rollback.
12. **D11 release checkpoint:** runbook, changesets, full gates, Phase D PR, and
    the D-to-E promotion report.

Promotion evidence is defined in the companion deployment runbook.

Rollback: freeze production, disable `guarded-deploy`, restore the last healthy
artifact, run the pinned rollback command, verify health, and retain all
evidence/outbox items.

## 10. Phase E — productization and publication

Authority:
`2026-07-27-kimi-productization-release-implementation.md`, amended by ledger
E-01/E-02 and X-06.

Ordered work packages:

1. **E0 product gate:** verify the signed D soak report before creating the
   release branch.
2. **E1 readiness contract:** expose exact thresholds and machine-readable
   reasons.
3. **E2 portable defaults:** remove owner-specific hostnames, paths, publisher
   defaults, and implicit commands. `publish.enabled=true` requires an explicit
   command and otherwise fails closed.
4. **E3 Kimi setup:** distinguish not installed, not authenticated, and
   available; share the same state model across setup, doctor, and runtime.
5. **E4 Builder opt-in:** Kimi remains reviewer-only by default; Builder is an
   explicit capability and configuration choice.
6. **E5 assets:** prove profile/Markdown/fixture discovery from npm packages and
   the single binary.
7. **E6 platform matrix:** macOS supported by real soak, Linux experimental with
   fake/contract evidence, Windows unsupported until tested.
8. **E7 clean install and migration:** fresh home, v1 config, pre-autonomy
   database, upgrade, downgrade/rollback, and old-proof verification.
9. **E8 documentation and privacy:** artifact-first scanner, public guides,
   bilingual README, migration guide, explicit allowlist for non-shipped test
   fixtures, and CI enforcement.
10. **E9 qualification:** full repository gates, package tarball inspection,
    single-binary string scan, clean-machine smoke, SBOM/signing/notarization as
    applicable, and release-candidate proof.
11. **E10 publication:** only with `OWNER-GO-PUBLISH`; publish, install from the
    public channel, run smoke, verify release metadata, and retain rollback
    artifacts.

Rollback: restore the previous package/binary channel, keep schema-compatible
data, set `legacy` or the last qualified guarded state, and publish a rollback
notice only after evidence is captured.

## 11. Verification discipline

For every implementation task:

1. write or identify the failing test;
2. run the narrow test and capture the expected failure;
3. implement the smallest change;
4. rerun the narrow test;
5. run the owning package test and typecheck;
6. run `git diff --check`;
7. make a focused conventional commit;
8. update the audit ledger from `PLAN_CLOSED` to `VERIFIED` only when the
   required implementation evidence exists.

Before every phase PR:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
git status --short
```

No task is complete when a command was skipped, timed out, or passed against
stale `dist`. Build before any CLI smoke that executes `dist`.

## 12. Stop and rollback conditions

Stop the current phase before the next side effect when:

- a Critical/High audit finding is reopened;
- current `origin/main` invalidates an interface or migration assumption;
- a reviewer can mutate the builder repository without prevention/detection;
- an approval cannot be traced to a trusted signed decision;
- a staged diff hash, pushed head SHA, proof digest, or script digest changes;
- branch protection/check requirements are absent or ambiguous;
- a secret/private identifier appears in an external-model request or release
  artifact;
- notification outbox or evidence persistence cannot durably record failure;
- rollback or post-rollback health fails;
- a named owner authority gate is not granted.

Do not "temporarily" lower a gate to continue. Record the state, preserve
evidence, and resume from the last legal transition after correction.

## 13. Definition of done

The program is done only when:

- every ledger Critical/High item is `VERIFIED`;
- all five phase PRs meet their promotion gates;
- the seven-day soak meets every count and integrity requirement;
- a real RISK-R2 allowlisted task completes guarded deployment with final proof;
- a real RISK-R3 task pauses with a signed, digest-bound approval request before
  any unauthorized write;
- a RISK-R4 task is permanently blocked;
- clean install, upgrade, rollback, package, binary, and privacy checks pass;
- the public artifact is installed and smoke-tested after publication;
- the previous release and operational rollback remain available.

## 14. Authoritative external references

- GitHub CLI `gh pr merge`, including `--match-head-commit`:
  https://cli.github.com/manual/gh_pr_merge
- GitHub protected-branch and required-status-check REST endpoints:
  https://docs.github.com/en/rest/branches/branch-protection
- GitHub effective repository rules for a branch:
  https://docs.github.com/en/rest/repos/rules
- GitHub rulesets can layer with branch-protection rules:
  https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
- GitHub required status checks must apply to the latest commit:
  https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks
- Local Mac power-setting semantics must be verified on the execution host with
  `man pmset`; do not copy a machine-wide setting from this plan blindly.

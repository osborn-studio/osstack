# Kimi Autonomy Audit Closure Ledger

> This ledger separates plan closure from implementation closure.
>
> Allowed plan states: `OPEN`, `PLAN_CLOSED`, `WAIVED_BY_OWNER`.
>
> Allowed implementation states: `NOT_STARTED`, `RED`, `GREEN`, `VERIFIED`.
>
> A row may become `PLAN_CLOSED` only when the exact phase plan contains the
> required correction, test target, and verification command. It may become
> `VERIFIED` only when the implementation evidence is linked.

## 1. Evidence format

For each state change, append:

```text
Plan evidence: <commit>:<file>:<line>
Implementation evidence: <commit>:<test-or-report>
Verification: <exact command and result>
Reviewer: <human or agent identity>
Date: <ISO-8601>
```

Do not delete original finding text. If a finding is disproved, preserve the
evidence and use `WAIVED_BY_OWNER` only when the owner accepts the residual
risk. Critical findings cannot be waived.

## 2. Original Critical and High findings

### A-01 — reviewer can mutate Git internals

- Severity: Critical
- Source: Plan A Task 6
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Attack: reviewer writes Git configuration, hooks, or ignored content; the old
  status/diff snapshot remains unchanged and a later commit executes the hook.
- Required plan correction:
  - do not call a linked worktree an isolation boundary;
  - select and test a native read-only policy or OS-enforced boundary;
  - snapshot builder Git config, hooks, ignored files, tracked files, staged
    state, and untracked files as defense in depth;
  - any mutation or incomplete snapshot blocks delivery and preserves evidence.
- Required tests:
  - `rejects reviewer write to git hook`;
  - `rejects reviewer write to git config`;
  - `rejects reviewer write to ignored file`;
  - `does not execute reviewer-created hook during commit`;
  - adversarial real-Kimi probe of the chosen isolation boundary.
- Verification:
  `pnpm --filter @osstack/loop test -- reviewer-isolation.test.ts`

### A-02 — wrong doctor target and capability contradiction

- Severity: High
- Source: Plan A Tasks 4 and 9
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Required plan correction:
  - modify `packages/cli/src/config.ts` and its config CLI tests;
  - Kimi advertises `code.review` and `release.verify` in Phase A;
  - Builder/debug capability remains opt-in until Phase E.
- Required tests:
  - installed, unauthenticated, unavailable diagnostics;
  - exact reviewer/test-verify roles without accidental coding role.
- Verification:
  `pnpm --filter @osstack/cli test -- config-cli.test.ts agent-list-cli.test.ts`

### A-03 — structured review stripped by Hermes schema

- Severity: High
- Source: Plan A Tasks 4 and 7
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Required plan correction:
  - add a versioned optional `review` object to
    `packages/hermes-adapter/src/events.ts`;
  - preserve it through Zod parsing and event transport;
  - a configured structured reviewer with no structured review fails closed.
- Required tests:
  - parse-preservation contract;
  - daemon/event round trip;
  - missing review yields error, never legacy approval.
- Verification:
  `pnpm --filter @osstack/hermes-adapter test && pnpm --filter @osstack/loop test -- verifier.test.ts`

### A-04 — seeded-defect gate is tautological

- Severity: High
- Source: Plan A Task 10
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Required plan correction:
  - keep fake offline evaluation for transport/fail-closed CI;
  - add a real Mac Mini `--live` evaluation of at least 10 cases;
  - score against deterministic `expected_finding_rules`;
  - A-to-B requires zero live false passes.
- Required evidence:
  `docs/reports/kimi-autonomy/phase-a-live-kimi-scorecard.json`
- Verification:
  `node scripts/eval-kimi-review.mjs --live --json`

### A-05 — machine-private paths in executable plan

- Severity: High
- Source: all phase worktree tasks
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Required plan correction:
  - use `OSSTACK_WORKTREES_ROOT`;
  - declare the execution host for each real probe/soak;
  - inspect configured storage without a private mount label.
- Required verification:
  a privacy/portability scan of all amended plans returns zero.

### B-01 — legacy behavior changes implicitly

- Severity: High
- Source: Plan B Tasks 5 and 6
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Required plan correction:
  - add pre-change snapshots for bare `deliver`, `loop run`, and `loop start`;
  - assert zero profile/adapter probes in `legacy`;
  - use the exact guarded activation predicate from the execution controller.
- Required tests:
  - `preserves bare deliver legacy output`;
  - `does not probe adapters in legacy mode`;
  - `activates profile routing only in guarded modes or explicit routing`.
- Verification:
  `pnpm --filter @osstack/cli test -- deliver-cli.test.ts loop-profile-routing.test.ts`

### B-02 — config identity acceptance has no implementation task

- Severity: High
- Source: Plan B Task 9 acceptance
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Required plan correction:
  add a task modifying `packages/cli/src/config.ts` with tests for provider,
  model, evidence source, and secret redaction.
- Verification:
  `pnpm --filter @osstack/cli test -- config-cli.test.ts`

### B-03 — configured identity can self-prove independence

- Severity: High
- Source: Plan B Tasks 2 and 3
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Required plan correction:
  - only `reported` identity can satisfy RISK-R2 independence;
  - `configured` or `inferred` identity produces `pass:false`;
  - proof records both evidence sources and the failure reason.
- Required tests:
  - configured K3 identity cannot prove independence;
  - inferred identity cannot prove independence;
  - two reported, distinct providers/models can.
- Verification:
  `pnpm --filter @osstack/config test -- runtime-identity.test.ts resolver.test.ts`

### C-01 — post-diff RISK-R3 approval livelock

- Severity: High
- Source: Plan C Tasks 7 and 11
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Required plan correction:
  - add legal `awaiting_approval -> candidate_proof` resume for a matching
    post-diff signed decision;
  - do not rerun Builder;
  - define preflight approval as build/verify only and post-diff approval as the
    authority for delivery actions.
- Required test:
  `resumes approved post-diff run without invoking runLocal`.
- Verification:
  `pnpm --filter @osstack/autonomy test -- state-machine.test.ts engine.test.ts`

### C-02 — untracked files bypass risk and proof

- Severity: High
- Source: Plan C Tasks 4, 11, and 13
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Required plan correction:
  use staged `git add -A` state plus porcelain status as the single diff input
  for risk, approval, candidate proof, and commit.
- Required tests:
  - untracked auth file becomes RISK-R3;
  - untracked file appears in candidate proof;
  - only approved staged content can commit.
- Verification:
  `pnpm --filter @osstack/autonomy test -- risk.test.ts engine.test.ts`

### C-03 — approval/proof-to-commit and PR-to-merge TOCTOU

- Severity: High
- Source: Plan C Tasks 9 and 11
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Required plan correction:
  - re-hash staged content immediately before commit;
  - mismatch becomes `escalated`;
  - bind merge to pushed SHA using `gh pr merge --match-head-commit`;
  - reject a changed remote head.
- Required tests:
  - staged mutation before commit blocks;
  - remote head change before merge blocks;
  - merge argv binds exact SHA.
- Verification:
  `pnpm --filter @osstack/github test -- delivery.test.ts && pnpm --filter @osstack/autonomy test -- engine.test.ts`

### C-04 — unprotected or zero-check repository fails open

- Severity: High
- Source: Plan C Tasks 9 and 13
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Required plan correction:
  - inspect effective protection, including documented ruleset behavior;
  - absent, ambiguous, or unauthorized protection lookup fails closed;
  - zero required checks fails closed;
  - successful checks must apply to the current pushed SHA.
- Required tests:
  no protection, ruleset-only protection, unauthorized lookup, zero checks,
  stale-SHA checks, and current-SHA success.
- Verification:
  `pnpm --filter @osstack/github test -- delivery.test.ts`

### D-01 — deploy/health/rollback script supply-chain gap

- Severity: High
- Source: Plan D Tasks 3 and 5
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Required plan correction:
  - parse all repository-local scripts referenced by effective deploy policy;
  - a change to one is RISK-R3;
  - production eligibility binds current digests to a successful rollback drill
    no older than 30 days.
- Required tests:
  changed rollback script escalates; unchanged drilled digest passes; stale or
  mismatched drill denies.
- Verification:
  `pnpm --filter @osstack/autonomy test -- risk.test.ts deploy-policy.test.ts`

### D-02 — open change-type vocabulary is self-asserted

- Severity: High
- Source: Plan D Tasks 2 and 3
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Required plan correction:
  use a closed enum and deterministic `deriveChangeTypes(changedPaths,
  diffStats)`; unknown means deny; LLM output is not an input.
- Required tests:
  exact path/stat table, segment-boundary counterexamples, and unknown denial.
- Verification:
  `pnpm --filter @osstack/autonomy test -- repo-policy.test.ts deploy-policy.test.ts`

### D-03 — owner notification is absent

- Severity: High
- Source: new Plan D notification task
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Required plan correction:
  - persist a redacted outbox item on five attention states;
  - retry with bounded backoff and idempotency key;
  - failed delivery does not rewrite the primary run result;
  - health and scorecard expose pending/dead-letter counts.
- Required tests:
  fake server success, timeout, retry, duplicate suppression, restart recovery,
  redaction, and dead-letter visibility.
- Verification:
  `pnpm --filter @osstack/cli test -- autonomy-notification.test.ts autonomy-health.test.ts`

### D-04 — freeze clear and approval actor are self-declared

- Severity: High
- Source: Plan D Task 7 and Plan C Task 12
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Required plan correction:
  - verify externally signed owner decisions for production;
  - Builder/Reviewer never receive signing material;
  - nonce replay, expiry, digest mismatch, and scope mismatch fail closed;
  - governance denies approval/freeze commands to agent subprocesses;
  - TTY-only mode is marked development/break-glass and cannot clear a
    production freeze.
- Required tests:
  signature valid/invalid, replay, expired, wrong diff, wrong scope, agent
  command denial, and TTY production denial.
- Verification:
  `pnpm --filter @osstack/autonomy test -- approval.test.ts && pnpm --filter @osstack/governance test`

### E-01 — owner-specific publisher default ships in npm

- Severity: High
- Source: Plan E Tasks 3 and 9
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Required plan correction:
  remove the publisher command default; `enabled=true` requires explicit
  portable configuration and fails closed otherwise. Include runtime source,
  package tarball, and binary scans.
- Required tests:
  disabled-without-command is safe; enabled-without-command rejects; packaged
  artifacts contain no private path.
- Verification:
  `pnpm --filter @osstack/loop test -- publisher.test.ts`

### E-02 — privacy scan uses the wrong identity and scope

- Severity: High
- Source: Plan E Task 9
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Required plan correction:
  - artifact-first scan for usernames, home/volume paths, private hostnames,
    repository names, and credential patterns;
  - CI gate for npm tarballs, binary strings, public docs, runtime defaults, and
    templates;
  - explicit reviewed allowlist only for non-shipped fixtures, with reason and
    expiry;
  - no allowlist for a runtime default or shipped artifact.
- Required evidence:
  package and binary scan reports plus allowlist review.

## 3. New challenge findings

### X-01 — linked worktree isolation is a false boundary

- Severity: Critical
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Finding: linked worktrees share the common Git directory. "Disposable detached
  worktree" does not prevent writes to shared hooks/config and cannot close
  A-01.
- Closure: the phase plan names a proven native/OS-enforced boundary and an
  adversarial test. If the Kimi P0 probe cannot prove one, A-to-B is blocked.

### X-02 — TTY is not non-spoofable human identity

- Severity: High
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Finding: same-user code can allocate a pseudo-terminal. `isTTY` is useful UX,
  not authentication.
- Closure: production decisions are signed outside the agent trust domain;
  TTY-only approval is development/break-glass and cannot authorize production.

### X-03 — best-effort webhook can fail silently

- Severity: High
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Finding: "notification failure does not block" without an outbox makes an
  unattended approval/freeze/rollback failure permanently silent.
- Closure: durable outbox, retry, idempotency, dead-letter, and health visibility
  are explicit Plan D tasks.

### X-04 — branch protection endpoint is not the full ruleset model

- Severity: High
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Finding: repositories may use rulesets instead of legacy branch protection.
  Treating one endpoint's `404` as a full protection model can false-block;
  treating it as "no protection" without checking effective rules can misstate
  evidence.
- Closure: the GitHub adapter has an explicit effective-protection contract,
  tests both mechanisms, and fails closed on ambiguity.

### X-05 — privacy grep will flag safe fixtures or miss shipped transforms

- Severity: High
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Finding: scanning all source text with one regex creates false positives in
  redaction tests, while scanning only source misses bundler/package transforms.
- Closure: artifact-first zero-tolerance gates plus a reviewed expiring
  non-shipped-fixture allowlist.

### X-06 — public worktree instructions still encode a private device assumption

- Severity: Medium
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Closure: inspect the configured root's actual device; no literal private
  device label appears in plans, source, defaults, or examples.

### X-07 — webhook/signing secrets can leak through inherited environments

- Severity: High
- Plan state: PLAN_CLOSED
- Implementation state: NOT_STARTED
- Finding: limiting only deploy-runner variables does not protect secrets from
  Builder, Reviewer, or other tool subprocesses.
- Closure: central minimal environment builder; explicit per-adapter allowlist;
  tests inject fake notification/signing secrets and prove child processes
  cannot read them.

## 4. Medium and Low assignment checklist

These do not block Gate 0 when each is assigned to an exact task and test:

- [x] A: run-ID naming, real stream-field arbitration, agent-file probe, Kimi
  timeout ownership, prompt construction, intentional unknown-ID behavior,
  fingerprint stability, and module-path convention.
- [x] B: guarded-only separation failure, daemon file anchors and restart
  semantics, compatible loop summary type, fifth verify rule, zero-dependency
  fixture, stored profile argv, build-before-smoke, and type-only package
  boundary.
- [x] C: action-scope enforcement, approval audit linkage, protocol status
  mapping, recoverable delivery state, PR idempotency, loop dependency,
  `.env.*`, SQL/privilege/network rules, autonomy self-protection, base-commit
  policy, branch validation, and SIGKILL semantics.
- [x] D: minimal child environment, rollback drill producer, stricter overlay
  semantics, timezone/cross-midnight rules, power policy, real-task supply,
  clock jumps, log rotation, proof retention, and launchd real-host evidence.
- [x] E: Kimi three-state diagnosis, platform matrix, actual config/template
  terminology, Markdown asset copy, old-proof verification, bilingual README,
  and failing-test-first steps.

## 5. Plan closure evidence map

The `PLAN_CLOSED` rows above are implemented in the planning suite as follows:

| Finding IDs | Plan evidence |
|---|---|
| A-01..A-05, X-01, X-07 | `2026-07-27-kimi-adapter-verifier-implementation.md`, `v3 mandatory amendments` A.1–A.7 |
| B-01..B-03 | `2026-07-27-kimi-profile-deliver-routing-implementation.md`, `v3 mandatory amendments` B.1–B.5 |
| C-01..C-04, X-02, X-04, X-07 | `2026-07-27-guarded-git-autonomy-implementation.md`, `v3 mandatory amendments` C.1–C.6 |
| D-01..D-04, X-03, X-07 | `2026-07-27-deploy-mac-mini-operations-implementation.md`, `v3 mandatory amendments` D.1–D.7 |
| E-01..E-02, X-05, X-06 | `2026-07-27-kimi-productization-release-implementation.md`, `v3 mandatory amendments` E.1–E.5 |
| X-01..X-07 cross-phase authority | `2026-07-27-kimi-code-mac-mini-autonomy.v2.md` invariants 16–20, the design §20 errata, and `2026-07-27-kimi-autonomy-execution-control-v3.md` |

The final audit verdict records the commit SHA after these documents are
committed. Implementation states remain `NOT_STARTED` until code/test evidence
exists.

## 6. Final ledger gate

Before Phase A begins:

- [x] A-01 through E-02 are `PLAN_CLOSED`.
- [x] X-01 through X-07 are `PLAN_CLOSED`.
- [x] every Medium/Low item is assigned or explicitly waived.
- [ ] the amended plan commit is recorded in the final audit verdict.

Before public release:

- [ ] A-01 through E-02 are `VERIFIED`.
- [ ] X-01 through X-07 are `VERIFIED`.
- [ ] all owner waivers are listed in release notes with residual risk.

# Kimi Profile Delivery — Phase B Validation

Date: 2026-07-28

Branch: `feat/kimi-profile-deliver`

Phase A merge baseline: `16ec9145cbc31c012a20b9c0246fe90240d746f6`

## Decision

Phase B is ready for pull-request review.

The guarded-local path completed one real disposable delivery with a Claude
Builder and Kimi Code Evaluator. Deterministic tests, structured review, strict
governance, identity evidence, proof generation, and worktree cleanup all
passed. Phase B does not authorize push, pull-request creation, merge,
deployment, or any other remote mutation.

## Scope delivered

- Adapter/provider/model/profile identity in configuration and diagnostics.
- Mac Mini role profile with Claude Code as Builder and Kimi Code as primary
  test/verify Evaluator.
- Exact opt-in routing predicate that preserves the legacy `deliver` path.
- `guarded-local` delivery with required Git worktree, verification command,
  strict governance, separated roles, and complete proof artifacts.
- Profile and both runtime identities persisted into loop events, daemon state,
  reports, scorecards, and proof.
- Contract creation freezes `profile_name`; approval emits shell-safe,
  structured guarded-local argv.
- Contracts created before profile binding fail closed and require re-signing.
- Operator runbook for configuration, smoke verification, delivery, and
  fail-closed triage.

## Adversarial findings resolved during final validation

### 1. Development smoke could execute an older installed binary

`pnpm --filter @osstack/cli exec osstack` resolved to a machine-installed
binary instead of the freshly built workspace binary. Its output omitted the
Kimi adapter and Phase B identity fields.

Resolution:

- Development smoke commands now invoke
  `node packages/cli/dist/bin.js` after building current `dist`.
- The runbook explains the stale-shim risk.

### 2. Headless Builder lacked write permission

The Claude SDK intentionally disables write/command tools unless
`OSSTACK_AUTOAPPROVE=1` is set. The original smoke command omitted this
single-run opt-in, so a headless Builder could not complete the contract.

Resolution:

- The runbook scopes `OSSTACK_AUTOAPPROVE=1` to the single, human-approved,
  guarded-local invocation.
- It explicitly forbids persisting the setting in a shell or daemon
  environment.

### 3. Cancelled Builder output could be promoted

The first real writable smoke reached the legacy 120-second execution timeout.
The Builder emitted `cancelled`, but its partial work passed deterministic
verification and Kimi review, allowing the task to be recorded as success and
merged. This violated fail-closed execution.

Resolution:

- Verification now emits blocking rule
  `execute.outcome_not_completed` for both `failed` and `cancelled` Builder
  outcomes.
- Passing tests or review can no longer override an incomplete Builder run.
- Cancelled worktree changes are cleaned without merge.
- Guarded-local execution now uses a 600-second default command timeout and
  records it in task context.
- `--command-timeout-ms` is parsed and validated for explicit override.

Regression coverage proves:

- failed and cancelled execution both produce score `0`;
- cancelled changes with a passing verification command are not promoted or
  merged;
- invalid timeout values are rejected before Builder invocation.

## Real Mac Mini smoke evidence

The final smoke used a fresh, standalone Git repository copied from
`fixtures/guarded-local` and an isolated non-secret osstack home.

| Gate | Result |
|---|---|
| Profile | `mac-mini`, pinned |
| Builder | `claude-code` / `anthropic` / `claude-current` |
| Evaluator | `kimi-code` 0.29.1 / `kimi` / `kimi-code/k3` |
| Identity evidence | configured for Builder and Evaluator |
| Role independence | pass; distinct adapter ids |
| Builder terminal outcome | `completed` |
| Builder timeout budget | 600,000 ms |
| Changed paths | two bounded fixture source/test files |
| Deterministic verification | `node --test`, exit 0, four tests passed |
| Artifact verification | pass |
| Kimi structured verdict | `approved`, zero findings |
| Governance | strict, pass, zero findings |
| Worktree | local commit merged; temporary branch/worktree cleaned |
| Report and scorecard | generated |
| Proof directory/archive/manifest | generated |
| Remote push/PR/merge/deploy | not invoked |

The proof and raw JSON remained in the disposable fixture only. They were not
committed because they contain machine-specific absolute paths. This report
records the sanitized gate outcomes.

## Verification commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
git status --short
```

Targeted security regression:

```bash
pnpm --filter @osstack/loop exec vitest run \
  src/verifier.test.ts src/loop-engine.test.ts
pnpm --filter @osstack/cli exec vitest run \
  src/deliver-cli.test.ts src/start-control-cli.test.ts
```

Real local smoke:

```bash
OSSTACK_HOME="<isolated-home>" \
OSSTACK_AUTOAPPROVE=1 \
node packages/cli/dist/bin.js deliver \
  "Add a tested greeting helper" \
  --workspace "<disposable-git-fixture>" \
  --profile mac-mini \
  --autonomy guarded-local \
  --verify "node --test" \
  --worktree \
  --json
```

## Final adversarial audit closure

The pre-merge Codex audit found one inherited hook-execution gap in the
worktree lifecycle. Reviewer snapshots already detect writes to Git metadata,
ignored files, and hooks, but the later `git worktree add`, `git commit`, and
fast-forward `git merge` operations still honored repository hooks. A
reviewer-controlled process racing the final snapshot could therefore attempt
to execute a `post-checkout`, `pre-commit`, or `post-merge` hook.

The worktree lifecycle now passes `core.hooksPath=/dev/null` to all three
promotion operations. Regression tests install executable marker hooks and
prove that creating isolation, committing verified changes, and
fast-forwarding them never execute repository hook code.

## Promotion boundary

Phase B may merge only after:

1. the final full-repository commands above are green on the final commit;
2. CI is green on the pull request;
3. review confirms no secret, personal path, generated proof, or local runtime
   state entered the diff.

After merge, Phase C may begin guarded Git autonomy. Deployment and production
operations remain out of scope until the later promotion gates authorize them.

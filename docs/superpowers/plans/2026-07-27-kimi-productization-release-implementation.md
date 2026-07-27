# Kimi Autonomy Productization and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the proven Owner-specific Kimi/Mac Mini system into a portable, documented, upgrade-safe osstack capability and release it only after the real soak evidence satisfies the productization gate.

**Architecture:** Turn private machine assumptions into public profile templates and setup diagnostics, keep Kimi Builder capability opt-in, enforce an evidence-backed readiness gate, validate clean install and upgrade/rollback across supported platforms, and publish npm/single-binary artifacts through existing release workflows.

**Tech Stack:** TypeScript ESM, Zod, Vitest, pnpm/Changesets, npm packaging, Bun single binary, GitHub Actions, osstack release doctor/proof, Kimi Code CLI.

---

## Task 1: Prove the productization gate before creating a release branch

**Files:**

- Read-only soak evidence

- [ ] On the Mac Mini stable-serving installation, run:

```bash
osstack autonomy health --json
node scripts/soak-kimi-autonomy.mjs \
  --status \
  --require-productization \
  --report "$OSSTACK_HOME/reports/kimi-autonomy-soak-latest.json"
```

Precondition: `OSSTACK_HOME` is already set to the Mac Mini stable-serving installation's explicit data directory. Refuse to continue if it is unset or resolves to the default `~/.osstack`. The status command verifies the report checksum and its referenced proof; do not parse human prose or bypass a failed predicate.

Required readiness result:

```text
elapsed_days >= 7
real_task_count >= 30
repo_count >= 2
forced_restart_count >= 5
network_interruption_count >= 3
rollback_drill_count >= 3
unauthorized_r3_r4_count = 0
reviewer_mutation_escape_count = 0
proof_integrity_failure_count = 0
restart_recovery_rate = 1
rollback_success_rate = 1
unattended_r1_r2_completion_rate >= 0.85
high_severity_open_defects = 0
```

- [ ] If any condition fails, stop Plan E. Continue the soak and fix the responsible earlier phase; do not weaken the threshold.

- [ ] When green, export the redacted readiness JSON and final proof references to:

```text
docs/reports/kimi-autonomy-productization-readiness-2026-08.md
```

Use the actual completion month in the filename if the soak finishes after August 2026.

- [ ] Create the implementation worktree:

```bash
git fetch origin --prune
git worktree add -b feat/kimi-productization \
  /Users/gilbertchen/Documents/CODE/worktrees/osstack-kimi-productization \
  origin/main
cd /Users/gilbertchen/Documents/CODE/worktrees/osstack-kimi-productization
corepack enable pnpm
pnpm install --frozen-lockfile
mkdir -p "$PWD/.tmp/osstack-dev-home"
export OSSTACK_HOME="$PWD/.tmp/osstack-dev-home"
export OSSTACK_SOCKET="$OSSTACK_HOME/daemon.sock"
```

Expected: clean branch and green baseline.

## Task 2: Make readiness a first-class strict CLI contract

**Files:**

- Create: `packages/autonomy/src/readiness.ts`
- Create: `packages/autonomy/src/readiness.test.ts`
- Modify: `packages/autonomy/src/index.ts`
- Modify: `packages/cli/src/autonomy-command.ts`
- Modify: `packages/cli/src/autonomy-cli.test.ts`
- Test: exact thresholds and field output

- [ ] Define:

```ts
export interface ProductizationReadinessInput {
  elapsed_days: number;
  real_task_count: number;
  repo_count: number;
  forced_restart_count: number;
  network_interruption_count: number;
  rollback_drill_count: number;
  unauthorized_r3_r4_count: number;
  reviewer_mutation_escape_count: number;
  proof_integrity_failure_count: number;
  restart_recovery_rate: number;
  rollback_success_rate: number;
  unattended_r1_r2_completion_rate: number;
  high_severity_open_defects: number;
}

export interface ProductizationReadiness {
  ready: boolean;
  checks: Array<{
    id: string;
    pass: boolean;
    actual: number;
    required: string;
  }>;
}
```

- [ ] Add table tests for every threshold, including exact-boundary passes and one-step-below failures.

- [ ] Run:

```bash
pnpm --filter @osstack/autonomy test -- readiness.test.ts
```

Expected: failure before implementation.

- [ ] Implement `evaluateProductizationReadiness` as a pure function. Add CLI:

```text
osstack autonomy readiness --since-days 7 [--json]
osstack autonomy readiness --since-days 7 --field latest_run_id
osstack autonomy readiness --since-days 7 --field latest_proof_dir
```

Allow only a closed field set. Unknown fields return exit `1`. Not-ready returns exit `2`.

- [ ] Run:

```bash
pnpm --filter @osstack/autonomy test -- readiness.test.ts
pnpm --filter @osstack/cli test -- autonomy-cli.test.ts
pnpm --filter @osstack/autonomy typecheck
pnpm --filter @osstack/cli typecheck
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add packages/autonomy/src packages/cli/src
git commit -m "feat(autonomy): enforce productization readiness evidence"
```

## Task 3: Remove Owner-specific defaults and publish portable profiles

**Files:**

- Modify: `packages/config/src/config.ts`
- Modify: `packages/config/src/config.test.ts`
- Create: `packages/config/src/templates.ts`
- Create: `packages/config/src/templates.test.ts`
- Modify: `packages/config/src/index.ts`
- Modify: `packages/cli/src/config.ts`
- Modify: `packages/cli/src/i18n-cli.test.ts`
- Test: no private hostname/path and predictable fallback

- [ ] Replace hostname-specific built-ins with:

```ts
profiles: {
  "mac-mini": {
    match: { hostnames: [], model_hints: ["Macmini"] },
    roles: {
      coding: { primary: "claude-code", fallback: ["codex-cli"] },
      "test-verify": {
        primary: "kimi-code",
        fallback: ["codex-cli", "claude-cli"],
      },
      design: { primary: "claude-design", fallback: ["google-stitch"] },
    },
  },
  portable: {
    match: { hostnames: [], model_hints: ["MacBookPro"] },
    roles: {
      coding: { primary: "codex-cli", fallback: ["claude-code"] },
      "test-verify": {
        primary: "kimi-code",
        fallback: ["claude-code", "codex-cli"],
      },
      design: { primary: "google-stitch", fallback: ["claude-design"] },
    },
  },
}
```

- [ ] Add tests that scan default YAML/JSON for:

- `/Users/`;
- actual Owner hostnames;
- API-key/token assignments;
- local router ports;
- private repo paths.

Expected: none are present.

- [ ] Add public templates:

```text
mac-mini
portable
ci-review
custom
```

`ci-review` may select `kimi-code` only as evaluator and must not assume an interactive login is available; doctor must warn when authentication is absent.

- [ ] Extend:

```text
osstack config init --template mac-mini
osstack config init --template portable
osstack config init --template ci-review
```

Keep `config bind` for explicit hostname association.

- [ ] Run:

```bash
pnpm --filter @osstack/config test -- config.test.ts templates.test.ts
pnpm --filter @osstack/cli test -- i18n-cli.test.ts
pnpm --filter @osstack/config typecheck
pnpm --filter @osstack/cli typecheck
```

Expected: all tests pass and defaults contain no private identity.

- [ ] Commit:

```bash
git add packages/config/src packages/cli/src/config.ts \
  packages/cli/src/i18n-cli.test.ts
git commit -m "feat(config): publish portable Kimi profile templates"
```

## Task 4: Add a safe Kimi setup assistant

**Files:**

- Create: `packages/cli/src/kimi-setup.ts`
- Create: `packages/cli/src/kimi-setup.test.ts`
- Modify: `packages/cli/src/config.ts`
- Modify: `packages/cli/src/bin.ts`
- Test: installed, missing, unauthenticated, and noninteractive setup

- [ ] Add:

```text
osstack config setup kimi --profile mac-mini [--yes] [--json]
```

The command may:

- locate `kimi`;
- run `kimi --version`;
- run one explicit read-only prompt probe after `--yes`;
- update the selected role binding;
- write non-secret provider/model metadata;
- print official installation/login guidance.

The command may not:

- download or execute an installer;
- accept or persist an API key;
- print environment variables;
- modify Claude/Codex provider settings;
- enable production deployment.

- [ ] Write tests:

- missing binary returns `blocked` with install guidance;
- installed but prompt probe fails returns `blocked`;
- `--yes` is required before the prompt probe;
- config write is atomic;
- an existing custom fallback order is preserved;
- JSON contains no credential material;
- repeated setup is idempotent.

- [ ] Run:

```bash
pnpm --filter @osstack/cli test -- kimi-setup.test.ts
```

Expected: failure before implementation.

- [ ] Use the same `KimiCodeAdapter.isAvailable()` and runtime identity path as execution; do not duplicate subprocess parsing.

- [ ] Run:

```bash
pnpm --filter @osstack/cli test -- kimi-setup.test.ts
pnpm --filter @osstack/cli typecheck
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add packages/cli/src
git commit -m "feat(cli): guide safe Kimi profile setup"
```

## Task 5: Make Kimi Builder capability explicit and opt-in

**Files:**

- Modify: `packages/config/src/types.ts`
- Modify: `packages/config/src/config.test.ts`
- Modify: `packages/agents/src/adapters/kimi-code.ts`
- Modify: `packages/agents/src/adapters/kimi-code.test.ts`
- Modify: `packages/agents/src/index.ts`
- Modify: `packages/agents/src/adapter-conformance.test.ts`
- Modify: `packages/cli/src/config.ts`
- Test: default reviewer-only and opt-in Builder

- [ ] Add:

```ts
export const AgentFeatureConfig = z.object({
  kimi_code: z.object({
    builder_enabled: z.boolean().default(false),
  }).strict().default({ builder_enabled: false }),
}).strict().default({
  kimi_code: { builder_enabled: false },
});
```

Add `agent_features` to `OsstackConfig`.

- [ ] Refactor registry creation:

```ts
export interface DefaultAdapterOptions {
  kimiBuilderEnabled?: boolean;
}

export function defaultAdapters(
  options: DefaultAdapterOptions = {},
): AgentAdapter[];
```

- [ ] Tests must prove:

- default Kimi capabilities exclude `code.write` and `code.refactor`;
- opt-in adds both;
- reviewer mode remains read-only even when Builder is enabled;
- Builder mode cannot be selected as Evaluator for the same run;
- config doctor labels the feature experimental;
- enabling Builder does not alter provider/model identity;
- public templates keep it disabled.

- [ ] Run:

```bash
pnpm --filter @osstack/agents test -- kimi-code.test.ts adapter-conformance.test.ts
pnpm --filter @osstack/config test -- config.test.ts
```

Expected: opt-in tests fail before implementation.

- [ ] In Builder mode, use a separate packaged agent file:

```text
packages/agents/src/adapters/kimi-builder-agent.md
```

It may modify only `task.context.repo_path`, must respect osstack worktree scope, and remains subject to deterministic verification and an independent Evaluator. Do not reuse the review profile.

- [ ] Run:

```bash
pnpm --filter @osstack/agents test -- kimi-code.test.ts adapter-conformance.test.ts
pnpm --filter @osstack/config test -- config.test.ts
pnpm --filter @osstack/agents typecheck
pnpm --filter @osstack/config typecheck
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add packages/agents/src packages/config/src packages/cli/src/config.ts
git commit -m "feat(agents): make Kimi Builder an explicit opt-in"
```

## Task 6: Package agent profiles and fixtures correctly

**Files:**

- Modify: `packages/agents/package.json`
- Modify: `packages/agents/tsconfig.json`
- Create: `packages/agents/src/assets.test.ts`
- Modify: `packages/cli/tsup.config.ts`
- Modify: `scripts/build-single-binary.mjs`
- Modify: `scripts/smoke-portable-cli.mjs`
- Test: npm package and single binary asset discovery

- [ ] Ensure published assets include:

```text
dist/adapters/kimi-review-agent.md
dist/adapters/kimi-builder-agent.md
```

Do not publish test fixtures containing raw provider output unless the fixtures are synthetic and sanitized.

- [ ] Add tests:

- npm-packed `@osstack/agents` contains both agent files;
- `KimiCodeAdapter` resolves assets when installed from npm;
- single binary embeds or materializes both assets;
- missing asset returns a clear availability/configuration error;
- no absolute build-machine path appears in bundled JS or manifests.

- [ ] Run:

```bash
pnpm --filter @osstack/agents build
pnpm --filter @osstack/agents test -- assets.test.ts
pnpm build:single-binary
pnpm smoke:portable-cli
```

Expected: all commands pass.

- [ ] Commit:

```bash
git add packages/agents packages/cli/tsup.config.ts \
  scripts/build-single-binary.mjs scripts/smoke-portable-cli.mjs
git commit -m "fix(packaging): ship Kimi agent profiles portably"
```

## Task 7: Add cross-platform compatibility checks

**Files:**

- Create: `.github/workflows/kimi-autonomy.yml`
- Create: `packages/agents/src/kimi-platform.test.ts`
- Modify: `packages/cli/src/serve-install-cli.test.ts`
- Modify: `docs/runbooks/kimi-mac-mini-autonomy.md`
- Test: macOS and Linux behavior

- [ ] Workflow matrix:

```yaml
strategy:
  matrix:
    os: [macos-14, ubuntu-24.04]
    node: [20, 22]
```

Run:

```text
pnpm install --frozen-lockfile
pnpm --filter @osstack/agents test
pnpm --filter @osstack/config test
pnpm --filter @osstack/autonomy test
pnpm --filter @osstack/cli test
pnpm typecheck
```

Use fake Kimi/GitHub/deploy binaries only; CI does not require real model credentials.

- [ ] Add tests:

- path resolution works on POSIX separators;
- Windows-style paths in findings normalize without executing on Windows;
- launchd commands return a clear macOS-only error on Linux;
- guarded local/Git logic remains available on Linux;
- Mac Mini runbook is explicitly macOS-specific;
- missing Kimi is a normal unavailable adapter, not a process crash.

- [ ] Run locally:

```bash
pnpm --filter @osstack/agents test -- kimi-platform.test.ts
pnpm --filter @osstack/cli test -- serve-install-cli.test.ts
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add .github/workflows/kimi-autonomy.yml \
  packages/agents/src/kimi-platform.test.ts \
  packages/cli/src/serve-install-cli.test.ts \
  docs/runbooks/kimi-mac-mini-autonomy.md
git commit -m "ci: test Kimi autonomy on macOS and Linux"
```

## Task 8: Add clean-install and upgrade/rollback E2E

**Files:**

- Create: `scripts/smoke-kimi-clean-install.mjs`
- Create: `scripts/smoke-kimi-upgrade.mjs`
- Modify: `package.json`
- Modify: `packages/cli/src/upgrade.ts`
- Modify: `packages/cli/src/release-workflow.test.ts`
- Test: fresh home, v1 config, pre-autonomy DB, rollback

- [ ] Add scripts:

```json
"smoke:kimi-clean-install": "node scripts/smoke-kimi-clean-install.mjs",
"smoke:kimi-upgrade": "node scripts/smoke-kimi-upgrade.mjs"
```

- [ ] Clean-install smoke:

1. create a fresh temporary OSSTACK_HOME;
2. install packed npm artifacts into a temporary project;
3. use a fake Kimi binary;
4. run config setup;
5. run guarded-local fixture;
6. verify proof;
7. assert no path references the source checkout.

- [ ] Upgrade smoke:

1. create a schema-16 state database;
2. create a v1 config;
3. install current candidate;
4. migrate to schema 18;
5. preserve config and existing run evidence;
6. run an autonomy health check;
7. simulate failed binary health;
8. restore prior binary and database snapshot;
9. confirm the prior CLI can reopen the restored database.

- [ ] Add release tests proving the upgrade workflow drains active runs and does not auto-resume production after rollback.

- [ ] Run:

```bash
pnpm smoke:kimi-clean-install
pnpm smoke:kimi-upgrade
pnpm --filter @osstack/cli test -- release-workflow.test.ts
```

Expected: all commands exit `0`.

- [ ] Commit:

```bash
git add scripts/smoke-kimi-clean-install.mjs \
  scripts/smoke-kimi-upgrade.mjs package.json \
  packages/cli/src/upgrade.ts packages/cli/src/release-workflow.test.ts
git commit -m "test(release): verify Kimi clean install and rollback upgrade"
```

## Task 9: Complete public documentation and migration guidance

**Files:**

- Modify: `README.md`
- Create: `docs/guides/kimi-code.md`
- Create: `docs/guides/guarded-autonomy.md`
- Create: `docs/guides/mac-mini-remote-control.md`
- Modify: `docs/product/03_USER_JOURNEY_AND_USE_CASES.md`
- Modify: `docs/product/05_AI_AND_LLM_ARCHITECTURE.md`
- Modify: `docs/product/06_SKILLS_AND_AGENT_REGISTRY.md`
- Modify: `docs/product/11_TEST_AND_EVAL_PLAN.md`
- Modify: `docs/product/12_RUNBOOK.md`
- Test: links, examples, and terminology

- [ ] Document separately:

1. Kimi Code as independent adapter/evaluator;
2. K3 as a provider/model used inside Claude Code or Codex;
3. Stitch/Claude Design as design roles;
4. deterministic test commands;
5. guarded autonomy risk and approval;
6. Git and deploy side effects;
7. Mac Mini remote observation via CodeX pairing or Screen Sharing.

- [ ] Include this example:

```yaml
agent_runtime:
  claude-code:
    provider_id: kimi
    model_id: k3-256k
    agent_profile: claude-code-k3
  kimi-code:
    provider_id: kimi
    model_id: k3-256k
    agent_profile: osstack-kimi-review
```

Explain that this same-provider pairing satisfies adapter separation but does not satisfy the default R2 provider-or-model independence unless the actual model differs. Recommend a native Claude/Codex Builder when Kimi is the Evaluator for R2.

- [ ] Add migration guidance:

```text
repo schema v1 -> v2
legacy deliver -> guarded-local
guarded-local -> guarded-git
guarded-git -> guarded-deploy
```

- [ ] Run:

```bash
pnpm lint
rg -n 'OsborNs-|/Users/gilbertchen|sk-[A-Za-z0-9-]{20,}' README.md docs
git diff --check
```

Expected: lint and diff pass; private-name/path/secret scan prints no matches in newly public documentation.

- [ ] Commit:

```bash
git add README.md docs/guides docs/product
git commit -m "docs: publish Kimi guarded autonomy guides"
```

## Task 10: Prepare changesets and release notes

**Files:**

- Create: `.changeset/kimi-autonomy-productization.md`
- Create: `docs/releases/kimi-autonomy.md`
- Modify: package changelogs
- Modify: `docs/2026-06-22-release-readiness.md`

- [ ] Add changeset covering:

```markdown
---
"@osstack/agents": minor
"@osstack/config": minor
"@osstack/autonomy": minor
"@osstack/cli": minor
---

Productize Kimi Code profiles, setup, portable packaging, and optional Builder support after the guarded-autonomy soak gate.
```

- [ ] Release notes must include:

- feature summary;
- experimental/stable labels;
- supported platforms;
- Kimi login prerequisite;
- schema migrations;
- default behavior and fallback;
- production deployment remains per-project opt-in;
- rollback instructions;
- links to readiness evidence and proof.

- [ ] Run:

```bash
pnpm lint
git diff --check
```

Expected: pass.

- [ ] Commit:

```bash
git add .changeset docs/releases/kimi-autonomy.md \
  docs/2026-06-22-release-readiness.md packages/*/CHANGELOG.md
git commit -m "docs(release): prepare Kimi autonomy release"
```

## Task 11: Full release qualification

**Files:**

- Verify only

- [ ] Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm eval:kimi-review
pnpm smoke:guarded-git
pnpm test:soak-kimi-autonomy
pnpm smoke:kimi-clean-install
pnpm smoke:kimi-upgrade
pnpm smoke:npm-install
pnpm smoke:portable-cli
pnpm build:single-binary
pnpm smoke:bun-single-binary
git diff --check
git status --short
```

Expected: every command exits `0`; worktree clean.

- [ ] Run release doctor against the candidate proof:

```bash
OSSTACK_HOME="$PWD/.tmp/osstack-release-doctor" \
  pnpm --filter @osstack/cli exec osstack release doctor \
  --target all \
  --workspace "$PWD" \
  --proof-dir "$PWD/release/osstack-proof-kimi-autonomy-release" \
  --json
```

Expected: `ok=true`, no missing proof/checksum, and no unresolved release blocker.

- [ ] Run the clean Mac Mini installed-binary smoke, not the source checkout:

```bash
osstack --version
osstack config doctor
osstack autonomy health --json
test ! -e "$PWD/.tmp/disposable-fixture"
mkdir -p "$PWD/.tmp/disposable-fixture"
cp -R "$PWD/fixtures/guarded-local/." "$PWD/.tmp/disposable-fixture/"
git -C "$PWD/.tmp/disposable-fixture" init -b main
git -C "$PWD/.tmp/disposable-fixture" add .
git -C "$PWD/.tmp/disposable-fixture" \
  -c user.name="osstack release smoke" \
  -c user.email="osstack-release-smoke@example.invalid" \
  commit -m "test: seed productization fixture"
osstack deliver "Update a non-production fixture document" \
  --workspace "$PWD/.tmp/disposable-fixture" \
  --profile mac-mini \
  --autonomy guarded-local \
  --worktree \
  --json
```

Expected: Kimi evaluation passes and candidate proof validates. If the fixed disposable path already exists, stop and inspect it; do not overwrite or reuse an unknown repository.

## Task 12: Pull request, merge, and publication

**Files:**

- GitHub/release actions only after all qualification gates

- [ ] Push and create:

```bash
git push -u origin feat/kimi-productization
gh pr create \
  --base main \
  --head feat/kimi-productization \
  --title "feat: productize Kimi guarded autonomy" \
  --body "Productizes the soaked Kimi/Mac Mini guarded-autonomy system. Includes portable profiles, safe setup, optional Kimi Builder, cross-platform tests, clean-install and upgrade rollback E2E, and release documentation."
```

- [ ] Wait for required CI, inspect the exact head SHA, and merge:

```bash
gh pr checks --watch --fail-fast
gh pr view --json number,url,headRefOid,mergeable,mergeStateStatus,statusCheckRollup
gh pr merge --squash --delete-branch
```

Expected: checks pass, head SHA matches the qualified commit, merge succeeds.

- [ ] On updated `main`, generate final release proof and run:

```bash
pnpm install --frozen-lockfile
pnpm build
OSSTACK_HOME="$PWD/.tmp/osstack-final-release" \
  pnpm --filter @osstack/cli exec osstack release doctor \
  --target all \
  --workspace "$PWD" \
  --proof-dir "$PWD/release/osstack-proof-kimi-autonomy-final" \
  --json
```

Expected: final release doctor is green.

- [ ] Publish only through the repository’s existing Changesets/npm/single-binary release workflow. After publication:

```bash
npm view @osstack/agents version
npm view @osstack/cli version
gh release view --json tagName,url,assets
```

Expected: published versions and release assets match the merged release metadata.

- [ ] Install the published CLI into a fresh temporary environment and rerun:

```bash
osstack --version
osstack config setup kimi --profile mac-mini --yes --json
osstack config show --profile mac-mini
```

Expected: published CLI detects Kimi, resolves Kimi as Evaluator, and emits no private path or credential.

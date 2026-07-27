# Kimi Profile and Deliver Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Mac Mini profile select Kimi Code as the default independent evaluator and make `deliver`, `loop run`, and `loop start` share the same identity-aware routing logic.

**Architecture:** Extend agent runtime identity without coupling credentials to osstack, teach `@osstack/config` to resolve separated roles, extract profile routing and `deliver` out of the monolithic CLI, and pass the complete routing evidence into loop events and proof. Preserve explicit CLI overrides and local `--execute` test paths.

**Tech Stack:** TypeScript ESM, Zod, Vitest, osstack config YAML, agent adapters, loop events, CLI JSON contracts.

> **v3 execution amendment.** This plan is executable only together with
> `2026-07-27-kimi-autonomy-execution-control-v3.md` and ledger items B-01
> through B-03. The amendment section at the end of this file overrides
> conflicting task text.

**Execution hosts:** package and CLI work may run on any development host. The
installed-profile smoke runs on the registered Mac Mini with an isolated
development `OSSTACK_HOME`.

---

## Task 1: Create the Phase B worktree

**Files:**

- Verify Phase A baseline only

- [ ] Create the worktree after Phase A is merged:

```bash
git fetch origin --prune
: "${OSSTACK_WORKTREES_ROOT:=$HOME/Developer/worktrees}"
mkdir -p "$OSSTACK_WORKTREES_ROOT"
git worktree add -b feat/kimi-profile-deliver \
  "$OSSTACK_WORKTREES_ROOT/osstack-kimi-profile-deliver" \
  origin/main
cd "$OSSTACK_WORKTREES_ROOT/osstack-kimi-profile-deliver"
corepack enable pnpm
pnpm install --frozen-lockfile
mkdir -p "$PWD/.tmp/osstack-dev-home"
export OSSTACK_HOME="$PWD/.tmp/osstack-dev-home"
export OSSTACK_SOCKET="$OSSTACK_HOME/daemon.sock"
```

- [ ] Verify Phase A is present:

```bash
rg -n 'class KimiCodeAdapter' packages/agents/src/adapters/kimi-code.ts
pnpm --filter @osstack/agents test -- kimi-code.test.ts
pnpm --filter @osstack/loop test -- verifier.test.ts
```

Expected: the class is found and both suites pass.

## Task 2: Add configured runtime identity overrides

**Files:**

- Modify: `packages/config/src/types.ts`
- Modify: `packages/config/src/config.ts`
- Modify: `packages/config/src/config.test.ts`
- Modify: `packages/config/package.json`
- Create: `packages/config/src/runtime-identity.ts`
- Create: `packages/config/src/runtime-identity.test.ts`
- Modify: `packages/config/src/index.ts`
- Modify: `pnpm-lock.yaml`
- Test: adapter/provider/model identity merge

- [ ] Add failing tests for a configuration containing:

```yaml
version: 1
active_profile: auto
agent_runtime:
  claude-code:
    provider_id: kimi
    model_id: k3-256k
    agent_profile: claude-code-k3
  codex-cli:
    provider_id: openai
    model_id: gpt-5.6-codex
    agent_profile: codex-native
profiles: {}
defaults:
  roles:
    coding: { primary: claude-code, fallback: [codex-cli] }
    test-verify: { primary: kimi-code, fallback: [codex-cli, claude-cli] }
    design: { primary: claude-design, fallback: [google-stitch] }
```

Assert:

- no credential, endpoint token, or arbitrary environment map is accepted;
- provider/model overrides are normalized;
- adapter-reported values win over inferred values;
- configured values win over inferred values;
- an adapter mismatch is rejected.

- [ ] Run:

```bash
pnpm --filter @osstack/config test -- runtime-identity.test.ts config.test.ts
```

Expected: the new identity tests fail before the schema exists.

- [ ] Add:

```ts
export const AgentRuntimeIdentityOverride = z.object({
  provider_id: z.string().min(1),
  model_id: z.string().min(1),
  model_context_window: z.number().int().positive().optional(),
  reasoning_effort: z.string().min(1).optional(),
  agent_profile: z.string().min(1).optional(),
}).strict();
```

Add to `OsstackConfig`:

```ts
agent_runtime: z.record(z.string(), AgentRuntimeIdentityOverride).default({}),
```

Do not add API keys, base URLs with embedded credentials, headers, cookies, or arbitrary environment variables.

- [ ] Add `@osstack/agents: workspace:*` to `packages/config/package.json`. This dependency is one-way: agents depends on core, while agents does not depend on config. Use `AgentAdapter` and `AgentRuntimeIdentity` from `@osstack/agents` rather than duplicating the identity shape.

- [ ] Implement:

```ts
export async function resolveRuntimeIdentity(
  adapter: AgentAdapter,
  override?: AgentRuntimeIdentityOverride,
): Promise<AgentRuntimeIdentity> {
  const reported = await adapter.runtimeIdentity?.();
  if (reported !== undefined && reported.adapter_id !== adapter.id) {
    throw new Error(
      `runtime identity adapter mismatch: expected ${adapter.id}, got ${reported.adapter_id}`,
    );
  }
  if (reported !== undefined && reported.evidence_source === "reported") return reported;
  if (override !== undefined) {
    return {
      adapter_id: adapter.id,
      adapter_version: reported?.adapter_version ?? "unknown",
      auth_mode: agentAuthMode(adapter.id),
      provider_id: override.provider_id,
      model_id: override.model_id,
      ...(override.model_context_window !== undefined
        ? { model_context_window: override.model_context_window }
        : {}),
      ...(override.reasoning_effort !== undefined
        ? { reasoning_effort: override.reasoning_effort }
        : {}),
      ...(override.agent_profile !== undefined
        ? { agent_profile: override.agent_profile }
        : {}),
      ...(reported?.binary_path_sha256 !== undefined
        ? { binary_path_sha256: reported.binary_path_sha256 }
        : {}),
      evidence_source: "configured",
    };
  }
  return reported ?? {
    adapter_id: adapter.id,
    adapter_version: "unknown",
    auth_mode: agentAuthMode(adapter.id),
    provider_id: "unknown",
    model_id: "unknown",
    evidence_source: "inferred",
  };
}
```

- [ ] Run:

```bash
pnpm --filter @osstack/config test -- runtime-identity.test.ts config.test.ts
pnpm --filter @osstack/config typecheck
```

Expected: tests and typecheck pass.

- [ ] Commit:

```bash
git add packages/config/src packages/config/package.json pnpm-lock.yaml
git commit -m "feat(config): model adapter provider and model identity"
```

## Task 3: Resolve Builder, Evaluator, and Designer with separation

**Files:**

- Modify: `packages/config/src/resolver.ts`
- Modify: `packages/config/src/resolver.test.ts`
- Modify: `packages/config/src/index.ts`
- Test: fallback and independence

- [ ] Add failing tests for:

1. coding primary `claude-code`, evaluator primary `kimi-code`;
2. evaluator primary equals the selected Builder, so evaluator falls back;
3. Kimi unavailable, so evaluator falls back to `codex-cli`;
4. all independent evaluators unavailable, so resolution is blocked;
5. explicit Builder still excludes itself from evaluator candidates;
6. provider/model independence:
   - same provider + same model fails;
   - same provider + different model passes;
   - different provider + same model passes;
   - unknown identity fails when R2 independence is required.

- [ ] Run:

```bash
pnpm --filter @osstack/config test -- resolver.test.ts
```

Expected: separation cases fail against `resolveAll`.

- [ ] Extend `ResolveOpts`:

```ts
export interface ResolveOpts {
  autoFallback?: boolean;
  excludeAgentIds?: ReadonlySet<string>;
}
```

Skip excluded candidates and record:

```ts
{ id, ok: false, reason: "excluded by role-separation policy" }
```

- [ ] Add:

```ts
export interface DeliveryRoleResolution {
  builder: RoleResolution;
  evaluator: RoleResolution;
  designer: RoleResolution;
  identities: {
    builder?: AgentRuntimeIdentity;
    evaluator?: AgentRuntimeIdentity;
    designer?: AgentRuntimeIdentity;
  };
  independent: boolean;
  independence_reason: string;
}
```

Implement `resolveDeliveryRoles` by:

1. resolving Builder;
2. resolving Evaluator with Builder adapter excluded;
3. resolving Designer independently;
4. resolving runtime identities;
5. returning `independent=false` when either Builder or Evaluator is absent.

Add:

```ts
export function runtimeIdentitiesIndependent(
  builder: AgentRuntimeIdentity,
  evaluator: AgentRuntimeIdentity,
  level: "adapter" | "provider-or-model",
): { pass: boolean; reason: string };
```

`adapter` requires different `adapter_id`. `provider-or-model` additionally requires known identities and either different `provider_id` or different `model_id`.

- [ ] Run:

```bash
pnpm --filter @osstack/config test -- resolver.test.ts
pnpm --filter @osstack/config typecheck
```

Expected: all separation and identity cases pass.

- [ ] Commit:

```bash
git add packages/config/src/resolver.ts packages/config/src/resolver.test.ts \
  packages/config/src/index.ts
git commit -m "feat(config): resolve separated delivery roles"
```

## Task 4: Make Kimi the Mac Mini evaluator default

**Files:**

- Modify: `packages/config/src/config.ts`
- Modify: `packages/config/src/config.test.ts`
- Modify: `README.md`
- Test: default profile snapshots

- [ ] Change the Mac Mini role map to:

```ts
const MAC_MINI_ROLES: RoleMap = {
  coding: { primary: "claude-code", fallback: ["codex-cli"] },
  "test-verify": {
    primary: "kimi-code",
    fallback: ["codex-cli", "claude-cli"],
  },
  design: { primary: "claude-design", fallback: ["google-stitch"] },
};
```

Keep the MacBook profile coding preference unchanged, but use:

```ts
"test-verify": {
  primary: "kimi-code",
  fallback: ["claude-code", "codex-cli"],
},
```

This makes Kimi the default evaluator on either machine when it is installed, while preserving different Builder defaults.

- [ ] Update tests to assert the exact primary and fallback arrays.

- [ ] Run:

```bash
pnpm --filter @osstack/config test -- config.test.ts
```

Expected: all config tests pass.

- [ ] Document that Claude Code or Codex may use K3 as their provider, while the independent evaluator remains the `kimi-code` adapter. Explain that adapter identity is not the same as provider identity.

- [ ] Commit:

```bash
git add packages/config/src/config.ts packages/config/src/config.test.ts README.md
git commit -m "feat(config): default Mac profiles to Kimi evaluation"
```

## Task 5: Extract shared loop profile routing from the CLI monolith

**Files:**

- Create: `packages/cli/src/loop-profile-routing.ts`
- Create: `packages/cli/src/loop-profile-routing.test.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `packages/cli/src/loop-cli.test.ts`
- Test: extraction parity and activation rules

- [ ] Move `resolveLoopProfileRouting`, `parseRoleOverrides`, and role normalization from `bin.ts` to `loop-profile-routing.ts` without behavior changes.

- [ ] Run:

```bash
pnpm --filter @osstack/cli test -- loop-cli.test.ts
```

Expected: existing loop profile tests remain green after the mechanical extraction.

- [ ] Add a pure activation helper:

```ts
export function shouldResolveExecutionProfile(input: {
  explicitProfile: boolean;
  roleOverrides: boolean;
  autoAgent: boolean;
  executeCommand: boolean;
  guardedAutonomy: boolean;
}): boolean {
  return input.explicitProfile
    || input.roleOverrides
    || input.autoAgent
    || input.guardedAutonomy
    || !input.executeCommand;
}
```

This keeps explicit local `--execute` test paths unchanged while making normal agent-backed `deliver`, `loop run`, and `loop start` honor `active_profile:auto`.

- [ ] Replace the old `resolveAll` call with `resolveDeliveryRoles`. Return an error when:

- Builder is missing;
- Evaluator is missing;
- Builder and Evaluator are not adapter-independent.

Keep explicit `--agent`, `--reviewer`, and `--checker` as highest-priority choices, but still validate their separation in guarded modes.

- [ ] Return this JSON-safe summary:

```ts
export interface LoopProfileSummary {
  profile_name: string;
  reason: string;
  builder_agent_id: string;
  evaluator_agent_id: string;
  designer_agent_id?: string;
  builder_identity: AgentRuntimeIdentity;
  evaluator_identity: AgentRuntimeIdentity;
  designer_identity?: AgentRuntimeIdentity;
  independent: boolean;
  independence_reason: string;
  overrides: Record<string, string>;
  resolutions: Record<string, {
    chosen: string | null;
    reason: string;
    tried: Array<{ id: string; ok: boolean; reason?: string }>;
  }>;
}
```

- [ ] Add tests proving:

- `active_profile:auto` resolves without an explicit `--profile`;
- local `--execute` alone does not probe adapters;
- explicit profile always resolves;
- an explicit same Builder/Evaluator pair errors;
- unavailable Kimi falls back;
- no independent fallback errors.

- [ ] Run:

```bash
pnpm --filter @osstack/cli test -- loop-profile-routing.test.ts loop-cli.test.ts
pnpm --filter @osstack/cli typecheck
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add packages/cli/src/loop-profile-routing.ts \
  packages/cli/src/loop-profile-routing.test.ts \
  packages/cli/src/bin.ts packages/cli/src/loop-cli.test.ts
git commit -m "refactor(cli): share identity-aware loop profile routing"
```

## Task 6: Extract `deliver` and add guarded-local mode

**Files:**

- Create: `packages/cli/src/deliver-command.ts`
- Create: `fixtures/guarded-local/package.json`
- Create: `fixtures/guarded-local/src/greeting.ts`
- Create: `fixtures/guarded-local/src/greeting.test.ts`
- Modify: `packages/cli/src/deliver-cli.test.ts`
- Modify: `packages/cli/src/bin.ts`
- Test: legacy parity and guarded-local defaults

- [ ] Move `handleDeliverCommand`, `suggestVerifyCommand`, and delivery-only helpers from `bin.ts` to `deliver-command.ts` without changing the public behavior.

- [ ] Run:

```bash
pnpm --filter @osstack/cli test -- deliver-cli.test.ts
```

Expected: all existing delivery tests pass after extraction.

- [ ] Add:

```ts
export const DeliverAutonomyMode = z.enum(["legacy", "guarded-local"]);
export type DeliverAutonomyMode = z.infer<typeof DeliverAutonomyMode>;
```

Parse `--autonomy`; default to `legacy` in Phase B. For `guarded-local`:

1. require a Git worktree;
2. resolve the profile even when `--profile` is absent;
3. require separated Builder/Evaluator;
4. enable artifact verification;
5. use explicit `--verify` commands, otherwise the detected verify command;
6. fail before execution when no verify command can be detected;
7. run governance in strict mode;
8. always produce report, scorecard, and candidate proof;
9. perform no push, PR, merge, or deploy.

- [ ] Use exact default verify detection already present:

```text
pnpm-lock.yaml -> pnpm test
bun.lock/bun.lockb -> bun test
package-lock.json -> npm test
yarn.lock -> yarn test
```

If none matches and no explicit `--verify` exists, return exit `2` with error code `verify_profile_missing`.

- [ ] Add a minimal, deterministic pnpm fixture whose initial test passes and whose requested change can be made without network access. Unit tests copy it to a temporary directory, initialize a local Git repository, and commit the baseline before invoking `deliver`; never run guarded delivery against the osstack source worktree itself.

- [ ] Add failing tests:

- guarded-local selects `claude-code` Builder and `kimi-code` Evaluator from a fake available registry;
- guarded-local auto-enables worktree and proof;
- missing verifier command blocks before Builder invoke;
- legacy mode preserves old behavior;
- guarded-local never calls fake GitHub/deploy ports.

- [ ] Run:

```bash
pnpm --filter @osstack/cli test -- deliver-cli.test.ts
```

Expected: guarded-local tests pass and legacy tests remain green.

- [ ] Commit:

```bash
git add packages/cli/src/deliver-command.ts \
  packages/cli/src/deliver-cli.test.ts packages/cli/src/bin.ts \
  fixtures/guarded-local
git commit -m "feat(cli): add profile-driven guarded local delivery"
```

## Task 7: Carry routing identity into loop events and proof

**Files:**

- Modify: `packages/loop/src/loop-engine.ts`
- Modify: `packages/loop/src/loop-engine.test.ts`
- Modify: `packages/loop/src/types.ts`
- Modify: `packages/cli/src/proof-pack.ts`
- Modify: `packages/cli/src/proof-pack.test.ts`
- Modify: `packages/cli/src/deliver-command.ts`
- Test: policy/runtime evidence

- [ ] Add to `LoopEngineOptions`:

```ts
profileRouting?: {
  profile_name: string;
  reason: string;
  builder_agent_id: string;
  evaluator_agent_id: string;
  designer_agent_id?: string;
  builder_identity: Record<string, unknown>;
  evaluator_identity: Record<string, unknown>;
  designer_identity?: Record<string, unknown>;
  independent: boolean;
  independence_reason: string;
};
```

- [ ] Write failing tests asserting:

- `loop.plan.done` includes profile and Builder identity;
- `loop.verify.done` includes Evaluator identity;
- proof `policy-decision.json` contains the profile and independence reason;
- proof `agent-runtime.json` contains adapter/provider/model for both roles;
- the proof redactor removes secrets from identity fields.

- [ ] Run:

```bash
pnpm --filter @osstack/loop test -- loop-engine.test.ts
pnpm --filter @osstack/cli test -- proof-pack.test.ts
```

Expected: evidence assertions fail before the event fields are added.

- [ ] Add routing evidence to events at the current plan and verify emission sites. Update proof mapping to prefer event-supplied runtime identity over `agentAuthMode` inference.

- [ ] Pass `profileRouting.summary` into every local and daemon `LoopEngine` path. Extend daemon RPC parameter validation and session persistence so restart recovery keeps the same routing decision rather than re-resolving to a different agent mid-run.

- [ ] Run:

```bash
pnpm --filter @osstack/loop test -- loop-engine.test.ts
pnpm --filter @osstack/cli test -- proof-pack.test.ts daemon-loop.test.ts
pnpm --filter @osstack/loop typecheck
pnpm --filter @osstack/cli typecheck
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add packages/loop/src packages/cli/src
git commit -m "feat(proof): record delivery role and runtime identity"
```

## Task 8: Update start/control to emit guarded-local delivery

**Files:**

- Modify: `packages/cli/src/start-control-command.ts`
- Modify: `packages/cli/src/start-control-cli.test.ts`
- Test: shell-safe command and raw argv

- [ ] Update the approved contract’s raw argv to include:

```ts
[
  "deliver",
  meta.goal,
  "--workspace",
  meta.repo_path,
  "--verify",
  meta.verify_command,
  "--autonomy",
  "guarded-local",
  "--worktree",
  "--profile",
  "mac-mini",
]
```

Do not hardcode `mac-mini` when the contract metadata contains a selected profile; add `profile_name` to `ContractMeta` and store the resolved profile at `start`.

- [ ] Add tests that:

- raw `deliver_args` contain the exact tokens;
- human command remains POSIX-safe for hostile goal text;
- an approved contract cannot emit `legacy`;
- an absent Kimi adapter causes delivery to fail closed at execution time, not approval time.

- [ ] Run:

```bash
pnpm --filter @osstack/cli test -- start-control-cli.test.ts
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add packages/cli/src/start-control-command.ts \
  packages/cli/src/start-control-cli.test.ts
git commit -m "feat(cli): authorize guarded profile delivery from contracts"
```

## Task 9: Mac Mini configuration smoke

**Files:**

- Create: `docs/runbooks/kimi-profile-routing.md`
- Test: installed configuration with isolated development home

- [ ] Add a runbook with this non-secret Mac Mini config:

```yaml
version: 1
active_profile: mac-mini
agent_runtime:
  claude-code:
    provider_id: anthropic
    model_id: claude-current
    agent_profile: claude-code-native
  kimi-code:
    provider_id: kimi
    model_id: k3-256k
    agent_profile: osstack-kimi-review
profiles:
  mac-mini:
    match:
      hostnames: []
      model_hints: [Macmini]
    roles:
      coding:
        primary: claude-code
        fallback: [codex-cli]
      test-verify:
        primary: kimi-code
        fallback: [codex-cli, claude-cli]
      design:
        primary: claude-design
        fallback: [google-stitch]
defaults:
  roles:
    coding:
      primary: claude-code
      fallback: [codex-cli]
    test-verify:
      primary: kimi-code
      fallback: [codex-cli, claude-cli]
    design:
      primary: claude-design
      fallback: [google-stitch]
```

The runbook must state that if Claude Code or Codex is configured to use K3, update `provider_id` and `model_id` honestly; this does not replace the independent `kimi-code` adapter.

- [ ] With a development home, run:

```bash
OSSTACK_HOME="$PWD/.tmp/osstack-profile-smoke" \
  pnpm --filter @osstack/cli exec osstack config show --profile mac-mini
OSSTACK_HOME="$PWD/.tmp/osstack-profile-smoke" \
  pnpm --filter @osstack/cli exec osstack config doctor
```

Expected:

- coding resolves to Claude Code or its configured fallback;
- test-verify resolves to Kimi Code;
- the two adapter ids differ;
- runtime identity is present;
- no secret values appear.

- [ ] Commit:

```bash
git add docs/runbooks/kimi-profile-routing.md
git commit -m "docs: add Kimi profile routing runbook"
```

## Task 10: Phase B final verification and pull request

**Files:**

- Verify only

- [ ] Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
git status --short
```

Expected: all commands exit `0`; worktree clean.

- [ ] Run guarded-local against a disposable fixture repository on the Mac Mini:

```bash
test ! -e "$PWD/.tmp/greeting-fixture"
mkdir -p "$PWD/.tmp/greeting-fixture"
cp -R "$PWD/fixtures/guarded-local/." "$PWD/.tmp/greeting-fixture/"
git -C "$PWD/.tmp/greeting-fixture" init -b main
git -C "$PWD/.tmp/greeting-fixture" add .
git -C "$PWD/.tmp/greeting-fixture" \
  -c user.name="osstack smoke" \
  -c user.email="osstack-smoke@example.invalid" \
  commit -m "test: seed guarded-local fixture"
OSSTACK_HOME="$PWD/.tmp/osstack-guarded-local-smoke" \
  pnpm --filter @osstack/cli exec osstack deliver \
  "Add a tested greeting helper" \
  --workspace "$PWD/.tmp/greeting-fixture" \
  --profile mac-mini \
  --autonomy guarded-local \
  --verify "pnpm test" \
  --worktree \
  --json
```

Expected:

- Builder and Kimi Evaluator differ;
- tests and Kimi review pass;
- candidate proof is written;
- no GitHub or deployment write occurs.

- [ ] Push and create the pull request:

```bash
git push -u origin feat/kimi-profile-deliver
gh pr create \
  --base main \
  --head feat/kimi-profile-deliver \
  --title "feat: route guarded delivery through Kimi profiles" \
  --body "Implements P3 of the approved Kimi Mac Mini autonomy design. Adds identity-aware separated Builder/Evaluator routing and guarded-local deliver."
```

Expected: a PR URL. Plan C starts only after CI is green and the PR is merged.

---

## v3 mandatory amendments

### B.1 Legacy snapshot before extraction

Before Task 5, add a red/characterization task that freezes:

- bare `deliver`, `loop run`, and `loop start` JSON, exit status, and command
  construction;
- zero profile resolution and zero adapter probes for bare `legacy` calls.

The guarded-routing activation predicate is exactly:

```text
explicitProfile || roleOverrides || guardedAutonomy ||
(autoAgent && !executeCommand)
```

Do not use `|| !input.executeCommand`.

### B.2 Evidence-graded runtime identity

Runtime identity contains `reported`, `configured`, or `inferred`
`evidence_source`. Adapter-reported values may override configuration for
observed runtime evidence, but configured/inferred values cannot prove
RISK-R2 provider/model independence.

Required resolver result when either side is not reported:

```ts
{
  pass: false,
  reason: "configured/inferred identity cannot prove provider independence",
}
```

Proof records both evidence sources and the independence reason. Keep
`enforceRoleSeparation` in `@osstack/loop` as defense in depth; guarded modes
also fail during routing when independence cannot be proven.

### B.3 Missing config diagnostics task

Insert a task after routing extraction:

**Files:**

- Modify: `packages/cli/src/config.ts`
- Create or modify: `packages/cli/src/config-cli.test.ts`

`config show` and `config doctor` display adapter, provider, model, profile, and
evidence source for each role without emitting credentials or arbitrary
environment values.

### B.4 Deliver fixture and verification parity

The guarded-local fixture is zero-dependency and uses `node --test` plus a
committed lockfile when needed. Preserve the existing fifth inference rule:
when `package.json` defines a test script, infer the package-manager test
command.

### B.5 Events, proof, and daemon

- Use actual `LoopRunOptions`, not `LoopEngineOptions`.
- Keep new profile summary fields optional for old callers or introduce a
  compatible subtype.
- Task 7 additionally modifies `packages/cli/src/daemon.ts` and
  `packages/cli/src/daemon-loop.test.ts`.
- Persist `profileRouting` in daemon RPC/run state; restart recovery reuses it
  and never silently resolves a different adapter.
- Store the selected profile name in contract metadata. Approval/resume argv
  uses `--profile <meta.profile_name>`; an old card with no profile name fails
  closed and requests re-signing.
- Build current `dist` before every CLI smoke.
- Any cross-package config-to-agent dependency uses type-only imports where
  possible and must not introduce a second Zod runtime boundary.

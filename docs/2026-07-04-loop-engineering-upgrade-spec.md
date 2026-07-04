# osstack Loop Engineering Upgrade Spec

> Date: 2026-07-04
> Audience: Claude / coding agent implementation session
> Target repo: `/Users/gilbertchen/Documents/CODE/agentsteam/osstack`
> Status: Draft for implementation

## 1. One-Line Goal

Upgrade osstack Loop Engineering from a runnable loop runtime into a reliable Senior-Manager-style self-converging engineering system: discover bounded work, execute in isolated worktrees, verify with robust evaluation, feed failures back into the next attempt, externalize state, control cost, and preserve human authority over priorities.

## 2. Background

The current osstack loop runtime already implements the core skeleton:

- `packages/loop/src/loop-engine.ts`: `Discover -> Plan -> Execute -> Verify -> Iterate -> State`
- `packages/loop/src/discover.ts`: `git_diff`, `github_branch`, `task_queue`
- `packages/loop/src/verifier.ts`: shell verifier commands, verifier adapters, artifact verification
- `packages/loop/src/iterator.ts`: stop / continue / escalate decisions
- `packages/agents/src/worktree.ts`: per-task git worktree creation, commit, merge, cleanup
- `packages/cli/src/daemon.ts`: daemon-managed loop sessions, cron/interval loops, stats, persistence
- `LOOP-STATE.json` and `STATE.md`: machine-readable and human-readable state

The gap is not "does osstack have a loop?" It does. The gap is loop quality: evaluation depth, feedback reuse, SOP compounding, task discovery governance, cost controls, and observability.

## 3. Product Principle

Loop Engineering is not "cron plus AI". It is a management system. The human should define what matters, what counts as done, what the agent may change, when to escalate, and how learning becomes reusable. The loop should automate execution and local iteration, not strategic direction.

Use these product principles:

1. Human owns priority and acceptance criteria.
2. Maker and checker must be structurally separated when trust matters.
3. A failed verification must become useful input to the next attempt.
4. The loop must stop when progress stalls or budget is exceeded.
5. Successful runs must produce reusable knowledge, not just code.
6. State must explain "why this happened", not only "what happened".

## 4. Current-State Assessment

### Strong Existing Pieces

- Worktree isolation is real and tested.
- Local and daemon loop paths exist.
- Task queue files are schema-backed JSON.
- CLI and daemon support `loop run`, `loop start`, `loop status`, `loop list`, `loop stop`.
- Verifier adapters and shell verification are already supported.
- Role separation enforcement exists.
- State/report/proof artifacts exist and have test coverage.

### Main Deficiencies

1. Verification is too shallow. It mostly checks command exit codes, adapter completion, artifact paths, and governance findings. It does not model evaluation harnesses as first-class specs.
2. Iteration is weak. A failing verdict causes another loop attempt, but the failure is not converted into structured maker feedback for the next attempt.
3. Task discovery is under-governed. AI can scan for work, but priority and auto-execution policy are not explicit enough.
4. SOP/memory compounding is missing. Successful lessons are not turned into reviewed skill drafts or reusable runbooks.
5. Cost controls are incomplete. `tokens_consumed` exists in state, but budgets are not enforced as stop conditions.
6. Observability is evidence-heavy but diagnosis-light. Reports show events, but do not clearly cluster failure modes, no-progress loops, verifier disagreements, or recurring issues.

## 5. Upgrade Scope

Implement the upgrade in five focused increments. Keep each increment independently testable.

### Increment A: EvaluationSpec

Create a first-class evaluation specification model.

New or modified files:

- `packages/loop/src/evaluation-spec.ts`
- `packages/loop/src/evaluation-spec.test.ts`
- `packages/loop/src/types.ts`
- `packages/loop/src/verifier.ts`
- `packages/loop/src/task-queue.ts`
- `loop-engineering/references/task-schema.md`

Add schema:

```ts
export const EvaluationSpec = z.object({
  id: z.string(),
  mode: z.enum([
    "command",
    "contract",
    "property",
    "e2e",
    "artifact",
    "semantic_review",
    "governance",
  ]),
  description: z.string(),
  required: z.boolean().default(true),
  command: z.string().optional(),
  target_paths: z.array(z.string()).default([]),
  forbidden_paths: z.array(z.string()).default([]),
  acceptance: z.string().optional(),
  weight: z.number().min(0).max(1).default(1),
});
```

Task queue files may include:

```json
{
  "task_id": "fix-auth-test",
  "capability": "code.fix",
  "prompt": "Fix auth test failures without weakening access control.",
  "priority": 90,
  "source": "task_queue",
  "evaluation": [
    {
      "id": "auth-tests",
      "mode": "command",
      "description": "Auth test suite passes.",
      "command": "pnpm test -- tests/auth",
      "required": true
    },
    {
      "id": "no-policy-bypass",
      "mode": "semantic_review",
      "description": "The fix must not bypass authorization or hardcode access outcomes.",
      "acceptance": "Reject changes that return constant allow/deny values, skip session validation, or remove negative tests.",
      "required": true
    }
  ]
}
```

Verifier behavior:

- Existing `--verify CMD` still works and becomes an implicit `EvaluationSpec` with mode `command`.
- `context.require_git_diff`, `context.files`, and artifact verification become implicit `artifact` specs.
- `semantic_review` specs should be passed to verifier adapters in structured context.
- The resulting `Verdict` should include per-spec results, not only one global pass/fail.

Acceptance criteria:

- Existing loop tests keep passing.
- New tests prove command, artifact, and semantic specs are parsed and surfaced in `Verdict`.
- `STATE.md` renders failed evaluation spec IDs and summaries.

### Increment B: Feedback-Carrying Iteration

Make the loop genuinely self-correcting across attempts.

New or modified files:

- `packages/loop/src/feedback.ts`
- `packages/loop/src/feedback.test.ts`
- `packages/loop/src/loop-engine.ts`
- `packages/loop/src/executor.ts`
- `packages/loop/src/types.ts`

Add schema:

```ts
export const IterationFeedback = z.object({
  attempt: z.number(),
  verdict_summary: z.string(),
  blocking_issues: z.array(Issue),
  failed_evaluations: z.array(z.string()),
  suggested_focus: z.array(z.string()).default([]),
  previous_diff_summary: z.string().optional(),
});
```

Behavior:

- After each failed `Verdict`, derive `IterationFeedback`.
- Pass feedback into the next `executePlan` call through `AgentTask.context.iteration_feedback`.
- For local command execution, expose feedback via a temp JSON file path in env if practical.
- For adapter execution, include feedback in structured context and prompt framing.
- Record feedback in `CompletedTask` and `STATE.md`.

Acceptance criteria:

- A test adapter receives first-attempt verifier issues in second-attempt context.
- `loop.iterate.done` events include failed evaluation IDs and issue count.
- If two consecutive attempts produce the same issue fingerprint and same changed files, trigger no-progress escalation.

### Increment C: Discovery Governance

Separate "discovering possible work" from "authorizing execution".

New or modified files:

- `packages/loop/src/discovery-policy.ts`
- `packages/loop/src/discovery-policy.test.ts`
- `packages/loop/src/discover.ts`
- `packages/loop/src/loop-engine.ts`
- `packages/loop/src/types.ts`
- CLI parsing in `packages/cli/src/bin.ts`

Add task authorization:

```ts
export const TaskAuthorization = z.enum([
  "auto_execute",
  "needs_approval",
  "suggest_only",
  "blocked",
]);
```

Add policy config:

```ts
export const DiscoveryPolicy = z.object({
  default_authorization: TaskAuthorization.default("needs_approval"),
  auto_execute_capabilities: z.array(z.string()).default([]),
  blocked_capabilities: z.array(z.string()).default([]),
  blocked_paths: z.array(z.string()).default([]),
  max_auto_priority: z.number().min(0).max(100).default(80),
});
```

Behavior:

- `task_queue` tasks may opt into `auto_execute`.
- `git_diff` should default to `suggest_only` or review-only unless explicitly authorized.
- `github_branch` should default to `needs_approval` unless configured.
- Blocked tasks should appear in state/report but not execute.

Acceptance criteria:

- Tests prove unauthorized discovered tasks are not executed.
- `STATE.md` has sections for executed, needs approval, suggested, and blocked tasks.
- CLI supports a conservative default without breaking existing tests. If preserving current behavior is necessary, default legacy local runs to auto-execute only for explicit `task_queue` tasks.

### Increment D: Budget And Stop Controls

Make cost and progress limits first-class.

New or modified files:

- `packages/loop/src/budget.ts`
- `packages/loop/src/budget.test.ts`
- `packages/loop/src/types.ts`
- `packages/loop/src/loop-engine.ts`
- `packages/cli/src/bin.ts`
- `packages/cli/src/daemon.ts`

Add schema:

```ts
export const LoopBudget = z.object({
  max_cycles: z.number().optional(),
  max_task_iterations: z.number().optional(),
  max_runtime_ms: z.number().optional(),
  max_tokens: z.number().optional(),
  max_estimated_cost_usd: z.number().optional(),
  no_progress_limit: z.number().default(2),
});
```

Behavior:

- Enforce runtime/cycle/no-progress limits locally and in daemon sessions.
- Track adapter token usage when adapters expose it. If unavailable, keep zero but preserve the API.
- Stop with `loop.budget.exceeded` event when budget is exceeded.
- Surface budget status in `loop status`, report, scorecard, and daemon stats.

Acceptance criteria:

- Tests cover runtime, cycle, and no-progress stop conditions.
- Budget stop exits with code `2`, not CLI crash code `1`.
- Daemon loop sessions persist budget stop reason.

### Increment E: SOP Flywheel

Turn successful loop runs into reviewable reusable knowledge.

New or modified files:

- `packages/loop/src/lesson-draft.ts`
- `packages/loop/src/lesson-draft.test.ts`
- `packages/loop/src/loop-engine.ts`
- `packages/cli/src/bin.ts`
- docs for generated drafts

Behavior:

- When a task succeeds after one or more failed attempts, generate a lesson draft.
- The draft should not directly modify official skills by default.
- Write drafts to `loop-lessons/drafts/<task_id>.md` or a configurable path.
- Include:
  - task prompt
  - failed evaluations
  - final fix summary
  - what verifier caught
  - proposed reusable rule
  - suggested target skill, if inferable

Example draft:

```md
# Lesson Draft: auth-session-expiry

## Problem
Auth tests failed after session expiry handling changed.

## Failure Pattern
The first fix made positive login tests pass but skipped negative expiry cases.

## Reusable Rule
When modifying auth middleware, always verify both positive access and negative expired-session cases. Do not replace session validation with constant allow/deny shortcuts.

## Suggested Evaluation
Run `pnpm test -- tests/auth` and require semantic review for authorization bypass.
```

Acceptance criteria:

- Drafts are created only when useful.
- Draft paths are recorded in `LOOP-STATE.json` and `STATE.md`.
- No official skill file is mutated unless an explicit flag is passed.

## 6. Non-Goals

- Do not rewrite the whole loop engine.
- Do not replace existing CLI commands.
- Do not require a cloud service for local loop usage.
- Do not make AI decide business priority by default.
- Do not auto-merge or publish externally without explicit existing flags/config.

## 7. Compatibility Requirements

Preserve these commands:

```bash
osstack loop enqueue "Fix failing test" --workspace . --capability code.test
osstack loop run --workspace . --source task_queue --verify "pnpm test" --json
osstack loop run --workspace . --source git_diff --reviewer ds-review --json
osstack loop start --workspace . --source task_queue --interval-ms 5000
osstack loop status --workspace .
pnpm --filter @osstack/loop test -- --run
```

Existing tests should remain green unless the test is explicitly updated for the new richer state shape.

## 8. Suggested Implementation Order

1. Add `EvaluationSpec` types and parser support.
2. Extend verifier to produce per-evaluation results.
3. Update state rendering for evaluation results.
4. Add feedback derivation and pass it into second attempt context.
5. Add no-progress fingerprinting.
6. Add discovery authorization policy.
7. Add budget enforcement.
8. Add SOP lesson drafts.
9. Update docs and task schema references.
10. Run unit tests and at least one loop smoke path.

## 9. Verification Plan

Minimum verification:

```bash
pnpm --filter @osstack/loop test -- --run
pnpm --filter @osstack/cli test -- loop-cli --run
pnpm --filter @osstack/cli test -- daemon-loop --run
```

Preferred verification:

```bash
pnpm test
pnpm smoke:loop
pnpm coverage:loop
```

If any full-suite command is too slow, run the targeted tests first and document what was skipped.

## 10. Claude Implementation Prompt

Use this prompt when handing the work to Claude:

```text
You are upgrading osstack's Loop Engineering runtime. Read:

- docs/2026-07-04-loop-engineering-upgrade-spec.md
- docs/LOOP_ENGINEERING_DESIGN.md
- loop-engineering/SKILL.md
- loop-engineering/references/task-schema.md
- packages/loop/src/loop-engine.ts
- packages/loop/src/verifier.ts
- packages/loop/src/iterator.ts
- packages/loop/src/types.ts
- packages/agents/src/worktree.ts
- packages/cli/src/daemon.ts

Implement the upgrade incrementally. Do not rewrite the whole runtime. Preserve existing CLI behavior and tests.

Start with Increment A: EvaluationSpec. Add schema, parsing, verifier integration, state rendering, and tests. Then proceed to Increment B only after tests pass.

Engineering constraints:

- Prefer existing osstack patterns and Zod schemas.
- Keep local mode working without cloud services.
- Keep human priority control explicit.
- Do not mutate official skill files automatically.
- Use structured state/events rather than only markdown text.
- Add focused tests for every new behavior.

Before claiming completion, run:

pnpm --filter @osstack/loop test -- --run

Then report:

- files changed
- tests run
- behavior added
- compatibility risks
- next increment if unfinished
```

## 11. Acceptance Checklist

- [ ] Evaluation specs are first-class task inputs.
- [ ] Verifier emits per-evaluation results.
- [ ] Failed verdicts become structured next-attempt feedback.
- [ ] No-progress detection escalates stuck loops.
- [ ] Discovery policy separates found tasks from authorized tasks.
- [ ] Runtime/cycle/token/cost budgets are modeled and enforced where data is available.
- [ ] SOP lesson drafts are generated after meaningful successful recovery.
- [ ] `STATE.md` explains failed evaluations, feedback, budgets, and lesson drafts.
- [ ] Existing loop CLI commands remain compatible.
- [ ] Targeted tests pass.


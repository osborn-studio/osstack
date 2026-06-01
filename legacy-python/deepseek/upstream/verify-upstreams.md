# Verification Upstream Notes

## Repos Reviewed

### 1. github/spec-kit  (cloned to `~/.osborn/sources/spec-kit`)

* **Purpose:** scaffolding toolkit for Spec-Driven Development. Generates
  `spec.md`, `plan.md`, `tasks.md`, `checklist.md` from templates and ties them
  to feature branches.
* **Useful parts:**
  * `templates/spec-template.md` — User Story / Acceptance Scenarios in
    Given/When/Then notation with explicit P1/P2/P3 priorities.
  * `templates/checklist-template.md` — `CHK001`-style structured checklist
    items that we use as inspiration for `## Required Fixes` numbering.
  * The general **spec → plan → tasks** workflow alignment, which mirrors what
    OSBORN's `osb-init` already produces (`docs/02_PRD.md`,
    `docs/04_SYSTEM_ARCHITECTURE.md`, `docs/10_TASK_BREAKDOWN.md`).
* **Rejected as base:** the only `validate`-named command is
  `extensions/git/commands/speckit.git.validate.md`, which validates **feature
  branch naming conventions** (`001-feature-name`), not implementation ↔ spec
  alignment. There is no upstream "verify spec was implemented" command.
* **Borrowed concept:** Given/When/Then acceptance-scenario phrasing — fed to
  the verifier prompt so the LLM reasons about acceptance criteria in the
  same shape spec-kit projects already use.

### 2. Fission-AI/OpenSpec  (cloned to `~/.osborn/sources/OpenSpec`)

* **Purpose:** TypeScript/npm CLI for spec-driven development with
  `/opsx:propose` → `/opsx:apply` → `/opsx:archive` lifecycle.
* **Useful parts:**
  * `src/core/profile-sync-drift.ts` — detects drift between profile state and
    target state. The **"drift"** framing (intent vs. reality) is the
    closest upstream concept to OSBORN's alignment-verification need.
  * `src/utils/change-utils.ts` — proposal/change diff utilities.
  * Workflow contract: tasks are checkboxes, archive happens only when all
    boxes are ticked — turning **task checkbox state into a completion gate**.
* **Rejected as base:** wired tightly into OpenSpec's `openspec/changes/`
  directory layout and proposal/archive lifecycle. We'd inherit a lot of
  unrelated machinery to extract a single drift-detection routine. Also
  TypeScript, which would force a Node runtime dependency.
* **Borrowed concept:** **drift framing** — `ds-verify` reports per-area
  alignment as PASS / PARTIAL / FAIL, which is essentially "no drift / partial
  drift / full drift" against intent.

### 3. hustcer/deepseek-review  (already cloned for P3)

* **Purpose:** DeepSeek code review (P3 already adapted this).
* **Useful parts for P4:** the API call shape, header conventions, prompt
  structure, and OpenAI-compatible payload — all reused via the new
  `~/.osborn/capabilities/deepseek/lib/api.py` module. Same envelope as P3.

## Selected Approach

**Reference Only** — no upstream code is executed at runtime. We borrow
*concepts* from three repos and build a fresh Python implementation that
shares its DeepSeek client with `ds-review`.

Reasoning: each upstream solves a different problem (scaffolding,
proposal-lifecycle management, code review). None offers a primitive
"verify implementation matches PRD/architecture/sprint" function. Adapting
any of them as a base would carry more incidental complexity than
implementing fresh against OSBORN's already-defined doc layout.

## Borrowed Concepts

1. **Given/When/Then acceptance-scenario phrasing** (from spec-kit) — the
   `verify.md` prompt encourages the LLM to think of acceptance criteria in
   this shape when evaluating PRD-vs-implementation alignment.
2. **Drift framing** (from OpenSpec) — the per-area Alignment table uses
   PASS / PARTIAL / FAIL where PARTIAL ≈ "drift detected but not total."
3. **Two-layer verification** (original to OSBORN, but informed by both
   upstreams) — Layer 1 deterministic checks run locally; Layer 2 LLM call
   reasons over docs + diff + Layer 1 findings.
4. **Task-checkbox-as-completion-signal** (from OpenSpec) — unchecked items
   in `tasks/CURRENT_SPRINT.md` are treated as evidence of incomplete sprint
   work and feed both deterministic checks and the LLM context.
5. **DeepSeek API client envelope** (from `hustcer/deepseek-review`) —
   `lib/api.py` reuses the same request shape, headers, and timeouts that
   P3's `ds-review` already validated.

## Limitations

* **No formal traceability matrix.** A "real" requirements-traceability tool
  would maintain links between requirement IDs and code/tests. OSBORN does
  not yet have requirement IDs; the LLM is asked to reason about alignment
  prose-to-prose. Acceptable for P4; a future P-N could introduce
  `REQ-001`-style identifiers if the workflow needs auditable traceability.
* **No automated test execution.** `ds-verify` checks for *presence* of
  tests heuristically; it does not run them. Pair with project-specific
  test runners externally.
* **No structured spec format requirement.** Unlike spec-kit and OpenSpec,
  OSBORN does not force a specific Markdown schema. The trade-off: more
  flexible, but the LLM has to do more inference. If the project follows
  `osb-init` conventions, alignment is easier to evaluate.
* **Single LLM call per run.** No iteration, no self-critique, no
  multi-agent verification. P5 could add a "challenger" pass.

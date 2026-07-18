# Implementation Plan — osstack `neat` Knowledge Hygiene

| Item | Value |
|---|---|
| Status | In progress — P0 accepted; R0-R4 authorized 2026-07-17 |
| Date | 2026-07-17 |
| Product spec | `docs/2026-07-17-neat-product-technical-spec-v2.md` |
| Architecture decision | `docs/decisions/ADR-002-neat-knowledge-hygiene-boundary.md` |
| Historical draft | `docs/2026-07-17-neat-knowledge-hygiene-design.md` |
| Delivery model | One independently mergeable PR per increment; maker/checker separated |

---

## 1. Objective

Deliver the complete `neat` upgrade in controlled releases:

1. **R0:** a high-precision, read-only repository knowledge-contract checker;
2. **R1:** explicit resolution evidence and one narrowly safe patch action;
3. **R2:** persistence, portfolio aggregation, and daily visibility;
4. **R3:** explicit read-only platform memory adapters;
5. **R4:** application-layer automation and repeated-finding improvement
   proposals.

R0 is the first customer-usable release and the mandatory gate before later
work. The implementation must not pull R1-R4 concerns into an earlier PR.

---

## 2. Baseline and working-tree safety

Baseline facts verified on 2026-07-17:

- TypeScript ESM pnpm monorepo;
- Vitest colocated tests;
- `@osstack/governance` is a public leaf package;
- `@osstack/cli` already depends on governance and protocol;
- `checkAgentInstructionDrift` is private in `packages/cli/src/bin.ts`;
- `@osstack/supervisor` registry has no dependency edges;
- existing policy gate receives only a workspace path;
- `GovernanceFinding` is not suitable as the neat lifecycle model;
- current worktree already contains user-owned changes to `AGENTS.md` and the
  historical neat draft.

Implementation agents must preserve unrelated worktree changes. No task in this
plan authorizes resetting, deleting, or rewriting user-owned files outside its
listed scope.

---

## 3. Execution rules

Every implementation PR must:

- link the exact spec section it implements;
- contain no unrelated refactor;
- keep tasks to approximately five touched files or fewer where practical;
- add focused tests before or with behavior;
- add a changeset for public or user-visible behavior;
- update generated inventories through their generator, never by hand;
- run focused tests while iterating and the full release commands before merge;
- include rollback instructions;
- be reviewed by a checker that did not author the implementation.

Global completion commands:

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm lint
```

If `pnpm lint` exposes unrelated pre-existing failures, record the exact output
and run a changed-file lint check; do not claim full lint success.

### Commit convention

Suggested Conventional Commit scopes:

```text
feat(governance): add knowledge hygiene contracts
refactor(cli): share instruction source inspection
feat(cli): add neat check command
feat(neat): add change review contracts
feat(neat): add review resolution artifacts
feat(supervisor): aggregate knowledge hygiene findings
```

---

## 4. Dependency graph

```text
P0 specification + ADR approval
  |
  v
R0.1 domain schemas + config
  |-----------------------|
  v                       v
R0.2 instruction          R0.3 path/change foundations
inspector                  |
  |                        |
  |------------|-----------|
               v
R0.4 engine vertical slice
               |
               v
R0.5 CLI + human output
               |
               v
R0.6 change contracts + references
               |
               v
R0.7 strict JSON + schemas + golden evaluation
               |
               v
R0.8 companion skill + release docs
               |
          R0 MVP GATE
               |
     |---------|----------|
     v                    v
R1 resolutions       R2 persistence design
     |
R1 safe patch
     |
R2 portfolio + daily
     |
R3 memory adapters
     |
R4 application finalizer + proposals
```

R0.2 and R0.3 may run in parallel only after R0.1 freezes shared types and
configuration semantics. Everything that consumes public JSON waits for R0.7.

---

## 5. Phase P0 — specification approval

### Task P0.1: Review and accept ADR-002

**Description:** Confirm governance owns the engine, CLI remains thin, config is
the machine authority, and external memory is excluded from R0.

**Acceptance criteria:**

- [x] ADR status changes from Proposed to Accepted with owner approval date.
- [x] Any rejected decision is replaced by a new explicit alternative before
  code begins.
- [x] ADR-001 compatibility is confirmed.

**Verification:**

- [x] Owner architecture approval recorded in this plan and ADR.
- [x] No implementation code existed when approval was recorded.

**Dependencies:** None.

**Files likely touched:**

- `docs/decisions/ADR-002-neat-knowledge-hygiene-boundary.md`

**Estimated scope:** XS.

### Task P0.2: Approve the v2 product and technical specification

**Description:** Freeze R0 scope, CLI syntax, exit codes, config v1, domain
contracts, rule ids, and release gates.

**Acceptance criteria:**

- [x] Spec status changes from Proposed to Accepted.
- [x] No unresolved blocking product/API question remains.
- [x] Historical Draft v1 remains preserved and points to v2.

**Verification:**

- [x] Owner confirms implementation may begin at R0.1.
- [x] Links among draft, spec, ADR, and plan resolve.

**Dependencies:** P0.1.

**Files likely touched:**

- `docs/2026-07-17-neat-product-technical-spec-v2.md`
- `docs/2026-07-17-neat-knowledge-hygiene-design.md`
- `docs/superpowers/plans/2026-07-17-neat-implementation-plan.md`

**Estimated scope:** S.

### Checkpoint P0

- [x] ADR-002 Accepted.
- [x] Product spec Accepted.
- [x] Implementation authorization explicit.
- [x] No production code had changed at the approval checkpoint.

---

## 6. Phase R0 — read-only MVP

### PR R0.1 — Domain schemas and config v1

#### Task R0.1.1: Add Zod-first domain contracts

**Description:** Define versioned report, finding, metric, check-input, rule-id,
and supporting schemas without I/O or CLI dependencies.

**Acceptance criteria:**

- [x] `KnowledgeHygieneReportV1` and `KnowledgeHygieneFindingV1` match spec §8.
- [x] Rule ids are a closed enum containing only accepted R0 ids.
- [x] Finding fingerprints exclude line number and human message fields.

**Verification:**

- [x] `pnpm --filter @osstack/governance test -- knowledge-hygiene`
- [x] `pnpm --filter @osstack/governance typecheck`

**Dependencies:** P0 checkpoint.

**Files likely touched:**

- `packages/governance/src/knowledge-hygiene/types.ts`
- `packages/governance/src/knowledge-hygiene/types.test.ts`
- `packages/governance/src/knowledge-hygiene/fingerprint.ts`
- `packages/governance/src/knowledge-hygiene/fingerprint.test.ts`

**Estimated scope:** M.

#### Task R0.1.2: Add strict config loading and validation

**Description:** Implement `.osstack/neat.yaml` v1 parsing, duplicate-id checks,
path confinement, path-pattern validation, and fail-closed errors.

**Acceptance criteria:**

- [x] Good example config parses exactly.
- [x] Unknown version, duplicate id, absolute path, `..` escape, broad ignore,
  unsupported pattern, and invalid budget ordering are rejected.
- [x] Missing config returns explicit zero-config mode; invalid config never
  falls back.

**Verification:**

- [x] `pnpm --filter @osstack/governance test -- config`
- [x] Config tests use temporary paths and do not read the real home directory.

**Dependencies:** R0.1.1.

**Files likely touched:**

- `packages/governance/src/knowledge-hygiene/config.ts`
- `packages/governance/src/knowledge-hygiene/config.test.ts`
- `packages/governance/package.json`
- `pnpm-lock.yaml`

**Estimated scope:** M.

#### Task R0.1.3: Publish additive governance exports

**Description:** Add a local module barrel and public package exports without
changing the existing source-scanner types or behavior.

**Acceptance criteria:**

- [x] Existing `scanText`, `scanFiles`, and `GovernanceFinding` imports compile.
- [x] New types import from `@osstack/governance` without deep paths.
- [x] Changeset describes additive public API.

**Verification:**

- [x] `pnpm --filter @osstack/governance test`
- [x] `pnpm --filter @osstack/governance build`

**Dependencies:** R0.1.1, R0.1.2.

**Files likely touched:**

- `packages/governance/src/knowledge-hygiene/index.ts`
- `packages/governance/src/index.ts`
- `.changeset/<generated-neat-governance-name>.md`

**Estimated scope:** S.

**PR R0.1 rollback:** Revert new exports, module directory, dependencies, lock
change, and changeset. Existing governance APIs remain untouched.

---

### PR R0.2 — Shared instruction-source inspector

#### Task R0.2.1: Implement the package-level inspector

**Description:** Move instruction file classification into governance as a
typed observation that supports canonical direction and allowed mirror modes.

**Acceptance criteria:**

- [x] Detects missing canonical, missing mirror, valid import, valid symlink,
  wrong symlink, and independent-file drift.
- [x] Does not merge, write, or delete any file.
- [x] Symlink resolution remains confined and reports outside-root targets.

**Verification:**

- [x] `pnpm --filter @osstack/governance test -- instruction-source`
- [x] macOS/Linux symlink test and portable import test pass.

**Dependencies:** R0.1.

**Files likely touched:**

- `packages/governance/src/knowledge-hygiene/instruction-source.ts`
- `packages/governance/src/knowledge-hygiene/instruction-source.test.ts`
- `packages/governance/src/knowledge-hygiene/index.ts`

**Estimated scope:** M.

#### Task R0.2.2: Migrate loop doctor without behavior change

**Description:** Replace the private inspector in `bin.ts` with the governance
API and map typed observations back to the exact existing doctor messages.

**Acceptance criteria:**

- [x] Existing doctor JSON and human messages are byte-identical for all
  instruction cases.
- [x] Private `checkAgentInstructionDrift` and classifier implementation are
  removed from `bin.ts`.
- [x] No other loop doctor check changes.

**Verification:**

- [x] `pnpm --filter @osstack/cli test -- loop-cli`
- [x] Add frozen regression cases before deleting private logic.

**Dependencies:** R0.2.1.

**Files likely touched:**

- `packages/cli/src/bin.ts`
- `packages/cli/src/loop-cli.test.ts`
- `packages/cli/package.json` only if dependency metadata requires adjustment

**Estimated scope:** M.

**PR R0.2 rollback:** Restore private functions and imports. The governance
inspector may remain additive or be reverted with the PR.

---

### PR R0.3 — Path patterns and Git change-set foundations

#### Task R0.3.1: Implement the v1 path-pattern grammar

**Description:** Add exact, `*`, and `**` POSIX matching with strict rejection
of unsupported glob syntax.

**Acceptance criteria:**

- [x] Pattern behavior matches spec §7.3.
- [x] Backslashes, braces, extglobs, character classes, and negation fail
  validation rather than being interpreted inconsistently.
- [x] Matching is deterministic across macOS/Linux path separators.

**Verification:**

- [x] `pnpm --filter @osstack/governance test -- path-pattern`

**Dependencies:** R0.1.

**Files likely touched:**

- `packages/governance/src/knowledge-hygiene/path-pattern.ts`
- `packages/governance/src/knowledge-hygiene/path-pattern.test.ts`
- `packages/governance/src/knowledge-hygiene/config.ts`

**Estimated scope:** S.

#### Task R0.3.2: Build explicit Git change sets

**Description:** Implement worktree, range, and base-to-worktree inputs using
`execFile`, normalized changed paths, resolved refs, and a deterministic
`diff_id`.

**Acceptance criteria:**

- [x] Default includes staged, unstaged, deleted, renamed, and untracked paths.
- [x] Range mode requires valid explicit refs and records resolved SHAs.
- [x] Git timeout and command failure produce typed boundary errors.
- [x] `diff_id` changes when relevant content or config changes.

**Verification:**

- [x] `pnpm --filter @osstack/governance test -- change-set`
- [x] Tests initialize temporary Git repositories without network access.

**Dependencies:** R0.3.1.

**Files likely touched:**

- `packages/governance/src/knowledge-hygiene/change-set.ts`
- `packages/governance/src/knowledge-hygiene/change-set.test.ts`
- `packages/governance/src/knowledge-hygiene/types.ts`
- `packages/governance/src/knowledge-hygiene/index.ts`

**Estimated scope:** M.

**PR R0.3 rollback:** Remove new utilities and exports; no existing behavior is
modified.

---

### PR R0.4 — Engine vertical slice

#### Task R0.4.1: Implement bounded repository inventory

**Description:** Inventory only recognized knowledge surfaces with default
exclusions, file/byte limits, no symlink-directory traversal, and explicit
completeness state.

**Acceptance criteria:**

- [x] Recognized surfaces and exclusions match spec §10.
- [x] Limit and read failures create `scan.incomplete` instead of silent skips.
- [x] Inventory does not read external user memory or arbitrary home paths.

**Verification:**

- [x] `pnpm --filter @osstack/governance test -- repository-reader`
- [x] Fixture proves no traversal through a symlinked directory.

**Dependencies:** R0.1, R0.3.

**Files likely touched:**

- `packages/governance/src/knowledge-hygiene/repository-reader.ts`
- `packages/governance/src/knowledge-hygiene/repository-reader.test.ts`
- `packages/governance/src/knowledge-hygiene/types.ts`

**Estimated scope:** M.

#### Task R0.4.2: Add instruction, required-surface, and budget rules

**Description:** Implement the first three deterministic rule families and a
single immutable rule registry.

**Acceptance criteria:**

- [x] Findings match configured severity and remediation modes.
- [x] Budgets count normalized lines and raw UTF-8 bytes exactly.
- [x] Zero-config mode does not invent required surfaces or budgets.
- [x] Rule registry rejects duplicate ids and is exhaustively typed.

**Verification:**

- [x] Rule table tests cover positive, clean, suppression, and boundary cases.

**Dependencies:** R0.4.1, R0.2.

**Files likely touched:**

- `packages/governance/src/knowledge-hygiene/rules/instruction-rule.ts`
- `packages/governance/src/knowledge-hygiene/rules/required-surface-rule.ts`
- `packages/governance/src/knowledge-hygiene/rules/budget-rule.ts`
- `packages/governance/src/knowledge-hygiene/rules/rules.test.ts`
- `packages/governance/src/knowledge-hygiene/rules/index.ts`

**Estimated scope:** M.

#### Task R0.4.3: Compose the deterministic engine

**Description:** Orchestrate config, change set, inventory, rules,
suppressions, sorting, metrics, and report construction through injected ports.

**Acceptance criteria:**

- [x] Pipeline order matches spec §10.
- [x] Same input/config produces the same normalized JSON and ordering.
- [x] Suppressed findings are excluded from active findings and counted.
- [x] Engine has no CLI, DB, supervisor, or home-memory dependency.

**Verification:**

- [x] `pnpm --filter @osstack/governance test -- engine`
- [x] `pnpm --filter @osstack/governance typecheck`

**Dependencies:** R0.4.1, R0.4.2.

**Files likely touched:**

- `packages/governance/src/knowledge-hygiene/engine.ts`
- `packages/governance/src/knowledge-hygiene/engine.test.ts`
- `packages/governance/src/knowledge-hygiene/index.ts`

**Estimated scope:** M.

**Checkpoint R0 foundation:**

- [x] Governance package tests and typecheck pass.
- [x] Existing source scanner remains compatible.
- [x] Loop doctor behavior remains compatible.
- [x] Engine can produce a report from a temporary repository with zero writes.

---

### PR R0.5 — CLI `neat check` vertical slice

#### Task R0.5.1: Add CLI boundary and exit policy

**Description:** Implement the exact command/flag/mode/exit-code contract in a
standalone command module with injected output, runner, clock, and cwd.

**Acceptance criteria:**

- [x] Bare `neat` and `neat check` are equivalent.
- [x] All invalid flag combinations exit 2 with actionable errors.
- [x] `--fail-on` affects exit code but not report content.
- [x] Default check performs no writes.

**Verification:**

- [x] `pnpm --filter @osstack/cli test -- neat-command`

**Dependencies:** R0.4.

**Files likely touched:**

- `packages/cli/src/neat-command.ts`
- `packages/cli/src/neat-command.test.ts`

**Estimated scope:** M.

#### Task R0.5.2: Add deterministic human renderer

**Description:** Render summary, evidence, remediation, fingerprint, and exit
policy in the order specified by the product contract.

**Acceptance criteria:**

- [x] Rendering uses repository-relative locations.
- [x] No finding/evidence is silently truncated.
- [x] Snapshot tests cover clean, finding, incomplete, and bad-config cases.

**Verification:**

- [x] Focused CLI snapshot tests pass on repeated runs.

**Dependencies:** R0.5.1.

**Files likely touched:**

- `packages/cli/src/neat-command.ts`
- `packages/cli/src/neat-command.test.ts`

**Estimated scope:** S.

#### Task R0.5.3: Wire top-level dispatch and help

**Description:** Add one `neat` branch to `bin.ts`, English/Chinese help text,
and a CLI changeset.

**Acceptance criteria:**

- [x] Existing top-level command dispatch behavior is unchanged.
- [x] `osstack neat --help` documents all R0 flags and exit codes.
- [x] Help does not advertise R1-R4 features.

**Verification:**

- [x] `pnpm --filter @osstack/cli test`
- [x] `pnpm --filter @osstack/cli build`

**Dependencies:** R0.5.1, R0.5.2.

**Files likely touched:**

- `packages/cli/src/bin.ts`
- `packages/cli/src/neat-command.test.ts`
- `.changeset/<generated-neat-cli-name>.md`

**Estimated scope:** S.

**PR R0.5 rollback:** Remove dispatch/help and command module; governance engine
remains independently usable.

---

### PR R0.6 — Change contracts and conservative references

#### Task R0.6.1: Implement configured change-review contracts

**Description:** Evaluate `when.any_path` against the change set and determine
whether at least one declared review target changed.

**Acceptance criteria:**

- [x] Untriggered contracts emit nothing.
- [x] Triggered/satisfied contracts emit nothing.
- [x] Triggered/unresolved contracts emit configured warning/error.
- [x] Finding evidence lists triggering paths and candidate review targets.

**Verification:**

- [x] `pnpm --filter @osstack/governance test -- change-contract`

**Dependencies:** R0.3, R0.4.

**Files likely touched:**

- `packages/governance/src/knowledge-hygiene/rules/change-contract-rule.ts`
- `packages/governance/src/knowledge-hygiene/rules/change-contract-rule.test.ts`
- `packages/governance/src/knowledge-hygiene/rules/index.ts`

**Estimated scope:** M.

#### Task R0.6.2: Implement conservative reference checks

**Description:** Check plain relative Markdown links and instruction imports
while ignoring code fences, URLs, images, fragments, wikilinks, and ambiguous
syntax.

**Acceptance criteria:**

- [x] Parser behavior matches spec §11.2.
- [x] Path-like prose and code examples do not create findings.
- [x] Missing relative targets include source line evidence.
- [x] Unsupported syntax is skipped without failing the scan.

**Verification:**

- [x] `pnpm --filter @osstack/governance test -- reference-rule`

**Dependencies:** R0.4.

**Files likely touched:**

- `packages/governance/src/knowledge-hygiene/rules/reference-rule.ts`
- `packages/governance/src/knowledge-hygiene/rules/reference-rule.test.ts`
- `packages/governance/src/knowledge-hygiene/rules/index.ts`

**Estimated scope:** M.

#### Task R0.6.3: Add osstack's initial neat config

**Description:** Dogfood config v1 on this repository using only rules with
clear owners and low expected noise.

**Acceptance criteria:**

- [x] Canonical/mirror direction matches current loop doctor policy.
- [x] Required surfaces are limited to real repository obligations.
- [x] Change contracts reference existing canonical docs.
- [x] Initial full audit is reviewed and every expected finding is labelled.

**Verification:**

- [x] `osstack neat check --all --fail-on none` after the CLI build.
- [x] Checker signs off on every warning/error as true or false positive.

**Dependencies:** R0.6.1, R0.6.2, R0.5.

**Files likely touched:**

- `.osstack/neat.yaml`
- a focused config fixture or test file

**Estimated scope:** S.

**PR R0.6 rollback:** Remove new rules/config. Core CLI remains useful for
instruction, required-surface, and budget checks.

---

### PR R0.7 — Strict JSON, schemas, vectors, and golden evaluation

#### Task R0.7.1: Wrap report in strict `AgentCommandResult`

**Description:** Emit a single protocol envelope for `--json`, using protocol
version string and domain report under `result.report`.

**Acceptance criteria:**

- [x] Clean and finding reports both use `status: ok` when the check completes.
- [x] Invalid input/config uses `bad_request` and exit 2.
- [x] Runtime failure uses the accepted protocol error code and exit 3.
- [x] Output parses with strict `AgentCommandResult`.

**Verification:**

- [x] `pnpm --filter @osstack/cli test -- neat-command`

**Dependencies:** R0.5, R0.6.

**Files likely touched:**

- `packages/cli/src/neat-command.ts`
- `packages/cli/src/neat-command.test.ts`

**Estimated scope:** S.

#### Task R0.7.2: Generate and freeze domain schemas

**Description:** Generate report/finding schemas from Zod, ship them with the
governance package, and add good/bad vectors and drift checks.

**Acceptance criteria:**

- [x] Generated schema is reproducible and `--check` reports zero diff.
- [x] Package publishes schema artifacts.
- [x] At least one good and one bad vector per public domain schema.
- [x] Additive compatibility test protects v1.

**Verification:**

- [x] `pnpm --filter @osstack/governance check:schemas`
- [x] `pnpm --filter @osstack/governance test -- schema`

**Dependencies:** R0.1, R0.7.1.

**Files likely touched:**

- `packages/governance/scripts/generate-schemas.mjs`
- `packages/governance/package.json`
- `packages/governance/schemas/*.schema.json`
- `packages/governance/fixtures/**/*.json`
- `pnpm-lock.yaml`

**Estimated scope:** M.

#### Task R0.7.3: Build and independently score golden fixtures

**Description:** Create the twelve labelled repositories from spec §15.4,
execute the built CLI, and calculate blocking/warning precision.

**Acceptance criteria:**

- [x] All twelve scenario classes are represented.
- [x] Expected findings are human-labelled before final tuning.
- [x] Blocking precision >=95%, warning precision >=80%.
- [x] Evaluator records self-evaluation bias if maker also runs the first score.

**Verification:**

- [x] Golden evaluation command returns pass and a reproducible report.
- [x] An independent deterministic checker reviews false positives and false
  negatives; release-owner human review remains required before publication.

**Dependencies:** R0.7.1, R0.7.2.

**Files likely touched:**

- `packages/governance/fixtures/knowledge-hygiene/**`
- `scripts/eval-neat-goldens.mjs`
- `docs/reports/neat-r0-golden-eval.md`

**Estimated scope:** M; fixture tree may exceed five files but is data-only and
should be generated from a compact manifest where possible.

**Checkpoint R0 release candidate:**

- [x] Domain and protocol schemas frozen.
- [x] Human and JSON outputs stable.
- [x] Precision gates pass.
- [x] Default path performs zero writes.
- [x] Full repository commands pass.

---

### PR R0.8 — Companion skill and release documentation

#### Task R0.8.1: Author the thin neat companion skill

**Description:** Create a <=150-line workflow that calls the CLI, handles only
authorized editorial work, requests decisions, and reruns the check.

**Acceptance criteria:**

- [x] Trigger description covers `/neat`, tidy/sync/close-out phrases.
- [x] Mechanical checks are never reimplemented in shell instructions.
- [x] Human decisions and incomplete scans block success claims.
- [x] Source attribution is present.

**Verification:**

- [x] Skill validates under the Agent Skills validator when available.
- [x] Manual clean and finding scenarios follow the same CLI path.

**Dependencies:** R0.7.

**Files likely touched:**

- `neat-skill/SKILL.md`
- `neat-skill/references/editorial-playbook.md`
- `neat-skill/THIRD_PARTY_NOTICES.md`

**Estimated scope:** M.

#### Task R0.8.2: Add end-to-end close-out smoke

**Description:** Build a temporary sick repository, run check, apply a simulated
editorial correction, rerun check, and assert the obligation closes without
touching the real home directory.

**Acceptance criteria:**

- [x] Smoke starts from a hermetic temporary repo.
- [x] First check finds expected issues.
- [x] Second check closes the edited issue and retains human-decision issues.
- [x] No external memory or network access occurs.

**Verification:**

- [x] `pnpm smoke:neat`

**Dependencies:** R0.8.1.

**Files likely touched:**

- `scripts/smoke-neat.mjs`
- `package.json`
- one compact smoke fixture manifest if needed

**Estimated scope:** S.

#### Task R0.8.3: Complete user-facing release docs

**Description:** Add quick start, config example, command help, release notes,
generated CLI inventory, and changesets.

**Acceptance criteria:**

- [x] README shows local, CI, and full-audit examples.
- [x] Config reference matches schema exactly.
- [x] Generated inventory has no manual edits.
- [x] R0 non-goals are visible to users.

**Verification:**

- [x] Documentation commands and links are validated.
- [x] Full release commands pass.

**Dependencies:** R0.8.2.

**Files likely touched:**

- `README.md`
- a focused neat user guide under `docs/`
- generated `docs/inventory/CLI_COMMANDS.md`
- `.changeset/<generated-neat-release-name>.md`

**Estimated scope:** M.

### R0 MVP release gate

- [x] All spec §20 R0 definition-of-done items pass.
- [x] Independent deterministic checker accepts precision report, with maker
  bias disclosed for release-owner review.
- [x] No hidden persistence or write path exists.
- [x] Release docs state exactly what R0 does not do.
- [x] Owner authorized completion of all implementation increments; no external
  package publication is performed by this plan.

Do not start R1 implementation before this gate.

---

## 7. Phase R1 — resolution evidence and controlled writes

### PR R1.1 — Portable resolution artifact

#### Task R1.1.1: Add resolution/review schemas

**Description:** Implement resolution and review-artifact Zod schemas tied to a
report `diff_id`.

**Acceptance criteria:**

- [x] All five outcomes from spec §8.3 validate.
- [x] Empty reason, unknown fingerprint, and mismatched `diff_id` are rejected.
- [x] Existing report/finding schema v1 remains backward compatible.

**Verification:**

- [x] Governance schema/unit tests pass.

**Dependencies:** R0 gate.

**Files likely touched:**

- `packages/governance/src/knowledge-hygiene/types.ts`
- `packages/governance/src/knowledge-hygiene/types.test.ts`
- governance schema/vector artifacts

**Estimated scope:** M.

#### Task R1.1.2: Add `neat review` artifact authoring

**Description:** Provide an explicit command that reads a report, adds or
replaces one resolution, and writes only to a caller-provided output path.

Proposed interface:

```bash
osstack neat review \
  --report neat-report.json \
  --finding khf_... \
  --outcome reviewed_no_change \
  --reason "No public behavior changed" \
  --actor osborn \
  --output neat-review.json
```

**Acceptance criteria:**

- [x] No implicit output path or DB write.
- [x] Artifact update is atomic and deterministic.
- [x] Unknown/mismatched finding is rejected with exit 2.

**Verification:**

- [x] CLI tests cover create, replace, mismatch, and malformed input.

**Dependencies:** R1.1.1.

**Files likely touched:**

- `packages/cli/src/neat-command.ts`
- `packages/cli/src/neat-command.test.ts`
- CLI help and changeset

**Estimated scope:** M.

#### Task R1.1.3: Apply review artifacts during check

**Description:** Add `--review-file` and report resolved/unresolved counts
without deleting original findings from evidence.

**Acceptance criteria:**

- [x] Only matching diff/fingerprint resolutions apply.
- [x] Active and resolved views are both available in JSON.
- [x] `--fail-on` considers unresolved findings only.

**Verification:**

- [x] End-to-end review-no-change scenario passes.

**Dependencies:** R1.1.2.

**Files likely touched:**

- governance resolution application module + test
- `packages/cli/src/neat-command.ts`
- `packages/cli/src/neat-command.test.ts`

**Estimated scope:** M.

---

### PR R1.2 — Safe patch planning and apply

#### Task R1.2.1: Define patch action contracts

**Description:** Add versioned patch/action schemas with before preconditions,
risk, source fingerprint, and evidence.

**Acceptance criteria:**

- [x] Action cannot target an absolute/outside-root path.
- [x] Before existence/hash precondition is mandatory.
- [x] Only the approved `create_instruction_import` action exists initially.

**Verification:** Governance tests and frozen vectors pass. ✅

**Dependencies:** R1.1.

**Files likely touched:** Governance types, patch types test, schemas/vectors.

**Estimated scope:** S.

#### Task R1.2.2: Implement preview-only patch provider

**Description:** Convert eligible `instruction.mirror_missing` findings into a
patch that creates an exact one-line import; never replace a path.

**Acceptance criteria:**

- [x] Provider refuses existing targets and unsupported mirror modes.
- [x] Preview contains target, before state, after hash, and source finding.
- [x] Repeated preview is byte-stable after timestamp normalization.

**Verification:** Governance patch-provider tests pass. ✅

**Dependencies:** R1.2.1.

**Files likely touched:** Patch provider, test, index exports.

**Estimated scope:** M.

#### Task R1.2.3: Add explicit apply command and policy check

**Description:** Add `neat fix --from <report> [--apply --yes]`, defaulting to
preview. Apply validates policy, action allowlist, and current before state.

**Acceptance criteria:**

- [x] No flags means preview only.
- [x] `--apply` without `--yes` refuses.
- [x] Observe/propose policy refuses apply; invalid policy refuses apply.
- [x] Changed target state refuses with conflict.
- [x] Applied action records before/after hashes and is idempotent.

**Verification:** CLI and policy tests cover every refusal and success path. ✅

**Dependencies:** R1.2.2 and explicit owner approval for action policy semantics.

**Files likely touched:** CLI command/test, action-aware policy adapter/test,
changeset.

**Estimated scope:** M.

### R1 release gate

- [x] Review artifacts cannot close a different diff.
- [x] Preview is the default for every write-related command.
- [x] Only one safe action exists.
- [x] Apply precondition/idempotency/policy tests pass.
- [x] Skill workflow supports `reviewed_no_change` without fake doc edits.

---

## 8. Phase R2 — persistence, portfolio, and daily

### PR R2.1 — Core persistence

#### Task R2.1.1: Approve persistence schema and migration

**Description:** Write a focused migration design for runs, finding occurrences,
and resolutions before changing the DB.

**Acceptance criteria:** ✅ Schema supports first/last seen, recurrence, closure,
and report identity without storing duplicate report blobs by default.

**Verification:** ✅ Owner-approved all-phase execution; ADR-003 records the
migration and rollback plan.

**Dependencies:** R0; may be designed in parallel with R1 but not implemented
without approval.

**Files likely touched:** Spec amendment and migration design doc.

**Estimated scope:** S.

#### Task R2.1.2: Implement repositories and migration

**Description:** Add core-owned storage APIs and tests; governance remains DB
independent.

**Acceptance criteria:** Migration round-trip, idempotency, concurrent upsert,
and older DB compatibility pass.

**Verification:** Core migration/repository tests and full suite pass.

**Dependencies:** R2.1.1.

**Files likely touched:** One migration, one repository module, index export,
tests, changeset.

**Estimated scope:** M.

#### Task R2.1.3: Add explicit `--record`

**Description:** CLI records only when requested, using core repositories.

**Acceptance criteria:** Default remains zero-write; repeated same run upserts
occurrences without duplication.

**Verification:** CLI temp-DB tests pass.

**Dependencies:** R2.1.2.

**Files likely touched:** CLI command/test and dependency wiring.

**Estimated scope:** S.

---

### PR R2.2 — Supervisor aggregation

#### Task R2.2.1: Add optional hygiene summary to repo health

**Description:** Extend supervisor schemas additively with the summary defined
in spec §16.

**Acceptance criteria:** Old reports parse; missing hygiene block remains valid;
no change to L0-L6 calculation.

**Verification:** Supervisor schema compatibility tests pass.

**Dependencies:** R2.1.

**Files likely touched:** Supervisor types/test and changeset/private package
metadata as required.

**Estimated scope:** S.

#### Task R2.2.2: Add bounded portfolio scanner

**Description:** Reuse the governance engine for enabled registry entries with
bounded concurrency and per-repo failure isolation.

**Acceptance criteria:** One failure does not abort others; ordering follows
registry order; no user memory is inspected.

**Verification:** 20-repo temporary portfolio test completes under target and
contains deterministic summaries.

**Dependencies:** R2.2.1.

**Files likely touched:** Supervisor hygiene scanner/test and exports.

**Estimated scope:** M.

---

### PR R2.3 — Daily visibility

#### Task R2.3.1: Integrate hygiene into daily brief

**Description:** Surface incomplete scans, errors, repeated warnings, and at
most three owner decisions using structured recommendations.

**Acceptance criteria:** Clean repos add no noise; no score; next actions use
machine command identifiers rather than parsed prose.

**Verification:** Daily JSON strict parse, Markdown snapshots, and delta tests
pass.

**Dependencies:** R2.2.

**Files likely touched:** Daily command/test and supervisor recommendation enum
or mapping if required.

**Estimated scope:** M.

#### Task R2.3.2: Add trend report

**Description:** Report count, age, recurrence, closure rate, and new/resolved
delta from persisted events.

**Acceptance criteria:** Trends are reproducible from event history; suppressed
findings are separated; no composite score.

**Verification:** Core query tests and CLI/report snapshots pass.

**Dependencies:** R2.1, R2.3.1.

**Files likely touched:** Core query/test and daily renderer/test.

**Estimated scope:** M.

### R2 release gate

- [ ] Default single-repo check is still stateless.
- [ ] Portfolio scans are bounded and isolated.
- [ ] Daily shows action, not routine clean metrics.
- [ ] Trend data is event-derived and score-free.

---

## 9. Phase R3 — explicit read-only memory adapters

### PR R3.1 — Adapter contract

#### Task R3.1.1: Freeze adapter interface and consent model

**Description:** Add the adapter contract from spec §17, explicit enablement,
version/evidence fields, and no-op behavior for absent platforms.

**Acceptance criteria:** Presence alone never enables scanning; adapter cannot
write; platform limits are adapter-owned.

**Verification:** Contract tests with fake adapters pass.

**Dependencies:** R0 gate; schedule after R2 unless owner reprioritizes.

**Files likely touched:** Governance adapter types/test/index and spec amendment.

**Estimated scope:** M.

### PR R3.2 — Claude Code read-only adapter

#### Task R3.2.1: Implement documented detection/inventory

**Description:** Read only the documented project auto-memory directory and
`MEMORY.md` limit after explicit enablement.

**Acceptance criteria:** Custom configured memory directory is respected; no
other projects are scanned; 200-line/25KB rule is labelled Claude-specific.

**Verification:** Tests use a fake home/settings directory and never touch real
Claude memory.

**Dependencies:** R3.1.

**Files likely touched:** Claude adapter/test/config extension/index.

**Estimated scope:** M.

#### Task R3.2.2: Integrate adapter findings

**Description:** Add memory surface metrics and hard-limit findings without
graduation, stale-topic, or last-reference heuristics.

**Acceptance criteria:** Disabled adapter changes nothing; absent platform is a
clean skip; findings include adapter id/version/source.

**Verification:** CLI human/JSON and golden adapter scenarios pass.

**Dependencies:** R3.2.1.

**Files likely touched:** Engine integration/test, CLI flags/help/test.

**Estimated scope:** M.

### R3 release gate

- [ ] Explicit consent required.
- [ ] Adapter is read-only.
- [ ] No platform limit is generalized.
- [ ] No real user memory appears in tests or fixtures.

---

## 10. Phase R4 — application automation and proposals

### PR R4.1 — Application-layer loop finalizer

#### Task R4.1.1: Add optional post-success orchestration

**Description:** After a successful loop run, the CLI/daemon application layer
may invoke neat check and attach evidence. `LoopEngine` remains unaware of neat.

**Acceptance criteria:** Disabled by default; failure cannot rewrite loop
outcome; report/incomplete state is visible to retro; no recursion.

**Verification:** Daemon and direct-command integration tests pass.

**Dependencies:** R2 persistence recommended.

**Files likely touched:** Daemon/application orchestrator/test and config/help.

**Estimated scope:** M.

### PR R4.2 — Repeated-finding improvement proposals

#### Task R4.2.1: Define recurrence policy

**Description:** Convert repeated high-confidence violations into draft
improvement proposals only after configurable occurrence/repository thresholds.

**Acceptance criteria:** One-off findings never propose; dedupe is stable;
proposal remains human-reviewed; no hook is installed automatically.

**Verification:** Core/supervisor proposal tests pass.

**Dependencies:** R2 trends.

**Files likely touched:** Recurrence policy/test, proposal adapter/test.

**Estimated scope:** M.

### R4 release gate

- [ ] Automation remains opt-in.
- [ ] Loop kernel has no governance dependency.
- [ ] Proposals are drafts, deduplicated, and evidence-backed.
- [ ] No hook or policy is modified automatically.

---

## 11. Risks and mitigations

| Risk | Impact | Mitigation and gate |
|---|---|---|
| False positives create alert fatigue | High | Conservative R0 rules, independent golden labels, precision gates |
| Config becomes a second truth | High | Config is explicitly machine authority; prose explains and links |
| `bin.ts` grows further | Medium | One dispatch branch; all behavior in command/governance modules |
| Governance public API breaks consumers | High | Additive exports, frozen schemas, changeset, existing scanner regression |
| Worktree diff semantics miss files | High | Temp Git fixtures for staged/unstaged/untracked/rename/delete |
| Scan silently incomplete | High | Hard limits produce `scan.incomplete` and completeness=false |
| Review artifact closes a new change | High | `diff_id` match required |
| Safe patch races with user edits | High | Before hash/existence precondition and conflict refusal |
| Policy gate is too coarse | High | No apply until action-aware validation is approved and tested |
| Portfolio registry lacks dependencies | Medium | No cross-repo impact claims until dependency schema exists |
| Platform memory leaks private data | High | Explicit consent, read-only adapters, fake-home tests, no R0 scanning |
| Skill duplicates CLI behavior | Medium | Thin workflow, no shell reimplementation, smoke validates CLI path |
| Hygiene score is gamed | Medium | No score; count/age/recurrence/closure only |

---

## 12. Parallelization and sequencing

Safe after shared contracts are frozen:

- R0.2 instruction inspector and R0.3 change-set foundation can proceed in
  parallel.
- R0.8 skill editorial playbook may be drafted while R0.7 evaluation runs, but
  it cannot be accepted until CLI JSON is frozen.
- R2.1 persistence design may be reviewed while R1 is implemented.
- R3 adapter research may occur read-only, but adapter code waits for the
  consent contract.

Must remain sequential:

- config/types before engine consumers;
- engine before CLI;
- CLI semantics before public JSON freeze;
- JSON freeze before skill release;
- resolution schema before review CLI;
- patch schema/provider before apply;
- persistence migration approval before DB code;
- supervisor schema before daily integration.

Coordination rule: if two PRs touch the same public schema, the earlier PR lands
and publishes the contract before the dependent branch rebases.

---

## 13. Final product completion checklist

The full upgrade is complete only when:

- [ ] R0-R4 release gates are met or later releases are explicitly descoped in
  an accepted spec amendment.
- [ ] Every public command, config, schema, and adapter is documented.
- [ ] Every write action has preview, confirmation, policy, precondition,
  idempotency, and evidence.
- [ ] Default local `neat` remains read-only and fast.
- [ ] Portfolio/daily aggregation uses the governance API, never CLI text.
- [ ] External memory requires explicit consent and remains source-faithful.
- [ ] No composite score is shipped without a separately accepted evaluation
  design.
- [ ] Full tests, build, typecheck, smoke, schemas, changesets, inventories, and
  attribution are green/current.
- [ ] Release handoff names remaining non-goals and operational rollback.

P0 was approved on 2026-07-17. The next authorized action is R0.1
implementation.

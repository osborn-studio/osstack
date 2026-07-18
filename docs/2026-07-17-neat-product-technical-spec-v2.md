# osstack `neat` v2 — Executable Product and Technical Specification

| Item | Value |
|---|---|
| Status | Accepted — implementation authorized 2026-07-17 |
| Date | 2026-07-17 |
| Product | `osstack neat` knowledge hygiene |
| Source draft | `docs/2026-07-17-neat-knowledge-hygiene-design.md` |
| Architecture decision | `docs/decisions/ADR-002-neat-knowledge-hygiene-boundary.md` |
| Implementation plan | `docs/superpowers/plans/2026-07-17-neat-implementation-plan.md` |
| Initial release | R0 read-only knowledge-contract checker |
| Owners | Product: Osborn; architecture/checker: designated CTO reviewer; implementation: maker agent |

---

## 1. Executive decision

`osstack neat` will be built as a **repository knowledge-contract checker**.

For a repository or a concrete Git change set, it answers:

1. Which project knowledge surfaces are inconsistent, missing, oversized, or
   likely affected by the change?
2. What deterministic evidence supports each finding?
3. Who or what may resolve it: a safe patch, an editorial agent, or a human
   decision?
4. Has every finding been fixed, reviewed as no-change-needed, accepted, or
   suppressed with an auditable reason?

The product is not a general Markdown linter and not an autonomous
documentation writer. R0 never edits repository or user-memory files.

### Product promise

> After a code change, `osstack neat` produces a deterministic, low-noise list
> of knowledge obligations that can be explained, closed, and rechecked.

### Why this product belongs in osstack

osstack already controls execution, verification, evidence, lessons, policy,
daily briefs, and portfolio supervision. Neat closes the remaining lifecycle
gap between a verified code change and the project knowledge future humans and
agents will rely on.

---

## 2. Assumptions and approval gate

This specification proceeds with the following explicit assumptions:

1. `AGENTS.md` is canonical for repositories managed with the osstack default,
   but every repository may override the direction in `.osstack/neat.yaml`.
2. A missing neat config enables only conservative zero-config observations; it
   never invents required files, naming rules, or document obligations.
3. Git is required for change-set mode. `--all` remains usable in a non-Git
   directory.
4. R0 ships no implicit persistence. `--record` is introduced only when the
   persistence schema is implemented.
5. The public JSON report is versioned independently from the outer
   `AgentCommandResult` envelope.
6. New public exports and user-visible CLI behavior receive changesets.
7. The owner accepted this specification and ADR-002 on 2026-07-17 and
   authorized implementation through R4.

Approval means accepting the product boundary, CLI contract, package ownership,
configuration authority, and release sequence defined here. Implementation
discoveries update this specification before changing code behavior.

---

## 3. Users and jobs to be done

### 3.1 Primary users

| User | Job | Required outcome |
|---|---|---|
| Developer finishing a change | Know whether instructions/docs need attention | Short actionable report in the terminal |
| Coding agent running `/neat` | Obtain structured evidence before editing prose | Stable JSON findings and resolution modes |
| CI maintainer | Gate only high-confidence knowledge violations | Deterministic exit code and no hidden writes |
| Portfolio owner | See repeated knowledge debt across registered repos | Later aggregation of open/recurring findings |
| Future agent | Understand why a finding was closed without a doc edit | Resolution evidence tied to a concrete diff |

### 3.2 Core user journeys

#### Journey A — local session close

```text
developer finishes code
  -> agent runs osstack neat check --format json
  -> agent edits only editorial targets
  -> human resolves ambiguous obligations
  -> agent reruns osstack neat check
  -> final summary lists zero unresolved blocking findings
```

#### Journey B — direct terminal check

```bash
osstack neat
```

The command checks the current worktree against `HEAD`, prints a human report,
and performs no writes.

#### Journey C — CI range check

```bash
osstack neat check --base "$BASE_SHA" --head "$HEAD_SHA" --fail-on error --format json
```

CI supplies explicit refs. The command never guesses a tag or merge base.

#### Journey D — full repository audit

```bash
osstack neat check --all --fail-on none
```

This audits recognized knowledge surfaces without a Git diff and is suitable
for onboarding or periodic manual review.

---

## 4. Scope and release boundaries

### 4.1 R0 — read-only MVP

R0 includes:

- `osstack neat` and `osstack neat check`;
- optional `.osstack/neat.yaml` with strict validation;
- canonical instruction and mirror checks;
- configured required-surface checks;
- configured line/byte budgets;
- conservative relative Markdown/import reference checks;
- explicit Git worktree or range change-set construction;
- configured change-to-document review contracts;
- deterministic human and JSON reports;
- configurable exit threshold;
- a thin companion skill after the CLI is stable.

### 4.2 R1 — resolution and controlled writes

R1 includes:

- a portable review/resolution artifact;
- `reviewed_no_change` and other explicit closure outcomes;
- an explicit `neat review` artifact-authoring command;
- safe patch preview;
- a single initial auto-fix: create a missing mirror as a one-line import when
  the target is absent and config explicitly requests it;
- apply preconditions and action-aware policy enforcement.

### 4.3 R2 — portfolio integration

R2 includes:

- bounded-concurrency scans over registered repos;
- optional hygiene summary on supervisor repo health;
- daily brief surfacing only blocking or recurring findings;
- persisted run/resolution history in `@osstack/core`;
- trend metrics based on count, age, recurrence, and closure rate.

### 4.4 R3 — platform memory adapters

R3 begins with an explicit, read-only Claude Code adapter. Other platforms are
added only from documented platform contracts. Memory adapters never inherit
Claude-specific limits by default.

### 4.5 R4 — automation and improvement proposals

R4 may add:

- an application-layer finalizer after a successful loop run;
- repeated-finding proposals for a hook or deterministic gate;
- dependency-aware cross-repository knowledge obligations after the registry
  has explicit dependency edges.

### 4.6 Explicit non-goals

- No generic Markdown style, spelling, or prose-quality linting.
- No automatic semantic rewriting of README or docs.
- No arbitrary rule extraction from prose during a deterministic check.
- No TypeScript/Python route, environment-variable, or schema heuristics in R0.
- No deletion, rename, merge, or cleanup of existing instruction files.
- No automatic editing of Claude, Codex, OpenCode, or OpenClaw memory.
- No composite hygiene score before real-world calibration.
- No parsing of CLI human output by downstream consumers.

---

## 5. Success metrics and release gates

### 5.1 R0 product metrics

| Metric | Release gate |
|---|---:|
| Blocking-finding precision on golden fixtures | >= 95% |
| Warning precision on golden fixtures | >= 80% |
| Default command writes | 0 |
| Same input/config report equality | byte-stable after normalized timestamps are excluded |
| Small repository check P95 | < 3 seconds |
| 20k recognized files protection | terminates with explicit incomplete-scan finding, never hangs |
| Existing `loop doctor` behavior | byte-identical for instruction checks |
| Strict JSON envelope parse | 100% |

Precision is measured against human-labelled repository fixtures. Coverage is
secondary: R0 intentionally prefers missing a semantic issue to producing a
high-confidence false alarm.

### 5.2 R1 product metrics

- Every actionable finding has exactly one supported resolution path.
- A review artifact for a different `diff_id` is rejected.
- Applying a patch after the target content hash changed is rejected.
- Reapplying an already-applied safe patch is a no-op.
- No write occurs without `--apply --yes` and an execution-allowing policy.

### 5.3 R2 product metrics

- Portfolio aggregation does not change per-repository finding semantics.
- One failing repository does not abort other scans.
- Daily shows at most three owner decisions and does not emit a vanity score.
- Trend data distinguishes new, recurring, resolved, suppressed, and stale
  findings.

---

## 6. Public CLI contract

### 6.1 Commands

```text
osstack neat
osstack neat check [options]
```

`osstack neat` is an exact alias for `osstack neat check`.

R0 options:

```text
--repo <path>                 Repository root; default cwd
--all                         Audit all recognized knowledge surfaces
--base <git-ref>              Base ref for a change set
--head <git-ref>              Head ref; valid only with --base
--config <path>               Config path; default <repo>/.osstack/neat.yaml
--checks <id,...>             Run only listed rule ids
--skip-checks <id,...>        Exclude listed rule ids
--format <human|json>         Default human
--json                        Alias for --format json
--fail-on <error|warning|none> Default none locally
--help
```

### 6.2 Mode resolution

Mode selection is deterministic:

1. `--all` selects full-audit mode.
2. `--base` with `--head` selects committed range mode.
3. `--base` without `--head` selects base-to-current-worktree mode.
4. With none of these flags, current-worktree mode compares `HEAD` with staged,
   unstaged, and untracked files.

Invalid combinations:

- `--all` with `--base` or `--head`;
- `--head` without `--base`;
- both `--checks` and `--skip-checks` containing the same rule;
- an unknown rule id;
- change-set mode outside a Git repository.

Full-audit mode does not require Git.

### 6.3 Exit codes

| Code | Meaning |
|---:|---|
| 0 | Check completed and fail threshold was not met |
| 1 | Check completed and findings met the fail threshold |
| 2 | Invalid arguments or invalid config |
| 3 | Runtime/environment failure prevented a complete check |

The JSON envelope status describes whether the command executed successfully;
it does not duplicate the hygiene threshold:

- completed scan, including one with findings: `status: ok`;
- invalid input/config: `status: error`, code `bad_request`;
- unreadable repository or Git failure: `status: error`, code `internal` or
  `conflict` according to the existing protocol taxonomy.

### 6.4 Human output

Human output is ordered by:

1. severity: error, warning, info;
2. rule id;
3. repository-relative path;
4. semantic anchor;
5. fingerprint.

Example:

```text
Knowledge hygiene: 1 error, 1 warning, 3 info

ERROR instruction.mirror_drift  CLAUDE.md
  Expected: one-line import of AGENTS.md or an allowed symlink
  Observed: independent 84-line instruction file
  Resolve: human_decision
  Fingerprint: khf_...

WARNING contract.review_required  packages/cli/src/bin.ts
  Contract: cli-public-surface
  Review one of: README.md, docs/inventory/CLI_COMMANDS.md
  Resolve: agent_edit or reviewed_no_change

Exit policy: --fail-on none (exit 0)
```

Absolute paths are excluded from normal finding messages to keep reports
portable. The report metadata may contain the resolved repository root.

---

## 7. Configuration contract

### 7.1 Location and authority

Default location:

```text
<repo>/.osstack/neat.yaml
```

The file is the authoritative machine contract. It is optional. A present but
invalid file fails closed with exit 2. The engine never silently falls back to
zero-config behavior after a parse or validation error.

### 7.2 Version 1 example

```yaml
version: 1

instructions:
  canonical: AGENTS.md
  mirrors:
    - path: CLAUDE.md
      mode: import_or_symlink

required_surfaces:
  - id: readme
    path: README.md
    severity: error
  - id: architecture-decisions
    path: docs/decisions
    kind: directory
    severity: warning

budgets:
  - id: agent-context
    path: AGENTS.md
    warn:
      lines: 200
      bytes: 15360
    error:
      bytes: 25600

contracts:
  - id: cli-public-surface
    when:
      any_path:
        - packages/cli/src/**
    review:
      any_path:
        - README.md
        - docs/inventory/CLI_COMMANDS.md
    enforcement: advisory

ignore:
  - rule_id: reference.markdown_target_missing
    paths:
      - docs/generated/**
    reason: generated on release
```

### 7.3 Schema semantics

#### `version`

- Required integer.
- R0 accepts only `1`.
- Unknown versions fail with a migration-oriented error.

#### `instructions`

- Paths are repository-relative POSIX paths.
- `canonical` must remain inside the repository root.
- Mirror modes in v1:
  - `import`: exact trimmed content `@<canonical>`;
  - `symlink`: symbolic link resolving to the canonical file;
  - `import_or_symlink`: either form.
- Independent real files are never auto-merged.

#### `required_surfaces`

- `kind` is `file` by default or `directory` explicitly.
- A missing surface produces the configured severity.
- The engine does not scaffold missing documents in R0.

#### `budgets`

- Every threshold is optional, but `warn` or `error` must contain at least one
  of `lines` or `bytes`.
- `error` values must be greater than or equal to corresponding `warn` values.
- Budgets measure raw UTF-8 bytes and logical lines using `\n` normalization.
- No universal AGENTS.md or docs limit exists without config or a platform
  adapter.

#### `contracts`

- `when.any_path` is matched against changed repository-relative paths.
- `review.any_path` is satisfied when at least one target path changed in the
  same change set.
- `enforcement: advisory` produces a warning and supports
  `reviewed_no_change` in R1.
- `enforcement: required` produces an error.
- A contract never proves semantic documentation correctness; it proves that a
  declared review obligation is unresolved.

#### Path patterns

Version 1 supports a deliberately small grammar:

- exact path;
- `*` matches within one path segment;
- `**` matches zero or more complete path segments.

Brace expansion, extglobs, character classes, negated globs, and platform
backslashes are rejected. All matching uses normalized POSIX separators.

#### `ignore`

- Every ignore entry requires a rule id, path list, and non-empty reason.
- Unknown rule ids fail validation.
- Ignore entries suppress matching findings but remain counted in report
  metadata as `suppressed_count`.
- Broad `**` suppression is rejected in v1.

### 7.4 Boundary validation

- Config YAML is parsed once at the package boundary and validated with Zod.
- Config input is capped at 1 MiB and YAML alias expansion is bounded.
- Duplicate ids are rejected.
- Absolute paths and paths escaping the repository via `..` are rejected.
- Symlink directories are not recursively traversed.
- Configured symlink targets outside the repository are reported and never
  followed for content scanning.

---

## 8. Domain contracts

All public domain schemas are Zod-first and exported by
`@osstack/governance`. JSON field names use snake_case to match osstack's
existing protocol artifacts. Governance exports an evidence-reference schema
that is structurally identical to protocol v1 `EvidenceRef`; this keeps the
engine independently buildable while the CLI validates the final envelope with
`@osstack/protocol`.

### 8.1 Report

```ts
interface KnowledgeHygieneReportV1 {
  schema_version: "1";
  generated_at: string;
  repo: {
    root: string;
    repo_id?: string;
  };
  input: {
    mode: "all" | "worktree" | "range" | "base_to_worktree";
    base_ref?: string;
    base_sha?: string;
    head_ref?: string;
    head_sha?: string;
    diff_id?: string;
    config_path?: string;
    config_sha256?: string;
  };
  completeness: {
    complete: boolean;
    skipped_files: number;
    reasons: string[];
  };
  summary: {
    error: number;
    warning: number;
    info: number;
    suppressed: number;
  };
  findings: KnowledgeHygieneFindingV1[];
  metrics: KnowledgeSurfaceMetricV1[];
}
```

`generated_at` is injectable in tests. Determinism assertions normalize this
single field before byte comparison.

### 8.2 Finding

```ts
interface KnowledgeHygieneFindingV1 {
  fingerprint: string;
  rule_id: KnowledgeHygieneRuleIdV1;
  rule_version: string;
  surface: "instruction" | "documentation" | "memory";
  severity: "error" | "warning" | "info";
  confidence: "high" | "medium" | "low";
  location: {
    path: string;
    line?: number;
    anchor?: string;
  };
  observed: Record<string, unknown>;
  expected: Record<string, unknown>;
  rationale: string;
  evidence_refs: EvidenceRef[];
  remediation: {
    mode: "safe_patch" | "agent_edit" | "human_decision";
    action_id?: string;
  };
}
```

Findings are immutable observations. They contain no mutable workflow status.

Fingerprint input:

```text
schema version + rule id + rule version + repo identity
+ normalized relative path + semantic anchor
```

Line numbers and human messages are excluded so moving a paragraph does not
create a new logical finding.

### 8.3 Resolution, introduced in R1

```ts
interface KnowledgeHygieneResolutionV1 {
  schema_version: "1";
  diff_id: string;
  fingerprint: string;
  outcome:
    | "fixed"
    | "reviewed_no_change"
    | "accepted_risk"
    | "suppressed"
    | "obsolete";
  actor: {
    kind: "human" | "agent";
    id: string;
  };
  reason: string;
  evidence_refs: EvidenceRef[];
  resolved_at: string;
}
```

An artifact whose `diff_id` does not match the current report is rejected,
preventing stale approval from closing a new change.

### 8.4 Surface metric and check input

```ts
interface KnowledgeSurfaceMetricV1 {
  surface: "instruction" | "documentation" | "memory";
  path: string;
  kind: "file" | "directory";
  exists: boolean;
  bytes?: number;
  lines?: number;
  sha256?: string;
}

interface KnowledgeHygieneCheckInputV1 {
  repo_root: string;
  mode: "all" | "worktree" | "range" | "base_to_worktree";
  base_ref?: string;
  head_ref?: string;
  config_path?: string;
  checks?: KnowledgeHygieneRuleIdV1[];
  skip_checks?: KnowledgeHygieneRuleIdV1[];
}
```

Metric byte and line counts are non-negative integers. A SHA-256, when
present, is lowercase hexadecimal. `base_ref` is required for `range` and
`base_to_worktree`; `head_ref` is required only for `range`. `checks` and
`skip_checks` are mutually exclusive and contain no duplicates. These
cross-field constraints are enforced by the schema, not deferred to the CLI.

### 8.5 Git change set

```ts
interface KnowledgeHygieneChangeV1 {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  old_path?: string;
  content_sha256?: string;
}

interface KnowledgeHygieneChangeSetV1 {
  schema_version: "1";
  repo_root: string;
  mode: "worktree" | "range" | "base_to_worktree";
  base_ref: string;
  base_sha: string;
  head_ref?: string;
  head_sha?: string;
  config_sha256?: string;
  changes: KnowledgeHygieneChangeV1[];
  changed_paths: string[];
  diff_id: string;
}
```

Renames contribute both `old_path` and `path` to `changed_paths`. Worktree
content hashes describe the final visible content (symlinks are hashed as link
text by Git); deleted content is identified by the resolved base SHA. Range
mode is content-addressed by its resolved base and head SHAs. The deterministic
`diff_id` covers the normalized change set and optional config SHA-256.

### 8.6 Rule specification

```ts
interface KnowledgeHygieneRuleV1 {
  id: KnowledgeHygieneRuleIdV1;
  version: string;
  default_severity: "error" | "warning" | "info";
  evaluate(input: RuleInputV1): readonly KnowledgeHygieneFindingV1[];
}
```

Rules are registered in one immutable table. Unknown configured rule ids are
boundary errors. Consumer switches are exhaustive.

### 8.7 Engine interface

```ts
interface KnowledgeHygieneEngineV1 {
  check(
    input: KnowledgeHygieneCheckInputV1,
    ports: KnowledgeHygienePortsV1,
  ): Promise<KnowledgeHygieneReportV1>;
}
```

Ports include repository reading, Git change construction, clock, and hashing.
Tests use fakes or temporary repositories; production uses Node adapters.

---

## 9. Package and module design

```text
packages/governance/src/
  knowledge-hygiene/
    types.ts                 Zod schemas and exported types
    config.ts                YAML loading + boundary validation
    path-pattern.ts          v1 path-pattern grammar
    fingerprint.ts           stable finding fingerprint
    instruction-source.ts    shared AGENTS/CLAUDE inspector
    change-set.ts            Git worktree/range adapter
    repository-reader.ts     bounded recognized-surface inventory
    engine.ts                orchestration and deterministic ordering
    rules/
      instruction-rule.ts
      required-surface-rule.ts
      budget-rule.ts
      reference-rule.ts
      change-contract-rule.ts
    index.ts
  index.ts

packages/cli/src/
  neat-command.ts            CLI parser, rendering, envelope, exit policy
  neat-command.test.ts
  bin.ts                     one dispatch branch + help text

neat-skill/
  SKILL.md                   thin workflow, <=150 lines target
  references/
    editorial-playbook.md
  THIRD_PARTY_NOTICES.md
```

### 9.1 Dependency rules

- Governance must not import CLI, supervisor, core state, or daemon modules.
- CLI may import governance and protocol.
- Supervisor may import governance only in R2.
- Core persistence receives plain validated domain values and does not import
  CLI.
- The skill calls the CLI; it does not reimplement `find`, `grep`, `wc`, or Git
  classification logic.

### 9.2 Existing-code integration

The current private `checkAgentInstructionDrift` logic is replaced by a public
governance inspector. `loop doctor` maps the inspector result back into its
existing check shape and preserves all established messages and details.

The existing `GovernanceFinding` and `scanFiles` APIs remain unchanged.

`osstack init` scaffolding is not reused for a missing surface: it creates a
larger project skeleton and has different product semantics. Neat never creates
an entire osstack scaffold as a side effect of a finding.

---

## 10. R0 evaluation pipeline

```text
1. Parse CLI boundary
2. Resolve and validate repository root
3. Load/validate neat config, or enter conservative zero-config mode
4. Build explicit input mode and Git change set when required
5. Inventory recognized knowledge surfaces with scan limits
6. Run applicable pure rules
7. Apply explicit suppressions
8. Sort findings and metrics deterministically
9. Build KnowledgeHygieneReportV1
10. Render human output or wrap in AgentCommandResult
11. Compute exit code from --fail-on
```

### 10.1 Recognized surfaces

R0 inventories only:

- configured instruction files and mirrors;
- root `AGENTS.md`, `CLAUDE.md`, and `README*.md` when present;
- Markdown under `docs/`;
- explicitly configured required, budget, contract, and ignore paths.

Default exclusions:

```text
.git/**
node_modules/**
.pnpm/**
dist/**
build/**
coverage/**
vendor/**
```

### 10.2 Scan limits

R0 defaults:

| Limit | Default |
|---|---:|
| Recognized files | 20,000 |
| Single Markdown file | 2 MiB |
| Total Markdown bytes read | 50 MiB |
| Git command timeout | 10 seconds |

Reaching a limit produces an explicit incomplete-scan error finding and sets
`completeness.complete` to false. It never silently omits coverage.

Git is invoked with `execFile`, never through a shell command string.

---

## 11. Rule catalog

### 11.1 R0 rule ids

| Rule id | Trigger | Default severity | Confidence | Resolution |
|---|---|---|---|---|
| `instruction.canonical_missing` | Configured canonical file absent | error | high | agent_edit |
| `instruction.mirror_missing` | Configured mirror absent | warning | high | safe_patch or agent_edit |
| `instruction.mirror_drift` | Mirror exists but violates declared mode | error | high | human_decision |
| `surface.required_missing` | Configured file/directory absent | configured | high | agent_edit |
| `budget.warn_exceeded` | Configured warning budget exceeded | warning | high | agent_edit |
| `budget.error_exceeded` | Configured error budget exceeded | error | high | agent_edit |
| `reference.markdown_target_missing` | Conservative relative Markdown link is missing | warning | high | agent_edit |
| `reference.instruction_import_missing` | `@relative/path` target is missing | error | high | agent_edit |
| `contract.review_required` | Change contract triggered and no declared review target changed | configured | medium | agent_edit or human_decision |
| `scan.incomplete` | Inventory limit or unreadable required surface | error | high | human_decision |

### 11.2 Conservative reference parsing

R0 checks only:

- Markdown inline links whose destination is a plain relative path;
- `@relative/path` imports in instruction files.

It ignores:

- `http`, `https`, `mailto`, `data`, and other URI schemes;
- fragment-only links;
- images and attachments;
- destinations containing unresolved variables;
- links inside fenced code blocks;
- Obsidian wikilinks;
- arbitrary path-looking prose.

Unsupported or ambiguous syntax is skipped, not guessed.

### 11.3 Zero-config behavior

Without `.osstack/neat.yaml`, R0:

- reports instruction-file inventory metrics;
- warns when AGENTS.md and CLAUDE.md are both independent non-empty files;
- checks conservative relative references in recognized surfaces;
- reports configured-platform limits only when a platform adapter is explicitly
  enabled in a later release.

It does not require AGENTS.md, docs/, README, naming conventions, or `.gitignore`
entries without an explicit contract.

---

## 12. JSON and protocol contract

`--format json` emits one strict `AgentCommandResult` using
`@osstack/protocol`'s string protocol version.

Successful shape:

```json
{
  "protocol_version": "1.0",
  "status": "ok",
  "result": {
    "command": "knowledge_hygiene.check",
    "report": {}
  },
  "evidence_refs": []
}
```

Rules:

- Findings live under `result.report.findings`.
- `next_actions` is optional and capped to three by the neat producer, but it
  is not used as a finding transport.
- Producer output parses under the strict protocol schema.
- Domain schemas are generated from governance Zod definitions and shipped
  with `@osstack/governance`.
- A good and bad frozen vector exist for report, finding, and resolution.
- Additive optional fields may extend schema version 1. Removing fields,
  changing enum meaning, or changing requiredness requires a new domain schema
  version.

---

## 13. Error and safety model

### 13.1 Read boundary

- Repository-relative configured paths cannot escape the repository root.
- Symlink directories are never recursively followed.
- Missing optional files are normal observations; unreadable required files are
  incomplete-scan errors.
- The scanner never reads user home memory in R0.
- The scanner never reads ignored build/vendor trees.

### 13.2 Write boundary, R1+

Every mutation is represented as a patch action with:

```text
action id
target relative path
expected before existence/hash
proposed content or patch
rationale
source finding fingerprint
risk classification
```

Apply requirements:

1. caller passes `--apply --yes`;
2. repository policy mode permits execution;
3. action type and target are allowed;
4. before precondition still matches;
5. action is idempotent;
6. before/after hashes are emitted as evidence.

Initial safe action:

- Create a missing mirror file containing an exact one-line import of the
  canonical file when the target path does not exist.

Not auto-fixable:

- replace an existing instruction file;
- merge independent instruction files;
- delete or rewrite dead references;
- create or rewrite general docs;
- rename paths;
- create symlinks automatically;
- modify `.gitignore` as part of knowledge hygiene;
- modify external agent memory.

### 13.3 Fail-closed meanings

- Invalid config: refuse the check rather than ignore config.
- Incomplete required inventory: report error rather than claim clean.
- Policy loader error: refuse apply.
- Missing policy file preserves current repository behavior for read-only
  checks; write commands still require explicit apply confirmation.

---

## 14. Companion skill contract

The `neat-skill` is an editorial application of the CLI, not an alternate
implementation.

Required workflow:

1. Run `osstack neat check --format json`.
2. Validate command success before trusting findings.
3. Handle `agent_edit` findings only within the user's requested repository.
4. Route `human_decision` findings to the user with evidence.
5. Never execute destructive actions.
6. Rerun the same check after edits.
7. Report remaining unresolved findings and skipped work.

The main `SKILL.md` targets <=150 lines and contains only triggers, workflow,
safety, and completion criteria. Detailed editorial guidance belongs in one
direct reference file. Adapted source material carries MIT attribution in
`THIRD_PARTY_NOTICES.md`.

---

## 15. Testing and evaluation strategy

### 15.1 Unit tests

Every rule uses table-driven tests covering:

- positive detection;
- clean case;
- ignore/suppression case;
- path normalization;
- invalid/ambiguous input;
- deterministic fingerprint and ordering.

### 15.2 Package tests

Governance tests cover:

- strict YAML/Zod config validation;
- duplicate ids and unknown versions;
- path escape and symlink boundaries;
- worktree/range change-set construction;
- scan limits and incomplete reports;
- frozen JSON vectors;
- existing `scanFiles` backward compatibility.

### 15.3 CLI tests

CLI tests use temporary repositories and injected output/clock/runner:

- default alias behavior;
- flag mutual exclusion and usage errors;
- every exit-code class;
- human ordering and stable messages;
- strict `AgentCommandResult` parsing;
- no write in R0;
- `loop doctor` regression after inspector extraction.

### 15.4 Golden repository fixtures

At least twelve labelled fixtures:

1. clean osstack-style AGENTS canonical repository;
2. valid one-line CLAUDE import;
3. valid symlink mirror;
4. independent conflicting instruction files;
5. docs-only repository with no instructions;
6. missing configured required surface;
7. valid and broken relative Markdown links;
8. code fences containing path-like text;
9. TypeScript change triggering an advisory contract;
10. triggered contract reviewed with no target edit;
11. non-Git full audit;
12. scan-limit/incomplete repository.

Human labels are the source of truth for precision metrics. The implementation
agent must not also be the only evaluator for release-gate precision.

### 15.5 Verification commands

Focused iteration:

```bash
pnpm --filter @osstack/governance test
pnpm --filter @osstack/governance typecheck
pnpm --filter @osstack/cli test -- neat-command
pnpm --filter @osstack/cli typecheck
```

PR completion:

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm lint
```

If root lint exposes pre-existing unrelated failures, the PR records them and
proves no new lint failures in changed files; it does not silently claim green.

---

## 16. Persistence and portfolio design, R2

R0 report generation is stateless. R2 may persist:

- scan run identity and normalized input;
- finding fingerprint occurrences;
- resolution events;
- first-seen and last-seen timestamps;
- recurrence count;
- closure duration.

Persistence belongs in core repositories and migrations. Governance remains
usable without a database.

Supervisor integration adds an optional hygiene block to repo health rather
than changing the L0-L6 closed-loop level:

```ts
interface RepoKnowledgeHygieneSummaryV1 {
  complete: boolean;
  error_count: number;
  warning_count: number;
  recurring_count: number;
  oldest_open_days?: number;
  checked_at: string;
}
```

Daily displays only:

- incomplete scans;
- open errors;
- repeated warnings above the configured recurrence threshold;
- at most three owner decisions.

No 0-100 hygiene score is introduced before observed portfolio data supports a
validated formula.

---

## 17. Platform memory adapter design, R3

Memory is a separate optional surface adapter:

```ts
interface KnowledgeSurfaceAdapterV1 {
  id: string;
  version: string;
  detect(input: AdapterDetectionInputV1): Promise<AdapterDetectionV1>;
  inventory(input: AdapterInventoryInputV1): Promise<KnowledgeSurfaceInventoryV1>;
  rules(): readonly KnowledgeHygieneRuleV1[];
}
```

Requirements:

- Explicit enablement by config or CLI; filesystem presence alone is not
  permission to inspect user memory.
- Read-only in the first release of every adapter.
- Platform-specific documented paths and limits.
- Adapter version and evidence source included in findings.
- Missing platform is a clean skip, not an error.
- No "last referenced" metric until osstack has an actual read/recall event
  source; file timestamps are not used as a proxy.

The first adapter targets Claude Code because its auto-memory limit and storage
contract are documented. Codex/OpenCode/OpenClaw adapters require their own
verified contracts before implementation.

---

## 18. Boundaries

### Always do

- Update this specification before changing public semantics.
- Validate config and external data at boundaries.
- Keep findings deterministic and evidence-backed.
- Preserve existing `GovernanceFinding` and `loop doctor` behavior.
- Add focused tests and a changeset for public/user-visible increments.
- Use repository-relative paths in portable results.
- Record incomplete coverage explicitly.

### Ask first

- Add a new runtime dependency outside already-used workspace libraries.
- Add or change a database migration.
- Change CI workflows.
- Enable a write action beyond the single approved mirror creation.
- Add a platform memory adapter.
- Change an R0 rule from advisory to blocking by default.
- Add dependency edges to the portfolio registry.

### Never do

- Parse human CLI text as an API.
- Treat prose as an automatically executable rule source.
- Delete, rename, merge, or overwrite user knowledge automatically.
- Traverse arbitrary paths outside the repository in R0.
- Claim a complete scan after hitting a limit or read failure.
- Produce a composite score without an accepted evaluation design.
- put governance engine logic back into `bin.ts`.

---

## 19. Release and rollback

Every implementation increment is additive and independently revertible.

R0 release obligations:

- changeset for `@osstack/governance` public exports;
- changeset for `@osstack/cli` command surface;
- CLI help and generated inventory updated through their canonical generator;
- README quick-start example;
- strict JSON vector and schema check;
- full build/typecheck/test evidence;
- source-skill attribution.

Rollback is package/command removal plus reverting the dispatch branch. R0 does
not migrate persistent state, so rollback has no data migration.

R1/R2 increments with persisted artifacts or migrations must define forward and
backward compatibility separately in their PR specifications.

---

## 20. Definition of done

R0 is complete only when all are true:

- [ ] ADR-002 is accepted.
- [ ] `osstack neat` and `osstack neat check` implement the documented CLI.
- [ ] Config v1 validates strictly and has frozen good/bad fixtures.
- [ ] All R0 rules exist with positive, clean, boundary, and suppression tests.
- [ ] Default execution performs zero writes.
- [ ] Human and JSON output are deterministic.
- [ ] JSON parses under strict `AgentCommandResult` and domain schemas.
- [ ] Existing governance exports and loop doctor behavior remain compatible.
- [ ] Golden fixture precision gates pass under independent review.
- [ ] `pnpm typecheck`, `pnpm build`, and `pnpm test` pass.
- [ ] README, CLI inventory, help, changesets, and third-party notice are current.
- [ ] The companion skill completes the check-edit-recheck scenario end to end.

R0 completion does not imply R1-R4 completion. Each later release has its own
gate in the implementation plan.

---

## 21. References

- `docs/2026-07-17-neat-knowledge-hygiene-design.md`
- `docs/decisions/ADR-001-shared-control-kernel.md`
- `docs/decisions/ADR-002-neat-knowledge-hygiene-boundary.md`
- `docs/specs/AGENT_COMMAND_PROTOCOL_V1.md`
- `docs/specs/POLICY_PROFILE_V1.md`
- Original MIT skill: <https://github.com/KKKKhazix/khazix-skills/tree/main/neat-freak>
- Agent Skills specification: <https://agentskills.io/specification>
- Claude Code memory contract: <https://code.claude.com/docs/en/memory>

# `osstack neat` knowledge hygiene

`osstack neat check` is a deterministic, read-only repository check for
instruction sources, required knowledge surfaces, configured budgets,
conservative relative references, and change-review obligations. It does not
use a model to invent findings or rewrite prose. `osstack neat review` is a
separate, explicit write command that only creates or updates the output path
provided by the caller.

## Quick start

Installed CLI:

```bash
# Current worktree, informational exit policy.
osstack neat check --fail-on none

# CI range; fail when an error or warning is present.
osstack neat check \
  --base origin/main \
  --head HEAD \
  --format json \
  --fail-on warning

# Full repository audit without Git change-contract evaluation.
osstack neat check --all --fail-on none
```

From this source repository:

```bash
pnpm --filter @osstack/cli build
node packages/cli/dist/bin.js neat check --all --fail-on none
```

`osstack neat` is an alias of `osstack neat check`.

## Portable review evidence

Use a review artifact when a finding has been checked but should no longer be
active for exactly the report diff that produced it. In worktree mode, keep the
report and review artifact outside the repository: adding either file inside
the worktree changes the content-addressed `diff_id`.

```bash
neat_artifacts="$(mktemp -d -t neat-review)"
report_file="$neat_artifacts/report.json"
review_file="$neat_artifacts/review.json"

osstack neat check --json --fail-on none > "$report_file"
osstack neat review \
  --report "$report_file" \
  --finding khf_... \
  --outcome reviewed_no_change \
  --reason "No maintained documentation changed" \
  --actor osborn \
  --output "$review_file"
osstack neat check --review-file "$review_file" --json --fail-on warning
```

`--report` accepts either the raw v1 domain report or the successful strict CLI
JSON envelope. Review outcomes are `fixed`, `reviewed_no_change`,
`accepted_risk`, `suppressed`, and `obsolete`; `--actor-kind` defaults to
`human` and also accepts `agent`. Creation has no implicit output or database,
rejects symbolic-link outputs, and updates a regular output file atomically.

`--review-file` fails with exit 2 unless its `diff_id` and every fingerprint
match the newly generated report. JSON keeps unresolved findings in `findings`
and evidence-preserving `{ finding, resolution }` entries in
`resolved_findings`; `summary.resolved` reports their count. `--fail-on` uses
only unresolved severity counts.

## Safe patch preview and apply

`neat fix` supports one closed low-risk action: create a missing instruction
mirror containing exactly one confined import line. Preview is always the
default and does not require write policy:

```bash
osstack neat fix --from "$report_file"
osstack neat fix --from "$report_file" --json
```

The preview includes the absent-target precondition, final content hash, source
finding, evidence, and stable patch/action IDs. It refuses existing targets,
symlink-only mirror mode, a missing canonical source, stale config hash, and
reports without a `diff_id`.

Apply requires both confirmation flags and a complete source report:

```yaml
# .osstack/policy.yaml
schema_version: 1
mode: execute
auto_apply: true
allowed_auto_changes: [docs]
```

```bash
osstack neat fix --from "$report_file" --apply --yes
```

`observe` and `propose` modes, missing/invalid policy, `requires_approval`,
forbidden docs, and a missing docs allowlist all fail closed. `--yes` confirms
the command but is not approval evidence. Apply rechecks the target immediately
before writing, resolves parent symlinks inside the repository, and uses an
atomic no-replace create. A concurrent different target is preserved and
reported as a conflict; repeating the exact applied action reports
`already_applied`.

## Explicit history recording

Checks remain stateless unless `--record` is present. To append normalized run,
finding occurrence, closure, and resolution events to the core state DB:

```bash
osstack neat check --record --json --fail-on none
osstack neat check --record --db /absolute/path/to/state.db --json
```

The default is `$OSSTACK_HOME/state.db` (or `~/.osstack/state.db`). `--db`
requires `--record`. The DB stores report SHA identity and bounded normalized
metadata, not duplicate report JSON blobs. Recording the identical report again
returns `inserted: false` and does not increase occurrence counts. Only a
complete report can infer `closed_absent` for a previously active finding.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | Check completed and the selected `--fail-on` threshold was not met. |
| 1 | Check completed and findings met the threshold. |
| 2 | Arguments or `.osstack/neat.yaml` are invalid. |
| 3 | A runtime, Git, filesystem, or environment failure prevented a complete check. |

`--fail-on none` never hides findings; it only makes a completed check exit 0.
An incomplete inventory is still represented by `scan.incomplete`.

## Configuration v1

The optional authoritative config is `<repo>/.osstack/neat.yaml`. A present but
invalid file fails closed. Unknown keys are rejected.

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
    kind: file
    severity: error

budgets:
  - id: agent-context
    path: AGENTS.md
    warn: { lines: 120, bytes: 16384 }
    error: { lines: 200, bytes: 32768 }

contracts:
  - id: cli-public-surface
    when:
      any_path: [packages/cli/src/**]
    review:
      any_path: [README.md, docs/inventory/CLI_COMMANDS.md]
    enforcement: advisory

ignore:
  - rule_id: reference.markdown_target_missing
    paths: [docs/generated/**]
    reason: generated only during release
```

### Exact field reference

| Field | Required | Accepted value |
|---|---|---|
| `version` | yes | Integer `1`. |
| `instructions.canonical` | when `instructions` exists | Repository-relative file path. |
| `instructions.mirrors[].path` | per mirror | Repository-relative file path. |
| `instructions.mirrors[].mode` | per mirror | `import`, `symlink`, or `import_or_symlink`. |
| `required_surfaces[].id` | per entry | Unique lowercase identifier using letters, digits, `.`, `_`, or `-`. |
| `required_surfaces[].path` | per entry | Repository-relative path. |
| `required_surfaces[].kind` | no | `file` (default) or `directory`. |
| `required_surfaces[].severity` | no | `warning` (default), `error`, or `info`. |
| `budgets[].id` | per entry | Unique identifier. |
| `budgets[].path` | per entry | Repository-relative file path. |
| `budgets[].warn` / `.error` | at least one | Object with positive integer `lines`, `bytes`, or both. Error thresholds cannot be below warning thresholds. |
| `contracts[].id` | per entry | Unique identifier. |
| `contracts[].when.any_path` | per entry | Non-empty v1 path-pattern list. |
| `contracts[].review.any_path` | per entry | Non-empty v1 path-pattern list. |
| `contracts[].enforcement` | no | `advisory` (warning) or `required` (error). |
| `ignore[].rule_id` | per entry | A known rule id. |
| `ignore[].paths` | per entry | Non-empty v1 path-pattern list; broad `**` is forbidden. |
| `ignore[].reason` | per entry | Non-empty explanation. |

Paths use POSIX separators, must remain inside the repository, and reject brace
expansion, extglobs, character classes, negated globs, and backslashes. Patterns
support exact paths, `*` within one segment, and `**` as a complete segment.

## Checks

| Rule | Default result |
|---|---|
| `instruction.canonical_missing` | error |
| `instruction.mirror_missing` | warning |
| `instruction.mirror_drift` | error when configured; warning in zero-config conflict detection |
| `surface.required_missing` | configured severity |
| `budget.warn_exceeded` | warning |
| `budget.error_exceeded` | error |
| `reference.markdown_target_missing` | warning |
| `reference.instruction_import_missing` | error |
| `contract.review_required` | advisory warning or required error |
| `scan.incomplete` | error |

Reference checks intentionally recognize only plain relative inline Markdown
links and exact-line `@relative/path` instruction imports. URLs, images,
fragments, wikilinks, code fences, unresolved variables, and ambiguous syntax
are skipped.

## Machine output

`--json` emits one strict `AgentCommandResult`. A completed check has
`status: ok` even when findings exist; the domain report is at
`result.report`. Finding/report v1 schemas ship with `@osstack/governance`:

- [finding v1 schema](../../packages/governance/schemas/knowledge-hygiene-finding-v1.schema.json)
- [report v1 schema](../../packages/governance/schemas/knowledge-hygiene-report-v1.schema.json)
- [patch action v1 schema](../../packages/governance/schemas/knowledge-hygiene-patch-action-v1.schema.json)
- [patch plan v1 schema](../../packages/governance/schemas/knowledge-hygiene-patch-plan-v1.schema.json)

## Companion skill

Use [`neat-skill`](../../neat-skill/SKILL.md) for an evidence-led
check-edit-recheck close-out. The skill delegates all mechanical decisions to
this CLI, routes `human_decision` findings to the user, and never claims success
after an incomplete scan.

## R0 non-goals

Without explicit `review`, `fix --apply`, or `--record`, the checker does not
write files, inspect external agent memory, perform semantic prose
linting, infer rules from arbitrary prose, check external URLs, persist finding
history, produce a composite score, or auto-fix findings. It never deletes,
renames, merges, or rewrites instruction files.

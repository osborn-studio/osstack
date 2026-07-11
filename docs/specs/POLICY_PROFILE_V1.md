# POLICY_PROFILE_V1

Status: Draft
Version: 1.0.0
Date: 2026-07-11
Owner: Fable 5 (CTO); shapes from Doc 16 §7, constraints per ADR-001.

The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as
described in RFC 2119.

A policy profile is the human-owned contract that bounds what osstack may do
in a repository. It is git-tracked (reviewable, versioned) and enforced by the
kernel gates — never by prompt text alone.

## P-001 Files

A managed repo declares two files:

- `.osstack/repo.yaml` — identity and command contract
  (`schemas/repo-config.schema.json`)
- `.osstack/policy.yaml` — authority and budgets
  (`schemas/policy-profile.schema.json`)

Both MUST be YAML, MUST carry `schema_version: 1`, and MUST validate against
their schema. **Unknown keys MUST be rejected (fail-closed)** — the same
discipline as `DiscoveryPolicy` in `@osstack/loop`: a typo'd key silently
falling through to a default is a policy hole, not a convenience.

## P-002 `.osstack/repo.yaml`

```yaml
schema_version: 1
product: osborn-pa
domain: osbornpa.com
role: core_product          # core_product | tool | library | reference | archive
priority: 100               # 0-100
default_branch: main
verify_command: "pnpm test"
build_command: "pnpm -r build"
staging_command: ""         # optional
production_environment: ""  # optional, descriptive
```

- `verify_command` MUST be deterministic (exit code is the gate). It is the
  single CI-equivalent verification entry point (Doc 16: 唯一 verify contract).
- Commands here are *declarations*; execution authority comes from
  `.osstack/policy.yaml`.

## P-003 `.osstack/policy.yaml`

```yaml
schema_version: 1
mode: propose               # observe | propose | execute
auto_apply: false
allowed_auto_changes:
  - docs
  - tests
  - lint
requires_approval:
  - product_scope
  - source
  - dependencies
  - ci
  - database_migrations
  - production_deploy
forbidden:
  - secrets
  - destructive_git
  - unreviewed_external_actions
budgets:
  max_iterations: 5
  max_runtime_minutes: 45
  max_cost_usd: 20
```

Semantics:

- `mode: observe` — osstack MAY read and report; MUST NOT modify the repo.
- `mode: propose` — osstack MAY prepare branches, diffs, and proposals; MUST
  NOT merge, deploy, or apply to the default branch.
- `mode: execute` — osstack MAY apply changes in categories listed in
  `allowed_auto_changes` when `auto_apply: true` AND deterministic gates pass;
  everything in `requires_approval` still requires a human ApprovalDecision
  (AGENT_COMMAND_PROTOCOL_V1 A-005).
- `forbidden` categories MUST be refused regardless of mode, approval, or
  actor. They are not overridable by an agent actor.
- Budgets map onto the loop budget primitives (`max_iterations`,
  `max_runtime_minutes` → `max_runtime_ms`, `max_cost_usd`). Exceeding a
  budget MUST stop work with `budget_exceeded`, never silently continue.

## P-004 Resolution Order

1. `forbidden` (hard deny, first)
2. `requires_approval` (gate)
3. `allowed_auto_changes` + `mode` + `auto_apply` (permit)
4. default: propose-only.

A change touching multiple categories MUST be governed by the strictest
matching rule. When no category matches, the change requires approval.

## P-005 Category Vocabulary (v1, closed)

`docs`, `tests`, `lint`, `source`, `dependencies`, `ci`,
`database_migrations`, `production_deploy`, `product_scope`, `secrets`,
`destructive_git`, `unreviewed_external_actions`.

The vocabulary is CLOSED in v1: schemas MUST reject categories outside it.
Extending the vocabulary is a minor version bump of this spec plus schema
update — never an ad-hoc string.

## P-006 Defaults and Onboarding

First onboarding of any repo MUST use `mode: propose`, `auto_apply: false`
(Doc 16: 首轮统一 propose). Loosening to `execute` for a category SHOULD cite
dogfood evidence (successful verified deliveries) in the PR that changes the
policy file. Policy file changes are `ci`-category changes and therefore
themselves require approval.

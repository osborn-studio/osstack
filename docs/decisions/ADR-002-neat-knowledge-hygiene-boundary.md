# ADR-002: Neat uses a governance engine with a thin CLI surface

## Status

Accepted — owner approval recorded 2026-07-17.

## Date

2026-07-17

## Context

The original `neat` draft proposed engineering the `neat-freak` Agent Skill
into an osstack capability that audits project instructions, documentation,
and agent memory. The draft correctly separated deterministic inspection from
LLM editorial work, but its first implementation boundary placed the engine in
`@osstack/cli` and deferred extraction until portfolio support was added.

That creates four problems:

1. `@osstack/supervisor`, daemon workflows, CI consumers, and future product
   surfaces cannot consume a CLI-private engine without a later ownership
   migration.
2. Repository rules described in prose cannot be deterministically enforced
   unless their machine semantics have an authoritative contract.
3. Platform-specific memory limits and locations are not universal repository
   invariants.
4. A scanner finding, a proposed edit, and a human decision have different
   lifecycles and must not be collapsed into one mutable record.

ADR-001 already establishes that shared capabilities must be consumed through
published package APIs or versioned protocols, never by importing or parsing
`@osstack/cli` output.

## Decision

### 1. Engine ownership

The deterministic knowledge-hygiene engine will live under
`@osstack/governance`, in a new `knowledge-hygiene/` module. The existing
`GovernanceFinding` source scanner remains compatible; neat introduces its own
versioned domain schemas instead of widening the existing type.

`@osstack/cli` owns only:

- argument parsing;
- human rendering;
- `AgentCommandResult` wrapping;
- exit-code policy;
- explicit write orchestration for later fix/review commands.

Optional persistence belongs in `@osstack/core`. Portfolio aggregation belongs
in `@osstack/supervisor`.

### 2. Machine rule authority

`.osstack/neat.yaml` is the authority for machine-executable repository
contracts. `AGENTS.md`, `CLAUDE.md`, and project documentation explain why a
rule exists and link to the configuration; they are not parsed as a hidden
configuration language.

The engine may generate a proposed config fragment from prose in a future
Agent workflow, but it never activates that fragment without explicit review.

### 3. Product boundary

The first product is a repository knowledge-contract checker:

- default behavior is read-only;
- findings are immutable observations;
- resolution evidence is stored separately;
- re-running the same input produces the same ordered report;
- external agent memory is out of the initial release.

### 4. Public interface

The stable command family begins with:

```text
osstack neat
osstack neat check
```

`check` is the single verification operation. A separate `verify` command and
implicit "latest report" state are intentionally avoided. Editing followed by
another `check` is the verification loop.

## Alternatives considered

### Keep all logic in `@osstack/cli`

- Advantage: fewer initial package edits.
- Rejected: guarantees a later extraction before supervisor and daemon reuse,
  and violates the long-term package boundary established by ADR-001.

### Create a new `@osstack/knowledge-hygiene` package

- Advantage: strongest domain isolation.
- Rejected for the initial release: the repository already has many packages,
  and deterministic repository-policy inspection fits the governance domain.
  A new package may be reconsidered if neat gains independent consumers or a
  release cadence incompatible with governance.

### Put neat into `@osstack/knowledge`

- Advantage: the name appears related.
- Rejected: `@osstack/knowledge` owns knowledge packs and retrieval, not
  repository conformance or documentation drift.

### Treat instruction prose as the canonical machine rule source

- Advantage: one visible human document.
- Rejected: reliable extraction requires semantic interpretation and cannot
  guarantee deterministic CI behavior. It also makes rule behavior change when
  prose is reworded.

### Include Claude/Codex/OpenCode/OpenClaw memory in R0

- Advantage: closer feature parity with the source skill.
- Rejected: locations, ownership, safety, and hard limits are platform-specific.
  Memory adapters will be explicit, read-only, versioned extensions.

## Consequences

- `@osstack/governance` gains Zod and YAML boundary validation and new public
  exports; this requires a changeset and compatibility tests.
- `loop doctor` will consume a shared instruction-source inspector while
  preserving its current output byte-for-byte.
- The CLI does not persist scan artifacts unless the caller explicitly asks it
  to record a run.
- Portfolio reporting can consume the same engine without importing CLI code.
- The R0 feature set is smaller than the original draft, but its behavior is
  testable, explainable, and suitable for CI.
- Composite hygiene scores, language-specific source heuristics, automatic
  memory edits, and arbitrary prose rewriting are deferred.

## Revisit conditions

Reconsider this ADR if any of these becomes true:

- two non-osstack products require the engine but cannot depend on governance;
- governance release cadence blocks independent neat releases;
- memory adapters become the majority of the implementation;
- a stable industry knowledge-hygiene protocol supersedes the local schemas.

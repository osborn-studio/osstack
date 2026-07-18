# ADR-004: probe uses a pure governance engine and portable ledgers

- Status: Accepted
- Date: 2026-07-18
- Decision owner: repository owner
- Scope: `probe` product boundary and v1 artifact authority

## Context

`probe` turns unknowns discovered before and during implementation into
versioned questions, dispositions, document destinations, and readiness
obligations. It must support a one-question-at-a-time product experience while
also remaining deterministic enough for CLI automation, CI, kanban guards,
Loop Engineering, neat, daily reporting, and supervisor aggregation.

Putting this logic in `@osstack/cli` would make every non-CLI consumer depend on
a product-private adapter. Treating a developer-machine SQLite database as the
only authority would make pull requests and CI unable to reproduce readiness.
Treating Markdown as a writable machine ledger would make state reconstruction
ambiguous and vulnerable to accidental edits.

ADR-001 requires shared kernel capabilities to use published package APIs or
versioned protocols instead of importing CLI implementation. ADR-002 applies
the same ownership rule to the neat governance engine. `probe` needs the same
boundary, plus an explicit distinction between live session state and portable
review artifacts.

## Decision

### 1. Engine and adapter ownership

The deterministic `probe` domain engine lives in `@osstack/governance` under
`packages/governance/src/probe/` and is exported from the package root. It owns
strict schemas, state transitions, question ranking, versioned static packs,
readiness evaluation, gate policy interpretation, render models, and restricted
evaluation-template compilation.

`@osstack/core` owns SQLite migrations and the transactional probe repository.
It stores already-validated snapshots and events, enforces idempotency and
optimistic revisions, and does not reproduce governance decisions.

`@osstack/cli` owns argument parsing, dependency composition, human rendering,
`AgentCommandResult` envelopes, exit codes, and explicit artifact writes. No
kernel or portfolio package may import the CLI implementation or parse its
human output.

The `probe-skill` owns LLM-assisted blind-spot discovery, prototype reaction,
semantic restatement comparison, and one-question-at-a-time interaction. It
must call the CLI's strict inputs and must not maintain a parallel ledger or
gate implementation.

### 2. Live and portable authority

The core-owned SQLite repository is authoritative for a live local session.
Every domain mutation appends exactly one event and advances the session
revision in the same transaction. Idempotency receipts and compare-and-swap
revision checks prevent retries and competing writers from corrupting state.

For repository delivery and cross-machine verification, the authority is the
strict `docs/probe/sessions/<session-id>/ledger.json` exported at a declared
revision. `ledger.md` is a human projection bound to the canonical JSON digest.
`render-manifest.json` is written last and binds every completed output by hash
and byte length. CI must receive an explicit ledger path and never infer a
developer machine's latest session.

SQLite and exported JSON are not independently editable truths. Continuing a
session requires a new render. Markdown cannot be imported back into live state.

### 3. Package and integration boundary

R0 does not create a new workspace package. The domain fits the existing
governance responsibility, and storage fits core. Cross-domain integrations use
public package APIs, portable schemas, or application-level ports/callbacks:

- Loop core does not import probe; a CLI observer may translate structured
  implementation deviations into probe mutations.
- Kanban provides a generic transition-guard port with no probe-specific
  branch.
- neat, daily, and supervisor consume public governance/core APIs or portable
  artifacts, never CLI-private code.

### 4. Safe release defaults

The readiness gate defaults to report-only. Blocking requires an explicit,
valid `.osstack/probe.yaml` policy or explicit guard registration. SQLite
migrations are additive and forward-only. Rolling back the application leaves
probe tables and ledgers intact; disabling block enforcement does not delete
evidence.

## Alternatives considered

### Keep the engine in `@osstack/cli`

- Advantage: fewer files in the first vertical slice.
- Rejected: violates ADR-001, prevents clean reuse, and guarantees a later
  ownership migration.

### Create `@osstack/probe`

- Advantage: maximum domain isolation and independent release cadence.
- Rejected for v1: the current responsibility fits governance, and another
  package would add release and dependency surface without a second external
  consumer. Reconsider when the revisit conditions are met.

### Use SQLite as the only authority

- Advantage: one mutable store for the CLI.
- Rejected: CI, reviewers, and clean machines cannot reproduce local state, and
  pull requests would contain no auditable contract.

### Use Markdown as the machine ledger

- Advantage: a single human-friendly file.
- Rejected: stable parsing, canonical hashing, strict union validation, and
  concurrent update semantics become unreliable.

### Let stack or Loop import probe directly

- Advantage: fewer adapter functions.
- Rejected: couples generic lifecycle primitives to one product and reverses
  package dependency direction.

## Consequences

- `@osstack/governance`, `@osstack/core`, and `@osstack/cli` receive additive
  public behavior and require changesets.
- Every machine object and portable artifact has a versioned strict schema.
- The CLI can work without an LLM, while the skill can add semantic value
  through validated dynamic inputs.
- Consumers can verify readiness without access to local SQLite state.
- Rendering must use fail-closed, manifest-last atomic publication.
- A completed implementation spans multiple packages, but each integration is
  independently testable and rollback-friendly.

## Revisit conditions

Reconsider a standalone `@osstack/probe` package if any of these becomes true:

- two non-osstack products need the domain engine;
- governance release cadence blocks probe releases;
- probe dependencies or public surface dominate the governance package;
- an interoperable external unknowns/elicitation protocol supersedes v1.

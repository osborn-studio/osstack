# ADR-001: Shared Control Kernel, Two Product Surfaces

Status: Accepted (owner-approved 2026-07-11)
Context docs: `docs/product/15_OSSTACK_5_6_PRODUCT_AND_ARCHITECTURE.md`,
`docs/product/16_GITHUB_FIRST_CORE_PRODUCT_UPGRADE_PORTFOLIO.md`,
plan `docs/superpowers/plans/2026-07-11-osstack-r0-r1.md`.
Audit baseline: `main @ 08df7be` (inventories in `docs/inventory/`).

## Decision

osstack is organized as **one shared control kernel with two product
surfaces**. The kernel (contracts, loop, policy, gates, evidence, knowledge
asset protocol) is consumed by the osstack internal product (CLI + agent
surfaces) today and may later be consumed by PartnerOS. The two products do
not merge into one UX and do not duplicate the loop runtime.

### D1. Kernel-schema package is `@osstack/protocol` (new)

The Doc 15 proposal named the kernel-schema package `@osstack/contracts`, but
that name is already taken by the API contract checker
(`ContractManifest`/`ContractFinding` — frontend/backend HTTP alignment).
Owner decision: **create `@osstack/protocol`; do not rename or repurpose the
existing `@osstack/contracts`**, which stays compatible as-is.

`@osstack/protocol` owns the stable cross-product / cross-process /
cross-agent contracts:

- Task / Run / Event
- Evidence reference
- Approval request / decision
- Policy decision
- Agent command envelope (per `AGENT_COMMAND_PROTOCOL_V1`)
- JSON Schema artifacts and an explicit `protocol_version`

Constraints (owner-set):

- MUST NOT depend on `@osstack/cli` (or any product-surface package).
- Domain-neutral wherever possible.
- v1 extracts only contracts that are genuinely shared today — it does not
  pre-import every internal type.
- Ships schema fixtures, invalid fixtures, backward-compatibility tests, and
  conformance tests from the first version.

### D2. State repositories move from the CLI into `@osstack/core` (R1.1)

Audit fact: run/task/event/approval Zod schemas live in
`core/src/state/schema.ts`, but the insert/read repositories live in
`packages/cli/src/store.ts` (plus raw SELECTs in `daemon.ts`, `dashboard.ts`,
`bin.ts`). An external consumer therefore cannot read run/event/proof state
without the product-private CLI.

Owner decision: approved as R1.1 with these constraints:

- First increment is **ownership relocation only** — no DB behavior, schema,
  or CLI behavior changes.
- `@osstack/core` owns the repository API and implementation; the CLI calls
  core.
- Compatibility re-exports are kept for any existing import path, with the
  migration path documented.
- Tests must cover migration, round-trip, concurrency, error paths, and CLI
  compatibility.
- No opportunistic business-logic refactoring or new DB design in the same PR.
- Merge only after the full suite and conformance tests pass.

### D3. Consumption rules for the kernel

- No consumer may import `@osstack/cli` or parse osstack CLI text output as an
  API (audit confirms nothing does today; this ADR makes it a rule).
- Shared capabilities are consumed only via published package APIs, JSON
  Schemas, or daemon RPC.
- `@osstack/supervisor` stays `private` until its conformance story is
  complete; PartnerOS may not depend on it.
- PartnerOS integration work itself is explicitly deferred (owner: "暂时不要
  开始 PartnerOS 集成") — the kernel boundary is built and dogfooded on the
  three internal product repos (OsbornPA, OsbornModel, OsbornAlpha) first.

### D4. Package stability tiers

| Package | Tier |
|---|---|
| `@osstack/protocol` (new) | public / stable — versioned protocol, BC-tested |
| `@osstack/core` | public / stable subset (state repos + schemas after R1.1) |
| `@osstack/loop` | public / stable ports (`LoopEngine`, spec/budget/policy types) |
| `@osstack/agents` | adapter contract stable; concrete adapters best-effort |
| `@osstack/contracts` (existing) | unchanged — API contract checker, unrelated to the kernel protocol |
| `@osstack/supervisor` | internal (private) until conformance complete |
| `@osstack/cli` | product-private; no stability promises on output text |

## Known boundary debts (tracked, not solved by this ADR)

- `loop -> @osstack/github` coupling (`discover.ts` branch-steward scan) —
  VCS-specific code inside the kernel layer; candidate for an injected
  discovery source after R1.
- Two `Task` shapes (loop file-queue Task vs core `TaskRow`) — `@osstack/protocol`
  v1 must state which is canonical for cross-process exchange (expected:
  a protocol Task that both map onto; neither struct is silently renamed).

## Consequences

- R0.4 protocol/policy specs and R0.5 consumption conformance test are written
  against this ADR.
- The conformance test imports only kernel packages; its expected-fail on
  "read runs/events without CLI" documents Gap D2 until R1.1 lands.
- Release trains keep `linked: [["@osstack/*"]]`; adding `@osstack/protocol`
  joins the linked version group.

# R0/R1 Technical Architecture Design

Status: Proposed (awaiting owner approval — gates Opus sub-agent dispatch)
Date: 2026-07-11
Author: Fable 5 (CTO)
Upstream: ADR-001, plan `2026-07-11-osstack-r0-r1.md`, Doc 15/16.
Baseline: `main @ 7f89e83` (R0.1–R0.3 merged).

## 0. Key audit fact shaping this design

The repo already contains a draft run protocol: `docs/specs/OSSTACK_RUN_SPEC_V1.md`
with 9 JSON Schemas (`task`, `event`, `policy-decision`, `proof-pack-manifest`,
`loop-state`, `verify-results`, `agent-runtime`, `knowledge-pack`,
`worktree-status`), test vectors, and a conformance matrix — but it exists only
as *documents*, consumed by 3 CLI tests. **`@osstack/protocol` therefore
packagizes and extends OSSTACK_RUN_SPEC_V1 — it does not invent a parallel
protocol.** (`@osstack/runtime` is an unrelated Zellij-launcher placeholder;
untouched.)

## 1. `@osstack/protocol` v1 (owner decision D1)

**Layout** — `packages/protocol`, deps: `zod` only (devDeps add
`zod-to-json-schema`). No workspace dependencies; it is the bottom layer.

```
packages/protocol/
  src/
    version.ts        PROTOCOL_VERSION = "1.0"
    task.ts           Task (canonical cross-process shape)
    run.ts            RunSummary
    event.ts          EventEnvelope
    evidence.ts       EvidenceRef
    approval.ts       ApprovalRequest / ApprovalDecision
    policy.ts         PolicyDecision
    envelope.ts       AgentCommand / AgentCommandResult
    index.ts
  fixtures/
    valid/*.json      one+ per type — FROZEN once released (BC corpus)
    invalid/*.json    one+ per type, each with a `$reason`
  schemas/            generated JSON Schema (build step, committed)
  src/*.test.ts       parse/BC/invalid-fixture tests
```

**Canonical shapes — extraction decisions (CTO):**

| Protocol type | Extracted from | Decision |
|---|---|---|
| `Task` | `loop/src/types.ts` Task ≈ `docs/specs/schemas/task.schema.json` | The loop file-queue/daemon-RPC Task IS the cross-process shape today; protocol adopts it (task_id, capability, prompt, source, priority, context?, evaluation?). core's `TaskRow` is a persistence projection, NOT protocol. |
| `EventEnvelope` | `hermes-adapter` event envelope | event_id, seq, run_id, session_id, created_at, terminal, type, payload (open). Payload unions stay out of v1 — only the envelope is shared today. |
| `RunSummary` | common denominator of executor `AgentRun` and cli `insertRun` | run_id, task_id, agent_id, outcome, started_at, completed_at?, duration_ms?, summary? |
| `EvidenceRef` | new (Doc 15 §5.4 response contract) | { kind: report\|scorecard\|proof\|loop_state\|external, ref, sha256?, run_id? } |
| `ApprovalRequest/Decision` | core `ApprovalRow` minimal subset | request: approval_id, run_id, action, risk, requested_at; decision: approval_id, approved, decided_by, decided_at, reason? |
| `PolicyDecision` | `core/policy/types.ts` (interface today) | becomes Zod in protocol; core re-exports later (R1.2) |
| `AgentCommand/Result` | Doc 15 §5.4 | command envelope: protocol_version, command, actor{type,id}, scope{portfolio_id?,repo_id?}, input, policy_profile?, idempotency_key; result: status, result, evidence_refs[], required_approvals[], next_actions[], error? |

**Versioning/BC contract:** `PROTOCOL_VERSION = "1.0"`. `fixtures/valid/` is
append-only per version; a BC test asserts every released valid fixture parses
with current schemas forever. Breaking change ⇒ new major + new fixture dir.
Zod is source of truth; `schemas/` generated at build and committed;
an inventory-style `--check` guards staleness.

**v1 explicitly excludes** (not genuinely shared yet): loop-state internals,
knowledge-pack, proof-pack manifest internals, worktree-status, evaluation-spec
details. They stay in RUN_SPEC docs until a second consumer exists.

**No consumer rewiring in the protocol PR.** core/loop re-exports happen in
R1.2, keeping each PR single-concern.

## 2. R0.4 spec docs (Fable-authored; protocol package implements them)

- `docs/specs/AGENT_COMMAND_PROTOCOL_V1.md` — the envelope/result contract,
  actor model, idempotency, error taxonomy; states that `@osstack/protocol` is
  the executable form and OSSTACK_RUN_SPEC_V1 remains the run-lifecycle spec
  (cross-referenced, no duplication).
- `docs/specs/POLICY_PROFILE_V1.md` — `.osstack/repo.yaml` + `.osstack/policy.yaml`
  (Doc 16 §7 shapes; modes observe|propose|execute; fail-closed unknown keys,
  same discipline as DiscoveryPolicy). JSON Schemas under `docs/specs/schemas/`.

## 3. R0.5 conformance package

`packages/conformance` — `private: true`, never published, test-only.
workspace deps: core, loop, agents (protocol added in its PR).

Tests (vitest):
1. `openDb` + migrations on a temp DB → `user_version` = CURRENT_SCHEMA_VERSION.
2. `enqueueTask` (loop file queue) → task file parses as protocol Task shape.
3. `LoopEngine.runOnce` with an in-memory fake adapter (no CLI, no network) →
   completed task, state file written.
4. **Gap D2 documentation test**: asserts that reading runs/events via public
   core/loop APIs is impossible today (`expect(coreExports).not.toContain(...)`)
   with a comment tying it to R1.1 — flips into a positive read test when R1.1
   lands.
5. Import-boundary test: the package compiles with ZERO imports from
   `@osstack/cli` (enforced by dependency absence + a grep test).

## 4. R1.1 state-repository relocation (owner decision D2)

**Scope facts:** `cli/src/store.ts` = 147 lines, 4 functions (`insertTask`,
`insertRun`, `appendEvent`, `finalizeRun`); 8 raw `SELECT … FROM runs|events|tasks`
sites across `daemon.ts` (4), `dashboard.ts` (2), `bin.ts` (2).

**Target API** — `packages/core/src/state/run-store.ts` (one module; the four
writers + read functions extracted verbatim from the raw-SQL sites):

```
insertTask / insertRun / appendEvent / finalizeRun    (moved as-is)
getRun(db, runId) / listRecentRuns(db, {limit})       (from bin/dashboard SQL)
listEventsForRun(db, runId) / countEvents(db)          (from daemon/dashboard SQL)
```

Constraints (ADR-001 D2, owner-set): ownership move only — identical SQL
semantics; no schema change; no new DB design. `cli/src/store.ts` becomes a
compat re-export shim (`export … from "@osstack/core"`) with a deprecation
comment + migration note. Raw-SQL sites switch to the core readers.

**Test matrix** (owner-required): existing `store.test.ts` moves to core;
round-trip (insert→finalize→read) tests; concurrency test (parallel
`withWrite` writers, busy-retry path); error paths (bad FK, double finalize);
CLI-compat test proving old import path still works. Full suite + conformance
green before merge; conformance test #4 flips to positive reads in this PR.

## 5. Execution: increments, Opus contracts, maker/checker

Order (owner's A→B→C): R0.4 → R0.5 → protocol v1 → R1.1. One branch/PR each.

| PR | Who implements | First review | Final review |
|---|---|---|---|
| R0.4 specs | **Fable 5** (protocol design = CTO work) | Opus-R (review-only contract) | owner-visible in PR |
| R0.5 conformance | **Opus-A** | **Opus-B** | **Fable 5** |
| protocol v1 | **Opus-B** | **Opus-A** | **Fable 5** |
| R1.1 relocation | **Opus-C** | **Opus-A or B** (not C) | **Fable 5** |

Maker/checker: no Opus reviews its own code. Fable 5 personally verifies per
increment: git diff, module boundaries, test honesty (no weakened assertions /
skips / sleeps), full-suite + CI, rollback = clean revert.

Each Opus dispatch carries the owner's contract template: goal, non-goals,
allowed/forbidden paths, acceptance criteria, verification commands, budget
(iteration/time cap), and the §3 escalation triggers verbatim.

## 6. Out of scope (unchanged)

No PartnerOS integration; no LoopEngine rewrite; no golden-path (`daily`/`start`)
implementation in these increments (that is R1.3–R1.6, planned separately);
`docs/specs/` RUN_SPEC docs are cross-referenced, not rewritten.

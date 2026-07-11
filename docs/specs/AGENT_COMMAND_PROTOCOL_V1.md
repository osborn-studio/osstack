# AGENT_COMMAND_PROTOCOL_V1

Status: Draft
Version: 1.0.0
Date: 2026-07-11
Owner: Fable 5 (CTO); decisions per `docs/decisions/ADR-001-shared-control-kernel.md`.
Executable form: `@osstack/protocol` (planned; this document is normative until
the package ships, then the package's Zod schemas + generated JSON Schemas are
the executable source of truth and this document explains intent).

The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as
described in RFC 2119.

Relationship to `OSSTACK_RUN_SPEC_V1.md`: that spec defines the run *lifecycle*
(discover → plan → execute → verify → iterate → persist) and its artifacts.
This spec defines the *command envelope* an agent surface (Claude Code, Codex,
Hermes, CI, PartnerOS) uses to invoke osstack application services and the
result contract it gets back. The two are complementary; types shared by both
(Task, event envelope) are defined once in `@osstack/protocol`.

## A-001 Command Envelope

Every command an agent surface sends to an osstack application service MUST
conform to `schemas/agent-command.schema.json`:

```json
{
  "protocol_version": "1.0",
  "command": "portfolio.daily",
  "actor": { "type": "human", "id": "osborn" },
  "scope": { "portfolio_id": "default", "repo_id": "osborn-pa" },
  "input": {},
  "policy_profile": "internal-default",
  "idempotency_key": "b3f9…"
}
```

- `protocol_version` MUST be present. A server MUST reject a major version it
  does not support with error code `unsupported_protocol_version`.
- `command` MUST be a dot-separated `<service>.<action>` identifier
  (e.g. `portfolio.daily`, `delivery.start`, `improve.propose`).
- `actor.type` MUST be `human` or `agent`; `actor.id` MUST be non-empty.
  Approvals and audit records MUST record the actor verbatim.
- `scope` narrows the command to a portfolio and/or repo. Commands that write
  MUST NOT default to a broader scope than given.
- `input` is command-specific and MUST be validated by the receiving service.
- `policy_profile` is optional; when present the service MUST resolve and
  enforce it (see `POLICY_PROFILE_V1.md`). Absence means the repo's own
  `.osstack/policy.yaml` (or the conservative default) applies.

## A-002 Idempotency

Any command that can write MUST accept `idempotency_key`. Two commands with
the same key MUST NOT produce duplicate tasks, approvals, runs, or assets; the
second invocation MUST return the first invocation's result (or its current
state). Read-only commands MAY omit the key.

## A-003 Command Result

Every response MUST conform to `schemas/agent-command-result.schema.json`:

```json
{
  "protocol_version": "1.0",
  "status": "ok",
  "result": {},
  "evidence_refs": [
    { "kind": "proof", "ref": "release/osstack-proof-run_abc/", "run_id": "run_abc" }
  ],
  "required_approvals": [],
  "next_actions": [
    { "command": "control.approve", "reason": "production deploy gate" }
  ],
  "error": null
}
```

- `status` MUST be one of `ok`, `needs_approval`, `blocked`, `error`.
- `result` carries the command-specific payload. Markdown in `result` is for
  human display only; integrations MUST consume structured fields, never parse
  prose (ADR-001 D3: CLI/markdown text is not an API).
- `evidence_refs[]` items MUST conform to the EvidenceRef shape:
  `kind` ∈ `report | scorecard | proof | loop_state | external`, `ref`
  (path or URL), optional `sha256`, optional `run_id`. Services MUST attach
  evidence for anything they claim was verified.
- `required_approvals[]` items are ApprovalRequest shapes (A-005). `status`
  MUST be `needs_approval` whenever this list is non-empty.
- `next_actions[]` are suggested follow-up commands with reasons; they MUST be
  advisory only.
- On `status: "error"`, `error` MUST be `{ code, message, retryable }` with
  `code` from the taxonomy in A-006.

## A-004 Actor and Authority

- A service MUST NOT escalate an `agent` actor's authority above the resolved
  policy profile (e.g. an agent actor cannot approve its own approval request).
- Approval decisions MUST come from a `human` actor unless the policy profile
  explicitly delegates a category (`allowed_auto_changes`).

## A-005 Approval Shapes

ApprovalRequest: `{ approval_id, run_id?, action, risk, requested_at }` with
`risk` ∈ `low | medium | high`. ApprovalDecision:
`{ approval_id, approved, decided_by, decided_at, reason? }`.
A service MUST NOT execute an action whose ApprovalRequest is unanswered, and
MUST record the decision with the same `approval_id`.

## A-006 Error Taxonomy

`code` MUST be one of:
`bad_request`, `unsupported_protocol_version`, `unknown_command`,
`policy_denied`, `needs_approval`, `not_found`, `conflict` (idempotency or
concurrent state), `budget_exceeded`, `internal`.
`retryable` MUST be `true` only for transient failures (`internal`,
`conflict`).

## A-007 Versioning and Compatibility

- Minor additions (new optional fields, new commands, new error codes) MUST
  NOT break existing consumers; consumers MUST ignore unknown fields.
- Removing/renaming a field or changing semantics REQUIRES a major version and
  a new fixture corpus. Released valid fixtures are frozen: every fixture
  published for a protocol version MUST parse against all later minors of that
  major (backward-compatibility test in `@osstack/protocol`).

## A-008 Transport Neutrality

The envelope is transport-neutral: the same shape MUST be usable over the
daemon Unix-socket RPC, a future HTTP surface, or direct in-process calls.
Transport concerns (framing, auth) are out of scope for this spec.

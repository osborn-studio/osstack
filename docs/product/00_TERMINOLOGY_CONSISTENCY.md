# Terminology Consistency

Status: Living product companion for `OSSTACK_RUN_SPEC_V1`.

## Canonical Terms

| Term | Meaning |
|---|---|
| run | One persisted execution record for a task or loop-triggered unit of work. |
| loop | The durable discover -> plan -> execute -> verify -> iterate runtime. |
| task | A queued or discovered work item conforming to `docs/specs/schemas/task.schema.json`. |
| agent | A local or remote execution adapter such as `codex-cli`, `claude-cli`, or `local-command`. |
| verifier | A deterministic command or reviewer/checker adapter that can pass, fail, or escalate work. |
| proof pack | A checksumed evidence bundle generated from state, events, reports, scorecards, and artifacts. |
| governance | Deterministic safety and quality checks. It is a verifier, not the routing policy engine. |
| Knowledge Cloud | Osstack-owned cloud-first knowledge service with local cache and fail-open behavior. |
| cockpit | Product control surface over daemon status, runs, kanban, reports, proof, lessons, and scorecards. |

## Rules

- Use `proof pack`, not certification package.
- Use `compliance mapping`, not external certification.
- Use `Knowledge Cloud`, not an upstream or third-party mirrored knowledge base.
- Use `agent routing`, not model switching, when policy chooses an execution adapter.


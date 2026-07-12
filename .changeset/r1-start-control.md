---
"@osstack/core": minor
"@osstack/cli": minor
---

R1.5 — contract-gated `osstack start` / `osstack control` lifecycle. v1 owns the
contract lifecycle + approval records only; it never spawns delivery.

- `@osstack/core`: new `contract_approvals` (authoritative current lifecycle
  state: pending/approved/revising/stopped) + `contract_approval_decisions`
  (append-only approve/revise/stop history) tables (migration #8), the
  repository (`insertContractApproval` / `getContractApprovalByContract` /
  `getContractApproval` / `recordContractDecision` / `listContractDecisions`)
  and protocol mappers (`contractApprovalRowToRequest` /
  `contractApprovalRowToDecision`). DEDICATED tables, not the run-coupled
  `approvals` table, because a contract has no run at approval time.
- `@osstack/cli`: new `start` and `control` commands.
  - `osstack start "<goal>" --repo-id <id> [--risk R] [--json]` requires the repo
    registered + a valid `.osstack/repo.yaml`; `mode: observe` is refused
    (policy_denied, exit 2), an invalid policy fails closed (exit 1). Records the
    contract atomically (kanban card + pending approval in one transaction),
    then writes the Execution Contract markdown to a git-tracked path in the
    target repo (`.osstack/contracts/<id>.md` — review the TBDs and commit it).
    `--json` emits a strict protocol `AgentCommandResult` with status
    `needs_approval`, an `ApprovalRequest`, and the exact `control approve`
    invocation as `next_actions[0]`.
  - `osstack control <contract-id> status|approve|revise|stop [--json]`.
    The approval row is authoritative; the kanban card is a best-effort
    projection (a failed card move degrades to a warning, never a crash).
    `approve` records a protocol `ApprovalDecision` (human actors only — an
    agent actor is refused as policy_denied per A-004) and emits the
    ready-to-run `osstack deliver …` command, POSIX-single-quoted so hostile
    goal text cannot execute on paste, plus a raw `deliver_args` argv array for
    agent consumers — it does NOT spawn delivery. `revise`/`stop` update status
    with a `--reason`; `status` renders the contract + the full append-only
    approval trail.

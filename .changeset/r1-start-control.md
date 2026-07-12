---
"@osstack/core": minor
"@osstack/cli": minor
---

R1.5 — contract-gated `osstack start` / `osstack control` lifecycle. v1 owns the
contract lifecycle + approval records only; it never spawns delivery.

- `@osstack/core`: new `contract_approvals` table (migration #8) + repository
  (`insertContractApproval` / `getContractApprovalByContract` /
  `getContractApproval` / `resolveContractApproval` / `reopenContractApproval`)
  and protocol mappers (`contractApprovalRowToRequest` /
  `contractApprovalRowToDecision`). A DEDICATED table, not the run-coupled
  `approvals` table, because a contract has no run at approval time.
- `@osstack/cli`: new `start` and `control` commands.
  - `osstack start "<goal>" --repo-id <id> [--risk R] [--json]` requires the repo
    registered + a valid `.osstack/repo.yaml`; `mode: observe` is refused
    (policy_denied, exit 2), an invalid policy fails closed (exit 1). Writes an
    Execution Contract to `.osstack/contracts/<id>.md` in the target repo, tracks
    it as a kanban card on the `contracts` board, records a pending approval, and
    (`--json`) emits a strict protocol `AgentCommandResult` with status
    `needs_approval`, an `ApprovalRequest`, and the exact `control approve`
    invocation as `next_actions[0]`.
  - `osstack control <contract-id> status|approve|revise|stop [--json]`.
    `approve` records a protocol `ApprovalDecision` (human actors only, A-004),
    flips the contract to approved, and emits the ready-to-run `osstack deliver …`
    command (verify + budget flags) — it does NOT spawn delivery. `revise`/`stop`
    update status with a `--reason`; `status` renders the contract + approval
    trail.

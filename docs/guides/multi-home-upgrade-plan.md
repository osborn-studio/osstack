# Multi-home upgrade planning and journal

U2a provides plans and a private phase journal. Production CLI integration exposes only plan/status. It does not register an apply operation, install packages, open home databases, start daemons or restart actual homes. Every ordinary plan remains `qualification_pending`; a home inventory is a snapshot, never proof that all consumers of a shared binary are known.

## Plan contract

`createUpgradePlan(request, inventory.homes, nowMs)` reuses `DeploymentIdentitySchema` from the real home inventory. The request contains:

```json
{
  "schema_version": 1,
  "expires_at_ms": 1792800000000,
  "target": {
    "version": "0.22.0",
    "build_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "protocol_version": 2,
    "database_schema": 45,
    "readable_schema_min": 44,
    "readable_schema_max": 45
  },
  "budget": { "max_total_ms": 300000, "max_step_ms": 60000, "max_steps": 32 },
  "groups": [{
    "group_id": "npm-primary",
    "installation_id": "registered-shared-installation",
    "deployment_kind": "npm",
    "home_ids": ["home_00000000000000000000000000000001", "home_00000000000000000000000000000002"]
  }]
}
```

Replace the example expiry, target evidence and home IDs with actual registered values. Tags and version ranges are rejected. A plan binds the exact target, inventory identity/generation/build/schema, sockets, group membership, group order, expiration and budgets into its digest. The target's schema readability range is a requested constraint; only a future qualified updater can attest compatibility. A caller-supplied range cannot grant installation permission.

Limits: 32 total homes; 32 groups; expiry within 24 hours; per-step limit at most 5 minutes; total limit at most 1 hour; at most 512 port calls. A group needs at least 5 × home count + 2 calls; insufficient budgets remain unqualified before any drain. `budget_scope: "per_group"` is explicit: the coordinator handles one group per attempt, not a cross-group global maintenance window. Groups must finish in their frozen array order; a later group remains pending until every predecessor is verified. Deadlines bound logical waiting and request cancellation; they do not prove physical stop. Stale, missing or incompatible observations remain recorded as unqualified reasons. Checkout deployments cannot use the npm path. A lower target database schema is unqualified even when a caller declares that schema readable; binary downgrade never authorizes database rollback.

## Persistence and status

The caller creates an explicitly selected, existing private directory (0700, same UID, canonical path). `new UpgradeJournal(root).create(frozenPlan)` saves an immutable digest-checked plan. `status(planDigest, groupId)` only reads the plan and the bounded hash-linked phase records. It returns `phase`, `completed`, and `resume_allowed: false`; reading does not retry, steal a lock or invoke an updater.

Records are published create-only after file sync, followed by directory sync. File ownership, permissions, type, hard links, byte bounds and paths are checked. After a crash between link publication and temporary unlink, reads accept exactly the matching second inode link in the same private directory; other hard links are rejected. Status does not remove that temporary. Claims are keyed by both installation ID and individual home IDs across plan digests and acquired create-only. If claim acquisition fails before a writer is returned, only this new attempt’s token-matching claims are removed; no native effect can yet have started. A cleanup that cannot be confirmed remains visible for reconciliation. No PID heuristic, elapsed timeout or maintenance window can steal a claim. A completed verified run releases its claim; an interrupted or failed run retains it for reconciliation. Even a dead process is not proof that an installation had no effect. Claim cleanup/reconciliation is deliberately not automated in this slice. An incomplete claim set is visible through claims_held/claims_expected/partial_claim and reports recovery_required even before the first phase record. Removing claim files manually cannot make a previously started journal replayable; the journal itself enforces that boundary. Status includes historical confirmed drain homes and the last started phase/home for recovery; those records are not proof that a home remains stopped now. A verified run whose claim cleanup failed stays factually verified and reports claim_cleanup_pending; cleanup failure does not erase the verification facts.

Journal reads reject noncanonical JSON bytes, including reordered or duplicate-key encodings. The journal hash chain detects corruption and binds local records. It is neither a signature nor cross-host authentication, and it does not protect against a malicious process with the same host account. Preserve the directory across disabling or upgrading this feature. File/directory fsync is used, but macOS power-loss cache durability and arbitrary local filesystem hangs are not qualified. Port time budgets do not bound filesystem calls. Temporary files are retained; no automatic GC is provided. Canonical roots are required (resolve aliases such as /tmp before construction).

## Qualified host boundary and future native adapter

`coordinateUpgrade({journal, plan, groupId, port?})` is available for injected host adapters and fake fault tests. With no port, it only persists the plan and returns `qualification_pending`. No production implementation of `NativeUpgradePort` is supplied.

A future host `resolveAuthority` must independently prove every consumer of the canonical installation, return the exact plan/group/installation/consumer binding, a current explicit authorization and qualification reference, expiration, and synchronous `assertCurrent`. Installation IDs must be canonical host registration identities: letting callers assign aliases for one installation would bypass shared-installation serialization. The registry manifest and its claimed completeness cannot satisfy this proof. These values come from the trusted host callback, never user JSON or model text.

The same port supplies `observe`, `drain`, `snapshot`, `install` and `restart`. Each drain must return exact home/generation evidence, confirmed stop, zero durable Graph holds, zero unknown actions and a synchronous live maintenance-fence check. Every shared consumer must stop before any snapshot or installation. Fences are rechecked before and after snapshots and installation. The future adapter must enforce these requirements at the actual native effect boundary; receipt shapes alone cannot establish them.

The existing `upgrade.ts` provides deployed-home resolution and single-deployment primitives, but its current command has a fixed launchd label, process-global environment and failure paths that restore old database files. Do not call that entire command as the new install port. U2b must separate and qualify suitable native primitives first. No snapshot in U2a authorizes restoring a database containing newer external facts: the plan fixes `rollback: "no_database_restore"`, and the port exposes no database rollback operation.

## Failure behavior

The sequence is preflight identity checks, all-consumer drain, quiescent, consistent snapshots, one installation, per-home restart, then exact healthy target identity verification. The preflight record binds the host authorization/qualification/completeness evidence digest and authorization reference. Each effect records `started` and synchronously rechecks all claim tokens immediately before calling the port and records evidence after confirmation. The verified daemon must have the pinned home ID, a new generation, target version/build/protocol/schema, and healthy status.

An install timeout, missing receipt, revoked fence, wrong identity or restart failure never triggers another install or automatic database rollback. Late receipts cannot advance the journal. Reopening a partial journal returns `recovery_required` without invoking any updater. Partial drains also require reconciliation because some homes may already be stopped. Ordinary preflight failures before side effects are marked `aborted_before_install`; their claims are retained conservatively. All fake evidence references in tests are explicitly fake.

Qualification status: plan/journal implementation and injected-port local fault tests are implemented; native installation, real shared-consumer completeness, launchd multi-instance management, cross-host authentication and real dual-home upgrades remain unqualified and disabled.

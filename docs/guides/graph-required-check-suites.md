# Graph contracts with several required checks

A local Graph delivery contract can require up to 16 independently registered
acceptance commands. Every `required_checks[].registry_ref` must resolve to
exactly one trusted host registry entry by its command digest. The requested
primary `acceptanceRef` runs first, followed by the other contract checks in
contract order. Selected entries must have distinct registry refs, zero as their
only passing exit code, and at most 16 KiB of command text in total. Missing,
ambiguous or unsupported registrations reject admission before execution.

The existing Graph `tests` node executes one bounded suite. Each command is a
separate process invocation; command strings are never concatenated. This suite
uses one canonical write admission, one ledger effect/logical attempt and one
120-second total execution deadline, still subject to the enclosing Graph
budget/cancellation. It does **not** represent each command as a separate Graph
action-start charge. Source identity, current authorization and policy are
rechecked before every invocation. Ordinary registered nonzero exits remain
verification failures; infrastructure/cancellation/unknown-stop outcomes cannot
publish completion. A stop that cannot be confirmed retains admission and blocks
replay. Source modifications by a check prevent the next check from running.

Contained execution runs the same ordered suite as separate container invocations
against the frozen image, with unique invocation IDs and verified removal receipts.
It never turns an ordinary native command result into a container proof. Native
host commands remain trusted same-UID code, not an operating-system sandbox.

Durable verification evidence contains `acceptanceSuite` plus `commandSuite` or
`containedSuite`. Every entry carries the actual exit and stop evidence, in order.
A stopped prefix is retained only as a failed infrastructure observation. The complete local suite file is capped at 256 KiB; each entry retains the
existing bounded-JSON validation. Worker IPC and single-check evidence keep
their 64 KiB limits. Output
previews are bounded; discarded captured output is described by byte count and
SHA-256 metadata, not claimed to remain retrievable. As with existing evidence,
upstream process capture itself has an output limit.

The completion receipt preserves the original primary `check` field and adds
`checks` for multi-check contracts. Each entry binds its required-check ID,
registered command digest, zero exit, suite index and the same canonical tests
effect/evidence reference. The host reads this evidence again before completion;
worker output or a caller-supplied passing JSON object cannot satisfy the gate.
Single-check contracts keep their existing receipt shape. Completion remains
`local_verified` / `artifact_only`, with no publication or merge authority.

Qualification covers real local Graph workers, actual shell processes, SQLite
ledger transitions, durable evidence reload, later-check failure, incomplete and
substituted evidence, and HTTP container-engine fixtures including unknown removal.
A deployed Docker daemon and real provider credentials are separate environment
qualification requirements; fixture results do not establish either.

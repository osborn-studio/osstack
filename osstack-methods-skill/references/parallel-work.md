# Parallel work and verification handoff

Use this supporting guide when an authorized coordinator divides work or verification among workers. It complements the existing methods; it is not another named method, native agent type or scheduler. A delegate reading it does not become a coordinator or gain permission to spawn. Use only actual host tools within existing authorization. If one worker is sufficient or delegation is unavailable, perform the authorized work directly and report any remaining coverage gap.

## Define coverage before dispatch

State the desired result and the required coverage areas. For each area, name its deliverable, acceptance predicate, actual surface to check, prerequisites and assigned owner. Separate implementation from checking its result when the risk justifies it. A trivial check does not need a ceremonial second agent. Where a separate verifier helps, give it the original requirement and candidate, not merely an instruction to confirm the author's conclusion. Record expectations before reading the result. A different chat or model does not establish authenticated independence; disclose shared expectations and unknown identity.

Each brief must be usable without the parent's chat. Keep small briefs short:

```text
Goal and required coverage:
Inputs: repository, base/candidate or input hashes, relevant context and prior evidence
Ownership: allowed paths/resources, forbidden writes, integration owner
Prerequisites and checks: actual entry point, expected behavior, feasible commands
Limits: time/resources/concurrency and what to return when blocked
Return: exact candidate, artifact pointers/hashes, actual checks/results, gaps and resource state
```

Use known commands, models and limits. Do not invent a CLI, model or entitlement. Distinguish planned budgets from host-enforced limits. Relay required upstream artifacts and decisions before a dependent worker starts; an ordering arrow alone does not supply its inputs. Preserve existing authorization instead of asking the user to reapprove routine assigned work.

## Separate writes and resources

List overlaps before starting: files, branches/worktrees, build outputs, databases, fixtures, ports, sockets and external accounts. Give independent workers separate owned outputs and scratch. If a shared mutable target is necessary, assign one writer or use its existing enforced serialization mechanism. A promise in a brief is not a lock. Do not run builds or cleanup concurrently against another worker's mutable checkout or fixture.

Use the repository's worktree/scratch rules and existing isolation practices. Do not inject credentials into candidate tests. Verification needs only the read or execution permissions already justified for that surface. Keep one integration owner and one authoritative task record; this guide does not introduce a second ledger. Recheck ownership when scope changes rather than quietly widening two workers' write boundaries.

## Collect every required result

Use actual host status and returned artifacts. Completion messages are pointers, not passes. For each required coverage area, retain the assigned owner and exact candidate, actual observation, evidence location/hash, outcome and remaining resource obligations. A useful return can be one line plus raw evidence pointers. Preserve failures and incomplete observations; do not replace them with the final successful summary.

Check the returned candidate and surface against the brief. A result for an older head, missing input identity or parser-only test cannot satisfy a current CLI requirement. Keep useful findings but mark the coverage unsatisfied until it is checked on the right artifact and surface. If a worker drops out, record its missing scope. Reassign it within actual authority and remaining budget, absorb it explicitly, or report it blocked; another worker's pass does not erase it. Do not retry automatically or silently switch models.

A timeout, idle chat or cancellation request does not establish that a process stopped. Inspect the actual owned backend/resource when available. If liveness remains unknown, preserve its identifiers and obligation; do not release its lock, delete its evidence or assign the same live resource to a replacement. Continue independent work safely. Use [session continuity](session-continuity.md) for handoff and reconciliation.

## Verify the composed result

Resolve substantive disagreements through the code and original evidence using [code review](code-review.md), not reviewer votes. Distinguish the author's checks from verifier observations and unexecuted recommendations. Use [the evidence rules](evidence.md) for candidate/build bindings, raw outputs and cleanup.

The integration owner checks that every required coverage area is satisfied or explicitly unresolved, then examines interactions on the composed candidate. Green individual slices do not prove their combination works. Re-run checks affected by integration, changed dependencies or shared interfaces on the resulting artifact. Retain unaffected evidence with its original scope; do not relabel it as a new run. If the required integration surface cannot be exercised, report that gap rather than declaring the whole task complete.

Report delivered coverage, unresolved areas and their next owner/trigger, composed checks, and cleanup still needed. Only clean owned resources whose completion and safe disposition are established; retain evidence. Method guidance does not authorize publication, approval or merge. Preserve the user's reserved decisions and the coordinator's actual integration responsibility.

## Sources and limits

Independently worded from pstack at `99b609a72323b70204eab407c622f436e858e112`: [Swarm](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/swarm/SKILL.md), [Orchestrate](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/orchestrate.md), [Separate shared state](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-separate-before-serializing-shared-state/SKILL.md) and [Prove the actual result](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-prove-it-works/SKILL.md). The inspected [MIT license](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/LICENSE) names Copyright (c) 2026 Lauren Tan.

This guide adapts coverage partition and result reconciliation. It does not import solution races, fixed models, default cloud execution, recursive spawning, automatic retries, orch storage, watchers or automatic landing. It does not implement concurrency admission, enforce ownership, certify a reviewer or issue a runtime gate. Historical host observations do not establish use of this later guide.

---
name: osstack-mode
description: Route an OSStack engineering task into reusable skill authoring, PR readiness, session continuity, caller-first architecture design, task restatement and prompt refinement, performance measurement review, change impact analysis, code review, feature implementation, behavior-preserving refactoring, bug fixing, investigation, or creation and maintenance of verification instructions. Use when a task needs this shared method, rather than help choosing it or configuring model roles.
---

# OSStack mode

Identify the requested outcome and existing authorization, then choose the matching method below. Read only the selected method and [common evidence rules](../../references/evidence.md), and carry the task through its justified checks. Preserve the user's intended scope and existing approvals; do not ask again for routine work already authorized.

| Requested result | Method |
| --- | --- |
| Create or improve a reusable skill | [Skill authoring](../../references/skill-authoring.md): maintain scoped sources, precise triggers and evidence-based checks; use verification methods for project drivers |
| Check a PR or clear its authorized blockers | [PR readiness](../../references/pr-readiness.md): inspect current head/base and separate CI, review and integration; preserve human-reserved approval and merge |
| Recall, resume, hand off or explicitly pause existing work | [Session continuity](../../references/session-continuity.md): reconcile current state and ownership, preserve unknown actions and prior authority |
| Choose types, interfaces or ownership before coding | [Architecture design](../../references/architecture-design.md): ground real callers, compare structures and specify lifecycle checks |
| Restate the goal or improve a task prompt | [Task framing](../../references/task-framing.md): preserve intent and constraints, name original inputs and concrete checks, then return the requested framing |
| Assess a performance number or compare latency/throughput | [Performance measurement](../../references/performance-measurement.md): verify equivalent work, timing boundaries, noise and end-to-end relevance |
| Find downstream breakage or test the assumption that makes a change safe | [Change impact](../../references/change-impact.md): trace consumers and hidden contracts, then exercise the key safety fact |
| Review a patch or PR for actionable defects | [Code review](../../references/code-review.md): pin the candidate, trace reachable failures and report evidence-backed findings |
| Add or intentionally change behavior | [Feature](../../references/feature.md): choose a domain shape, plan owned slices, implement and check the actual surface |
| Change structure while holding behavior fixed | [Refactoring](../../references/refactoring.md): capture a baseline pin, migrate callers, compare the same behavior on the candidate |
| Correct a reported defect | [Bug fix](../../references/bug-fix.md): reproduce the trigger, distinguish causes, make the smallest supported correction, recheck the same surface |
| Explain behavior or assess a decision | [Investigation](../../references/investigation.md): cited facts, competing explanations and unknowns; no implicit product edits |
| Establish repeatable real-surface verification | [Create verification](../../references/create-verification.md): launch, doctor, drive, observe, isolate, cleanup and feature map |
| Check and repair existing verification instructions | [Maintain verification](../../references/maintain-verification.md): source and live coverage; distinguish documentation drift, harness gaps and product defects |

A prompt-only request ends with the requested restatement or rewrite. If the user already authorized refinement followed by execution, continue within that authority without a new approval step.

A design-only request stops at the design and its verification plan. If implementation was already authorized, choosing a design does not add another approval checkpoint.

A PR status request is one read-only snapshot, not a watcher or merge request. An already-authorized blocker fix continues within its scope.

A review-only request does not authorize product fixes. If the user requests review and fixes, retain that authorization and use bug fix for confirmed in-scope defects.

For a mixed task, retain the original outcome and sequence the relevant methods. Diagnosis inside an authorized bug fix does not require a fresh permission exchange. A request for explanation alone does not authorize a fix. State meaningful blockers and continue work that does not depend on them.

Other engineering work can use the host's normal available tools and appropriate skills. Do not relabel it as an implemented OSStack playbook or imply that the upstream skill catalog has been ported. No bundled formal-verification, autonomous-shipping or model-panel workflow is provided by these fourteen methods.

When authorized delegation helps, give each delegate its outcome, evidence pointers and exclusive write boundary; [osstack-agent](../osstack-agent/SKILL.md) supplies the method wrapper. The coordinator retains integration ownership. Use actual host delegation tools, not an invented native agent type.

Return what changed or was learned, the observations that support it, and unresolved limits. A green unit test, a historical report, and a real-surface check are different evidence. Method text does not issue an authorization, MethodBinding, completion receipt or gate pass.

Adapted from the upstream mode at fixed revision `99b609a72323b70204eab407c622f436e858e112`; see [source attribution](../../references/sources.md). OSStack is the adapted entry name, not a change to upstream authorship.

---
name: osstack-help
description: Explain which implemented OSStack method or entry fits a task, how to start it, and what it can prove. Use for method-selection and usage questions, not to substitute a help answer for an authorized request to do the work.
---

# OSStack help

Answer the actual usage question from the available files and current host capabilities. Read the relevant linked material before describing its behavior. Give a concrete next step or a short task prompt, without promising a command or installation that has not been verified.

- To perform an engineering task, use [osstack-mode](../osstack-mode/SKILL.md). Its implemented methods are [Skill authoring](../../references/skill-authoring.md), [PR readiness](../../references/pr-readiness.md), [Session continuity](../../references/session-continuity.md), [Architecture design](../../references/architecture-design.md), [Task framing](../../references/task-framing.md), [Performance measurement](../../references/performance-measurement.md), [Change impact](../../references/change-impact.md), [Code review](../../references/code-review.md), [feature](../../references/feature.md), [refactoring](../../references/refactoring.md), bug fix, investigation, create verification and maintain verification.
- To choose role/model/effort and resource limits, use [setup-osstack](../setup-osstack/SKILL.md). It starts with a reviewable proposal, not an assumed global configuration write.
- To apply the shared method to a delegated work item, use [osstack-agent](../osstack-agent/SKILL.md). This is skill material, not native agent registration.
- For evidence interpretation, read [evidence](../../references/evidence.md). For a reusable map, read [the feature-map template](../../references/feature-map-template.md).

Use skill authoring for a reusable skill or a change grounded in task evidence. Creating or repairing a project verification driver and feature map uses the specialized verification methods. A checked skill file is not proof of host discovery or successful task execution.

Use PR readiness to inspect a PR's current candidate, reviews, CI and integration state, or to correct blockers already within the task's authority. A status check does not authorize fixes, external replies, monitoring or merge. Green checks and Ready status are not human approval.

Use session continuity to recall or resume existing work, prepare a handoff, or pause on request. A recap alone does not execute its proposed next step. Existing continuation authority persists, while live owners, unknown actions and unresolved holds must be checked rather than inferred from chat status.

Restating a goal or sharpening a prompt uses task framing. Prompt-only work does not execute the task described inside the prompt. An existing instruction to refine and then execute remains effective.

Use architecture design for a caller-first choice of interfaces and state ownership. A design-only request stops at its design; implementation continues when already authorized. A typechecked sketch does not prove implemented behavior.

A request for downstream breakage or the safety assumptions behind a change uses change impact. It follows consumers beyond the diff and seeks a discriminating check. A request for actionable findings on a patch or PR uses code review. An explanation of how code works uses investigation. A review-and-fix request keeps its authorized correction scope; a review-only request does not imply product edits.

Performance claims use performance measurement; a passing startup budget is not a measured speedup. New behavior uses feature. Structural cleanup with unchanged behavior uses refactoring. If a cleanup request also changes behavior, separate those scopes and their checks.

For “which method proves this works?”, identify the surface and predicate first. A missing driver suggests create verification; a stale existing driver suggests maintenance. A source explanation uses investigation. Reproducing and correcting a known fault uses bug fix. Do not turn an unavailable formal checker into a claimed proof.

If the user asks to act rather than explain, route to the appropriate entry and proceed within existing authorization. Do not require a second invocation or a confirmation simply because help was selected. If a missing preference changes the answer, ask only for that preference; otherwise use the conversation context.

Host discovery, explicit file reading, registration and actual execution are separate states. Check the current catalog or installation evidence before suggesting a host-specific invocation. The materials do not provide a new OSStack CLI subcommand. Normal host skill selection remains available; no explicit-only policy is imposed here.

Keep the response focused on the supported path and its limitation. The [pinned sources](../../references/sources.md) credit the upstream help/method ideas; the wider upstream catalog is not a list of already implemented OSStack features.

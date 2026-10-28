---
name: osstack-help
description: Explain which implemented OSStack method or entry fits a task, how to start it, and what it can prove. Use for method-selection and usage questions, not to substitute a help answer for an authorized request to do the work.
---

# OSStack help

Answer the actual usage question from the available files and current host capabilities. Read the relevant linked material before describing its behavior. Give a concrete next step or a short task prompt, without promising a command or installation that has not been verified.

- To perform an engineering task, use [osstack-mode](../osstack-mode/SKILL.md). Its implemented methods are [Code review](../../references/code-review.md), [feature](../../references/feature.md), [refactoring](../../references/refactoring.md), bug fix, investigation, create verification and maintain verification.
- To choose role/model/effort and resource limits, use [setup-osstack](../setup-osstack/SKILL.md). It starts with a reviewable proposal, not an assumed global configuration write.
- To apply the shared method to a delegated work item, use [osstack-agent](../osstack-agent/SKILL.md). This is skill material, not native agent registration.
- For evidence interpretation, read [evidence](../../references/evidence.md). For a reusable map, read [the feature-map template](../../references/feature-map-template.md).

A request for actionable findings on a patch or PR uses code review. An explanation of how code works uses investigation. A review-and-fix request keeps its authorized correction scope; a review-only request does not imply product edits.

New behavior uses feature. Structural cleanup with unchanged behavior uses refactoring. If a cleanup request also changes behavior, separate those scopes and their checks.

For “which method proves this works?”, identify the surface and predicate first. A missing driver suggests create verification; a stale existing driver suggests maintenance. A source explanation uses investigation. Reproducing and correcting a known fault uses bug fix. Do not turn an unavailable formal checker into a claimed proof.

If the user asks to act rather than explain, route to the appropriate entry and proceed within existing authorization. Do not require a second invocation or a confirmation simply because help was selected. If a missing preference changes the answer, ask only for that preference; otherwise use the conversation context.

Host discovery, explicit file reading, registration and actual execution are separate states. Check the current catalog or installation evidence before suggesting a host-specific invocation. The materials do not provide a new OSStack CLI subcommand. Normal host skill selection remains available; no explicit-only policy is imposed here.

Keep the response focused on the supported path and its limitation. The [pinned sources](../../references/sources.md) credit the upstream help/method ideas; the wider upstream catalog is not a list of already implemented OSStack features.

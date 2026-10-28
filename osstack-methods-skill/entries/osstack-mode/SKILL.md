---
name: osstack-mode
description: Route an OSStack engineering task into evidence-led bug fixing, investigation, or creation and maintenance of verification instructions. Use when a task needs this shared method, rather than help choosing it or configuring model roles.
---

# OSStack mode

Identify the requested outcome and existing authorization, then choose the matching method below. Read only the selected method and [common evidence rules](../../references/evidence.md), and carry the task through its justified checks. Preserve the user's intended scope and existing approvals; do not ask again for routine work already authorized.

| Requested result | Method |
| --- | --- |
| Correct a reported defect | [Bug fix](../../references/bug-fix.md): reproduce the trigger, distinguish causes, make the smallest supported correction, recheck the same surface |
| Explain behavior or assess a decision | [Investigation](../../references/investigation.md): cited facts, competing explanations and unknowns; no implicit product edits |
| Establish repeatable real-surface verification | [Create verification](../../references/create-verification.md): launch, doctor, drive, observe, isolate, cleanup and feature map |
| Check and repair existing verification instructions | [Maintain verification](../../references/maintain-verification.md): source and live coverage; distinguish documentation drift, harness gaps and product defects |

For a mixed task, retain the original outcome and sequence the relevant methods. Diagnosis inside an authorized bug fix does not require a fresh permission exchange. A request for explanation alone does not authorize a fix. State meaningful blockers and continue work that does not depend on them.

Other engineering work can use the host's normal available tools and appropriate skills. Do not relabel it as an implemented OSStack playbook or imply that the upstream skill catalog has been ported. No bundled formal-verification, autonomous-shipping or model-panel workflow is provided by these four methods.

When authorized delegation helps, give each delegate its outcome, evidence pointers and exclusive write boundary; [osstack-agent](../osstack-agent/SKILL.md) supplies the method wrapper. The coordinator retains integration ownership. Use actual host delegation tools, not an invented native agent type.

Return what changed or was learned, the observations that support it, and unresolved limits. A green unit test, a historical report, and a real-surface check are different evidence. Method text does not issue an authorization, MethodBinding, completion receipt or gate pass.

Adapted from the upstream mode at fixed revision `99b609a72323b70204eab407c622f436e858e112`; see [source attribution](../../references/sources.md). OSStack is the adapted entry name, not a change to upstream authorship.

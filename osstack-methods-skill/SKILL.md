---
name: osstack-methods
description: Use for creating and maintaining reusable agent skills (SKILL.md), PR readiness checks and authorized blocker fixes, session recall, authorized continuation and safe handoff or pause, caller-first architecture design, task restatement and prompt refinement, performance measurement review, change impact analysis, code review, feature implementation, behavior-preserving refactoring, evidence-led bug fixes, read-only investigations, and creating or maintaining project verification instructions. Intended for Codex and Claude through explicit file reading of one shared method set.
---

# OSStack engineering methods

Read the requested entry below and [the common evidence rules](references/evidence.md). These are engineering instructions for an explicitly requested task, not an OSStack runtime integration, permission grant, or qualification receipt. Existing user scope and repository rules control actions.

| User intent | Read | Deliver |
| --- | --- | --- |
| Create or improve a reusable skill | [Skill authoring](references/skill-authoring.md) | Scoped source changes, discriminating triggers, reference checks and observed-use limits |
| Check a PR or clear its authorized blockers | [PR readiness](references/pr-readiness.md) | Current candidate, separate checks/review/integration facts, justified fixes and remaining human decisions |
| Recall, resume, hand off or explicitly pause existing work | [Session continuity](references/session-continuity.md) | Current owner/state, inherited evidence, unresolved obligations and a resume point with its prerequisite |
| Choose interfaces, domain shapes and state ownership before implementation | [Architecture design](references/architecture-design.md) | Caller examples, compared structures, lifecycle contracts and falsifiable checks |
| Restate a goal or sharpen a prompt without expanding it | [Task framing](references/task-framing.md) | Preserved intent, constraints, open choices and a concrete evidence-based task |
| Assess a latency, throughput or regression claim | [Performance measurement](references/performance-measurement.md) | Comparable completed work, raw samples, uncertainty and user-visible significance |
| Find what a change can break beyond its diff | [Change impact](references/change-impact.md) | Affected consumers, challenged safety assumptions and concrete verification limits |
| Review code or a PR for actionable defects | [Code review](references/code-review.md) | Scoped findings, reachable triggers, evidence and unresolved limits |
| Add or deliberately change observable behavior | [feature](references/feature.md) | Scoped implementation, design choice and actual surface checks |
| Improve structure while preserving behavior | [refactoring](references/refactoring.md) | Pinned contract, migrated callers and baseline/candidate comparison |
| Fix a reproducible defect | [bug-fix](references/bug-fix.md) | Small justified change, original failing observation and candidate recheck |
| Explain behavior or assess alternatives | [investigation](references/investigation.md) | Cited findings, competing explanations and remaining unknowns |
| Establish a repeatable way to verify this project | [create-verification](references/create-verification.md) | Project verification instructions, feature map, one actual end-to-end proof or explicit draft |
| Check whether existing verification still works | [maintain-verification](references/maintain-verification.md) | Coverage record and clean/changed/blocked outcome, with retained failures |

Start from the actual checkout, existing commands and original evidence. Read relevant code before choosing a driver. Separate a source-based prediction from an executed observation. Work within the authorized task; do not add publication, scheduling, credentials or product changes because a method suggests them.

For a first runnable OSStack example, read [engineering decision verification](references/engineering-decision.md). It drives `scripts/smoke-engineering-decision.mjs` against an isolated deterministic fixture, compiled CLI and independent daemon. It does not qualify a live provider.

Supporting references:

- [Feature map template](references/feature-map-template.md)
- [Evidence and result record](references/evidence.md)
- [Explicit Codex/Claude use](references/host-usage.md)
- [Pinned sources and adaptation](references/sources.md)

This directory installs nothing, edits no host configuration and introduces no new CLI command, scheduler, MethodBinding or gate. A host can read it directly; availability in a skill picker and actual host execution remain separate facts.

## Named entries

The adapted OSStack entry materials are [osstack-mode](entries/osstack-mode/SKILL.md), [osstack-help](entries/osstack-help/SKILL.md), [setup-osstack](entries/setup-osstack/SKILL.md), and [osstack-agent](entries/osstack-agent/SKILL.md). They share these fourteen methods; the larger upstream catalog remains source material, not an implemented capability list. [Export instructions](EXPORT.md) create a separate project layout for Codex or Claude without modifying an existing installation.

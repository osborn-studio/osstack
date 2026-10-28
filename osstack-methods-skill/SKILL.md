---
name: osstack-methods
description: Use for evidence-led bug fixes, read-only investigations, and creating or maintaining project verification instructions. Shares one method set across Codex and Claude through explicit file reading.
---

# OSStack engineering methods

Read the requested entry below and [the common evidence rules](references/evidence.md). These are engineering instructions for an explicitly requested task, not an OSStack runtime integration, permission grant, or qualification receipt. Existing user scope and repository rules control actions.

| User intent | Read | Deliver |
| --- | --- | --- |
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

# Explicit Codex and Claude use

Both hosts can be asked to read the same repository files. This package contains no host installer or automatic discovery registration. Do not assume a slash command or skill picker entry exists.

Use this request in either host, substituting the actual absolute checkout path and task:

> Read `<checkout>/osstack-methods-skill/SKILL.md`, its common evidence rules, and the entry for `create-verification`. Apply them to `<requested task>` within the existing authorization. Report the material paths used, actual commands and observations, and any blocked or unverified steps. Do not treat the materials as permission to publish or as a gate receipt.

For bug fixes, investigation or maintenance, change the entry name. Keep the complete directory so relative reference links resolve. If a host cannot access the checkout, explicitly supply the same files; record any omitted content instead of calling a partial copy equivalent. No model or provider selection is prescribed.

Manual assembly means choosing the task entry and supplying the shared files. This document does not instruct edits to `AGENTS.md`, `CLAUDE.md`, global home directories or host configuration. If a later task requests installation, verify that host/version's actual installation mechanism separately and avoid overwriting existing content.

| Consumption cell | Current claim |
| --- | --- |
| Codex explicit file reading | One recorded read-only report from an `inputs/` copy of PR288 materials: investigation entry |
| Claude explicit file reading | One recorded read-only report from an `inputs/` copy of PR288 materials: investigation plus bug-fix entries |
| Automatic discovery / installation | Not provided or tested |
| MethodBinding / mandatory adapter injection | Not wired by this package |
| Live provider equivalence / formal qualification | Not established |

A recorded host run can establish that particular host/version read particular material bytes and produced a report for a task. It does not establish behavioral equivalence across providers, authenticated oracle independence, or automatic qualification of future tasks. Preserve raw output and limitations for each cell separately.

[The two host experiments](https://github.com/osborn-studio/osstack/blob/bf381f22b4833d781e9ec3d803d402f309e470a4/docs/implementation/joint-host-effects/README.md) preserve the actual material versions, commands, outputs and limits. Both read the pre-change evidence guidance at `10629495aafe7b3aca0de4c920bcaec40b083d7b`; neither tested this checkout request template or the new evidence-reading guidance. The records show material reading and reports about supplied historical outcomes, not product driving, cross-host equivalence or a causal improvement from the materials. Follow [the evidence reading rules](evidence.md): use targeted reads before large raw dumps, and distinguish unavailable evidence from supplied evidence that was not read or verified.

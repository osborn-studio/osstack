# Using OSStack methods in Codex and Claude

Choose the material path that actually exists in your context. Source checkout, exported project and installed host catalog are different locations; export alone does not establish native discovery.

## Exported project

Keep all four entry directories together. In a Codex bundle the mode entry is `.agents/skills/osstack-mode/SKILL.md`; in a Claude bundle it is `.claude/skills/osstack-mode/SKILL.md`. Replace the example below with the absolute path of the exported entry that you can read:

> Read `<actual-skill-directory>/SKILL.md` and its selected method and evidence references. Apply them to `<requested task>` within the existing authorization. Report the material paths used, actual observations and unresolved limits.

References in a bundle live under each entry's `references/`. `session-continuity`, `feature`, `refactoring`, `create-verification`, `maintain-verification`, `bug-fix`, and `investigation` are reference methods selected by `osstack-mode`, not additional exported entry names. Use `osstack-help` for routing questions, `setup-osstack` for scoped model and budget preferences, or `osstack-agent` for an already delegated task.

If the host catalog actually lists these skills, use its supported selection mechanism. Otherwise explicit file reading remains possible. Do not claim a slash command exists merely because a folder was generated. Host trust, version and settings can affect discovery; no global installation or configuration edit is needed for explicit reading.

## Original source checkout

The source router is `osstack-methods-skill/SKILL.md`. Its four named entries are under `osstack-methods-skill/entries/`; its shared methods are under `osstack-methods-skill/references/`. The original source layout and the exported layout intentionally differ. When sharing files explicitly, state which files were supplied and which were omitted.

## Execution and historical evidence

Exported materials contain instructions, not the OSStack product or its verification scripts. To execute an OSStack example, obtain an actual target checkout, its revision and built artifacts, and inspect the supported command there. A missing checkout or unavailable driver is a limitation to report, not permission to invent observations. A referenced script path is relative to that target repository, not to the exported skill directory.

A host run establishes only the material bytes, task, host/version and observed actions in that run. It does not establish cross-provider equivalence, independent identity, automatic recovery or future task qualification.

[The historical two-host experiments](https://github.com/osborn-studio/osstack/blob/bf381f22b4833d781e9ec3d803d402f309e470a4/docs/implementation/joint-host-effects/README.md) preserve their commands and raw outputs. Both read pre-change material at `10629495aafe7b3aca0de4c920bcaec40b083d7b`; neither tested the template above or native discovery. Those results show explicit reading and reports about historical observations, not product driving or a measured causal improvement. Follow [the evidence rules](evidence.md) and retain that distinction in new runs.

Session continuity is shared guidance for recall, continuation, handoff and requested pause. It does not install history connectors, a background supervisor or a process fence. Historical host experiments above do not validate this later method; actual state/owner observations and unconfirmed cleanup must be recorded in each new task.

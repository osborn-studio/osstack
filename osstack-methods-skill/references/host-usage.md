# Using OSStack methods in Codex and Claude

Choose the material path that actually exists in your context. Source checkout, exported project and installed host catalog are different locations; export alone does not establish native discovery.

## Exported project

Keep all four entry directories together. In a Codex bundle the mode entry is `.agents/skills/osstack-mode/SKILL.md`; in a Claude bundle it is `.claude/skills/osstack-mode/SKILL.md`. Replace the example below with the absolute path of the exported entry that you can read:

> Read `<actual-skill-directory>/SKILL.md` and its selected method and evidence references. Apply them to `<requested task>` within the existing authorization. Report the material paths used, actual observations and unresolved limits.

References in a bundle live under each entry's `references/`. `session-continuity`, `feature`, `refactoring`, `create-verification`, `maintain-verification`, `bug-fix`, and `investigation` are reference methods selected by `osstack-mode`, not additional exported entry names. Use `osstack-help` for routing questions, `setup-osstack` for scoped model and budget preferences, or `osstack-agent` for an already delegated task.

If the host catalog actually lists these skills, use its supported selection mechanism. Otherwise explicit file reading remains possible. Do not claim a slash command exists merely because a folder was generated. Host trust, version and settings can affect discovery; no global installation or configuration edit is needed for explicit reading.

## Original source checkout

The source router is `osstack-methods-skill/SKILL.md`. Its four named entries are under `osstack-methods-skill/entries/`; its shared methods are under `osstack-methods-skill/references/`. The original source layout and the exported layout intentionally differ. When sharing files explicitly, state which files were supplied and which were omitted.

## Read the necessary material completely

Read the selected entry, method and evidence references one file at a time. A fixed page size is not a completion condition: a 60-line page can omit the end of a 64-line file. If the host tool delivered the complete file, use that result; no extra helper is required. If it returned a preview, truncation notice or persisted-output pointer, continue reading the authorized file in bounded ranges. Record missing ranges if the remaining content is unavailable.

For a checkout that contains `scripts/read-method-material.mjs`, the optional read-only helper returns bounded JSON pages. It is a script in the actual OSStack checkout, not a file included in exported skills. It requires Node and does not install or register anything. Replace the example paths with the real checkout and exported file paths, and use only a command permitted by the task:

```sh
node /absolute/osstack-checkout/scripts/read-method-material.mjs --file /absolute/project/.claude/skills/osstack-mode/references/evidence.md --start 1 --lines 60
```

For Codex, use the corresponding `.agents/skills/osstack-mode/references/evidence.md` path. Read the returned `text` and keep the whole-file `sha256`. If `eof` is false, copy `next_start` into `NEXT_START` and that first hash into `FIRST_PAGE_SHA256` in the next command. These uppercase tokens are placeholders; replace them before execution. Use the same file and first hash for every later page:

```sh
node /absolute/osstack-checkout/scripts/read-method-material.mjs --file /absolute/project/.claude/skills/osstack-mode/references/evidence.md --start NEXT_START --lines 60 --sha256 FIRST_PAGE_SHA256
```

Continue through every page until `eof` is true. A hash mismatch means the file changed: retain the partial record and start a new reading sequence for the new version within the task's authorization. Do not join pages from different versions. If a page exceeds the text bound, request fewer lines; report an unsupported single long line rather than claim it was read. The helper accepts regular UTF-8 files up to 1 MiB, at most 200 lines per page and at most 16 KiB of page text. It does not bypass host permissions.

`eof` describes the returned page, not whether earlier pages reached the model. Inspect the host's delivered tool results as well: complete raw output in an archive can coexist with a truncated model-visible preview. Preserve that distinction in the report. Neither a hash nor a complete page sequence proves understanding, native skill discovery or runtime qualification.

## Execution and historical evidence

Exported materials contain instructions, not the OSStack product or its verification scripts. To execute an OSStack example, obtain an actual target checkout, its revision and built artifacts, and inspect the supported command there. A missing checkout or unavailable driver is a limitation to report, not permission to invent observations. A referenced script path is relative to that target repository, not to the exported skill directory.

When a task supplies a narrow execution entry, submit each supported command as one literal tool call. Do not add loops, `echo`, shell separators, pipes or redirection for convenience. Use the host's permitted file tools for file work. A denied compound command does not prove that the declared atomic entry is unavailable; only an actual authorized invocation can establish its outcome. Do not expand permissions or work around a denial. Preserve the exact request and result, and follow the task's stop rule. A closed experiment or exhausted budget is not permission to retry it.

A normal test exit that records a failing behavior assertion is different from a permission denial. Missing files, import errors and harness failures are also different from that behavioral failure. Keep each outcome explicit instead of treating every nonzero exit as the same blocker. The number of commands and the allowed continuation depend on the current task; a historical eight-call experiment is not a requirement for every repair.

A host run establishes only the material bytes, task, host/version and observed actions in that run. It does not establish cross-provider equivalence, independent identity, automatic recovery or future task qualification.

[The historical two-host experiments](https://github.com/osborn-studio/osstack/blob/bf381f22b4833d781e9ec3d803d402f309e470a4/docs/implementation/joint-host-effects/README.md) preserve their commands and raw outputs. Both read pre-change material at `10629495aafe7b3aca0de4c920bcaec40b083d7b`; neither tested the template above or native discovery. Those results show explicit reading and reports about historical observations, not product driving or a measured causal improvement. Follow [the evidence rules](evidence.md) and retain that distinction in new runs.

Session continuity is shared guidance for recall, continuation, handoff and requested pause. It does not install history connectors, a background supervisor or a process fence. Historical host experiments above do not validate this later method; actual state/owner observations and unconfirmed cleanup must be recorded in each new task.

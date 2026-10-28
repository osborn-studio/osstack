# Export OSStack method entries

From this checkout, create a new project bundle beneath an existing parent:

```sh
pnpm export:methods --host codex --output /absolute/existing-parent/osstack-codex
pnpm export:methods --host claude --output /absolute/existing-parent/osstack-claude
```

Use `--dry-run` first to inspect the plan without creating files. The destination must not exist, including as a symlink. An export does not register global skills, edit existing project settings or change model/provider configuration. The exporter refuses destinations beneath the known protected host homes; select an ordinary new project destination. A failed export may leave its owned incomplete directory for inspection; use a new destination after fixing the reported cause.

Keep all four entry directories together: the entries link to each other. Each bundle has four entries: `osstack-mode`, `osstack-help`, `setup-osstack`, and `osstack-agent`. Codex gets `.agents/skills/`; Claude gets `.claude/skills/`. Shared references are copied into each entry and hashes are recorded in the manifest. Read that manifest and the resulting files before using the bundle. Copying an export into an existing project is a separate installation decision requiring collision checks; this tool does not perform it.

Open the generated project in the intended host and check the actual skill catalog. Host version, trust settings, disabled skills and conflicting names can affect discovery. Until that check is observed, report only successful export; do not claim a slash command is registered. Explicitly asking the host to read an exported `SKILL.md` is also supported, but proves a different consumption path.

`osstack-mode` selects evidence-led bug fixing, investigation, verification creation or maintenance. `osstack-help` explains these paths, `setup-osstack` prepares scoped role/model/budget choices, and `osstack-agent` guides an already delegated task. These materials create no OSStack CLI subcommands, native agent type, control-plane authority or runtime qualification. Original source attribution stays in each bundle.

The exporter is for the reviewed canonical materials. Reference sources must be non-hidden lowercase `.md` files; a stray `.DS_Store` is rejected. It supports a strict subset of Markdown links and definitions, so complex labels, titles, container definitions and some code-layout forms may be refused. Fragment anchors are not qualified. This is not a general HTML sanitizer or protection against concurrent mutation of source/output trees.

# neat R3 release candidate

R3 adds explicit, read-only platform memory inspection without changing the
default repository-only behavior of `osstack neat check`.

## Included

- a versioned `KnowledgeSurfaceAdapterV1` contract with read-only capability,
  detection, inventory, rule, identity, and official-source evidence fields;
- a contract executor that calls no adapter method without explicit consent and
  treats an absent enabled platform as a clean skip;
- strict `.osstack/neat.yaml` `adapters.claude_code` configuration and matching
  `--adapter claude-code --claude-memory-dir <path>` CLI flags;
- a Claude Code adapter that inventories immediate Markdown files from one
  exact absolute or `~/` directory and never enumerates sibling projects;
- portable `claude-code://auto-memory/...` metrics, with no local directory in
  findings or reports;
- the Claude-specific `memory.platform_limit_exceeded` warning for `MEMORY.md`
  above 200 lines or 25KB, including adapter id, version, content proof, and
  official documentation evidence.

## Safety boundary

The adapter exposes no write operation. Filesystem presence alone is never
consent. A disabled adapter does not detect, inventory, or load rules. No mtime
or file timestamp is interpreted as a recall event, and no limit is generalized
to another platform or repository knowledge surface.

The platform contract is sourced from
<https://code.claude.com/docs/en/memory>. Because that documentation does not
publish the default `<project>` directory encoding, R3 requires the exact memory
directory instead of guessing or scanning sibling projects.

Publication still requires the final R0-R4 monorepo release gates.

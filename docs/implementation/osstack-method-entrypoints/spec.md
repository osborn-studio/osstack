# OSStack named method entries and host exports

Base: main `f92914e0a98bd3e5f82765fddc5a275a93637f30`, after PR290. OSStack card `card_7ed42c18`. D2a method-material/export scope, with no new authority, DB/schema, provider, scheduler or runtime method activation.

Four canonical entries live under `osstack-methods-skill/entries/<name>/SKILL.md`: `osstack-mode` chooses an appropriate task method; `osstack-help` explains available methods and useful prompts; `setup-osstack` prepares role/model/reasoning-budget choices within the actual host's capabilities; `osstack-agent` wraps an already-delegated engineering task without creating an autonomous worker. Shared method references remain maintained once. Unsupported capabilities are explicitly distinguished from the existing four methods.

Export API: `node scripts/export-osstack-methods.mjs --host codex|claude --output NEW_ABSOLUTE_ROOT [--dry-run]`. The parent must exist, the destination must not. A directory or dangling symlink at the destination is refused. Dry-run performs no writes or child execution. The command writes only its newly allocated project root; it does not write global skills, model settings, OSStack homes or an existing checkout. Failed exports are visibly incomplete and retain only their owned output for inspection.

Codex layout is `.agents/skills/<name>/SKILL.md`; Claude layout is `.claude/skills/<name>/SKILL.md`. Each exported skill includes the references it requires. The exporter rewrites the canonical shared-reference prefix and checks that local links resolve inside the exported bundle; it cannot turn arbitrary repository files into exports through symlinks or path traversal. The output manifest binds canonical input bytes and exported file bytes. Export, host discovery, method interpretation and runtime qualification are separate facts.

Acceptance includes meaningful content/link/hash checks for both hosts, no-overwrite and invalid input rejection, read-only dry-run, safe source traversal and a real symlink entry invocation. Materials receive an independent behavior review against realistic task requests. Actual Codex/Claude use must retain raw inputs/responses and state whether it exercised explicit reading or native discovery. Setup must not invent model IDs or use a skill invocation as permission to overwrite configuration.

Primary documentation checked 2026-10-28: [Codex local skill loading](https://learn.chatgpt.com/docs/build-skills) and [Claude skill directories and invocation](https://code.claude.com/docs/en/skills). These establish layout compatibility, not a test of this candidate or the locally installed host versions. No marketplace address is fabricated.

Root owns package/CI hooks, central ledger, full-regression queue, actual Sonnet5.5 audit and PR publication. Materials and exporter have distinct authors; an independent reviewer receives realistic requests and original artifacts. User gilberthello alone approves and merges.

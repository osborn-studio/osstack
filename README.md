# OSBORN stack (osstack)

A Hermes-resident **project manager Agent** for the software development lifecycle.

**中文文档：[README.zh.md](README.zh.md)**

> Status: **V2 GA scaffold complete (S0-S6) + PartnerOS-core port (S7.1)**. 76/76 tests passing across 9 packages. See [docs/V2_REFACTOR_PLAN.md](docs/V2_REFACTOR_PLAN.md) and [docs/external/partneros-analysis.md](docs/external/partneros-analysis.md).

## What it is

osstack is a **Hermes skill/plugin** that handles the software-development-specific project-manager work that Hermes itself does not specialize in:

- Decide which sub-agent (Claude Code, Codex CLI, ...) should handle a task
- Track cross-task memory ("which agent does well on which task type")
- Learn from failure to refine the routing policy
- Normalize external skill ecosystems (GStack, SuperPower, Everything Claude, Anthropic Skills) into Hermes-compatible SKILL.md format

It is **not** a standalone product. Hermes owns messaging, cron, dashboard, kanban, memory, auth. osstack focuses only on dev-task orchestration.

## Architecture (dual-form)

```
+──────────────────────────────────────────────────────────────────+
│ Hermes session (Python)                                           │
│   ↓ import                                                        │
│ ~/.hermes/skills/software-development/osstack/scripts/             │
│   osstack_bridge.py  ←  thin Python wrapper                       │
│   ↓ Unix socket (/tmp/osstack.sock, length-prefixed JSON)         │
│ osstack daemon  (Node.js, TypeScript, launchctl-managed)           │
│   ↓                                                                │
│ @osstack/agents → @anthropic-ai/claude-agent-sdk → Claude Code     │
+──────────────────────────────────────────────────────────────────+
```

- TS daemon: this repository, published as `@osstack/cli` on npm.
- Hermes skill wrapper: lives at `~/.hermes/skills/software-development/osstack/`.

## Monorepo

| Package | Role |
|---|---|
| [`@osstack/cli`](packages/cli) | `osstack` binary |
| [`@osstack/core`](packages/core) | orchestrator / lifecycle / policy / memory / learning / privacy / observability / kg |
| [`@osstack/agents`](packages/agents) | sub-agent adapters (claude-code, codex-cli) |
| [`@osstack/hermes-adapter`](packages/hermes-adapter) | Hermes Run Adapter Contract impl |
| [`@osstack/skills`](packages/skills) | lifecycle skill templates + V1 shim |
| [`@osstack/plugins`](packages/plugins) | 7 plugin slots |
| [`@osstack/skill-registry`](packages/skill-registry) | external skill ingestion + LLM normalize |
| [`@osstack/runtime`](packages/runtime) | optional Zellij workspace (V1 osb-runtime preserved) |
| [`@osstack/partneros-core`](packages/partneros-core) | Intent model + FSM ported from [partneros-mvp](https://github.com/gilosbornhello/partneros-mvp); item 1 of analysis roadmap |

## V1 → V2

V1 is preserved verbatim in [legacy-python/](legacy-python/). Sprint 5 (S5) ships shim commands so existing scripts that call `osb-init`, `ds-review`, `osb-context`, etc. continue to work — the names route through V2 internals.

## Requirements

- Node.js ≥ 20 (corepack will manage pnpm)
- Hermes Agent installed at `/Volumes/AIMATE_WORK/projects/hermes-agent/` (or wherever; `HERMES_HOME` defaults to `~/.hermes`)
- macOS (launchctl-based daemon; Linux/systemd in a future sprint)

## Develop

```bash
git clone https://github.com/gilosbornhello/osbstack.git ~/Developer/osbstack
cd ~/Developer/osbstack
git checkout v2/typescript
corepack enable pnpm
pnpm install
pnpm build
pnpm test
```

## License

MIT. See [LICENSE](LICENSE).

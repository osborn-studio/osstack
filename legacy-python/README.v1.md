# OSBStack

A personal, global, shell-command-based capability package for AI-assisted product development.

> Use the best AI agents without being locked into any one agent runtime.

OSBStack is **not** a Claude Skill, a Codex plugin, or a Hermes worker. It is a system-level shell capability package that any agent runtime can call. It standardizes the loop:

```text
idea → docs → architecture → tasks → code → review → verify → test/build/deploy → release → iteration
```

## What you get

11 commands, two ways to invoke each:

| Long form | Short alias | What it does |
|-----------|-------------|--------------|
| `osbstack init` | `osb-init` | Scaffold the OSBORN project skeleton (docs/, tasks/, .agent/, AGENTS.md, …) |
| `osbstack context` | `osb-context` | Refresh `.agent/PROJECT_CONTEXT.md` from project state |
| `osbstack task <args>` | `osb-task` | Structured task management (Markdown files with YAML frontmatter) |
| `osbstack review` | `ds-review` | DeepSeek-powered code review on `git diff` |
| `osbstack verify` | `ds-verify` | DeepSeek-powered alignment check (PRD ↔ architecture ↔ sprint ↔ implementation) |
| `osbstack runtime` | `osb-runtime` | Launch / attach Zellij runtime workspace (5 tabs) |
| `osbstack loop` | `osb-loop` | Run the standard post-execution review/verify loop |
| `osbstack brief` | `osb-agent-brief` | Generate concise handoff brief for CCB / Codex / Claude Code |
| `osbstack run` | `osb-run` | Pre/post-execution helper (refresh context + write brief) |
| `osbstack architecture sync` | `osb-architecture-sync` | Verify diagrams ↔ docs are in sync (deterministic) |
| `osbstack release-check` | `osb-release-check` | Pre-release gate (deterministic GO / NO-GO) |

All commands are stdlib-only Python 3 + bash. No npm, no pip dependencies. The only external service is DeepSeek (for `ds-review` / `ds-verify`).

## Install

Requires: Python 3.9+, bash, git. Optional: [Zellij](https://zellij.dev) for `osb-runtime`, [`btop`](https://github.com/aristocratos/btop) for the monitor tab.

```bash
git clone https://github.com/gilosbornhello/osbstack.git ~/Developer/osbstack
cd ~/Developer/osbstack
./install.sh
```

`install.sh` symlinks `capabilities/` into `~/.osborn/capabilities/` and the eleven binaries into `~/bin/`. It does NOT modify your shell rc files. If `~/bin` is not already in `PATH`, it prints exact instructions to add it.

To uninstall:

```bash
./uninstall.sh
```

## Setup

```bash
export DEEPSEEK_API_KEY="sk-..."   # for ds-review and ds-verify
# Optional:
export DEEPSEEK_BASE_URL="https://api.deepseek.com"   # default
export DEEPSEEK_MODEL="deepseek-reasoner"             # default
```

## Usage

Initialize a new project:

```bash
mkdir my-project && cd my-project
osbstack init
osbstack context
osbstack task add "Implement login page" --priority P1
```

Day-to-day loop after your agent makes changes:

```bash
osb-run                  # refresh context, write .agent/AGENT_BRIEF.md
# … your agent does its turn …
osb-loop                 # context → review → verify → summary
```

Pre-release gate:

```bash
osb-architecture-sync    # diagrams ↔ docs alignment
osb-release-check        # GO / NO-GO with reasons
```

Persistent runtime workspace (optional, requires Zellij):

```bash
osb-runtime              # creates session "aimate" with 5 tabs
```

## Architecture

```text
~/.osborn/capabilities/
├── osbstack/                  ← umbrella dispatcher
├── osb-project/               ← osb-init, osb-context        (P1, P2)
├── deepseek/                  ← ds-review, ds-verify          (P3, P4)
│   ├── lib/                     api.py, doc_reader.py, …
│   ├── prompts/                 review.md, verify.md
│   └── upstream/                research notes per upstream
├── runtime/                   ← osb-runtime, osb-loop, osb-agent-brief  (P5–P7)
│   ├── lib/agent_brief.py
│   └── layouts/aimate.kdl
├── task/                      ← osb-task                      (P8)
│   └── lib/task_engine.py
└── workflow/                  ← osb-run, osb-architecture-sync, osb-release-check  (P9–P11)
```

Layered:

1. **Project structure** — `osb-init`
2. **Context** — `osb-context`, `osb-agent-brief`
3. **Task** — `osb-task`
4. **Review / verify** — `ds-review`, `ds-verify`
5. **Runtime** — `osb-runtime`, `osb-loop`, `osb-run`
6. **Architecture** — `osb-architecture-sync`
7. **Release** — `osb-release-check`

## Borrowed from

OSBStack adapts concepts (not code at runtime) from:

- [hustcer/deepseek-review](https://github.com/hustcer/deepseek-review) — DeepSeek client envelope, prompt structure, CLI flag conventions for `ds-review`.
- [github/spec-kit](https://github.com/github/spec-kit) — Given/When/Then acceptance phrasing, spec-driven workflow concepts.
- [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec) — drift framing for the alignment table in `ds-verify`.
- Taskmaster (concept reference) — task model fields and lifecycle for `osb-task`.

See `capabilities/deepseek/upstream/` for detailed borrowing notes per phase.

## Philosophy

OSBStack follows the Unix philosophy:

- small tools
- clear contracts
- composable workflows
- agent-agnostic design

The human is:

- goal setter
- architecture judge
- final acceptance reviewer

Everything else is delegated to agents and tools, with structured handoffs.

## Roadmap

V1 is feature-complete at P11. The full roadmap, including what is explicitly **not** built yet (Multica / OpenClaw / Hermes integration / autonomous schedulers), is in [`capabilities/OSBSTACK_PROJECT_SUMMARY_AND_ROADMAP.md`](capabilities/OSBSTACK_PROJECT_SUMMARY_AND_ROADMAP.md).

## License

MIT — see [LICENSE](LICENSE).

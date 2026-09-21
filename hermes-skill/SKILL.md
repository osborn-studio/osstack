---
name: osstack
description: "Use when running a software development task that benefits from explicit project-manager-style orchestration: deciding which sub-agent (Claude Code, Codex, ...) handles it, tracking cross-task memory, learning from past outcomes, or routing through the full design→code→test→ship lifecycle. Also use for publishing skills to OsbornSkillHub (api.osbornhub.com) through the OSStack Hub CLI. Bridges Hermes to the osstack daemon."
version: 0.12.0
author: Osborn (gilosbornhello)
license: MIT
platforms: [macos]
metadata:
  hermes:
    tags: [orchestration, project-manager, software-development, osstack, claude-code, codex]
    related_skills: [writing-plans, requesting-code-review, plan, subagent-driven-development]
    daemon_npm_version: "@osstack/cli@0.12.0"
    hermes_min_version: "0.12.0"
---

# osstack — Project Manager Agent

## Overview

osstack is a project-manager agent for software development tasks. It is a thin Python skill that bridges Hermes to an external Node.js daemon (the actual orchestrator). Hermes calls osstack when:

- a task is complex enough to need multi-agent coordination (e.g., write code → review → test → fix),
- the choice of which sub-agent to use is non-obvious,
- the work should be tracked alongside cross-task history,
- the user explicitly asks for the "project manager" treatment.

The daemon owns: agent selection (policy engine), task memory (SQLite), sub-agent invocation (`@anthropic-ai/claude-agent-sdk` for Claude Code, headless `codex` for Codex CLI), event streaming (Hermes Run Adapter Contract).

This skill itself is just a wrapper.

## When to Use

- User says: "use osstack to ..." / "have the project manager handle this" / "route this through osstack"
- A multi-step dev task (design → architecture → code → review → test) where you want explicit lifecycle gating
- A task where you want osstack to pick the right sub-agent based on history (not just "always use Claude Code")
- Need to track outcome / duration / cost across runs to refine future routing

**Don't use for:**
- Quick one-shot questions (use Claude Code directly)
- Tasks fully outside software development (use the appropriate Hermes skill)
- Anything that requires Hermes-side messaging, cron, or memory directly (those stay in Hermes)

## Status: Production Stable Control Plane (v0.12.0)

osstack is no longer a scaffold. The daemon runs as a launchd service (`ai.osstack.daemon`) on a versioned Node runtime, serving from a dedicated stable home (`OSSTACK_HOME`, default `~/.osstack-stable`) with a control-plane guard on every DB entry point, a 5-check `doctor` (including plist drift), fail-closed routing, and schema-governed migrations. Working today: agent routing + policy engine, loop sessions (`loop enqueue/run`), daily sessions, task memory (SQLite), kanban board + Telegram subscription relay, hub candidate/publish, stack CLI family, release train commands, and self-upgrade with health rollback.

## OsbornSkillHub publishing (including external agents)

For requests to upload/publish a skill to **OsbornSkillHub / api.osbornhub.com**, the existing route is `osstack hub publish`. It invokes the Hub companion, pushes the catalog Git repository, and waits for the deployed API version. Do not infer "no upload support" from the absence of a direct HTTP upload endpoint. `skills add` and `knowledge publish` serve different purposes.

Use the installed `osstack` CLI directly; the Python bridge does not expose these Hub commands:

```bash
# Read-only discovery; does not execute companion scripts or grant permissions.
osstack hub doctor --json
# For an EXISTING Hub-managed asset, after the user's publication authorization:
osstack hub publish <asset-id> --gate team --surfaces api --json
```

`OSSTACK_HUB_ROOT` (fallback `HUB_ROOT`) selects the trusted Hub checkout. `CATALOG_DIR` selects its catalog checkout (default: sibling `osborn-skill-catalog`). The catalog Git principal controls publishing; `SKILL_HUB_KEY` is only the API read credential used for verification. A readable API does not establish write access. Keep credentials in the trusted publisher runtime, never in messages or skill prompts.

If `doctor` is unknown, the installed CLI predates this diagnostic. Report its version and check `osstack --help` for `hub publish`; an old command surface is not evidence that the Hub lacks a publishing channel. If root/tooling/catalog is missing, report the specific missing setup. For a new asset, candidate registration only records an external Git source reference; it does not import content into the catalog or publish it.

For an external automated agent, obtain its actual runtime host/framework and authenticated principal before onboarding. A display name is not permission. `doctor` reports `publish_permission: unverified` even when configured. Missing booleans are `null`; report partial outcomes using `committed`, `pushed`, `apiVerified` and `delivery`. A nonzero exit is not completed delivery; a pushed but unverified result requires checking CI/API before a retry. Version verification is the companion's report, not independent artifact-digest attestation.

See [the onboarding and recovery guide](../docs/guides/hub-agent-publishing.md).

## Quick Usage

```bash
# Check daemon health
python3 ~/.hermes/skills/software-development/osstack/scripts/osstack_bridge.py health

# Get daemon version (proves Hermes can reach it)
python3 ~/.hermes/skills/software-development/osstack/scripts/osstack_bridge.py version
```

Both commands run the `osstack` binary directly via subprocess. Daemon-backed commands talk to the long-running launchd daemon over the Unix socket at `$OSSTACK_HOME/daemon.sock` (default `~/.osstack-stable/daemon.sock`).

## How It Works

1. Hermes session loads this skill (`SKILL.md`).
2. To do work, Hermes calls `osstack_bridge.py` via subprocess.
3. `osstack_bridge.py` shells out to the `osstack` CLI (must be on `$PATH`; the shim exports `OSSTACK_HOME`).
4. Daemon RPCs (kanban, stats, health, routing) go over the Unix socket to the launchd-managed daemon; Hermes never sees the daemon directly — only the wrapper.
5. Output is returned to Hermes for rendering.

## Kanban board (Telegram-facing)

osstack ships its own kanban board (lanes: triage → todo → ready → running → blocked → done). Every task the daemon runs auto-creates a card that moves to `running` then `done`/`blocked`. A Telegram chat can **subscribe** to a card and receive progress pushes — the way the user monitors osstack from their phone.

```bash
BRIDGE=~/.hermes/skills/software-development/osstack/scripts/osstack_bridge.py

# Show the board (what's in flight, what's blocked, what's done)
python3 $BRIDGE kanban-board

# Return the cockpit URL for Telegram/WeChat replies
python3 $BRIDGE dashboard-url

# Create a planning card
python3 $BRIDGE kanban-create "Refactor auth module" 5 claude-code

# Move a card across lanes
python3 $BRIDGE kanban-move card_ab12 done

# Subscribe THIS Telegram chat to a card's progress
#   (chat_id comes from the Hermes message context)
python3 $BRIDGE kanban-subscribe card_ab12 "$TELEGRAM_CHAT_ID"

# Drain pending events → format + relay each to subscribed chats
#   (run this on a Hermes cron tick, e.g. every minute)
python3 $BRIDGE kanban-events
```

### How the Telegram loop works

1. **User (Telegram):** "show me the osstack board" → Hermes calls `kanban-board`, renders the columns.
2. **User:** "tell me when card_ab12 finishes" → Hermes calls `kanban-subscribe card_ab12 <chat_id>`. The daemon records the subscription with a cursor at the current latest event, so the chat only gets FUTURE progress.
3. **Cron tick:** Hermes calls `kanban-events`, which returns the event log past each subscription's cursor. The daemon advances cursors only after Hermes confirms delivery, so a dropped tick re-delivers next time (at-least-once).
4. Hermes formats each event ("📋 card_ab12 — moved running → done ✅") and sends it to the subscribed chat/thread.

Subcommand reference:

| Command | Daemon RPC | Purpose |
|---|---|---|
| `kanban-board [board] [archived]` | `kanban.board` | Full board with columns + stats |
| `kanban-create <title> [pri] [assignee]` | `kanban.create` | New card in triage |
| `kanban-move <card_id> <status> [reason]` | `kanban.move` | Drag a card across lanes |
| `kanban-comment <card_id> <text> [author]` | `kanban.comment` | Thread comment (emits event) |
| `kanban-subscribe <card_id> <chat_id> [thread]` | `kanban.subscribe` | Telegram chat ← card progress |
| `kanban-events [since]` | `kanban.events` | Drain events for the relay |
| `kanban-subscriptions [card_id]` | `kanban.subscriptions` | List who's subscribed |
| `dashboard-url` | `dashboard.url` | Return the local cockpit URL to send back in chat |
| `dashboard-snapshot` | `dashboard.snapshot` | Return the JSON backing the cockpit |

Borrowed from Hermes Agent's own kanban: the 6-lane column model, per-card event log, incremental polling (`since`/`latest_event_id`), and the notify-subscription pattern. osstack's board is its own SQLite-backed surface so it works even when Hermes is offline; Hermes is just the relay.

## Installation Check

```bash
# Required:
node --version     # ≥ 20 (daemon itself runs on a pinned versioned Node runtime)
which osstack || echo "osstack binary not on PATH — /opt/homebrew/bin/osstack shim expected"

# Daemon (production stable control plane):
launchctl list | grep ai.osstack.daemon
ls ~/.osstack-stable/daemon.sock
osstack doctor          # 5-check health incl. plist drift
```

## References

- [Plan v0.6](https://github.com/gilosbornhello/osbstack/blob/v2/typescript/docs/V2_REFACTOR_PLAN.md) — full architecture and Sprint roadmap
- [Hermes Run Adapter Contract RFC](https://github.com/nesquena/hermes-webui/blob/main/docs/rfcs/hermes-run-adapter-contract.md) — event protocol osstack implements
- `references/` in this skill — sub-docs for capability schema, lifecycle phases, event mapping (land in S1)

## Common Pitfalls

1. **Calling osstack for trivial tasks.** osstack adds project-manager overhead. For a single one-shot question, Claude Code direct is faster.
2. **Talking to the wrong home.** The stable daemon serves `~/.osstack-stable` (exported as `OSSTACK_HOME` by the shim); `~/.osstack` is a sacrificial sandbox. If a command reports schema/guard refusal, check `OSSTACK_HOME` before assuming the daemon is down.
3. **Hardcoding paths.** The bridge auto-detects `osstack` on `$PATH` and falls back to a clear error if missing.

## Verification Checklist

- [ ] `python3 osstack_bridge.py version` prints the current CLI version (0.12.x)
- [ ] `python3 osstack_bridge.py health` prints a JSON status block
- [ ] If `osstack` is missing from `$PATH`, the bridge prints a clear install hint, not a Python traceback

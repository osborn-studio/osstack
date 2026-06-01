# OSBStack — Project Summary and Roadmap

## 0. One-Line Definition

OSBStack is a personal, global, shell-command-based capability package for AI-assisted product development.

It is designed to help me run the full product development loop:

```text
idea → docs → architecture → tasks → code → review → verify → test/build/deploy → release → iteration
```

The goal is to reduce human interruption and let docs, tasks, and acceptance criteria drive agents.

---

## 1. Core Insight

The current bottleneck is not that Claude Code, Codex, DeepSeek, or ChatGPT are weak.

The real bottleneck is the lack of a **project-level Agent Workflow Manager**.

The system needs to solve three problems:

1. Close the loop from documents → architecture → tasks → code → testing → deployment.
2. Let multiple agents/tools each do their role instead of requiring human copy-paste between them.
3. Automate review / verify / rerun as much as possible, interrupting human only for key decisions.

---

## 2. Device Role

### Mac mini

The Mac mini is the 7×24 AI runtime node.

**Role:** AI Runtime Server / AImate

Main tools:
- Claude Desktop = main brain
- CCB = Claude Code Bypass, main executor
- Zellij = runtime console
- OSBStack = global shell capability package
- DeepSeek = review / verify backend
- Codex CLI = optional patch worker
- ChatGPT for Mac = optional, low-frequency use

### MacBook Pro

The MacBook Pro is the mobile product and architecture studio.

**Role:** Product Studio / Control Console

Main tools:
- ChatGPT for Mac = plan mode, architecture diagrams, flow diagrams
- Codex for Mac = GUI coding
- MLX local models = local experiments
- Warp = terminal UI

---

## 3. OSBStack Is Not a Claude Skill

OSBStack should not be bound to one agent runtime. It should not live only inside:

- Claude Code skill folder
- Codex plugin folder
- Hermes plugin folder
- OpenClaw workflow folder

Instead, OSBStack should be a **global system-level capability package**.

Recommended installation root:

```text
~/.osborn/osbstack/
```

or:

```text
~/.osborn/capabilities/
```

Recommended command exposure:

```text
~/bin/osbstack
~/bin/osb-init
~/bin/osb-context
~/bin/osb-task
~/bin/ds-review
~/bin/ds-verify
~/bin/osb-loop
```

**Principle:**
> Agent runtimes are replaceable.
> Capabilities should be reusable.

---

## 4. OSBStack Command Style

The preferred long-term interface is one main command:

```bash
osbstack <subcommand>
```

Examples:

```bash
osbstack init
osbstack context
osbstack task add "Implement login page"
osbstack review
osbstack verify
osbstack loop
osbstack runtime
osbstack release-check
```

For speed and compatibility, keep short aliases:

```text
osb-init        → osbstack init
osb-context     → osbstack context
osb-task        → osbstack task
ds-review       → osbstack review
ds-verify       → osbstack verify
osb-loop        → osbstack loop
osb-runtime     → osbstack runtime
```

This gives both: clean package identity + fast shell ergonomics.

---

## 5. Open Source Projects to Learn From

OSBStack should not blindly reinvent everything. Useful references:

### 5.1 GitHub Spec Kit

Open-source CLI toolkit for spec-driven development. Initializes project structure and uses specifications to steer coding agents (GitHub Copilot, Claude Code, Gemini CLI).

Borrow: spec-driven project structure, command-line initialization, cross-agent portability.
Avoid: full workflow if it conflicts with OSBORN docs structure.

### 5.2 GStack

Garry Tan's Claude Code setup with opinionated roles: CEO, Designer, Eng Manager, Release Manager, Doc Engineer, QA, etc. (~23 tools).

Borrow: thinking patterns, review lenses (CEO review, eng review, doc review, release review, QA review), structured role prompts.
Avoid: binding everything only to Claude Code slash commands.

### 5.3 Taskmaster

AI-powered task management system that parses PRDs, manages dependencies, and helps agents ship code matching requirements.

Borrow: task format, sprint generation, dependency tracking, acceptance criteria linkage.

### 5.4 hustcer/deepseek-review

DeepSeek-powered code review project (already adapted into P3).

Borrow: DeepSeek review implementation, API handling, prompt patterns, local git diff review.

### 5.5 OpenCode / Aider / other coding agents

Useful as optional execution / patch agents, but not the core of OSBStack.
**OSBStack should orchestrate around existing coding agents, not replace them.**

---

## 6. What Should Be Built vs Borrowed

### Build Ourselves
Specific to this workflow:
- osb-init, osb-context, osb-task, osb-agent-brief, osb-loop, osb-release-check
- OSBORN project templates
- CCB protocol
- agent handoff format

### Borrow / Adapt
- ds-review from DeepSeek review projects
- ds-verify from verification / doc consistency tools
- task parsing ideas from Taskmaster
- thinking modes from GStack
- spec workflow ideas from Spec Kit

### Do Not Build Yet
- full autonomous scheduler
- Multica replacement
- OpenClaw replacement
- Hermes replacement
- full multi-agent dashboard

---

## 7. Final Scope: Stop at P11

The first version of OSBStack should stop at P11.

- No Multica integration.
- No OpenClaw orchestration.
- No full autonomous workers.

The target is a **minimum stable loop**.

---

## Phase Roadmap

### P1 — osb-init  ✅ shipped
Initialize standard OSBORN project skeleton.

### P2 — osb-context  ✅ shipped
Generate / update `.agent/PROJECT_CONTEXT.md`.

### P3 — ds-review  ✅ shipped
DeepSeek-powered code review (adapted from hustcer/deepseek-review).

### P4 — ds-verify  ✅ shipped
DeepSeek-powered implementation verification (alignment check).

### P5 — osb-runtime  ✅ shipped
Zellij runtime console with 5 tabs (1-dev, 2-review, 3-verify, 4-test-build-deploy, 5-monitor).

### P6 — osb-loop  ✅ shipped
Run the standard post-execution review/verify loop.

### P7 — osb-agent-brief  ✅ shipped
Generate concise handoff brief for CCB / Codex / Claude Code.

### P8 — osb-task
Structured task management. Inspired by Taskmaster. Task fields:
id, title, status, priority, linked docs, files involved, acceptance criteria,
do-not-change rules, test plan, rollback plan, dependencies.

### P9 — osb-run
Semi-automatic execution helper. Flow: osb-context → osb-agent-brief --for ccb --write → manual agent step → osb-loop.

### P10 — osb-architecture-sync
Keep architecture diagrams and architecture docs synchronized. Tracks references, does NOT generate images.

### P11 — osb-release-check
Pre-release gate. Checks tests, build, changelog, ds-review/verify run, acceptance criteria, risk register, deployment docs, rollback plan.

---

## Recommended V1 Command List

**Long form:**
```text
osbstack init
osbstack context
osbstack task
osbstack review
osbstack verify
osbstack runtime
osbstack loop
osbstack brief
osbstack run
osbstack architecture sync
osbstack release-check
```

**Short aliases:**
```text
osb-init, osb-context, osb-task,
ds-review, ds-verify,
osb-runtime, osb-loop, osb-agent-brief,
osb-run, osb-architecture-sync, osb-release-check
```

---

## Layered Architecture

1. **Project Structure Layer** — `osb-init`
2. **Context Layer** — `osb-context`, `osb-agent-brief`
3. **Task Layer** — `osb-task`
4. **Review / Verify Layer** — `ds-review`, `ds-verify`
5. **Runtime Layer** — `osb-runtime`, `osb-loop`, `osb-run`
6. **Architecture Layer** — `osb-architecture-sync`
7. **Release Layer** — `osb-release-check`

---

## What OSBStack Should Not Be Yet

OSBStack V1 should not be:
- full autonomous multi-agent system
- OpenClaw replacement
- Hermes replacement
- Multica replacement
- cloud platform
- GUI dashboard
- agent marketplace

It should be:
- global shell capability package
- project workflow standardizer
- review/verify loop runner
- task/context/acceptance manager

---

## Future After P11

After P11, **pause**. Use OSBStack in real projects and observe:
- Where do I still get interrupted?
- Where does CCB still drift?
- Where does review fail?
- Where does verify miss things?
- Where does task structure feel heavy?

Only after real usage, consider:
- Hermes integration
- OpenClaw long-running workers
- Multica-style visual coordination
- web dashboard
- automatic task routing
- multi-agent scheduling

---

## Final Philosophy

OSBStack should follow the **Unix philosophy**:
- small tools
- clear contracts
- composable workflows
- agent-agnostic design

The real goal:

> Use the best AI agents without being locked into any one agent runtime.

The human should stop being the person who manually moves context around. The human should become:
- goal setter
- architecture judge
- final acceptance reviewer

# OSBORN Capability Layer

This directory contains system-level capabilities that can be called by any agent runtime.
These tools should not be tightly coupled to Claude, Codex, Hermes, or OpenClaw.

Principle:

```text
Agent runtimes are replaceable.
Capabilities should be reusable.
```

Current capabilities:

* osb-project: project skeleton and context tools
* deepseek: review and verify tools, implemented in later phases

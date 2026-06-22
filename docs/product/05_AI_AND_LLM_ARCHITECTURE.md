# AI And LLM Architecture

## Adapter Strategy

osstack prefers subprocess-first adapters so users can reuse authenticated local CLIs:

- `codex-cli`
- `claude-cli`
- `opencode-cli`
- `claude-code`
- local commands and deterministic verifiers

SDK/API adapters remain explicit advanced paths.

## Control Signals

Loop control must be deterministic. Exit codes, verifier results, persisted events, and policy records decide whether a run stops, retries, or escalates. LLM output can advise plans and changes, but it must not fabricate evidence.

## Evidence Requirements

Agent selection should produce policy evidence. Agent runtime artifacts should record adapter mode, auth mode, roles, and event sequence pointers when available.


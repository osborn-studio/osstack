# System Architecture

## Layers

```text
CLI / cockpit / Hermes skill
        |
daemon RPC / local command path
        |
LoopEngine + task discovery + router
        |
agent adapters / local executor
        |
verifiers / governance / reviewers
        |
state.db + LOOP-STATE.json + reports/proof
```

## Package Boundaries

- `@osstack/cli`: commands, daemon, cockpit, proof assembly.
- `@osstack/loop`: loop state, report model, scorecard rendering.
- `@osstack/core`: policy, state, kanban, lessons, telemetry primitives.
- `@osstack/agents`: adapter implementations and worktree isolation.
- `@osstack/governance`: deterministic scanner.
- `@osstack/knowledge`: Knowledge Cloud pack contracts, search, local cache, and cloud sync.
- `@osstack/compliance`: mapping packs and proof views.

## Design Constraints

- Evidence layers do not own the loop.
- Governance is a verifier, not the policy engine.
- Cloud features fail open to local/off where possible.
- User secrets and model API keys are not stored by default.

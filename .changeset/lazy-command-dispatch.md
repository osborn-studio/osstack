---
"@osstack/cli": patch
---

Lazy-dispatch the CLI command surface: every command module and heavy package (`@osstack/loop`, `agents`, `governance`, `github`, `supervisor`, `config`) now loads at its dispatch/use site instead of at startup. `osstack status`/`--help` drop from ~350ms (pre-plan) / ~150ms (post-wrapper) to **~75ms** end-to-end; the eagerly-parsed main chunk shrinks from 1.1MB to ~500KB. `@osstack/loop` values go through a memoized `loadLoop()` with types kept static; five internal helpers became async (all call sites awaited); the `@osstack/config` package's hidden dependency on `@osstack/agents` and the `@osstack/supervisor` chain that pulled loop/governance/agents/github back in (~177ms) are both cut. Import-failure paths surface as clean `osstack:` errors via the entry wrapper.

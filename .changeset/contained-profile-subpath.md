---
"@osstack/agents": patch
"@osstack/cli": patch
---

Move the contained profile loader, profile execution and commit exporter to `@osstack/agents/contained-profile` and re-export them from the CLI without changing behaviour.

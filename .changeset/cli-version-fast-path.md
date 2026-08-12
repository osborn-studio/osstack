---
"@osstack/cli": patch
---

Answer `osstack --version` in ~30ms (was ~350ms) via a lightweight entry wrapper.

`dist/bin.js` is now a 1KB wrapper (`cli-entry.ts`) that serves `--version`/`-v`/`version` without loading the command surface, then lazily imports the full CLI (emitted as a split chunk) for every other command. The direct-execution guard moved into the wrapper and `bin.ts` no longer self-executes — under `bun build --compile` every bundled module reports the same `import.meta.url`, so a guard left in the chunk would have run `main()` twice. Importing `dist/bin.js` as a module remains side-effect free. A new `smoke:cli-startup` gate (`scripts/bench-cli-startup.mjs`) budgets `--version` at 150ms and `--help` at 500ms so the startup tax cannot silently return.

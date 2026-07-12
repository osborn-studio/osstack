---
"@osstack/cli": minor
---

Machine-scoped portfolio registry fallback (R1.6). `resolveRegistryPath` now
resolves, in order: explicit `--registry`; explicit `--workspace` (pinned, no
fallback); `cwd/.osstack/repos.json` when it exists; `$OSSTACK_HOME/repos.json`
when it exists; the legacy cwd default otherwise. `osstack daily` / `supervise`
now find the machine-scoped registry from any cwd without flags. No behavior
change for repos that already have a workspace-local registry.

Write-path note: `supervise register` writes to the resolved registry, so with
a machine registry present and no local one it now appends there instead of
creating a fresh local file — pass `--workspace .` to force a repo-local
registry.

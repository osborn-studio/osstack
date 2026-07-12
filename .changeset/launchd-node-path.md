---
"@osstack/cli": patch
---

`serve --install`: fix the generated LaunchAgent crash-looping with exit 127
(`env: node: No such file or directory`). launchd's default PATH lacks
`/opt/homebrew/bin` (and nvm shims), so a JS bin's `#!/usr/bin/env node`
shebang cannot resolve. The plist now, for JS bin paths (detected via
realpath, so the extensionless npm-global symlink shim is covered too),
extends PATH (current runtime's dir first, then the standard install dirs)
and invokes `node` by name — no absolute node path is pinned, so a later
brew/nvm node upgrade keeps working. Native single-binary installs are
still executed directly.

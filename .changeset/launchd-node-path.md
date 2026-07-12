---
"@osstack/cli": patch
---

`serve --install`: the generated LaunchAgent plist now invokes the resolved
Node runtime (`process.execPath`) explicitly for `.js` bin paths. launchd's
default PATH lacks `/opt/homebrew/bin` (and nvm shims), so the previous
shebang-reliant invocation crash-looped with exit 127 (`env: node: No such
file or directory`) under KeepAlive. Native single-binary installs are
unchanged (still executed directly).

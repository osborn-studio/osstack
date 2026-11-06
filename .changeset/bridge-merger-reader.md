---
"@osstack/cli": patch
---

Add the read side of the App E shadow merger (M-B): `contained-mission-merger-reader.ts` builds the typed `MergeGateInput` for `evaluateMergeGates` from one GraphQL query document and `gh api --method GET` requests against a fixed path allowlist (registered repository and ruleset ids only; no `-f`/`-F`/`--input`/`-X`), with two full reads required for `would_merge`; `contained-mission-merger-config.ts` loads `$OSSTACK_HOME/bridge/merger.json` (strict, rejects any credential field, missing means off). `redactBridge` moves to the dependency-free `contained-mission-redact.ts` (still re-exported from `contained-mission-bridge.ts`) so the merger never imports App-credential code. Nothing calls the new modules yet.

---
"@osstack/governance": minor
---

Add the contained Mission patch classifier as pure functions: `classifyMissionPatch` parses a bounded unified diff and returns `rejected`, `T2`, `T1` or `T0` with stable, ordered reason codes, using a digested protected set and cumulative caps that a spec may only tighten. `scanForSecrets` and `redactSecrets` scan and redact any executor output channel (patch, final message, stdout, stderr) without ever returning the secret value.

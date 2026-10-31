---
"@osstack/agents": minor
---

Add `CodexProxyExecutor` for contained Missions. It runs Codex read-only with user config and rules ignored, in an isolated HOME and CODEX_HOME that hold only a copied login, and reads the proposed patch losslessly through `-o`. Codex runs in its own process group with stop evidence, and a host-run qualification probe checks that the sandbox denies writes and network for the probe and for a descendant that left its group.

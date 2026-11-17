---
"@osstack/cli": minor
"@osstack/protocol": minor
---

Accept `mission.decide` with an optional decision ID and expected revision. Record acceptance before execution and bind each ID to its principal and decision content. Commit budget charges with effect markers, return unknown after an interrupted effect, and retry effect-free refusals under the same ID. Replays include the current Mission view beside the recorded result.

A keyed decision scans Mission history inside the write transaction. Long Missions may exceed the RPC budget; use kind-specific queries or an index later.

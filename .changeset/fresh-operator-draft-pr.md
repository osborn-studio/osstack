---
"@osstack/cli": minor
"@osstack/core": minor
"@osstack/loop": patch
---

Add trusted local `improve deliver`: one preview confirmation approves a draft proposal, builds and reviews a candidate, replays the saved patch in a clean checkout, verifies it again, and creates a draft GitHub PR. Persist delivery intents, exact commit bindings, cooperative stops and read-only reconciliation in schema 27. PR verification replaces ambient environment inheritance; existing verifier callers keep their defaults. Uncertain writes are never retried automatically. This does not enable daemon delegation, merge, release or hostile-worker isolation.

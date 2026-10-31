---
"@osstack/protocol": minor
"@osstack/skill-registry": patch
---

Move the generic source contracts (`SourcePin`, `SourceSnapshot`, `sourceSnapshotDigest`) and canonical JSON out of `protocol/joint` into the new opt-in `@osstack/protocol/source` subpath. `@osstack/protocol/joint` re-exports the same objects and keeps its error codes and digest domain registry, so its behavior is unchanged. Skill-registry source inspection and adoption now import from the neutral subpath.

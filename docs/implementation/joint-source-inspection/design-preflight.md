Historical input to the Sonnet preflight, superseded by README.md and the implementation. Do not use this draft as the final API contract.

# J02a: bounded immutable Git source inspection

A candidate source snapshot is data, not method activation or qualification. The host supplies an authenticated repository identity and a local mirror path. The reader cannot authenticate an origin from local Git config.

Input: full 40/64 lowercase commit, repository identity, canonical POSIX subdir (or .), and 1..32 explicit repository-relative license file paths. Capture all regular blobs in that subdir and the declared license files. Reject unsafe paths, symlinks, gitlinks, case/NFC collisions, missing objects and malformed UTF-8 paths. Never read checkout files. Read at most 512 files, 512 KiB per file, 8 MiB total. Tree output is capped at 2 MiB; each Git process at 5 seconds and the operation at 30 seconds. No shell, checkout, filters, hooks or lazy network fetch. SHA-1/SHA-256 Git object hashes are recomputed over blob/commit bytes. The local object store and Git binary are trusted host infrastructure, not a malicious-same-UID boundary.

SourcePin.content_sha256 is jointDigest('osstack.joint.source-content.v1', {schema_version:1, repository, commit, subdir, files}), with files sorted by UTF-8 path and each entry {path,mode,blob,bytes,sha256,role:'source'|'license'}. This newly implemented domain is explicit and acyclic. It does not change sourceSnapshotDigest from J01 or legacy DeliveryContract hashing. license_refs contains sorted unique sha256:<content sha> references derived from declared license blobs; these references establish bytes, not legal permission.

Output: J01 SourceSnapshot, its sourceSnapshotDigest, the content manifest, and dependency_resolution='not_performed'. Dependencies is empty for this single-source primitive. No registry may treat it as a closed adoption graph. J02b will add adoption/dependency resolution and registry integration. The optional expected content digest detects drift. A different commit remains a different snapshot even when bytes happen to match.

Validation: real temporary Git repositories, SHA-1 and SHA-256; dirty checkout and untracked files ignored; replace objects disabled; Git environment injection ignored; path/type/collision/missing-object and all resource-limit negatives; raw binary/CRLF byte hashes; no local origin config trusted. No DB, public CLI, watcher, scheduler or default activation in J02a.

Official references: https://git-scm.com/docs/git-cat-file ; https://git-scm.com/docs/git-ls-tree ; https://git-scm.com/docs/git (environment variables). Git content is untrusted data and is never executed.

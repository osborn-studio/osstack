# Host-registered local data sources

## Slice contract (R3a)

The host explicitly registers a typed local JSON snapshot reader. Registration is
not discovered from repository content or accepted from an inspect request.
Default registration is empty. No plugin code, shell, network, dynamic imports,
credentials, action grants, source-ledger writes, task completion or publication.

A registration binds a canonical repository/default tenant, an explicit source
root, one relative regular file, a strict versioned manifest, independently pinned
manifest and content SHA-256 values, fixed `snapshot.read` capability, maximum
bytes/items/read time, and host verification/expiry times. Canonical manifest
hashing has fixed field order. Content pin changes require host re-registration.
The root and path are private host configuration; responses expose only source ID,
version, manifest/content digest, and bounded typed data.

Snapshots use schema version 1 with source ID, version, a monotonically comparable
nonnegative revision, and unique `{id,text}` entries. Unknown fields, oversize,
identity mismatch, changed file, symlink escape, pin mismatch, stale/expired
registration, clock rollback within the same service lifetime or unsupported protocol fail closed. Content is
untrusted reference data; text never becomes instructions or authority. This
snapshot-only protocol has no event cursor: gaps/event replay are unsupported,
not silently converted to completion.

Limits: at most 32 registrations, 2 actual reads concurrently, 65536 source bytes,
20 entries, 1000ms local read deadline. Timed-out work retains its actual read slot
until underlying filesystem work settles; late results cannot be returned. Reads
use regular-file checks, no-follow/nonblocking open, bounded allocation, and
before/after file identity checks. Cancellation stops observation, never a worker.

Implementation order: strict schemas and digest; pinned local reader; registry
scope/expiry/budgets; inspect CLI handler; real-file integration and hostile input
regressions; isolated Haiku audit. No migration or central entrypoint edits.

Acceptance counterexamples include default-none, other repo/tenant, changed pin,
manifest expansion, malformed/oversize/duplicate data, symlink escape, stale and
future host verification, abort/timeouts with retained slots, output injection,
and an inspect request attempting to add file/shell/credentials. A source receipt
is neither evidence of worker completion nor proof of semantic correctness.

The existing execution-context loader accepts pinned knowledge-pack evidence;
this slice does not reclassify arbitrary local JSON as that evidence or inject it
automatically. A separate explicitly qualified adapter is pending. Parent wiring
owns the real daemon method and command dispatch.

## Host integration and configuration

Create one long-lived `createHostLocalDataSourceService({configPath})` per daemon,
with the fixed `OSSTACK_HOME/source-registry.json` path. Do not allow the request
to select this file, and do not recreate the service per request (its actual-read
slots must survive logical timeouts). `inspect(input, signal?)` accepts only
`{source_id,repo_path,default_tenant:true}` and returns a strict bounded result. Invalid request shape rejects with the stable
`invalid_request` error; the daemon must map this as a request error.
`loadHostLocalSources(configPath)` is the host-only configuration reader; the
service imposes the overall deadline. Missing configuration is `disabled`;
malformed, wrong-owner, symlink or group/other-readable configuration is `unknown`.
Both contain no entries. An explicit empty registration array is `not_registered`.

The file is a same-owner private regular file (for example mode 0600), at most
128 KiB, with `{schema_version:1,registrations:[...]}`. Each registration has
`source_root`, `manifest`, `manifest_digest`, and `content_digest`. The latter is
SHA-256 of exact source file bytes. Compute `manifest_digest` with
`localSourceManifestDigest(manifest)` after explicitly reviewing the manifest;
the manifest does not self-authorize. Every inspect reloads the configuration and
checks its bytes and file identity again after reading content. Revocation and
changes during a read return unknown. There is no automatic install or repinning.

Manifest fields: `schema_version:1`, a lowercase `id`, `version`,
`protocol:"local_json_snapshot_v1"`, canonical `repo_path`, `default_tenant:true`,
`capabilities:["snapshot.read"]`, relative `file`, `max_bytes` (1..65536),
`max_items` (1..20), `read_timeout_ms` (10..1000), host `verified_at_ms`,
`expires_at_ms` (after verification, at most seven days), and `fresh_for_ms`
(1..86400000). Freshness derives from this explicit host verification window;
file modification time and payload timestamps cannot refresh trust. Stale and
expired sources return no entries. Text is untrusted even when pins match.

The source JSON contains only `schema_version:1`, `source_id`, matching `version`,
nonnegative integer `revision`, and `entries:[{id,text}]`. Entry IDs must be unique.
Revision is metadata within the pinned snapshot, not a completion event or an
accepted history sequence. Unknown fields are rejected.

Central wiring calls `handleLocalSourceCommand(args,{rpc,stdout?,stderr?})` from
`sources inspect ID --repo ABS --default-tenant [--json]`. The RPC port is fixed
`('source.inspect',params,1500,signal)`; the handler also has a local 1500ms wait
bound. The service enforces its own total 1000ms bound independently. The handler
returns 0 only for a ready integrity-checked snapshot, 1 for unavailable or invalid
observations. This is not a source's semantic accuracy or worker health claim.

## Explicit qualification limits

Host wall-clock correctness is required across daemon restarts. Rollback detection
is in-memory within one service lifetime; it is not a durable anti-rollback clock.
After host clock uncertainty, re-verify registrations before relying on freshness.
There is no automatic claim of freshness surviving a clock change and restart.

Node's `O_NOFOLLOW` protects the final component only. Pre/post canonical path and
identity checks detect persistent intermediate-directory replacement, but cannot
prove that a directory was never briefly swapped between those checks. A racing
read can touch another regular file; it cannot return different unpinned bytes.
The independent content pin remains the disclosure boundary. This first slice is
qualified only for host-controlled local source directories, not adversarial
shared filesystems or an atomic directory-handle confinement guarantee. No NFS/SMB
or native per-component open qualification is claimed. The service can retain both
slots indefinitely on a stuck filesystem; it reports unknown/busy and never
resets slots to launch more reads. Diagnose the filesystem before operator-led
service recovery.

The CLI canonicalizes the explicit local repository inside its read deadline and
checks the response source ID, canonical repository and default tenant before any
output. A substituted snapshot is unknown and its entries are never displayed.

Early disabled/busy/cancelled/config-invalid failures echo the submitted repository
as a request label, without touching that repository or asserting canonical
ownership. They always have `qualification:unqualified`, no provenance and no
entries. Only a ready source receipt has verified canonical scope. The CLI sends
canonical paths even in these early cases. A dangling registration path cannot be
attributed to a caller and is conservatively `not_registered`; a resolving alias
for the owning repository is `config_invalid`. A race after request canonicalization
may also produce `config_invalid`; no content is exposed.

# Managed native multi-home upgrades

This opt-in backend closes U2's implementation gap for a **new, private, same-UID managed launchd installation**. It never adopts a live npm-global prefix, evaluates package lifecycle scripts, uses an unpinned npm channel, automatically publishes, or restores an old database. Linux/systemd and checkout deployments fail closed. Real macOS launchd rollout, actual published release qualification, physical power-loss durability and network filesystems are not qualified by local process tests.

## Layout and authority

The installation root must be canonical and private (`0700`). `installation.json` is a private, immutable registry containing:

```json
{
  "schema_version": 1,
  "backend": "launchd",
  "installation_id": "production-managed",
  "root": "/absolute/private/installation",
  "node": "/absolute/canonical/node",
  "node_sha256": "64 lowercase hex characters",
  "entry": "node_modules/@osstack/cli/dist/bin.js",
  "consumers": [{
    "home_id": "home_32lowercasehexcharacters000000000",
    "home": "/absolute/private/home",
    "socket": "/absolute/private/home/daemon.sock",
    "label": "ai.osstack.managed.primary"
  }]
}
```

Use real identity IDs from the explicit inventory; the example values are illustrative. There are at most 32 consumers; IDs, homes, sockets and labels must each be unique. Every socket lives directly in its canonical private home. The complete closed consumer set is duplicated into `consumers/<home_id>.json`, and exact generated launchd plists live in `services/<home_id>.plist`. Extra, missing or changed records fail closed. Registry edits cannot race an already approved upgrade: its raw-byte SHA pin is checked at every boundary. No command silently adds a consumer. A changed consumer set requires a newly provisioned installation and fresh approval.

A persistent `upgrade-operation.json` fence blocks managed startup during stop/snapshot/switch. Native SQLite owner and daemon locks serialize upgrades across *different journal directories* and prevent consumers reopening their DB while stopped. Unknown outcomes retain the persistent fence and journal claims; kernel locks release on process exit. No age, PID timeout or stale-lock heuristic grants permission to replay an effect.

This is completeness for managed consumers of this controlled installation, not discovery of arbitrary programs a trusted administrator copies or launches outside it. The startup gate must run before any database opening; it refuses unregistered homes, mismatched socket/Node/current release, or a start lacking an exact post-switch permit. After opening, actual compiled version/protocol and actual schema must match the release declaration before the daemon reports host-manifest evidence.

## Exact release artifact

An artifact is bounded UTF-8 JSON (128 MiB maximum, 20,000 files), prepared from a fully resolved, platform-specific npm installation. It contains `schema_version:1`, `target` matching the existing upgrade plan target, and `files:[{path,mode,content_base64}]`. Modes are decimal 384 (`0600`) or 448 (`0700`). Paths are relative, traversal-free and case-insensitively unique; symlinks, archive extraction, package scripts and external fetches are absent. Include dependencies/native addons and the explicit `control-plane.json` serving-home declaration as pinned bytes. A release is executable code: only approve artifacts from the operator's trusted build/release process.

`target.build_digest` is SHA-256 of canonical JSON for the path-sorted array `{path,mode,sha256}`, with SHA-256 computed over decoded file bytes. The artifact's raw SHA-256 independently pins the entire metadata and content. The target includes exact semantic version, protocol, DB schema and readable schema range. The publisher fsyncs each staged file and containing directories, validates all contents against the manifest, then atomically renames a `current` symlink on the same filesystem. Extra files are rejected on verification. No live tree is modified in place; old release and snapshots remain for diagnosis, never automatic rollback.

## Commands

`homes prepare-managed-installation --request FILE --approve-registry SHA256 --artifact FILE --artifact-sha256 SHA256` creates a **new empty installation root**. Existing consumers must be offline. This command provisions files but does not start a service. Review and bootstrap the returned exact launchd plists through the host's normal explicit installation procedure. A durable provisioning claim binds the exact registry and artifact. Repeating this explicit command resumes only that same approved request, validates every existing file, and completes interrupted atomic publications; foreign files or a changed request fail closed. It cannot overwrite an existing unrelated installation.

Create the usual inventory-based `homes plan-upgrade` plan and inspect it. Apply requires *all* of:

```text
homes apply-upgrade --journal DIR --digest PLAN_SHA256 --group GROUP_ID \
  --registry /absolute/private/installation/installation.json --registry-sha256 REGISTRY_SHA256 \
  --artifact /absolute/private/release.json --artifact-sha256 ARTIFACT_SHA256 \
  --approve-plan PLAN_SHA256
```

The plan alone grants no authority. Expired plans, schema downgrades, incompatible schemas, stale generations and incomplete consumers fail before native effects. Apply stages and verifies the target before draining any daemon. It then drains each daemon, bootouts its exact registered launchd service, proves the observed PID has exited, acquires its native home mutex and an exclusive application-database lock, checks Graph holds and unknown delivery attempts, and snapshots state/WAL/SHM without opening for migration. Only after *all* homes are held does it switch the installation. Restart has no fallback kickstart or duplicate retry. Every home must report the exact target build/version/protocol/schema and a new generation.

## Explicit forward recovery

`homes upgrade-status` returns `history_digest`. Reconcile takes the same flags as apply plus `--approve-history HISTORY_SHA256`. That fresh approval binds to the exact durable history and is checked while holding the physical installation mutex. A changed history fails before any service action.

Recovery observes the current release and every service. Already-running exact target consumers are verified and never bootstrapped twice. If still on the previous release, old running consumers must pass the original identity/drain checks; physically absent consumers must allow acquiring the native home mutex and exclusive database lock. Only after those locks and a refused socket connection prove abandonment may the same private socket inode be removed. Recovery verifies or stages the approved target before stopping any consumer, takes fresh snapshots, and only moves forward. Missing service may be bootstrapped; indeterminate launchctl status, a live or unverifiable socket, wrong running build, unresolved Graph/delivery actions or incompatible files stop recovery. A fresh durable reconciliation-start record precedes every recovery sequence. Recovery failures remain explicitly unknown and require a new history approval. Verified target observations append a terminal receipt and release only matching plan/group claims. Snapshots are never copied back.

The native command's deadline aborts launchctl and RPC sockets; unknown physical effects remain fenced. `upgrade-status` reads the journal without running installation or recovery.

## Evidence and limitations

Component tests use actual scratch Node child processes, Unix sockets, SQLite files, native mutexes, release files and atomic symlinks. They cover two-consumer success, response loss after a process really restarts, recovery without a second bootstrap, different-journal contention, changed consumer/artifact pins, traversal, extra module injection, pre-DB startup gates, actual-version/schema mismatch, unresolved delivery quarantine, SIGKILL of coordinator and consumer processes, partial provisioning, terminal cleanup, and close during a pending physical stop. The existing journal/plan/coordinator suites remain required.

These tests do not emulate a successful real launchctl invocation. The supported production driver uses only `/bin/launchctl print`, `bootout`, and `bootstrap` in `gui/<uid>`, exact configured labels and generated plist paths, bounded output and deadlines. Unknown errors are never interpreted as service absence. Real launchd absence-code compatibility, OS shutdown behavior, actual deployed npm artifact/native addon compatibility and physical power cuts require separately authorized host qualification. A same-UID administrator can replace files or execute arbitrary code outside the managed installation; this is not an OS sandbox against that administrator.

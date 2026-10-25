# Inspect explicitly registered local homes

`osstack homes inspect --manifest /absolute/homes.json --json` reads only the listed local Unix sockets. It never discovers homes by walking directories, opens a database, starts a daemon, installs a package or applies an upgrade.

```json
{"schema_version":1,"homes":[{"home_id":"home_0123456789abcdef0123456789abcdef","socket":"/absolute/declared-home/daemon.sock","enabled":true,"desired":{"version":"0.21.0","protocol_version":1}}]}
```

The authorized daemon startup creates `deployment-identity.json` once in its serving home. Obtain and explicitly register that home ID from that controlled deployment. A responding socket is never automatically trusted or pinned. A malformed or symlink identity file disables identity reporting; it is not overwritten. The home ID remains stable across restarts; each daemon instance has a new generation.

The `deployment.identity` RPC reports the serving binary's version, protocol, actual open database schema and startup generation. Build digest and deployment type currently remain explicitly unavailable/unknown because this runtime does not have an independently pinned installation manifest. Add optional `desired.database_schema`, `desired.build_digest` or `desired.deployment_kind` only when those assertions are required; missing observed evidence yields `unknown`, not a match. `matched_requested` applies only to fields requested in the manifest.

Up to 32 entries are accepted, with four socket reads at a time and a three-second deadline per identity RPC read. Responses are capped at 64 KiB before buffering; manifests are regular files capped at 64 KiB. IDs, desired fields and unknown fields are strictly validated. Duplicate IDs and socket paths fail; canonical aliases of the same enabled endpoint also fail. A short socket symlink can be used on macOS, where full scratch paths can exceed the Unix socket pathname limit. Aliases are canonicalized and checked for changes after the read.

This is local same-UID socket/file ownership trust, not remote authentication or peer-credential attestation. A same-UID process that controls the home/socket is already inside that trust boundary. Filesystem metadata calls are local and not preemptible by the network timer; do not register paths on unresponsive network mounts. An unavailable, old, malformed or mismatched endpoint remains in the result as `unreachable`, `unknown` or `identity_mismatch`. One failure does not produce a healthy summary or remove the failed entry from the denominator.

Results are observations, not upgrade authorization. Shared-install consumer discovery, drain coordination, crash-safe multi-home update journals and real multi-home upgrade qualification remain separate work.

`complete` requires at least one enabled endpoint and all enabled endpoints matching the requested fields. It does not assert process health or build provenance. Copying an identity file copies its home ID: this is not clone attestation; an operator must provision a new deployment identity for a copied home before registering it as another instance. Identity publication is create-only and atomic after file sync, followed by directory sync; an interrupted temporary record cannot become the published pin.

Identity provisioning requires a local filesystem supporting hard links and file/directory fsync (for example APFS). Unsupported filesystems report identity unavailable and are not silently downgraded. An abrupt process termination may leave a uniquely named `.deployment-identity-*.tmp`; it is never read as the pin. Only remove such remnants during an explicitly quiescent maintenance operation. Invalid or duplicate manifest input reports a stable error code.

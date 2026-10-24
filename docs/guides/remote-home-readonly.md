# Read a remote home without remote control

This optional command projects a single bounded page of Session and bound-run status from an already running remote OSStack daemon. It does not send messages, start/cancel/resume workers, open a remote database, install a daemon, or register a general RPC relay. Graph, unbound runs, logs and incremental events are not supported.

The deployment operator must provision an SSH account/key with a forced command or equivalent restrictions. That wrapper executes the fixed literal `osstack remote-export --stdio` with `OSSTACK_REMOTE_EXPORT_REGISTRY` and `OSSTACK_REMOTE_EXPORT_SHA256` already set. It must disable forwarding and interactive shell access. The exporter cannot enforce the SSH account's other authorized commands; its read-only channel token grants only one snapshot. No account or remote host is automatically provisioned.

Create an owner-only (`0600`) regular registry at an absolute canonical path on the exporter host. All configured paths must be canonical and cannot be symlinks. Example (replace every placeholder before use):

```json
{
  "version": 1,
  "home_id": "home_0123456789abcdef0123456789abcdef",
  "daemon_protocol": 1,
  "socket": "/absolute/serving-home/daemon.sock",
  "scopes": [{"alias":"project","repo_path":"/absolute/project","default_tenant":true}]
}
```

The home ID and daemon protocol come from the running home's `deployment.identity`, not from repository names or a guessed home path. Compute the SHA-256 of the exact registry file bytes and pin it in the wrapper environment. The exporter verifies that its configured socket is canonical and owned by the same OS user, and that the daemon identifies the pinned home. This local socket trust is not independent peer-credential attestation. Owners who can replace their own binaries/configuration or daemon remain trusted.

On the reader machine, create another `0600` canonical regular registry:

```json
{
  "version":1,
  "homes":[{
    "alias":"dev",
    "host":"example.test",
    "port":22,
    "user":"reader",
    "host_key":"ssh-ed25519 BASE64_PUBLIC_HOST_KEY",
    "identity_file":"/absolute/private/readonly_identity",
    "home_id":"home_0123456789abcdef0123456789abcdef",
    "daemon_protocol":1,
    "registry_sha256":"EXPORTER_REGISTRY_SHA256",
    "scope":"project"
  }]
}
```

The host public key is a full Ed25519 public key, verified independently with the host operator. A key retrieved on the same untrusted connection is not a trustworthy pin. The private identity file must also be an owner-only canonical regular file; it is passed directly to OpenSSH and never printed or read into an application payload. Identity-file and scratch paths cannot contain whitespace, quotes, percent signs or backslashes; this avoids OpenSSH path expansion/tokenization ambiguity. Only DNS names/IPv4-style host strings are accepted in this first version; IPv6 literals and custom SSH options are not supported. SSH must be available at `/usr/bin/ssh`.

Run `osstack remote-home inspect --registry /absolute/client.json --sha256 CLIENT_REGISTRY_SHA256 --alias dev --limit 50`. The reader ignores user SSH config and agents, creates a restrictive temporary known-hosts file containing only the pinned host key, and disables proxying, forwarding and connection multiplexing. The remote command is constant; registry fields are never interpolated into a shell command. Configuration/key changes require explicit digest/key repinning. The home pin and exporter registry digest are independently checked after SSH transport authentication. Registry digests in the observation are public pin-confirmation values, not confidentiality guarantees for easily guessed registry contents.

Output is JSON, at most 64 KiB. `status: observed` means the bound response was received; it does not mean the home is healthy. `snapshot.complete: false` and `has_more: true` mean only the first page was observed. Exit status is nonzero for incomplete or unavailable observations. No continuation cursor is exposed yet. Empty results still describe only this scope's eligible source views. Session and run rows may describe the same worker.

Rows contain metadata and snapshot-local `observation_ref` values. These references are not stable worker IDs or action handles. Scope filtering is enforced by the trusted daemon worker projection; the exporter validates the pinned scope echo and does not independently query database rows. Tests include other tenants and repositories. The output omits private repository paths, local opaque worker IDs/cursors, prompt/log/decision text and provider-native IDs. A source's completed status is an observed stored fact, not proof that a provider process has stopped. `process_liveness` remains unknown.

`received_at_ms` is the reader's local receipt time; `round_trip_ms` uses a local monotonic clock. Remote timestamps and source freshness remain unverified. `remote_clock` merely compares the remote sample time with the local clock; it does not synchronize clocks or establish freshness. Re-read explicitly for a new observation. A timeout, disconnection or binding error returns `status: unknown` and no stale snapshot. It never falls back to the local home or retries an action.

The evidence digest hashes the recursively key-sorted JSON of parsed snapshot fields (excluding the digest itself; array order is preserved), binding nonce, generation, scope, registry and row metadata. It detects accidental/tampered binding within the authenticated channel; it does not independently attest server truth. The channel token is random, connection-local and never printed. It is not a general OSStack credential.

Local isolated child-process tests and a real running local daemon qualify the wire and socket implementation. A real remote host has not been supplied: two-host SSH authentication, account restrictions, network failure behavior and key rotation are **pending qualification**. Every result preserves `qualification: remote_host_pending`. No general remote-action or plugin ecosystem qualification is implied.

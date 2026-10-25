# Remote Graph cancellation with durable receipts

Remote control is disabled without explicit host setup. It uses a separate signed write authorization and a separate `remote-control --stdio` exporter. The read-only `remote-export` protocol and token cannot cancel anything. This implementation controls existing Graph runs; it does not add remote start, arbitrary shell commands, generic daemon RPC or automatic daemon startup.

## Host setup

Use canonical absolute paths. Private home/journal directories must be owned by the current UID and mode0700; configuration, grant, token and key files mode0600, single-link regular files, no symlinks. Ancestors cannot be writable by other users except root-owned sticky temporary directories. Configuration/journal/socket must be outside registered repositories. Store keys outside checked-out code. Same-UID hostile processes that can read an operator private key are outside this authority boundary; use separate OS identities where that separation is required.

The remote host needs an already running OSStack daemon, its private Unix socket and a valid existing `graph-host.json` registration allowing read/cancel for the selected scope. The new signed grant does not override that authorization. Its `graph_scope` must match the existing Graph registration. `repo_path` is the host registration's canonical repository path; it is not accepted from a free-form remote command.

Set the remote account's trusted environment (or a fixed administrator-owned wrapper):

```
OSSTACK_REMOTE_CONTROL_REGISTRY=/absolute/private/remote-control.json
OSSTACK_REMOTE_CONTROL_SHA256=<SHA256 of exact file bytes>
```

No request can supply a socket, daemon executable, endpoint, signer, registry path or alternate command. Do not configure SSH AcceptEnv or a wrapper to accept these values from an untrusted client. The exporter executes only `osstack remote-control --stdio`.

The server JSON schema:

```json
{
  "version": 1,
  "home_id": "home_<32 lowercase hex>",
  "daemon_protocol": 1,
  "socket": "/absolute/private/daemon.sock",
  "journal_dir": "/absolute/private/remote-cancel-journal",
  "scopes": [{
    "alias": "project",
    "repo_path": "/absolute/repository",
    "graph_scope": {"schemaVersion":1,"tenantId":"local","principalId":"owner","workspaceId":"workspace"}
  }],
  "keys": [{
    "key_id": "cancel-operator",
    "public_key_pem": "<Ed25519 SPKI public PEM>",
    "actor_id": "operator",
    "scope_aliases": ["project"],
    "max_validity_ms": 300000
  }]
}
```

Pin the exact server file hash in the client private registry, using the existing remote-home schema (`version:1`, `homes` entries with alias, host, port, user, pinned ssh-ed25519 host_key, identity_file, home_id, daemon_protocol, registry_sha256 and scope). This is the dedicated control registry hash, which will differ from a read-only export registry. SSH uses explicit identity and known-hosts files, strict host-key checking, no agent forwarding, no proxy command or SSH user configuration. No host key is accepted automatically. See [OpenSSH configuration documentation](https://man.openbsd.org/ssh_config).

On the operator host, create `$OSSTACK_HOME/remote-cancel-issuer.json` with the schema below, and matching private `$OSSTACK_HOME/issuer-cancel-operator.pem`:

```json
{
  "version":1,"enabled":true,"actor_id":"operator","key_id":"cancel-operator",
  "public_key_pem":"<same Ed25519 SPKI public PEM>","max_validity_ms":300000,
  "targets":[{
    "name":"dev","home_id":"home_<32 lowercase hex>",
    "server_registry_sha256":"<64 lowercase hex>","scope_alias":"project",
    "repo_path":"/absolute/repository",
    "graph_scope":{"schemaVersion":1,"tenantId":"local","principalId":"owner","workspaceId":"workspace"}
  }]
}
```

An operator obtains the current daemon generation, Graph run ID/generation/revision through authorized host observation. The CLI does not infer an approval from model text or from a repository file. Issue a single exact grant:

```
osstack remote-home issue-cancel-grant --target dev --daemon-generation instance_<32hex> --graph-run <run> --graph-generation <generation> --revision <revision> --output /absolute/private/grant.json
```

The issuer requires local interactive stdin/stderr and displays the complete cancellation subject, key, one-call ceiling, nonce and expiration. Type the entire `APPROVE <preview SHA256>` phrase. There is no `--yes`, environment bypass or RPC signer. The issuer rechecks config after approval and before signing; changed config, expired approval, wrong private key or existing output file refuses issuance. Creating a grant does not send it.

```
osstack remote-home cancel --registry /absolute/private/client.json --sha256 <client hash> --alias dev --grant /absolute/private/grant.json
osstack remote-home query  --registry /absolute/private/client.json --sha256 <client hash> --alias dev --grant /absolute/private/grant.json
```

## Exact state transitions and recovery

The Ed25519 domain `osstack.remote-graph-cancel.v1` binds actor, remote home, daemon generation, server registry hash, Graph scope/run/generation/revision, action, grant ID, request UUID, nonce and validity (maximum5minutes). The exporter rechecks current registry before reserving and invoking; revocation or wrong generation fails closed. Identity, status and cancellation use one persistent existing daemon socket. Existing Graph expected-revision CAS also fences changes between status and cancellation.

The client writes and fsyncs `<home>/remote-actions/<request>.local.json` before starting SSH. Once that file exists, another `cancel` with the same request becomes a read-only `query`; changed content or endpoint under that request ID is refused. It does not re-send even when a timeout happened before reaching the remote server. A truly absent remote request therefore remains `not_found`; a fresh, explicitly approved grant/request is required if an operator decides to try again.

The remote server creates and fsyncs `<request>.started.json` before a single Graph cancel call, then creates/fsyncs `<request>.result.json` before acknowledging. Files are create-only with O_EXCL/O_NOFOLLOW, bounded32768bytes, at most2048directory entries; the parent directory is fsynced too. See [Node file synchronization/open semantics](https://nodejs.org/docs/latest-v22.x/api/fs.html). Do not remove unresolved journal entries to force a retry. Storage exhaustion or invalid private permissions refuses work. Power-loss durability on each deployment filesystem remains a live qualification.

| Boundary | Result of repeat/query | New cancel call? |
|---|---|---|
| Client intent exists, remote never saw it | `not_found` | No |
| Remote reserve exists, no durable result after crash | `delivery_unknown` | No |
| Graph reply lost after invocation | `delivery_unknown` | No |
| Remote result persisted, SSH acknowledgement lost | Exact persisted receipt | No |
| Same request ID with changed grant | Refused | No |
| Valid historical signature after expiry | Receipt query allowed | No |
| Registry/key revoked or hash changed | Refused; old evidence preserved | No |

`stop_requested` means the existing Graph handler acknowledged cancellation. Every response carries `physical_stop: not_attested`, including a locally observed Graph terminal state. Actual worker-stop proof and resource-hold release remain the Graph runtime's responsibility. A receipt never releases locks or claims a remote process stopped. Query does not contact the daemon and can recover persisted evidence while it is down. Query still requires the current pinned registry/key; revoking that trust intentionally removes query access as well. Preserve and inspect historical journals through authorized local operations if that occurs.

The stdio protocol is length-framed, bounded to64KiB and two messages each direction; the internal fixed-method daemon connection permits at most8frames. Client and exporter have a10second overall exchange deadline, plus bounded per-frame reads/writes. New control schemas reject unknown fields and never accept arbitrary URLs or commands. The code does not implement remote physical-stop attestation, cross-host restart orchestration or clock synchronization.

## Qualification

Local tests use real child processes, framed stdio, a real Unix socket, persistent files, process kill, corrupt receipts and exact grant signatures. An integration bridge invokes the actual GraphRpcService and observes its worker abort/terminal proof while the remote receipt still says not_attested. Existing read-only remote tests are rerun to ensure its token is never widened. This is not real-SSH qualification.

Still pending on a configured real host: pinned host-key login, restricted account environment, authorized socket peer/Graph registration, actual production adapter stop and retained holds, power loss/disk durability, clock skew, SSH disconnect/reconnect and host restart. No real SSH connection, host registration, private key provisioning or remote cancellation was performed during development. Until those checks are completed, output retains `qualification: remote_host_pending`.

# GitHub follow-up delivery: operator setup and recovery

This adapter posts a general issue/PR conversation comment on github.com. It does not merge a PR, deploy, resolve the independent local obligation, send a review-thread reply, or act as a general outbound HTTP client. No real public message was sent during this implementation's tests.

The host must explicitly provision authority. A repository document, task request, RPC caller, `--approved` flag or generated grant cannot install a trusted key. The daemon reads only its fixed `OSSTACK_HOME/follow-up-delivery.json`; absence/invalid configuration leaves delivery disabled. Code supports a real GitHub transport, but this project's test evidence is local fixture evidence, not a production qualification.

## Private host configuration

Use a dedicated canonical OSStack home outside every managed repository. The home directory must be owned by the current uid and mode `0700`; its registry, token and issuer key files must be regular single-link files owned by that uid and mode `0600`. Symlinks and noncanonical parent paths are rejected. Ancestors must be owned by root/current uid and not group/world writable, except root-owned sticky temporary roots; this also prevents an untrusted parent directory from replacing the home. The directory and credentials are local operator configuration, never committed into a repository.

Install a fine-grained personal access token or GitHub App **user** token supporting `GET /user`, issue read and issue-comment write for the exact repository. Installation tokens are not supported in this first transport, because they do not provide the required authenticated-user identity endpoint. Do not print the token in shell history. Store it in `github-token` using your existing credential provisioning procedure. No credential is discovered from the environment, `gh`, a URL, repository configuration, or a request body.

Provision an Ed25519 keypair using the operator's existing key-management procedure. The public SPKI PEM goes in the registry; the matching private PKCS8 PEM goes in `issuer-operator.pem`. The daemon reads public keys only; the local issuer reads the private key after approval. This is a same-uid local trust boundary, not protection against a malicious process that can already read that uid's private files or control its terminal. Stronger principal separation should run the issuer in a separate operator account/process and import its signed grants through the existing authorize command.

Example registry shape (replace every example value; this is not an enrollment command):

```json
{
  "schema_version": 1,
  "enabled": true,
  "qualification": "sandbox_qualified",
  "qualification_note": "Operator qualification record identifier and exact environment/date",
  "targets": [{
    "destination_ref": "release-thread",
    "repo_path": "/absolute/canonical/repository",
    "provider_id": "github_comment",
    "account_id": "operator-account",
    "host": "github.com",
    "owner": "organization",
    "repository": "repository",
    "issue_number": 123,
    "target_node_id": "actual issue node_id",
    "actor_node_id": "actual authenticated user node_id"
  }],
  "accounts": [{ "account_id": "operator-account", "token_file": "github-token" }],
  "keys": [{
    "key_id": "operator",
    "public_key_pem": "-----BEGIN PUBLIC KEY-----\nactual public SPKI key\n-----END PUBLIC KEY-----\n",
    "repo_path": "/absolute/canonical/repository",
    "destination_refs": ["release-thread"],
    "max_validity_ms": 60000
  }]
}
```

Capture the target `node_id` using the exact issue endpoint and the actor `node_id` from the authenticated user endpoint. The adapter checks both again before any POST. Qualification is a host attestation field; changing it is not a test or proof. Keep `sandbox_qualified` until a separately recorded live qualification supports `production_qualified`. The CLI reports a sandbox delivery with exit code 1 even when a provider receipt was found, preserving the existing production-only success convention.

Restart the daemon after provisioning or intentionally replacing configuration. A bounded synchronous registry fingerprint fence runs inside the authorize/dispatch transaction before a grant is persisted or consumed. Each send/lookup also re-reads and compares the registry to its startup fingerprint. Editing or removing it prevents further calls from an already running adapter. This fence may conservatively leave an already started attempt unknown. In-flight HTTP effects cannot be retracted by editing a file; use reconciliation. Token contents are read privately for each operation and compared again before the single POST.

## Review, grant, authorize, dispatch

Use an explicit per-workspace `OSSTACK_HOME` for development. `follow-up create` establishes a separate local obligation. `follow-up-delivery prepare` freezes a public draft against that obligation/revision and a registered destination reference. Inspect the prepared attempt before authorization.

The operator then runs:

```text
osstack follow-up-delivery issue-grant ATTEMPT_ID --repo /absolute/canonical/repository --default-tenant --revision 1 --key operator --output /private/operator-directory/grant.json
```

The local command requires interactive stdin/stderr. It shows JSON containing the exact public wire body, target, author, account, repository, attempt, revision, key and validity. The wire body adds an HTML correlation marker containing the attempt ID and envelope digest; this marker is included in the preview. Type the displayed `APPROVE <entire-preview-sha256>` phrase. There is no unattended `--yes`, approval RPC, or server-side private-key signer. The handler re-inspects the attempt and registry after confirmation, independently recomputes body/target/envelope digests and subject binding, then writes a **new** grant file with exclusive creation, private mode and file/directory fsync. It does not authorize or send.

```text
osstack follow-up-delivery authorize ATTEMPT_ID --repo /absolute/canonical/repository --default-tenant --revision 1 --grant /private/operator-directory/grant.json
osstack follow-up-delivery dispatch ATTEMPT_ID --repo /absolute/canonical/repository --default-tenant --revision AUTHORIZED_REVISION
```

Use the revisions returned by each command. The existing service verifies the host-trusted signature and expiry, atomically consumes a one-call grant and records durable `started`, performs a bounded read-only actor/target preflight before consumption, rechecks the grant/revision at consumption, then invokes exactly one POST. An initial readiness failure or timeout leaves the prepared grant active because no send boundary was entered. A failure racing after durable `started` remains conservative unknown. The HTTP adapter has no redirect following, automatic retry, shell execution or SDK retry layer. It uses fixed github.com API paths and verifies successful response status, request ID, comment ID, exact body, issue URL and author node ID. An error response body is never surfaced with credentials.

## Unknown means reconcile, not resend

A timeout, truncated body, disconnected response, failed identity check, ambiguous write outcome or process crash after durable admission does not prove non-delivery. The attempt stays `delivery_unknown`/`started`, cannot dispatch again, and blocks a new attempt for the same obligation. Reconstructing the service preserves this behavior in SQLite. Run `inspect`, then `reconcile` with its current revision:

```text
osstack follow-up-delivery reconcile ATTEMPT_ID --repo /absolute/canonical/repository --default-tenant --revision CURRENT_REVISION
```

Reconciliation uses only GETs. It checks authenticated actor and target again, uses the trusted attempt creation time minus a five-minute clock-skew margin as GitHub `since`, then reads at most twenty pages of at most ten comments, and rejects incomplete enumeration, duplicate actor-owned correlation or altered actor-owned content. Foreign authors/targets are ignored before matching, so a third party copying a public marker cannot veto a genuine receipt. No match is unknown; it is never evidence that resending is safe. Historical large threads are filtered by `since`; a recent flood, edits to old comments, or clock skew beyond the margin may still need an operator's external evidence investigation because the bounded adapter intentionally does not enumerate indefinitely. `revoke` records cancellation but cannot recall an already posted message. Public delivery and the local promise's resolution remain independent.

Each response is at most 4 MiB; stream reads are bounded, service calls have an abort deadline, redirects are rejected and provider-controlled pagination URLs are ignored. An HTTP fixture endpoint is accepted only through the trusted test constructor under `test_only`, never through host JSON or RPC.

## Local evidence and live qualification still required

Local tests cover real HTTP send/lookup, receipt loss after a stored provider-side comment, durable unknown and reconstruction, no second POST, exact body/author/target, malformed/oversized/timeout/redirect responses, duplicate correlation, bounded pagination, registry revocation, private file restrictions, actual handler-to-service authorization, changed preview/attempt/registry, forged subjects, wrong keys and exclusive output creation. Existing journal tests also exercise SQLite/SIGKILL, concurrency and late responses.

Still required in a separately authorized test repository: live GitHub permission and account/issue node identity checks, actual raw-body/correlation preservation, real rate-limit/timeout behavior, lookup after a live interrupted response, and operator-controlled production qualification. No production token, issuer or host configuration was created in this development task. OS power-loss durability and hostile same-uid key isolation are not established by local fixtures.

Sources checked on 2026-10-24: [GitHub issue-comment REST API](https://docs.github.com/en/rest/issues/comments) documents general PR/issue comments, raw bodies, create/list shapes and pagination; [authenticated user REST API](https://docs.github.com/en/rest/users/users#get-the-authenticated-user) documents identity and supported user-token types. The transport pins API version `2026-03-10`.

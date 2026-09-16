# Graph delegation v1

OSStack executes the fixed `code-delivery-v1` engineering graph. It produces a frozen candidate and independent review/test evidence. A `ready` result does not merge, push, deploy, or complete another product's task state.

## CLI

```sh
# Use a dedicated development home; never point a checkout at the serving database.
export OSSTACK_HOME=/absolute/workspace-specific/osstack-home
osstack graph validate --spec spec.json --json
osstack graph run --request start.json --json
osstack graph status --run GRAPH_RUN_ID --scope scope.json --json
osstack graph result --run GRAPH_RUN_ID --scope scope.json --json
osstack graph cancel --request cancel.json --json
osstack graph resume --request resume.json --json
```

`validate` performs pure compilation and budget feasibility checks. It neither connects to the daemon nor opens the control-plane database. Successful validation does not grant execution permission. `explain` retains its separate read-only task/Loop/card relationship interface (`osstack graph explain --help`).

Files must be regular UTF-8 JSON files, at most 64 KiB, conforming to the strict v1 schemas. Duplicate/unknown flags are rejected. All execution commands use the daemon; none creates a second local execution engine. `--json` emits one structured object. Exit 0 means the request was acknowledged, not that the run has finished. Exit 1 means rejection or invalid input. Exit 2 means the mutation response was lost and its delivery is unknown.

## Submit, lookup, cancel and resume

`graph.start` and `graph.submit` accept `StartGraphRequest`. `graph.status` and `graph.result` accept `GraphStatusRequest`; both return the same authoritative `GraphDelegationStatus` projection. `graph.cancel` and `graph.resume` accept their corresponding versioned request schemas. The CLI `run` command calls `graph.start`.

```json
{
  "schemaVersion": 1,
  "kind": "start",
  "scope": { "schemaVersion": 1, "tenantId": "local", "principalId": "owner", "workspaceId": "project" },
  "idempotencyKey": "delivery-001",
  "inputArtifactRef": "task-input-001",
  "source": { "product": "osstack", "requestId": "request-001" },
  "spec": {
    "schemaVersion": 1,
    "template": "code-delivery-v1",
    "input": { "taskRef": "task-001", "repositoryRef": "project", "baseRevision": "0000000000000000000000000000000000000000", "acceptanceRef": "unit-tests" },
    "limits": { "maxEpochs": 2, "maxBranchAttempts": 1, "maxConcurrentReaders": 2, "maxConcurrentWritersPerRepo": 1, "maxActionStarts": 14, "deadlineSeconds": 3600, "tokenReservationLimit": 98304 },
    "publication": "artifact_only"
  }
}
```

Replace the example base revision with an actual commit in the registered repository. References resolve only through the host registry. They are not paths, shell commands, adapters or grants supplied by the caller.

The complete scope and idempotency key bind the original business input. Repeating an identical request returns the existing run. Reusing a key with different business input returns `IDEMPOTENCY_CONFLICT`. Metadata such as trace/request time is excluded from the business digest. Source product, source request ID and optional `parentRunId` remain part of that digest and are preserved in status.

A lost response yields `GraphDeliveryUnknown`: the original scope, idempotency key and mutation input digest, optional run ID, and `nextAction: retry_same_request`. Retry the exact request. Do not invent a new key to work around a timeout. A retry after daemon restart consults durable state; it must not create another writer. A crashed execution without independently proven stop remains subject to reconciliation.

Cancel requests include `graphRunId`, the latest `expectedRevision`, and a distinct idempotency key. `cancel_pending` records an intent; `cancelled` requires confirmed worker and executor quiescence. `cancel_pending` and `reconciliation_required` expose `delivery_unknown`. A promise completion, expired lease, or model statement does not prove a physical stop. Graceful daemon shutdown also waits for remaining local database users (including late persistence/release). A bounded cancellation response does not permit closing SQLite underneath them; genuinely stuck local I/O can delay graceful shutdown and requires operator recovery.

Resume requests include the exact interrupt ID and latest revision. The v1 quality-resume data is `{ "kind": "data", "value": { "inputDigest": "ORIGINAL_RUN_INPUT_DIGEST" } }`. The host checks the original scope, current grant, saved checkpoint/join evidence and supervisor stop observations before G15 takeover. Boolean input or text saying `approved` is never authorization. A live supervisor may resume an observed, safely stopped quality interrupt; loss of that supervisor requires independent recovery evidence. General unobserved process-crash recovery is tracked separately in G25.

## Result interpretation

Status includes run ID, original source/scope, input/spec digests, revision, generation, stage, candidate and evidence references when available, and ledger-derived budget usage. Reserved and charged token totals are decimal strings to retain exact integer accounting. Resume retains the original creation time, deadline and consumed budget.

`ready` requires a frozen candidate, immutable quality evidence and a result reference, with `delivery: available`. Other active/terminal states do not authorize delivery. A frozen candidate alone is not a passing result. References are verified by the serving host; clients should resolve them through the same trusted OSStack deployment and must not fetch arbitrary model-provided URLs as evidence.

## Local host registration

Before starting `osstack serve`, create `$OSSTACK_HOME/graph-host.json` with mode `0600`, owned by the serving user. The server also checks its Unix socket is owner-only. A development checkout must use an explicit isolated home. The registration below is an example; choose installed, authenticated agents with the required capabilities and independent reviewer identity. No live provider run is implied by this example.

```json
{
  "schemaVersion": 1,
  "registration": {
    "id": "project-owner",
    "scope": { "schemaVersion": 1, "tenantId": "local", "principalId": "owner", "workspaceId": "project" },
    "repositoryRef": "project",
    "repositoryPath": "/absolute/canonical/project",
    "taskRef": "task-001",
    "task": "Implement the approved task and satisfy the registered acceptance tests.",
    "inputArtifactRef": "task-input-001",
    "writer": { "agentId": "claude-code", "capabilityId": "claude-code.code.write" },
    "reviewer": { "agentId": "codex-cli", "capabilityId": "codex-cli.code.review" },
    "acceptanceRegistry": [{ "ref": "unit-tests", "command": "pnpm test", "passExitCodes": [0], "failExitCodes": [1] }],
    "grant": {
      "scope": { "schemaVersion": 1, "tenantId": "local", "principalId": "owner", "workspaceId": "project" },
      "expiresAt": 1,
      "operations": ["read", "execute", "cancel", "resume"]
    }
  }
}
```

`expiresAt` is Unix time in milliseconds. The example intentionally uses an expired timestamp; the owner sets an appropriate future deadline when authorizing execution. The registered source repository remains the policy authority after cloning, and daemon health checks still apply. A candidate clone cannot replace the current source policy; its own restrictions may only add checks. The daemon resolves commands only from this configuration. A caller cannot replace these bindings through a request.

The owner may renew the grant's deadline and allowed operations while retaining the original scope and immutable registration. Changing the repository, task, command registry or adapter binding invalidates an existing registration. Execute/resume expiry does not remove separately retained read/cancel permissions. Status reports `needs_authorization` in the original scope when execute permission is unavailable. Editing an input field or returning `approved` from a model never changes the grant.

The current CLI host pauses at a negative quality join that needs another repair epoch. Resume requires the same live supervisor and an unexpired worker lease (currently bounded to five minutes at the quality boundary) as well as the original overall deadline. Expired leases are refused before acknowledgement; this version does not silently refresh them or adopt another owner. Longer human approval waits and reconstruction after daemon loss require the recovery work in G25. Positive quality joins finish without an extra resume.

## Trust boundary and external callers

The local server uses an explicit host registration and owner-controlled grant configuration. The Unix socket and host configuration are local owner capabilities. Merely claiming a `principalId`, scope or `source.product` in JSON does not authenticate a caller.

OStag and OSBot integration tests use simulated callers registered by a trusted host resolver. They verify source isolation, duplicate submissions, parent references and results. This is not production OSBot/OStag authentication, a public HTTP API, a Rakazo connector, or a new product UI. Unsupported remote identities fail closed. A future connector must authenticate the transport and bind it to its registration before invoking this service.

The v1 Zod definitions in `packages/protocol/src/graph.ts` and generated `packages/protocol/schemas/graph.schema.json` are the machine-readable source of truth.

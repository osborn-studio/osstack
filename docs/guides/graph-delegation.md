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
osstack graph reconcile --request cancel.json --json
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

`graph reconcile` calls `graph.reconcile` using the same strict `CancelGraphRequest` as `graph cancel`, under the current **cancel** grant. It records cancellation intent and asks the host to verify cancellation, not to restart execution or accept a client-supplied outcome. A live supervisor receives cancellation through the existing signal chain. A fresh host can additionally confirm cancellation when **every historical worker generation has a durable no-child observation and the entire run has no admitted actions, admissions or checkpoint scheduling evidence**. This bounded path uses G15's independent checks and final transaction; it remains available with new admission disabled or adapters unsupported, and after the execution deadline expires.

Example cancellation/reconciliation input:

```json
{
  "schemaVersion": 1,
  "kind": "cancel",
  "scope": { "schemaVersion": 1, "tenantId": "local", "principalId": "owner", "workspaceId": "project" },
  "graphRunId": "GRAPH_RUN_ID",
  "expectedRevision": 7,
  "idempotencyKey": "cancel-001"
}
```

Obtain the current revision from status. Proof references, process IDs, paths, arbitrary outcomes and takeover owners are not accepted in this request. For a lost response, repeat the exact request to `reconcile`. Reusing the original cancel request can continue reconciliation while its cancellation intent is still the next unchanged revision. After other state changes, the old key only returns current status; inspect it and submit a new cancellation key with the current revision for another reconciliation attempt. This prevents an old request from operating on a later owner/generation. Confirmed cancellation replay returns the terminal state without another recovery decision.

Exit 0 acknowledges the request. Inspect `status`: `cancel_pending` with `delivery_unknown` means the host still cannot prove stop, not success. Missing journals, an unobserved generation, checkpoint evidence or opaque external effects keep the run pending and retain holds. General effect outcome reconciliation, workspace quiescence and recovery of already-launched orphan workers remain unsupported by this public path. It never infers stop from an expired lease or a missing process, and never creates a replacement writer. Graceful shutdown drains these asynchronous reconciliation requests before SQLite closes.

Once cancellation intent is durable, a concurrent state change or failed proof check returns the current state rather than claiming that the intent was rejected. Grant failure still refuses further reconciliation; an earlier intent may already be recorded. A successful G15 commit checks its grant inside the final transaction, so expiry strictly after that commit does not invalidate the completed cancellation acknowledgement.

Resume requests include the exact interrupt ID and latest revision. The v1 quality-resume data is `{ "kind": "data", "value": { "inputDigest": "ORIGINAL_RUN_INPUT_DIGEST" } }`. The host checks the original scope, current grant, saved checkpoint/join evidence and supervisor stop observations before G15 takeover. Boolean input or text saying `approved` is never authorization. A live supervisor may resume an observed, safely stopped quality interrupt; loss of that supervisor requires independent recovery evidence. General unobserved process-crash recovery is tracked separately in G25.

## Result interpretation

Status includes run ID, original source/scope, input/spec digests, revision, generation, stage, candidate and evidence references when available, and ledger-derived budget usage. Reserved and charged token totals are decimal strings to retain exact integer accounting. Resume retains the original creation time, deadline and consumed budget.

`ready` requires a frozen candidate, immutable quality evidence and a result reference, with `delivery: available`. Other active/terminal states do not authorize delivery. A frozen candidate alone is not a passing result. References are verified by the serving host; clients should resolve them through the same trusted OSStack deployment and must not fetch arbitrary model-provided URLs as evidence.

## Local host registration

Before starting `osstack serve`, create `$OSSTACK_HOME/graph-host.json` with mode `0600`, owned by the serving user. The server also checks its Unix socket is owner-only. A development checkout must use an explicit isolated home. The registration below is an example; choose installed, authenticated agents with the required capabilities and independent reviewer identity. No live provider run is implied by this example.

Both writer and reviewer must implement `AgentAdapter.confirmStopped`. The current builtin Claude Code, Codex CLI and Kimi Code adapters do not implement this contract: new graph runs using them return `EXECUTOR_UNSUPPORTED` before reservation or invocation. The example agent IDs below illustrate configuration only, and do not constitute a runnable provider pairing. Existing Loop/session uses of these agents are unaffected. A callback's presence only permits admission; every actual invocation must still provide trusted stop evidence. A terminal model event alone is insufficient.

```json
{
  "schemaVersion": 1,
  "admissionEnabled": false,
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

Set top-level `admissionEnabled` to `false` to reject new reservations with `GRAPH_ADMISSION_DISABLED`. The owner-only file is reread at admission; changing this boolean does not require a daemon restart or alter the registered bindings. Omission preserves the earlier enabled default. The example starts disabled. Write configuration updates atomically, retaining mode `0600` and ownership.

The cutoff is durable reservation: already admitted queued/running work continues, and live quality resume remains available under its existing grant. To stop that work, use `graph cancel`. Reads, results, cancellation, bounded cancellation reconciliation and exact start-request replay remain available under their required grants while admission is disabled, including from a fresh host whose adapters no longer support new graphs. Conflicting replay input is still rejected. This switch does not release unknown effects; `graph reconcile` has the proof limits described above. The CLI returns exit 1 and `nextAction: stop` for either admission error; retrying with a new key does not fix the host configuration.

The current CLI host pauses at a negative quality join that needs another repair epoch. Resume requires the same live supervisor and an unexpired worker lease (currently bounded to five minutes at the quality boundary) as well as the original overall deadline. Expired leases are refused before acknowledgement; this version does not silently refresh them or adopt another owner. Longer human approval waits and reconstruction after daemon loss require the recovery work in G25. Positive quality joins finish without an extra resume.

## Bounded Messages writer/reviewer (G25-B1)

An opt-in backend now implements the stop contract for a deliberately small effect scope: a single direct request to the selected Anthropic or DeepSeek API with no tools, followed by at most one synchronous atomic replacement of a registered existing file. It does not wrap Claude Code, launch subprocesses, execute model-generated commands or provide a general OS sandbox. A fresh reviewer invocation sees only the registered candidate files, its review task and the same concrete acceptance criteria; writer conversation history is not reused.

In the owner registration above, replace the two role entries and add:

```json
{
  "writer": { "agentId": "anthropic-bounded-writer", "capabilityId": "anthropic-bounded-writer.writer" },
  "reviewer": { "agentId": "anthropic-bounded-reviewer", "capabilityId": "anthropic-bounded-reviewer.reviewer" },
  "boundedMessages": {
    "model": "EXACT_PROVIDER_MODEL_ID",
    "files": ["answer"],
    "acceptance": "The answer file must contain 1 followed by one newline."
  }
}
```

This fragment belongs **inside `registration`**, not in an RPC request. Set the surrounding registered task, acceptance command and spec to the same business goal. The daemon process must receive `ANTHROPIC_API_KEY` through its environment. Do not put credentials in JSON or source control. Existing Claude CLI subscription login is not consumed by this backend. Use an exact API model ID whose returned identity matches and which supports the writer's 32768 maximum output tokens; a CLI model alias is not sufficient. The new role IDs are enrolled only for this graph registration, not the default agent router. Programmatic hosts can use the lazy `createBoundedMessagesAdapter` factory from `@osstack/agents` under their existing Graph authority and exclusive workspace lease.

The first writer scope is 1–16 explicitly named existing UTF-8 files, each at most **4096 bytes**, with **one file replacement per invocation**, at most 4096 output bytes. No new/deleted files, dotfile paths, symlinks, hardlinks, binary files, path traversal or recursive file discovery. The model must return an exact registered path and before-content SHA-256. Before replacement, the host rechecks live execution authority, cancellation, canonical path, content, inode, device and mode; it writes a temporary file, fsyncs it, preserves permissions, atomically renames it and fsyncs the directory. The candidate workspace is exclusively leased and assumes no hostile same-UID process changing its directory tree. The reviewer supports up to 64 KiB per file/256 KiB total, but the paired writer imposes the smaller bound. Review JSON is capped at 8192 serialized UTF-8 bytes.

Stop evidence is specific to this profile: no request dispatched, a complete documented request-rejection response, or a complete matching text-only provider message followed by settled local file operations. Receipt digests bind run ID, workspace, request and response. The trusted provider response attests this one inference completed; this is not proof about arbitrary CLI children or remote tools. 5xx errors, network disconnects, timeouts, mismatched identities, tool activity and truncated/untrusted envelopes remain unconfirmed. Cancel during inference aborts HTTP and forbids a later write, but does not infer that remote inference stopped. Such runs retain admission and require independent recovery; the public no-child reconcile branch cannot resolve them.

Receipts are in-memory and never recycled. Duplicate invocation IDs are refused; after 4096 invocations the adapter refuses more until its host is restarted. Restart does not recreate proof for earlier unknown runs. The original Anthropic path remains fixture-verified. **The DeepSeek variant has now passed a live API pilot through the actual built daemon and Graph runtime**, including independent negative review and cancellation with an unknown inference hold retained. This bounded pilot does not complete the full G25 fault matrix or G29 internal rollout. See [live DeepSeek validation](../reports/graph-deepseek-live-validation.md) and [original fixture validation](../reports/graph-bounded-messages-validation.md).

Provider contracts: [Messages API](https://platform.claude.com/docs/en/api/messages/create), [stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons), and [error status/type pairs](https://platform.claude.com/docs/en/api/errors). Supporting this narrow boundary does not change the unsupported status of existing generic CLI adapters.

## DeepSeek configuration and live pilot

The same bounded file and lifecycle rules apply to DeepSeek. Inside the owner-controlled `registration`, select:

```json
{
  "writer": { "agentId": "deepseek-bounded-writer", "capabilityId": "deepseek-bounded-writer.writer" },
  "reviewer": { "agentId": "deepseek-bounded-reviewer", "capabilityId": "deepseek-bounded-reviewer.reviewer" },
  "boundedMessages": {
    "provider": "deepseek",
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-v4-pro",
    "files": ["answer.mjs"],
    "acceptance": "State the concrete acceptance criteria for these files."
  }
}
```

The daemon needs `DEEPSEEK_API_KEY`, independently of Anthropic credentials. `provider` defaults to `anthropic` for compatibility. The DeepSeek `baseUrl` defaults to the official origin; `/v1` or an explicitly trusted proxy prefix may be configured. No credential-bearing URL, query (including bare `?`), fragment (including bare `#`) or non-HTTPS remote endpoint is accepted. HTTP is permitted only for explicit localhost/127.0.0.1/IPv6-loopback endpoints. Redirects remain disabled. Changing provider/base URL invalidates the live owner binding. These are host settings, never RPC input.

`DEEPSEEK_BASE_URL` is a convenience for the live-pilot script, which copies it into the generated owner config. The daemon uses `boundedMessages.baseUrl`; it does not silently retarget an existing registration from a changed environment variable. A custom endpoint must implement ordinary no-tools Chat Completions semantics. An agent gateway that launches its own tools or background tasks is outside this stop guarantee.

The adapter requests non-streaming JSON with thinking disabled and no tools. It accepts exactly one choice, index 0, matching model identity and valid usage; nonempty tool/function calls or unknown finish reasons cannot prove stop. Known interrupted/truncated/filtered finishes produce stopped failure with observed token usage. DeepSeek cache and reasoning usage are already part of prompt/completion totals and are not added again. Documented request-rejection statuses with a structured error body can prove rejection; 5xx/transport failures stay unknown. Contracts were checked against [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) and [error codes](https://api-docs.deepseek.com/quick_start/error_codes/).

After building, the explicit live pilot can be run with a fresh isolated home and credentials already injected into its environment:

```sh
OSSTACK_HOME=/absolute/private/pilot-home \
  node scripts/verify-bounded-deepseek.mjs /absolute/private/pilot-report.json deepseek-v4-pro
```

The report parent directory must exist. This is a paid, opt-in API run, not part of ordinary tests. It creates a fresh toy repository and daemon home, calls real health checks, submits Graph work through the public socket, and checks every confirmed ledger node and join. The acceptance command validates a closed source form rather than executing arbitrary model output. It separately asks a real reviewer to reject the original bug, then cancels another admitted writer and checks its exact admission hold if the inference outcome is unknown. No merge, push or deploy is performed. Retained unknown evidence stays in the isolated pilot home for inspection. The script must receive no secrets in its command-line arguments.

## Recovery after a stopped bounded writer loses its ledger acknowledgement

`graph reconcile` now also supports a narrow admitted-action recovery path: generation 1 / epoch 0 of the v4 delivery program, exactly the confirmed workspace action followed by one completed bounded writer. The host must have durably recorded both the stopped inference/output receipt and the worker's actual exit before the original host exits. A fresh host verifies those records, the original canonical writer-lock token, current cancellation permission, and an independent fingerprint of the preserved candidate, then uses G15 to settle the original action and finish cancellation. It never invokes the model again or advances the graph to ready.

Adapter stop receipts remain in-memory; the new `bounded-recovery/<effectKey>.json` is a separate host-owned persistent attestation published from a verified completed invocation before ledger confirmation. It cannot reconstruct proof for an earlier unknown HTTP request. Recovery coverage requires a private detached clone with at most 32 MiB / 10000 raw filesystem entries, including Git metadata and ignored/untracked files, and no symlinks, shared hardlinks or special files. Only host writer-lock metadata is excluded from the fingerprint. Unsupported workspace shapes do not gain this recovery coverage.

A live/suspended original host, missing worker-exit journal, changed workspace, invalid program version, missing/corrupt receipt, or revoked grant keeps the action held. A different current lock token is never unlinked. After a lost release acknowledgement, an absent original lock can be acknowledged only following verification of the durable decision and stopped producer. If partial reconciliation advanced the run revision, obtain a fresh status and explicitly retry with its revision and a new idempotency key; an old request only returns current status.

The candidate remains in the private writer directory after cancellation; it is not a published or approved artifact. Earlier unknown remote inference remains unresolved. See [recovery validation and boundaries](../reports/graph-bounded-recovery-validation.md).

## Trust boundary and external callers

The local server uses an explicit host registration and owner-controlled grant configuration. The Unix socket and host configuration are local owner capabilities. Merely claiming a `principalId`, scope or `source.product` in JSON does not authenticate a caller.

OStag and OSBot integration tests use simulated callers registered by a trusted host resolver. They verify source isolation, duplicate submissions, parent references and results. This is not production OSBot/OStag authentication, a public HTTP API, a Rakazo connector, or a new product UI. Unsupported remote identities fail closed. A future connector must authenticate the transport and bind it to its registration before invoking this service.

The v1 Zod definitions in `packages/protocol/src/graph.ts` and generated `packages/protocol/schemas/graph.schema.json` are the machine-readable source of truth.

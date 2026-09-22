# Graph invocation evidence ledger — P04a

Status: experimental storage foundation; no provider, executor registration, host apply, or CLI activation. P04b apply authority and P05–P09 remain required. Baseline d32e175; migration 38 is additive. Historical compiler v4 and its generated source remain unchanged.

## Decision and authority

GraphActionStore remains the sole authority for effect identity, logicalAttempt, token reservations, usage settlement and retry budgets. The two new immutable SQLite tables store request and response bindings keyed by the existing effectKey. They contain no second budget, attempt counter, provider credentials, prompt or file contents.

`beginInvocation(fence, effectKey, executionRef, request)` uses the existing synchronous BEGIN IMMEDIATE transaction. It validates scope, program identity, owner, revision, generation and live worker lease; checks the original action epoch, status, original deadline and budget blocks; requires a matching unreleased host admission; then inserts request evidence and moves the existing action intent to running atomically. Exactly one caller receives changed=true. Only that successful return permits a host to send the prepared request. Changed=false, exceptions, lost ACK, missing response, expired lease and failed evidence reads never permit sending. Automatic HTTP retries must be disabled by the future adapter. This is at-most-once dispatch eligibility, not provider exactly-once execution.

The broker already acquires actual host resources, asserts its lease, records admission, then calls its beforeEffect gate. The new primitive requires that existing admission; it does not invent resource ownership from a database insert. A crash between admission and beginInvocation leaves a legacy intent with no invocation row, handled by existing stopped/non-execution recovery. A crash after beginInvocation commit but before HTTP sends can lose the call permanently; the preserved reservation/admission requires explicit profile-specific reconciliation, which is not yet implemented. The system must not infer that an absent response means no paid request occurred.

## Binding matrix

| Field | Storage checks / host responsibility |
| --- | --- |
| runId, effectKey, generation | Exact match to current run and existing action |
| programDigest | Exact match to immutable run.identity.compiledProgramDigest |
| baseRevision | Git baseline commit; equals run.spec.input.baseRevision, never run.revision |
| inputArtifactRef, workspaceLeaseRef | Exact match to stored implement/repair action. Host still verifies actual workspace identity and resource lease. |
| profile | Only experimental bounded-changeset-v1; no enrollment implied |
| treeRevision | Host-observed preimage tree, must be checked under write lease again before apply |
| profile/grant/policy/manifest digests | Strict digest strings, immutable across replay; host independently verifies their content and authority |
| provider, model, requestDigest | Host binds provider routing, exact prepared request and all generation settings; storage cannot reconstruct or authenticate HTTP body |
| responseDigest, proposalDigest, evidenceRef, stopEvidenceRef | Host must validate persisted artifacts, complete provider stop proof and proposal. References alone are not proof. |

The core module does not depend on agents or import its experimental schemas. Existing bounded validation runs in host/adapter before this storage boundary. Schemas are strict and bounded by GraphJsonValue, including accessor rejection. Both tables have SQL UPDATE/DELETE and duplicate-INSERT guards (including OR REPLACE) and foreign keys. Responses are one immutable append per effect; conflicts fail. Caller follows every returned run revision.

## Response, accounting and recovery

`recordInvocationResponse` records an immutable validated response under the current fence and admission; accepted proposal, cannot_complete and rejected response are distinct dispositions. Proposal requires a proposalDigest; the other dispositions forbid it. Response alone never settles action usage, marks implementation_complete, applies files or releases admission. Late response in unknown/cancel_pending may be preserved without clearing the state or reservation. Exact receipt replay returns changed=false even after host resource release, provided the current generation/epoch and run fence are still valid. Historical evidence is readable through getInvocation under a new current fence, but cannot be rebound or appended under the new generation.

P04a blocks normal confirmed settlement and retry-safe failed settlement for request-backed actions. A trusted, stopped, non-retryable failed result can still use existing recordOutcome accounting: failed attempts charge max(reservation, actualTokens), as before. Host verification of stop, usage and disposition is required; the database does not interpret evidence artifact content. Legacy recovery applied/not_applied verdicts are rejected for request-backed actions, since old proofs do not cover the provider or multifile application. Unknown recovery is allowed and retains budget. Normal action paths without new request rows remain unchanged.

No terminal response releases the write admission: P06 requires request → validation → apply → durable receipt under the SAME host write lease. Release follows verified terminal host handling, not mere model completion. Partial apply, provider uncertainty and cross-generation reconciliation have no automatic success path in this batch. A pending request can remain quarantined indefinitely; this is an explicit activation blocker, not production-complete recovery.

## Crash and concurrency contract

Tests use real file SQLite and independent SIGKILLed Node processes with a durable fake paid-call counter. They cover before begin, inside the begin transaction after request insertion, after begin commit before dispatch (zero calls even after restart), after response before receipt (one call, no receipt), and after receipt commit before ACK (one call, receipt retained). Two restarts never produce a second dispatch. Transaction fault injection verifies request insert rolls back if running update fails. Two database connections verify stale revision rejection and identical replay; existing action worker tests cover BEGIN IMMEDIATE serialization and shared budgets. Tests also cover bindings, admission, immutable rows, original deadline, unknown late response, stale generation, legacy recovery and accounting.

Process-kill tests do not establish power-loss durability: openDb uses WAL with synchronous=NORMAL. Host/process crashes and OS/power failure are different guarantees. No real paid provider calls are made. Raw SQLite writes by a privileged actor remain outside the store API trust boundary.

## Next implementation gates

Before activation, choose and test the power-loss durability requirement for paid invocation gates (including SQLite synchronization policy); process-kill evidence alone is insufficient.

1. P04b: define apply intent/journal/receipt authority and cross-generation reconciliation proof, including resource release. Do not rewrite historical request generation or infer success from current files.
2. P05: prepare exact bounded provider request before beginInvocation, disable automatic retries, verify bounded UTF-8 response, usage and terminal status. No file writes.
3. P06: connect beforeEffect to beginInvocation only for a new explicit profile; keep existing bounded writer unchanged. Revalidate grant, path, links, preimages and tree under the same lease. Partial apply quarantines and blocks freeze/review/join.
4. P07–P09: full cumulative review, new compiler/profile versions, three-file create/replace/delete end-to-end and failure windows. Retain explicit parsers for historical request/response schema versions when adding new versions. No default activation before these gates pass.

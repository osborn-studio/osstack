# Persistent local source observations and explicit context

The implemented protocol is `local_json_snapshot_v1`: the host pins local snapshot bytes, manifest and repository scope in its private `source-registry.json`. No external service or plugin executable is launched. `sources inspect` remains read-only. `sources observe SOURCE_ID --repo ABSOLUTE_PATH --default-tenant` persists metadata in migration 46 of the existing control-plane DB; it does not store snapshot bodies. Short connections pass the normal control-plane and managed-home guards, require an already migrated supported schema, and close on success and failure.

A stream is scoped to one canonical repository, default tenant and source ID. Manifest `version` is its explicit generation, and snapshot `revision` is its sequence within that generation. The first verified full snapshot establishes a baseline. Consecutive snapshots advance it; exact duplicates are idempotent. A skipped revision creates a durable `gap`; changed contents at the same revision, an older revision, unavailable source, or generation change creates `unknown`. Restarts and later successful reads do not clear these states. A persisted clock rejects time regression. At most 128 streams and 32 retired generations per stream are accepted; a retired generation cannot be resurrected.

`sources events SOURCE_ID --repo ABSOLUTE_PATH --default-tenant --after SEQUENCE` returns bounded metadata pages. The observation journal has its own sequence, distinct from the source revision. It retains 500 events per stream, returns the current checkpoint, and explicitly marks a history gap when the requested cursor predates retention. A cursor ahead of known history fails. This is a journal of host observations, not a guarantee that the producer delivered every intermediate event, and it never treats an unobserved revision as a zero-valued update.

## Explicit snapshot acknowledgement

An operator must first review the current observation and a freshly pinned complete snapshot. A request to acknowledge a gap has no authority on its own. The private, same-UID `OSSTACK_HOME/source-acknowledgements.json` (0600) must contain an exact grant:

```json
{
  "schema_version": 1,
  "grants": [{
    "id": "calendar-reconcile-1",
    "scope": {"repo_path": "/absolute/repository", "source_id": "calendar", "default_tenant": true},
    "generation": "v2",
    "revision": 12,
    "manifest_digest": "64 lowercase hexadecimal characters",
    "content_digest": "64 lowercase hexadecimal characters",
    "expected_record_revision": 8,
    "expires_at_ms": 1792886400000
  }]
}
```

Replace illustrative paths, digests, revisions and expiry with the reviewed values. Then run `sources acknowledge calendar --repo /absolute/repository --default-tenant --grant calendar-reconcile-1`. The host rereads the pinned snapshot and approval before an atomic compare-and-swap. Changed history, mismatched scope/content/generation/manifest, stale grants and replay are rejected. Acknowledgement cannot rewind a revision or resurrect a retired generation. No RPC parameter accepts arbitrary snapshot bodies or generates approvals.

## Actual agent context

Source inspection/registration alone never enables prompt injection. An operator separately writes private `OSSTACK_HOME/source-context.json`:

```json
{
  "schema_version": 1,
  "repo_path": "/absolute/repository",
  "default_tenant": true,
  "source_ids": ["calendar"],
  "max_bytes": 4096
}
```

At most four sources are allowed, with at most 8192 source-body bytes in total. Existing explicit execution-context configuration enables the context adapter; its `packs` may be empty for source-only context. This same host adapter serves ordinary and Graph execution. Missing host source policy defaults off. Invalid policy, wrong repository, unavailable snapshot or quarantined ledger prevents the configured invocation.

Each source becomes one complete, escaped JSON `data_source` entry in the untrusted reference-data section. It is never a host instruction or permission. The existing assembler charges the actual encoded prompt bytes, preserves mandatory task/safety/contract sections, and records budget omissions. Receipts contain source generation/revision, durable observation revision, policy/manifest/content digests, selected/omitted decisions and exact final prompt digest; source bodies are absent. After the prepared receipt is durable, the host rechecks policy, fresh source pins and durable sequence immediately before dispatch. Revocation, expiry, content changes and new gaps prevent adapter invocation. Evidence stops at the actual `AgentTask.prompt` boundary; provider token windows and provider-wire delivery are not inferred.

## Qualification

Tests cover actual SQLite migration/reopen, persistent gaps/clock, retention and pagination, retired generations, exact host approvals, source-only real context assembly, prepared-receipt revocation races, actual captured adapter prompts/receipt digests and normal DB guards. External live sources, provider token-window compatibility, physical power loss and producer completeness outside the pinned local protocol remain unqualified.

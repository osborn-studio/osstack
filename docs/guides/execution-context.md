# Explicit local execution context

`deliver --execution-context FILE` is the opt-in integration contract. The CLI dependency factory loads this module only for that option; without it, the adapter array and original task are unchanged. The module does not route agents, invoke extra models, grant permissions, or change approval and publication policy. CLI flag and factory wiring are maintained with the delivery integration.

The factory calls `loadExecutionContextConfig(FILE, workspacePath)`, then `createPinnedLocalContextLoader(config)` and `createExecutionContextAdapters({ mode: "local", adapters, workspacePath, loadContext, recordReceipt, maxPromptBytes: config.max_prompt_bytes, maxKnowledgeBytes: config.max_knowledge_bytes, contractDigest?, contractBrief? })`. The receipt writer is trusted host code and must persist the supplied object with restrictive permissions, returning `{ path, digest }` where the digest covers the exact persisted bytes. The wrapper does not interpret or generate a delivery approval.

## Configuration

Place the configuration and all pinned pack files inside the explicitly selected canonical repository. `repo_path` must be the absolute canonical path (resolve symbolic aliases first). This version supports the default tenant only. Example values must be replaced with actual paths, exact file SHA-256, version, and Unix epoch milliseconds:

```json
{
  "schema_version": 1,
  "mode": "local",
  "repo_path": "/canonical/repository",
  "default_tenant": true,
  "max_prompt_bytes": 65536,
  "max_knowledge_bytes": 8192,
  "packs": [{
    "path": "knowledge/project.pack.json",
    "pack_id": "project/reference",
    "version": "1.0.0",
    "sha256": "<64 lowercase hex characters of the entire pack file>",
    "scope": "project",
    "verified_at_ms": 1792800000000,
    "expires_at_ms": 1792886400000
  }]
}
```

Packs use the existing OSStack knowledge-pack manifest format. The loader accepts explicitly pinned `project` or `official` scope with no tenant ID; it does not verify that a declared official source actually came from its claimed publisher. Hash pins establish byte identity, not factual accuracy or publisher authentication. Freshness timestamps are operator assertions. Each pack must have a unique ID and unique chunk IDs. Unknown configuration settings, traversal, mismatched hashes/versions/scopes, malformed manifests, and escaping symlinks fail before adapter invocation.

The filesystem checks assume cooperative local ownership. Descriptor identity checks and hashes protect the accepted bytes, but they are not an atomic filesystem snapshot or a sandbox against a same-user process repeatedly swapping ancestor paths.

Configuration is bounded to 64 KiB. At most 8 packs, 1,000,000 bytes per pack, 4,000,000 combined pack bytes, and 256 chunks per pack are read. Existing local lexical search uses the first 4,096 UTF-16 characters of the original task and returns at most 20 excerpts. No remote fetch, global user cache, embedding call, or credential lookup occurs. A source cannot promote itself to mandatory context.

## Rendering and evidence

The original task text, fixed host safety instructions, and optional frozen delivery contract brief are mandatory. The host caller supplies contract digest and brief together from the same frozen contract. `source_digest` identifies that full contract; `text_sha256` independently identifies the exact brief text. This module cannot derive the full contract from its brief and trusts that pairing. The delivery boundary validates it.

Budgeting counts every UTF-8 byte of the final rendered prompt, including JSON, escaping, section framing and metadata. Optional entries are selected whole in retrieval order. The knowledge budget is the increase over the mandatory render. An entry that is expired, has a future verification time, or exceeds either budget is omitted with an explicit reason. Mandatory overflow or invalid source metadata blocks invocation; mandatory text is never silently shortened. Invalid optional source shape, integrity, or scope also blocks the enabled invocation. Evidence exceeding 64 KiB blocks invocation; extremely long repository paths can reach this limit even within a prompt budget. Unknown model windows are always `token_window_qualification: "unqualified"`; this is not a token-limit guarantee or evidence of token savings.

Knowledge is JSON data with escaped angle brackets; it cannot close the host data section. The prompt contains reference text, opaque source IDs and excerpt digests, not the loader's absolute repository paths or full pack references. Original task and contract text are preserved as supplied by the host. Textual framing is not a security sandbox: instructions from any source cannot grant authority; existing runtime authorization and frozen-contract checks remain responsible for enforcement.

Before adapter invocation, a `prepared` receipt records the exact prompt digest, full byte count, run/task/session/adapter identities, source pins, selected/omitted entries and contract identity. After the adapter produces its first event, an `adapter_observed` receipt records the same prompt digest. Selection `sampled_at_ms` remains fixed across phases; `observed_at_ms` separately records first-event observation. Receipts exclude prompt and knowledge bodies, but unsalted source/text hashes can confirm guesses about short predictable content. Treat receipts as private evidence rather than anonymized data. A failed dispatch-time freshness check and a zero-event iterator both retain only prepared evidence; prepared never establishes that invocation happened. Neither phase proves provider-wire payload, task success, source correctness, model obedience, physical process termination or publication permission.

`repo_path` in the receipt and source entries identifies the canonical original repository used to read pinned packs. `execution_repo_path` separately records the canonical `AgentTask.context.repo_path`, or `null` when absent. An isolated candidate worktree may differ from the original source repository. The module does not read its packs from that candidate and does not assert that knowledge matches the candidate Git snapshot. Candidate admission and worktree authorization remain the caller's responsibility; recording the path grants no permission.

Construct one wrapper per delivery/Loop lifecycle. `receiptRefs()` returns references from all tasks in that lifecycle; `receiptRefs({ run_id?, task_id?, session_id? })` can select exact identities. Each referenced receipt contains its full identities and phase. Do not reuse an unfiltered aggregate as proof for an unrelated delivery. The caller must read refs after Loop execution (including failures), then bind them into its delivery receipt.

A failed prepared write prevents invocation. Failure after the first event aborts the linked signal and requests iterator cleanup. External cancellation also interrupts stalled loading, persistence or iteration; late persistence cannot mutate the completed invocation's refs. An already-started filesystem write may still finish as an unreferenced prepared file. Cleanup waits at most 100 ms; this is not proof that a provider stopped. The original adapter's `confirmStopped`, capability, availability and runtime-identity methods retain their original `this` binding.

## Rollback and verification

Remove `--execution-context FILE` to use the unchanged adapter path. No DB migration, daemon configuration, existing user settings, provider configuration or knowledge-pack mutation is required.

Component tests exercise complete-render bytes, Unicode, mandatory overflow, stale/future sources, authority claims, pins/scope/escapes, candidate/source separation, actual adapter prompts versus persisted receipt digests, task-specific refs, post-cancellation late writes, stalled cleanup and receipt failures. The delivery integration must additionally verify the actual Loop-issued task prompt and host-proof references; a helper test alone does not qualify the CLI end to end. Provider-wire behavior and any performance or quality benefit require separate model-specific qualification.

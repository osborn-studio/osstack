# Graph physical apply and cumulative review input

Baseline: e3ce5fd. These are experimental host services, not production executor enrollment. Jev is out of scope.

## Physical application

`graph-apply-changeset.ts` validates the existing bounded changeset contract again and requires a canonical, pristine, registered private Git candidate. All tracked and untracked/ignored bytes are inventoried; untracked/ignored files, symlinks, hardlinks, special files, sparse/assume-unchanged index flags and unsupported modes fail closed. The complete raw tree must equal the invocation tree, HEAD tree and index. The original task base may differ during repair. Linked worktrees are supported; their `.git` file is not mistaken for candidate content.

The host must already own an exclusive physical write lease and prove scope, grant, profile, stopped provider and workspace registration. Inode checks are evidence of change, not a sandbox against a malicious same-UID process. Git and the process environment are host-trusted. No shell, `git add`, clean filters, index staging or commit is invoked. Target trees are calculated directly using Git blob/tree object encoding; Git executable mode uses owner execute bit. Existing physical permission bits are preserved for replacement. Creation uses 0644.

Inventory limits are 10,000 entries, depth 64, 8 MiB per existing file, 64 MiB total. Existing protocol limits remain eight changes, 16 KiB proposed content in aggregate and ASCII target paths. An ordinary developer checkout containing node_modules/build outputs is not an admitted candidate. This is intentional scope, not a reason to ignore untracked files.

Order:

1. Authenticate, validate full preimage/HEAD/index, precompute target tree and immutable journal.
2. Persist journal outside candidate via private evidence store (file + directory fsync).
3. Revalidate authority and original tree. `beginApply.applyAuthorized === true` is the only first-write permission. A duplicate or uncertain gate never permits resuming writes.
4. At each file/directory boundary, revalidate full inventory, HEAD/index, current authority and held admission. Create parents conservatively; write exclusive temp, fsync, rename, fsync parent. Delete unlinks the checked preimage and fsyncs parent.
5. Verify the complete resulting bytes/modes against expected target; persist completion evidence, recheck authority and use the checked revision for `completeApply`.
6. On failure, preserve bytes/temp files and attempt immutable quarantine. If quarantine persistence fails, return `reconciliation_required`, not `quarantined`. No automatic rollback, cleanup or physical admission release occurs.

`graph-changeset-apply-host.ts` connects the file engine to invocation/apply ledgers. It requires readable provider request/response/terminal artifacts, verifies their bindings/digests and usage, checks WAL FULL/EXTRA without mutating global DB settings, and pins scope/run/generation/owner. Fresh revisions are accepted only through explicit checked reads. The begin/complete write consumes the revision returned by the preceding authority check rather than silently adopting a later revision.

Quarantine deliberately permits forensic recording after admission/grant revocation, but core still checks identity and immutable resolution. It cannot overwrite an already applied receipt. An `apply_complete` artifact is not a commit: only matching authoritative ledger state establishes settlement. The orphan artifact can exist after revoked authority or a lost DB ACK.

Failure metadata contains allowlisted code, phase, path, temporary path and completedChanges; it omits arbitrary error text. completedChanges is a lower bound of durably finished changes, never a roll-forward cursor. A sync failure may follow a successful physical mutation. SIGKILL bypasses this catch entirely: immutable journal plus pending DB intent still block replay/ready, and later inspection must derive actual state from bytes. Process-crash tests do not certify physical power loss.

## Complete reviewer evidence

`graph-review-input.ts` reads exact commit IDs from the host-owned frozen object store, checks repository toplevel and ancestry, and constructs two separate complete change sets:

- Original task base → candidate: cumulative review, including deleted before bytes.
- Invocation base → candidate: current repair, including reverted/transient paths absent from the cumulative change set.

Both include explicit before/after blob IDs, SHA-256, Git mode, byte count and full UTF-8 text; no mutable working file is read for content. Invalid UTF-8, NUL/binary content, symlink/gitlink changes, over-limit context and unsupported disclosure paths reject the whole result. UTF-8 BOM is preserved. A shared deny-first path policy validator authenticates the actual policy against inputPolicyDigest and checks the union of changed paths before any blob content is loaded. Digest alone is not authority: the host callback must bind it to the authorized disclosure policy.

Each change set allows at most 32 paths; the shared path policy caps their union at 64. Each before/after body is at most 16 KiB; all rendered bodies together at most 128 KiB; canonical JSON envelope at most 200,000 bytes. Repeated blobs are counted twice when rendered twice. Repository tree inventory is bounded at 10,000 entries/4 MiB. Exceeding any bound yields `GRAPH_REVIEW_CONTEXT_INCOMPLETE`; no truncation or fallback to only the last repair.

The output is evidence data, not instructions or a quality verdict. It contains no provider call and does not mark ready. Actual prompt/system/acceptance overhead and provider token-bound proof still need end-to-end enrollment validation.

## Remaining production gates

- Authenticated profile/grant/workspace enrollment, real token-bound verifier, physical lease renewal/shutdown lifecycle.
- Explicit durability configuration for production daemon (its current default remains NORMAL).
- New compiler/profile identity and broker invocation/apply lifecycle integration; do not make old v4 secretly execute new behavior.
- Freeze verifies the new applied receipt and producer-stop chain, not receipt-prefix matching. Existing delivery expects the legacy delivery-receipt shape, so it cannot simply consume the new reference.
- Reviewer provider adapter consumes this complete envelope and persists its digest; independent review and contained tests complete the three-file daemon task.
- Recovery/diagnostics reconcile retained evidence without hash-only completion, automatically clearing holds, or reusing quarantined workspaces.

No changes here enable GraphRpc production registration or alter existing writer/reviewer behavior. Completing these modules is progress on P06/P07, not closure of P08 or the whole roadmap.

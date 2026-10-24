# Evidence-backed lesson candidates

## Implementation contract

This bridge writes review material, never approval or published knowledge. The
real CLI `attention lesson --from-run RUN --repo PATH --default-tenant` requests
`attention.lesson-evidence` from the existing authenticated daemon. The RPC reader
uses the daemon's existing database without opening, migrating or modifying it.
The CLI never opens a database or starts a daemon. It requires a
canonical registered Attention repository scope, the default-tenant task/run and
an admitted run subject. Adapter events and ordinary run outcomes cannot prove a
verifier succeeded: these sources always yield an **investigation** candidate.
Absent, foreign, released or ambiguous source bindings fail closed without a file.

The source digest binds scope/task/run identity and bounded persisted event metadata (identity, sequence, type, time, terminal flag and payload byte length). Payload contents are never read or hashed; the fingerprint does not detect same-length payload edits.
No raw task prompt, transcript, command output, or secret-looking log text is
copied. Oversized/truncated event history is explicitly incomplete evidence.
The stable candidate key binds scope/task/failure family/source digest. Candidate
creation is create-only and atomic; identical input is idempotent. User-edited
files are preserved and a revision candidate references the prior draft. Reviewed
promoted/discarded candidates are never silently reintroduced.

Storage uses the existing `loop-lessons/drafts` directory, so existing
`loop lessons list/show/promote/discard` controls review. Directory components
must remain under the real repository path and cannot be symlinks. The bridge
checks drafts, promoted and discarded paths; no automatic promotion or skill edit
is permitted. Missing current proof remains investigation, regardless of booleans
such as `passed` or `reviewed` in an input/event.

## Strong evidence qualification

A planned, not yet implemented host-only Graph adapter would inspect authenticated registration scope, immutable
verification joins, action ledger, candidate artifacts and hashed verifier receipts.
It must call the registration's synchronous authorize callback before and after
asynchronous evidence reads. CLI callers cannot supply Graph scope or arbitrary
Graph database access. A success-after-repair candidate requires an actual prior
failed verifier command, a confirmed repair action, a different frozen candidate,
then a same-candidate successful command and independent review. Unknown actions,
missing receipts, mismatched scope/head/check, or source changes invalidate success.

Graph qualification remains pending until a real authenticated host registration
is wired. The ordinary CLI does not upgrade itself to that authority. The current
delivery contract receipt has no complete failure→repair attempt history and is
not treated as proof of recovery.

## Acceptance cases

- Real ordinary completed run + forged passed/reviewed event → investigation only.
- Foreign tenant, wrong repo, mismatched task, missing/admission-released run → no file.
- Repeated unchanged source → same candidate; edited source file → revision without overwrite.
- Source changes after inspection → retry with a new fingerprint, never reuse old proof.
- Draft/promoted/discarded symlink escape, symlink final file and unsafe output path → reject.
- Interrupted publication → no partial Markdown target, no overwriting old user content.
- Existing list/show/promote/discard sees the candidate; bridge itself never promotes.
- Missing database/schema/history and opaque execution status remain unknown/investigation.
- Strong adapter: forged passed flag, wrong scope/candidate/check, unchanged repair,
  unconfirmed stop, missing final proof or revoked authorization → no recovery claim.

The existing automatic Loop task writer now also uses create-only publication, bounded deterministic revisions and reviewed-candidate checks. Normal task IDs keep their filenames; normalized, long or reserved-namespace IDs get a task-prefixed hash suffix to avoid collisions. Explicit skill promotion includes a source-bound marker, so retrying a failed lifecycle move does not append the same lesson twice. Explicit skill symlinks resolve to the canonical target and retain its permission mode. Promotion/discard use no-overwrite links; a failure after linking can leave both copies for manual reconciliation, but never overwrites a reviewed file.

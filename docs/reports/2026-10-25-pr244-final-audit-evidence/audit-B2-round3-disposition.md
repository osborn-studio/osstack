# B2 round 3 disposition

This supersedes the earlier decision to treat the F7 point measurement alone as sufficient. The second Haiku audit correctly identified repeated raw observations during unrelated evidence-file I/O. Its NEEDS_FIX result is retained.

## F7 implementation

- `publishGraphVerificationEvidence` separates cheap live authority from raw candidate observation. Cheap authority/effect identity checks still surround EVERY asynchronous storage operation. Raw-byte observation happens immediately before invoking create-only link publication, after that link finishes, and once more after all durability/unlink operations before returning a successful receipt. There is no awaited operation between the pre-link raw observation and beginning the link, except the link itself. Full byte observations are never cached across these boundaries.
- Persistence also performs its existing initial observation to classify candidate mutation. The new diagnostic counter tests therefore require exactly FOUR complete observations per persist, rather than the roughly 21 inferred in the previous audit. Invocation and ordinary verify boundaries retain their independent observations.
- New shared inventory reader limits each candidate raw pass to 128 MiB aggregate and 10,000 entries. Repository metadata traversal is independently limited to 256 MiB of described files and 20,000 entries. These are explicit fail-closed supported-envelope limits, not universal latency promises. A review performs both tracked and full inventory passes.
- Directory enumeration is incremental (`opendirSync`), rejects excess names before allocating an unbounded listing, then sorts bounded names. Raw file reads use a nonblocking/no-follow opened descriptor, validate inode/type/link count/mode/size, charge the aggregate budget before allocation, read exactly that bounded size, and probe one extra byte to reject growth. This avoids stat-to-read unbounded allocations and FIFO/symlink replacement stalls. It does not claim atomic filesystem snapshots against an adversarial same-UID process.
- Tests exercise aggregate bytes across real opened files, stale size rejection, directory enumeration limits, oversized sparse untracked file rejection, and content mutations at all three publication observations. All fail closed.
- The opt-in benchmark now covers a 31 MiB candidate AND 1,500 distinct tracked files plus 1,500 valid unreachable loose Git objects. It records actual verify/invoke/persist observation counts and wall times. The loose objects use correct Git blob headers, SHA-1 names and zlib encoding, not fake filesystem objects.

## F1 concurrent release latent issue fixed

`released` becomes final only after physical lock release succeeds. A pending `releasing` promise is shared by normal release and reconciliation callers, and rejects use of the lease while release is pending. Normal release also coalesces with an in-flight reconciliation. A barrier test holds the physical repository-lock release, races both release entrypoints, asserts no recovery success/permit discharge until the barrier opens, and asserts one physical release total.

Rationale correction from the reviewer is accepted: it is the thrown release-boundary failure that stops the current dispatch chain; the ledger separately prevents terminal projection while an admission acknowledgement is outstanding. We do not claim `reserve` globally rejects unrelated subsequent actions based solely on a confirmed action's outstanding admission.

## F2 explicit recovery limitation

`GraphReconciler` exposes a host-only administrative interface with independent `verifyWorker`, `verifyQuiescence`, `verifyOutcome`, and synchronous `recheck`; it never accepts worker claims as proof. The specialized `recoverUnstartedGraphWorker` deliberately requires no actions/admissions at all and therefore does NOT automatically settle an already-written `intent` with a lost failed-settlement commit. An administrator must independently prove and attest the outcome through the generic trusted recovery registration; `execution_ref=NULL` alone is not sufficient proof. If such proof is unavailable, the run remains blocked. This is an explicit conservative recovery limitation; no automatic operator exit or automatic retry is claimed.

## F3/F4/F5

The second audit marked these resolved for their reported class. Environment filtering, cancellation classification and immutable retry semantic identity remain unchanged. `RegisteredContainedTests` context is supplied: executor/stop callbacks are trusted host registrations, not worker-provided authorities. The fresh-workspace preparation path still independently validates the candidate, reviewer and invocation receipts. A generic function's implementation cannot be inferred or certified by its ID; that remains a trust boundary, not a claim of cryptographic callback identity.

Validation records follow with their actual exit statuses; the final global suite and CI are performed by the parent task. This scoped static review cannot certify those results or external provider/SSH/GitHub/launchd qualification.

## Executed validation

- Inventory + physical-release + broker admission boundary files: 39/39 passed. Final nonblocking fd reader additionally reran inventory 2/2 passed.
- Full verification file: 51/52 passed. All new publication mutation, aggregate bound and two-scenario benchmark tests passed. One existing 16-contained-check test returned fail-closed `unknown` because its final physical stop proof was unconfirmed. The production stop deadline was not changed. The same test rerun alone passed (14.161 seconds, log retained). The first failure is not erased or represented as a clean full run; its exact root cause is not established. Parent final suite/CI must independently pass.
- CLI TypeScript check exited 0; separate JSON records the observed exit status rather than relying on empty stdout alone.
- Both benchmark cases require exactly four complete observations during every persist; verify uses one and invocation uses two. 31 MiB persistence measured 0.908–1.313 s versus the earlier 3.533–6.277 s point sample. Many-files/objects persistence measured 1.540–2.598 s. Many-file preparation took 58.082 s, an explicitly retained limitation. These are local wall-time samples under concurrent work, not a universal throughput or RPC p95 guarantee.

# Sonnet 5.5 audit dispositions

Original complete model output is preserved in evidence. The host verifies claims against code and real tests. The review is static, not an executed test or qualification.

## Preflight

- No detached SourceSnapshot is exported. Inspection markers are digest-bound; J02b owns provenance and dependency closure.
- Repo-relative raw UTF-8 paths, mode and roles, license selection/deduplication and refusal limits are explicit.
- Host supplies absolute binary and mirror. Effective config and object-store prerequisites are checked; no implicit hydration.
- #273 head is pinned. Successor-owner halt, split CI scope, candidate/merged/qualified distinction and exact management version are recorded.
- Date speculation was not adopted: ISO observation times are the authority. 69 original tasks and 69 revised future cases are distinct sets, validated independently.

## First code review

F1: confirmed ancestor discovery; now exact bare store or root/.git only. Regression rejects subdirectories.
F2: the suggested whitespace repository example does not establish the claimed SourcePin Ref constraint (repository is a string in J01). A real unpaired-surrogate input could throw a raw canonicalization error. Early canonical validation now returns INVALID_INPUT; public failures are typed.
F3: confirmed included/worktree promisor configuration gap. Query effective included config; tests exercise both.
F4/F5/F6: documented synchronous worker-only use, full-listing/commit-byte caps and conservative Git2.48 floor. Local Git2.54 and existing Linux CI Git2.55 observed. No broad cross-vendor qualification claim.
F7: added typed timeout/unsupported-Git, corruption, included-config, NFC, non-ASCII Python parity, outside-license and promisor-marker probes. Hook/filter sentinel is a regression guard against accidentally adding checkout/filter reads; it is not proof of arbitrary Git sandboxing.
F8: timestamps scoped to each PR observation; final source/test/audit evidence recorded separately. Export is experimental, not registry admission.

## Second code review

F1: license-only subtree now refused, with a regression test.
F2: stderr ignored; long missing paths return OBJECT_UNAVAILABLE rather than maxBuffer overflow.
F3: kept the simple bounded reader; measured exactly512 selected files at7.324s on the current host. Slow environments can return SOURCE_TIMEOUT; no universal performance guarantee. Batching remains a future optimization if measurement warrants it.
F4: SIGKILL timeout with a host test binary that ignores SIGTERM; retryable SOURCE_TIMEOUT observed.
F5: bare clone yields identical evidence; redirected gitfile and .git symlink refused. Actual pstack bare mirror also replayed.
F6: PR-head CI explicitly does not certify combined Firstmate integration candidates or a combined Firstmate+joint tree. Their separate local evidence is preserved in the joint ledger.
P3: alternate size uses stat; unexpected programming errors use INTERNAL; promisor=false conservative rejection, materialization exclusions and synchronous boundary documented. Cwd is the pinned store.

Remaining limits: no adopted dependency closure, typed registry, method activation, complete Firstmate behavior mapping, J12 recovery, live provider fault, remote/malicious-same-UID or physical durability qualification. Tests of this slice do not complete J02 or J09.

## Final review

Sonnet 5.5 returned PASS, with no concrete P0/P1/P2. Raw output is audit3-raw.md and exact code hashes are audit-code-binding.json. P3 error-category refinements and trusted commit-graph hardening are deferred; both lie inside the declared fail-closed/trusted-store scope. The abbreviated ledger SHA is replaced by the full final code commit at closeout.

The model's statement that total time is bounded must be read with the host boundary: 30 seconds is a subprocess scheduling deadline, not hard-real-time proof against kernel/filesystem stalls. SIGKILL covers the direct trusted Git process; no process-tree containment or malicious host-binary support is claimed. Historical hook/filter sentinel tests guard against future accidental checkout/transform code, not arbitrary-Git sandboxing.

# G16 implementation handoff

G16 ONLY implemented. Parent integration is still required before broker freeze can be enabled. No AGENTS, user docs, task statuses, root exports/package boundaries, migrations, daemon/broker, or G14/G15 files were edited by this actor. No commits/push/merge/deploy, nested agents, nested Loops, default-home CLI/DB access, or socket tests were performed.

## Owned changes

- packages/core/src/graph/artifact-store.ts: GraphArtifactStore and trusted freeze/verify/restore APIs.
- packages/core/src/graph/artifact-git.ts: narrowly scoped isolated Git plumbing and exact raw tree capture.
- packages/core/src/graph/artifact-store.test.ts: 17 real temporary-Git integration tests.
- packages/agents/src/worktree.ts: persistent graph retention before worktree creation, locked worktrees, generic cleanup protection, explicit quarantine and verified cleanup APIs.
- packages/agents/src/worktree.test.ts: 9 lifecycle tests (existing 7 + retention/revocation/corruption coverage).

The API/receipt contract was written before implementation in G16-interface.md. Core has no agents dependency and no root export edits. No SQL migration is required for these immutable disk artifacts and retention records.

## Exact parent integration

1. Make `GraphArtifactStore` and the types `GraphFreezeInput`, `GraphFreezeAuthority`, `GraphArtifactManifest` accessible from a lazy core package boundary for `dist/graph/artifact-store.js`. Parent owns the export/package edit. Do not eagerly import it into CLI startup.
2. Agents root exports, if needed: `cleanupGraphWorktree`, `quarantineGraphWorktree`, `GraphWorktreeRetention`, `GraphWorktreeRetentionRecord`. Existing `CreateWorktreeOptions` gains optional `graphRetention: {runId,scopeKey,generation,workspaceLeaseRef}`. Pass this BEFORE handing the directory to any graph producer. Allocation persists retention before `git worktree add`, then locks the worktree.
3. Broker freeze must assemble GraphFreezeInput entirely from trusted registration and durable ledger: `{artifactId,scope,runId,generation,owner,workspaceLeaseRef,repoId,commonDir,worktreePath,baseRevision,implementationReceiptRef,producerStopEvidenceRef}`. The canonical commonDir/worktreePath and exact current HEAD are mandatory. artifactId must be a stable host action identity.
4. Call `store.freeze(input, {lease,verifyLease,verifyImplementationReceipt,verifyProducersStopped})` under the ALREADY HELD G10 canonical writer lease. Do not nest acquisition. Every callback is mandatory and must resolve exactly undefined or throw. `verifyLease(input,lease)` authenticates the actual held lease object, live ownership, repo/run/scope/generation, policy and writer authority. Parent's new `ExecutionLease.assertActive()` can participate but does not replace registration/scope checks. `verifyImplementationReceipt(input)` resolves the actual successful G04 receipt and checks its exact identities. `verifyProducersStopped(input)` resolves the full independently supervised producer set and rejects missing/unknown evidence. Worker flags, worker paths, leader exit, event exhaustion and cancellation alone are insufficient. Keep lease held and prevent new producers throughout freeze, including callback awaits and persistence.
5. Only translate the returned `candidate_ready` into a broker/ledger result after the Promise succeeds. Returned object, revision/digest and refs are deeply frozen; refs are `graph-artifact:<manifest SHA256>`. Receipt/evidence refs are not themselves grants. Do not make another worker/implementation path emit candidate_ready.
6. `store.verify(digest)` validates manifest/bundle digests and imports the complete bundle into an empty object database with full strict fsck plus exact tree/parent checks. `store.restore(digest,{rootPath,directoryName})` creates one exact fresh child directory, a self-contained Git repository, and raw tree; returns `{worktreePath,candidateRevision,tree}`. Root parent must already exist. It refuses existing directories, symlinks and traversal. Parent must register this restored workspace under the correct current canonical identity and retention before allowing producers. It is an independent repository, not automatically a linked worktree of the deleted original. One supported parent route is createWorktree({repoPath:restored.worktreePath,...,graphRetention}) for execution.
7. Generic cleanup APIs always retain recorded graph worktrees, including corrupt retention files. `quarantineGraphWorktree(handle,reason)` only durably records uncertainty. `cleanupGraphWorktree(handle,{artifactDigest,verifySafe})` is the explicit trusted cleanup path. verifySafe receives the immutable exact retention record and digest twice, must resolve undefined, and must freshly establish all-producer stop, exported artifact verification, and G10 exclusion. It then removes the locked worktree and branch; retention metadata remains. Never call this from an unconditional finally.

## Tested guarantees

- Snapshot does not commit into the source repository, modify its index/HEAD, publish source branch refs, merge or push. Candidate commit is created in an isolated private repository; bundle carries the complete reachable parent history, not an incremental/prerequisite bundle. No durable dependency on source alternates or original objects.
- Strong test deletes BOTH source worktree and complete original repository/object database before restoring. Restored HEAD tree and parent match; `git fsck --full --strict` passes; binary bytes, deleted file, executable mode and symlink target match. Candidate commit is absent from original object database before deletion.
- Raw capture/restore bypasses clean/smudge and text/EOL conversion. Local hostile hooks and configured filters do not execute. Source Git environment redirection and global/system config are stripped; scratch repositories have empty templates, disabled hooks/fsmonitor/signing and automatic GC.
- File-to-directory replacement and filenames containing spaces/newlines are covered. Submodule entries are rejected. Exact repo/common-dir/worktree/HEAD and source inode identities are checked, source tree is captured again before publication, and all three authority callbacks are rechecked, including after durable ID publication before returning ready. Missing receipt fields and non-undefined async authority responses are rejected.
- Manifest includes exact frozen input, candidate SHA, tree SHA and bundle SHA256. Artifact digest is SHA256 of canonical manifest bytes. Files are synced; complete artifact directory is renamed atomically; artifactId binding is separately written/synced/renamed and its directory synced. No ready result is returned when publication fails. The test injects failure at ID publication and verifies the exported content remains valid afterwards.
- Same ID replay requires identical input and source content and verifies saved artifact integrity. Changed receipt/content, corrupted manifest or bundle fail closed. Replay never rewrites accepted artifacts.
- Retention is outside the worker checkout in canonical commonDir/osstack-graph-retention/<SHA256(exact worktreePath)>.json, is saved before allocation, and survives fresh module/process startup. Prefix cleanup cannot remove it. Corruption and verifier revocation preserve the directory. Separate actual child-process probe verifies restart behavior, then explicit verified removal.

## Actual validation and raw logs

All commands used `OSSTACK_HOME=/Volumes/AIMATE_WORK/tmp/gc5/home TMPDIR=/Volumes/AIMATE_WORK/tmp/gc5`.

| Command | Actual result | Raw log |
| --- | --- | --- |
| pnpm --filter @osstack/core exec vitest run src/graph/artifact-store.test.ts | PASS, 17 tests | G16-core-acceptance-tests.log |
| pnpm --filter @osstack/agents exec vitest run src/worktree.test.ts | PASS, 9 tests | G16-agents-final-tests.log |
| pnpm --filter @osstack/core typecheck | PASS | G16-core-final-typecheck.log |
| pnpm --filter @osstack/agents typecheck | PASS | G16-agents-final-typecheck.log |
| pnpm --filter @osstack/core build | PASS | G16-core-final-build.log |
| pnpm --filter @osstack/agents build | PASS | G16-agents-final-build.log |
| node /Volumes/AIMATE_WORK/tmp/gc5/G16-restart-probe.mjs | PASS, fresh child preserved retained worktree; explicit cleanup then removed it | G16-restart-probe.log |

TDD evidence: G16-core-red.log (missing module; initial pnpm test forwarding incidentally also ran 391 existing core tests, all passed), G16-agents-red.log (missing quarantine API), G16-core-receipt-red.log (missing required receipt was incorrectly accepted before fix), G16-directory-red.log (file-to-directory replacement rejected before fix). G16-immutable-red.log records the returned-object immutability failure before its fix; G16-publication-authority-red.log records the missing post-publication lease recheck before its fix. Intermediate green logs remain. Initial core typecheck/build hit the concurrently unfinished graph-recovery.ts and its test; those raw failures remain in *-1.log. After that actor completed the file, both final core checks passed. No unrelated source was altered to hide those failures. No Unix socket evidence is claimed.

## Explicit limitations / operational contract

- Trusted host callbacks, a stable host-owned private artifact root/common-dir metadata area, and an honest Git executable are necessary. This is not an OS sandbox against another process that can arbitrarily edit the artifact store or metadata. The host is responsible for authenticating all evidence and keeping canonical exclusion active; the service does not manufacture real process-stop evidence or own a redundant DB lease/scheduler.
- Source snapshot contains tracked paths plus nonignored untracked files, matching Git inclusion semantics; ignored untracked files and empty directories are not candidate contents. Raw bytes intentionally bypass Git filter/EOL transformations. Only SHA1, non-shallow Git repositories and UTF-8 filenames are supported currently. Submodules, nested repos and special files fail closed. Git subprocess output is bounded at 256 MiB and each plumbing command has a 60-second timeout; this is not yet a large-repository streaming exporter.
- ID replay requires the original registered source still exists to compare current content. After source destruction, verify/restore by the durable returned digest remains available; no live-source authorization is inferred from a manifest.
- A crash can leave an orphaned complete artifact, scratch directory or per-ID lock. Artifacts are never automatically GC'd; stale ID locks deliberately fail closed until a trusted offline owner investigates. verify/restore do not depend on those locks. No automatic scratch/retention reclamation policy is introduced.
- Directory fsync ignores only filesystem unsupported-operation errors (EINVAL/ENOTSUP/EOPNOTSUPP), propagates other failures, and cannot promise physical-media behavior beyond platform fsync support. Restore failure leaves its newly allocated partial directory for inspection and refuses reuse; the immutable artifact remains available for a new exact destination.
- Broker registration, real G10 evidence resolver integration, restored-workspace policy, and the G17 daemon-worker chain remain parent responsibilities. This actor's tests prove the service/storage boundary, not end-to-end C5 admission.

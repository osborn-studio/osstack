> 历史执行器交接，非最终验收结论。最终状态与可复核证据见 [C3 报告](../2026-09-14-graph-admission-completion.md)。早期系统临时目录日志已不可用；本目录的新验收日志为重新运行所得。

# G09 executor evidence

Implemented only the assigned G09 resolver/lock modules and their tests, plus this report and requested G09-interface.md supervisor communication. Read repository AGENTS, the C2 Functional runtime decision, G09 acceptance, and supervisor.md (including cross-home scope and dead-owner quarantine requirements). No project commits, nested agents, recursive Loop, CLI execution, production DB access, push or merge. Parent/G08 owns core index and parent/G10 owns integration. Completion here is source/fixture evidence, not production graph admission.

## Final API

From `packages/core/src/graph/repository-scope.ts`:

```ts
resolveRepositoryScope(
  workspacePath: string,
  expected?: { repoId?: string; commonDir?: string },
): Promise<{ repoId: string; commonDir: string; workspacePath: string }>
```

`workspacePath` is an existing canonical directory. `commonDir` is the canonical actual Git common directory, shared across worktrees and symlinks. `repoId` is `repo-` plus the full lowercase SHA256 of that canonical commonDir string. Expected repoId must exactly match; expected commonDir is realpathed and must match. Missing/empty/non-directory workspace, non-Git workspace, forged identities, and missing expected commonDir paths reject. Git runs by execFile argument array, no shell; inherited GIT_* routing/config variables are removed, global/system configuration disabled, output capped at 64 KiB, timeout 5 seconds with SIGKILL. PATH/Git installation and local filesystem remain trusted.

This proves filesystem identity, **not authorization**. Daemon resolves its trusted registration and checks untrusted hints. Resolving an arbitrary caller-selected valid repository does not grant access. Registration must also bind policy and actual execution cwd; a logical legacy repo label is not the new canonical hash. G08/parent must export resolver and RepositoryScope through core index (not edited here).

Existing `acquireRepoWriteLock`, `acquireRepoLock`, `repoLockPath` remain the one lock implementation. Added options:

- `lease_ms?: number`: positive safe integer, default 60,000 ms.
- `recover_stale?: boolean`: default true preserves legacy recorded-PID-death recovery. **Every managed canonical admission must pass false** until trusted host reconciliation proves external producers stopped. False preserves the dead owner file and blocks repeated restart attempts.

Returned handle adds `renew(): Promise<void>`, `assertOwnership(): Promise<void>`, and `assertActive(): Promise<void>`. New owners carry UUID token and ISO expires_at; the schema accepts old owner files without these fields conservatively. The readonly owner getter reflects successful renewal and is frozen. Renewal checks token/current owner and rejects expired leases; assertOwnership accepts an expired but still owned lock, while assertActive rejects it. release permits expired ownership, is idempotent after successful release, and never deletes another token's lock. No automatic heartbeat is installed by this low-level API. Integrators must renew and stop further action admission on lease/ownership failure.

Expiry never permits stealing from a live/unknown recorded process. Liveness errors are unknown/live; only definite false permits legacy stale recovery. PID death alone does not establish descendant/adapter exit. Wall-clock lease expiration does not kill external processes or fence their filesystem writes. The trusted host must retain/quarantine ownership until exit/reconciliation evidence is sufficient, as required by C2/G15.

## Local mutation protocol and preconditions

All cooperating acquire/recover/renew/release/assert paths serialize through a short atomic-mkdir `<lock>.guard` transaction. The guard is part of the same writer-lock protocol, not another repository execution authority. Acquisition stages and fsyncs complete JSON before hard-link publication; replacement stages complete JSON and atomically renames it while holding the guard. Stale recovery does not move a live pathname aside. Token validation and deletion occur under the same guard, so concurrent stale recovery/release cannot remove a newly acquired cooperating owner's lock. A reread detects the original injected out-of-protocol ownership replacement regression.

Guard contention is bounded to approximately two seconds. A crashed/abandoned guard is **not** automatically removed based on age or PID; such removal has the same unsafe stale-unlink race. It fails closed until quiescent administrative recovery. No automated guard-repair utility is introduced. Crash after staging may leave an inert staging file and guard; do not clean them while participants may be active. This is an explicit availability limitation.

Requires a trusted private local filesystem with coherent atomic mkdir/link/rename semantics and a common lock root for all participants. Managed callers across different OSSTACK_HOMEs must use the same commonDir-relative root, tested here as `join(scope.commonDir, "osstack", "repo-locks")`. Caller-supplied root remains in the backward-compatible low-level API; the resolver alone cannot repair callers choosing different roots/old arbitrary IDs. Concurrent old binaries ignoring the guard, arbitrary hostile local file mutation, network/shared-host filesystems, and power-loss durability are not certified. All managed paths need parent integration and must reject unresolved legacy scopes rather than claiming automatic compatibility.

## RED before fixes

Evidence directory: `/var/folders/97/wmwg4qzx02j74c3n73nh438w0000gn/T/osstack-graph-admission-btizzez0/evidence`.

| Log | Observed failure before fix |
| --- | --- |
| G09-scope-red.log | Resolver module absent; test suite cannot load the proposed API. |
| G09-lock-red.log | Seven failures; all six original tests pass. Real stale-recovery competitors produce **two successful lock acquisitions**. Also absent token/renewal/expiry, invalid lease accepted, unknown liveness not classified busy, abandoned guard ignored. |
| G09-managed-red.log | Dead owner is automatically replaced despite requested recover_stale:false. |
| G09-publication-expiry-red.log | Lease expires while waiting for guard because its clock starts before publication. |

Fixes followed their respective RED observations. The six original behavioral tests are preserved; their exact stale-audit assertion now uses the acquired owner's actual object to accommodate additive token/expiry fields without dropping audit verification.

## GREEN and validation

- `G09-lock-green.log`: 17/17 lock tests pass.
- `G09-scope-green.log`: 6/6 resolver tests pass.
- `G09-managed-green.log`: intermediate 16/16 lock tests pass after quarantine fix.
- `G09-autonomy-suite.log`: 14 files, **172 tests pass**.
- `G09-core-suite.log`: 33 files, **340 tests pass** in the shared workspace snapshot (includes concurrent G08 work).
- `G09-autonomy-typecheck.log`: complete autonomy strict typecheck passes.
- `G09-scope-typecheck.log`: isolated resolver + resolver tests typecheck using repository strict configuration passes. This isolates G09 from G08's transient RED development.
- `G09-core-typecheck.log`: final complete core strict typecheck passes; earlier runs exposed only concurrent G08 test references while that implementation was in progress.
- `git diff --check` passes for modified lock files.

Commands used parent's explicit temporary OSSTACK_HOME: `/var/folders/97/wmwg4qzx02j74c3n73nh438w0000gn/T/osstack-graph-admission-btizzez0/home`. Focused commands are `pnpm --filter @osstack/core exec vitest run src/graph/repository-scope.test.ts` and `pnpm --filter @osstack/autonomy exec vitest run src/repo-lock.test.ts`; full commands are package test/typecheck scripts. No CLI was launched. Tests create and remove their own temporary roots.

Fixtures use real Git init/empty fixture commit/worktree/symlink operations and independent forked Node processes executing transpiled actual implementation source. They prove four-process initial competition, six-process concurrent stale recovery after confirmed SIGKILL exit, token-safe stale release/renewal, observable renewal and real wall-clock expiry with live child, conservative legacy owner handling, managed dead-owner quarantine, and two independent homes/worktrees sharing one canonical-root lock. Git shell-metacharacter paths remain literal. A real stub executable produces oversized output, then a hung child ignores SIGTERM; timeout rejection is followed by a PID probe confirming that child exited. Process IPC waits and Git subprocesses are bounded, child processes are killed/joined at fixture cleanup.

No claim is made that these tests prove hostile filesystem safety, power-loss durability, external-effect exactly-once behavior, descendant termination, or G10 integration completeness. Parent retains acceptance and integration ownership.

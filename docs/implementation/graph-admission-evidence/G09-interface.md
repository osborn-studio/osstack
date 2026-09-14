# G09 final supervisor interface

G09 source implementation and validation complete; parent owns acceptance/integration. Full evidence and limitations: [G09-executor.md](G09-executor.md). No core index edits by G09. G08/parent should export resolveRepositoryScope and RepositoryScope from `./graph/repository-scope.js`; parent has already measured compiled import cost per supervisor notes.

```ts
resolveRepositoryScope(
  workspacePath: string,
  expected?: { repoId?: string; commonDir?: string },
): Promise<{ repoId: string; commonDir: string; workspacePath: string }>
```

Module: `packages/core/src/graph/repository-scope.ts`. workspacePath and actual Git commonDir are realpathed; repoId is `repo-` + full lowercase SHA256(commonDir). Worktrees and symlinks share the identity. Expected hints must match (commonDir canonicalized); empty/missing/non-Git workspace and forged hints reject. Git invocation has no shell, strips inherited GIT_* variables, caps output at 64 KiB, and kills after 5 seconds. This proves filesystem identity, NOT caller authorization: resolve trusted registered path, check caller hint, and bind policy/action cwd at the host seam.

Existing lock APIs and repoLockPath remain. Add `lease_ms?: number` (default 60_000) and `recover_stale?: boolean` (legacy default true). Handle adds `renew(): Promise<void>`, `assertOwnership(): Promise<void>`, `assertActive(): Promise<void>`. New owner includes unique UUID token and expires_at; readonly owner getter reflects renewals. Old owner JSON is accepted conservatively. renew requires current unexpired ownership. assertOwnership permits expired ownership; assertActive requires unexpired ownership. Release checks token and is idempotent after successful release. No automatic heartbeat; host renews and stops action admission on failure.

**Managed integration requirements:** use `recover_stale: false` for every managed acquisition. PID death does not prove adapter/descendant termination. Dead owner file remains present/busy across repeated restart attempts. Expiry never steals from live/unknown PID, never kills or fences an external process. Host confirms producer exit/reconciliation before release/transfer.

Use one root shared across OSSTACK_HOMEs in canonical commonDir, tested as `join(scope.commonDir, "osstack", "repo-locks")`. Caller-supplied roots/legacy labels are not automatically canonicalized by low-level lock API; parent must normalize direct/Loop/graph seams or reject unresolved scope. Two actual Node processes, two temporary OSSTACK_HOMEs, main repo + worktree fixture prove shared exclusion with this root.

Race fix: short atomic mkdir mutation guard within the SAME writer-lock protocol serializes publication/recovery/renew/release/assert operations. Complete staged owner JSON is atomically published/replaced. An abandoned guard fails closed after approximately two seconds; no automatic age/PID stealing or recovery utility, since that recreates the stale-unlink race. Requires quiescent administrative recovery. Trusted private local filesystem/cooperating binaries only; old callers using the upgraded implementation retain compatibility, mixed old binaries ignoring guard and shared-network hosts are not certified.

Final GREEN: 17 lock + 6 scope focused tests; autonomy 172 tests; core 340 tests; autonomy and core full strict typechecks; isolated resolver typecheck. All six original lock behaviors retained. Initial RED reproduced **two successful acquisitions** by independent stale-recovery competitors. Additional RED/GREEN covers managed dead-owner quarantine and lease starting after guard wait. Logs: `/var/folders/97/wmwg4qzx02j74c3n73nh438w0000gn/T/osstack-graph-admission-btizzez0/evidence/G09-*.log`. All commands used parent's temporary OSSTACK_HOME sibling `home`; no CLI/Loop invocation or production DB.

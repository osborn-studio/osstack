# 宿主源码复核补充

固定 OSStack commit：14e7433b70f103499059c15fb9bf2ed87b0b0279。只读源码核验，没有运行时验证。

第四轮 db.ts 的 200–285 行范围错误，摘录为空；原始输入和 manifest 保留这一事实。第二轮输入包含完整 db.ts。此处补充精确原文，不声称第四轮模型已读到它。

## packages/core/src/state/db.ts:72-173

完整文件 SHA-256：72057b005cdec61b08d27459d4fcf58b9bfea672056537038cdefe9b1b74f2c2

```typescript
72:  * Open the osstack state database, apply pragmas, and run pending migrations.
73:  * Caller owns the lifetime — pair every openDb() with a db.close() in shutdown.
74:  */
75: export function openDb(opts: OpenDbOptions): Database.Database {
76:   const { path, readwrite = true, minFreeBytes = DEFAULT_MIN_FREE_BYTES } = opts;
77:   if (readwrite) preflightDiskSpace(path, minFreeBytes);
78: 
79:   const db = new Database(path, { readonly: !readwrite });
80: 
81:   try {
82:     // Refuse an unsupported schema before changing journal mode or running DDL,
83:     // including read-only inspection. A failed open never escapes with a live handle.
84:     assertSupportedVersion(db.pragma("user_version", { simple: true }) as number);
85:     assertMigrationLineage(db);
86:     // Pragmas are applied per-connection in SQLite. Apply on every open.
87:     if (readwrite) db.pragma("journal_mode = WAL");
88:     db.pragma("synchronous = NORMAL");
89:     db.pragma(`cache_size = ${PAGE_CACHE_KIB}`);
90:     db.pragma("foreign_keys = ON");
91:     db.pragma("busy_timeout = 5000");
92: 
93:     if (readwrite) runMigrations(db);
94:     return db;
95:   } catch (error) {
96:     db.close();
97:     throw error;
98:   }
99: }
100: 
101: // This schema is table-additive. Derive expected table introductions once;
102: // a future DROP/RENAME migration must also update this lineage contract.
103: const tableIntroductions = MIGRATIONS.flatMap(migration =>
104:   [...migration.sql.matchAll(/^\s*CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-zA-Z_]\w*)\s*\(/gm)]
105:     .map(match => ({ name: match[1]!, version: migration.id })));
106: 
107: /** Reject pure or mixed unreleased Graph schemas before application pragmas or
108:  * DDL. SQLite may itself checkpoint an abandoned WAL on close; logical ledger
109:  * content and user_version must remain intact for the original binary. */
110: function assertMigrationLineage(db: Database.Database): void {
111:   const current = db.pragma("user_version", { simple: true }) as number;
112:   const actual = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
113:   // Experimental Graph or Attention tables must never be migrated as released main.
114:   const experimentalTable = (name: string) => name.startsWith("graph_") || name.startsWith("attention_") || name === "daemon_owner";
115:   if (current < 25 && ![...actual].some(experimentalTable)) return;
116:   const expected = new Set(tableIntroductions.filter(table => table.version <= current).map(table => table.name));
117:   if ([...expected].some(name => !actual.has(name))
118:     || [...actual].some(name => experimentalTable(name) && !expected.has(name))) {
119:     throw new Error("GRAPH_EXPERIMENTAL_SCHEMA_CONFLICT: preserve this home and reconcile with its original build; do not reset user_version or reuse it for the integrated runtime");
120:   }
121: }
122: 
123: function assertSupportedVersion(current: number): void {
124:   if (current > CURRENT_SCHEMA_VERSION) {
125:     throw new Error(`Migration state inconsistent: user_version=${current}, expected=${CURRENT_SCHEMA_VERSION}`);
126:   }
127: }
128: 
129: /**
130:  * Apply pending migrations idempotently. `user_version` PRAGMA tracks progress.
131:  * The version pragma guarantees forward-only application. Many migrations
132:  * contain non-idempotent CREATE/ALTER statements; never reset user_version.
133:  */
134: export function runMigrations(db: Database.Database): void {
135:   const currentRow = db.pragma("user_version", { simple: true }) as number;
136:   let current = Number(currentRow);
137:   assertSupportedVersion(current);
138:   assertMigrationLineage(db);
139:   for (const m of MIGRATIONS) {
140:     if (m.id <= current) continue;
141:     db.exec("BEGIN");
142:     try {
143:       db.exec(m.sql);
144:       db.pragma(`user_version = ${m.id}`);
145:       db.exec("COMMIT");
146:       current = m.id;
147:     } catch (err) {
148:       db.exec("ROLLBACK");
149:       throw err;
150:     }
151:   }
152:   if (current !== CURRENT_SCHEMA_VERSION) {
153:     throw new Error(
154:       `Migration state inconsistent: user_version=${current}, expected=${CURRENT_SCHEMA_VERSION}`,
155:     );
156:   }
157: }
158: 
159: /**
160:  * Run a function inside a transaction with preflight. Use for any write path
161:  * called from the daemon hot loop. Wraps better-sqlite3's transaction() so
162:  * disk-space errors fire BEFORE BEGIN, not mid-transaction.
163:  */
164: export function withWrite<T>(
165:   db: Database.Database,
166:   path: string,
167:   fn: (db: Database.Database) => T,
168:   minFreeBytes: number = DEFAULT_MIN_FREE_BYTES,
169: ): T {
170:   preflightDiskSpace(path, minFreeBytes);
171:   const tx = db.transaction(fn);
172:   return tx(db);
173: }
```

## packages/core/src/state/attention-store.ts:80-105

完整文件 SHA-256：b6ffc14f93f2bc7d5f3a830e859c4ba59bb75d55d42c88b663be3ce666bcb788

```typescript
80:           "SELECT 1 FROM daemon_owner WHERE singleton=1 AND home_id=? AND instance_id=? AND generation=?"
81:         )
82:         .get(owner.home_id, owner.instance_id, owner.generation)
83:     )
84:       throw new Error("stale_owner");
85:   }
86:   write<T>(owner: AttentionOwner, fn: () => T): T {
87:     if (this.db.inTransaction) {
88:       this.assertOwner(owner);
89:       return fn();
90:     }
91:     return withWrite(this.db, this.path, () => {
92:       this.assertOwner(owner);
93:       return fn();
94:     });
95:   }
96:   registerScope(
97:     owner: AttentionOwner,
98:     taskId: string,
99:     repoPath: string
100:   ): AttentionScope {
101:     const canonicalRepo = realpathSync(repoPath);
102:     if (!statSync(canonicalRepo).isDirectory())
103:       throw new Error("repository_directory_required");
104:     return this.write(owner, () => {
105:       const task = this.db
```

## packages/cli/src/supervision-service.ts:73-94

完整文件 SHA-256：34e8afb5aed0a8c99b167f2d488d58cbd3d810cddd43e6f4e5caec34049e3cc7

```typescript
73:     readonly sender?: AttentionSender,
74:     private readonly options: SupervisionOptions = {}
75:   ) {
76:     this.readTimeoutMs = options.readTimeoutMs ?? 1000;
77:     if (!Number.isFinite(this.readTimeoutMs) || this.readTimeoutMs < 1 || this.readTimeoutMs > 1000)
78:       throw new Error("invalid_read_timeout");
79:     this.store = new AttentionStore(db, path);
80:     this.observer = new AttentionObserver(
81:       this.store,
82:       this.store.claimOwner(randomUUID())
83:     );
84:     this.experience = new AttentionExperience(this.store, this.observer.owner);
85:     this.experience.recoverDeliveries();
86:     new AttentionActions(this.store, this.observer.owner).recover();
87:   }
88:   private assertRunning(): void {
89:     if (this.stopped) throw new Error("supervision_stopped");
90:   }
91:   start(): void {
92:     this.assertRunning();
93:     if (this.started) return;
94:     this.started = true;
```

## packages/cli/src/governed-execution.ts:1-130

完整文件 SHA-256：471d5ba2b17392ce4dce2b31df64673f71bac02b5b5a5ae58d7ef4e703c93f75

```typescript
1: import { join } from "node:path";
2: import { acquireRepoWriteLock, FifoSemaphore, SemaphoreAcquireAbortedError, type SemaphoreLease, type RepoWriteLock } from '@osstack/autonomy';
3: import { resolveRepositoryScope } from '@osstack/core';
4: 
5: export interface ExecutionLease {
6:   /** Idempotent after physical release, including retries of a lost DB acknowledgement. */
7:   release(): Promise<void>;
8:   /** Keep ownership until a trusted caller has confirmed external exit. */
9:   retain(reason: string): void;
10:   /** Trusted host only; never accept a worker-provided proof callback.
11:    * Idempotent after release: recovery must never release semaphore permits twice. */
12:   releaseAfterReconciliation?(verify: () => Promise<void>): Promise<void>;
13:   /** Assert this exact canonical writer lease is still live. */
14:   assertActive?(): Promise<void>;
15:   /** Scoped synchronous file operations under the canonical writer lock. This
16:    * capability is absent on read leases. Failures retain admission until recovery. */
17:   withWriteGuard?<T>(workspacePath: string, operation: (assertActive: () => void) => T): Promise<T>;
18: }
19: export interface AdmissionInput {
20:   kind: 'read' | 'write';
21:   runId: string;
22:   /** Supplied by the daemon registration, never by an adapter context. */
23:   workspacePath?: string;
24:   repoId?: string;
25:   signal?: AbortSignal;
26:   authorize?: () => Promise<void>;
27:   /** Host-only synchronous proof: acquisition rejected with no lease or cleanup obligation. */
28:   onNotAcquired?: () => void;
29: }
30: export class GovernedExecution {
31:   private readonly activeRuns = new Set<string>();
32:   private readonly quarantinedRepositories = new Map<string, Set<string>>();
33:   private quarantine(repoId: string, runId: string): void {
34:     const owners = this.quarantinedRepositories.get(repoId) ?? new Set<string>();
35:     owners.add(runId); this.quarantinedRepositories.set(repoId, owners);
36:   }
37:   constructor(private readonly options: {
38:     reads: FifoSemaphore;
39:     writes: FifoSemaphore;
40:     repositories: Map<string, FifoSemaphore>;
41:     checkHealth: () => Promise<void>;
42:   }) {}
43: 
44:   get hasWriters(): boolean { return this.options.writes.in_use > 0; }
45: 
46:   async acquire(input: AdmissionInput): Promise<ExecutionLease> {
47:     const cleanup = { confirmed: true };
48:     try { return await this.acquireOwned(input, cleanup); }
49:     catch (error) {
50:       if (cleanup.confirmed && !this.activeRuns.has(input.runId)) input.onNotAcquired?.();
51:       throw error;
52:     }
53:   }
54: 
55:   private async acquireOwned(input: AdmissionInput, cleanup: { confirmed: boolean }): Promise<ExecutionLease> {
56:     const check = async (): Promise<void> => {
57:       if (input.signal?.aborted) throw new SemaphoreAcquireAbortedError();
58:       if (input.kind === 'write') await this.options.checkHealth();
59:       await input.authorize?.();
60:     };
61:     await check();
62:     const scope = input.workspacePath === undefined ? undefined
63:       : await resolveRepositoryScope(input.workspacePath, input.repoId === undefined ? {} : { repoId: input.repoId });
64:     if (input.kind === 'write' && !scope) throw new Error('trusted repository scope required for writes');
65:     if (input.kind === "write" && scope && this.quarantinedRepositories.has(scope.repoId)) throw new Error("repository external stop unconfirmed; reconciliation required");
66:     if (this.activeRuns.has(input.runId)) {
67:       cleanup.confirmed = false;
68:       throw new Error("run already admitted or queued");
69:     }
70:     this.activeRuns.add(input.runId);
71:     let local: SemaphoreLease | undefined;
72:     let global: SemaphoreLease | undefined;
73:     let lock: RepoWriteLock | undefined;
74:     let queue: FifoSemaphore | undefined;
75:     const releasePermits = (): void => {
76:       global?.release(); local?.release();
77:       this.activeRuns.delete(input.runId);
78:       if (scope && queue?.in_use === 0 && queue.pending === 0) this.options.repositories.delete(scope.repoId);
79:     };
80:     let released = false;
81:     let retained = false;
82:     let writeGuardActive = false;
83:     // Start as soon as the filesystem lock exists, including the final policy
84:     // wait. Once admitted, a renewal failure retains the unknown producer.
85:     let renewing: Promise<void> = Promise.resolve();
86:     let timer: ReturnType<typeof setInterval> | undefined;
87:     const startRenewal = () => {
88:       timer = setInterval(() => {
89:         if (writeGuardActive) return;
90:         renewing = renewing.then(async () => {
91:           if (!released && !writeGuardActive) await lock!.renew();
92:         }).catch((error: unknown) => {
93:           retained = true;
94:           if (scope) this.quarantine(scope.repoId, input.runId);
95:           process.stderr.write(`repository lease renewal failed; retained ${input.runId}: ${String(error)}\n`);
96:           if (timer) clearInterval(timer);
97:         });
98:       }, 20_000);
99:       timer.unref();
100:     };
101:     try {
102:       if (input.kind === 'write' && scope) {
103:         queue = this.options.repositories.get(scope.repoId) ?? new FifoSemaphore(1);
104:         this.options.repositories.set(scope.repoId, queue);
105:         local = await queue.acquire(input.signal);
106:       }
107:       global = await (input.kind === 'read' ? this.options.reads : this.options.writes).acquire(input.signal);
108:       if (input.kind === 'write' && scope) {
109:         // A failed filesystem acquisition may have left an ownership obligation.
110:         cleanup.confirmed = false;
111:         lock = await acquireRepoWriteLock({ root_dir: join(scope.commonDir, "osstack", "writer-locks"), recover_stale: false, repo_id: scope.repoId, autonomy_run_id: input.runId });
112:         // Authorization may wait behind another branch's synchronous work.
113:         // Start ownership renewal before that wait, not after publishing admission.
114:         startRenewal();
115:       }
116:       if (input.kind === "write" && scope && this.quarantinedRepositories.has(scope.repoId)) throw new Error("repository external stop unconfirmed; reconciliation required");
117:       await check();
118:       await renewing;
119:       if (retained) throw new Error("repository lease renewal failed during admission");
120:       await lock?.assertActive();
121:       if (retained) throw new Error("repository lease renewal failed during admission");
122:       if (input.signal?.aborted) throw new SemaphoreAcquireAbortedError();
123:     } catch (error) {
124:       if (timer) clearInterval(timer);
125:       await renewing;
126:       try {
127:         await lock?.release();
128:         if (lock) cleanup.confirmed = true;
129:         // No executor was admitted. Remove only this rejected acquisition's quarantine.
130:         if (scope) {
```

结论：openDb 在运行迁移前检查 user_version，assertSupportedVersion 拒绝高于当前 schema 的版本；这属于版本检查，不应误称只靠 lineage 检查。AttentionStore.write 有 inTransaction 分支，withWrite 调用 better-sqlite3.transaction；仍须用故障测试证明新增多表原子性。SupervisionService 构造函数实际调用 AttentionActions.recover。GovernedExecution 包含内存 quarantine 和 recover_stale=false 的写锁准入，不能仅凭这些源码推断所有宿主都已具备跨重启静默证明。

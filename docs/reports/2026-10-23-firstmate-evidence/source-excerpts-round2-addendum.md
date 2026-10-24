# Round 2 additional source evidence

## O13: packages/cli/src/daemon.ts:700-837
SHA256: 9e5ef8efa61a61f41094aeb2ac56140f94c3ead9fa9339578615c2881c9448e2

```text
700:   if (typeof p["text"] !== "string" || p["text"].trim() === "" || p["text"].length > 16_000) {
701:     return new Error("params.text must be between 1 and 16000 characters");
702:   }
703:   if (p["requested_by"] !== undefined && (
704:     typeof p["requested_by"] !== "string"
705:     || p["requested_by"].trim() === ""
706:     || p["requested_by"].length > 256
707:   )) {
708:     return new Error("params.requested_by must be a non-empty string of at most 256 characters");
709:   }
710:   return {
711:     session_id: p["session_id"] as string,
712:     runtime_id: p["runtime_id"] as string,
713:     turn_id: p["turn_id"] as string,
714:     message_id: p["message_id"] as string,
715:     expected_version: p["expected_version"] as number,
716:     text: p["text"] as string,
717:     ...(p["requested_by"] === undefined ? {} : { requested_by: p["requested_by"] as string }),
718:   };
719: }
720: 
721: async function handleSessionSend(
722:   ctx: DaemonContext,
723:   req: DaemonRequest,
724: ): Promise<SingleResponse> {
725:   const p = parseSessionSendParams(req.params);
726:   if (p instanceof Error) return singleErr(req.id, "bad_request", p.message);
727:   // Completed receipt replay remains read-only while drained; no new/retried
728:   // instruction may reserve a message or invoke an adapter during an upgrade.
729:   if (ctx.draining && ctx.sessions.getMessage(p.message_id)?.state !== "applied") {
730:     return singleErr(req.id, "draining", "daemon is not accepting session instructions");
731:   }
732: 
733:   const session = ctx.sessions.getSession(p.session_id);
734:   if (session === undefined) return singleErr(req.id, "not_found", "session not found");
735:   if (p.runtime_id !== session.agent_id) {
736:     return singleErr(req.id, "runtime_mismatch", "session belongs to another runtime");
737:   }
738:   // Idempotency wins over moving state: a retry may arrive after the first
739:   // delivery already appended a newer turn or completed the conversation.
740:   // Let the repository compare the complete canonical envelope before any
741:   // current-turn/current-state guards reject it.
742:   const existingMessage = ctx.sessions.getMessage(p.message_id);
743:   let recoveredReservationVersion: number | undefined;
744:   if (existingMessage !== undefined) {
745:     try {
746:       const replay = ctx.sessions.applyInbound({
747:         message_id: p.message_id,
748:         session_id: p.session_id,
749:         turn_id: p.turn_id,
750:         direction: "inbound",
751:         kind: "instruction.send",
752:         payload: { text: p.text, ...(p.requested_by === undefined ? {} : { requested_by: p.requested_by }) },
753:         state: "accepted",
754:         created_at: Date.now() / 1000,
755:       }, p.expected_version, Date.now() / 1000);
756:       if (existingMessage.state === "applied") {
757:         return singleOk(req.id, { state: replay.outcome, session_version: replay.session_version });
758:       }
759:       if (replay.session_version !== p.expected_version + 1) {
760:         return singleErr(req.id, "version_conflict", "accepted message cannot be recovered safely");
761:       }
762:       if (existingMessage.state === "accepted") {
763:         return ctx.activeSessionSends.has(session.session_id)
764:           ? singleErr(req.id, "session_busy", "session is already applying another instruction")
765:           : singleErr(
766:               req.id,
767:               "delivery_uncertain",
768:               "the previous delivery may have reached the agent; inspect the session before using a new message_id",
769:             );
770:       }
771:       if (existingMessage.state !== "failed") {
772:         return singleErr(req.id, "version_conflict", "reserved message is not retryable");
773:       }
774:       ctx.sessions.retryFailedMessage(p.message_id);
775:       recoveredReservationVersion = replay.session_version;
776:     } catch (err) {
777:       if (err instanceof SessionMessageIdConflict) {
778:         return singleErr(req.id, "message_id_conflict", "message_id was already used for different content");
779:       }
780:       throw err;
781:     }
782:   }
783:   if (recoveredReservationVersion === undefined && TERMINAL_SESSION_STATES.has(session.state)) {
784:     return singleErr(req.id, "session_terminal", `session state=${session.state}`);
785:   }
786:   if (!session.resume_supported || session.native_session_id === null) {
787:     return singleErr(req.id, "resume_unsupported", "session cannot be resumed");
788:   }
789:   const snapshot = ctx.sessions.latestSnapshot(p.session_id);
790:   if (recoveredReservationVersion === undefined && snapshot.turn_id !== p.turn_id) {
791:     return singleErr(req.id, "turn_conflict", "message does not target the current turn");
792:   }
793:   const adapter = ctx.adapters.get(session.agent_id);
794:   if (adapter === undefined || !isSessionCapableAdapter(adapter) || !adapter.sessionCapabilities().resume) {
795:     return singleErr(req.id, "resume_unsupported", "agent does not support resume");
796:   }
797:   if (ctx.activeSessionSends.has(session.session_id)) {
798:     return singleErr(req.id, "session_busy", "session is already applying another instruction");
799:   }
800: 
801:   let applied: { outcome: "applied" | "duplicate"; session_version: number };
802:   const now = Date.now() / 1000;
803:   if (recoveredReservationVersion !== undefined) {
804:     applied = { outcome: "applied", session_version: recoveredReservationVersion };
805:   } else {
806:     try {
807:       applied = ctx.sessions.applyInbound({
808:         message_id: p.message_id,
809:         session_id: p.session_id,
810:         turn_id: p.turn_id,
811:         direction: "inbound",
812:         kind: "instruction.send",
813:         payload: { text: p.text, ...(p.requested_by === undefined ? {} : { requested_by: p.requested_by }) },
814:         state: "accepted",
815:         created_at: now,
816:       }, p.expected_version, now);
817:     } catch (err) {
818:       if (err instanceof SessionVersionConflict) {
819:         return singleErr(req.id, "version_conflict", "session version changed; refresh before retrying");
820:       }
821:       if (err instanceof SessionMessageIdConflict) {
822:         return singleErr(req.id, "message_id_conflict", "message_id was already used for different content");
823:       }
824:       throw err;
825:     }
826:   }
827:   if (applied.outcome === "duplicate") {
828:     return singleOk(req.id, { state: "duplicate", session_version: applied.session_version });
829:   }
830: 
831:   return await executeReservedSessionTurn(ctx, req, p, session, adapter, applied.session_version);
832: }
833: 
834: /** Private port: only an already persisted reservation may invoke the runtime. */
835: async function executeReservedSessionTurn(
836:   ctx: DaemonContext,
837:   req: DaemonRequest,
```

## O14: packages/core/src/state/sessions.ts:290-383
SHA256: 923c69781b1bdf9370e92cefeaef2fdb8128c2105eb5bf20f4163d37d84d5710

```text
290:           .get(turn.session_id) as { version: number } | undefined;
291:         throw new SessionVersionConflict(
292:           turn.session_id,
293:           input.expected_version,
294:           actual?.version ?? null,
295:         );
296:       }
297: 
298:       db.prepare(`
299:         INSERT INTO session_turns(
300:           turn_id,session_id,ordinal,state,assistant_text,decision_json,created_at,updated_at
301:         ) VALUES (?,?,?,?,?,?,?,?)
302:       `).run(
303:         turn.turn_id,
304:         turn.session_id,
305:         turn.ordinal,
306:         turn.state,
307:         turn.assistant_text,
308:         turn.decision_json,
309:         turn.created_at,
310:         turn.updated_at,
311:       );
312: 
313:       const applied = db.prepare(`
314:         UPDATE session_messages
315:         SET state = 'applied', applied_at = ?
316:         WHERE message_id = ? AND state = 'accepted'
317:       `).run(input.applied_at, input.message_id);
318:       if (applied.changes !== 1) {
319:         throw new Error(`message ${input.message_id} could not be marked applied`);
320:       }
321:       return this.readSession(db, turn.session_id);
322:     });
323:   }
324: 
325:   getMessage(messageId: string): SessionMessageRowType | undefined {
326:     const row = this.db.prepare("SELECT * FROM session_messages WHERE message_id = ?")
327:       .get(messageId) as SessionMessageRowType | undefined;
328:     return row ? SessionMessageRow.parse(row) : undefined;
329:   }
330: 
331:   latestSnapshot(sessionId: string): SessionSnapshot {
332:     const session = this.readSession(this.db, sessionId);
333:     const turn = this.db.prepare(`
334:       SELECT * FROM session_turns WHERE session_id = ? ORDER BY ordinal DESC LIMIT 1
335:     `).get(sessionId) as SessionTurnRowType | undefined;
336:     const parsedTurn = turn ? SessionTurnRow.parse(turn) : undefined;
337:     return {
338:       session_id: session.session_id,
339:       task_id: session.task_id,
340:       run_id: session.run_id,
341:       agent_id: session.agent_id,
342:       runtime_id: session.agent_id,
343:       state: session.state,
344:       version: session.version,
345:       turn_id: parsedTurn?.turn_id ?? null,
346:       assistant_text: parsedTurn?.assistant_text ?? "",
347:       decision: parsedTurn?.decision_json ? JSON.parse(parsedTurn.decision_json) : null,
348:       updated_at: session.updated_at,
349:     };
350:   }
351: 
352:   listSessions(filter: SessionFilter = {}): AgentSessionRowType[] {
353:     const where: string[] = [];
354:     const values: Array<string | number> = [];
355:     if (filter.agent_id !== undefined) {
356:       where.push("agent_id = ?");
357:       values.push(filter.agent_id);
358:     }
359:     if (filter.state !== undefined) {
360:       AgentSessionState.parse(filter.state);
361:       where.push("state = ?");
362:       values.push(filter.state);
363:     }
364:     if (filter.task_id !== undefined) {
365:       where.push("task_id = ?");
366:       values.push(filter.task_id);
367:     }
368:     const limit = filter.limit ?? 200;
369:     if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
370:       throw new Error("session list limit must be an integer between 1 and 200");
371:     }
372:     values.push(limit);
373:     const sql = `SELECT * FROM agent_sessions${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, session_id LIMIT ?`;
374:     return (this.db.prepare(sql).all(...values) as RawSessionRow[]).map(parseSession);
375:   }
376: 
377:   private updateSession(
378:     sessionId: string,
379:     expectedVersion: number,
380:     updatedAt: number,
381:     assignment: string,
382:     values: unknown[],
383:   ): AgentSessionRowType {
```

## O15: packages/core/src/state/migrations.ts:1225-1356
SHA256: ebf89e8eaceb6fafabcac61748777d6e6dcaabbcf9e67a53aff1d35a73396c61

```text
1225:   {
1226:     id: 21,
1227:     name: "resumable_agent_sessions",
1228:     // Durable native-agent session identity and idempotent local input reservation.
1229:     // Tool arguments, command output and reasoning never enter these tables.
1230:     sql: `
1231:       CREATE TABLE IF NOT EXISTS agent_sessions (
1232:         session_id        TEXT PRIMARY KEY,
1233:         task_id           TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
1234:         run_id            TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
1235:         agent_id          TEXT NOT NULL,
1236:         request_sha256    TEXT NOT NULL CHECK (
1237:           length(request_sha256) = 64 AND
1238:           request_sha256 NOT GLOB '*[^0-9a-f]*'
1239:         ),
1240:         native_session_id TEXT,
1241:         state             TEXT NOT NULL CHECK (state IN (
1242:           'starting','running','awaiting_decision','idle','completed','failed','cancelled'
1243:         )),
1244:         resume_supported  INTEGER NOT NULL CHECK (resume_supported IN (0,1)),
1245:         version           INTEGER NOT NULL CHECK (version > 0),
1246:         updated_at        REAL NOT NULL
1247:       );
1248:       CREATE INDEX IF NOT EXISTS idx_agent_sessions_task
1249:         ON agent_sessions(task_id, updated_at DESC);
1250:       CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent_state
1251:         ON agent_sessions(agent_id, state, updated_at DESC);
1252: 
1253:       CREATE TABLE IF NOT EXISTS session_turns (
1254:         turn_id        TEXT PRIMARY KEY,
1255:         session_id     TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
1256:         ordinal        INTEGER NOT NULL CHECK (ordinal > 0),
1257:         state          TEXT NOT NULL CHECK (state IN (
1258:           'starting','running','awaiting_decision','idle','completed','failed','cancelled'
1259:         )),
1260:         assistant_text TEXT NOT NULL DEFAULT '',
1261:         decision_json  TEXT,
1262:         created_at     REAL NOT NULL,
1263:         updated_at     REAL NOT NULL,
1264:         UNIQUE(session_id, ordinal)
1265:       );
1266:       CREATE INDEX IF NOT EXISTS idx_session_turns_session_ordinal
1267:         ON session_turns(session_id, ordinal DESC);
1268: 
1269:       CREATE TABLE IF NOT EXISTS session_messages (
1270:         message_id   TEXT PRIMARY KEY,
1271:         session_id   TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
1272:         turn_id      TEXT NOT NULL,
1273:         direction    TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
1274:         kind         TEXT NOT NULL,
1275:         payload_json TEXT NOT NULL,
1276:         state        TEXT NOT NULL CHECK (state IN ('pending','accepted','applied','failed')),
1277:         created_at   REAL NOT NULL,
1278:         applied_at   REAL
1279:       );
1280:       CREATE INDEX IF NOT EXISTS idx_session_messages_session_state
1281:         ON session_messages(session_id, state, created_at);
1282:       CREATE INDEX IF NOT EXISTS idx_session_messages_turn
1283:         ON session_messages(turn_id, created_at);
1284:     `,
1285:   },
1286:   {
1287:     id: 22,
1288:     name: "agent_session_repo_path",
1289:     // Claude Code resolves persisted native sessions within the original cwd.
1290:     // Existing rows remain empty until an operator performs a verified local
1291:     // backfill; all newly created governed sessions persist the absolute path.
1292:     sql: `
1293:       ALTER TABLE agent_sessions ADD COLUMN repo_path TEXT NOT NULL DEFAULT '';
1294:     `,
1295:   },
1296:   {
1297:     id: 23,
1298:     name: "pitfall_observation_provenance",
1299:     // Legacy verified_count/source_run_ids mixed failures and unrelated
1300:     // successful runs. Preserve them verbatim; only new explicit observations
1301:     // populate this column. Never infer a verified-use history from old counts.
1302:     sql: `
1303:       ALTER TABLE pitfall_lessons
1304:         ADD COLUMN observation_run_ids_json TEXT NOT NULL DEFAULT '[]';
1305:     `,
1306:   },
1307:   {
1308:     id: 24,
1309:     name: "session_continuation_grants",
1310:     sql: `
1311:       CREATE TABLE session_continuation_grants (
1312:         grant_id TEXT PRIMARY KEY,
1313:         session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
1314:         body_json TEXT NOT NULL,
1315:         digest TEXT NOT NULL,
1316:         key_id TEXT NOT NULL,
1317:         signature TEXT NOT NULL,
1318:         status TEXT NOT NULL CHECK (status IN ('active','completed','blocked','revoked')),
1319:         reason TEXT,
1320:         step_index INTEGER NOT NULL DEFAULT 0 CHECK (step_index >= 0),
1321:         checks_used INTEGER NOT NULL DEFAULT 0 CHECK (checks_used >= 0),
1322:         resumes_used INTEGER NOT NULL DEFAULT 0 CHECK (resumes_used >= 0),
1323:         retries_used INTEGER NOT NULL DEFAULT 0 CHECK (retries_used >= 0),
1324:         expected_turn_id TEXT NOT NULL,
1325:         expected_version INTEGER NOT NULL CHECK (expected_version > 0),
1326:         created_at REAL NOT NULL,
1327:         updated_at REAL NOT NULL
1328:       );
1329:       CREATE UNIQUE INDEX idx_session_continuation_one_active
1330:         ON session_continuation_grants(session_id) WHERE status = 'active';
1331:       CREATE INDEX idx_session_continuation_session
1332:         ON session_continuation_grants(session_id, created_at DESC, grant_id);
1333:       CREATE TABLE session_continuation_attempts (
1334:         attempt_id TEXT PRIMARY KEY,
1335:         grant_id TEXT NOT NULL REFERENCES session_continuation_grants(grant_id) ON DELETE CASCADE,
1336:         step_index INTEGER NOT NULL CHECK (step_index >= 0),
1337:         source_turn_id TEXT NOT NULL,
1338:         source_version INTEGER NOT NULL CHECK (source_version > 0),
1339:         decision_sha256 TEXT NOT NULL,
1340:         status TEXT NOT NULL CHECK (status IN ('checking','reserved','applied','blocked','abandoned')),
1341:         check_result_json TEXT,
1342:         message_id TEXT UNIQUE REFERENCES session_messages(message_id),
1343:         reservation_version INTEGER,
1344:         action TEXT CHECK (action IN ('continue','retry')),
1345:         completed_turn_id TEXT,
1346:         completed_version INTEGER,
1347:         reason TEXT,
1348:         created_at REAL NOT NULL,
1349:         updated_at REAL NOT NULL
1350:       );
1351:       CREATE UNIQUE INDEX idx_session_continuation_one_attempt
1352:         ON session_continuation_attempts(grant_id) WHERE status IN ('checking','reserved');
1353:     `,
1354:   },
1355: ];
1356: 
```

## O16: packages/supervisor/package.json:1-36
SHA256: 65116c1d6a4880b013aa09f21afc3f83839170e9173a799f014077d60ec1ddcd

```text
1: {
2:   "name": "@osstack/supervisor",
3:   "version": "0.19.0",
4:   "description": "Portfolio repo supervision and closed-loop maturity control plane for osstack.",
5:   "license": "MIT",
6:   "private": true,
7:   "type": "module",
8:   "main": "./dist/index.js",
9:   "types": "./dist/index.d.ts",
10:   "files": [
11:     "dist"
12:   ],
13:   "scripts": {
14:     "build": "tsc -p .",
15:     "prepack": "node ../../scripts/prepare-npm-package.mjs",
16:     "test": "vitest run --passWithNoTests",
17:     "typecheck": "tsc --noEmit"
18:   },
19:   "dependencies": {
20:     "@osstack/core": "workspace:*",
21:     "@osstack/governance": "workspace:*",
22:     "@osstack/loop": "workspace:*",
23:     "zod": "^3.25.76"
24:   },
25:   "devDependencies": {
26:     "@types/node": "^22.19.19"
27:   },
28:   "repository": {
29:     "type": "git",
30:     "url": "https://github.com/gilosbornhello/osstack.git",
31:     "directory": "packages/supervisor"
32:   },
33:   "engines": {
34:     "node": ">=20"
35:   }
36: }
```

## O17: packages/cli/src/graph-command.ts:78-98
SHA256: 486a8dfa8303f6daa8824c85c739337e7fcd6c078dc27f29f9ed211662bdd98b

```text
78: 
79: export function explainGraph(input: GraphExplainInput) {
80:   if (!isAbsolute(input.dbPath) || !isAbsolute(input.statePath)) throw new Error("--db and --state must be absolute paths");
81:   if (!input.taskId || !input.board || input.tenantId === "" || input.tenantId === undefined) throw new Error("Explicit task, board and tenant scope required");
82:   const dbPath = realpathSync(input.dbPath);
83:   if (!statSync(dbPath).isFile()) throw new Error("Database must be an existing regular file");
84:   guardDatabasePath(dbPath);
85:   const statePath = realpathSync(input.statePath);
86:   const { state, sha256 } = readState(statePath);
87:   // Do not use core openDb: even its readonly mode sets database pragmas.
88:   const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 1000 });
89:   let facts: ReturnType<typeof readFacts>;
90:   try { facts = db.transaction(() => readFacts(db, input))(); }
91:   catch (error) {
92:     if (error instanceof Database.SqliteError) throw new Error(`Cannot read graph source tables/columns: ${error.message}`);
93:     throw error;
94:   }
95:   finally { db.close(); }
96:   const matches: LoopMatch[] = [];
97:   const locationCounts = { completed_tasks: 0, in_progress: 0, pending: 0, deferred_tasks: 0 };
98:   function addMatch(match: LoopMatch) {
```

## O18: packages/core/src/state/migrations.ts:12-68
SHA256: ebf89e8eaceb6fafabcac61748777d6e6dcaabbcf9e67a53aff1d35a73396c61

```text
12: export const MIGRATIONS: readonly Migration[] = [
13:   {
14:     id: 1,
15:     name: "initial_schema",
16:     sql: `
17:       CREATE TABLE IF NOT EXISTS tasks (
18:         task_id            TEXT PRIMARY KEY,
19:         title              TEXT NOT NULL,
20:         description        TEXT NOT NULL DEFAULT '',
21:         hermes_session_id  TEXT,
22:         status             TEXT NOT NULL CHECK (status IN ('pending','running','done','failed','cancelled')),
23:         created_at         REAL NOT NULL,
24:         updated_at         REAL NOT NULL
25:       );
26: 
27:       CREATE TABLE IF NOT EXISTS runs (
28:         run_id                    TEXT PRIMARY KEY,
29:         task_id                   TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
30:         session_id                TEXT NOT NULL,
31:         agent_id                  TEXT NOT NULL,
32:         capability_id             TEXT NOT NULL,
33:         phase                     TEXT NOT NULL,
34:         outcome                   TEXT,
35:         started_at                REAL NOT NULL,
36:         completed_at              REAL,
37:         duration_ms               REAL,
38:         tokens_in                 INTEGER NOT NULL DEFAULT 0,
39:         tokens_out                INTEGER NOT NULL DEFAULT 0,
40:         retry_count               INTEGER NOT NULL DEFAULT 0,
41:         human_intervention_count  INTEGER NOT NULL DEFAULT 0,
42:         pii_redacted_count        INTEGER NOT NULL DEFAULT 0,
43:         gbrain_page_id            TEXT,
44:         hermes_session_id         TEXT,
45:         last_step                 TEXT
46:       );
47:       CREATE INDEX IF NOT EXISTS idx_runs_task     ON runs(task_id);
48:       CREATE INDEX IF NOT EXISTS idx_runs_agent    ON runs(agent_id);
49:       CREATE INDEX IF NOT EXISTS idx_runs_phase    ON runs(phase);
50:       CREATE INDEX IF NOT EXISTS idx_runs_outcome  ON runs(outcome);
51: 
52:       CREATE TABLE IF NOT EXISTS events (
53:         event_id      TEXT PRIMARY KEY,
54:         run_id        TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
55:         session_id    TEXT NOT NULL,
56:         seq           INTEGER NOT NULL,
57:         type          TEXT NOT NULL,
58:         created_at    REAL NOT NULL,
59:         terminal      INTEGER NOT NULL DEFAULT 0,
60:         payload_json  TEXT NOT NULL
61:       );
62:       CREATE UNIQUE INDEX IF NOT EXISTS uq_events_run_seq ON events(run_id, seq);
63:       CREATE INDEX IF NOT EXISTS idx_events_run            ON events(run_id);
64:       CREATE INDEX IF NOT EXISTS idx_events_type           ON events(type);
65: 
66:       CREATE TABLE IF NOT EXISTS agents (
67:         agent_id      TEXT PRIMARY KEY,
68:         display_name  TEXT NOT NULL,
```

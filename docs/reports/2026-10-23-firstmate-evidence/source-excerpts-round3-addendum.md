# Round 3 source verification

## O19 packages/core/src/state/migrations.ts:125-151
SHA256: ebf89e8eaceb6fafabcac61748777d6e6dcaabbcf9e67a53aff1d35a73396c61

```text
125:   {
126:     id: 3,
127:     name: "multi_tenant_columns",
128:     // Multi-tenancy (partneros-analysis.md §五.10 / 路径 A 项 10).
129:     //
130:     // Strategy: ALTER TABLE ... ADD COLUMN tenant_id (nullable) on every
131:     // domain table. NULL means "default tenant" — i.e. single-tenant
132:     // installations keep working unchanged. Compound indexes on
133:     // (tenant_id, subject_id, status) speed up tenant-scoped reads.
134:     //
135:     // SQLite limitation: cannot ALTER an existing CHECK constraint or PK,
136:     // so we don't add tenant_id to PRIMARY KEY. The application is the
137:     // gatekeeper for "no cross-tenant fact ids".
138:     sql: `
139:       ALTER TABLE memory_facts ADD COLUMN tenant_id TEXT;
140:       CREATE INDEX IF NOT EXISTS idx_memory_facts_tenant_subject
141:         ON memory_facts(tenant_id, subject_type, subject_id, status);
142: 
143:       ALTER TABLE tasks ADD COLUMN tenant_id TEXT;
144:       CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(tenant_id);
145: 
146:       ALTER TABLE runs ADD COLUMN tenant_id TEXT;
147:       CREATE INDEX IF NOT EXISTS idx_runs_tenant ON runs(tenant_id);
148: 
149:       ALTER TABLE approvals ADD COLUMN tenant_id TEXT;
150:       CREATE INDEX IF NOT EXISTS idx_approvals_tenant ON approvals(tenant_id);
151: 
```

## O20 packages/core/src/state/session-continuations.ts:135-155
SHA256: c400826b890a4d1fd249796195c7ad5e3e2b071065740498ed46c4fd7bdb6651

```text
135:   beginCheck(id: string, now: number): BeginContinuationCheckResult {
136:     timestamp(now);
137:     return withWrite(this.db, this.path, () => {
138:       const grant = this.requireGrant(id);
139:       if (grant.status !== "active") return this.blocked(grant, grant.reason ?? `grant_${grant.status}`, now);
140:       if (now < Date.parse(grant.body.issued_at) / 1000 || now >= Date.parse(grant.body.expires_at) / 1000) {
141:         return this.blocked(grant, "expired", now);
142:       }
143:       const pending = this.db.prepare(`SELECT attempt_id FROM session_continuation_attempts
144:         WHERE grant_id = ? AND status IN ('checking','reserved')`).get(id) as { attempt_id: string } | undefined;
145:       if (pending !== undefined) return { outcome: "busy", grant, attempt: this.requireAttempt(pending.attempt_id) };
146:       const inspected = this.inspect(grant, now, true);
147:       if (!inspected.ok) return this.blocked(grant, inspected.reason, now);
148:       const attemptId = `cont_attempt_${sha(canonical([id, grant.checks_used + 1]))}`;
149:       this.db.prepare(`UPDATE session_continuation_grants SET checks_used = checks_used + 1, updated_at = ? WHERE grant_id = ?`).run(now, id);
150:       this.db.prepare(`INSERT INTO session_continuation_attempts
151:         (attempt_id,grant_id,step_index,source_turn_id,source_version,decision_sha256,status,created_at,updated_at)
152:         VALUES (?,?,?,?,?,?,'checking',?,?)`).run(attemptId, id, grant.step_index, grant.expected_turn_id,
153:         grant.expected_version, inspected.decisionDigest, now, now);
154:       return { outcome: "checking", grant: this.requireGrant(id), attempt: this.requireAttempt(attemptId),
155:         session: inspected.session, step: inspected.step };
```

## O21 packages/core/src/state/session-continuations.ts:274-306
SHA256: c400826b890a4d1fd249796195c7ad5e3e2b071065740498ed46c4fd7bdb6651

```text
274:   private inspect(grant: SessionContinuationGrantView, now: number, consumeCheck: boolean):
275:     { ok: false; reason: string } | { ok: true; session: SessionSnapshot; step: ContinuationGrantStep; decisionDigest: string } {
276:     const deny = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
277:     if (grant.status !== "active") return deny(grant.reason ?? `grant_${grant.status}`);
278:     if (now < Date.parse(grant.body.issued_at) / 1000 || now >= Date.parse(grant.body.expires_at) / 1000) return deny("expired");
279:     if (consumeCheck && grant.checks_used >= grant.body.max_checks) return deny("checks_exhausted");
280:     if (grant.resumes_used >= grant.body.max_resumes) return deny("resumes_exhausted");
281:     const bound = this.sessions.getSession(grant.session_id);
282:     if (bound === undefined || bound.agent_id !== grant.body.runtime_id || bound.repo_path !== grant.body.repo_path
283:       || !bound.resume_supported || !bound.native_session_id) return deny("session_binding_changed");
284:     const session = this.sessions.latestSnapshot(grant.session_id);
285:     if (session.turn_id !== grant.expected_turn_id || session.version !== grant.expected_version) return deny("cursor_changed");
286:     const turn = this.db.prepare("SELECT state FROM session_turns WHERE turn_id = ?").get(session.turn_id) as { state: string } | undefined;
287:     if (session.state !== "awaiting_decision" || turn?.state !== "awaiting_decision") return deny("session_not_awaiting_decision");
288:     if (this.hasUnresolvedReceipt(grant.session_id)) return deny("unresolved_receipt");
289:     const step = grant.body.steps[grant.step_index];
290:     const parsed = SessionDecision.safeParse(session.decision);
291:     if (step === undefined || !parsed.success || parsed.data.continuation?.gate_kind !== "phase_continue"
292:       || parsed.data.continuation.phase !== step.phase) return deny("decision_not_authorized");
293:     return { ok: true, session, step, decisionDigest: sha(canonical(parsed.data)) };
294:   }
295:   private hasUnresolvedReceipt(sessionId: string): boolean {
296:     return this.db.prepare(`SELECT 1 FROM session_messages WHERE session_id = ? AND direction = 'inbound'
297:       AND state IN ('accepted','failed') LIMIT 1`).get(sessionId) !== undefined;
298:   }
299:   private blocked(grant: SessionContinuationGrantView, reason: string, now: number): Blocked {
300:     return { outcome: "blocked", grant: this.block(grant.grant_id, reason, now), reason };
301:   }
302:   private blockAttempt(attempt: SessionContinuationAttemptView, reason: string, now: number): Blocked {
303:     this.db.prepare(`UPDATE session_continuation_attempts SET status = 'blocked', reason = ?, updated_at = ?
304:       WHERE attempt_id = ? AND status IN ('checking','reserved')`).run(reason, now, attempt.attempt_id);
305:     return this.blocked(this.requireGrant(attempt.grant_id), reason, now);
306:   }
```

## O22 packages/core/src/state/session-continuations.ts:178-235
SHA256: c400826b890a4d1fd249796195c7ad5e3e2b071065740498ed46c4fd7bdb6651

```text
178:       }
179:       if (grant.resumes_used >= grant.body.max_resumes) return this.blockAttempt(attempt, "resumes_exhausted", now);
180:       const messageId = `cont_message_${sha(attemptId)}`;
181:       // Reservation, budget consumption and attempt transition share a transaction.
182:       const receipt = this.sessions.applyInbound({ message_id: messageId, session_id: grant.session_id,
183:         turn_id: attempt.source_turn_id, direction: "inbound", kind: "instruction.send", state: "accepted",
184:         payload: { text: prompt, requested_by: `agent:collaborator:${grant.grant_id}` }, created_at: now }, attempt.source_version, now);
185:       if (receipt.outcome !== "applied") throw new Error("continuation message reservation collision");
186:       this.db.prepare(`UPDATE session_continuation_attempts SET status = 'reserved', message_id = ?,
187:         reservation_version = ?, action = ?, updated_at = ? WHERE attempt_id = ?`)
188:         .run(messageId, receipt.session_version, action, now, attemptId);
189:       this.db.prepare(`UPDATE session_continuation_grants SET resumes_used = resumes_used + 1,
190:         retries_used = retries_used + ?, updated_at = ? WHERE grant_id = ?`).run(action === "retry" ? 1 : 0, now, grant.grant_id);
191:       return { outcome: "reserved", grant: this.requireGrant(grant.grant_id), attempt: this.requireAttempt(attemptId),
192:         message: this.sessions.getMessage(messageId)!, prompt, reservation_version: receipt.session_version };
193:     });
194:   }
195: 
196:   /** Call inside the same outer transaction as SessionRepository.completeInboundTurn. */
197:   completeAttempt(attemptId: string, newTurnId: string, newVersion: number, now: number): SessionContinuationGrantView {
198:     timestamp(now);
199:     return withWrite(this.db, this.path, () => {
200:       const attempt = this.requireAttempt(attemptId);
201:       const grant = this.requireGrant(attempt.grant_id);
202:       if (attempt.status === "applied") {
203:         if (attempt.completed_turn_id !== newTurnId || attempt.completed_version !== newVersion) throw new Error("continuation completion conflict");
204:         return grant;
205:       }
206:       const session = this.sessions.latestSnapshot(grant.session_id);
207:       const receipt = attempt.message_id === null ? undefined : this.sessions.getMessage(attempt.message_id);
208:       if (attempt.status !== "reserved" || attempt.reservation_version === null || newVersion !== attempt.reservation_version + 1
209:         || newTurnId === attempt.source_turn_id || session.turn_id !== newTurnId || session.version !== newVersion || receipt?.state !== "applied"
210:         || receipt.session_id !== grant.session_id || receipt.turn_id !== attempt.source_turn_id
211:         || attempt.step_index !== grant.step_index || grant.expected_turn_id !== attempt.source_turn_id
212:         || grant.expected_version !== attempt.source_version) throw new Error("continuation completion cursor or receipt conflict");
213:       const nextStep = grant.step_index + (attempt.action === "continue" ? 1 : 0);
214:       // A concurrent revoke cannot undo a real receipt, nor may completion revive it.
215:       // Check wall time as well as the daemon's abort timer: an event-loop stall
216:       // can deliver a completed event before a delayed timeout callback runs.
217:       let status = grant.status;
218:       let reason = grant.reason;
219:       if (status === "active") {
220:         if (now >= Date.parse(grant.body.expires_at) / 1000) {
221:           status = "blocked";
222:           reason = "expired";
223:         } else if (now >= receipt.created_at + grant.body.turn_timeout_ms / 1000) {
224:           status = "blocked";
225:           reason = "turn_timeout";
226:         } else if (nextStep >= grant.body.steps.length) status = "completed";
227:       }
228:       this.db.prepare(`UPDATE session_continuation_attempts SET status = 'applied', completed_turn_id = ?,
229:         completed_version = ?, updated_at = ? WHERE attempt_id = ?`).run(newTurnId, newVersion, now, attemptId);
230:       this.db.prepare(`UPDATE session_continuation_grants SET step_index = ?, retries_used = ?, expected_turn_id = ?,
231:         expected_version = ?, status = ?, reason = ?, updated_at = ? WHERE grant_id = ?`).run(nextStep,
232:         attempt.action === "continue" ? 0 : grant.retries_used, newTurnId, newVersion, status, reason, now, grant.grant_id);
233:       return this.requireGrant(grant.grant_id);
234:     });
235:   }
```

## O23 packages/loop/src/loop-engine.ts:1199-1223
SHA256: 26636b8a432d928efbaa85d516528d66d560d14229c98a57dc6cc786a2516f71

```text
1199:   private async cleanupLoopWorktrees(
1200:     loopId: string,
1201:     workspacePath: string,
1202:     cycle: number,
1203:     phase: "before_cycle" | "after_cycle",
1204:     decisions: string[],
1205:   ): Promise<void> {
1206:     if (this.options.useWorktree !== true) return;
1207:     const result = await cleanupOrphanedWorktrees(workspacePath, {
1208:       branchPrefix: loopWorktreeBranchPrefix(loopId),
1209:       ...(this.options.worktreeRoot !== undefined ? { rootPath: this.options.worktreeRoot } : {}),
1210:     });
1211:     if (result.removed.length === 0) return;
1212:     this.emit(loopId, "loop.worktree.orphans_cleaned", {
1213:       cycle,
1214:       phase,
1215:       removed_count: result.removed.length,
1216:       branches: result.removed.map((worktree) => worktree.branch),
1217:     });
1218:     decisions.push(`worktree cleanup: removed ${result.removed.length} orphaned worktree(s) ${phase}`);
1219:   }
1220: 
1221:   private emit(loopId: string, type: LoopEvent["type"], payload?: Record<string, unknown>): void {
1222:     this.events.push({
1223:       event_id: `evt_${randomUUID()}`,
```

## O24 packages/agents/src/adapters/codex-cli.ts:365-394
SHA256: b3395ca0959a1aa029b0b6de43104f914eb1aa9f7aac1b148587562a116811ba

```text
365:   }
366: 
367:   startSession(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentSessionEvent> {
368:     const cwd = typeof task.context?.["repo_path"] === "string"
369:       ? task.context["repo_path"]
370:       : this.cwd;
371:     return this.runSession([
372:       "exec", "--json", "--skip-git-repo-check",
373:       "-s", this.sandbox, "-C", cwd, task.prompt,
374:     ], signal);
375:   }
376: 
377:   resumeSession(input: AgentSessionInput, signal: AbortSignal): AsyncIterable<AgentSessionEvent> {
378:     const cwd = typeof input.context?.["repo_path"] === "string"
379:       ? input.context["repo_path"]
380:       : this.cwd;
381:     // Current Codex CLI models resume as an exec subcommand. Parent flags must
382:     // precede `resume`; the fake-binary test locks this argv contract.
383:     return this.runSession([
384:       "exec", "--json", "--skip-git-repo-check",
385:       "-s", this.sandbox, "-C", cwd,
386:       "resume", input.native_session_id, input.prompt,
387:     ], signal, input.native_session_id);
388:   }
389: 
390:   private async *runSession(
391:     args: string[],
392:     signal: AbortSignal,
393:     expectedNativeSessionId?: string,
394:   ): AsyncIterable<AgentSessionEvent> {
```
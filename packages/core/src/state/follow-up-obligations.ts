import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import { FollowUpCreateParams, FollowUpListParams, FollowUpDraftParams, FollowUpResolveParams,
  FollowUpSourceSnapshot, FollowUpObligation, FollowUpMutationResult, FollowUpListResult,
  type FollowUpSourceSnapshot as Source, type FollowUpObligation as Obligation } from "@osstack/protocol";
import { withWrite } from "./db.js";

export const FOLLOW_UP_MAX_BYTES = 65536;
export const FOLLOW_UP_ERROR_CODES = ["invalid_follow_up_request", "follow_up_repository_unavailable", "follow_up_source_unavailable", "follow_up_source_revision_conflict",
  "follow_up_idempotency_conflict", "follow_up_not_found", "follow_up_revision_conflict", "follow_up_terminal", "follow_up_condition_not_met",
  "follow_up_database_unavailable", "follow_up_response_too_large", "follow_up_invalid_cursor", "follow_up_invalid_clock", "follow_up_unsupported_method"] as const;
export class FollowUpError extends Error { constructor(readonly code: typeof FOLLOW_UP_ERROR_CODES[number]) { super(code); this.name = "FollowUpError"; } }
export function serializeFollowUp(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\p{Cf}]/gu, character => character.split("").map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
}
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
interface Row {
  obligation_id: string; repo_path: string; source_session_id: string; source_task_id: string; source_run_id: string; source_creation_version: number; source_identity_digest: string;
  actor: string; promise: string; destination_ref: "local_operator"; resolution_condition: "manual" | "session_completed"; due_at: number | null;
  create_digest: string; state: Obligation["state"]; revision: number; created_at: number; updated_at: number; draft_json: string | null; resolution_json: string | null;
}
interface BoundSource extends Source { task_id: string; run_id: string; identity_digest: string }
const Cursor = z.object({ scope: z.string().regex(/^[a-f0-9]{64}$/), created_at: z.number().int().nonnegative().max(8_640_000_000_000_000), id: z.string().uuid() }).strict();

/** Local state only. The daemon owns authentication, DB access and migrations. */
export class FollowUpObligationService {
  private readonly now: () => number;
  constructor(private readonly db: Database.Database, private readonly dbPath: string, options: { nowMs?: () => number } = {}) { this.now = options.nowMs ?? Date.now; }
  handle(method: string, input: unknown): FollowUpMutationResult | FollowUpListResult {
    switch (method) {
      case "follow-up.create": return this.create(input);
      case "follow-up.list": return this.list(input);
      case "follow-up.draft": return this.draft(input);
      case "follow-up.resolve": return this.resolve(input);
      default: throw new FollowUpError("follow_up_unsupported_method");
    }
  }
  create(input: unknown): FollowUpMutationResult {
    const p = parse(FollowUpCreateParams, input); const repo = canonicalRepo(p.repo_path);
    const payloadDigest = digest([repo, p.source_session_id, p.expected_source_version, p.idempotency_key, p.actor, p.promise, p.destination_ref, p.resolution_condition, p.due_at]);
    return this.safe(() => withWrite(this.db, this.dbPath, () => {
      const existing = this.db.prepare("SELECT * FROM follow_up_obligations WHERE repo_path=? AND tenant='default' AND idempotency_key=?").get(repo, p.idempotency_key) as Row | undefined;
      if (existing) {
        if (existing.create_digest !== payloadDigest) throw new FollowUpError("follow_up_idempotency_conflict");
        return this.result(existing, true);
      }
      const source = this.source(repo, p.source_session_id);
      if (!source) throw new FollowUpError("follow_up_source_unavailable");
      if (source.version !== p.expected_source_version) throw new FollowUpError("follow_up_source_revision_conflict");
      const latest = this.db.prepare("SELECT MAX(updated_at) AS stamp FROM follow_up_obligations WHERE repo_path=? AND tenant='default'").get(repo) as { stamp: number | null };
      const now = this.clock(latest.stamp ?? 0); const id = randomUUID();
      this.db.prepare(`INSERT INTO follow_up_obligations(obligation_id,repo_path,tenant,source_session_id,source_task_id,source_run_id,source_creation_version,source_identity_digest,
        actor,promise,destination_ref,resolution_condition,due_at,idempotency_key,create_digest,state,revision,created_at,updated_at)
        VALUES(?,?,'default',?,?,?,?,?,?,?,?,?,?,?,?,'open',1,?,?)`).run(id, repo, p.source_session_id, source.task_id, source.run_id, source.version, source.identity_digest,
          p.actor, p.promise, p.destination_ref, p.resolution_condition, p.due_at, p.idempotency_key, payloadDigest, now, now);
      this.assertResolvable(this.row(repo, id));
      this.event(id, 1, "created", p.actor, payloadDigest, { source_session_id: p.source_session_id, source_identity_digest: source.identity_digest, source: snapshot(source) }, now);
      return this.result(this.row(repo, id), false);
    }));
  }
  draft(input: unknown): FollowUpMutationResult {
    const p = parse(FollowUpDraftParams, input); const repo = canonicalRepo(p.repo_path);
    return this.safe(() => withWrite(this.db, this.dbPath, () => {
      const row = this.mutable(repo, p.obligation_id, p.expected_revision); const source = this.currentSource(row); const now = this.clock(row.updated_at);
      const text = `UNSENT — local draft only; external delivery is unsupported.\nPromise: ${row.promise}\nSource session: ${row.source_session_id}\nObserved state: ${source?.state ?? "source_missing"}\nObserved version: ${source?.version ?? "unavailable"}\nThis draft grants no authority and does not resolve the obligation.`;
      const draft = { text, content_digest: createHash("sha256").update(text).digest("hex"), source, source_missing: source === null, created_at: now, delivery_state: "unsent" as const };
      const changed = this.db.prepare("UPDATE follow_up_obligations SET state='drafted',revision=revision+1,draft_json=?,updated_at=? WHERE obligation_id=? AND repo_path=? AND tenant='default' AND revision=?")
        .run(JSON.stringify(draft), now, row.obligation_id, repo, row.revision);
      if (changed.changes !== 1) throw new FollowUpError("follow_up_revision_conflict");
      this.event(row.obligation_id, row.revision + 1, "drafted", p.actor, draft.content_digest, { draft }, now);
      return this.result(this.row(repo, row.obligation_id), false);
    }));
  }
  resolve(input: unknown): FollowUpMutationResult {
    const p = parse(FollowUpResolveParams, input); const repo = canonicalRepo(p.repo_path);
    return this.safe(() => withWrite(this.db, this.dbPath, () => {
      const row = this.mutable(repo, p.obligation_id, p.expected_revision); const source = this.currentSource(row); const now = this.clock(row.updated_at);
      if (p.mode === "condition" && (row.resolution_condition !== "session_completed" || source?.state !== "completed")) throw new FollowUpError("follow_up_condition_not_met");
      const resolution = { mode: p.mode, actor: p.actor, reason: p.reason, source, resolved_at: now, external_delivery: "unsupported" as const };
      const state = p.mode === "waive" ? "waived" : "fulfilled_local";
      const changed = this.db.prepare("UPDATE follow_up_obligations SET state=?,revision=revision+1,resolution_json=?,updated_at=? WHERE obligation_id=? AND repo_path=? AND tenant='default' AND revision=?")
        .run(state, JSON.stringify(resolution), now, row.obligation_id, repo, row.revision);
      if (changed.changes !== 1) throw new FollowUpError("follow_up_revision_conflict");
      this.event(row.obligation_id, row.revision + 1, state, p.actor, digest(resolution), { source_session_id: row.source_session_id, source_identity_digest: row.source_identity_digest, resolution }, now);
      return this.result(this.row(repo, row.obligation_id), false);
    }));
  }
  list(input: unknown): FollowUpListResult {
    const p = parse(FollowUpListParams, input); const repo = canonicalRepo(p.repo_path); const cursorScope = digest([repo, "default", p.state ?? null]);
    let after: z.infer<typeof Cursor> | null = null;
    if (p.cursor !== undefined) {
      try {
        const bytes = Buffer.from(p.cursor, "base64url");
        if (bytes.toString("base64url") !== p.cursor) throw new Error();
        after = Cursor.parse(JSON.parse(bytes.toString("utf8"))); if (after.scope !== cursorScope) throw new Error();
      } catch { throw new FollowUpError("follow_up_invalid_cursor"); }
    }
    return this.safe(() => {
      const sampled = this.clock();
      const rows = this.db.prepare(`SELECT * FROM follow_up_obligations WHERE repo_path=? AND tenant='default'
        AND (? IS NULL OR state=?) AND (created_at>? OR (created_at=? AND obligation_id>?)) ORDER BY created_at,obligation_id LIMIT ?`)
        .all(repo, p.state ?? null, p.state ?? null, after?.created_at ?? -1, after?.created_at ?? -1, after?.id ?? "", p.limit + 1) as Row[];
      const overdue = this.db.prepare("SELECT COUNT(*) AS count FROM follow_up_obligations WHERE repo_path=? AND tenant='default' AND state IN ('open','drafted') AND due_at<?").get(repo, sampled) as { count: number };
      const result: FollowUpListResult = { schema_version: 1, scope: { repo_path: repo, default_tenant: true }, sampled_at_ms: sampled, obligations: [], next_cursor: null, overdue_count: overdue.count, external_delivery: "unsupported" };
      let last: Row | undefined;
      for (const row of rows.slice(0, p.limit)) {
        const { promise, draft, resolution: _resolution, ...rest } = this.view(row);
        const item = { ...rest, promise_preview: Array.from(promise).slice(0, 80).join(""), has_draft: draft !== null };
        result.obligations.push(item);
        if (Buffer.byteLength(serializeFollowUp(result)) > FOLLOW_UP_MAX_BYTES - 2048) { result.obligations.pop(); break; }
        last = row;
      }
      if (rows.length > result.obligations.length) {
        if (!last) throw new FollowUpError("follow_up_response_too_large");
        result.next_cursor = Buffer.from(JSON.stringify({ scope: cursorScope, created_at: last.created_at, id: last.obligation_id })).toString("base64url");
      }
      return bounded(FollowUpListResult.parse(result));
    });
  }
  private clock(minimum = 0): number {
    const now = this.now(); if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 || !Number.isSafeInteger(minimum) || minimum < 0) throw new FollowUpError("follow_up_invalid_clock"); return Math.max(now, minimum);
  }
  private safe<T>(fn: () => T): T { try { return fn(); } catch (error) { if (error instanceof FollowUpError) throw error; throw new FollowUpError("follow_up_database_unavailable"); } }
  private row(repo: string, id: string): Row {
    const row = this.db.prepare("SELECT * FROM follow_up_obligations WHERE repo_path=? AND tenant='default' AND obligation_id=?").get(repo, id) as Row | undefined;
    if (!row) throw new FollowUpError("follow_up_not_found"); return row;
  }
  private mutable(repo: string, id: string, revision: number): Row {
    const row = this.row(repo, id);
    if (row.revision !== revision) throw new FollowUpError("follow_up_revision_conflict");
    if (row.state === "fulfilled_local" || row.state === "waived") throw new FollowUpError("follow_up_terminal"); return row;
  }
  private source(repo: string, id: string): BoundSource | null {
    const raw = this.db.prepare(`SELECT s.state,s.version,s.updated_at,s.task_id,s.run_id,s.request_sha256,t.created_at AS task_created_at,r.started_at AS run_started_at FROM agent_sessions s JOIN tasks t ON t.task_id=s.task_id
      JOIN runs r ON r.run_id=s.run_id AND r.task_id=s.task_id AND r.session_id=s.session_id
      WHERE s.session_id=? AND s.repo_path=? AND t.tenant_id IS NULL AND r.tenant_id IS NULL`).get(id, repo) as (BoundSource & { request_sha256: string; task_created_at: number; run_started_at: number }) | undefined;
    if (!raw) return null;
    const parsed = FollowUpSourceSnapshot.safeParse(snapshot(raw));
    if (!parsed.success || !FollowUpObligation.shape.source_task_id.safeParse(raw.task_id).success || !FollowUpObligation.shape.source_run_id.safeParse(raw.run_id).success) throw new FollowUpError("follow_up_source_unavailable");
    if (!/^[a-f0-9]{64}$/.test(raw.request_sha256) || !Number.isFinite(raw.task_created_at) || !Number.isFinite(raw.run_started_at)) throw new FollowUpError("follow_up_source_unavailable");
    return { ...parsed.data, task_id: raw.task_id, run_id: raw.run_id, identity_digest: digest([id, raw.task_id, raw.run_id, raw.request_sha256, raw.task_created_at, raw.run_started_at]) };
  }
  private currentSource(row: Row): Source | null {
    let source: BoundSource | null;
    try { source = this.source(row.repo_path, row.source_session_id); }
    catch (error) { if (error instanceof FollowUpError && error.code === "follow_up_source_unavailable") return null; throw error; }
    return source && source.task_id === row.source_task_id && source.run_id === row.source_run_id && source.version >= row.source_creation_version && source.identity_digest === row.source_identity_digest ? snapshot(source) : null;
  }
  private view(row: Row): Obligation {
    const source = this.currentSource(row);
    return FollowUpObligation.parse({ obligation_id: row.obligation_id, repo_path: row.repo_path, default_tenant: true,
      source_session_id: row.source_session_id, source_task_id: row.source_task_id, source_run_id: row.source_run_id, source_creation_version: row.source_creation_version, source_identity_digest: row.source_identity_digest,
      actor: row.actor, promise: row.promise, destination_ref: row.destination_ref, resolution_condition: row.resolution_condition, due_at: row.due_at,
      state: row.state, revision: row.revision, created_at: row.created_at, updated_at: row.updated_at,
      draft: row.draft_json === null || row.state === "fulfilled_local" || row.state === "waived" ? null : JSON.parse(row.draft_json), resolution: row.resolution_json === null ? null : JSON.parse(row.resolution_json),
      source, source_missing: source === null, external_delivery: "unsupported" });
  }
  // Creation reserves enough escaped response space for a maximal local waiver,
  // so a later draft cannot make this obligation permanently unresolvable.
  private assertResolvable(row: Row): void {
    const source: Source = { state: "awaiting_decision", version: Number.MAX_SAFE_INTEGER - 1, updated_at: 8_640_000_000_000_000 };
    bounded({ schema_version: 1, duplicate: false, obligation: { ...this.view(row), draft: null, state: "fulfilled_local",
      revision: Number.MAX_SAFE_INTEGER - 1, updated_at: 8_640_000_000_000_000, source, source_missing: false,
      resolution: { mode: "condition", actor: "A" + "\u0000".repeat(127), reason: "R" + "\u0000".repeat(1023), source,
        resolved_at: 8_640_000_000_000_000, external_delivery: "unsupported" } } });
  }
  private result(row: Row, duplicate: boolean): FollowUpMutationResult { return bounded(FollowUpMutationResult.parse({ schema_version: 1, obligation: this.view(row), duplicate })); }
  private event(id: string, revision: number, transition: string, actor: string, contentDigest: string, evidence: unknown, now: number): void {
    this.db.prepare("INSERT INTO follow_up_obligation_events(obligation_id,revision,transition,actor,content_digest,evidence_json,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(id, revision, transition, actor, contentDigest, JSON.stringify(evidence), now);
  }
}
function snapshot(source: Source): Source { return { state: source.state, version: source.version, updated_at: source.updated_at }; }
function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input); if (!parsed.success) throw new FollowUpError("invalid_follow_up_request"); return parsed.data;
}
function canonicalRepo(path: string): string {
  try { if (!isAbsolute(path)) throw new Error(); const root = realpathSync(path); if (!statSync(root).isDirectory()) throw new Error(); accessSync(root, constants.R_OK | constants.X_OK); return root; }
  catch { throw new FollowUpError("follow_up_repository_unavailable"); }
}
function bounded<T>(value: T): T { if (Buffer.byteLength(serializeFollowUp(value)) + 1 > FOLLOW_UP_MAX_BYTES) throw new FollowUpError("follow_up_response_too_large"); return value; }

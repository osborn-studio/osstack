import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type Database from "better-sqlite3";
import { CURRENT_SCHEMA_VERSION } from "@osstack/core";
import { z } from "zod";

export const WORKER_VIEW_MAX_BYTES = 65536;
const TOKEN_TTL_MS = 15 * 60 * 1000;
const tokenString = z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/);
// Bound JSON escaping as well as characters before encryption/base64 growth.
const sourceIdentity = z.string().min(1).max(256).refine(id => Buffer.byteLength(JSON.stringify(id), "utf8") <= 1200);
const scopeInput = {
  repo_path: z.string().min(1).max(4096).refine(isAbsolute),
  default_tenant: z.literal(true),
};
export const WorkerListParamsSchema = z.object({ ...scopeInput,
  limit: z.number().int().min(1).max(50).optional(), cursor: tokenString.optional(),
}).strict();
export const WorkerInspectParamsSchema = z.object({ ...scopeInput, view_id: tokenString }).strict();
const states = ["starting", "running", "awaiting_decision", "idle", "completed", "failed", "cancelled", "expired", "outcome_pending", "unknown"] as const;
const StateSchema = z.enum(states);
const ViewSchema = z.object({
  view_id: tokenString, source_kind: z.enum(["run", "session"]),
  state: StateSchema, revision: z.number().int().safe().positive().nullable(),
  latest_turn: z.object({ ordinal: z.number().int().safe().positive(), state: StateSchema, decision_present: z.boolean() }).strict().nullable(),
  last_updated_at_ms: z.number().finite().nonnegative().nullable(),
  freshness: z.enum(["recent", "stale", "unknown"]),
  process_liveness: z.literal("unknown"),
  wait_reason: z.enum(["decision_record_present", "delivery_unknown", "awaiting_instruction", "none", "unknown"]),
  uncertain_delivery_recorded: z.boolean(),
  controls: z.literal("unsupported"),
}).strict();
const commonResponse = {
  schema_version: z.literal(1), mode: z.literal("readonly_state_view"),
  scope: z.object({ repo_path: z.string().max(4096), tenant: z.literal("default"), scope_id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  sampled_at_ms: z.number().int().nonnegative(),
  coverage: z.object({
    graph: z.literal("unsupported_authenticated_registration_required"),
    unbound_runs: z.literal("excluded_not_bound"),
    repository_binding: z.literal("canonical_stored_paths_only"),
    content: z.literal("structured_metadata_only"),
    counting: z.literal("source_views_not_unique_workers"),
  }).strict(),
};
export const WorkerListResultSchema = z.object({ ...commonResponse,
  total: z.number().int().nonnegative(), views: z.array(ViewSchema).max(50),
  next_cursor: tokenString.nullable(), truncated: z.boolean(),
}).strict();
export const WorkerInspectResultSchema = z.object({ ...commonResponse, view: ViewSchema }).strict();
export type WorkerViewListResult = z.infer<typeof WorkerListResultSchema>;
export type WorkerViewInspectResult = z.infer<typeof WorkerInspectResultSchema>;

/** Valid JSON with terminal control/format characters escaped in strings.
 * Use the same representation for service budgeting and CLI printing. */
export function serializeWorkerView(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new Error("invalid_worker_response");
  return serialized.replace(/[\p{Cf}\u007f-\u009f\u2028\u2029]/gu,
    char => char.split("").map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
}

const TokenSchema = z.object({ v: z.literal(1), kind: z.enum(["view", "cursor"]), scope: z.string(),
  source: z.enum(["run", "session"]), id: sourceIdentity, issued: z.number().int().nonnegative(),
}).strict();
type Token = z.infer<typeof TokenSchema>;
const RowSchema = z.object({
  kind: z.enum(["run", "session"]), id: sourceIdentity,
  state: StateSchema, revision: z.number().int().safe().positive().nullable(),
  updated: z.number().nullable(), ordinal: z.number().int().safe().positive().nullable(),
  turn_state: StateSchema.nullable(), decision_present: z.number(), uncertain_delivery: z.number(),
});
type Row = z.infer<typeof RowSchema>;

// Exact canonical paths and both tenant joins are intentional. A run alone has
// no repository column. Never infer its scope from a task title or event text.
const RELATION = `WITH bound AS (
  SELECT s.session_id, s.run_id, s.state, s.version, s.updated_at,
    r.outcome, r.completed_at, r.started_at
  FROM agent_sessions s JOIN tasks t ON t.task_id=s.task_id
  JOIN runs r ON r.run_id=s.run_id AND r.task_id=s.task_id
    AND r.session_id=s.session_id AND r.agent_id=s.agent_id
  WHERE s.repo_path=@repo AND t.tenant_id IS NULL AND r.tenant_id IS NULL
), sources AS (
  SELECT 'session' AS kind, session_id AS id, session_id, state, version AS revision, updated_at AS updated FROM bound
  UNION ALL
  SELECT 'run', run_id, session_id,
    CASE WHEN outcome IN ('completed','failed','cancelled','expired') THEN outcome
      WHEN outcome IS NULL THEN 'outcome_pending' ELSE 'unknown' END,
    NULL, coalesce(completed_at, started_at) FROM bound
)`;
const PROJECTION = `SELECT p.kind, substr(p.id,1,257) AS id, p.state, p.revision, p.updated,
  turn.ordinal, turn.state AS turn_state, (turn.decision_json IS NOT NULL) AS decision_present,
  EXISTS(SELECT 1 FROM session_messages m WHERE m.session_id=p.session_id
    AND m.direction='inbound' AND m.state IN ('pending','accepted','failed')) AS uncertain_delivery
  FROM sources p LEFT JOIN session_turns turn ON turn.session_id=p.session_id
    AND turn.ordinal=(SELECT max(ordinal) FROM session_turns WHERE session_id=p.session_id)`;

export const WORKER_VIEW_ERROR_CODES = ["invalid_request", "repository_unavailable", "invalid_cursor", "invalid_view", "source_not_found", "source_unavailable", "unsupported_schema", "unsupported_method", "response_too_large"] as const;
export class WorkerViewError extends Error {
  constructor(readonly code: typeof WORKER_VIEW_ERROR_CODES[number]) { super(code); this.name = "WorkerViewError"; }
}

/** Inject the daemon's existing connection. Construction never opens, migrates,
 * reads, or writes a database. Tokens are opaque, authenticated and ephemeral;
 * they grant no action authority and never expose provider-native identities. */
export class WorkerViewService {
  private readonly key = randomBytes(32);
  private readonly nowMs: () => number;
  constructor(private readonly db: Database.Database, options: { nowMs?: () => number } = {}) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  handle(method: string, params: unknown): WorkerViewListResult | WorkerViewInspectResult {
    if (method === "worker.list") return this.list(params);
    if (method === "worker.inspect") return this.inspect(params);
    throw new WorkerViewError("unsupported_method");
  }

  list(raw: unknown): WorkerViewListResult {
    const parsed = WorkerListParamsSchema.safeParse(raw);
    if (!parsed.success) throw new WorkerViewError("invalid_request");
    const params = parsed.data;
    const common = this.context(params.repo_path);
    const previous = params.cursor ? this.decode(params.cursor, "cursor", common.scope.scope_id, common.sampled_at_ms) : null;
    const cursorContext = { ...common, sampled_at_ms: previous?.issued ?? common.sampled_at_ms };
    return this.read(() => {
      const query = { repo: common.scope.repo_path };
      const total = (this.db.prepare(`${RELATION} SELECT count(*) AS n FROM sources`).get(query) as { n: number }).n;
      const limit = params.limit ?? 25;
      const rows = this.db.prepare(`${RELATION} ${PROJECTION}
        WHERE (@kind='' OR p.kind>@kind OR (p.kind=@kind AND p.id>@id))
        ORDER BY p.kind,p.id LIMIT @limit`).all({ ...query, kind: previous?.source ?? "", id: previous?.id ?? "", limit: limit + 1 });
      const result: WorkerViewListResult = { ...common, total, views: [], next_cursor: null, truncated: false };
      // Reserve room for a cursor before adding each entry; never silently drop
      // a row when the byte budget yields a shorter page than the count limit.
      let last: Row | null = null;
      for (let i = 0; i < Math.min(rows.length, limit); i++) {
        const row = RowSchema.parse(rows[i]);
        const more = i + 1 < rows.length;
        const candidate = { ...result, views: [...result.views, this.view(row, common)],
          next_cursor: more ? this.encode("cursor", row, cursorContext) : null, truncated: more };
        if (this.bytes(candidate) > WORKER_VIEW_MAX_BYTES) {
          if (!last) throw new WorkerViewError("response_too_large");
          result.next_cursor = this.encode("cursor", last, cursorContext); result.truncated = true;
          break;
        }
        Object.assign(result, candidate); last = row;
      }
      this.checkBytes(result);
      return WorkerListResultSchema.parse(result);
    });
  }

  inspect(raw: unknown): WorkerViewInspectResult {
    const parsed = WorkerInspectParamsSchema.safeParse(raw);
    if (!parsed.success) throw new WorkerViewError("invalid_request");
    const common = this.context(parsed.data.repo_path);
    const token = this.decode(parsed.data.view_id, "view", common.scope.scope_id, common.sampled_at_ms);
    return this.read(() => {
      const rawRow = this.db.prepare(`${RELATION} ${PROJECTION} WHERE p.kind=@kind AND p.id=@id`)
        .get({ repo: common.scope.repo_path, kind: token.source, id: token.id });
      if (!rawRow) throw new WorkerViewError("source_not_found");
      const result = { ...common, view: this.view(RowSchema.parse(rawRow), common) };
      this.checkBytes(result);
      return WorkerInspectResultSchema.parse(result);
    });
  }

  private context(path: string) {
    let repo: string;
    try {
      repo = realpathSync(path);
      if (repo.length > 4096 || !statSync(repo).isDirectory()) throw new Error();
      accessSync(repo, constants.R_OK | constants.X_OK);
    } catch { throw new WorkerViewError("repository_unavailable"); }
    const now = this.nowMs();
    if (!Number.isSafeInteger(now) || now < 0) throw new WorkerViewError("source_unavailable");
    return { schema_version: 1 as const, mode: "readonly_state_view" as const,
      scope: { repo_path: repo, tenant: "default" as const, scope_id: createHash("sha256").update(`default\0${repo}`).digest("hex") },
      sampled_at_ms: now, coverage: {
        graph: "unsupported_authenticated_registration_required" as const,
        unbound_runs: "excluded_not_bound" as const,
        repository_binding: "canonical_stored_paths_only" as const,
        content: "structured_metadata_only" as const,
        counting: "source_views_not_unique_workers" as const,
      } };
  }

  private view(row: Row, common: ReturnType<WorkerViewService["context"]>): z.infer<typeof ViewSchema> {
    const updated = row.updated !== null && Number.isFinite(row.updated) && row.updated >= 0 && row.updated <= Number.MAX_SAFE_INTEGER / 1000 ? Math.round(row.updated * 1000) : null;
    const age = updated === null ? -1 : common.sampled_at_ms - updated;
    const terminal = ["completed", "failed", "cancelled", "expired"].includes(row.state);
    return { view_id: this.encode("view", row, common), source_kind: row.kind, state: row.state,
      revision: row.revision,
      latest_turn: row.ordinal !== null && row.turn_state !== null ? { ordinal: row.ordinal, state: row.turn_state, decision_present: row.decision_present === 1 } : null,
      last_updated_at_ms: updated, freshness: age < 0 ? "unknown" : age <= 60000 ? "recent" : "stale",
      process_liveness: "unknown", controls: "unsupported",
      uncertain_delivery_recorded: row.uncertain_delivery === 1,
      wait_reason: terminal ? "none" : row.uncertain_delivery ? "delivery_unknown" : row.state === "awaiting_decision" ? (row.decision_present ? "decision_record_present" : "unknown") : row.state === "idle" ? "awaiting_instruction" : "none",
    };
  }

  private encode(kind: Token["kind"], row: Row, common: ReturnType<WorkerViewService["context"]>): string {
    const payload: Token = { v: 1, kind, scope: common.scope.scope_id, source: row.kind, id: row.id, issued: common.sampled_at_ms };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
  }

  private decode(value: string, kind: Token["kind"], scope: string, now: number): Token {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
      const bytes = Buffer.from(value, "base64url");
      if (bytes.toString("base64url") !== value || bytes.length < 29) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const token = TokenSchema.parse(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")));
      if (token.kind !== kind || token.scope !== scope || token.issued > now || now - token.issued > TOKEN_TTL_MS) throw new Error();
      return token;
    } catch { throw new WorkerViewError(kind === "cursor" ? "invalid_cursor" : "invalid_view"); }
  }

  private read<T>(fn: () => T): T {
    try {
      return this.db.transaction(() => {
        const version = this.db.pragma("user_version", { simple: true });
        if (typeof version !== "number" || version < 24 || version > CURRENT_SCHEMA_VERSION) throw new WorkerViewError("unsupported_schema");
        return fn();
      })();
    } catch (error) {
      if (error instanceof WorkerViewError) throw error;
      throw new WorkerViewError("source_unavailable");
    }
  }
  private bytes(value: unknown): number { return Buffer.byteLength(serializeWorkerView(value), "utf8") + 1; }
  private checkBytes(value: unknown): void {
    if (this.bytes(value) > WORKER_VIEW_MAX_BYTES) throw new WorkerViewError("response_too_large");
  }
}

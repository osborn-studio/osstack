import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import type Database from "better-sqlite3";
import { SessionDecision } from "@osstack/protocol";
import { withWrite } from "./db.js";

export function attentionDigest(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v !== null && typeof v === "object")
      return `{${Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
        .join(",")}}`;
    return JSON.stringify(v);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export interface AttentionOwner {
  instance_id: string;
  generation: number;
  home_id: string;
}
export interface AttentionScope {
  scope_id: string;
  task_id: string;
  repo_path: string;
  discovery_after: string;
  scan_complete: number;
  sampled_at: number;
  deadline: number;
  generation: number;
  error: string | null;
}
export interface AttentionItem {
  item_id: string;
  scope_id: string;
  session_id: string;
  turn_id: string;
  decision_id: string;
  content_hash: string;
  decision: SessionDecision;
  source_version: number;
  revision: number;
  state: string;
  created_at: number;
  updated_at: number;
  external_message_id: string | null;
}
type ItemRow = Omit<AttentionItem, "decision"> & { decision_json: string };
function parseItem(row: ItemRow): AttentionItem {
  const { decision_json, ...rest } = row;
  return {
    ...rest,
    decision: SessionDecision.parse(JSON.parse(decision_json)),
  };
}
export class AttentionStore {
  constructor(readonly db: Database.Database, readonly path: string) {}
  /** Only called AFTER the daemon's process lock is acquired. Not an executor lease. */
  claimOwner(instanceId: string): AttentionOwner {
    return withWrite(this.db, this.path, () => {
      this.db
        .prepare(
          `INSERT INTO daemon_owner(singleton,home_id,instance_id,generation) VALUES(1,?,?,1)
        ON CONFLICT(singleton) DO UPDATE SET instance_id=excluded.instance_id,generation=generation+1`
        )
        .run(randomUUID(), instanceId);
      return this.db
        .prepare(
          "SELECT home_id,instance_id,generation FROM daemon_owner WHERE singleton=1"
        )
        .get() as AttentionOwner;
    });
  }
  assertOwner(owner: AttentionOwner): void {
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM daemon_owner WHERE singleton=1 AND home_id=? AND instance_id=? AND generation=?"
        )
        .get(owner.home_id, owner.instance_id, owner.generation)
    )
      throw new Error("stale_owner");
  }
  write<T>(owner: AttentionOwner, fn: () => T): T {
    if (this.db.inTransaction) {
      this.assertOwner(owner);
      return fn();
    }
    return withWrite(this.db, this.path, () => {
      this.assertOwner(owner);
      return fn();
    });
  }
  registerScope(
    owner: AttentionOwner,
    taskId: string,
    repoPath: string
  ): AttentionScope {
    const canonicalRepo = realpathSync(repoPath);
    if (!statSync(canonicalRepo).isDirectory())
      throw new Error("repository_directory_required");
    return this.write(owner, () => {
      const task = this.db
        .prepare(
          "SELECT created_at FROM tasks WHERE task_id=? AND tenant_id IS NULL"
        )
        .get(taskId) as { created_at: number } | undefined;
      if (!task) throw new Error("not_found");
      if (
        (
          this.db.prepare("SELECT COUNT(*) n FROM attention_scopes").get() as {
            n: number;
          }
        ).n >= 100 &&
        !this.db
          .prepare(
            "SELECT 1 FROM attention_scopes WHERE task_id=? AND repo_path=?"
          )
          .get(taskId, canonicalRepo)
      )
        throw new Error("scope_capacity");
      const scopeId = attentionDigest([
        owner.home_id,
        taskId,
        canonicalRepo,
        task.created_at,
      ]);
      this.db
        .prepare(
          `INSERT INTO attention_scopes(scope_id,task_id,repo_path,generation) VALUES(?,?,?,?)
        ON CONFLICT(scope_id) DO NOTHING`
        )
        .run(scopeId, taskId, canonicalRepo, owner.generation);
      return this.getScope(scopeId)!;
    });
  }
  getScope(scopeId: string): AttentionScope | undefined {
    return this.db
      .prepare("SELECT * FROM attention_scopes WHERE scope_id=?")
      .get(scopeId) as AttentionScope | undefined;
  }
  listScopes(): AttentionScope[] {
    return this.db
      .prepare("SELECT * FROM attention_scopes ORDER BY scope_id")
      .all() as AttentionScope[];
  }
  getItem(scopeId: string, itemId: string): AttentionItem | undefined {
    const row = this.db
      .prepare("SELECT * FROM attention_items WHERE scope_id=? AND item_id=?")
      .get(scopeId, itemId) as ItemRow | undefined;
    return row ? parseItem(row) : undefined;
  }
  listItems(scopeId: string, after = "", limit = 100): AttentionItem[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("invalid_limit");
    return (
      this.db
        .prepare(
          "SELECT * FROM attention_items WHERE scope_id=? AND item_id>? ORDER BY item_id LIMIT ?"
        )
        .all(scopeId, after, limit) as ItemRow[]
    ).map(parseItem);
  }
  projectDecision(
    owner: AttentionOwner,
    input: {
      scopeId: string;
      sessionId: string;
      turnId: string;
      sourceVersion: number;
      decision: unknown;
      now: number;
    }
  ): AttentionItem {
    const decision = SessionDecision.parse(input.decision);
    const contentHash = attentionDigest(decision);
    const itemId = attentionDigest([
      input.scopeId,
      input.sessionId,
      input.turnId,
      decision.decision_id,
    ]);
    if (
      !Number.isSafeInteger(input.sourceVersion) ||
      input.sourceVersion < 1 ||
      !Number.isFinite(input.now)
    )
      throw new Error("invalid_source_version");
    return this.write(owner, () => {
      if (!this.getScope(input.scopeId)) throw new Error("not_found");
      const existing = this.getItem(input.scopeId, itemId);
      if (existing && existing.content_hash !== contentHash)
        throw new Error("decision_content_conflict");
      if (existing && existing.source_version > input.sourceVersion)
        throw new Error("stale_source");
      this.db
        .prepare(
          `INSERT INTO attention_items(item_id,scope_id,session_id,turn_id,decision_id,content_hash,decision_json,source_version,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET
        revision=revision+CASE WHEN source_version<>excluded.source_version OR state='source_missing' THEN 1 ELSE 0 END,
        state=CASE WHEN state='source_missing' THEN 'open' ELSE state END,
        source_version=excluded.source_version,updated_at=excluded.updated_at`
        )
        .run(
          itemId,
          input.scopeId,
          input.sessionId,
          input.turnId,
          decision.decision_id,
          contentHash,
          JSON.stringify(decision),
          input.sourceVersion,
          input.now,
          input.now
        );
      return this.getItem(input.scopeId, itemId)!;
    });
  }
  release(
    owner: AttentionOwner,
    scopeId: string,
    kind: string,
    subjectId: string,
    expectedVersion: number
  ): void {
    if (!["session", "run", "loop"].includes(kind))
      throw new Error("invalid_subject_kind");
    this.write(owner, () => {
      const row = this.db
        .prepare(
          "SELECT payload_json,source_version FROM attention_subjects WHERE scope_id=? AND kind=? AND subject_id=?"
        )
        .get(scopeId, kind, subjectId) as
        | { payload_json: string; source_version: number }
        | undefined;
      if (!row || row.source_version !== expectedVersion)
        throw new Error("subject_version_conflict");
      this.db
        .prepare(
          "UPDATE attention_subjects SET admitted=0,payload_json=? WHERE scope_id=? AND kind=? AND subject_id=?"
        )
        .run(
          JSON.stringify({
            ...JSON.parse(row.payload_json),
            reason: "owner_released",
          }),
          scopeId,
          kind,
          subjectId
        );
    });
  }
  markMissing(owner: AttentionOwner, scopeId: string, sessionId: string): void {
    this.write(owner, () =>
      this.db
        .prepare(
          `UPDATE attention_items SET state='source_missing',revision=revision+1
      WHERE scope_id=? AND session_id=? AND state='open'`
        )
        .run(scopeId, sessionId)
    );
  }
}

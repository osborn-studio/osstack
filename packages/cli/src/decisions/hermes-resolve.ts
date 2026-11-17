import type Database from "better-sqlite3";

/** The existing resolve operation, shared by direct RPC and the decision router. */
export function resolveHermesDecision(db: Database.Database, method: "approval.resolve" | "clarify.resolve", params: Record<string, unknown>) {
  const approval = method === "approval.resolve";
  const table = approval ? "approvals" : "clarifies";
  const key = approval ? "approval_id" : "clarify_id";
  const field = approval ? "choice" : "answer";
  const id = params[key]; const value = params[field];
  if (typeof id !== "string" || typeof value !== "string") throw Error("bad_request");
  const row = db.prepare(`SELECT status FROM ${table} WHERE ${key}=?`).get(id) as { status: string } | undefined;
  if (!row) throw Error("not_found");
  if (row.status !== "pending") throw Error("already_resolved");
  db.prepare(`UPDATE ${table} SET status=?,resolved_at=?,${field}=? WHERE ${key}=? AND status='pending'`)
    .run(approval ? "accepted" : "answered", Date.now() / 1000, value, id);
  return { resolved: true, [key]: id, ...(approval ? { choice: value } : {}) };
}

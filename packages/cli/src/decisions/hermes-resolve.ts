import type Database from "better-sqlite3";

/** The existing resolve operation, shared by direct RPC and the decision router. */
export function resolveHermesDecision(db: Database.Database, method: "approval.resolve" | "clarify.resolve", params: Record<string, unknown>) {
  const approval = method === "approval.resolve";
  const table = approval ? "approvals" : "clarifies";
  const key = approval ? "approval_id" : "clarify_id";
  const field = approval ? "choice" : "answer";
  const id = params[key];
  const value = params[field];
  if (typeof id !== "string" || typeof value !== "string") throw Error("bad_request");
  const status = approval ? "accepted" : "answered";
  const result = { resolved: true, [key]: id, ...(approval ? { choice: value } : {}) };
  const lookup = db.prepare<[string], { status: string; value: string | null }>(
    `SELECT status, ${field} AS value FROM ${table} WHERE ${key}=?`,
  );
  let row = lookup.get(id);
  if (!row) throw Error("not_found");
  if (row.status === "pending") {
    const { changes } = db.prepare(`UPDATE ${table} SET status=?,resolved_at=?,${field}=? WHERE ${key}=? AND status='pending'`)
      .run(status, Date.now() / 1000, value, id);
    if (changes === 1) return result;
    row = lookup.get(id);
    if (!row) throw Error("not_found");
  }
  if (row.status !== status || row.value !== value) throw Error("already_resolved");
  return result;
}

// Internal synchronous primitive shared by action and checkpoint storage. Never
// export a callback-taking transaction API from core's public entry point.
import type Database from "better-sqlite3";
import { GraphJsonValue } from "@osstack/protocol";
import { preflightDiskSpace } from "./db.js";
import { GraphRunStore, checkGraphRunFence, graphRunFenceSchema, type GraphRun, type GraphRunFence } from "./graph-runs.js";

export interface GraphStorageMutation<T> { value: T; changed: boolean }

/** Acquires BEGIN IMMEDIATE before any fence/cache read. Callback is internal,
 * synchronous SQL only; no adapter invocation, async authorization, or nested
 * transactions. Every mutation advances run revision; a read/cache hit does not.
 * Host must serialize requests and refresh its fence from the returned run. */
export function fencedGraphTransaction<T>(
  db: Database.Database,
  value: GraphRunFence,
  operation: (run: GraphRun) => GraphStorageMutation<T>,
): { value: T; run: GraphRun } {
  const input = graphRunFenceSchema.parse(GraphJsonValue.parse(value));
  if (db.inTransaction) throw new Error("Graph storage requires its own BEGIN IMMEDIATE transaction");
  preflightDiskSpace(db.name);
  return db.transaction(() => {
    const store = new GraphRunStore(db);
    const run = checkGraphRunFence(store.get(input.scope, input.graphRunId), input, true);
    const result = operation(run);
    // Runtime guard supplements the non-Promise callback return type. Callers are
    // trusted internal code; this cannot sandbox an intentionally async callback.
    if (!result || typeof result.changed !== "boolean" || "then" in result) throw new Error("Graph storage callback must be synchronous");
    if (result.changed) {
      db.prepare("UPDATE graph_runs SET revision = ?, updated_at = ? WHERE graph_run_id = ?")
        .run(run.revision + 1, input.now, run.graphRunId);
    }
    return { value: result.value, run: result.changed ? store.get(input.scope, input.graphRunId)! : run };
  }).immediate();
}

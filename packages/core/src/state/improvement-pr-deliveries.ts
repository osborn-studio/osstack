import type Database from "better-sqlite3";
import { z } from "zod";
import { withWrite } from "./db.js";
import type { ImprovementExecutionWorker, ImprovementExecutionStop } from "./improvement-executions.js";

export const ImprovementPrTarget = z.object({
  repository_id: z.number().int().positive().safe(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).refine((s) => s.split("/").every((part) => part !== "." && part !== "..")),
  base: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/)
    .refine((s) => !s.includes("..") && !s.includes("//") && !s.endsWith("/") && !s.endsWith(".lock")),
  branch: z.string().regex(/^codex\/improve-pr-[a-f0-9]{24}$/),
  title: z.string().trim().min(1).max(200).refine((s) => ![...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)),
  draft: z.literal(true),
}).strict();
export type ImprovementPrTarget = z.infer<typeof ImprovementPrTarget>;
export type ImprovementPrState = "authorized" | "preparing" | "prepared" | "push_dispatched" | "pushed" | "pr_dispatched" | "delivered" | "blocked";
export interface ImprovementPrCommit { base_sha: string; commit_sha: string; tree_sha: string; patch_sha256: string }
export interface ImprovementPrReceipt { number: number; url: string; head_sha: string }
export interface ImprovementPrDeliveryView {
  execution_id: string;
  target: ImprovementPrTarget;
  state: ImprovementPrState;
  workspace_path?: string;
  commit?: ImprovementPrCommit;
  pr?: ImprovementPrReceipt;
  stop?: ImprovementExecutionStop;
  error?: string;
}
interface Row { execution_id: string; target_json: string; state: ImprovementPrState; workspace_path: string | null; commit_json: string | null; pr_json: string | null; stop_json: string | null; error: string | null }
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Local operator control-plane ledger. This is not a remote execution grant. */
export class ImprovementPrDeliveryRepository {
  constructor(private readonly db: Database.Database, private readonly dbPath: string) {}

  get(id: string): ImprovementPrDeliveryView | undefined {
    const row = this.db.prepare("SELECT * FROM improvement_pr_deliveries WHERE execution_id = ?").get(id) as Row | undefined;
    if (!row) return undefined;
    return { execution_id: id, target: ImprovementPrTarget.parse(JSON.parse(row.target_json)), state: row.state,
      ...(row.workspace_path === null ? {} : { workspace_path: row.workspace_path }),
      ...(row.commit_json === null ? {} : { commit: JSON.parse(row.commit_json) as ImprovementPrCommit }),
      ...(row.pr_json === null ? {} : { pr: JSON.parse(row.pr_json) as ImprovementPrReceipt }),
      ...(row.stop_json === null ? {} : { stop: JSON.parse(row.stop_json) as ImprovementExecutionStop }),
      ...(row.error === null ? {} : { error: row.error }),
    };
  }

  begin(id: string, worker: ImprovementExecutionWorker, now: number): boolean {
    return withWrite(this.db, this.dbPath, () => {
      this.assertActive(id, worker);
      if (this.require(id).state !== "authorized") return false;
      this.move(id, "authorized", "preparing", now);
      return true;
    });
  }

  assertActive(id: string, worker: ImprovementExecutionWorker): void {
    const delivery = this.require(id);
    if (delivery.stop !== undefined) throw new Error("PR delivery stop requested; no new dispatch permitted");
    const execution = this.db.prepare("SELECT state, worker_id, worker_generation, stop_json FROM improvement_executions WHERE execution_id = ?").get(id) as { state: string; worker_id: string; worker_generation: number; stop_json: string | null };
    if (execution.state !== "candidate_verified") throw new Error("PR delivery requires a verified candidate");
    if (execution.stop_json !== null || execution.worker_id !== worker.worker_id || execution.worker_generation !== worker.generation) {
      throw new Error("PR delivery worker or stop conflict");
    }
  }

  recordWorkspace(id: string, worker: ImprovementExecutionWorker, path: string, now: number): void {
    if (!Number.isFinite(now) || now < 0 || !path.startsWith("/") || path.includes("\0")) throw new Error("Invalid PR reconstruction workspace");
    withWrite(this.db, this.dbPath, () => {
      this.assertActive(id, worker);
      const changed = this.db.prepare("UPDATE improvement_pr_deliveries SET workspace_path = ?, updated_at = ? WHERE execution_id = ? AND state = 'preparing' AND workspace_path IS NULL").run(path, now, id);
      if (changed.changes !== 1) throw new Error("PR reconstruction workspace conflict");
    });
  }

  prepare(id: string, worker: ImprovementExecutionWorker, commit: ImprovementPrCommit, now: number): void {
    if (!SHA.test(commit.base_sha) || !SHA.test(commit.commit_sha) || !SHA.test(commit.tree_sha) || !/^[a-f0-9]{64}$/.test(commit.patch_sha256)) throw new Error("Invalid PR commit binding");
    withWrite(this.db, this.dbPath, () => {
      this.assertActive(id, worker);
      const request = this.db.prepare("SELECT request_json FROM improvement_executions WHERE execution_id = ?").get(id) as { request_json: string };
      if (JSON.parse(request.request_json).base_sha !== commit.base_sha) throw new Error("PR base differs from authorized request");
      this.db.prepare("UPDATE improvement_pr_deliveries SET commit_json = ? WHERE execution_id = ?").run(JSON.stringify(commit), id);
      this.move(id, "preparing", "prepared", now);
    });
  }

  /** Persisted dispatch is the linearization point; a subsequent stop cannot undo issued I/O. */
  dispatch(id: string, worker: ImprovementExecutionWorker, action: "push" | "pr", now: number): void {
    if (action !== "push" && action !== "pr") throw new Error("Invalid PR delivery action");
    withWrite(this.db, this.dbPath, () => {
      this.assertActive(id, worker);
      this.move(id, action === "push" ? "prepared" : "pushed", action === "push" ? "push_dispatched" : "pr_dispatched", now);
    });
  }

  /** Observations may finish after stop, but never issue another external action. */
  observePush(id: string, sha: string, now: number): void {
    withWrite(this.db, this.dbPath, () => {
      if (this.require(id).commit?.commit_sha !== sha) throw new Error("Observed push differs from bound commit");
      this.move(id, "push_dispatched", "pushed", now);
    });
  }

  observePr(id: string, pr: ImprovementPrReceipt, now: number): void {
    withWrite(this.db, this.dbPath, () => {
      const view = this.require(id);
      if (!Number.isSafeInteger(pr.number) || pr.number < 1 || pr.head_sha !== view.commit?.commit_sha
        || pr.url !== `https://github.com/${view.target.repository}/pull/${pr.number}`) throw new Error("Invalid PR receipt binding");
      this.db.prepare("UPDATE improvement_pr_deliveries SET pr_json = ? WHERE execution_id = ?").run(JSON.stringify(pr), id);
      this.move(id, "pr_dispatched", "delivered", now);
    });
  }

  recordError(id: string, error: string, now: number): void {
    if (!Number.isFinite(now) || now < 0) throw new Error("Invalid PR delivery timestamp");
    withWrite(this.db, this.dbPath, () => {
      const view = this.require(id);
      if (view.state === "delivered") return;
      const execution = this.db.prepare("SELECT state FROM improvement_executions WHERE execution_id = ?").get(id) as { state: string };
      const state = view.state === "authorized" && execution.state === "candidate_failed" ? "blocked" : view.state;
      this.db.prepare("UPDATE improvement_pr_deliveries SET state = ?, error = ?, updated_at = ? WHERE execution_id = ?")
        .run(state, error.slice(0, 2000).replaceAll("\0", ""), now, id);
    });
  }

  private require(id: string): ImprovementPrDeliveryView {
    const view = this.get(id);
    if (!view) throw new Error("No authorized PR delivery for this execution");
    return view;
  }
  private move(id: string, from: ImprovementPrState, to: ImprovementPrState, now: number): void {
    if (!Number.isFinite(now) || now < 0) throw new Error("Invalid PR delivery timestamp");
    const changed = this.db.prepare("UPDATE improvement_pr_deliveries SET state = ?, error = NULL, updated_at = ? WHERE execution_id = ? AND state = ?")
      .run(to, now, id, from);
    if (changed.changes !== 1) throw new Error(`PR delivery state conflict: expected ${from}`);
  }
}

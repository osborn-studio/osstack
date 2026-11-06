import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { AttentionOwner, AttentionStore } from "./attention-store.js";

export type MergerVerdictKind = "would_merge" | "refused" | "unevaluated";
export type MergerOutcomeKind = "merged" | "closed_unmerged" | "reopened" | "observation_expired";

/** sha256 of `[]`: the `codes_digest` of every would_merge row. Mirrored in the migration's CHECKs. */
export const EMPTY_CODES_DIGEST = createHash("sha256").update("[]").digest("hex");

export interface MergerWatermark { repository: string; pr_number: number; issued_seq: number; accepted_seq: number; updated_at: number }
export interface MergerDecisionRow {
  seq: number; repository: string; pr_number: number; mission_id: string; observation_seq: number; head_sha: string; base_sha: string | null;
  verdict: MergerVerdictKind; codes_json: string; codes_digest: string; gates_json: string; merge_request_json: string | null;
  evidence_digest: string; observed_at: number; created_at: number;
}
export interface MergerOutcomeRow {
  seq: number; repository: string; pr_number: number; mission_id: string; observation_seq: number; outcome: MergerOutcomeKind; head_at_close: string;
  merged_at: string | null; merge_commit: string | null; merged_by_actor_id: number | null; merged_by_type: "User" | "Bot" | null;
  owner_approved_head: 0 | 1 | null; facts_json: string; observed_at: number; created_at: number;
}

export interface MergerPrRef { repository: string; pr_number: number }
export interface MergerDecisionInput extends MergerPrRef {
  mission_id: string;
  head_sha: string;
  /** Live base tip; null only when the verdict is `unevaluated`. */
  base_sha: string | null;
  verdict: MergerVerdictKind;
  codes: readonly string[];
  gates: Record<string, unknown>;
  merge_request?: { sha: string; merge_method: "squash" } | null;
  evidence_digest: string;
  /** Local wall time when the cycle started reading. Reporting only; never used for ordering. */
  observed_at: number;
}
export interface MergerDecisionResult {
  observation_seq: number;
  /** `recorded`: a new decision row; `deduped`: same head, verdict and codes as the previous decision. The fence advanced either way. */
  decision: "recorded" | "deduped";
  decision_seq: number | null;
}
export interface MergerOutcomeInput extends MergerPrRef {
  mission_id: string;
  outcome: MergerOutcomeKind;
  head_at_close: string;
  merged_at?: string | null; merge_commit?: string | null;
  merged_by_actor_id?: number | null; merged_by_type?: "User" | "Bot" | null;
  /** null: this repository's approvals are not inspection evidence (registry `inspection_evidence=false`). */
  owner_approved_head?: boolean | null;
  facts?: Record<string, unknown>;
  observed_at: number;
}

/** Stable error codes: `message` is the code. Database trigger codes (`merger_*`) are passed through. */
export class MergerShadowError extends Error {
  constructor(readonly code: string) { super(code); this.name = "MergerShadowError"; }
}
const fail = (code: string): never => { throw new MergerShadowError(code); };

export type MergerCycleEntry = readonly [repository: string, prNumber: number, observationSeq: number, head: string, verdict: MergerVerdictKind];

/** The only surface the shadow merger service receives: four methods, no Mission or chain store. */
export interface MergerShadowWriter {
  recordCycle(startedAt: number, finishedAt: number, prs: readonly MergerCycleEntry[], now: number): number;
  beginObservation(repository: string, prNumber: number, now: number): number;
  recordDecision(input: MergerDecisionInput, observationSeq: number, now: number): MergerDecisionResult;
  recordOutcome(input: MergerOutcomeInput, observationSeq: number, now: number): MergerOutcomeRow;
}
export function mergerShadowWriter(store: MergerShadowStore): MergerShadowWriter {
  return {
    recordCycle: (startedAt, finishedAt, prs, now) => store.recordCycle(startedAt, finishedAt, prs, now),
    beginObservation: (repository, prNumber, now) => store.beginObservation(repository, prNumber, now),
    recordDecision: (input, n, now) => store.recordDecision(input, n, now),
    recordOutcome: (input, n, now) => store.recordOutcome(input, n, now),
  };
}

/** `gates_json` is a closed schema of observed values (ids, oids, states, counts): no bodies, logins, URLs or paths, at any depth. */
const OID_OR_NULL = (v: unknown): boolean => v === null || (typeof v === "string" && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(v));
const TOKEN_OR_NULL = (v: unknown): boolean => v === null || (typeof v === "string" && /^[A-Za-z0-9_.() -]{0,80}$/.test(v));
const INT_OR_NULL = (v: unknown): boolean => v === null || (typeof v === "number" && Number.isSafeInteger(v));
const INT = (v: unknown): boolean => typeof v === "number" && Number.isSafeInteger(v);
const object = (shape: Record<string, (v: unknown) => boolean>) => (v: unknown): boolean =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
  && Object.keys(v).every(k => Object.hasOwn(shape, k) && shape[k]!((v as Record<string, unknown>)[k]));
const GATES_SCHEMA = object({
  start_is_base: v => typeof v === "boolean", second_read: v => typeof v === "boolean",
  g2c: object({ live: OID_OR_NULL, pushed: OID_OR_NULL, candidate: OID_OR_NULL, evidence: OID_OR_NULL, marker: OID_OR_NULL, check: OID_OR_NULL }),
  g3: object({ check_run_id: INT_OR_NULL, conclusion: TOKEN_OR_NULL, duplicates: INT, foreign_same_name: INT }),
  g4: object({ required: v => Array.isArray(v) && v.length <= 32 && v.every(r => Array.isArray(r) && r.length === 4 && TOKEN_OR_NULL(r[0]) && INT(r[1]) && INT_OR_NULL(r[2]) && TOKEN_OR_NULL(r[3])) }),
  g5: object({ base_head: OID_OR_NULL, live_tip: OID_OR_NULL }),
  g6a: object({ review_id: INT_OR_NULL, commit: OID_OR_NULL }),
  g6b: object({ rulesets: v => Array.isArray(v) && v.length <= 8 && v.every(INT), force_push_events: INT }),
  g7: object({ mergeable: TOKEN_OR_NULL, merge_state: TOKEN_OR_NULL }),
  read_ms: v => Array.isArray(v) && v.length === 2 && v.every(INT),
});
const gatesOk = (v: unknown): v is Record<string, unknown> => GATES_SCHEMA(v);

const HEX = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;

// The four statements the writer ever runs against the fence and the evidence tables. Fixed text, bound parameters only.
const SQL_TAKE = "INSERT INTO engineering_merger_shadow_watermarks(repository,pr_number,issued_seq,accepted_seq,updated_at) VALUES(?,?,1,0,?) "
  + "ON CONFLICT(repository,pr_number) DO UPDATE SET issued_seq=issued_seq+1,updated_at=excluded.updated_at RETURNING issued_seq";
const SQL_ADVANCE = "UPDATE engineering_merger_shadow_watermarks SET accepted_seq=?,updated_at=? WHERE repository=? AND pr_number=?";
const SQL_DECISION = `INSERT INTO engineering_merger_shadow_decisions(repository,pr_number,mission_id,observation_seq,head_sha,base_sha,verdict,codes_json,
  codes_digest,gates_json,merge_request_json,evidence_digest,observed_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
const SQL_CYCLE = "INSERT INTO engineering_merger_shadow_cycles(started_at,finished_at,prs_json) VALUES(?,?,?)";
const SQL_OUTCOME = `INSERT INTO engineering_merger_shadow_outcomes(repository,pr_number,mission_id,observation_seq,outcome,head_at_close,merged_at,
  merge_commit,merged_by_actor_id,merged_by_type,owner_approved_head,facts_json,observed_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/** Append-only shadow-merger ledger. Synchronous; every write is one `BEGIN IMMEDIATE` transaction under the daemon owner
 * fence and makes no network, git or process call. It never touches the Mission or revision-chain tables. */
export class MergerShadowStore {
  constructor(readonly attention: AttentionStore, readonly owner: AttentionOwner) {}
  get db(): Database.Database { return this.attention.db; }

  watermark(repository: string, prNumber: number): MergerWatermark | null {
    return (this.db.prepare("SELECT * FROM engineering_merger_shadow_watermarks WHERE repository=? AND pr_number=?").get(this.repo(repository), prNumber) as MergerWatermark | undefined) ?? null;
  }
  decisions(repository: string, prNumber: number): MergerDecisionRow[] {
    return this.db.prepare("SELECT * FROM engineering_merger_shadow_decisions WHERE repository=? AND pr_number=? ORDER BY seq").all(this.repo(repository), prNumber) as MergerDecisionRow[];
  }
  outcomes(repository: string, prNumber: number): MergerOutcomeRow[] {
    return this.db.prepare("SELECT * FROM engineering_merger_shadow_outcomes WHERE repository=? AND pr_number=? ORDER BY seq").all(this.repo(repository), prNumber) as MergerOutcomeRow[];
  }
  /** The decision in force just before the merge: the latest one fenced with a lower observation number than the merged segment. Never wall time. */
  decisionBeforeMerge(repository: string, prNumber: number): MergerDecisionRow | null {
    return (this.db.prepare(`SELECT d.* FROM engineering_merger_shadow_decisions d WHERE d.repository=? AND d.pr_number=? AND d.observation_seq<
      (SELECT o.observation_seq FROM engineering_merger_shadow_outcomes o WHERE o.repository=d.repository AND o.pr_number=d.pr_number AND o.outcome='merged')
      ORDER BY d.observation_seq DESC LIMIT 1`).get(this.repo(repository), prNumber) as MergerDecisionRow | undefined) ?? null;
  }

  /** Take the next observation number for a PR. The number is returned only after its transaction commits; call it before the first GitHub read. */
  beginObservation(repository: string, prNumber: number, now: number): number {
    this.ref({ repository, pr_number: prNumber }); this.clock(now);
    return this.write(() => (this.db.prepare(SQL_TAKE).get(this.repo(repository), prNumber, now) as { issued_seq: number }).issued_seq);
  }

  /** One transaction: advance the fence to `observationSeq` (a number at or below the accepted one is `merger_stale_observation`), then the
   * decision row, which the dedupe trigger may drop. Any failure rolls the whole transaction back, fence included. */
  recordDecision(input: MergerDecisionInput, observationSeq: number, now: number): MergerDecisionResult {
    this.ref(input); this.clock(now); this.clock(input.observed_at); this.seq(observationSeq);
    if (typeof input.mission_id !== "string" || input.mission_id.length === 0 || !HEX.test(input.head_sha) || !HEX64.test(input.evidence_digest)) fail("merger_invalid_input");
    if (input.base_sha !== null && !HEX.test(input.base_sha)) fail("merger_invalid_input");
    const codes = [...new Set(input.codes)].sort();
    if (codes.some(c => typeof c !== "string" || c.length === 0 || c.length > 200)) fail("merger_invalid_input");
    if ((input.verdict === "would_merge") !== (codes.length === 0)) fail("merger_verdict_codes_mismatch");
    if (input.verdict === "would_merge") {
      if (input.base_sha === null || input.merge_request?.sha !== input.head_sha || input.merge_request.merge_method !== "squash") fail("merger_invalid_merge_request");
    } else if (input.merge_request) fail("merger_invalid_merge_request");
    if (input.verdict === "refused" ? codes.some(c => c.startsWith("U.")) : input.verdict === "unevaluated" && codes.some(c => !c.startsWith("U."))) fail("merger_decision_codes_invalid");
    if (input.verdict !== "unevaluated" && input.base_sha === null) fail("merger_invalid_input");
    const codesJson = JSON.stringify(codes);
    const digest = createHash("sha256").update(codesJson).digest("hex");
    if (!gatesOk(input.gates)) fail("merger_invalid_input");
    const gatesJson = JSON.stringify(input.gates);
    if (gatesJson.length > 16384) fail("merger_invalid_input");
    const repository = this.repo(input.repository);
    return this.write(() => {
      this.mission(input.mission_id);
      this.db.prepare(SQL_ADVANCE).run(observationSeq, now, repository, input.pr_number);
      const r = this.db.prepare(SQL_DECISION).run(repository, input.pr_number, input.mission_id, observationSeq, input.head_sha, input.base_sha, input.verdict,
        codesJson, digest, gatesJson, input.merge_request ? JSON.stringify({ sha: input.merge_request.sha, merge_method: input.merge_request.merge_method }) : null,
        input.evidence_digest, input.observed_at, now);
      return { observation_seq: observationSeq, decision: r.changes === 1 ? "recorded" : "deduped", decision_seq: r.changes === 1 ? Number(r.lastInsertRowid) : null } satisfies MergerDecisionResult;
    });
  }

  /** One row per scan cycle: the PRs it looked at (at most 10), so a report can tell "not seen" from "seen, unchanged". */
  recordCycle(startedAt: number, finishedAt: number, prs: readonly MergerCycleEntry[], now: number): number {
    this.clock(startedAt); this.clock(finishedAt); this.clock(now);
    if (finishedAt < startedAt || prs.length > 10) fail("merger_invalid_input");
    for (const [repository, prNumber, seq, head, verdict] of prs) {
      this.ref({ repository, pr_number: prNumber }); this.seq(seq);
      if (!HEX.test(head) || (verdict !== "would_merge" && verdict !== "refused" && verdict !== "unevaluated")) fail("merger_invalid_input");
    }
    const json = JSON.stringify(prs.map(([repository, ...rest]) => [this.repo(repository), ...rest]));
    if (json.length > 4096) fail("merger_invalid_input");
    return this.write(() => Number(this.db.prepare(SQL_CYCLE).run(startedAt, finishedAt, json).lastInsertRowid));
  }

  /** Same fence as decisions: the segment carries the observation number that was just accepted. */
  recordOutcome(input: MergerOutcomeInput, observationSeq: number, now: number): MergerOutcomeRow {
    this.ref(input); this.clock(now); this.clock(input.observed_at); this.seq(observationSeq);
    if (typeof input.mission_id !== "string" || input.mission_id.length === 0 || !HEX.test(input.head_at_close)) fail("merger_invalid_input");
    if (input.merge_commit != null && !HEX.test(input.merge_commit)) fail("merger_invalid_input");
    const factsJson = JSON.stringify(input.facts ?? {});
    if (factsJson.length > 8192) fail("merger_invalid_input");
    const repository = this.repo(input.repository);
    return this.write(() => {
      this.mission(input.mission_id);
      this.db.prepare(SQL_ADVANCE).run(observationSeq, now, repository, input.pr_number);
      const r = this.db.prepare(SQL_OUTCOME).run(repository, input.pr_number, input.mission_id, observationSeq, input.outcome, input.head_at_close, input.merged_at ?? null,
        input.merge_commit ?? null, input.merged_by_actor_id ?? null, input.merged_by_type ?? null,
        input.owner_approved_head === undefined || input.owner_approved_head === null ? null : input.owner_approved_head ? 1 : 0, factsJson, input.observed_at, now);
      return this.db.prepare("SELECT * FROM engineering_merger_shadow_outcomes WHERE seq=?").get(Number(r.lastInsertRowid)) as MergerOutcomeRow;
    });
  }

  /** Repository names compare case-insensitively everywhere else; store and read one lowercase form so casing cannot split a PR's history. */
  private repo(r: string): string { return r.toLowerCase(); }
  private ref(k: MergerPrRef): void {
    if (typeof k.repository !== "string" || k.repository.length < 3 || k.repository.length > 200 || !Number.isSafeInteger(k.pr_number) || k.pr_number < 1) fail("merger_invalid_input");
  }
  /** The dedupe trigger runs before foreign-key checks, so an unknown Mission would advance the fence on a row that is then dropped. */
  private mission(id: string): void {
    if (!this.db.prepare("SELECT 1 FROM engineering_contained_missions WHERE mission_id=?").get(id)) fail("merger_unknown_mission");
  }
  private seq(n: number): void { if (!Number.isSafeInteger(n) || n < 1) fail("merger_invalid_input"); }
  private clock(ms: number): void { if (!Number.isSafeInteger(ms) || ms < 0) fail("merger_invalid_clock"); }
  /** BEGIN IMMEDIATE; `transaction()` rolls back on any throw, so a `RAISE(ABORT)` in a later statement never leaves an advanced fence behind. */
  private write<T>(fn: () => T): T {
    if (this.db.pragma("synchronous", { simple: true }) !== 2) fail("durability_required");
    // Inside a caller's transaction `.immediate()` is only a savepoint: an outer rollback would re-issue a ticket already handed out.
    if (this.db.inTransaction) fail("merger_nested_transaction");
    try {
      return this.db.transaction(() => { this.attention.assertOwner(this.owner); return fn(); }).immediate();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!(error instanceof MergerShadowError) && /^merger_[a-z_]+$/.test(message)) throw new MergerShadowError(message);
      throw error;
    }
  }
}

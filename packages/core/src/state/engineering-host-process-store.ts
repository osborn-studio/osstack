import type Database from "better-sqlite3";
import type { AttentionOwner, AttentionStore } from "./attention-store.js";
import { ContainedMissionStore, type ContainedMission, type ContainedMissionState } from "./engineering-contained-store.js";

/**
 * W13-A host child-process ledger store (design docs/design/2026-11-06-w13-host-git-survival.md sections 3.4, 4, 5.5).
 *
 * The public method names and payloads of `launching` / `registered` / `release` / `stopped` match the
 * `HostProcessJournal` the W13-B launcher (`runGatedProcess`) is written against. The launcher mints `op_id`.
 * The row is synchronous and holds no process knowledge; it starts nothing and probes nothing.
 */

export const HOST_PROCESS_KINDS = ["git_push", "gh_pr_create", "git_update_ref", "git_worktree_add", "git_index_write"] as const;
export type HostProcessKind = (typeof HOST_PROCESS_KINDS)[number];
export const HOST_PROCESS_STOP_PROOFS = [
  "rebooted", "never_registered+marker_unheld", "group_empty+marker_unheld", "leader_reused+marker_unheld",
  "never_released", "never_spawned", "already_stopped",
] as const;
export type HostProcessStopProof = (typeof HOST_PROCESS_STOP_PROOFS)[number];
export type HostProcessState = "launching" | "registered" | "released" | "stopped";

export interface HostProcessMarker { path: string; dev: string; ino: string }
export interface HostProcessLaunchInput {
  op_id: string; mission_id: string; kind: HostProcessKind; remote_target?: string; local_target: string;
  intent_id?: string; argv_digest: string; boot_id: string; marker: HostProcessMarker;
}
export interface HostProcessIdentity { pid: number; pgid: number; leader_start: string | null }
export interface HostProcessOutcome {
  proof: HostProcessStopProof; detail: Record<string, unknown>; exit_code?: number | null; exit_signal?: string | null;
}
export interface HostProcessRecord {
  op_id: string; mission_id: string; kind: HostProcessKind; remote_target: string | null; local_target: string; intent_id: string | null;
  argv_digest: string; owner_home: string; owner_instance: string; owner_generation: number; boot_id: string;
  marker_path: string; marker_dev: string; marker_ino: string; state: HostProcessState;
  pid: number | null; pgid: number | null; leader_start: string | null; released_at: number | null;
  exit_code: number | null; exit_signal: string | null; stop_proof: HostProcessStopProof | null; stop_detail_json: string | null;
  created_at: number; updated_at: number;
}
export interface HostProcessExit {
  to: ContainedMissionState; event: { kind: string; payload: unknown }; actor?: string;
}
export interface HostProcessStoreOptions { clock?: () => number }

const OP_ID = /^hp_[A-Za-z0-9]{1,125}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const DEVINO = /^(?:[0-9]{1,30}|0x[0-9a-fA-F]{1,28})$/;
const MAX_DETAIL = 4096;

export class HostProcessStore {
  private readonly clock: () => number;
  private readonly contained: ContainedMissionStore;
  constructor(readonly attention: AttentionStore, readonly owner: AttentionOwner, options: HostProcessStoreOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.contained = new ContainedMissionStore(attention, owner);
  }
  get db(): Database.Database { return this.attention.db; }

  // ---- reads ---------------------------------------------------------------------------------

  get(opId: string): HostProcessRecord {
    const row = this.db.prepare("SELECT * FROM engineering_host_processes WHERE op_id=?").get(opId) as HostProcessRecord | undefined;
    if (!row) throw Error("not_found");
    return row;
  }
  /** Every record that is not yet proven stopped (state<>'stopped'), oldest first. */
  open(missionId?: string): HostProcessRecord[] {
    return (missionId === undefined
      ? this.db.prepare("SELECT * FROM engineering_host_processes WHERE state<>'stopped' ORDER BY created_at,op_id").all()
      : this.db.prepare("SELECT * FROM engineering_host_processes WHERE state<>'stopped' AND mission_id=? ORDER BY created_at,op_id").all(missionId)
    ) as HostProcessRecord[];
  }
  hasOpen(missionId: string): boolean {
    return this.db.prepare("SELECT 1 FROM engineering_host_processes WHERE mission_id=? AND state<>'stopped' LIMIT 1").get(missionId) !== undefined;
  }
  /**
   * Open records recovery must classify (design 5.1): written by an older owner generation, plus, when `activeOpIds` is
   * given, current-owner records with no live handle in this process (e.g. an online proof that timed out). Without
   * `activeOpIds` the current owner's records are treated as in flight.
   */
  openForRecovery(limit = 100, activeOpIds?: ReadonlySet<string>): HostProcessRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw Error("invalid_limit");
    const rows = this.db.prepare(`SELECT * FROM engineering_host_processes WHERE state<>'stopped' ORDER BY created_at,op_id`).all() as HostProcessRecord[];
    const current = (r: HostProcessRecord) => r.owner_home === this.owner.home_id && r.owner_instance === this.owner.instance_id && r.owner_generation === this.owner.generation;
    return rows.filter(r => !current(r) || (activeOpIds !== undefined && !activeOpIds.has(r.op_id))).slice(0, limit);
  }
  /** Missions with at least one record not proven stopped, oldest record first. */
  missionsWithOpen(limit = 100): string[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw Error("invalid_limit");
    return (this.db.prepare(`SELECT mission_id FROM engineering_host_processes WHERE state<>'stopped'
      GROUP BY mission_id ORDER BY MIN(created_at),mission_id LIMIT ?`).all(limit) as Array<{ mission_id: string }>).map(r => r.mission_id);
  }
  /** Records already proven stopped for a Mission: the evidence list recovery attaches to its settle event. */
  stoppedProofs(missionId: string): Array<{ op_id: string; proof: HostProcessStopProof }> {
    return this.db.prepare("SELECT op_id,stop_proof AS proof FROM engineering_host_processes WHERE mission_id=? AND state='stopped' ORDER BY created_at,op_id")
      .all(missionId) as Array<{ op_id: string; proof: HostProcessStopProof }>;
  }
  /** True only if the release byte may have been written: `released_at IS NULL` means the program never ran (design 4.2). */
  remoteEffectPossible(op: string | HostProcessRecord): boolean {
    const record = typeof op === "string" ? this.get(op) : op;
    return record.released_at !== null;
  }

  // ---- journal (top-level durable transactions) -----------------------------------------------

  launching(input: HostProcessLaunchInput): void {
    this.topLevel();
    const now = this.now();
    validateLaunch(input);
    this.write(() => {
      try {
        this.db.prepare(`INSERT INTO engineering_host_processes(op_id,mission_id,kind,remote_target,local_target,intent_id,argv_digest,
          owner_home,owner_instance,owner_generation,boot_id,marker_path,marker_dev,marker_ino,state,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'launching',?,?)`)
          .run(input.op_id, input.mission_id, input.kind, input.remote_target ?? null, input.local_target, input.intent_id ?? null,
            input.argv_digest, this.owner.home_id, this.owner.instance_id, this.owner.generation, input.boot_id,
            input.marker.path, input.marker.dev, input.marker.ino, now, now);
      } catch (error) {
        throw mapUnique(error);
      }
      this.event(input.mission_id, "host_process_launching", {
        op_id: input.op_id, kind: input.kind, remote_target: input.remote_target ?? null, local_target: input.local_target,
        intent_id: input.intent_id ?? null, argv_digest: input.argv_digest, boot_id: input.boot_id,
      }, now);
    });
  }

  registered(opId: string, identity: HostProcessIdentity): void {
    this.topLevel();
    const now = this.now();
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 1 || identity.pgid !== identity.pid) throw Error("host_process_invalid_identity");
    if (identity.leader_start !== null && (typeof identity.leader_start !== "string" || identity.leader_start.length < 1 || identity.leader_start.length > 256)) {
      throw Error("host_process_invalid_identity");
    }
    this.write(() => {
      const row = this.get(opId);
      this.changed(this.db.prepare("UPDATE engineering_host_processes SET state='registered',pid=?,pgid=?,leader_start=?,updated_at=? WHERE op_id=? AND state='launching'")
        .run(identity.pid, identity.pgid, identity.leader_start, now, opId));
      this.event(row.mission_id, "host_process_registered", { op_id: opId, pid: identity.pid, pgid: identity.pgid, leader_start: identity.leader_start }, now);
    });
  }

  /**
   * Runs `fence()` first, then records registered -> released, all in one top-level transaction: a throwing fence (or a
   * failing write) rolls the whole thing back, including anything the fence wrote. The fence must be synchronous.
   */
  release(opId: string, fence: () => void): void {
    this.topLevel();
    const now = this.now();
    if (typeof fence !== "function") throw Error("host_process_fence_required");
    this.write(() => {
      const row = this.get(opId);
      const result: unknown = fence();
      if (result !== undefined && result !== null && typeof (result as { then?: unknown }).then === "function") throw Error("host_process_fence_async");
      this.changed(this.db.prepare("UPDATE engineering_host_processes SET state='released',released_at=?,updated_at=? WHERE op_id=? AND state='registered'")
        .run(now, now, opId));
      this.event(row.mission_id, "host_process_released", { op_id: opId, kind: row.kind, remote_target: row.remote_target }, now);
    });
  }

  stopped(opId: string, outcome: HostProcessOutcome): void {
    this.topLevel();
    const now = this.now();
    if (!(HOST_PROCESS_STOP_PROOFS as readonly string[]).includes(outcome.proof)) throw Error("host_process_invalid_proof");
    const detail = JSON.stringify(outcome.detail ?? {});
    if (detail === undefined || detail.length > MAX_DETAIL) throw Error("host_process_detail_too_large");
    const exitCode = outcome.exit_code ?? null;
    const exitSignal = outcome.exit_signal ?? null;
    if (exitCode !== null && !Number.isSafeInteger(exitCode)) throw Error("host_process_invalid_exit");
    if (exitSignal !== null && (typeof exitSignal !== "string" || exitSignal.length < 1 || exitSignal.length > 32)) throw Error("host_process_invalid_exit");
    this.write(() => {
      const row = this.get(opId);
      if (row.state === "stopped") throw Error("host_process_already_stopped");
      this.changed(this.db.prepare(`UPDATE engineering_host_processes SET state='stopped',stop_proof=?,stop_detail_json=?,exit_code=?,exit_signal=?,updated_at=?
        WHERE op_id=? AND state<>'stopped'`).run(outcome.proof, detail, exitCode, exitSignal, now, opId));
      this.event(row.mission_id, "host_process_stopped",
        { op_id: opId, proof: outcome.proof, exit_code: exitCode, exit_signal: exitSignal, released: row.released_at !== null, detail: outcome.detail }, now);
    });
  }

  // ---- recovery ------------------------------------------------------------------------------

  /** Audit event for a record recovery could not prove stopped. Writes no row change (design 5.2). */
  recordUnproven(opId: string, reason: string): number {
    const now = this.now();
    if (!reason || reason.length > 64) throw Error("invalid_reason");
    return this.write(() => {
      const row = this.get(opId);
      return this.event(row.mission_id, "host_process_unproven", { op_id: opId, state: row.state, reason }, now);
    });
  }

  /**
   * After every record of the Mission is `stopped` (committed earlier, by `stopped`): clear the stop obligation (only when it is
   * set) and leave `stop_unknown` (or, with nothing to clear, a non-terminal state such as `authorized`) in ONE owner transaction. A failure at any step rolls back every step, so the
   * `stop_unknown + stop_obligation=0` crash window of the two-commit form cannot arise.
   */
  settleStopped(missionId: string, ifRevision: number, evidence: unknown, exit: HostProcessExit): ContainedMission {
    this.topLevel();
    const now = this.now();
    if (!Number.isSafeInteger(ifRevision) || ifRevision < 1) throw Error("invalid_revision");
    return this.write(() => {
      const mission = this.contained.get(missionId);
      if (mission.revision !== ifRevision) throw Error("version_conflict");
      // stop_unknown, or a Mission whose obligation was never set (an `authorized` orphan worktree-add proven stopped on first recovery).
      if (mission.state !== "stop_unknown" && mission.stop_obligation === 1) throw Error("settle_requires_stop_unknown");
      if (this.hasOpen(missionId)) throw Error("host_process_unproven");
      let revision = mission.revision;
      if (mission.stop_obligation === 1) {
        revision = this.contained.recordStopEvidence(missionId, revision, evidence, now).revision;
      } else {
        this.contained.record(missionId, "host_process_settled", evidence, now);
      }
      return this.contained.transition(missionId, {
        if_revision: revision, to: exit.to, event: exit.event, ...(exit.actor === undefined ? {} : { actor: exit.actor }),
      }, now);
    });
  }

  // ---- internals -----------------------------------------------------------------------------

  /** `attention.write` runs inline inside an outer transaction, so an outer rollback would erase a release the child already saw. */
  private topLevel(): void {
    if (this.db.inTransaction) throw Error("host_process_nested_transaction");
  }
  private write<T>(fn: () => T): T {
    if (this.db.pragma("synchronous", { simple: true }) !== 2) throw Error("durability_required");
    return this.attention.write(this.owner, fn);
  }
  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) throw Error("invalid_clock");
    return now;
  }
  /** A guarded UPDATE that matched no row means the record was not in the state the call requires. */
  private changed(result: { changes: number }): void {
    if (result.changes !== 1) throw Error("host_process_flow");
  }
  private event(missionId: string, kind: string, payload: unknown, now: number): number {
    const json = JSON.stringify(payload);
    if (json.length > 32768) throw Error("event_too_large");
    return Number(this.db.prepare("INSERT INTO engineering_contained_events(mission_id,kind,actor,payload_json,created_at) VALUES(?,?,NULL,?,?)")
      .run(missionId, kind, json, now).lastInsertRowid);
  }
}

function validateLaunch(input: HostProcessLaunchInput): void {
  const bad = (code: string): never => { throw Error(`host_process_invalid_${code}`); };
  if (typeof input.op_id !== "string" || !OP_ID.test(input.op_id)) bad("op_id");
  if (typeof input.mission_id !== "string" || input.mission_id.length < 1 || input.mission_id.length > 256) bad("mission");
  if (!(HOST_PROCESS_KINDS as readonly string[]).includes(input.kind)) bad("kind");
  if ((input.kind === "git_push" || input.kind === "gh_pr_create") && !input.remote_target) bad("remote_target");
  if (input.remote_target !== undefined && (typeof input.remote_target !== "string" || input.remote_target.length < 1 || input.remote_target.length > 1024)) bad("remote_target");
  if (typeof input.local_target !== "string" || input.local_target.length < 1 || input.local_target.length > 1024) bad("local_target");
  if (input.intent_id !== undefined && (typeof input.intent_id !== "string" || input.intent_id.length < 1 || input.intent_id.length > 256)) bad("intent");
  if (typeof input.argv_digest !== "string" || !DIGEST.test(input.argv_digest)) bad("argv_digest");
  if (typeof input.boot_id !== "string" || input.boot_id.length < 1 || input.boot_id.length > 256) bad("boot_id");
  const marker = input.marker as HostProcessMarker | undefined;
  if (!marker || typeof marker.path !== "string" || marker.path.length < 1 || marker.path.length > 1024 || marker.path.includes("\0")) bad("marker");
  else if (typeof marker.dev !== "string" || !DEVINO.test(marker.dev) || typeof marker.ino !== "string" || !DEVINO.test(marker.ino)) bad("marker");
}

function mapUnique(error: unknown): unknown {
  if (!(error instanceof Error) || !/UNIQUE/.test(error.message)) return error;
  if (/intent_id/.test(error.message)) return Error("host_process_intent_reused");
  if (/remote_target/.test(error.message)) return Error("host_process_remote_busy");
  if (/mission_id/.test(error.message)) return Error("host_process_mission_busy");
  if (/op_id/.test(error.message)) return Error("host_process_op_exists");
  return error;
}

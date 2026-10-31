import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { attentionDigest, type AttentionOwner, type AttentionStore } from "./attention-store.js";
import type { EngineeringPrincipal } from "./engineering-store.js";

export type ContainedMissionState =
  | "authorized" | "workspace_ready" | "executing" | "candidate_ready" | "verifying" | "verified" | "verify_failed"
  | "revalidating" | "delivering" | "pr_opened" | "awaiting_decision" | "needs_reconciliation" | "stop_unknown"
  | "cancel_requested" | "cancelled" | "abandoned" | "failed";
export interface ContainedMission {
  mission_id: string; scope_id: string; owner_principal_id: string; owner_client_session_id: string;
  spec_digest: string; spec_json: string; state: ContainedMissionState; revision: number;
  expected_head: string | null; candidate_head: string | null; candidate_tree: string | null; candidate_diff_digest: string | null;
  verify_attempts: number; repair_cycles: number; stop_obligation: 0 | 1;
  /** 1 only after verifying → verified for the current candidate. */ candidate_verified: 0 | 1;
  /** A failed verification awaits repair; the next execution consumes one repair cycle. */ repair_pending: 0 | 1;
  supersedes: string | null;
  created_at: number; updated_at: number;
}
export interface ContainedEvent { seq: number; mission_id: string; kind: string; actor: string | null; payload_json: string; created_at: number }
export interface WorkspaceClaim {
  claim_id: string; mission_id: string; repo_identity: string; branch: string; worktree_identity: string;
  state: "active" | "released"; created_at: number; released_at: number | null; release_reason: string | null;
}
export interface ContainedAuthorizeInput {
  scope_id: string; spec: Record<string, unknown>; supersedes?: string;
  claim: { repo_identity: string; branch: string; worktree_identity: string };
}
export interface ContainedTransition {
  if_revision: number; to: ContainedMissionState; event: { kind: string; payload: unknown }; actor?: string;
  candidate?: { head: string; tree: string; diff_digest: string } | null; expected_head?: string;
}

const TERMINAL: ReadonlySet<ContainedMissionState> = new Set(["pr_opened", "cancelled", "abandoned", "failed"]);
// Reachable from any non-terminal state; the decision table (§4.4) narrows how a Mission leaves them.
const HALTS: readonly ContainedMissionState[] = ["awaiting_decision", "needs_reconciliation", "stop_unknown", "cancel_requested", "failed"];
const NEXT: Readonly<Record<ContainedMissionState, readonly ContainedMissionState[]>> = {
  authorized: ["workspace_ready"],
  workspace_ready: ["executing"],
  executing: ["candidate_ready"],
  candidate_ready: ["verifying"],
  verifying: ["verified", "verify_failed"],
  verify_failed: ["executing"],
  verified: ["revalidating"],
  revalidating: ["delivering", "candidate_ready"],
  delivering: ["pr_opened", "candidate_ready"],
  awaiting_decision: ["executing", "revalidating", "abandoned"],
  needs_reconciliation: ["executing", "candidate_ready", "abandoned"],
  stop_unknown: ["needs_reconciliation", "abandoned"],
  cancel_requested: ["cancelled"],
  pr_opened: [], cancelled: [], abandoned: [], failed: [],
};
const CANDIDATE_PATH: ReadonlySet<ContainedMissionState> = new Set(["verifying", "verified", "verify_failed", "revalidating", "delivering", "pr_opened"]);
const MAX_REPAIR_CYCLES = 8;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DIGEST = /^[0-9a-f]{64}$/;

/** Ledger for host-orchestrated contained Missions. Synchronous, under the
 * daemon owner fence; it starts no process and performs no git or network call. */
export class ContainedMissionStore {
  constructor(readonly attention: AttentionStore, readonly owner: AttentionOwner) {}
  get db(): Database.Database { return this.attention.db; }

  get(missionId: string): ContainedMission {
    const row = this.db.prepare("SELECT * FROM engineering_contained_missions WHERE mission_id=?").get(missionId) as ContainedMission | undefined;
    if (!row) throw Error("not_found"); return row;
  }
  claim(missionId: string): WorkspaceClaim {
    const row = this.db.prepare("SELECT * FROM engineering_workspace_claims WHERE mission_id=?").get(missionId) as WorkspaceClaim | undefined;
    if (!row) throw Error("not_found"); return row;
  }
  events(missionId: string, afterSeq = 0, limit = 100): ContainedEvent[] {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw Error("invalid_limit");
    return this.db.prepare("SELECT * FROM engineering_contained_events WHERE mission_id=? AND seq>? ORDER BY seq LIMIT ?").all(missionId, afterSeq, limit) as ContainedEvent[];
  }
  readable(principal: EngineeringPrincipal, missionId: string): ContainedMission {
    const mission = this.db.prepare("SELECT * FROM engineering_contained_missions WHERE mission_id=?").get(missionId) as ContainedMission | undefined;
    if (!mission || !principal.read_scopes.includes(mission.scope_id)) throw Error("permission_denied");
    return mission;
  }
  /** Missions recovery must visit: non-terminal, an open stop obligation, or a held claim (§9). */
  listOutstanding(limit = 100, after?: { created_at: number; mission_id: string }): Array<{ mission_id: string; created_at: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (after && (!Number.isSafeInteger(after.created_at) || after.created_at < 0 || !after.mission_id))) throw Error("invalid_limit");
    return this.db.prepare(`SELECT m.mission_id,m.created_at FROM engineering_contained_missions m
      LEFT JOIN engineering_workspace_claims c ON c.mission_id=m.mission_id
      WHERE (m.state NOT IN ('pr_opened','cancelled','abandoned','failed') OR m.stop_obligation=1 OR c.state='active')
      AND (m.created_at>? OR (m.created_at=? AND m.mission_id>?)) ORDER BY m.created_at,m.mission_id LIMIT ?`)
      .all(after?.created_at ?? -1, after?.created_at ?? -1, after?.mission_id ?? "", limit) as Array<{ mission_id: string; created_at: number }>;
  }

  authorize(principal: EngineeringPrincipal, input: ContainedAuthorizeInput, now: number): ContainedMission {
    this.clock(now);
    if (!principal.principal_id || !principal.client_session_id || !principal.write_scopes.includes(input.scope_id)) throw Error("permission_denied");
    if (input.spec === null || typeof input.spec !== "object" || Array.isArray(input.spec)) throw Error("invalid_spec");
    const { repo_identity, branch, worktree_identity } = input.claim;
    if (![repo_identity, branch, worktree_identity].every(v => typeof v === "string" && v.length > 0 && v.length <= 1024)) throw Error("invalid_claim");
    const spec_json = JSON.stringify(input.spec);
    if (spec_json.length > 32768) throw Error("invalid_spec");
    return this.write(() => {
      let repairCycles = 0; let repairPending = 0;
      if (input.supersedes) {
        const prior = this.get(input.supersedes);
        if (prior.scope_id !== input.scope_id) throw Error("permission_denied");
        if (!TERMINAL.has(prior.state)) throw Error("supersedes_active_mission");
        repairCycles = prior.repair_cycles; repairPending = prior.repair_pending;
        // Hand the worktree over; a prior Mission with unproven stop keeps its claim, so this fails as workspace_claimed.
        if (prior.stop_obligation === 0 && this.claim(prior.mission_id).state === "active") {
          this.db.prepare("UPDATE engineering_workspace_claims SET state='released',released_at=?,release_reason='superseded' WHERE mission_id=?").run(now, prior.mission_id);
          this.event(prior.mission_id, "workspace_released", null, { reason: "superseded" }, now);
        }
      }
      const missionId = `cm_${randomUUID()}`;
      this.db.prepare(`INSERT INTO engineering_contained_missions(mission_id,scope_id,owner_principal_id,owner_client_session_id,spec_digest,spec_json,
        state,revision,repair_cycles,repair_pending,supersedes,created_at,updated_at) VALUES(?,?,?,?,?,?,'authorized',1,?,?,?,?,?)`)
        .run(missionId, input.scope_id, principal.principal_id, principal.client_session_id, attentionDigest(input.spec), spec_json, repairCycles, repairPending, input.supersedes ?? null, now, now);
      try {
        this.db.prepare(`INSERT INTO engineering_workspace_claims(claim_id,mission_id,repo_identity,branch,worktree_identity,state,created_at)
          VALUES(?,?,?,?,?,'active',?)`).run(`wc_${randomUUID()}`, missionId, repo_identity, branch, worktree_identity, now);
      } catch (error) {
        if (error instanceof Error && /UNIQUE/.test(error.message)) throw Error("workspace_claimed");
        throw error;
      }
      const mission = this.get(missionId);
      this.event(missionId, "contained_authorized", principal.principal_id, { spec_digest: mission.spec_digest, supersedes: mission.supersedes }, now);
      this.event(missionId, "workspace_claimed", null, { repo_identity, branch, worktree_identity }, now);
      return mission;
    });
  }

  /** One compare-and-swap step of the §4.3 state machine plus its event, atomically. */
  transition(missionId: string, step: ContainedTransition, now: number): ContainedMission {
    this.clock(now);
    return this.write(() => {
      const mission = this.get(missionId);
      if (mission.revision !== step.if_revision) throw Error("version_conflict");
      if (TERMINAL.has(mission.state)) throw Error("mission_terminal");
      const from = mission.state; const to = step.to;
      if (!NEXT[from].includes(to) && !HALTS.includes(to)) throw Error("transition_denied");
      // No new execution and no host write while a previous executor may still be running.
      if ((to === "cancelled" || to === "executing" || to === "candidate_ready") && mission.stop_obligation === 1) throw Error("stop_evidence_required");
      if ((to === "revalidating" || to === "delivering") && mission.candidate_verified !== 1) throw Error("verification_required");
      if (from === "verifying" && (to === "verified" || to === "verify_failed") && mission.stop_obligation === 1) throw Error("stop_evidence_required");
      let repair = mission.repair_cycles; let pending = mission.repair_pending;
      if (to === "verify_failed") pending = 1;
      if (to === "executing" && pending === 1) {
        // A user grant after exhaustion may extend up to the hard cap; every other route stays within the spec.
        const limit = from === "awaiting_decision" ? MAX_REPAIR_CYCLES : specRepairLimit(mission.spec_json);
        if (repair >= limit) throw Error("repair_cycles_exhausted");
        repair += 1; pending = 0;
      }
      const attempts = to === "verifying" ? mission.verify_attempts + 1 : mission.verify_attempts;
      const candidate = candidateFor(mission, from, to, step.candidate);
      const verified = to === "verified" ? 1 : candidate && candidate.head === mission.candidate_head && to !== "candidate_ready" && to !== "verify_failed" && to !== "verifying" ? mission.candidate_verified : 0;
      if (step.expected_head !== undefined && !SHA.test(step.expected_head)) throw Error("invalid_head");
      const expectedHead = step.expected_head ?? mission.expected_head;
      // An executor turn and a verification container are both effects that must be proven stopped.
      const obligation = to === "executing" || to === "verifying" ? 1 : mission.stop_obligation;
      this.db.prepare(`UPDATE engineering_contained_missions SET state=?,revision=revision+1,updated_at=?,expected_head=?,
        candidate_head=?,candidate_tree=?,candidate_diff_digest=?,verify_attempts=?,repair_cycles=?,stop_obligation=?,
        candidate_verified=?,repair_pending=? WHERE mission_id=?`)
        .run(to, now, expectedHead, candidate?.head ?? null, candidate?.tree ?? null, candidate?.diff_digest ?? null, attempts, repair, obligation,
          verified, pending, missionId);
      this.event(missionId, step.event.kind, step.actor ?? null, { ...asObject(step.event.payload), from, to }, now);
      return this.get(missionId);
    });
  }

  /** Append an intent or receipt without changing state. */
  record(missionId: string, kind: string, payload: unknown, now: number, actor?: string): number {
    this.clock(now);
    return this.write(() => { this.get(missionId); return this.event(missionId, kind, actor ?? null, payload, now); });
  }

  /** Clears the open stop obligation once the host holds stop evidence; allowed in terminal states too. */
  recordStopEvidence(missionId: string, ifRevision: number, evidence: unknown, now: number): ContainedMission {
    this.clock(now);
    return this.write(() => {
      const mission = this.get(missionId);
      if (mission.revision !== ifRevision) throw Error("version_conflict");
      if (mission.stop_obligation !== 1) throw Error("no_stop_obligation");
      this.db.prepare("UPDATE engineering_contained_missions SET stop_obligation=0,revision=revision+1,updated_at=? WHERE mission_id=?").run(now, missionId);
      this.event(missionId, "executor_stopped", null, asObject(evidence), now);
      return this.get(missionId);
    });
  }

  releaseClaim(missionId: string, reason: string, now: number): WorkspaceClaim {
    this.clock(now);
    if (!reason || reason.length > 256) throw Error("invalid_reason");
    return this.write(() => {
      const mission = this.get(missionId);
      if (!TERMINAL.has(mission.state) || mission.stop_obligation === 1) throw Error("claim_release_denied");
      const claim = this.claim(missionId);
      if (claim.state !== "active") throw Error("claim_released");
      this.db.prepare("UPDATE engineering_workspace_claims SET state='released',released_at=?,release_reason=? WHERE mission_id=?").run(now, reason, missionId);
      this.event(missionId, "workspace_released", null, { reason }, now);
      return this.claim(missionId);
    });
  }

  private write<T>(fn: () => T): T {
    if (this.db.pragma("synchronous", { simple: true }) !== 2) throw Error("durability_required");
    return this.attention.write(this.owner, fn);
  }
  private clock(now: number): void { if (!Number.isSafeInteger(now) || now < 0) throw Error("invalid_clock"); }
  private event(missionId: string, kind: string, actor: string | null, payload: unknown, now: number): number {
    if (!kind || kind.length > 64) throw Error("invalid_event");
    const json = JSON.stringify(payload);
    if (json.length > 32768) throw Error("event_too_large");
    return Number(this.db.prepare("INSERT INTO engineering_contained_events(mission_id,kind,actor,payload_json,created_at) VALUES(?,?,?,?,?)")
      .run(missionId, kind, actor, json, now).lastInsertRowid);
  }
}

/** Upgrade holds for contained work: anything recovery would still visit (§4.1). */
export function containedUpgradeHolds(db: Database.Database): number {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='engineering_contained_missions'").get()) return 0;
  return (db.prepare(`SELECT COUNT(*) n FROM engineering_contained_missions m
    LEFT JOIN engineering_workspace_claims c ON c.mission_id=m.mission_id
    WHERE m.state NOT IN ('pr_opened','cancelled','abandoned','failed') OR m.stop_obligation=1 OR c.state='active'`).get() as { n: number }).n;
}

function specRepairLimit(specJson: string): number {
  const value = (JSON.parse(specJson) as { max_repair_cycles?: unknown }).max_repair_cycles;
  return Number.isSafeInteger(value) && (value as number) >= 0 ? Math.min(value as number, MAX_REPAIR_CYCLES) : 2;
}
// A candidate is fixed on entering candidate_ready and survives only along the
// verify/deliver path; every other move drops it, so stale evidence cannot carry over.
function candidateFor(mission: ContainedMission, from: ContainedMissionState, to: ContainedMissionState, next: ContainedTransition["candidate"]) {
  if (to === "candidate_ready") {
    if (!next || !SHA.test(next.head) || !SHA.test(next.tree) || !DIGEST.test(next.diff_digest)) throw Error("candidate_required");
    return next;
  }
  if (next) throw Error("candidate_unexpected");
  const current = mission.candidate_head
    ? { head: mission.candidate_head, tree: mission.candidate_tree!, diff_digest: mission.candidate_diff_digest! }
    : null;
  if (CANDIDATE_PATH.has(to)) {
    if (!current) throw Error("candidate_required");
    return current;
  }
  return HALTS.includes(to) && from !== "executing" ? current : null;
}
function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { value };
}

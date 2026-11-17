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
export const MAX_REPAIR_CHAIN_DEPTH = 8;
export const LINEAGE_UNKNOWN_REASON = "verify_chain_lineage_unknown";
export type MissionLineageSourceKind = "local_root" | "supersede" | "review" | "github_actions" | "local_failure" | "verification" | "patrol";
export type DerivedSourceKind = Exclude<MissionLineageSourceKind, "local_root" | "supersede">;
export interface MissionLineage {
  mission_id: string; origin_mission_id: string; parent_mission_id: string | null; chain_depth: number;
  source_kind: MissionLineageSourceKind; source_id: string | null; idempotency_key: string | null; created_at: number;
}
export type LineageResolution = { status: "known"; lineage: MissionLineage }
  | { status: "unknown"; reason: typeof LINEAGE_UNKNOWN_REASON; detail: string };
export interface ContainedDeriveInput {
  parent_mission_id: string; scope_id: string; spec: Record<string, unknown>;
  claim: { repo_identity: string; branch: string; worktree_identity: string };
  source: { kind: DerivedSourceKind; id: string }; idempotency_key: string;
}
export type ContainedDeriveResult =
  | { status: "registered" | "duplicate"; mission: ContainedMission; lineage: MissionLineage }
  | { status: "waiting"; reason: typeof LINEAGE_UNKNOWN_REASON; parent_mission_id: string };

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
  // candidate_ready: only the same candidate, to resume a launch the budget or grant stopped before it began (revision children).
  // workspace_ready: W13 `resume_workspace` after an orphaned worktree add was proven stopped (the runner checks the halt reason).
  awaiting_decision: ["executing", "revalidating", "abandoned", "candidate_ready", "workspace_ready"],
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

  /** Missions in `pr_opened`, in (created_at, mission_id) order, for the read-only shadow reconciler's cursor scan. */
  listPrOpened(limit = 100, after?: { created_at: number; mission_id: string }): Array<{ mission_id: string; created_at: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (after && (!Number.isSafeInteger(after.created_at) || after.created_at < 0 || !after.mission_id))) throw Error("invalid_limit");
    return this.db.prepare(`SELECT mission_id,created_at FROM engineering_contained_missions WHERE state='pr_opened'
      AND (created_at>? OR (created_at=? AND mission_id>?)) ORDER BY created_at,mission_id LIMIT ?`)
      .all(after?.created_at ?? -1, after?.created_at ?? -1, after?.mission_id ?? "", limit) as Array<{ mission_id: string; created_at: number }>;
  }

  lineage(missionId: string): MissionLineage | null {
    return this.db.prepare("SELECT * FROM engineering_mission_lineage WHERE mission_id=?").get(missionId) as MissionLineage | undefined ?? null;
  }

  resolveLineage(missionId: string): LineageResolution {
    const unknown = (detail: string): LineageResolution => ({ status: "unknown", reason: LINEAGE_UNKNOWN_REASON, detail });
    const seen = new Set<string>();
    const walk = (id: string, hops: number): LineageResolution => {
      if (hops > 64 || seen.has(id)) return unknown("lineage_cycle_or_limit");
      seen.add(id);
      const row = this.lineage(id);
      if (!row) return unknown("lineage_missing");
      if (!Number.isSafeInteger(row.chain_depth) || row.chain_depth < 0) return unknown("lineage_depth_invalid");
      if (row.source_kind === "supersede") {
        const priorId = this.get(id).supersedes;
        if (!priorId) return unknown("lineage_supersedes_missing");
        const prior = walk(priorId, hops + 1);
        if (prior.status === "unknown") return prior;
        if (row.origin_mission_id !== prior.lineage.origin_mission_id || row.parent_mission_id !== prior.lineage.parent_mission_id
          || row.chain_depth !== prior.lineage.chain_depth) return unknown("lineage_supersedes_mismatch");
      } else if (row.parent_mission_id === null) {
        if (row.chain_depth !== 0 || row.origin_mission_id !== id) return unknown("lineage_root_mismatch");
      } else {
        const parent = walk(row.parent_mission_id, hops + 1);
        if (parent.status === "unknown") return parent;
        if (row.origin_mission_id !== parent.lineage.origin_mission_id || row.chain_depth !== parent.lineage.chain_depth + 1)
          return unknown("lineage_parent_mismatch");
      }
      return { status: "known", lineage: row };
    };
    return walk(missionId, 0);
  }

  authorize(principal: EngineeringPrincipal, input: ContainedAuthorizeInput, now: number): ContainedMission {
    this.rejectLineageInput(input, true);
    const specJson = this.validateRegistration(principal, input, now);
    return this.write(() => {
      let repairCycles = 0; let repairPending = 0;
      let priorLineage: LineageResolution | undefined;
      if (input.supersedes) {
        const prior = this.get(input.supersedes);
        if (prior.scope_id !== input.scope_id) throw Error("permission_denied");
        if (!TERMINAL.has(prior.state)) throw Error("supersedes_active_mission");
        repairCycles = prior.repair_cycles; repairPending = prior.repair_pending;
        priorLineage = this.resolveLineage(prior.mission_id);
        // Hand the worktree over; a prior Mission with unproven stop keeps its claim, so this fails as workspace_claimed.
        if (prior.stop_obligation === 0 && this.claim(prior.mission_id).state === "active") {
          this.db.prepare("UPDATE engineering_workspace_claims SET state='released',released_at=?,release_reason='superseded' WHERE mission_id=?").run(now, prior.mission_id);
          this.event(prior.mission_id, "workspace_released", null, { reason: "superseded" }, now);
        }
      }
      const mission = this.insertMission(principal, input, specJson, now, repairCycles, repairPending);
      if (priorLineage?.status === "unknown") {
        this.event(mission.mission_id, "mission_lineage_unknown", null, { reason: LINEAGE_UNKNOWN_REASON, supersedes: input.supersedes }, now);
      } else {
        this.insertLineage({ mission_id: mission.mission_id, origin_mission_id: priorLineage?.lineage.origin_mission_id ?? mission.mission_id,
          parent_mission_id: priorLineage?.lineage.parent_mission_id ?? null, chain_depth: priorLineage?.lineage.chain_depth ?? 0,
          source_kind: input.supersedes ? "supersede" : "local_root", source_id: input.supersedes ?? null, idempotency_key: null, created_at: now });
      }
      return mission;
    });
  }

  registerDerived(principal: EngineeringPrincipal, input: ContainedDeriveInput, now: number): ContainedDeriveResult {
    this.rejectLineageInput(input, false);
    const specJson = this.validateRegistration(principal, input, now);
    const bounded = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 256;
    if (!input.source || !["review", "github_actions", "local_failure", "verification", "patrol"].includes(input.source.kind)
      || !bounded(input.source.id) || !bounded(input.idempotency_key)) throw Error("invalid_lineage_input");
    return this.write(() => {
      const parent = this.get(input.parent_mission_id);
      if (parent.scope_id !== input.scope_id) throw Error("permission_denied");
      const prior = this.db.prepare("SELECT * FROM engineering_mission_lineage WHERE idempotency_key=?").get(input.idempotency_key) as MissionLineage | undefined;
      if (prior) {
        const mission = this.get(prior.mission_id);
        if (prior.parent_mission_id !== parent.mission_id || prior.source_kind !== input.source.kind || prior.source_id !== input.source.id
          || mission.spec_digest !== attentionDigest(input.spec)) throw Error("lineage_idempotency_conflict");
        return { status: "duplicate", mission, lineage: prior };
      }
      const resolved = this.resolveLineage(parent.mission_id);
      if (resolved.status === "unknown") {
        const recorded = this.db.prepare("SELECT 1 FROM engineering_contained_events WHERE mission_id=? AND kind='mission_lineage_unknown' AND json_extract(payload_json,'$.idempotency_key')=?")
          .get(parent.mission_id, input.idempotency_key);
        if (!recorded) this.event(parent.mission_id, "mission_lineage_unknown", null,
          { reason: resolved.reason, detail: resolved.detail, source: input.source, idempotency_key: input.idempotency_key }, now);
        return { status: "waiting", reason: LINEAGE_UNKNOWN_REASON, parent_mission_id: parent.mission_id };
      }
      const mission = this.insertMission(principal, { scope_id: input.scope_id, spec: input.spec, claim: input.claim }, specJson, now);
      const lineage: MissionLineage = { mission_id: mission.mission_id, origin_mission_id: resolved.lineage.origin_mission_id,
        parent_mission_id: parent.mission_id, chain_depth: resolved.lineage.chain_depth + 1, source_kind: input.source.kind,
        source_id: input.source.id, idempotency_key: input.idempotency_key, created_at: now };
      this.insertLineage(lineage);
      return { status: "registered", mission, lineage };
    });
  }

  private rejectLineageInput(input: ContainedAuthorizeInput | ContainedDeriveInput, root: boolean): void {
    for (const key of ["origin_mission_id", "chain_depth", "depth", "root", "origin", ...(root ? ["parent_mission_id"] : [])])
      if (Object.prototype.hasOwnProperty.call(input, key)) throw Error("invalid_lineage_input");
  }
  private validateRegistration(principal: EngineeringPrincipal, input: ContainedAuthorizeInput, now: number): string {
    this.clock(now);
    if (!principal.principal_id || !principal.client_session_id || !principal.write_scopes.includes(input.scope_id)) throw Error("permission_denied");
    if (input.spec === null || typeof input.spec !== "object" || Array.isArray(input.spec)) throw Error("invalid_spec");
    const { repo_identity, branch, worktree_identity } = input.claim ?? {};
    if (![repo_identity, branch, worktree_identity].every(v => typeof v === "string" && v.length > 0 && v.length <= 1024)) throw Error("invalid_claim");
    const spec_json = JSON.stringify(input.spec);
    if (spec_json.length > 32768) throw Error("invalid_spec");
    return spec_json;
  }
  private insertMission(principal: EngineeringPrincipal, input: ContainedAuthorizeInput, spec_json: string, now: number, repairCycles = 0, repairPending = 0): ContainedMission {
    const { repo_identity, branch, worktree_identity } = input.claim;
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
  }
  private insertLineage(row: MissionLineage): void {
    const { mission_id, origin_mission_id, parent_mission_id, chain_depth, source_kind, source_id, idempotency_key, created_at } = row;
    this.db.prepare(`INSERT INTO engineering_mission_lineage(mission_id,origin_mission_id,parent_mission_id,chain_depth,source_kind,source_id,idempotency_key,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(mission_id, origin_mission_id, parent_mission_id, chain_depth, source_kind, source_id, idempotency_key, created_at);
    this.event(mission_id, "mission_lineage_registered", null, { origin_mission_id, parent_mission_id, chain_depth, source_kind, source_id, idempotency_key }, created_at);
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
      // A halted Mission may re-enter candidate_ready only with the very candidate it halted on; it can never swap in another.
      if (from === "awaiting_decision" && to === "candidate_ready" && (mission.candidate_head === null || step.candidate?.head !== mission.candidate_head
        || step.candidate.tree !== mission.candidate_tree || step.candidate.diff_digest !== mission.candidate_diff_digest)) throw Error("candidate_unexpected");
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
      // stop_unknown always means some effect may still be running, whatever state it came from.
      const obligation = to === "executing" || to === "verifying" || to === "stop_unknown" ? 1 : mission.stop_obligation;
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
  const missions = (db.prepare(`SELECT COUNT(*) n FROM engineering_contained_missions m
    LEFT JOIN engineering_workspace_claims c ON c.mission_id=m.mission_id
    WHERE m.state NOT IN ('pr_opened','cancelled','abandoned','failed') OR m.stop_obligation=1 OR c.state='active'`).get() as { n: number }).n;
  // W13-A: a host child process (git push, gh pr create, ...) not proven stopped is an unsettled side effect. The claim and
  // Mission triggers already keep such a Mission counted above; this direct count is the explicit second guard.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='engineering_host_processes'").get()) return missions;
  return missions + (db.prepare("SELECT COUNT(*) n FROM engineering_host_processes WHERE state<>'stopped'").get() as { n: number }).n;
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

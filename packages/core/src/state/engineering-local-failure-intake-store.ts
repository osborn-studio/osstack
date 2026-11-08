import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { AttentionOwner, AttentionStore } from "./attention-store.js";

export interface NewLocalFailureIntake {
  intake_id: string; chain_id: string; chain_revision: number; root_mission_id: string;
  repository: string; pr_number: number; branch: string; head_sha: string; tree_sha: string; base_ref: string; base_sha: string;
  profile_id: string; profile_digest: string; trusted_source_digest: string; grant_id: string; grant_digest: string;
  ci_hint_json: string; invocation_id: string; journal_ref: string; container_cap_seconds: number;
}
/** Timeout is a terminal observation only after proven stop. It is ineligible for repair. */
export type DiagnosticOutcome = "passed" | "reproducible_failure" | "infrastructure_error" | "cancelled" | "timeout";
/** Host-only opaque diagnostic observation, not a typed LocalVerificationReceipt.
 * Receipt bytes do not establish repair eligibility, host provenance, binding or process stop. */
export interface StoppedDiagnostic {
  outcome: DiagnosticOutcome; container_used_seconds: number; receipt_json: string; evidence_digest: string;
  proof_ref: string; proof_digest: string;
}
export interface LocalFailureIntake extends NewLocalFailureIntake {
  grant_json: string; owner_home: string; owner_instance: string; owner_generation: number;
  writer_instance: string; writer_generation: number; revision: number;
  state: "reserved" | "running" | "stop_unknown" | "stopped"; reason: string | null;
  stop_obligation: 0 | 1; started_at: number | null; container_used_seconds: number | null;
  outcome: DiagnosticOutcome | "not_started" | null; receipt_json: string | null;
  /** SHA256 of the exact receipt_json UTF-8 bytes. Raw byte integrity only.
   * Never use this as canonical receipt_digest or expose an authority alias. */
  receipt_bytes_sha256: string | null;
  evidence_digest: string | null; proof_ref: string | null; proof_digest: string | null; created_at: number; updated_at: number;
}
const digest = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Unregistered host journal. No launch, grant verification, child dispatch, receipt consumption or
 * global budget integration. Typed canonical host receipt persistence/consumption requires a separate
 * explicit bound field/table/adapter; this journal must never supply canonical receipt_digest.
 * All mutations use the real daemon owner and an immediate transaction.
 *
 * Later admission MUST verify signed v2 authority/profile/lineage and subtract containerDebit from
 * RevisionChainStore.remainingBudget in the SAME immediate transaction as reserve. Both review and
 * local child reservation/allocation must consume activeExclusions and this debit atomically.
 * Chain close, claim cleanup and upgrade recovery must retain all active exclusions until proven stop.
 * Existing V1 writers do not consult this journal. Do not attach a runner before that integration.
 */
export class LocalFailureIntakeStore {
  constructor(readonly attention: AttentionStore, readonly owner: AttentionOwner, private readonly clock: () => number = Date.now) {}
  get db(): Database.Database { return this.attention.db; }
  get(intakeId: string): LocalFailureIntake {
    const row = this.db.prepare("SELECT * FROM engineering_local_failure_intakes WHERE intake_id=?").get(intakeId) as LocalFailureIntake | undefined;
    if (!row) throw Error("not_found");
    return row;
  }
  /** Includes reserved, running and unknown-stop rows; deterministic order for recovery/exclusion. */
  activeExclusions(chainId: string): LocalFailureIntake[] {
    return this.db.prepare("SELECT * FROM engineering_local_failure_intakes WHERE chain_id=? AND state<>'stopped' ORDER BY created_at,intake_id")
      .all(chainId) as LocalFailureIntake[];
  }
  /** Across ALL grants/heads/profiles of this chain. Unknown stop retains its whole cap. */
  containerDebit(chainId: string): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN state='stopped' THEN container_used_seconds ELSE container_cap_seconds END),0) debit
      FROM engineering_local_failure_intakes WHERE chain_id=?`).get(chainId) as { debit: number };
    if (!Number.isSafeInteger(row.debit) || row.debit < 0) throw Error("intake_debit_overflow");
    return row.debit;
  }
  /** Reserves journal capacity only. This method is not launch authority. Nested use is permitted
   * for future shared-budget admission; the caller must hold BEGIN IMMEDIATE and commit before launch. */
  reserve(input: NewLocalFailureIntake): LocalFailureIntake {
    const now = this.now();
    return this.write(() => {
      // Keep identity parsing aligned with frozen efbea370 and the independent SQL checks.
      if (typeof input.intake_id !== "string" || input.intake_id.length !== 40 || !/^lfi_[0-9a-f-]{36}$/.test(input.intake_id)
        || ![input.head_sha, input.tree_sha, input.base_sha].every(value => typeof value === "string"
          && (value.length === 40 || value.length === 64) && /^[0-9a-f]+$/.test(value))) throw Error("intake_identity_invalid");
      const chain = this.db.prepare("SELECT grant_json FROM engineering_revision_chains WHERE chain_id=?").get(input.chain_id) as { grant_json: string } | undefined;
      if (!chain || digest(chain.grant_json) !== input.grant_digest) throw Error("intake_grant_mismatch");
      // Copy only declared input fields: JS callers cannot inject lifecycle or owner columns.
      this.db.prepare(`INSERT INTO engineering_local_failure_intakes (
        intake_id,chain_id,chain_revision,root_mission_id,repository,pr_number,branch,head_sha,tree_sha,base_ref,base_sha,
        profile_id,profile_digest,trusted_source_digest,grant_id,grant_digest,ci_hint_json,invocation_id,journal_ref,container_cap_seconds,
        grant_json,owner_home,owner_instance,owner_generation,writer_instance,writer_generation,state,revision,stop_obligation,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',1,1,?,?)`).run(
        input.intake_id,input.chain_id,input.chain_revision,input.root_mission_id,input.repository,input.pr_number,input.branch,
        input.head_sha,input.tree_sha,input.base_ref,input.base_sha,input.profile_id,input.profile_digest,input.trusted_source_digest,
        input.grant_id,input.grant_digest,input.ci_hint_json,input.invocation_id,input.journal_ref,input.container_cap_seconds,
        chain.grant_json,this.owner.home_id,this.owner.instance_id,this.owner.generation,this.owner.instance_id,this.owner.generation,now,now);
      // Reject precision loss rather than silently increasing capacity.
      this.containerDebit(input.chain_id);
      return this.get(input.intake_id);
    });
  }
  /** Persist the launch fence before any external launch. A restart may reconcile, never re-start. */
  start(intakeId: string, ifRevision: number): LocalFailureIntake {
    if (this.db.inTransaction) throw Error("intake_nested_launch");
    return this.change(intakeId, ifRevision, row => {
      if (row.state !== "reserved") throw Error("intake_state_denied");
      if (row.owner_home !== this.owner.home_id || row.owner_instance !== this.owner.instance_id || row.owner_generation !== this.owner.generation)
        throw Error("intake_owner_changed");
      const now = this.now();
      this.db.prepare(`UPDATE engineering_local_failure_intakes SET state='running',started_at=?,revision=revision+1,
        writer_instance=?,writer_generation=?,updated_at=? WHERE intake_id=?`).run(now,this.owner.instance_id,this.owner.generation,now,intakeId);
    });
  }
  markStopUnknown(intakeId: string, ifRevision: number, reason: string): LocalFailureIntake {
    return this.change(intakeId, ifRevision, () => {
      this.db.prepare(`UPDATE engineering_local_failure_intakes SET state='stop_unknown',reason=?,revision=revision+1,
        writer_instance=?,writer_generation=?,updated_at=? WHERE intake_id=?`).run(reason,this.owner.instance_id,this.owner.generation,this.now(),intakeId);
    });
  }
  /** Only the trusted host stop reconciler may call this. It must verify proof/evidence existence
   * and actual process stop first, including for timeout. A timeout event alone cannot settle a run.
   * receipt_json remains opaque; its hash preserves exact bytes without parsing or canonicalization.
   * Evidence digests here are references, never client repair authority. */
  settleStopped(intakeId: string, ifRevision: number, stopped: StoppedDiagnostic): LocalFailureIntake {
    return this.change(intakeId, ifRevision, () => {
      this.db.prepare(`UPDATE engineering_local_failure_intakes SET state='stopped',stop_obligation=0,outcome=?,
        container_used_seconds=?,receipt_json=?,receipt_bytes_sha256=?,evidence_digest=?,proof_ref=?,proof_digest=?,revision=revision+1,
        writer_instance=?,writer_generation=?,updated_at=? WHERE intake_id=?`).run(stopped.outcome,stopped.container_used_seconds,
        stopped.receipt_json,digest(stopped.receipt_json),stopped.evidence_digest,stopped.proof_ref,stopped.proof_digest,
        this.owner.instance_id,this.owner.generation,this.now(),intakeId);
    });
  }
  /** Safe only while the durable launch fence was never crossed; cannot settle a launched run. */
  settleNotStarted(intakeId: string, ifRevision: number): LocalFailureIntake {
    return this.change(intakeId, ifRevision, row => {
      const proof = `journal:not_started:${row.invocation_id}`;
      this.db.prepare(`UPDATE engineering_local_failure_intakes SET state='stopped',stop_obligation=0,outcome='not_started',
        container_used_seconds=0,proof_ref=?,proof_digest=?,revision=revision+1,writer_instance=?,writer_generation=?,updated_at=? WHERE intake_id=?`)
        .run(proof,digest(proof),this.owner.instance_id,this.owner.generation,this.now(),intakeId);
    });
  }
  private change(intakeId: string, ifRevision: number, fn: (row: LocalFailureIntake) => void): LocalFailureIntake {
    return this.write(() => {
      const row = this.get(intakeId);
      if (!Number.isSafeInteger(ifRevision) || row.revision !== ifRevision) throw Error("version_conflict");
      fn(row);
      return this.get(intakeId);
    });
  }
  private write<T>(fn: () => T): T {
    if (this.db.pragma("synchronous", { simple: true }) !== 2) throw Error("durability_required");
    return this.db.transaction(() => {
      this.attention.assertOwner(this.owner);
      const result = fn();
      this.attention.assertOwner(this.owner);
      return result;
    }).immediate();
  }
  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) throw Error("invalid_clock");
    return now;
  }
}

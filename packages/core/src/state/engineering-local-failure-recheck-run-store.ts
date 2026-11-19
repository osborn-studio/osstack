import { createHash, randomUUID } from "node:crypto";
import {
  localFailureBindingFromLedger,
  localVerificationReceiptDigest,
  parseLocalVerificationReceipt,
  type LocalVerificationReceipt
} from "../bridge/local-failure.js";
import { issueHostRecheckProof, type HostRecheckProof } from "../bridge/recheck-host-proof.js";
import { canonicalJson } from "../bridge/revision-grant.js";
import type { DiagnosisStore } from "./engineering-diagnosis-store.js";
import type { LocalFailureIntake } from "./engineering-local-failure-intake-store.js";
import type { LocalFailureRecheck } from "./engineering-local-failure-recheck-store.js";
import { checkRootAdmission } from "./engineering-root-admission.js";
import { VerificationSourceStore } from "./engineering-verification-source-store.js";

export interface ReserveRecheckRun {
  recheck_id: string;
  tree_sha: string;
  grant_id: string;
  grant_digest: string;
  invocation_id: string;
  journal_ref: string;
  container_cap_seconds: number;
  now: number;
}
export interface SettleRecheckRun {
  receipt: LocalVerificationReceipt;
  run_identity_digest: string;
  container_used_seconds: number;
}
type LedgerFields = Pick<
  LocalFailureRecheck,
  | "recheck_id"
  | "dispatch_id"
  | "child_mission_id"
  | "repository_id"
  | "skill_id"
  | "skill_version"
  | "skill_blob"
  | "skill_manifest_digest"
  | "original_result_id"
  | "original_source_seq"
  | "failed_check_id"
  | "original_checks_json"
>;
export interface LocalFailureRecheckRun
  extends LedgerFields,
    Omit<LocalFailureIntake, "grant_json" | "ci_hint_json" | "receipt_bytes_sha256"> {
  run_id: string;
  attempt: number;
  receipt_id: string | null;
  receipt_digest: string | null;
  run_identity_digest: string | null;
  conclusion_state: "host_passed" | "awaiting_decision" | "closed" | null;
  conclusion_reason: string | null;
}
const table = "engineering_local_failure_recheck_runs";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

function boundReceipt(row: LocalFailureRecheckRun, value: unknown): LocalVerificationReceipt | null {
  try {
    const receipt = parseLocalVerificationReceipt(value);
    const binding = localFailureBindingFromLedger(row);
    const fields = Object.keys(binding) as (keyof typeof binding)[];
    return receipt.started_at === row.started_at && fields.every((key) => receipt[key] === binding[key])
      ? receipt
      : null;
  } catch {
    return null;
  }
}

export class LocalFailureRecheckRunStore {
  private readonly sources: VerificationSourceStore;
  constructor(
    readonly diagnosis: DiagnosisStore,
    private readonly clock: () => number = Date.now
  ) {
    this.sources = new VerificationSourceStore(diagnosis.attention, diagnosis.owner);
  }
  private get db() {
    return this.diagnosis.db;
  }
  get(runId: string) {
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE run_id=?`).get(runId) as
      | LocalFailureRecheckRun
      | undefined;
    if (!row) throw Error("not_found");
    return row;
  }
  forRecheck(id: string) {
    return this.db
      .prepare(`SELECT * FROM ${table} WHERE recheck_id=? ORDER BY attempt`)
      .all(id) as LocalFailureRecheckRun[];
  }
  active(id: string) {
    return this.db
      .prepare(`SELECT * FROM ${table} WHERE recheck_id=? AND NOT (state='stopped' AND outcome IS 'not_started')`)
      .get(id) as LocalFailureRecheckRun | undefined;
  }
  private ledger(id: string) {
    return this.db.prepare("SELECT * FROM engineering_local_failure_rechecks WHERE recheck_id=?").get(id) as
      | LocalFailureRecheck
      | undefined;
  }
  private chain(id: string) {
    return this.db
      .prepare(
        "SELECT revision,branch,base_ref,published_head,published_base,grant_json FROM engineering_revision_chains WHERE chain_id=?"
      )
      .get(id) as
      | {
          revision: number;
          branch: string;
          base_ref: string;
          published_head: string;
          published_base: string;
          grant_json: string;
        }
      | undefined;
  }
  private registered(row: LedgerFields) {
    const reg = this.sources.registration(row.original_result_id);
    return reg && !reg.withdrawn_by && reg.registered.seq === row.original_source_seq;
  }
  /** Reserve journal capacity only. The caller verifies the signature and recheck opt-in in the
   * same immediate transaction. A reservation provides no launch authority. */
  reserve(input: ReserveRecheckRun) {
    return this.diagnosis.transaction(() => {
      const { recheck_id, tree_sha, grant_id, grant_digest, invocation_id, journal_ref, container_cap_seconds, now } = input;
      const prior = this.active(recheck_id);
      if (prior) return { run: prior, created: false };
      const row = this.ledger(recheck_id);
      if (row?.state !== "reverify_pending") throw Error("recheck_run_state_denied");
      if (!this.registered(row)) throw Error("verify_withdrawn");
      const chain = this.chain(row.chain_id);
      if (!chain || chain.published_head !== row.new_head_sha) throw Error("verify_stale_head");
      if (chain.published_base !== row.base_sha) throw Error("verify_base_changed");
      if (digest(chain.grant_json) !== grant_digest || JSON.parse(chain.grant_json).grant_id !== grant_id)
        throw Error("recheck_run_grant_mismatch");
      const attempt = this.forRecheck(row.recheck_id).length + 1;
      if (attempt > 3) throw Error("recheck_run_attempts_exhausted");
      const admission = checkRootAdmission(this.db, row.root_mission_id, "recheck", {
        chain_id: row.chain_id,
        container_seconds: container_cap_seconds
      });
      if (!admission.ok) throw Error(admission.code);
      const run_id = `vrn_${randomUUID()}`;
      const { home_id, instance_id, generation } = this.diagnosis.owner;
      // Copy the binding from the pending ledger inside this transaction.
      const ledgerColumns = `recheck_id,dispatch_id,root_mission_id,child_mission_id,chain_id,intake_id,repository_id,
        repository,pr_number,base_sha,profile_id,profile_digest,trusted_source_digest,skill_id,skill_version,skill_blob,
        skill_manifest_digest,original_result_id,original_source_seq,failed_check_id,original_checks_json`;
      this.db.prepare(`INSERT INTO ${table} (${ledgerColumns},head_sha,run_id,attempt,chain_revision,branch,base_ref,
        tree_sha,grant_id,grant_digest,invocation_id,journal_ref,container_cap_seconds,created_at,updated_at,
        owner_home,owner_instance,owner_generation,writer_instance,writer_generation,state,revision,stop_obligation)
        SELECT ${ledgerColumns},new_head_sha,@run_id,@attempt,@chain_revision,@branch,@base_ref,@tree_sha,@grant_id,
        @grant_digest,@invocation_id,@journal_ref,@container_cap_seconds,@now,@now,@home_id,@instance_id,@generation,
        @instance_id,@generation,'reserved',1,1 FROM engineering_local_failure_rechecks WHERE recheck_id=@recheck_id`)
        .run({ recheck_id, run_id, attempt, chain_revision: chain.revision, branch: chain.branch, base_ref: chain.base_ref,
          tree_sha, grant_id, grant_digest, invocation_id, journal_ref, container_cap_seconds, now, home_id, instance_id, generation });
      return { run: this.get(run_id), created: true };
    });
  }
  private change(
    id: string,
    ifRevision: number,
    patch: (row: LocalFailureRecheckRun, now: number) => Partial<LocalFailureRecheckRun>
  ) {
    return this.diagnosis.transaction(() => {
      const row = this.get(id);
      if (row.revision !== ifRevision) throw Error("version_conflict");
      const now = this.clock();
      const update = {
        ...patch(row, now),
        writer_instance: this.diagnosis.owner.instance_id,
        writer_generation: this.diagnosis.owner.generation,
        updated_at: now,
        revision: row.revision + 1
      };
      this.db
        .prepare(
          `UPDATE ${table} SET ${Object.keys(update)
            .map((c) => c + "=@" + c)
            .join(",")} WHERE run_id=@id`
        )
        .run({ ...update, id });
      return this.get(id);
    });
  }
  start(id: string, ifRevision: number) {
    if (this.db.inTransaction) throw Error("recheck_run_nested_launch");
    return this.change(id, ifRevision, (row, now) => {
      if (row.state !== "reserved") throw Error("recheck_run_state_denied");
      if (!this.registered(row)) throw Error("verify_withdrawn");
      return { state: "running", started_at: now };
    });
  }
  markStopUnknown(id: string, ifRevision: number) {
    return this.change(id, ifRevision, () => ({
      state: "stop_unknown",
      reason: "verify_stop_unproven",
      conclusion_state: "awaiting_decision",
      conclusion_reason: "verify_stop_unproven"
    }));
  }
  settleNotStarted(
    id: string,
    ifRevision: number,
    reason: "verify_recheck_not_started" | "verify_profile_unavailable"
  ) {
    return this.change(id, ifRevision, (row) => {
      if (row.state !== "reserved") throw Error("recheck_run_state_denied");
      if (reason !== "verify_recheck_not_started" && reason !== "verify_profile_unavailable")
        throw Error("recheck_run_state_denied");
      const proof = `journal:not_started:${row.invocation_id}`;
      return {
        state: "stopped",
        outcome: "not_started",
        stop_obligation: 0,
        container_used_seconds: 0,
        proof_ref: proof,
        proof_digest: digest(proof),
        conclusion_state: "awaiting_decision",
        conclusion_reason: reason
      };
    });
  }
  private conclusion(
    row: LocalFailureRecheckRun,
    outcome: LocalVerificationReceipt["outcome"]
  ): Pick<LocalFailureRecheckRun, "conclusion_state" | "conclusion_reason"> {
    if (row.state === "stop_unknown")
      return { conclusion_state: "awaiting_decision", conclusion_reason: "verify_stop_unproven" };
    if (!this.registered(row)) return { conclusion_state: "closed", conclusion_reason: "verify_withdrawn" };
    const chain = this.chain(row.chain_id);
    if (chain?.published_head !== row.head_sha)
      return { conclusion_state: "awaiting_decision", conclusion_reason: "verify_stale_head" };
    if (chain.published_base !== row.base_sha)
      return { conclusion_state: "awaiting_decision", conclusion_reason: "verify_base_changed" };
    if (outcome === "passed") return { conclusion_state: "host_passed", conclusion_reason: null };
    return {
      conclusion_state: "awaiting_decision",
      conclusion_reason:
        outcome === "reproducible_failure" ? "verify_recheck_host_failed" : "verify_infrastructure_error"
    };
  }
  settleStopped(id: string, ifRevision: number, input: SettleRecheckRun) {
    return this.change(id, ifRevision, (row) => {
      if (row.state !== "running" && row.state !== "stop_unknown") throw Error("recheck_run_state_denied");
      const receipt = boundReceipt(row, input.receipt);
      if (
        !receipt ||
        !Number.isSafeInteger(input.container_used_seconds) ||
        input.container_used_seconds < 0 ||
        input.container_used_seconds > row.container_cap_seconds
      )
        throw Error("recheck_run_receipt_binding_invalid");
      return {
        state: "stopped",
        outcome: receipt.outcome,
        stop_obligation: 0,
        container_used_seconds: input.container_used_seconds,
        evidence_digest: receipt.evidence_digest,
        proof_ref: receipt.stop.proof_ref,
        proof_digest: receipt.stop.proof_digest,
        receipt_json: canonicalJson(receipt),
        receipt_digest: localVerificationReceiptDigest(receipt),
        receipt_id: `vrr_${randomUUID()}`,
        run_identity_digest: input.run_identity_digest,
        ...this.conclusion(row, receipt.outcome)
      };
    });
  }
  hostProof(id: string): HostRecheckProof | null {
    return this.diagnosis.transaction(() => {
      const run = this.active(id),
        row = this.ledger(id);
      if (
        run?.state !== "stopped" ||
        run.outcome !== "passed" ||
        run.conclusion_state !== "host_passed" ||
        !run.receipt_id ||
        !run.receipt_json ||
        !run.receipt_digest ||
        !row ||
        run.head_sha !== row.new_head_sha ||
        run.base_sha !== row.base_sha ||
        run.profile_digest !== row.profile_digest ||
        run.trusted_source_digest !== row.trusted_source_digest ||
        this.chain(run.chain_id)?.published_head !== run.head_sha
      )
        return null;
      try {
        const receipt = boundReceipt(run, JSON.parse(run.receipt_json));
        if (
          receipt?.outcome !== "passed" ||
          localVerificationReceiptDigest(receipt) !== run.receipt_digest ||
          !this.registered(row)
        )
          return null;
        const { receipt_id, receipt_digest, head_sha, base_sha, profile_digest, trusted_source_digest } = run;
        return issueHostRecheckProof({
          receipt_id,
          receipt_digest,
          head_sha,
          base_sha,
          profile_digest,
          trusted_source_digest,
          outcome: "passed"
        });
      } catch {
        return null;
      }
    });
  }
}

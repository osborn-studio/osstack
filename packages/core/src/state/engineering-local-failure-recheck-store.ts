import { createHash, randomUUID } from "node:crypto";
import {
  classifyRecheck,
  parseRecheckResult,
  type ActionsAttemptFact,
  type HostRecheckProof,
  type RecheckBinding,
  type RecheckVerdict,
} from "../bridge/recheck.js";
import type { DiagnosisStore } from "./engineering-diagnosis-store.js";
import { VerificationSourceStore } from "./engineering-verification-source-store.js";

type Outcome = {
  state: RecheckVerdict["state"];
  reason: RecheckVerdict["reason"];
  missing_json: string;
  recheck_result_id: string | null;
  recheck_source_seq: number | null;
  actions_attempt: number | null;
  actions_digest: string | null;
  host_receipt_id: string | null;
  host_receipt_digest: string | null;
};
export interface LocalFailureRecheck extends Omit<RecheckBinding, "original_checks">, Outcome {
  recheck_id: string;
  dispatch_id: string;
  root_mission_id: string;
  child_mission_id: string;
  chain_id: string;
  intake_id: string;
  original_source_seq: number;
  original_checks_json: string;
  failed_failure_code: string;
  repository: string;
  revision: number;
  owner_home: string;
  owner_instance: string;
  owner_generation: number;
  created_at: number;
  updated_at: number;
}
export interface RecheckEvaluation {
  recheck_id: string;
  result?: { source_seq: number; contract_text: string };
  actions?: ActionsAttemptFact;
  host?: HostRecheckProof;
  now: number;
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const table = "engineering_local_failure_rechecks";

export class LocalFailureRecheckStore {
  private readonly sources: VerificationSourceStore;
  constructor(readonly diagnosis: DiagnosisStore) {
    this.sources = new VerificationSourceStore(diagnosis.attention, diagnosis.owner);
  }
  private get db() {
    return this.diagnosis.db;
  }

  get(id: string): LocalFailureRecheck {
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE recheck_id=?`).get(id) as LocalFailureRecheck | undefined;
    if (!row) throw Error("not_found");
    return row;
  }
  forDispatch(id: string) {
    return this.db.prepare(`SELECT * FROM ${table} WHERE dispatch_id=?`).get(id) as LocalFailureRecheck | undefined;
  }
  forChain(id: string) {
    return this.db
      .prepare(`SELECT * FROM ${table} WHERE chain_id=? ORDER BY recheck_id`)
      .all(id) as LocalFailureRecheck[];
  }
  open(input: { child_mission_id: string; original_contract_text: string; now: number }): LocalFailureRecheck {
    return this.diagnosis.transaction(() => {
      const binding = this.db
        .prepare(
          `SELECT d.dispatch_id,d.child_mission_id,d.root_mission_id,d.chain_id,
        d.check_id AS failed_check_id,d.failure_code AS failed_failure_code,r.intake_id,r.result_id AS original_result_id,
        r.source_seq AS original_source_seq,c.published_head AS new_head_sha
        FROM engineering_local_failure_dispatches d JOIN engineering_revision_chains c ON c.chain_id=d.chain_id
        JOIN engineering_revision_chain_events e ON e.chain_id=c.chain_id AND e.kind='local_repair_push_confirmed'
          AND json_extract(e.payload_json,'$.dispatch_id')=d.dispatch_id AND json_extract(e.payload_json,'$.child_mission_id')=d.child_mission_id
          AND json_extract(e.payload_json,'$.new_head')=c.published_head
        JOIN engineering_diagnosis_requests r ON r.request_id=d.request_id
        JOIN engineering_verification_sources s ON s.seq=r.source_seq AND s.result_id=r.result_id AND s.intake_id=r.intake_id
        WHERE d.child_mission_id=? AND s.decision='accepted' AND s.contract_digest=?`
        )
        .get(input.child_mission_id, digest(input.original_contract_text)) as
        | Pick<
            LocalFailureRecheck,
            | "dispatch_id"
            | "child_mission_id"
            | "root_mission_id"
            | "chain_id"
            | "failed_check_id"
            | "failed_failure_code"
            | "intake_id"
            | "original_result_id"
            | "original_source_seq"
            | "new_head_sha"
          >
        | undefined;
      const result = parseRecheckResult(input.original_contract_text);
      if (
        !binding ||
        !/^[a-f0-9]{40}$/.test(binding.new_head_sha) ||
        !Number.isSafeInteger(input.now) ||
        input.now < 0 ||
        !result ||
        result.result_id !== binding.original_result_id ||
        result.outcome !== "failed" ||
        !result.checks.some(
          (c) => c.check_id === binding.failed_check_id && c.failure_code === binding.failed_failure_code
        )
      )
        throw Error("verify_recheck_binding_invalid");
      const prior = this.forDispatch(binding.dispatch_id);
      if (prior) return prior;
      const {
        repository_id,
        repository,
        pr,
        base_sha,
        skill_id,
        skill_version,
        skill_blob,
        skill_manifest_digest,
        profile_id,
        profile_digest,
        trusted_source_digest,
      } = result;
      const owner = this.diagnosis.owner;
      const row: LocalFailureRecheck = {
        ...binding,
        recheck_id: `vrc_${randomUUID()}`,
        repository_id,
        repository,
        pr_number: pr,
        base_sha,
        skill_id,
        skill_version,
        skill_blob,
        skill_manifest_digest,
        profile_id,
        profile_digest,
        trusted_source_digest,
        original_checks_json: JSON.stringify(result.checks.map((c) => c.check_id).sort()),
        state: "reverify_pending",
        reason: "verify_recheck_missing",
        missing_json: '["result","actions","host"]',
        recheck_result_id: null,
        recheck_source_seq: null,
        actions_attempt: null,
        actions_digest: null,
        host_receipt_id: null,
        host_receipt_digest: null,
        revision: 1,
        owner_home: owner.home_id,
        owner_instance: owner.instance_id,
        owner_generation: owner.generation,
        created_at: input.now,
        updated_at: input.now,
      };
      const columns = Object.keys(row);
      this.db
        .prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map((k) => "@" + k).join(",")})`)
        .run(row);
      return row;
    });
  }
  private currentResult(input: NonNullable<RecheckEvaluation["result"]>) {
    const result = parseRecheckResult(input.contract_text);
    if (!result) return null;
    const registration = this.sources.registration(result.result_id);
    const source = registration?.registered;
    if (
      !source ||
      registration?.withdrawn_by ||
      source.seq !== input.source_seq ||
      source.contract_digest !== digest(input.contract_text) ||
      source.repository_id !== result.repository_id ||
      source.pr_number !== result.pr ||
      source.head_sha !== result.head_sha ||
      source.base_sha !== result.base_sha ||
      source.outcome !== result.outcome ||
      source.skill_id !== result.skill_id ||
      this.db
        .prepare("SELECT 1 FROM engineering_verification_sources WHERE supersedes_result_id=? AND decision='accepted'")
        .get(result.result_id)
    )
      return null;
    return { result, source };
  }
  evaluate(input: RecheckEvaluation) {
    return this.diagnosis.transaction(() => {
      const row = this.get(input.recheck_id);
      if (
        row.state !== "reverify_pending" ||
        !this.db
          .prepare("SELECT 1 FROM engineering_revision_chains WHERE chain_id=? AND published_head=?")
          .get(row.chain_id, row.new_head_sha)
      )
        return row;
      const current = input.result && this.currentResult(input.result);
      // Snapshot the read once. The stored attempt and digest must be the facts that passed classification.
      const actionsRead = input.actions ? { ...input.actions } : null;
      const hostProof = input.host ?? null;
      const verdict = classifyRecheck(
        { ...row, original_checks: JSON.parse(row.original_checks_json) },
        { result: current?.result ?? null, actions: actionsRead, host: hostProof }
      );
      const missing = new Set<string>(verdict.missing);
      const recorded = !missing.has("result") && current;
      const actions = verdict.state !== "awaiting_decision" && !missing.has("actions") && actionsRead;
      const host = verdict.state !== "awaiting_decision" && !missing.has("host") && hostProof;
      const outcome: Outcome = {
        state: verdict.state,
        reason: verdict.reason,
        missing_json: JSON.stringify(verdict.missing),
        recheck_result_id: recorded ? recorded.result.result_id : null,
        recheck_source_seq: recorded ? recorded.source.seq : null,
        actions_attempt: actions ? actions.attempt : null,
        actions_digest: actions ? actions.digest : null,
        host_receipt_id: host ? host.receipt_id : null,
        host_receipt_digest: host ? host.receipt_digest : null,
      };
      const columns = Object.keys(outcome) as (keyof Outcome)[];
      if (columns.every((k) => outcome[k] === row[k])) return row;
      if (recorded && recorded.source.intake_id === null)
        this.sources.linkIntake(recorded.source.seq, row.intake_id, "admission");
      this.db
        .prepare(
          `UPDATE ${table} SET ${columns.map((k) => k + "=@" + k).join(",")},revision=revision+1,updated_at=@now
        WHERE recheck_id=@id`
        )
        .run({ ...outcome, now: input.now, id: row.recheck_id });
      return this.get(row.recheck_id);
    });
  }
}

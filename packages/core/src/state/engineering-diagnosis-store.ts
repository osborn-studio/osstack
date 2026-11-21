import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../bridge/revision-grant.js";
import { parseLocalFailureRevisionGrant, type LocalFailureRevisionGrant } from "../bridge/revision-local-failure-grant.js";
import {
  localFailureBindingFromLedger,
  localVerificationReceiptDigest,
  parseLocalVerificationReceipt,
  type LocalVerificationReceipt,
} from "../bridge/local-failure.js";
import {
  checkGrantWindow,
  type DiagnosisProfile,
  type DiagnosisBinding,
  type DiagnosisReason,
  type DiagnosisVerdict,
} from "../bridge/diagnosis-admission.js";
import { matchVerificationProducer, type VerificationProducerPolicyV1 } from "../bridge/verification-producer-policy.js";
import { parseVerificationResultV1 } from "../bridge/verification-result.js";
import type { AttentionOwner, AttentionStore } from "./attention-store.js";
import { ContainedMissionStore } from "./engineering-contained-store.js";
import { LocalFailureIntakeStore, type LocalFailureIntake } from "./engineering-local-failure-intake-store.js";
import type { RevisionChain } from "./engineering-revision-chain-store.js";
import { VerificationSourceStore } from "./engineering-verification-source-store.js";
import { readRootActivity } from "./engineering-root-admission.js";

interface DiagnosisOwnerColumns {
  owner_home: string;
  owner_instance: string;
  owner_generation: number;
  created_at: number;
}
export interface DiagnosisRequest extends DiagnosisBinding, DiagnosisOwnerColumns {
  request_id: string;
  source_seq: number;
  result_id: string;
  repository_id: number;
  skill_id: string;
  profile_id: string;
  profile_digest: string;
  trusted_source_digest: string;
  trusted_repository: string;
  trusted_commit: string;
  expected_failures_json: string;
  allowed_codes_json: string;
  summary_reference_json: string;
  chain_id: string | null;
  state: "registered" | "admitted" | DiagnosisVerdict["state"];
  reason: DiagnosisReason | null;
  intake_id: string | null;
  receipt_id: string | null;
  revision: number;
  writer_instance: string;
  writer_generation: number;
  updated_at: number;
}
export interface HostReceipt extends DiagnosisOwnerColumns {
  receipt_id: string;
  intake_id: string;
  request_id: string;
  invocation_id: string;
  binding_json: string;
  run_identity_digest: string;
  receipt_json: string;
  receipt_digest: string;
  evidence_digest: string;
  stop_proof_ref: string;
  stop_proof_digest: string;
  profile_digest: string;
  trusted_source_digest: string;
  outcome: LocalVerificationReceipt["outcome"];
  consumed_at: number | null;
  consumed_by: string | null;
}
export interface DiagnosisRegistration {
  result_id: string;
  contract_text: string;
  root_mission_id: string;
  chain_id: string | null;
  policy: VerificationProducerPolicyV1;
}
export interface DiagnosisFacts {
  chain_id: string;
  grant: LocalFailureRevisionGrant;
  grant_digest: string;
  now: number;
  binding: Omit<DiagnosisBinding, "root_mission_id"> & { tree_sha: string };
  profile: DiagnosisProfile;
  container_cap_seconds: number;
  invocation_id: string;
  journal_ref: string;
  intake_id: string;
}
export type DiagnosisAdmission =
  | {
      status: "admitted";
      request: DiagnosisRequest;
      intake: LocalFailureIntake;
    }
  | { status: "refused"; reason: DiagnosisReason; request: DiagnosisRequest };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const clearable = new Set<DiagnosisReason>([
  "verify_grant_missing",
  "verify_grant_invalid",
  "verify_chain_busy",
  "verify_budget_exhausted",
]);
export function diagnosisCanAdmit(r: DiagnosisRequest) {
  return (
    r.intake_id === null &&
    (r.state === "registered" || (r.state === "awaiting_decision" && r.reason !== null && clearable.has(r.reason)))
  );
}
export function diagnosisProfile(r: DiagnosisRequest): DiagnosisProfile {
  return {
    profile_id: r.profile_id,
    profile_digest: r.profile_digest,
    trusted_source: {
      repository: r.trusted_repository,
      commit: r.trusted_commit,
      artifact_digest: r.trusted_source_digest,
    },
  };
}
export class DiagnosisStore {
  readonly intakes: LocalFailureIntakeStore;
  private readonly sources: VerificationSourceStore;
  constructor(
    readonly attention: AttentionStore,
    readonly owner: AttentionOwner,
    private readonly clock: () => number = Date.now,
  ) {
    this.sources = new VerificationSourceStore(attention, owner);
    this.intakes = new LocalFailureIntakeStore(attention, owner, clock);
  }
  get db(): Database.Database {
    return this.attention.db;
  }
  transaction<T>(fn: () => T): T {
    if (this.db.pragma("synchronous", { simple: true }) !== 2) throw Error("durability_required");
    return this.db
      .transaction(() => {
        this.attention.assertOwner(this.owner);
        const value = fn();
        this.attention.assertOwner(this.owner);
        return value;
      })
      .immediate();
  }
  get(id: string): DiagnosisRequest {
    const row = this.db.prepare("SELECT * FROM engineering_diagnosis_requests WHERE request_id=?").get(id) as
      | DiagnosisRequest
      | undefined;
    if (!row) throw Error("not_found");
    return row;
  }
  byResult(id: string) {
    return this.db.prepare("SELECT * FROM engineering_diagnosis_requests WHERE result_id=?").get(id) as
      | DiagnosisRequest
      | undefined;
  }
  receipt(id: string): HostReceipt {
    const row = this.db.prepare("SELECT * FROM engineering_host_receipts WHERE receipt_id=?").get(id) as HostReceipt | undefined;
    if (!row) throw Error("not_found");
    return row;
  }
  matchesCandidateTree(r: DiagnosisRequest, chainId: string, tree: string): boolean {
    return !this.db
      .prepare(`SELECT 1 FROM engineering_contained_missions m
        WHERE m.candidate_head=? AND m.candidate_tree IS NOT NULL AND m.candidate_tree<>?
        AND (m.mission_id=? OR EXISTS (SELECT 1 FROM engineering_revision_reservations rr WHERE rr.chain_id=? AND rr.child_mission_id=m.mission_id)) LIMIT 1`)
      .get(r.head_sha, tree, r.root_mission_id, chainId);
  }
  withdrawn(r: DiagnosisRequest) {
    return !!this.db
      .prepare(`SELECT 1 FROM engineering_verification_sources WHERE repository_id=? AND pr_number=?
      AND decision='accepted' AND withdraws_seq=? LIMIT 1`)
      .get(r.repository_id, r.pr_number, r.source_seq);
  }
  /** Requests that were registered and never admitted, oldest first. Read only. */
  registered(limit = 10, after?: { created_at: number; request_id: string }): DiagnosisRequest[] {
    const size = Math.max(1, Math.min(100, Math.trunc(limit) || 1));
    return this.db.prepare(`SELECT * FROM engineering_diagnosis_requests WHERE state='registered' AND intake_id IS NULL
      AND (created_at, request_id) > (?, ?) ORDER BY created_at, request_id LIMIT ?`)
      .all(after?.created_at ?? -1, after?.request_id ?? "", size) as DiagnosisRequest[];
  }
  admitted() {
    return this.db
      .prepare("SELECT * FROM engineering_diagnosis_requests WHERE state='admitted' ORDER BY request_id")
      .all() as DiagnosisRequest[];
  }
  chain(root: string, id: string | null) {
    return this.db
      .prepare(
        "SELECT * FROM engineering_revision_chains WHERE root_mission_id=? AND mode='live' AND state<>'closed' AND (? IS NULL OR chain_id=?)",
      )
      .get(root, id, id) as RevisionChain | undefined;
  }
  register(input: DiagnosisRegistration): DiagnosisRequest {
    return this.transaction(() => {
      const prior = this.byResult(input.result_id);
      if (prior) return prior;
      const registration = this.sources.registration(input.result_id),
        s = registration?.registered;
      if (!s || s.outcome !== "failed" || s.contract_digest !== sha(input.contract_text)) throw Error("verify_scope_unregistered");
      const parsed = parseVerificationResultV1(input.contract_text);
      if (!parsed.ok) throw Error(parsed.code);
      const v = parsed.result;
      if (
        v.outcome !== "failed" ||
        v.result_id !== s.result_id ||
        v.repository_id !== s.repository_id ||
        v.repository !== s.repository ||
        v.pr !== s.pr_number ||
        v.head_sha !== s.head_sha ||
        v.base_sha !== s.base_sha ||
        v.skill_id !== s.skill_id ||
        v.producer.type !== "App" ||
        v.producer.app_id !== s.app_id
      )
        throw Error("verify_scope_unregistered");
      const matched = matchVerificationProducer(input.policy, {
        ...v.producer,
        carrier: "check-run",
        repository_id: v.repository_id,
        skill_id: v.skill_id,
        skill_manifest_digest: v.skill_manifest_digest,
        profile_id: v.profile_id,
        profile_digest: v.profile_digest,
        failure_code: v.failure_code,
      });
      if (!matched.ok) throw Error(matched.code);
      // V1 has no per-check policy map. An incomplete or contradictory mapping must never reproduce.
      const ambiguous =
        v.checks.some((c) => (c.exit === 0 ? c.failure_code !== null : c.failure_code === null)) ||
        new Set(v.checks.map((c) => c.check_id)).size !== v.checks.length;
      const failures = ambiguous
        ? []
        : v.checks.flatMap((c) => (c.failure_code === null ? [] : [{ check_id: c.check_id, failure_code: c.failure_code }]));
      const chain = input.chain_id === null ? undefined : this.chain(input.root_mission_id, input.chain_id);
      let bound: string | null = null;
      if (chain) {
        try {
          parseLocalFailureRevisionGrant(chain.grant_json);
          bound = chain.chain_id;
        } catch {
          /* No structurally valid opt-in. */
        }
      }
      const reason = registration?.withdrawn_by ? "verify_withdrawn" : bound ? null : "verify_grant_missing";
      const now = this.clock(),
        id = `vdr_${randomUUID()}`;
      this.db
        .prepare(`INSERT INTO engineering_diagnosis_requests
        (request_id,source_seq,result_id,repository_id,repository,pr_number,head_sha,base_sha,base_ref,branch,skill_id,profile_id,profile_digest,trusted_source_digest,
        trusted_repository,trusted_commit,root_mission_id,chain_id,expected_failures_json,allowed_codes_json,summary_reference_json,state,reason,revision,
        owner_home,owner_instance,owner_generation,writer_instance,writer_generation,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?)`)
        .run(
          id,
          s.seq,
          s.result_id,
          s.repository_id,
          s.repository,
          s.pr_number,
          s.head_sha,
          s.base_sha,
          v.base_ref,
          v.branch,
          v.skill_id,
          v.profile_id,
          v.profile_digest,
          v.trusted_source.artifact_digest,
          v.trusted_source.repository,
          v.trusted_source.commit_sha,
          input.root_mission_id,
          bound,
          JSON.stringify(failures),
          JSON.stringify(matched.producer.allowed_failure_codes),
          JSON.stringify(s.summary),
          reason === "verify_withdrawn" ? "diagnostic_closed" : reason ? "awaiting_decision" : "registered",
          reason,
          this.owner.home_id,
          this.owner.instance_id,
          this.owner.generation,
          this.owner.instance_id,
          this.owner.generation,
          now,
          now,
        );
      return this.get(id);
    });
  }
  private change(
    r: DiagnosisRequest,
    state: DiagnosisRequest["state"],
    reason: DiagnosisReason | null,
    chain = r.chain_id,
    intake = r.intake_id,
    receipt = r.receipt_id,
  ) {
    this.db
      .prepare(`UPDATE engineering_diagnosis_requests SET state=?,reason=?,chain_id=?,intake_id=?,receipt_id=?,revision=revision+1,
      writer_instance=?,writer_generation=?,updated_at=? WHERE request_id=? AND revision=?`)
      .run(
        state,
        reason,
        chain,
        intake,
        receipt,
        this.owner.instance_id,
        this.owner.generation,
        this.clock(),
        r.request_id,
        r.revision,
      );
    return this.get(r.request_id);
  }
  admit(id: string, ifRevision: number, f: DiagnosisFacts): DiagnosisAdmission {
    return this.transaction(() => {
      const r = this.get(id);
      if (r.state === "admitted" && r.intake_id)
        return {
          status: "admitted",
          request: r,
          intake: this.intakes.get(r.intake_id),
        };
      if (r.revision !== ifRevision) throw Error("version_conflict");
      if (!diagnosisCanAdmit(r)) throw Error("diagnosis_state_denied");
      const refuse = (reason: DiagnosisReason): DiagnosisAdmission => {
        const state = reason === "verify_withdrawn" || reason === "verify_duplicate" ? "diagnostic_closed" : "awaiting_decision";
        return {
          status: "refused",
          reason,
          request: r.state === state && r.reason === reason ? r : this.change(r, state, reason),
        };
      };
      const reg = this.sources.registration(r.result_id);
      if (!reg || reg.withdrawn_by || reg.registered.seq !== r.source_seq) return refuse("verify_withdrawn");
      const chain = this.chain(r.root_mission_id, f.chain_id),
        g = f.grant;
      if (
        !chain ||
        (r.chain_id !== null && r.chain_id !== chain.chain_id) ||
        sha(chain.grant_json) !== f.grant_digest ||
        canonicalJson(JSON.parse(chain.grant_json)) !== canonicalJson(g) ||
        chain.published_head !== r.head_sha ||
        chain.published_base !== r.base_sha ||
        g.root_mission_id !== r.root_mission_id ||
        (g.renews && g.renews.chain_id !== chain.chain_id) ||
        canonicalJson(diagnosisProfile(r)) !== canonicalJson(f.profile) ||
        g.local_failure.profile_id !== r.profile_id ||
        g.local_failure.profile_digest !== r.profile_digest ||
        canonicalJson(g.local_failure.trusted_source) !== canonicalJson(f.profile.trusted_source) ||
        f.container_cap_seconds !== g.local_failure.diagnostic_timeout_seconds ||
        f.now < g.issued_at ||
        f.now >= g.expires_at ||
        this.clock() < g.issued_at
      )
        return refuse("verify_grant_invalid");
      try {
        checkGrantWindow(g, this.clock(), Infinity, chain.budget_json);
      } catch {
        return refuse("verify_grant_invalid");
      }
      for (const k of ["repository", "pr_number", "branch", "head_sha", "base_sha", "base_ref"] as const)
        if (g[k] !== r[k] || f.binding[k] !== r[k]) return refuse("verify_grant_invalid");
      const missions = new ContainedMissionStore(this.attention, this.owner);
      if (!this.matchesCandidateTree(r, chain.chain_id, f.binding.tree_sha) || missions.get(r.root_mission_id).scope_id !== g.scope_id) return refuse("verify_grant_invalid");
      if (missions.resolveLineage(r.root_mission_id).status !== "known") return refuse("verify_chain_lineage_unknown");
      if (missions.atDepthLimit(r.root_mission_id)) return refuse("verify_chain_depth_limit");
      if (chain.state !== "awaiting_review")
        return refuse(readRootActivity(this.db, r.root_mission_id).review ? "verify_chain_busy" : "verify_grant_invalid");
      let intake: LocalFailureIntake;
      try {
        intake = this.intakes.reserve({
          ...f.binding,
          intake_id: f.intake_id,
          chain_id: chain.chain_id,
          chain_revision: chain.revision,
          root_mission_id: r.root_mission_id,
          grant_id: g.grant_id,
          grant_digest: f.grant_digest,
          profile_id: r.profile_id,
          profile_digest: r.profile_digest,
          trusted_source_digest: r.trusted_source_digest,
          ci_hint_json: JSON.stringify({ source_seq: r.source_seq }),
          invocation_id: f.invocation_id,
          journal_ref: f.journal_ref,
          container_cap_seconds: f.container_cap_seconds,
        });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        switch (error.message) {
          case "verify_chain_busy":
          case "verify_budget_exhausted":
            return refuse(error.message);
          case "intake_grant_mismatch":
          case "intake_binding_denied":
          case "intake_opt_in_denied":
          case "intake_identity_invalid":
            return refuse("verify_grant_invalid");
          case "intake_reused":
            return refuse("verify_duplicate");
          default:
            throw error;
        }
      }
      this.sources.linkIntake(r.source_seq, intake.intake_id, "admission");
      return {
        status: "admitted",
        request: this.change(r, "admitted", null, chain.chain_id, intake.intake_id),
        intake,
      };
    });
  }
  conclude(id: string, ifRevision: number, v: DiagnosisVerdict) {
    return this.transaction(() => {
      const r = this.get(id);
      if (r.revision !== ifRevision) throw Error("version_conflict");
      if (r.state === v.state && r.reason === v.reason) return r;
      return this.change(r, v.state, v.reason);
    });
  }
  recordReceipt(id: string, value: LocalVerificationReceipt, runIdentityDigest: string): HostReceipt {
    return this.transaction(() => {
      const r = this.get(id);
      if (r.state !== "admitted" || !r.intake_id || r.receipt_id) throw Error("host_receipt_immutable");
      const receipt = parseLocalVerificationReceipt(value),
        i = this.intakes.get(r.intake_id),
        binding = localFailureBindingFromLedger(i);
      if (
        i.state !== "stopped" ||
        i.started_at !== receipt.started_at ||
        i.outcome !== receipt.outcome ||
        i.proof_ref !== receipt.stop.proof_ref ||
        i.proof_digest !== receipt.stop.proof_digest ||
        i.evidence_digest !== receipt.evidence_digest ||
        Object.entries(binding).some(([k, v]) => receipt[k as keyof typeof binding] !== v)
      )
        throw Error("host_receipt_binding_invalid");
      const receiptId = `vhr_${randomUUID()}`;
      this.db
        .prepare(`INSERT INTO engineering_host_receipts(receipt_id,intake_id,request_id,invocation_id,binding_json,profile_digest,trusted_source_digest,
        run_identity_digest,receipt_json,receipt_digest,evidence_digest,stop_proof_ref,stop_proof_digest,outcome,owner_home,owner_instance,owner_generation,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          receiptId,
          i.intake_id,
          id,
          i.invocation_id,
          canonicalJson(binding),
          i.profile_digest,
          i.trusted_source_digest,
          runIdentityDigest,
          canonicalJson(receipt),
          localVerificationReceiptDigest(receipt),
          i.evidence_digest,
          i.proof_ref,
          i.proof_digest,
          i.outcome,
          this.owner.home_id,
          this.owner.instance_id,
          this.owner.generation,
          this.clock(),
        );
      this.change(r, "admitted", null, r.chain_id, r.intake_id, receiptId);
      return this.receipt(receiptId);
    });
  }
  consumeReceipt(id: string, expectedReceiptDigest: string, consumer: string) {
    return this.transaction(() => {
      const row = this.receipt(id);
      if (row.consumed_at !== null) throw Error("host_receipt_consumed");
      if (row.receipt_digest !== expectedReceiptDigest) throw Error("host_receipt_digest_mismatch");
      let digest:string;
      try {digest=localVerificationReceiptDigest(JSON.parse(row.receipt_json));}
      catch {throw Error("host_receipt_digest_mismatch");}
      if (digest !== expectedReceiptDigest) throw Error("host_receipt_digest_mismatch");
      const r = this.get(row.request_id);
      if (r.state !== "eligible" || r.receipt_id !== id) throw Error("host_receipt_ineligible");
      this.db
        .prepare("UPDATE engineering_host_receipts SET consumed_at=?,consumed_by=? WHERE receipt_id=?")
        .run(this.clock(), consumer, id);
      return this.receipt(id);
    });
  }
}

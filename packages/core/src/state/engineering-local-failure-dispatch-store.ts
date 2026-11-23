import { createHash, randomUUID } from "node:crypto";
import { parseLocalVerificationReceipt } from "../bridge/local-failure.js";
import { createLocalFailureRepairInput, buildRepairGoal } from "../bridge/repair-input.js";
import { loadProtectedInstructionConfig } from "../bridge/instruction-boundary.js";
import { parseLocalFailureRevisionGrant } from "../bridge/revision-local-failure-grant.js";
import type { LocalFailureIntake } from "./engineering-local-failure-intake-store.js";
import type { EngineeringPrincipal } from "./engineering-store.js";
import {
  ContainedMissionStore,
  MAX_REPAIR_CHAIN_DEPTH,
  type ContainedDeriveInput,
} from "./engineering-contained-store.js";
import type { DiagnosisStore, DiagnosisRequest } from "./engineering-diagnosis-store.js";
import { checkGrantWindow } from "../bridge/diagnosis-admission.js";
import { checkRootAdmission } from "./engineering-root-admission.js";
import { RevisionChainStore, RevisionChainError, type RevisionChain } from "./engineering-revision-chain-store.js";
import { VerificationSourceStore } from "./engineering-verification-source-store.js";

export type DispatchReason =
  | "verify_repair_limit"
  | "verify_source_revoked"
  | "verify_chain_busy"
  | "verify_budget_exhausted"
  | "verify_grant_invalid"
  | "verify_chain_depth_limit"
  | "verify_chain_lineage_unknown"
  | "verify_protected_path";
export type PublicationFence =
  | ({ ok: true; dispatch_id: string; grant_digest: string } & Pick<DiagnosisRequest,
      "root_mission_id" | "request_id" | "result_id" | "source_seq" | "head_sha" | "base_sha">)
  | { ok: false; reason: "verify_publish_authority_invalid" | "verify_source_revoked" | "verify_stale_head" | "verify_base_changed" };
export type DispatchFault = "before_consume" | "after_consume" | "after_child" | "before_commit";
export interface RepairBinding {
  root: string;
  request_id: string;
  receipt_id: string;
  check_id: string;
  failure_code: string;
  pr: number;
  branch: string;
  base: string;
}
export interface DispatchInput {
  request_id: string;
  verify(
    request: DiagnosisRequest,
    chain: RevisionChain,
  ): {
    grant_digest: string;
    principal: EngineeringPrincipal;
    check_ids: readonly string[];
  };
  now(): number;
  launchCaps: { executor_seconds: number; verify_seconds: number };
  locations?: readonly string[];
  withinAllowed(path: string, allowedGlobs: readonly string[]): boolean;
  checkPaths(paths: readonly string[], verificationPaths: readonly string[]): "verify_protected_path" | null;
  buildChild(fields: {
    rootSpec: string;
    head: string;
    goal: string;
    locations: readonly string[];
    binding: RepairBinding;
  }): Pick<ContainedDeriveInput, "spec" | "claim">;
  fault?(point: DispatchFault): void;
}
class Refusal extends Error {
  constructor(
    readonly root: string,
    readonly reason: DispatchReason,
  ) {
    super(reason);
  }
}
interface Dispatched {
  status: "dispatched";
  dispatch_id: string;
  child_mission_id: string;
}
const config = loadProtectedInstructionConfig([
  {
    id: "repair",
    text: "Preserve the original test assertions and verification configuration.",
  },
]);

export class LocalFailureDispatchStore {
  constructor(readonly diagnosis: DiagnosisStore) {}
  recover(requestId: string): Dispatched | null {
    const row = this.diagnosis.db
      .prepare("SELECT dispatch_id,child_mission_id FROM engineering_local_failure_dispatches WHERE request_id=?")
      .get(requestId) as Omit<Dispatched, "status"> | undefined;
    return row ? { status: "dispatched", ...row } : null;
  }
  private sourceRevoked(r: DiagnosisRequest): boolean {
    const s = this.diagnosis;
    const reg = new VerificationSourceStore(s.attention, s.owner).registration(r.result_id);
    return !reg || !!reg.withdrawn_by || reg.registered.seq !== r.source_seq || !!s.db.prepare(
      "SELECT 1 FROM engineering_verification_sources WHERE supersedes_result_id=? AND decision='accepted'",
    ).get(r.result_id);
  }

  private grantHonorsIntake(chain: RevisionChain, currentDigest: string, boundDigest: string, intake: LocalFailureIntake): boolean {
    if (chain.chain_id !== intake.chain_id) return false;
    if (currentDigest === boundDigest) return true;
    try {
      const grant = parseLocalFailureRevisionGrant(chain.grant_json);
      if (grant.renews?.chain_id !== chain.chain_id) return false;
      const pin = grant.local_failure;
      // The intake digest covers only the artifact. Its immutable grant also binds repository and commit.
      const source = parseLocalFailureRevisionGrant(intake.grant_json).local_failure.trusted_source;
      return pin.profile_id === intake.profile_id && pin.profile_digest === intake.profile_digest
        && pin.trusted_source.artifact_digest === intake.trusted_source_digest
        && pin.trusted_source.repository === source.repository && pin.trusted_source.commit === source.commit;
    } catch {
      return false;
    }
  }

  publicationFence(childMissionId: string, now: number): PublicationFence {
    const s = this.diagnosis;
    const row = s.db.prepare(
      "SELECT dispatch_id, grant_digest, request_id, root_mission_id, chain_id FROM engineering_local_failure_dispatches WHERE child_mission_id=?",
    ).get(childMissionId) as { dispatch_id: string; grant_digest: string; request_id: string; root_mission_id: string; chain_id: string } | undefined;
    const invalid = { ok: false, reason: "verify_publish_authority_invalid" } as const;
    if (!row) return invalid;
    const chain = s.chain(row.root_mission_id, row.chain_id);
    const r = s.get(row.request_id);
    if (!chain || !r.intake_id) return invalid;
    try {
      const digest = createHash("sha256").update(chain.grant_json).digest("hex");
      if (!this.grantHonorsIntake(chain, digest, row.grant_digest, s.intakes.get(r.intake_id))) return invalid;
      const grant = parseLocalFailureRevisionGrant(chain.grant_json);
      if (now < grant.issued_at) return invalid;
      checkGrantWindow(grant, now, Infinity, chain.budget_json);
    } catch {
      return invalid;
    }
    if (this.sourceRevoked(r)) return { ok: false, reason: "verify_source_revoked" };
    if (chain.published_head !== r.head_sha) return { ok: false, reason: "verify_stale_head" };
    if (chain.published_base !== r.base_sha) return { ok: false, reason: "verify_base_changed" };
    return { ok: true, dispatch_id: row.dispatch_id, grant_digest: row.grant_digest, root_mission_id: row.root_mission_id,
      request_id: r.request_id, result_id: r.result_id, source_seq: r.source_seq, head_sha: r.head_sha, base_sha: r.base_sha };
  }

  dispatch(input: DispatchInput) {
    const s = this.diagnosis;
    if (s.db.inTransaction) throw Error("dispatch_requires_immediate_transaction");
    const missions = new ContainedMissionStore(s.attention, s.owner);
    try {
      return s.transaction(() => {
        const r = s.get(input.request_id);
        const refuse = (reason: DispatchReason): never => {
          throw new Refusal(r.root_mission_id, reason);
        };
        if (r.state !== "eligible" || !r.receipt_id || !r.chain_id) return refuse("verify_grant_invalid");
        const existing = this.recover(r.request_id);
        if (existing) return existing;
        const chain = s.chain(r.root_mission_id, r.chain_id);
        if (!chain) return refuse("verify_grant_invalid");
        let verified: ReturnType<DispatchInput["verify"]>;
        let grant: ReturnType<typeof parseLocalFailureRevisionGrant>;
        try {
          verified = input.verify(r, chain);
          grant = parseLocalFailureRevisionGrant(chain.grant_json);
        } catch {
          return refuse("verify_grant_invalid");
        }
        const root = missions.get(r.root_mission_id);
        const intake = s.intakes.get(r.intake_id!);
        if (
          verified.grant_digest !== createHash("sha256").update(chain.grant_json).digest("hex") ||
          !this.grantHonorsIntake(chain, verified.grant_digest, intake.grant_digest, intake) ||
          grant.scope_id !== root.scope_id ||
          verified.principal.principal_id !== grant.principal_id ||
          verified.principal.client_session_id !== grant.client_session_id ||
          !verified.principal.write_scopes.includes(root.scope_id)
        )
          return refuse("verify_grant_invalid");
        if (!s.matchesCandidateTree(r, chain.chain_id, intake.tree_sha)) return refuse("verify_grant_invalid");
        if (this.sourceRevoked(r) || chain.published_head !== r.head_sha || chain.published_base !== r.base_sha)
          return refuse("verify_source_revoked");
        const parent = missions.resolveLineage(root.mission_id);
        if (parent.status === "unknown") return refuse(parent.reason);
        if (
          s.db
            .prepare("SELECT 1 FROM engineering_local_failure_dispatches WHERE root_mission_id=?")
            .get(root.mission_id)
        )
          return refuse("verify_repair_limit");
        if (chain.state !== "awaiting_review") return refuse("verify_chain_busy");
        if (chain.rounds_used >= grant.rounds) return refuse("verify_repair_limit");
        const rootSpec = JSON.parse(root.spec_json) as {
          allowed_paths: string[];
          verification_paths?: string[];
          max_repair_cycles?: number;
        };
        const launches = 1 + Math.min(rootSpec.max_repair_cycles ?? 2, 8);
        const slice = {
          executor_seconds: launches * input.launchCaps.executor_seconds,
          container_seconds: launches * input.launchCaps.verify_seconds,
        };
        if (!Number.isSafeInteger(slice.executor_seconds) || slice.executor_seconds < 1)
          return refuse("verify_budget_exhausted");
        const admission = checkRootAdmission(s.db, root.mission_id, "local_failure", {
          chain_id: r.chain_id,
          container_seconds: slice.container_seconds,
        });
        if (!admission.ok) return refuse(admission.code);
        const chains = new RevisionChainStore(s.attention, s.owner, input.now);
        try {
          if (chains.remainingBudget(chain.chain_id).executor_seconds < slice.executor_seconds)
            return refuse("verify_budget_exhausted");
        } catch (error) {
          if (error instanceof RevisionChainError && error.code === "spent_unreadable")
            return refuse("verify_budget_exhausted");
          throw error;
        }
        const receipt = s.receipt(r.receipt_id);
        if (receipt.consumed_by !== null) return refuse("verify_repair_limit");
        const allowedCodes: string[] = JSON.parse(r.allowed_codes_json);
        const { checks } = parseLocalVerificationReceipt(JSON.parse(receipt.receipt_json));
        if (
          allowedCodes.length !== 1 ||
          verified.check_ids.length !== 1 ||
          checks.length !== 1 ||
          checks[0]?.check_id !== verified.check_ids[0] ||
          !checks[0]?.exit_code ||
          receipt.outcome !== "reproducible_failure"
        )
          return refuse("verify_grant_invalid");
        const check_id = checks[0].check_id,
          failure_code = allowedCodes[0]!;
        let repair: ReturnType<typeof createLocalFailureRepairInput>;
        try {
          repair = createLocalFailureRepairInput(
            {
              check_id,
              failure_code,
              ...(input.locations !== undefined && { locations: input.locations }),
              check_ids: verified.check_ids,
              allowed_codes: allowedCodes,
              allowed_paths: rootSpec.allowed_paths,
            },
            input.withinAllowed,
          );
        } catch (error) {
          if (error instanceof Error && error.message === "verify_protected_path")
            return refuse("verify_protected_path");
          return refuse("verify_grant_invalid");
        }
        if (input.checkPaths(repair.locations, rootSpec.verification_paths ?? []))
          return refuse("verify_protected_path");
        const goal = buildRepairGoal(config, repair);
        const binding = {
          root: root.mission_id,
          request_id: r.request_id,
          receipt_id: r.receipt_id,
          check_id,
          failure_code,
          pr: r.pr_number,
          branch: r.branch,
          base: r.base_sha,
        };
        let child: ReturnType<DispatchInput["buildChild"]>;
        try {
          child = input.buildChild({
            rootSpec: root.spec_json,
            head: r.head_sha,
            goal,
            locations: repair.locations,
            binding,
          });
        } catch {
          return refuse("verify_grant_invalid");
        }
        const dispatch_id = `vld_${randomUUID()}`,
          idempotency_key = `local_failure:${root.mission_id}`,
          now = input.now();
        const register = () => missions.registerDerived(
          verified.principal,
          {
            ...child,
            scope_id: root.scope_id,
            parent_mission_id: root.mission_id,
            source: { kind: "local_failure", id: r.request_id },
            idempotency_key,
          },
          now,
        );
        if (parent.lineage.chain_depth + 1 >= MAX_REPAIR_CHAIN_DEPTH) {
          const stop = register();
          if (stop.status !== "depth_limit") throw Error("lineage_idempotency_conflict");
          input.fault?.("after_child");
          return { status: "depth_limit" as const, state: "awaiting_decision" as const, reason: stop.reason, stop_mission_id: stop.mission.mission_id };
        }
        input.fault?.("before_consume");
        s.consumeReceipt(receipt.receipt_id, receipt.receipt_digest, dispatch_id);
        input.fault?.("after_consume");
        const registered = register();
        if (registered.status === "waiting" || registered.status === "depth_limit") return refuse(registered.reason);
        if (registered.status === "duplicate") return refuse("verify_repair_limit");
        input.fault?.("after_child");
        const child_mission_id = registered.mission.mission_id;
        chains.allocateChild(chain.chain_id, chain.revision, child_mission_id, slice, now, dispatch_id);
        try {
          s.db
            .prepare(`INSERT INTO engineering_local_failure_dispatches
          (dispatch_id,request_id,receipt_id,receipt_digest,root_mission_id,chain_id,child_mission_id,grant_id,grant_digest,
          check_id,failure_code,idempotency_key,owner_home,owner_instance,owner_generation,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(
              dispatch_id,
              r.request_id,
              r.receipt_id,
              receipt.receipt_digest,
              root.mission_id,
              chain.chain_id,
              child_mission_id,
              intake.grant_id,
              intake.grant_digest,
              check_id,
              failure_code,
              idempotency_key,
              s.owner.home_id,
              s.owner.instance_id,
              s.owner.generation,
              now,
            );
        } catch (error) {
          if (error instanceof Error && error.message === "verify_chain_busy") return refuse("verify_chain_busy");
          if (error instanceof Error && error.message === "dispatch_binding_invalid")
            return refuse("verify_grant_invalid");
          throw error;
        }
        input.fault?.("before_commit");
        return { status: "dispatched" as const, dispatch_id, child_mission_id };
      });
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      s.transaction(() => {
        if (
          !s.db
            .prepare(`SELECT 1 FROM engineering_contained_events e WHERE e.mission_id=? AND e.kind='local_failure_dispatch_refused'
          AND json_extract(e.payload_json,'$.reason')=?
          AND NOT EXISTS (SELECT 1 FROM engineering_revision_chain_events c
            JOIN engineering_revision_chains chain ON chain.chain_id=c.chain_id
            WHERE chain.root_mission_id=e.mission_id AND c.kind='grant_replaced' AND c.created_at > e.created_at)`)
            .get(e.root, e.reason)
        )
          missions.record(
            e.root,
            "local_failure_dispatch_refused",
            { state: "awaiting_decision", reason: e.reason },
            input.now(),
          );
      });
      return {
        status: "refused" as const,
        state: "awaiting_decision" as const,
        reason: e.reason,
      };
    }
  }
}

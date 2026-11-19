import type { PrLiveState, SnapshotReview } from "./merge-gates.js";
import type { RecheckVerdict } from "./recheck.js";

export interface VerificationGateInput {
  recheck: {
    state: RecheckVerdict["state"];
    reason: RecheckVerdict["reason"];
    new_head_sha: string;
    base_sha: string;
    recheck_result_id: string | null;
  } | null;
  recheck_result_current: boolean;
  chain: { published_head: string; published_base: string; base_ref: string; branch: string; pr_number: number };
  confirmed_push: { candidate: string; branch: string; pr: number } | null;
  pr: {
    complete: boolean;
    state: PrLiveState;
    head_oid: string;
    base_ref_name: string;
    base_tip_oid: string | null;
    merge_commit_oid: string | null;
    merged_head_oid: string | null;
    merge_base_oid: string | null;
    merged_by: { type: "User" | "Bot"; id: number } | null;
  };
  reviews: { complete: boolean; items: readonly SnapshotReview[] };
  threads: { complete: boolean; unresolved: number };
  counted_approvers: readonly number[];
}

export interface VerificationGateVerdict {
  state: "awaiting_decision" | "merged" | "closed_unmerged" | "reverify_pending" | "ready_for_human";
  reason: RecheckVerdict["reason"] | "verify_merge_unverified" | "verify_approval_required";
  hold: boolean;
  facts: { head: string | null; review_id: number | null; base_sha?: string | null; merge_base_oid?: string | null };
}

const sha = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
const id = (v: number | null): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const ref = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,254}$/.test(v)
  && !v.includes("..") && !v.includes("//") && !v.endsWith("/") && !v.endsWith(".") && !v.split("/").some(p => p.endsWith(".lock"));
const resultId = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);

function countedApproval({ reviews, threads, counted_approvers, pr }: VerificationGateInput): number | null {
  if (reviews?.complete !== true || !Array.isArray(reviews.items) || threads?.complete !== true || threads.unresolved !== 0
    || !Array.isArray(counted_approvers) || !counted_approvers.every(id)) return null;
  const stateful: SnapshotReview[] = [];
  for (const r of reviews.items) {
    if (r?.state === "PENDING" || r?.state === "COMMENTED") continue;
    if (!r || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state) || !id(r.author_id)
      || !["User", "Bot", "Other"].includes(r.author_type) || !id(r.review_id) || !Number.isSafeInteger(r.submitted_at_ms)
      || r.submitted_at_ms < 0 || typeof r.author_can_push !== "boolean" || !(r.commit_oid === null || sha(r.commit_oid))) return null;
    stateful.push(r);
  }
  const latest = new Map<string, SnapshotReview>();
  for (const r of stateful.sort((a, b) => a.submitted_at_ms - b.submitted_at_ms || a.review_id - b.review_id))
    latest.set(`${r.author_type}:${r.author_id}`, r);
  const rows = [...latest.values()];
  if (rows.some(r => r.state === "CHANGES_REQUESTED")) return null;
  return rows.find(r => r.state === "APPROVED" && r.author_type === "User" && r.author_id !== null
    && counted_approvers.includes(r.author_id) && r.author_can_push && r.commit_oid === pr.head_oid)?.review_id ?? null;
}

export function evaluateVerificationGate(input: VerificationGateInput): VerificationGateVerdict {
  const { pr, recheck, chain, confirmed_push: push } = input;
  const observed = pr?.state === "MERGED" ? pr.merged_head_oid : pr?.head_oid;
  const facts: VerificationGateVerdict["facts"] = { head: sha(observed) ? observed : null, review_id: null };
  if (pr?.state === "MERGED") {
    facts.base_sha = sha(recheck?.base_sha) ? recheck.base_sha : null;
    facts.merge_base_oid = sha(pr.merge_base_oid) ? pr.merge_base_oid : null;
  }
  const held = (state: VerificationGateVerdict["state"], reason: VerificationGateVerdict["reason"]) => ({ state, reason, hold: true, facts });
  if (pr?.complete !== true || !["OPEN", "MERGED", "CLOSED"].includes(pr.state))
    return held("awaiting_decision", "verify_merge_unverified");
  if (pr.state === "CLOSED") return held("closed_unmerged", null);

  const current = recheck?.state === "recheck_passed" && recheck.reason === null && resultId(recheck.recheck_result_id)
    && input.recheck_result_current === true && sha(recheck.new_head_sha) && sha(recheck.base_sha)
    && chain?.published_head === recheck.new_head_sha && sha(chain.published_base)
    && ref(chain.base_ref) && ref(chain.branch) && id(chain.pr_number);
  if (pr.state === "MERGED") {
    if (current && sha(pr.merge_commit_oid) && pr.merged_head_oid === recheck.new_head_sha
      && pr.base_ref_name === chain.base_ref
      && pr.merged_by && ["User", "Bot"].includes(pr.merged_by.type) && id(pr.merged_by.id)
      && push?.candidate === recheck.new_head_sha && push.branch === chain.branch && push.pr === chain.pr_number)
      return held("merged", null);
    return held("awaiting_decision", "verify_merge_unverified");
  }

  if (recheck?.state === "awaiting_decision" && (recheck.reason === "verify_recheck_failed" || recheck.reason === "verify_recheck_binding_changed"))
    return held("awaiting_decision", recheck.reason);
  if (!current || pr.head_oid !== recheck.new_head_sha || chain.published_base !== recheck.base_sha)
    return held("reverify_pending", "verify_recheck_missing");
  if (!ref(pr.base_ref_name) || !sha(pr.base_tip_oid)) return held("awaiting_decision", "verify_merge_unverified");
  facts.review_id = countedApproval(input);
  if (facts.review_id === null) return held("ready_for_human", "verify_approval_required");
  return { state: "ready_for_human", reason: null, hold: false, facts };
}

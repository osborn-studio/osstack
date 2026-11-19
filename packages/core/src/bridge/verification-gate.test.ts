import { expect, it } from "vitest";
import { evaluateVerificationGate as gate, type VerificationGateInput } from "./verification-gate.js";

const head = "a".repeat(40), base = "b".repeat(40), other = "c".repeat(40);
const passed = { state: "recheck_passed", reason: null, new_head_sha: head, base_sha: base,
  recheck_result_id: "00000000-0000-4000-8000-000000000001" } as const;
const pending = { ...passed, state: "reverify_pending", reason: "verify_recheck_missing", recheck_result_id: null } as const;
const approval = { state: "APPROVED", review_id: 5, author_type: "User", author_id: 1, author_can_push: true,
  submitted_at_ms: 10, commit_oid: head } as const;
const open: VerificationGateInput = {
  recheck: passed, recheck_result_current: true,
  chain: { published_head: head, published_base: base, base_ref: "main", branch: "fix", pr_number: 9 },
  confirmed_push: { candidate: head, branch: "fix", pr: 9 },
  pr: { complete: true, state: "OPEN", head_oid: head, base_ref_name: "main", base_tip_oid: base,
    merge_commit_oid: null, merged_head_oid: null, merge_base_oid: null, merged_by: null },
  reviews: { complete: true, items: [approval] }, threads: { complete: true, unresolved: 0 }, counted_approvers: [1],
};
const merged: VerificationGateInput = { ...open, pr: { ...open.pr, state: "MERGED", merge_commit_oid: other,
  merged_head_oid: head, merge_base_oid: base, merged_by: { type: "Bot", id: 6 } } };

it("requires a complete known PR before recognizing closure", () => {
  for (const patch of [{ state: "CLOSED", complete: false }, { state: "UNKNOWN" }]) {
    expect(gate({ ...open, pr: { ...open.pr, ...patch } as typeof open.pr })).toMatchObject({
      state: "awaiting_decision", reason: "verify_merge_unverified", hold: true });
  }
  expect(gate({ ...open, pr: { ...open.pr, state: "CLOSED" } })).toMatchObject({ state: "closed_unmerged", reason: null, hold: true });
});
it("recognizes a fully bound merge without releasing", () => {
  expect(gate(merged)).toMatchObject({ state: "merged", reason: null, hold: true });
});
it.each([[other, other], [null, null], ["unreadable", null]])("recognizes a merge onto %s", (merge_base_oid, expected) => {
  expect(gate({ ...merged, pr: { ...merged.pr, merge_base_oid } })).toMatchObject({
    state: "merged", reason: null, hold: true, facts: { base_sha: base, merge_base_oid: expected },
  });
});
it("records available base evidence from an incomplete merged PR", () => {
  expect(gate({ ...merged, recheck: null, pr: { ...merged.pr, complete: false } })).toMatchObject({
    state: "awaiting_decision", reason: "verify_merge_unverified", facts: { base_sha: null, merge_base_oid: base },
  });
});
const mergeFailures: Record<string, Partial<VerificationGateInput>> = {
  pending: { recheck: pending }, failed: { recheck: { ...passed, state: "awaiting_decision", reason: "verify_recheck_failed" } },
  withdrawn: { recheck_result_current: false }, "other merged head": { pr: { ...merged.pr, merged_head_oid: other } },
  "missing commit": { pr: { ...merged.pr, merge_commit_oid: null } }, retargeted: { pr: { ...merged.pr, base_ref_name: "next" } },
  anonymous: { pr: { ...merged.pr, merged_by: null } },
  "invalid actor": { pr: { ...merged.pr, merged_by: { type: "User", id: 0 } } },
  "missing push": { confirmed_push: null }, "other candidate": { confirmed_push: { candidate: other, branch: "fix", pr: 9 } },
  "other branch": { confirmed_push: { candidate: head, branch: "next", pr: 9 } },
  "other PR": { confirmed_push: { candidate: head, branch: "fix", pr: 8 } },
};
it.each(Object.entries(mergeFailures))("holds an unverified merge: %s", (_, patch) => {
  expect(gate({ ...merged, ...patch })).toMatchObject({ state: "awaiting_decision", reason: "verify_merge_unverified", hold: true,
    facts: { merge_base_oid: (patch.pr ?? merged.pr).merge_base_oid, base_sha: base } });
});
it.each(["verify_recheck_failed", "verify_recheck_binding_changed"] as const)("surfaces %s", reason => {
  expect(gate({ ...open, recheck: { ...passed, state: "awaiting_decision", reason } })).toMatchObject({ state: "awaiting_decision", reason, hold: true });
});
it.each([ { recheck: null }, { recheck: pending }, { recheck_result_current: false }, { pr: { ...open.pr, head_oid: other } },
  { chain: { ...open.chain, published_head: other } }, { chain: { ...open.chain, published_base: other } },
  { recheck: { ...passed, recheck_result_id: null } } ])("holds for missing or stale verification %#", patch => {
  expect(gate({ ...open, ...patch })).toMatchObject({ state: "reverify_pending", reason: "verify_recheck_missing", hold: true });
});
const review = (items: VerificationGateInput["reviews"]["items"]) => ({ reviews: { complete: true, items } });
const approvalFailures: Record<string, Partial<VerificationGateInput>> = {
  app: review([{ ...approval, author_type: "Bot" }]), stale: review([{ ...approval, commit_oid: other }]),
  superseded: review([{ ...approval, state: "DISMISSED", review_id: 6 }, approval]),
  "changes requested": review([approval, { ...approval, author_id: 2, state: "CHANGES_REQUESTED" }]),
  anonymous: review([approval, { ...approval, author_id: null, state: "DISMISSED" }]),
  uncounted: { counted_approvers: [2] }, "no push": review([{ ...approval, author_can_push: false }]),
  unresolved: { threads: { complete: true, unresolved: 1 } }, "unknown threads": { threads: { complete: false, unresolved: 0 } },
  incomplete: { reviews: { ...open.reviews, complete: false } },
};
it.each(Object.entries(approvalFailures))("holds for approval: %s", (_, patch) => {
  expect(gate({ ...open, ...patch })).toMatchObject({ state: "ready_for_human", reason: "verify_approval_required", hold: true });
});
it("releases exactly the open, current, passed, approved combination", () => {
  for (const state of ["OPEN", "MERGED", "CLOSED"] as const)
    for (const recheck of [passed, pending, null])
      for (const current of [true, false])
        for (const approved of [true, false]) {
          const verdict = gate({ ...merged, pr: { ...merged.pr, state }, recheck, recheck_result_current: current, counted_approvers: approved ? [1] : [] });
          const release = state === "OPEN" && recheck === passed && current && approved;
          expect(verdict.hold).toBe(!release);
          if (release) expect(verdict).toMatchObject({ state: "ready_for_human", reason: null, facts: { head, review_id: 5 } });
        }
});

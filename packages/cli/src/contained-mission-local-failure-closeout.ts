import { RevisionChainStore, type ContainedMissionStore } from "@osstack/core";
import {
  DiagnosisStore, LocalFailureRecheckStore, evaluateVerificationGate, type VerificationGateInput, type VerificationGateVerdict,
} from "@osstack/core/verification-intake";

type Snapshot = Pick<VerificationGateInput, "pr" | "reviews" | "threads">;
interface Dependencies {
  store: ContainedMissionStore;
  now(): number;
  countedApprovers: readonly number[];
  readPr(target: { repository: string; pr: number }, signal: AbortSignal): Promise<Snapshot | null>;
  signal?: AbortSignal;
}
type Audit = Pick<VerificationGateVerdict, "state" | "reason" | "hold"> & {
  dispatch_id: string; recheck_id: string | null; head: string | null; merge_commit_oid: string | null;
};
const unreadable: Snapshot = {
  pr: { complete: false, state: "OPEN", head_oid: "", base_ref_name: "", base_tip_oid: null, merge_commit_oid: null,
    merged_head_oid: null, merge_base_oid: null, merged_by: null },
  reviews: { complete: false, items: [] }, threads: { complete: false, unresolved: 0 },
};

export async function readLocalFailureCloseout(deps: Dependencies, childMissionId: string) {
  const { store } = deps;
  const dispatch = store.db.prepare("SELECT dispatch_id,chain_id FROM engineering_local_failure_dispatches WHERE child_mission_id=?")
    .get(childMissionId) as { dispatch_id: string; chain_id: string } | undefined;
  if (!dispatch) throw Error("verify_closeout_unknown_child");
  const { dispatch_id, chain_id } = dispatch;
  const diagnosis = new DiagnosisStore(store.attention, store.owner);
  const ledger = new LocalFailureRecheckStore(diagnosis);
  const chains = new RevisionChainStore(store.attention, store.owner);
  const latest = () => {
    const json = store.db.prepare(`SELECT payload_json FROM engineering_revision_chain_events
      WHERE chain_id=? AND kind='local_repair_closeout' AND json_extract(payload_json,'$.dispatch_id')=?
      ORDER BY seq DESC LIMIT 1`).pluck().get(chain_id, dispatch_id) as string | undefined;
    return json === undefined ? null : JSON.parse(json) as Audit;
  };
  const target = chains.get(chain_id);
  const ids = { dispatch_id, chain_id, pr: target.pr_number };
  const terminal = (row: Audit | null) => {
    if (row?.state !== "merged" && row?.state !== "closed_unmerged") return null;
    return { ...ids, recheck_id: row.recheck_id, state: row.state, reason: null, hold: true,
      published_head: target.published_head, recheck_head: row.recheck_id ? ledger.get(row.recheck_id).new_head_sha : null,
      head: row.head, merge_commit_oid: row.merge_commit_oid, facts: { head: row.head, review_id: null } };
  };
  const recorded = terminal(latest());
  if (recorded) return recorded;
  let live: Snapshot | null;
  try {
    live = await deps.readPr({ repository: target.repository, pr: target.pr_number }, deps.signal ?? new AbortController().signal);
  } catch {
    live = null;
  }

  return diagnosis.transaction(() => {
    const prior = latest();
    const settled = terminal(prior);
    if (settled) return settled;
    const chain = chains.get(chain_id);
    const recheck = ledger.forDispatch(dispatch_id);
    const push = store.db.prepare(`SELECT json_extract(proof,'$.candidate') AS candidate,
      json_extract(proof,'$.branch') AS branch,
      CASE WHEN json_type(proof,'$.pr')='integer' THEN json_extract(proof,'$.pr') END AS pr
      FROM (SELECT CASE WHEN json_valid(payload_json) THEN payload_json END AS proof
        FROM engineering_contained_events WHERE mission_id=? AND kind='verify_repair_push_confirmed'
        ORDER BY seq DESC LIMIT 1)`).get(childMissionId) as VerificationGateInput["confirmed_push"] | undefined;
    const snapshot = live && target.repository === chain.repository && target.pr_number === chain.pr_number ? live : unreadable;
    const verdict = evaluateVerificationGate({
      pr: snapshot.pr,
      reviews: snapshot.reviews,
      threads: snapshot.threads,
      chain,
      recheck: recheck ?? null,
      recheck_result_current: recheck !== undefined && ledger.resultCurrent(recheck.recheck_id),
      confirmed_push: push ?? null,
      counted_approvers: deps.countedApprovers,
    });
    const { state, reason, hold } = verdict;
    const head = verdict.facts.head;
    const oid = snapshot.pr?.merge_commit_oid;
    const merge_commit_oid = typeof oid === "string" && /^[a-f0-9]{40}$/.test(oid) ? oid : null;
    const recheck_id = recheck?.recheck_id ?? null;
    if (prior?.state !== state || prior.reason !== reason || prior.head !== head) {
      const payload: Audit = { dispatch_id, recheck_id, state, reason, hold, head, merge_commit_oid };
      chains.appendEvent(chain_id, "local_repair_closeout", payload, deps.now());
    }
    return { ...ids, recheck_id, published_head: chain.published_head, recheck_head: recheck?.new_head_sha ?? null,
      head, merge_commit_oid, ...verdict };
  });
}

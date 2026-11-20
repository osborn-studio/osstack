import { createHash } from "node:crypto";
import { RevisionChainStore, type ContainedMissionStore } from "@osstack/core";
import {
  DiagnosisStore,
  LocalFailureRecheckStore,
  VerificationSourceStore,
  parseRecheckResult,
  type LocalFailureRecheck,
  type RecheckEvaluation,
  type ActionsAttemptFact,
  type HostRecheckProof,
} from "@osstack/core/verification-intake";

type Target = { repository: string; repository_id: number; pr: number; head: string };
export interface RecheckCollectorDeps {
  store: ContainedMissionStore;
  now(): number;
  signal?: AbortSignal;
  readOriginalContract(
    q: { result_id: string; source_seq: number; repository_id: number; pr: number },
    signal: AbortSignal,
  ): Promise<string | null>;
  readRecheckContracts(q: Target & { base_sha: string }, signal: AbortSignal): Promise<readonly string[] | null>;
  readActions(q: Target & { base: string; branch: string }, signal: AbortSignal): Promise<ActionsAttemptFact | null>;
  hostProof(recheckId: string): HostRecheckProof | null;
}

async function readPort<T>(read: () => T | Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

function newestResult(texts: readonly string[] | null, row: LocalFailureRecheck, sources: VerificationSourceStore) {
  if (
    !texts?.length ||
    texts.length > 20 ||
    texts.some((t) => typeof t !== "string" || Buffer.byteLength(t) > 256 * 1024)
  )
    return null;
  const history = sources.history(row.repository_id, row.pr_number);
  let newest: RecheckEvaluation["result"];
  for (const text of texts) {
    const result = parseRecheckResult(text);
    if (!result || result.head_sha !== row.new_head_sha || result.result_id === row.original_result_id) continue;
    const digest = createHash("sha256").update(text).digest("hex");
    const source = history.find(
      (s) => s.decision === "accepted" && s.result_id === result.result_id && s.contract_digest === digest,
    );
    if (source && (!newest || source.seq > newest.source_seq)) newest = { source_seq: source.seq, contract_text: text };
  }
  return newest;
}

export async function collectLocalFailureRecheck(deps: RecheckCollectorDeps, childMissionId: string) {
  const { store } = deps;
  const dispatch = store.db
    .prepare("SELECT dispatch_id, request_id FROM engineering_local_failure_dispatches WHERE child_mission_id=?")
    .get(childMissionId) as { dispatch_id: string; request_id: string } | undefined;
  if (!dispatch) throw Error("verify_recheck_unknown_child");
  const diagnosis = new DiagnosisStore(store.attention, store.owner);
  const ledger = new LocalFailureRecheckStore(diagnosis);
  const signal = deps.signal ?? new AbortController().signal;
  let row = ledger.forDispatch(dispatch.dispatch_id);
  let opened = false;
  if (!row) {
    const request = diagnosis.get(dispatch.request_id);
    const text = await readPort(() =>
      deps.readOriginalContract(
        {
          result_id: request.result_id,
          source_seq: request.source_seq,
          repository_id: request.repository_id,
          pr: request.pr_number,
        },
        signal,
      ),
    );
    if (text === null) return { opened: false, recheck: null, code: "verify_recheck_missing" } as const;
    try {
      // Another collector can open this dispatch while the original contract is being read.
      row = diagnosis.transaction(() => {
        const existing = ledger.forDispatch(dispatch.dispatch_id);
        if (existing) return existing;
        const created = ledger.open({
          child_mission_id: childMissionId,
          original_contract_text: text,
          now: deps.now(),
        });
        opened = true;
        return created;
      });
    } catch (error) {
      if (error instanceof Error && error.message === "verify_recheck_binding_invalid")
        return { opened: false, recheck: null, code: "verify_recheck_binding_invalid" } as const;
      throw error;
    }
  }
  const presented = { result: false, actions: false, host: false };
  if (row.state !== "reverify_pending") return { opened, recheck: row, presented };
  const { recheck_id, base_sha } = row;
  const target = {
    repository: row.repository,
    repository_id: row.repository_id,
    pr: row.pr_number,
    head: row.new_head_sha,
  };
  const { branch } = new RevisionChainStore(store.attention, store.owner).get(row.chain_id);
  const [texts, actions, host] = await Promise.all([
    readPort(() => deps.readRecheckContracts({ ...target, base_sha }, signal)),
    readPort(() => deps.readActions({ ...target, base: base_sha, branch }, signal)),
    readPort(() => deps.hostProof(recheck_id)),
  ]);
  const result = newestResult(texts, row, new VerificationSourceStore(store.attention, store.owner));
  const recheck = ledger.evaluate({
    recheck_id,
    now: deps.now(),
    ...(result && { result }),
    ...(actions && { actions }),
    ...(host && { host }),
  });
  return { opened, recheck, presented: { result: !!result, actions: !!actions, host: !!host } };
}

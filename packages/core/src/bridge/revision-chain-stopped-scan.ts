import { decideChainStep, type PrState } from "./revision-chain.js";
import { RevisionChainError, type RevisionChain, type RevisionChainStore } from "../state/engineering-revision-chain-store.js";

/** Minimal PR facts for a stopped chain. The reader supplies no reviews or git history. */
export interface StoppedPrFacts {
  pr_state: PrState;
  head: string;
  head_repository: string;
  head_ref: string;
  base_sha: string;
  base_ref: string;
  complete: boolean;
}
export interface StoppedScanEntry {
  chain_id: string;
  repository: string;
  pr_number: number;
  facts: StoppedPrFacts | null;
  action: "none" | "closed";
  reason: "pr_merged" | "pr_closed" | "facts_changed" | "facts_unchanged" | "snapshot_incomplete" | "read_failed" | "version_conflict" | "changed_during_read" | "scan_error";
  /** Set on a committed close so the caller can request child cancellation. */
  current_mission_id?: string | null;
  /** Heads voided by the committed close. */
  voided_reservation_heads?: string[];
}
export interface StoppedScanReport { chains: StoppedScanEntry[]; next_cursor: { updated_at: number; chain_id: string } | null }
type ScanStore = Pick<RevisionChainStore, "listStoppedLive" | "get" | "events" | "appendEvent" | "applyDecision" | "reservations">;

function complete(facts: StoppedPrFacts): boolean {
  return facts.complete && [facts.head, facts.head_repository, facts.head_ref, facts.base_sha, facts.base_ref].every(x => typeof x === "string" && x.length > 0)
    && ["OPEN", "MERGED", "CLOSED"].includes(facts.pr_state);
}
function latestObservation(store: ScanStore, chainId: string): Record<string, unknown> | null {
  let after = 0;
  let latest: Record<string, unknown> | null = null;
  for (;;) {
    const page = store.events(chainId, after, 500);
    for (const event of page) {
      if (event.kind === "stopped_chain_observed") latest = JSON.parse(event.payload_json) as Record<string, unknown>;
    }
    if (page.length < 500) return latest;
    after = page[page.length - 1]!.seq;
  }
}
function observation(chain: RevisionChain, facts: StoppedPrFacts, now: number) {
  return {
    pr_state: facts.pr_state, head: facts.head, head_repository: facts.head_repository, head_ref: facts.head_ref,
    base_sha: facts.base_sha, base_ref: facts.base_ref, observed_at: now,
    differs: { head: facts.head !== chain.published_head, base: facts.base_sha !== chain.published_base || facts.base_ref !== chain.base_ref },
  };
}
/** One bounded scan. The live caller owns scheduling, rate limits, and bridge enablement. For every
 * `closed` entry, it must request cancellation of `current_mission_id` when present. Active
 * reservations are voided atomically with the close; `voided_reservation_heads` identifies them. */
export async function scanStoppedChains(input: {
  store: ScanStore;
  readPr: (chain: RevisionChain) => Promise<StoppedPrFacts>;
  now: number;
  limit: number;
  after?: { updated_at: number; chain_id: string };
}): Promise<StoppedScanReport> {
  const chains: StoppedScanEntry[] = [];
  const batch = input.store.listStoppedLive(input.limit, input.after);
  for (const chain of batch) {
    const entry = (facts: StoppedPrFacts | null, reason: StoppedScanEntry["reason"], action: StoppedScanEntry["action"] = "none"): StoppedScanEntry =>
      ({ chain_id: chain.chain_id, repository: chain.repository, pr_number: chain.pr_number, facts, action, reason });
    let facts: StoppedPrFacts | null = null;
    try {
      try { facts = await input.readPr(chain); }
      catch { chains.push(entry(null, "read_failed")); continue; }
      if (!complete(facts)) { chains.push(entry(facts, "snapshot_incomplete")); continue; }
      const decision = decideChainStep({
        mode: chain.mode, state: chain.state, published_head: chain.published_head, published_base: chain.published_base,
        base_ref: chain.base_ref, rounds_used: chain.rounds_used, grant_rounds: null,
        review_deadline: chain.review_deadline, reserved_heads: [],
      }, { pr_state: facts.pr_state, head: facts.head, base_sha: facts.base_sha, base_ref: facts.base_ref,
        reviews: [], complete: true, moved: false }, { publisher: [], reviewers: [] }, input.now);
      if (decision.kind === "transition" && decision.to === "closed") {
        try {
          const heads = input.store.reservations(chain.chain_id).filter(r => r.state === "reserved" || r.state === "dispatched").map(r => r.head_sha);
          input.store.applyDecision(chain.chain_id, chain.revision, decision, input.now);
          chains.push({ ...entry(facts, decision.reason === "pr_merged" ? "pr_merged" : "pr_closed", "closed"),
            current_mission_id: chain.current_mission_id, voided_reservation_heads: heads });
        } catch (error) {
          if (!(error instanceof RevisionChainError && error.code === "version_conflict")) throw error;
          chains.push(entry(facts, "version_conflict"));
        }
        continue;
      }
      const current = input.store.get(chain.chain_id);
      if (current.revision !== chain.revision || current.state !== chain.state) {
        chains.push(entry(facts, "changed_during_read")); continue;
      }
      const seen = observation(chain, facts, input.now);
      const last = latestObservation(input.store, chain.chain_id);
      const changed = last === null || (["pr_state", "head", "head_repository", "head_ref", "base_sha", "base_ref"] as const).some(key => last[key] !== seen[key]);
      if (changed) input.store.appendEvent(chain.chain_id, "stopped_chain_observed", seen, input.now);
      chains.push(entry(facts, changed ? "facts_changed" : "facts_unchanged"));
    } catch {
      chains.push(entry(facts, "scan_error"));
    }
  }
  const last = batch.at(-1);
  return { chains, next_cursor: last ? { updated_at: last.updated_at, chain_id: last.chain_id } : null };
}

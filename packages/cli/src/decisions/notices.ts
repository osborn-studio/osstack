import type { DecisionRow, DecisionQueries, ExternalAttentionDecision, ExternalAttentionDecisions } from "@osstack/core";
import { DecisionSource } from "@osstack/protocol";
import { decisionItem } from "./list.js";

const pageSize = 100;
const sourceLimit = 500;
const locations = /(?:[a-z][a-z\d+.-]*:\/\/|[A-Za-z]:[\\/]|~?\/|\\\\)[^\s"'<>]*/giu;

function chainFacts(source: DecisionSource, row: DecisionRow): Pick<ExternalAttentionDecision, "reason" | "chain"> {
  if (source !== "contained_mission" || row.state !== "awaiting_decision" || row.reason !== "verify_chain_depth_limit" || !row.lineage_json) return {};
  try {
    const { origin_mission_id, parent_mission_id, depth } = JSON.parse(row.lineage_json);
    if (depth === 8 && typeof origin_mission_id === "string" && (parent_mission_id === null || typeof parent_mission_id === "string"))
      return { reason: row.reason, chain: { origin_mission_id, parent_mission_id, mission_id: row.id, depth, max_depth: 8 } };
  } catch { /* The pending decision remains visible without chain facts. */ }
  return {};
}

function isRecheckOnly(source: DecisionSource, row: DecisionRow): boolean {
  if (source !== "revision_chain" || row.state === "ready_for_human" || row.state === "awaiting_decision") return false;
  try {
    const recheck = JSON.parse(row.details_json)?.recheck;
    return recheck !== null && typeof recheck === "object";
  } catch { return false; }
}

function notice(queries: DecisionQueries, source: DecisionSource, row: DecisionRow, firstSeen: Map<string, number>, now: () => number): ExternalAttentionDecision {
  const item = decisionItem(source, row);
  // Without a transition, revisions on these projections (and the digest
  // of a card's editable title) can change during the same wait.
  const mutableRevision = source === "contained_mission" || source === "ci_repair"
    || source === "revision_chain" || source === "autonomy" || row.kind === "loop_card";
  const identity = item.waiting_since ?? (mutableRevision ? row.state : item.source_revision);
  const item_id = queries.externalDecisionItemId(source, item.source_id, identity);
  const waiting_since = item.waiting_since ?? firstSeen.get(item_id) ?? now();
  if (item.waiting_since === null) firstSeen.set(item_id, waiting_since);
  const reference = item.summary.replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(locations, "[redacted]").slice(0, 240);
  return { item_id, scope_id: item.scope_id ?? "host", source, source_id: item.source_id,
    waiting_since, reference, requires_local_signature: item.requires_local_signature, ...chainFacts(source, row) };
}

export function createDecisionNoticeSource(
  queries: DecisionQueries, scopes: () => readonly string[], now: () => number,
  report?: (code: string) => void,
): ExternalAttentionDecisions & { readonly truncated: boolean } {
  const firstSeenBySource = new Map<DecisionSource, Map<string, number>>();
  let truncated = false;
  const incomplete = new Set<string>();
  return {
    get truncated() { return truncated; },
    get incompleteSources() { return [...incomplete]; },
    pending() {
      truncated = false;
      incomplete.clear();
      const items: ExternalAttentionDecision[] = [];
      let read_scopes: readonly string[] = [];
      let scopesAvailable = true;
      try { read_scopes = scopes(); }
      catch { scopesAvailable = false; report?.("decision_notice_scopes_unreadable"); }
      for (const source of DecisionSource.options) {
        if (source === "session") continue;
        if (!scopesAvailable && ["contained_mission", "ci_repair", "revision_chain"].includes(source)) {
          incomplete.add(source);
          continue;
        }
        const batch: ExternalAttentionDecision[] = [];
        const firstSeen = firstSeenBySource.get(source) ?? new Map<string, number>();
        firstSeenBySource.set(source, firstSeen);
        let after = "";
        try {
          while (true) {
            const rows = queries[source]({ read_scopes, after, limit: pageSize });
            for (const row of rows) {
              if (isRecheckOnly(source, row)) continue;
              if (batch.length === sourceLimit) {
                truncated = true;
                incomplete.add(source);
                report?.("decision_notice_truncated:" + source);
                break;
              }
              batch.push(notice(queries, source, row, firstSeen, now));
            }
            if (incomplete.has(source) || rows.length < pageSize) break;
            after = rows[rows.length - 1]!.id;
          }
          if (!incomplete.has(source) && firstSeen.size) {
            const present = new Set(batch.map(item => item.item_id));
            for (const id of firstSeen.keys()) if (!present.has(id)) firstSeen.delete(id);
          }
          items.push(...batch);
        } catch {
          incomplete.add(source);
          report?.("decision_notice_unreadable:" + source);
        }
      }
      return items;
    },
  };
}

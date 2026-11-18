import { createHash } from "node:crypto";
import type { DecisionRow, DecisionQueries, ExternalAttentionDecision, ExternalAttentionDecisions } from "@osstack/core";
import { DecisionSource } from "@osstack/protocol";
import { decisionItem } from "./list.js";

const pageSize = 100;
const sourceLimit = 500;
const locations = /(?:[a-z][a-z\d+.-]*:\/\/|[A-Za-z]:[\\/]|~?\/|\\\\)[^\s"'<>]*/giu;

function notice(source: DecisionSource, row: DecisionRow, firstSeen: Map<string, number>, now: () => number): ExternalAttentionDecision {
  const item = decisionItem(source, row);
  // Without a transition, revisions on these projections (and the digest
  // of a card's editable title) can change during the same wait.
  const mutableRevision = source === "contained_mission" || source === "ci_repair"
    || source === "revision_chain" || source === "autonomy" || row.kind === "loop_card";
  const identity = item.waiting_since ?? (mutableRevision ? row.state : item.source_revision);
  const digest = createHash("sha256").update(JSON.stringify([source, item.source_id, identity])).digest("hex");
  const item_id = "decision:" + digest.slice(0, 32);
  const waiting_since = item.waiting_since ?? firstSeen.get(item_id) ?? now();
  if (item.waiting_since === null) firstSeen.set(item_id, waiting_since);
  const reference = item.summary.replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(locations, "[redacted]").slice(0, 240);
  return { item_id, scope_id: item.scope_id ?? "host", source, source_id: item.source_id,
    waiting_since, reference, requires_local_signature: item.requires_local_signature };
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
          while (batch.length < sourceLimit) {
            const limit = Math.min(pageSize, sourceLimit - batch.length);
            const rows = queries[source]({ read_scopes, after, limit });
            for (const row of rows) batch.push(notice(source, row, firstSeen, now));
            if (rows.length < limit) break;
            after = rows[rows.length - 1]!.id;
          }
          if (batch.length === sourceLimit && queries[source]({ read_scopes, after, limit: 1 }).length) {
            truncated = true;
            incomplete.add(source);
            report?.("decision_notice_truncated:" + source);
          } else if (firstSeen.size) {
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

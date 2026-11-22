import { createHash } from "node:crypto";
import { RevisionChainStore, type AttentionSender, type ContainedMissionStore } from "@osstack/core";
import { DiagnosisStore, LocalFailureRecheckStore } from "@osstack/core/verification-intake";

export const DEFAULT_RECHECK_WAITING_NOTICE_MS = 60 * 60 * 1000;

export interface RecheckWaitingNoticeDeps {
  store: ContainedMissionStore;
  now(): number;
  waitMs: number;
  send: AttentionSender;
  signal: AbortSignal;
  limit?: number;
}

export interface RecheckWaitingNoticeReport {
  examined: number;
  sent: number;
  failed: number;
  skipped: number;
}

const kind = "local_recheck_waiting_notice";

export async function noticeWaitingRechecks(deps: RecheckWaitingNoticeDeps): Promise<RecheckWaitingNoticeReport> {
  const { store, waitMs, limit = 20 } = deps;
  if (!Number.isSafeInteger(waitMs) || waitMs < 60_000 || waitMs > 7 * 24 * DEFAULT_RECHECK_WAITING_NOTICE_MS
    || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw Error("recheck_waiting_notice_config_invalid");
  }
  const diagnosis = new DiagnosisStore(store.attention, store.owner);
  const ledger = new LocalFailureRecheckStore(diagnosis);
  const chains = new RevisionChainStore(store.attention, store.owner);
  const candidates = store.db.prepare(`SELECT recheck_id FROM engineering_local_failure_rechecks AS r
    WHERE state='reverify_pending' AND instr(missing_json,'"result"')>0 AND created_at<=?
      AND NOT EXISTS (SELECT 1 FROM engineering_revision_chain_events AS e
        WHERE e.chain_id=r.chain_id AND e.kind=? AND json_extract(e.payload_json,'$.recheck_id')=r.recheck_id)
    ORDER BY created_at, recheck_id LIMIT 500`).pluck().all(deps.now() - waitMs, kind) as string[];
  const report = { examined: 0, sent: 0, failed: 0, skipped: 0 };
  for (const recheck_id of candidates) {
    if (deps.signal.aborted || report.sent + report.failed >= limit) break;
    report.examined++;
    const claim = diagnosis.transaction(() => {
      const row = ledger.get(recheck_id);
      const delivery_id = "recheck-waiting:" + recheck_id;
      if (row.state !== "reverify_pending" || !(JSON.parse(row.missing_json) as string[]).includes("result")
        || delivery_id.length > 256 || !/^[A-Za-z0-9_:-]+$/.test(recheck_id)) return null;
      const prior = store.db.prepare(`SELECT 1 FROM engineering_revision_chain_events
        WHERE chain_id=? AND kind=? AND json_extract(payload_json,'$.recheck_id')=? LIMIT 1`).get(row.chain_id, kind, recheck_id);
      if (prior) return null;
      const scope = store.db.prepare("SELECT scope_id FROM engineering_contained_missions WHERE mission_id=?")
        .pluck().get(row.root_mission_id) as string | undefined;
      const scope_id = scope ?? "host";
      if (store.db.prepare("SELECT 1 FROM attention_postures WHERE scope_id=? AND posture='quiet' LIMIT 1").get(scope_id)) return null;

      const message = {
        delivery_id, scope_id,
        item_id: "verification-waiting:" + createHash("sha256").update(recheck_id).digest("hex").slice(0, 32),
        state: "verification_waiting",
        question: `Waiting for the verification result: ${row.repository}#${row.pr_number} head ${row.new_head_sha} recheck ${recheck_id}`,
      };
      chains.appendEvent(row.chain_id, kind, { recheck_id, status: "claimed", delivery_id }, deps.now());
      return { chain_id: row.chain_id, message };
    });
    if (!claim) {
      report.skipped++;
      continue;
    }
    const ids = { recheck_id, delivery_id: claim.message.delivery_id };
    try {
      await deps.send(claim.message, deps.signal);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : null;
      const error = typeof message === "string" && /^[a-z0-9_]{1,64}$/.test(message) ? message : "send_failed";
      chains.appendEvent(claim.chain_id, kind, { ...ids, status: "failed", error }, deps.now());
      report.failed++;
      continue;
    }
    chains.appendEvent(claim.chain_id, kind, { ...ids, status: "sent" }, deps.now());
    report.sent++;
  }
  return report;
}

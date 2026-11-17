import type Database from "better-sqlite3";
import { restoreExternalReference } from "../bridge/external-reference.js";
import { decideVerificationSources, verificationRegistrationState, type VerificationSourceDecision, type VerificationSourceObservation, type VerificationSourceRecord } from "../bridge/verification-source-ledger.js";
import type { AttentionOwner, AttentionStore } from "./attention-store.js";

type StoredRow = Omit<VerificationSourceRecord, "summary"> & { summary_reference_json: string | null };
function restore(row: StoredRow): VerificationSourceRecord {
  const { summary_reference_json, ...fields } = row;
  try {
    const summary = summary_reference_json === null ? null : restoreExternalReference(JSON.parse(summary_reference_json));
    if ((fields.result_id === null) !== (summary === null)) throw new Error("verification_source_corrupt");
    return { ...fields, summary };
  } catch { throw new Error("verification_source_corrupt"); }
}
/** Owner-fenced, append-only source journal. No other domain table is written. */
export class VerificationSourceStore {
  constructor(readonly attention: AttentionStore, readonly owner: AttentionOwner) {}
  get db(): Database.Database { return this.attention.db; }

  history(repositoryId: number, pr: number): VerificationSourceRecord[] {
    const rows = this.db.prepare("SELECT * FROM engineering_verification_sources WHERE repository_id=? AND pr_number=? ORDER BY seq").all(repositoryId, pr) as StoredRow[];
    return rows.map(restore);
  }
  registration(resultId: string): ReturnType<typeof verificationRegistrationState> {
    const row = this.db.prepare("SELECT repository_id,pr_number FROM engineering_verification_sources WHERE result_id=? AND decision='accepted'").get(resultId) as { repository_id: number; pr_number: number } | undefined;
    return row ? verificationRegistrationState(this.history(row.repository_id, row.pr_number), resultId) : null;
  }
  record(batch: readonly VerificationSourceObservation[], observedAt: number, recordedAt: number): { observation: VerificationSourceObservation; outcome: VerificationSourceDecision; seq: number | null }[] {
    if (batch.length > 200) throw new Error("verification_source_batch_limit");
    return this.write(() => {
      const keys = new Map(batch.map(o => [`${o.repository_id}:${o.pr}`, o]));
      const history = [...keys.values()].flatMap(o => this.history(o.repository_id, o.pr));
      // Use the pure batch order, then resolve each decision against actual inserted sequence ids.
      return decideVerificationSources(history, batch).map(({ observation: o }) => {
        // The accepted result-id index is global, including registrations outside this PR.
        const registered = o.result ? this.db.prepare("SELECT * FROM engineering_verification_sources WHERE result_id=? AND decision='accepted'").get(o.result.result_id) as StoredRow | undefined : undefined;
        const decisionHistory = registered && !history.some(r => r.seq === registered.seq)
          ? [...history, restore(registered)] : history;
        const outcome = decideVerificationSources(decisionHistory, [o])[0]!.outcome;
        if (outcome.decision === "duplicate" && !outcome.persist) return { observation: o, outcome, seq: outcome.original_seq };
        const r = o.result;
        const row = {
          source_kind: o.source_kind, object_id: o.object_id, repository_id: o.repository_id, repository: o.repository, pr_number: o.pr,
          observed_head_sha: o.observed_head_sha, app_id: o.app_id, check_name: o.check_name, response_digest: o.response_digest, contract_digest: o.contract_digest,
          result_id: r?.result_id ?? null, attempt: r?.attempt ?? null, skill_id: r?.skill_id ?? null, outcome: r?.outcome ?? null,
          head_sha: r?.head_sha ?? null, base_sha: r?.base_sha ?? null, dedup_key: r?.dedup_key ?? null,
          withdraws_result_id: r?.withdraws_result_id ?? null, supersedes_result_id: r?.supersedes_result_id ?? null,
          decision: outcome.decision, reason_code: outcome.reason_code, original_seq: outcome.decision === "duplicate" ? outcome.original_seq : null,
          withdraws_seq: outcome.decision === "accepted" ? outcome.withdraws_seq : null,
          summary_reference_json: r ? JSON.stringify(r.summary) : null, intake_id: null, observed_at: observedAt, recorded_at: recordedAt,
        };
        const columns = Object.keys(row);
        const inserted = this.db.prepare(`INSERT INTO engineering_verification_sources(${columns.join(",")}) VALUES(${columns.map(c => `@${c}`).join(",")})`).run(row);
        const seq = Number(inserted.lastInsertRowid);
        history.push(restore({ ...row, seq }));
        return { observation: o, outcome, seq };
      });
    });
  }
  linkIntake(seq: number, intakeId: string): void {
    this.write(() => {
      const result = this.db.prepare("UPDATE engineering_verification_sources SET intake_id=? WHERE seq=?").run(intakeId, seq);
      if (result.changes !== 1) throw new Error("verification_source_immutable");
    });
  }
  private write<T>(fn: () => T): T {
    if (this.db.pragma("synchronous", { simple: true }) !== 2) throw new Error("durability_required");
    if (this.db.inTransaction) throw new Error("verification_source_nested_transaction");
    return this.db.transaction(() => { this.attention.assertOwner(this.owner); return fn(); }).immediate();
  }
}

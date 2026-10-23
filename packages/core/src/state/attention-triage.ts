import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { SessionDecision } from "@osstack/protocol";
import { z } from "zod";
import { attentionDigest, type AttentionOwner, type AttentionStore } from "./attention-store.js";

export const AttentionTriageResult = z.object({ category: z.enum(["human_decision", "system_wait", "source_uncertain"]), explanation: z.string().max(500) }).strict();
export type AttentionTriageResult = z.infer<typeof AttentionTriageResult>;
const Usage = z.object({ input_tokens: z.number().int().nonnegative().max(1000000), output_tokens: z.number().int().nonnegative().max(1000000) }).strict();
export interface AttentionTriageSnapshot {
  scope_id: string; item_id: string; item_revision: number; source_hash: string;
  deterministic_category: "human_decision"; question_excerpt: string; schema_version: 1; input_digest: string;
}
export interface AttentionTriageReservation {
  scope_id: string; item_id: string; model_id: string; policy_fingerprint: string; calls_per_hour: number; timeout_ms: number;
}
export type AttentionTriageAdmission = { state: "reserved"; attempt_id: string; input: AttentionTriageSnapshot }
  | { state: "cached"; attempt_id: string; result: AttentionTriageResult; input: AttentionTriageSnapshot }
  | { state: "fallback"; reason: string };
export interface AttentionTriageCompletion {
  status: "succeeded" | "failed" | "unknown"; reason?: string; reported_model?: string;
  usage?: { input_tokens: number; output_tokens: number }; result?: AttentionTriageResult;
}
interface Attempt {
  attempt_id: string; scope_id: string; item_id: string; input_digest: string; requested_model: string;
  owner_generation: number; reserved_at: number; deadline_at: number; status: string; result_json: string | null; active_slot: number | null;
}
/** Writes only the triage ledger; never answers, resumes, acknowledges or changes an item. */
export class AttentionTriageLedger {
  constructor(readonly store: AttentionStore, readonly owner: AttentionOwner, private readonly clock: () => number = Date.now) {}
  private snapshot(scopeId: string, itemId: string): AttentionTriageSnapshot {
    if (!/^[a-f0-9]{64}$/.test(scopeId) || !/^[a-f0-9]{64}$/.test(itemId)) throw Error("source_changed");
    const db = this.store.db;
    const raw = db.prepare(`SELECT i.revision,i.source_version,i.content_hash,i.turn_id,i.decision_id,i.session_id,
      s.task_id,s.repo_path,t.created_at task_created_at,a.run_id,a.request_sha256,a.agent_id,a.repo_path session_repo,a.version,
      u.binding_hash,CASE WHEN length(CAST(v.decision_json AS BLOB))<=16384 THEN v.decision_json ELSE NULL END decision_json
      FROM attention_items i JOIN attention_scopes s ON s.scope_id=i.scope_id
      JOIN tasks t ON t.task_id=s.task_id AND t.tenant_id IS NULL
      JOIN agent_sessions a ON a.session_id=i.session_id AND a.task_id=s.task_id AND a.state='awaiting_decision'
      JOIN runs r ON r.run_id=a.run_id AND r.task_id=t.task_id AND r.tenant_id IS NULL
      JOIN attention_subjects u ON u.scope_id=s.scope_id AND u.kind='session' AND u.subject_id=a.session_id AND u.admitted=1
      JOIN session_turns v ON v.session_id=a.session_id AND v.turn_id=i.turn_id AND v.ordinal=(SELECT MAX(ordinal) FROM session_turns WHERE session_id=a.session_id)
      WHERE i.scope_id=? AND i.item_id=? AND i.state='open'`).get(scopeId, itemId) as Record<string, unknown> | undefined;
    if (!raw || typeof raw["repo_path"] !== "string" || typeof raw["session_repo"] !== "string" || typeof raw["decision_json"] !== "string") throw Error("source_changed");
    if (attentionDigest([this.owner.home_id, raw["task_id"], raw["repo_path"], raw["task_created_at"]]) !== scopeId
      || realpathSync(raw["session_repo"]) !== raw["repo_path"] || raw["version"] !== raw["source_version"]
      || attentionDigest([raw["session_id"], raw["run_id"], raw["request_sha256"], raw["agent_id"], raw["session_repo"]]) !== raw["binding_hash"]) throw Error("source_changed");
    const decision = SessionDecision.parse(JSON.parse(raw["decision_json"]));
    if (attentionDigest(decision) !== raw["content_hash"] || decision.decision_id !== raw["decision_id"]) throw Error("source_changed");
    const input = { schema_version: 1 as const, scope_id: scopeId, item_id: itemId, item_revision: Number(raw["revision"]),
      source_hash: attentionDigest([raw["content_hash"], raw["source_version"], raw["turn_id"], raw["binding_hash"]]),
      deterministic_category: "human_decision" as const, question_excerpt: decision.question };
    if (Buffer.byteLength(JSON.stringify(input)) > 8192) throw Error("input_too_large");
    return { ...input, input_digest: attentionDigest(input) };
  }
  recover(): void {
    this.store.write(this.owner, () => this.store.db.prepare("UPDATE attention_triage_attempts SET status='unknown',reason='owner_restarted_unconfirmed_stop' WHERE active_slot=1 AND owner_generation<>?").run(this.owner.generation));
  }
  reserve(request: AttentionTriageReservation): AttentionTriageAdmission {
    if (!Number.isSafeInteger(request.calls_per_hour) || request.calls_per_hour < 1 || request.calls_per_hour > 5
      || !Number.isSafeInteger(request.timeout_ms) || request.timeout_ms < 1 || request.timeout_ms > 20000
      || !/^[a-f0-9]{64}$/.test(request.policy_fingerprint) || !/^[a-zA-Z0-9._:-]{1,128}$/.test(request.model_id)) throw Error("invalid_triage_configuration");
    return this.store.write(this.owner, () => {
      let input: AttentionTriageSnapshot;
      try { input = this.snapshot(request.scope_id, request.item_id); } catch { return { state: "fallback", reason: "source_changed" }; }
      const db = this.store.db;
      const cached = db.prepare("SELECT attempt_id,result_json FROM attention_triage_attempts WHERE input_digest=? AND requested_model=? AND policy_fingerprint=? AND status='succeeded' ORDER BY reserved_at DESC LIMIT 1").get(input.input_digest, request.model_id, request.policy_fingerprint) as Attempt | undefined;
      if (cached?.result_json) return { state: "cached", attempt_id: cached.attempt_id, result: AttentionTriageResult.parse(JSON.parse(cached.result_json)), input };
      const active = db.prepare("SELECT status FROM attention_triage_attempts WHERE active_slot=1").get() as { status: string } | undefined;
      if (active) return { state: "fallback", reason: active.status === "unknown" ? "triage_quarantined" : "triage_busy" };
      const now = this.clock(); if (!Number.isSafeInteger(now) || now < 0) throw Error("invalid_clock");
      const prior = db.prepare("SELECT MAX(reserved_at) latest FROM attention_triage_attempts").get() as { latest: number | null };
      const effectiveNow = Math.max(now, prior.latest ?? 0);
      const count = db.prepare("SELECT COUNT(*) n FROM attention_triage_attempts WHERE scope_id=? AND reserved_at>?").get(request.scope_id, effectiveNow - 3600000) as { n: number };
      if (count.n >= request.calls_per_hour) return { state: "fallback", reason: "budget_exhausted" };
      const attemptId = randomUUID();
      db.prepare("INSERT INTO attention_triage_attempts(attempt_id,scope_id,item_id,item_revision,source_hash,input_digest,requested_model,policy_fingerprint,owner_generation,reserved_at,deadline_at,status,active_slot) VALUES(?,?,?,?,?,?,?,?,?,?,?,'reserved',1)")
        .run(attemptId, request.scope_id, request.item_id, input.item_revision, input.source_hash, input.input_digest, request.model_id, request.policy_fingerprint, this.owner.generation, effectiveNow, effectiveNow + request.timeout_ms);
      return { state: "reserved", attempt_id: attemptId, input };
    });
  }
  start(attemptId: string): void {
    this.store.write(this.owner, () => {
      if (this.store.db.prepare("UPDATE attention_triage_attempts SET status='running' WHERE attempt_id=? AND owner_generation=? AND status='reserved' AND active_slot=1").run(attemptId, this.owner.generation).changes !== 1) throw Error("stale_attempt");
    });
  }
  finish(attemptId: string, completion: AttentionTriageCompletion): { status: string } {
    return this.store.write(this.owner, () => {
      const db = this.store.db;
      const attempt = db.prepare("SELECT * FROM attention_triage_attempts WHERE attempt_id=? AND owner_generation=? AND active_slot=1").get(attemptId, this.owner.generation) as Attempt | undefined;
      if (!attempt) throw Error("stale_attempt");
      // Once unknown, a late response cannot turn ambiguity into a successful explanation.
      let status: string = attempt.status === "unknown" ? "unknown" : completion.status;
      const now = this.clock();
      if (!Number.isSafeInteger(now) || now < 0) throw Error("invalid_clock");
      if (status === "succeeded" && Math.max(now, attempt.reserved_at) > attempt.deadline_at) status = "unknown";
      let result: AttentionTriageResult | undefined; let usage: z.infer<typeof Usage> | undefined;
      if (status === "succeeded") {
        try {
          if (this.snapshot(attempt.scope_id, attempt.item_id).input_digest !== attempt.input_digest) throw Error();
        } catch { status = "stale"; }
        if (status === "succeeded") {
          if (completion.reported_model !== attempt.requested_model) throw Error("model_identity_mismatch");
          result = AttentionTriageResult.parse(completion.result); usage = Usage.parse(completion.usage);
          if (Buffer.byteLength(JSON.stringify(result)) > 2048) throw Error("output_too_large");
        }
      }
      db.prepare("UPDATE attention_triage_attempts SET status=?,active_slot=?,reported_model=?,usage_json=?,result_json=?,result_digest=?,reason=? WHERE attempt_id=? AND owner_generation=?")
        .run(status, completion.status === "unknown" ? 1 : null, completion.reported_model?.slice(0,128) ?? null,
          usage ? JSON.stringify(usage) : null, result ? JSON.stringify(result) : null, result ? attentionDigest(result) : null,
          completion.reason?.slice(0,256) ?? (status === "stale" ? "source_changed" : status === "unknown" ? "outcome_unconfirmed_or_expired" : null), attemptId, this.owner.generation);
      return { status };
    });
  }
  /** Diagnostics are read-only; unknown active attempts cannot be silently released. */
  quarantine(): { attempt_id: string; reason: string | null; reserved_at: number } | undefined {
    this.store.assertOwner(this.owner);
    return this.store.db.prepare("SELECT attempt_id,reason,reserved_at FROM attention_triage_attempts WHERE active_slot=1 AND status='unknown'").get() as { attempt_id: string; reason: string | null; reserved_at: number } | undefined;
  }
}

import type { AttentionSender, ExternalAttentionDecision } from "@osstack/core";
import { localAttentionSender, validateExternalNoticeIds } from "./attention-local-delivery.js";

/** Host configuration only. Never include this object in diagnostics. */
export interface AttentionWebhookConfig {
  readonly url: URL;
  readonly key: string | null;
}

const noticeText = {
  merged_outside_merger: "A Mission pull request was merged by someone other than App E, so App E's gates did not apply to it. This is a notice, not a request. Replying here does nothing.",
  verification_waiting: "osstack is still waiting for the verification result on a repaired pull request. This is a notice, not a request. Replying here does nothing.",
  decision_pending_local: "A pending decision needs a signature on the owner's own machine. It cannot be answered remotely or by replying.",
  decision_overdue_local: "An overdue decision needs a signature on the owner's own machine. It cannot be answered remotely or by replying.",
  decision_pending: "A decision is waiting for the owner in osstack. Replying here does nothing; answer in osstack.",
  decision_overdue: "A decision is overdue in osstack. Replying here does nothing; answer in osstack.",
  answer_uncertain: "An answer needs review in osstack. Replying here does nothing; review it in osstack.",
  source_missing: "A decision source is missing in osstack. Replying here does nothing; check it in osstack.",
} as const;

export interface AttentionWebhookNotice {
  schema_version: 1;
  kind: "attention_decision_notice";
  delivery_id: string;
  scope_id: string;
  item_id: string;
  state: string;
  decision?: { source: string; source_id: string; local_signature_required: boolean;
    reason?: string; chain?: NonNullable<ExternalAttentionDecision["chain"]>;
    evidence?: { ledger: "engineering_contained_events"; mission_id: string } };
  reason_code: keyof typeof noticeText;
  reminder: { sequence: number; age_ms: number } | null;
  text: string;
  reference: {
    usage: "reference_only";
    kind: "external_reference";
    truncated: boolean;
    summary: string;
  };
}

export function parseAttentionWebhookConfig(env: NodeJS.ProcessEnv): AttentionWebhookConfig {
  const raw = env["OSSTACK_ATTENTION_WEBHOOK_URL"];
  let url: URL;
  try {
    if (!raw || raw !== raw.trim() || raw.length > 2048) throw new Error();
    url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || raw.includes("#")) throw new Error();
  } catch {
    throw new Error("attention_webhook_url_invalid");
  }
  const key = env["OSSTACK_ATTENTION_WEBHOOK_KEY"] ?? null;
  if (key !== null && (key !== key.trim() || key.length > 4096 || !/^[A-Za-z0-9._~+/-]+=*$/u.test(key))) {
    throw new Error("attention_webhook_key_invalid");
  }
  return { url, key };
}

export function buildAttentionWebhookNotice(message: Parameters<AttentionSender>[0]): AttentionWebhookNotice {
  for (const value of [message.delivery_id, message.scope_id, message.item_id, message.state]) {
    if (typeof value !== "string" || value.length > 256) throw new Error("attention_webhook_message_invalid");
  }
  if (typeof message.question !== "string") throw new Error("attention_webhook_message_invalid");
  const reminder = message.reminder;
  if (reminder && (!Number.isFinite(reminder.sequence) || !Number.isFinite(reminder.age_ms))) {
    throw new Error("attention_webhook_message_invalid");
  }
  const decision = message.decision;
  const waiting = message.state === "verification_waiting";
  const outside = message.state === "merged_outside_merger";
  if (outside !== message.item_id.startsWith("merged-outside-merger:")
    || (outside && (decision !== undefined || reminder !== undefined || !/^merged-outside-merger:[a-f0-9]{32}$/.test(message.item_id)))) {
    throw new Error("attention_webhook_message_invalid");
  }
  if (waiting !== message.item_id.startsWith("verification-waiting:")
    || (waiting && (decision !== undefined || reminder !== undefined || !/^verification-waiting:[a-f0-9]{32}$/.test(message.item_id)))) {
    throw new Error("attention_webhook_message_invalid");
  }
  if (decision !== undefined && (!decision || !["session", "contained_mission", "ci_repair", "revision_chain", "autonomy", "hermes", "loop", "probe", "ci_pilot"].includes(decision.source)
    || typeof decision.source_id !== "string" || decision.source_id.length > 256
    || typeof decision.requires_local_signature !== "boolean" || !/^decision:[a-f0-9]{32}$/.test(message.item_id))) {
    throw new Error("attention_webhook_message_invalid");
  }
  let facts: Pick<NonNullable<AttentionWebhookNotice["decision"]>, "reason" | "chain" | "evidence"> = {};
  if (decision && (decision.reason !== undefined || decision.chain !== undefined)) {
    const c = decision.chain;
    const validId = (id: unknown) => typeof id === "string" && /^[A-Za-z0-9_:-]{1,256}$/u.test(id);
    if (decision.source !== "contained_mission" || decision.reason !== "verify_chain_depth_limit" || !c
      || !validId(c.origin_mission_id) || !(c.parent_mission_id === null || validId(c.parent_mission_id))
      || !validId(c.mission_id) || c.mission_id !== decision.source_id || !Number.isInteger(c.depth) || c.depth < 0 || c.depth > 8 || c.max_depth !== 8)
      throw new Error("attention_webhook_message_invalid");
    const { origin_mission_id, parent_mission_id, mission_id, depth, max_depth } = c;
    facts = { reason: decision.reason, chain: { origin_mission_id, parent_mission_id, mission_id, depth, max_depth },
      evidence: { ledger: "engineering_contained_events", mission_id } };
  }
  const reason = outside ? "merged_outside_merger" : waiting ? "verification_waiting" : decision?.requires_local_signature ? (reminder ? "decision_overdue_local" : "decision_pending_local")
    : reminder ? "decision_overdue"
    : message.state === "answer_uncertain" || message.state === "source_missing" ? message.state : "decision_pending";
  const points = Array.from(message.question.replace(/[\r\n\t]/gu, " ").replace(/\p{Cc}/gu, ""));
  const notice: AttentionWebhookNotice = {
    schema_version: 1,
    kind: "attention_decision_notice",
    delivery_id: message.delivery_id,
    scope_id: message.scope_id,
    item_id: message.item_id,
    state: message.state,
    reason_code: reason,
    ...(decision && { decision: { source: decision.source, source_id: decision.source_id, local_signature_required: decision.requires_local_signature, ...facts } }),
    reminder: reminder ? { sequence: reminder.sequence, age_ms: reminder.age_ms } : null,
    text: noticeText[reason],
    reference: { usage: "reference_only", kind: "external_reference", truncated: points.length > 512, summary: points.slice(0, 512).join("") },
  };
  if (Buffer.byteLength(JSON.stringify(notice), "utf8") > 16 * 1024) throw new Error("attention_webhook_notice_too_large");
  return notice;
}

export function webhookAttentionSender(
  config: AttentionWebhookConfig,
  deps: { send?: typeof fetch; timeoutMs?: number } = {}
): AttentionSender {
  return async (message, signal) => {
    if (signal.aborted) throw new Error("aborted");
    if (message.decision) await validateExternalNoticeIds(message);
    const body = JSON.stringify(buildAttentionWebhookNotice(message));
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Idempotency-Key": message.delivery_id,
    };
    if (config.key !== null) headers["Authorization"] = `Bearer ${config.key}`;
    const timeout = AbortSignal.timeout(deps.timeoutMs ?? 4000);
    let response: Response;
    try {
      response = await (deps.send ?? fetch)(config.url, {
        method: "POST", headers, body, redirect: "error",
        signal: AbortSignal.any([signal, timeout]),
      });
    } catch {
      throw new Error(signal.aborted ? "aborted" : timeout.aborted ? "attention_webhook_timeout" : "attention_webhook_unreachable");
    }
    void response.body?.cancel().catch(() => {});
    if (response.status < 200 || response.status >= 300) throw new Error(`attention_webhook_http_${response.status}`);
  };
}

export function selectAttentionSender(env: NodeJS.ProcessEnv, home: string): AttentionSender | undefined {
  if (env["OSSTACK_ATTENTION_NOTIFY"] === "local") return localAttentionSender(home);
  if (env["OSSTACK_ATTENTION_NOTIFY"] === "webhook") return webhookAttentionSender(parseAttentionWebhookConfig(env));
  return undefined;
}

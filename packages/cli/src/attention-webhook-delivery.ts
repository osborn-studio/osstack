import type { AttentionSender } from "@osstack/core";
import { localAttentionSender } from "./attention-local-delivery.js";

/** Host configuration only. Never include this object in diagnostics. */
export interface AttentionWebhookConfig {
  readonly url: URL;
  readonly key: string | null;
}

const noticeText = {
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
  const reason = reminder ? "decision_overdue"
    : message.state === "answer_uncertain" || message.state === "source_missing" ? message.state : "decision_pending";
  const points = Array.from(message.question.replace(/[\r\n\t]/gu, " ").replace(/[\u0000-\u001f\u007f-\u009f]/gu, ""));
  const notice: AttentionWebhookNotice = {
    schema_version: 1,
    kind: "attention_decision_notice",
    delivery_id: message.delivery_id,
    scope_id: message.scope_id,
    item_id: message.item_id,
    state: message.state,
    reason_code: reason,
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

import { AutonomyNotificationPayload, type AutonomyNotificationKind } from "@osstack/core";
import { writeLocalNotice } from "./attention-local-delivery.js";
import { parseAttentionWebhookConfig, type AttentionWebhookConfig } from "./attention-webhook-delivery.js";
import { NotificationInvalidResponseError, type AutonomyNotificationSender } from "./autonomy-notification.js";
import { isSafeExternalNoticeId, redactBridge } from "./contained-mission-redact.js";

const noticeText: Record<AutonomyNotificationKind, string> = {
  awaiting_approval: "Approval needs a signature on the owner's own machine. Replying here does nothing.",
  escalated: "The guarded autonomy run escalated. Replying here does nothing.",
  deploy_frozen: "Production deployment is frozen. Replying here does nothing.",
  rollback_failed: "Production rollback failed. Replying here does nothing.",
  delivery_evidence_failed: "Delivery proof failed its integrity check. Replying here does nothing.",
};

function isSafeAutonomyRepoId(id: string): boolean {
  return /^[A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9._-]{1,100})?$/.test(id)
    && id.split("/").every(segment => segment !== "." && segment !== "..")
    && redactBridge(id) === id;
}

export function buildAutonomyWebhookNotice(payload: AutonomyNotificationPayload) {
  const parsed = AutonomyNotificationPayload.safeParse(payload);
  if (!parsed.success) throw new Error("autonomy_notice_invalid");
  const { notification_id, kind, autonomy_run_id, repo_id, run_state, status_command } = parsed.data;
  if (!isSafeAutonomyRepoId(repo_id) || ![autonomy_run_id, run_state].every(isSafeExternalNoticeId)
      || status_command[3] !== autonomy_run_id) throw new Error("autonomy_notice_invalid");
  const notice = {
    schema_version: 1, kind: "autonomy_notice", notification_id, reason_code: kind, text: noticeText[kind],
    autonomy_run_id, repo_id, run_state, status_command: status_command.join(" "),
  } as const;
  if (Buffer.byteLength(JSON.stringify(notice)) > 16 * 1024) throw new Error("autonomy_notice_invalid");
  return notice;
}

export function webhookAutonomySender(
  config: AttentionWebhookConfig,
  deps: { send?: typeof fetch; timeoutMs?: number } = {},
): AutonomyNotificationSender {
  return {
    async send({ payload }, signal) {
      if (signal.aborted) throw new Error("aborted");
      const notice = buildAutonomyWebhookNotice(payload);
      const headers: Record<string, string> = {
        "Content-Type": "application/json", "Idempotency-Key": notice.notification_id,
      };
      if (config.key !== null) headers["Authorization"] = `Bearer ${config.key}`;
      const timeout = AbortSignal.timeout(deps.timeoutMs ?? 4000);
      let response: Response;
      try {
        response = await (deps.send ?? fetch)(config.url, {
          method: "POST", headers, body: JSON.stringify(notice), redirect: "error",
          signal: AbortSignal.any([signal, timeout]),
        });
      } catch {
        if (signal.aborted) throw new Error("aborted");
        throw new Error(timeout.aborted ? "autonomy_webhook_timeout" : "autonomy_webhook_unreachable");
      }
      const status = response.status;
      void response.body?.cancel().catch(() => {});
      if (status < 200 || status >= 300) throw new NotificationInvalidResponseError(`autonomy_webhook_http_${status}`);
    },
  };
}

export function localAutonomySender(home: string): AutonomyNotificationSender {
  return {
    async send({ payload }, signal) {
      if (signal.aborted) throw new Error("aborted");
      const notice = buildAutonomyWebhookNotice(payload);
      await writeLocalNotice(home, notice.notification_id, notice, signal);
    },
  };
}

export function selectAutonomyNotificationSender(env: NodeJS.ProcessEnv, home: string): AutonomyNotificationSender | undefined {
  if (env["OSSTACK_ATTENTION_NOTIFY"] === "local") return localAutonomySender(home);
  if (env["OSSTACK_ATTENTION_NOTIFY"] === "webhook") return webhookAutonomySender(parseAttentionWebhookConfig(env));
  return undefined;
}

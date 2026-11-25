import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAutonomyRun, createScratchDirSync, enqueueAutonomyNotification, getNotification, openDb,
  type AutonomyNotificationPayload,
} from "@osstack/core";
import { afterEach, expect, it, vi } from "vitest";
import { drainAutonomyNotifications, NotificationInvalidResponseError } from "./autonomy-notification.js";
import { buildAutonomyWebhookNotice, localAutonomySender, selectAutonomyNotificationSender, webhookAutonomySender } from "./autonomy-notice-delivery.js";

const config = { url: new URL("https://example.invalid/private-hook"), key: "private-key" };
const signal = new AbortController().signal;
const payload: AutonomyNotificationPayload = {
  schema_version: 1, notification_id: "an_" + "a".repeat(32), kind: "escalated",
  autonomy_run_id: "run_1", repo_id: "repo", run_state: "escalated", summary: "Guarded autonomy run escalated",
  status_command: ["osstack", "autonomy", "status", "run_1", "--json"],
};
const message = { notification_id: payload.notification_id, idempotency_key: payload.notification_id, payload };
const texts = {
  awaiting_approval: "Approval needs a signature on the owner's own machine.",
  escalated: "The guarded autonomy run escalated.",
  deploy_frozen: "Production deployment is frozen.",
  rollback_failed: "Production rollback failed.",
  delivery_evidence_failed: "Delivery proof failed its integrity check.",
} as const;
let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

it("selects only configured transports and validates webhook settings", () => {
  for (const env of [{}, { OSSTACK_ATTENTION_NOTIFY: "other" }])
    expect(selectAutonomyNotificationSender(env, ".")).toBeUndefined();
  const env = { OSSTACK_ATTENTION_NOTIFY: "webhook", OSSTACK_ATTENTION_WEBHOOK_URL: config.url.href };
  for (const mode of ["local", "webhook"])
    expect(selectAutonomyNotificationSender({ ...env, OSSTACK_ATTENTION_NOTIFY: mode }, ".")?.send).toBeTypeOf("function");
  expect(() => selectAutonomyNotificationSender({ ...env, OSSTACK_ATTENTION_WEBHOOK_URL: "bad" }, ".")).toThrow("attention_webhook_url_invalid");
  expect(() => selectAutonomyNotificationSender({ ...env, OSSTACK_ATTENTION_WEBHOOK_KEY: "bad key" }, ".")).toThrow("attention_webhook_key_invalid");
});

it.each(Object.keys(texts) as (keyof typeof texts)[])("posts the %s notice", async kind => {
  const cancel = vi.fn();
  const send = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel })));
  const key = kind === "escalated" ? null : config.key;
  await webhookAutonomySender({ ...config, key }, { send }).send({ ...message, payload: { ...payload, kind } }, signal);
  expect(send).toHaveBeenCalledTimes(1);
  const [url, init] = send.mock.calls[0]!;
  expect(url).toEqual(config.url);
  expect(init).toMatchObject({ method: "POST", redirect: "error" });
  expect(init?.headers).toEqual({
    "Content-Type": "application/json", "Idempotency-Key": payload.notification_id,
    ...(key && { Authorization: "Bearer " + key }),
  });
  expect(JSON.parse(String(init?.body))).toEqual({
    schema_version: 1, kind: "autonomy_notice", notification_id: payload.notification_id,
    reason_code: kind, text: texts[kind] + " Replying here does nothing.", autonomy_run_id: "run_1",
    repo_id: "repo", run_state: "escalated", status_command: "osstack autonomy status run_1 --json",
  });
  expect(Buffer.byteLength(String(init?.body))).toBeLessThanOrEqual(16384);
  expect(cancel).toHaveBeenCalledOnce();
});

it("keeps maximum-length multibyte references within the wire limit", () => {
  const ref = "界".repeat(256);
  const notice = buildAutonomyWebhookNotice({
    ...payload, autonomy_run_id: ref, repo_id: "o".repeat(100) + "/" + "r".repeat(100), run_state: ref,
    status_command: ["osstack", "autonomy", "status", ref, "--json"],
  });
  expect(Buffer.byteLength(JSON.stringify(notice))).toBeLessThanOrEqual(16 * 1024);
});

it("refuses malformed payloads and unsafe references before sending", async () => {
  const send = vi.fn<typeof fetch>();
  const sender = webhookAutonomySender(config, { send });
  for (const field of ["autonomy_run_id", "run_state"]) {
    for (const bad of ["", "x".repeat(257), "a/b", "a\\b", "a\u0001b", "a\u200db", "ghp_" + "a".repeat(36)]) {
      await expect(sender.send({ ...message, payload: { ...payload, [field]: bad } }, signal)).rejects.toThrow("autonomy_notice_invalid");
    }
  }
  const command: AutonomyNotificationPayload["status_command"] = ["osstack", "autonomy", "status", "another/run", "--json"];
  for (const invalid of [{ ...payload, status_command: command }, { ...payload, extra: true }])
    await expect(sender.send({ ...message, payload: invalid }, signal)).rejects.toThrow("autonomy_notice_invalid");
  expect(send).not.toHaveBeenCalled();
});

it.each(["owner/repo", "owner.name/repo-1_x", "local"])("preserves repo id %s in webhook and spool delivery", async repo_id => {
  directory = createScratchDirSync("tests", "autonomy-repo-id");
  const notice = { ...message, payload: { ...payload, repo_id } };
  const send = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  await webhookAutonomySender(config, { send }).send(notice, signal);
  expect(JSON.parse(String(send.mock.calls[0]![1]?.body)).repo_id).toBe(repo_id);
  await localAutonomySender(directory).send(notice, signal);
  const name = createHash("sha256").update(payload.notification_id).digest("hex") + ".json";
  expect(JSON.parse(await readFile(join(directory, "attention-notifications", name), "utf8")).repo_id).toBe(repo_id);
});

it.each([
  "a/b/c", "/abs", "a/", ".", "..", "../x", "a/..", "a/.", "owner\\repo", "https://host/x",
  "owner/re po", "owner/repo\n", "owner/ghp_" + "a".repeat(36), "a".repeat(300),
  "a".repeat(101) + "/b", "a/" + "b".repeat(101),
])("refuses unsafe repo id %j before sending", async repo_id => {
  const send = vi.fn<typeof fetch>();
  const sender = webhookAutonomySender(config, { send });
  await expect(sender.send({ ...message, payload: { ...payload, repo_id } }, signal)).rejects.toThrow("autonomy_notice_invalid");
  expect(send).not.toHaveBeenCalled();
});

it("discards sensitive errors and abort reasons", async () => {
  const secret = config.url.href + config.key;
  const send = vi.fn<typeof fetch>(async () => { throw new Error(secret); });
  const sender = webhookAutonomySender(config, { send });
  await expect(sender.send(message, AbortSignal.abort(secret))).rejects.toThrow(/^aborted$/);
  expect(send).not.toHaveBeenCalled();
  await expect(sender.send(message, signal)).rejects.toThrow(/^autonomy_webhook_unreachable$/);
  const refused = webhookAutonomySender(config, { send: async () => new Response(secret, { status: 403 }) });
  const result = refused.send(message, signal);
  await expect(result).rejects.toBeInstanceOf(NotificationInvalidResponseError);
  await expect(result).rejects.toThrow(/^autonomy_webhook_http_403$/);
});

it("writes a private idempotent local receipt and preserves collisions", async () => {
  directory = createScratchDirSync("tests", "autonomy-spool");
  const sender = localAutonomySender(directory);
  await Promise.all([sender.send(message, signal), sender.send(message, signal)]);
  const dir = join(directory, "attention-notifications");
  const name = createHash("sha256").update(payload.notification_id).digest("hex") + ".json";
  const file = join(dir, name);
  expect(await readdir(dir)).toEqual([name]);
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...buildAutonomyWebhookNotice(payload), transport: "local_spool" });
  await writeFile(file, "existing");
  await expect(sender.send(message, signal)).rejects.toThrow("delivery_collision");
  expect(await readFile(file, "utf8")).toBe("existing");
  expect(await readdir(dir)).toEqual([name]);
});

it("delivers approvals and persists webhook timeout, backoff and dead letter", async () => {
  directory = createScratchDirSync("tests", "autonomy-webhook");
  const db_path = join(directory, "state.db");
  const db = openDb({ path: db_path, minFreeBytes: 0 });
  try {
    createAutonomyRun(db, db_path, {
      autonomy_run_id: "run_1", transition_id: "queued", task_id: "task", repo_id: "owner/repo",
      workspace_path: directory, contract_sha256: "a".repeat(64), budget: {}, attempt: {}, event: { kind: "queued" }, occurred_at: 1,
    });
    const enqueue = (kind: keyof typeof texts) => enqueueAutonomyNotification(db, db_path, {
      kind, autonomy_run_id: "run_1", repo_id: "owner/repo", run_state: kind, source_transition_id: kind, occurred_at: 1,
    }).notification_id;
    const approval = enqueue("awaiting_approval");
    const send = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    await drainAutonomyNotifications({ db, db_path, sender: webhookAutonomySender(config, { send }) });
    expect(JSON.parse(String(send.mock.calls[0]![1]?.body))).toMatchObject({ reason_code: "awaiting_approval", repo_id: "owner/repo" });
    expect(getNotification(db, approval)?.status).toBe("delivered");
    const failed = enqueue("escalated");
    const sender = webhookAutonomySender(config, { timeoutMs: 5, send: async (_url, init) =>
      new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error(config.key)))) });
    let now = 1;
    for (let attempt = 1; attempt <= 5; attempt++) {
      await drainAutonomyNotifications({ db, db_path, sender, now: () => now });
      const row = getNotification(db, failed)!;
      expect(row).toMatchObject({ attempt_count: attempt, status: attempt === 5 ? "dead_letter" : "pending", last_error_code: "transport_error" });
      expect(row.next_attempt_at).toBe(now + 30 * 2 ** (attempt - 1));
      expect((await drainAutonomyNotifications({ db, db_path, sender, now: () => now })).selected).toBe(0);
      now = row.next_attempt_at;
    }
  } finally { db.close(); }
});

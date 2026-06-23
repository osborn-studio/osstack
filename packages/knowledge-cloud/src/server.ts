import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import {
  loadKnowledgePack,
  loadKnowledgePackIndex,
  searchKnowledgePacks,
  validateKnowledgePackManifest,
  validateKnowledgePublishGate,
  type KnowledgeFeedbackEntry,
  type KnowledgePack,
  type KnowledgePackManifest,
  type KnowledgePackSummary,
  type KnowledgeSearchResult,
} from "@osstack/knowledge";

export interface KnowledgeCloudOptions {
  packs: KnowledgePack[];
  privatePacks?: KnowledgePack[];
  privateAuthToken?: string;
  privateTenantTokens?: Record<string, string>;
  publishedPackDir?: string;
  feedbackLog?: KnowledgeFeedbackEntry[];
  auditLog?: KnowledgeCloudAuditEntry[];
  now?: () => string;
  feedbackSink?: (entry: KnowledgeFeedbackEntry) => void | Promise<void>;
  auditSink?: (entry: KnowledgeCloudAuditEntry) => void | Promise<void>;
}

export interface KnowledgeCloudServerOptions extends KnowledgeCloudOptions {
  host?: string;
  port?: number;
}

export interface KnowledgeCloudServerHandle {
  url: string;
  server: Server;
  close: () => Promise<void>;
}

export interface KnowledgeCloudSearchResponse {
  packs: KnowledgePackSummary[];
  results: KnowledgeSearchResult[];
}

export interface KnowledgeCloudAuditEntry {
  event_id: string;
  action: "publish" | "private_packs" | "search" | "feedback";
  status: "ok" | "rejected" | "unauthorized";
  created_at: string;
  tenant_id?: string;
  private?: boolean;
  pack_id?: string;
  chunk_id?: string;
  rating?: "useful" | "bad";
  authorized?: boolean;
  result_count?: number;
  issue_codes?: string[];
}

type KnowledgeCloudAuditAction = KnowledgeCloudAuditEntry["action"];
type KnowledgeCloudAuditStatus = KnowledgeCloudAuditEntry["status"];
type KnowledgeCloudReviewQueueStatus = "needs_review" | "all" | "approved" | "changes_requested" | "missing";
const MAX_JSON_BODY_BYTES = 1024 * 1024;

export interface PublishedKnowledgeCloudPacks {
  packs: KnowledgePack[];
  privatePacks: KnowledgePack[];
}

export function createKnowledgeCloudHandler(options: KnowledgeCloudOptions) {
  const feedbackLog: KnowledgeFeedbackEntry[] = [...(options.feedbackLog ?? [])];
  const auditLog: KnowledgeCloudAuditEntry[] = [...(options.auditLog ?? [])];
  const packs: KnowledgePack[] = [...options.packs];
  const privatePacks: KnowledgePack[] = [...(options.privatePacks ?? [])];
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await routeKnowledgeCloudRequest({ ...options, packs, privatePacks, feedbackLog, auditLog }, req, res);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      if (error instanceof BadRequestError) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}

export async function startKnowledgeCloudServer(
  options: KnowledgeCloudServerOptions,
): Promise<KnowledgeCloudServerHandle> {
  const server = createServer(createKnowledgeCloudHandler(options));
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo | null;
  const resolvedHost = address?.address === "::" ? "127.0.0.1" : (address?.address ?? host);
  const resolvedPort = address?.port ?? port;
  return {
    url: `http://${resolvedHost}:${resolvedPort}`,
    server,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error !== undefined) rejectClose(error);
        else resolveClose();
      });
    }),
  };
}

export async function loadKnowledgeCloudPacksFromIndex(indexPath: string): Promise<KnowledgePack[]> {
  const index = await loadKnowledgePackIndex(indexPath);
  const indexDir = dirname(indexPath);
  return Promise.all(index.packs.map((pack) => loadKnowledgePack(join(indexDir, pack.path))));
}

export async function loadPublishedKnowledgeCloudPacksFromDir(root: string): Promise<PublishedKnowledgeCloudPacks> {
  const packs = await loadPublishedPacksFromDir(join(root, "official"));
  const privatePacks: KnowledgePack[] = [];
  for (const tenantId of await tenantDirs(join(root, "private"))) {
    if (!isSafeTenantId(tenantId)) throw new Error("persisted private tenant directory is invalid");
    privatePacks.push(...await loadPublishedPacksFromDir(join(root, "private", tenantId), tenantId));
  }
  return { packs, privatePacks };
}

async function routeKnowledgeCloudRequest(
  options: KnowledgeCloudOptions & {
    privatePacks: KnowledgePack[];
    feedbackLog: KnowledgeFeedbackEntry[];
    auditLog: KnowledgeCloudAuditEntry[];
  },
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://knowledge.osstack.local");
  if (method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, {
      ok: true,
      service: "osstack-knowledge-cloud",
      packs: options.packs.length,
      private_packs: options.privatePacks?.length ?? 0,
    });
    return;
  }
  if (method === "GET" && url.pathname === "/v1/packs") {
    sendJson(res, 200, {
      packs: options.packs.map((pack) => packSummary(pack.manifest)),
    });
    return;
  }
  if (method === "GET" && (url.pathname === "/review" || url.pathname === "/review/queue")) {
    const status = reviewQueueStatusParam(url.searchParams.get("status"));
    const items = reviewQueueItems(options.packs, status);
    sendHtml(res, 200, renderReviewQueueHtml({
      scope: "official",
      status,
      total: items.length,
      items,
    }));
    return;
  }
  if (method === "POST" && url.pathname === "/v1/sync") {
    await readJsonBody(req);
    sendJson(res, 200, {
      packs: options.packs.map((pack) => pack.manifest),
    });
    return;
  }
  if (method === "POST" && url.pathname === "/v1/private-packs") {
    const body = await readJsonBody(req);
    const tenantId = tenantIdField(body);
    if (tenantId === undefined) {
      sendJson(res, 400, { error: "private knowledge packs require tenant_id" });
      return;
    }
    if (!isAuthorizedPrivateRequest(options, req, tenantId)) {
      await recordAudit(options, {
        action: "private_packs",
        status: "unauthorized",
        tenant_id: tenantId,
        authorized: false,
        private: true,
      });
      sendJson(res, 401, { error: "private knowledge packs require authorization" });
      return;
    }
    await recordAudit(options, {
      action: "private_packs",
      status: "ok",
      tenant_id: tenantId,
      authorized: true,
      private: true,
      result_count: tenantPrivatePacks(options, tenantId).length,
    });
    sendJson(res, 200, {
      packs: tenantPrivatePacks(options, tenantId).map((pack) => pack.manifest),
    });
    return;
  }
  if (method === "POST" && url.pathname === "/v1/publish") {
    const body = await readJsonBody(req);
    let manifest: KnowledgePackManifest;
    try {
      manifest = validateKnowledgePackManifest(packField(body));
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const gate = validateKnowledgePublishGate(manifest);
    if (!gate.ok) {
      await recordAudit(options, {
        action: "publish",
        status: "rejected",
        private: isPrivateKnowledgePack(manifest),
        ...(manifest.tenant_id === undefined ? {} : { tenant_id: manifest.tenant_id }),
        pack_id: manifest.id,
        issue_codes: gate.issues.map((issue) => issue.code),
      });
      sendJson(res, 400, { ok: false, issues: gate.issues });
      return;
    }
    const pack: KnowledgePack = {
      manifest,
      path: `cloud://${manifest.id}@${manifest.version}`,
    };
    const privatePack = isPrivateKnowledgePack(manifest);
    if (privatePack) {
      const tenantId = manifestTenantId(manifest);
      if (tenantId === undefined || tenantId.trim().length === 0) {
        await recordAudit(options, {
          action: "publish",
          status: "rejected",
          private: true,
          pack_id: manifest.id,
          issue_codes: ["private_publish_missing_tenant_id"],
        });
        sendJson(res, 400, { error: "private knowledge publish requires tenant_id" });
        return;
      }
      if (!isAuthorizedPrivateRequest(options, req, tenantId)) {
        await recordAudit(options, {
          action: "publish",
          status: "unauthorized",
          private: true,
          tenant_id: tenantId,
          pack_id: manifest.id,
          authorized: false,
        });
        sendJson(res, 401, { error: "private knowledge publish requires authorization" });
        return;
      }
      await persistPublishedPack(options.publishedPackDir, pack, tenantId);
      upsertPack(options.privatePacks, pack);
      await recordAudit(options, {
        action: "publish",
        status: "ok",
        private: true,
        tenant_id: tenantId,
        pack_id: manifest.id,
        authorized: true,
      });
      sendJson(res, 200, {
        ok: true,
        private: true,
        tenant_id: tenantId,
        pack: packSummary(manifest),
      });
      return;
    }
    await persistPublishedPack(options.publishedPackDir, pack);
    upsertPack(options.packs, pack);
    await recordAudit(options, {
      action: "publish",
      status: "ok",
      private: false,
      pack_id: manifest.id,
    });
    sendJson(res, 200, {
      ok: true,
      private: false,
      pack: packSummary(manifest),
    });
    return;
  }
  if (method === "POST" && url.pathname === "/v1/search") {
    const body = await readJsonBody(req);
    const query = stringField(body, "query");
    if (query === undefined || query.trim().length === 0) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }
    const limit = searchLimitField(body);
    const tenantId = tenantIdField(body);
    const authorized = tenantId === undefined ? undefined : isAuthorizedPrivateRequest(options, req, tenantId);
    const packs = [
      ...options.packs,
      ...(tenantId !== undefined && authorized === true
        ? tenantPrivatePacks(options, tenantId)
        : []),
    ];
    const results = searchKnowledgePacks(packs, query, { limit });
    await recordAudit(options, {
      action: "search",
      status: "ok",
      ...(tenantId === undefined ? {} : { tenant_id: tenantId }),
      ...(authorized === undefined ? {} : { authorized }),
      private: tenantId !== undefined,
      result_count: results.length,
    });
    sendJson(res, 200, {
      packs: packs.map((pack) => packSummary(pack.manifest)),
      results,
    } satisfies KnowledgeCloudSearchResponse);
    return;
  }
  if (method === "POST" && url.pathname === "/v1/feedback") {
    const body = await readJsonBody(req);
    const chunkId = stringField(body, "chunk_id");
    const rating = stringField(body, "rating");
    const tenantId = tenantIdField(body);
    if (chunkId === undefined || (rating !== "useful" && rating !== "bad")) {
      sendJson(res, 400, { error: "chunk_id and rating are required" });
      return;
    }
    const authorized = tenantId === undefined
      ? isAuthorizedPrivateRequest(options, req)
      : isAuthorizedPrivateRequest(options, req, tenantId);
    if (tenantId !== undefined && !authorized) {
      await recordAudit(options, {
        action: "feedback",
        status: "unauthorized",
        chunk_id: chunkId,
        rating,
        tenant_id: tenantId,
        authorized: false,
        private: true,
      });
      sendJson(res, 401, { error: "tenant feedback requires authorization" });
      return;
    }
    const entry: KnowledgeFeedbackEntry = {
      chunk_id: chunkId,
      rating,
      status: "sent",
      created_at: options.now?.() ?? new Date().toISOString(),
      ...(tenantId === undefined ? {} : { tenant_id: tenantId }),
      authorized,
    };
    options.feedbackLog.push(entry);
    await options.feedbackSink?.(entry);
    await recordAudit(options, {
      action: "feedback",
      status: "ok",
      chunk_id: chunkId,
      rating,
      ...(tenantId === undefined ? {} : { tenant_id: tenantId }),
      ...(entry.authorized === undefined ? {} : { authorized: entry.authorized }),
      private: tenantId !== undefined,
    });
    sendJson(res, 200, { ok: true, feedback: entry });
    return;
  }
  if (method === "POST" && url.pathname === "/v1/feedback/summary") {
    const body = await readJsonBody(req);
    const tenantId = tenantIdField(body);
    if (tenantId !== undefined && !isAuthorizedPrivateRequest(options, req, tenantId)) {
      sendJson(res, 401, { error: "tenant feedback summary requires authorization" });
      return;
    }
    sendJson(res, 200, summarizeFeedback(options.feedbackLog, tenantId));
    return;
  }
  if (method === "POST" && url.pathname === "/v1/review/queue") {
    const body = await readJsonBody(req);
    const tenantId = tenantIdField(body);
    if (tenantId !== undefined && !isAuthorizedPrivateRequest(options, req, tenantId)) {
      sendJson(res, 401, { error: "tenant review queue requires authorization" });
      return;
    }
    const status = reviewQueueStatusField(body);
    const packs = tenantId === undefined ? options.packs : tenantPrivatePacks(options, tenantId);
    const items = reviewQueueItems(packs, status);
    sendJson(res, 200, {
      scope: tenantId === undefined ? "official" : "tenant",
      ...(tenantId === undefined ? {} : { tenant_id: tenantId }),
      status_filter: status,
      total: items.length,
      items,
    });
    return;
  }
  if (method === "POST" && url.pathname === "/v1/audit") {
    const body = await readJsonBody(req);
    const tenantId = tenantIdField(body);
    if (tenantId !== undefined && !isAuthorizedPrivateRequest(options, req, tenantId)) {
      sendJson(res, 401, { error: "tenant audit log requires authorization" });
      return;
    }
    const action = auditActionField(body);
    const status = auditStatusField(body);
    const limit = auditLimitField(body);
    const filteredEvents = (tenantId === undefined
      ? options.auditLog.filter((entry) => entry.tenant_id === undefined)
      : options.auditLog.filter((entry) => entry.tenant_id === tenantId))
      .filter((entry) => action === undefined || entry.action === action)
      .filter((entry) => status === undefined || entry.status === status);
    const events = limit === undefined ? filteredEvents : filteredEvents.slice(0, limit);
    sendJson(res, 200, {
      ...(tenantId === undefined ? {} : { tenant_id: tenantId }),
      filters: {
        ...(action === undefined ? {} : { action }),
        ...(status === undefined ? {} : { status }),
        ...(limit === undefined ? {} : { limit }),
      },
      events,
    });
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

async function recordAudit(
  options: KnowledgeCloudOptions & { auditLog: KnowledgeCloudAuditEntry[] },
  entry: Omit<KnowledgeCloudAuditEntry, "event_id" | "created_at">,
): Promise<void> {
  const auditEntry: KnowledgeCloudAuditEntry = {
    event_id: `audit-${options.auditLog.length + 1}`,
    created_at: options.now?.() ?? new Date().toISOString(),
    ...entry,
  };
  options.auditLog.push(auditEntry);
  await options.auditSink?.(auditEntry);
}

function summarizeFeedback(entries: KnowledgeFeedbackEntry[], tenantId: string | undefined): {
  total: number;
  useful: number;
  bad: number;
  tenant_id?: string;
  chunks: Array<{ chunk_id: string; total: number; useful: number; bad: number }>;
} {
  const filtered = tenantId === undefined
    ? entries.filter((entry) => entry.tenant_id === undefined)
    : entries.filter((entry) => entry.tenant_id === tenantId);
  const chunks = new Map<string, { chunk_id: string; total: number; useful: number; bad: number }>();
  let useful = 0;
  let bad = 0;
  for (const entry of filtered) {
    if (entry.rating === "useful") useful += 1;
    else bad += 1;
    const current = chunks.get(entry.chunk_id) ?? { chunk_id: entry.chunk_id, total: 0, useful: 0, bad: 0 };
    current.total += 1;
    if (entry.rating === "useful") current.useful += 1;
    else current.bad += 1;
    chunks.set(entry.chunk_id, current);
  }
  return {
    total: filtered.length,
    useful,
    bad,
    ...(tenantId === undefined ? {} : { tenant_id: tenantId }),
    chunks: [...chunks.values()].sort((a, b) => b.total - a.total || a.chunk_id.localeCompare(b.chunk_id)),
  };
}

function reviewQueueItems(packs: KnowledgePack[], status: KnowledgeCloudReviewQueueStatus): Array<{
  pack_id: string;
  version: string;
  name: string;
  scope: string;
  tenant_id?: string;
  source_kind: string;
  quality_score: number;
  review_status: "approved" | "changes_requested" | "missing";
  reviewer_id?: string;
  reviewed_at?: string;
  review_summary?: string;
  chunk_count: number;
  source_count: number;
}> {
  return packs
    .map((pack) => {
      const review = pack.manifest.review;
      const reviewStatus: "approved" | "changes_requested" | "missing" = review?.status ?? "missing";
      return {
        pack_id: pack.manifest.id,
        version: pack.manifest.version,
        name: pack.manifest.name,
        scope: pack.manifest.scope ?? "official",
        ...(pack.manifest.tenant_id === undefined ? {} : { tenant_id: pack.manifest.tenant_id }),
        source_kind: pack.manifest.source_kind,
        quality_score: pack.manifest.quality_score,
        review_status: reviewStatus,
        ...(review?.reviewer_id === undefined ? {} : { reviewer_id: review.reviewer_id }),
        ...(review?.reviewed_at === undefined ? {} : { reviewed_at: review.reviewed_at }),
        ...(review?.summary === undefined ? {} : { review_summary: review.summary }),
        chunk_count: pack.manifest.chunks.length,
        source_count: pack.manifest.source_provenance?.length ?? 0,
      };
    })
    .filter((item) => {
      if (status === "all") return true;
      if (status === "needs_review") return item.review_status !== "approved";
      return item.review_status === status;
    })
    .sort((a, b) => (
      reviewQueuePriority(a.review_status) - reviewQueuePriority(b.review_status)
      || a.pack_id.localeCompare(b.pack_id)
      || a.version.localeCompare(b.version)
    ));
}

function renderReviewQueueHtml(queue: {
  scope: "official";
  status: KnowledgeCloudReviewQueueStatus;
  total: number;
  items: ReturnType<typeof reviewQueueItems>;
}): string {
  const filters: KnowledgeCloudReviewQueueStatus[] = ["needs_review", "missing", "changes_requested", "approved", "all"];
  const rows = queue.items.map((item) => [
    "<tr>",
    `<td><code>${escapeHtml(item.pack_id)}</code><br><small>${escapeHtml(item.name)} @ ${escapeHtml(item.version)}</small></td>`,
    `<td><span class="status status-${escapeHtml(item.review_status)}">${escapeHtml(item.review_status)}</span></td>`,
    `<td>${escapeHtml(String(item.quality_score))}</td>`,
    `<td>${escapeHtml(item.reviewer_id ?? "unassigned")}<br><small>${escapeHtml(item.reviewed_at ?? "not reviewed")}</small></td>`,
    `<td>${escapeHtml(item.review_summary ?? "No review summary recorded.")}</td>`,
    `<td>${escapeHtml(String(item.chunk_count))}</td>`,
    `<td>${escapeHtml(String(item.source_count))}</td>`,
    "</tr>",
  ].join("")).join("\n");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Osstack Knowledge Cloud Review Queue</title>",
    "<style>",
    "body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;background:#f7f8fa;color:#16181d}",
    "main{max-width:1180px;margin:0 auto;padding:32px 20px}",
    "h1{font-size:28px;margin:0 0 6px}",
    "p{margin:0 0 18px;color:#596171}",
    ".filters{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0}",
    ".filters a{border:1px solid #d9dde5;border-radius:6px;color:#222;text-decoration:none;padding:7px 10px;background:white}",
    ".filters a.active{background:#16181d;color:white;border-color:#16181d}",
    "table{width:100%;border-collapse:collapse;background:white;border:1px solid #d9dde5;border-radius:8px;overflow:hidden}",
    "th,td{text-align:left;vertical-align:top;border-bottom:1px solid #edf0f4;padding:10px;font-size:14px}",
    "th{background:#f0f2f5;color:#3a4050;font-size:12px;text-transform:uppercase;letter-spacing:.04em}",
    "tr:last-child td{border-bottom:0}",
    "code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}",
    "small{color:#6b7280}",
    ".status{display:inline-block;border-radius:999px;padding:3px 8px;font-size:12px;font-weight:700}",
    ".status-missing{background:#fff1f2;color:#be123c}",
    ".status-changes_requested{background:#fff7ed;color:#c2410c}",
    ".status-approved{background:#ecfdf5;color:#047857}",
    ".empty{background:white;border:1px solid #d9dde5;border-radius:8px;padding:24px}",
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    "<h1>Osstack Knowledge Cloud Review Queue</h1>",
    `<p>Scope: ${escapeHtml(queue.scope)} · Filter: ${escapeHtml(queue.status)} · Total: ${queue.total}</p>`,
    `<nav class="filters">${filters.map((filter) => `<a class="${filter === queue.status ? "active" : ""}" href="/review?status=${filter}">${escapeHtml(filter)}</a>`).join("")}</nav>`,
    queue.items.length === 0
      ? '<div class="empty">No review queue items match this filter.</div>'
      : [
        "<table>",
        "<thead><tr><th>Pack</th><th>Status</th><th>Quality</th><th>Reviewer</th><th>Summary</th><th>Chunks</th><th>Sources</th></tr></thead>",
        `<tbody>${rows}</tbody>`,
        "</table>",
      ].join(""),
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
}

function reviewQueuePriority(status: "approved" | "changes_requested" | "missing"): number {
  if (status === "missing") return 0;
  if (status === "changes_requested") return 1;
  return 2;
}

function tenantPrivatePacks(options: KnowledgeCloudOptions, tenantId: string): KnowledgePack[] {
  return (options.privatePacks ?? []).filter((pack) => {
    const packTenantId = pack.manifest.tenant_id;
    return tenantId === packTenantId;
  });
}

async function persistPublishedPack(root: string | undefined, pack: KnowledgePack, tenantId?: string): Promise<void> {
  if (root === undefined || root.trim().length === 0) return;
  const dir = tenantId === undefined ? join(root, "official") : join(root, "private", tenantId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, publishedPackFileName(pack.manifest)), `${JSON.stringify(pack.manifest, null, 2)}\n`, "utf-8");
}

async function loadPublishedPacksFromDir(dir: string, tenantId?: string): Promise<KnowledgePack[]> {
  const files = await jsonFiles(dir);
  const packs: KnowledgePack[] = [];
  for (const file of files) {
    const path = join(dir, file);
    const manifest = validateKnowledgePackManifest(JSON.parse(await readFile(path, "utf-8")) as unknown);
    if (tenantId === undefined && isPrivateKnowledgePack(manifest)) {
      throw new Error("official persisted pack cannot be private");
    }
    if (tenantId !== undefined && manifestTenantId(manifest) !== tenantId) {
      throw new Error("tenant_id does not match persisted private directory");
    }
    packs.push({ manifest, path });
  }
  return packs;
}

async function tenantDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function jsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function publishedPackFileName(manifest: KnowledgePackManifest): string {
  return `${encodeURIComponent(manifest.id)}.json`;
}

function upsertPack(packs: KnowledgePack[], pack: KnowledgePack): void {
  const index = packs.findIndex((candidate) => candidate.manifest.id === pack.manifest.id);
  if (index >= 0) packs[index] = pack;
  else packs.push(pack);
}

function packField(body: unknown): unknown {
  const candidate = isRecord(body) && "pack" in body ? body["pack"] : body;
  return isRecord(candidate) && "manifest" in candidate ? candidate["manifest"] : candidate;
}

function tenantIdField(body: unknown): string | undefined {
  const tenantId = stringField(body, "tenant_id");
  if (tenantId === undefined || tenantId.trim().length === 0) return undefined;
  if (!isSafeTenantId(tenantId)) throw new BadRequestError("tenant_id is invalid");
  return tenantId;
}

function manifestTenantId(manifest: KnowledgePackManifest): string | undefined {
  const tenantId = manifest.tenant_id;
  if (tenantId === undefined || tenantId.trim().length === 0) return undefined;
  if (!isSafeTenantId(tenantId)) throw new BadRequestError("tenant_id is invalid");
  return tenantId;
}

function isPrivateKnowledgePack(manifest: KnowledgePackManifest): boolean {
  return manifest.scope === "team" || manifest.scope === "project" || manifest.tenant_id !== undefined;
}

function isSafeTenantId(tenantId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tenantId);
}

function isAuthorizedPrivateRequest(options: KnowledgeCloudOptions, req: IncomingMessage, tenantId?: string): boolean {
  const authorization = req.headers.authorization;
  const tenantToken = tenantId === undefined ? undefined : options.privateTenantTokens?.[tenantId]?.trim();
  if (tenantToken !== undefined && tenantToken.length > 0) return authorization === `Bearer ${tenantToken}`;
  const globalToken = options.privateAuthToken?.trim();
  if (globalToken !== undefined && globalToken.length > 0) return authorization === `Bearer ${globalToken}`;
  if (tenantId !== undefined && Object.keys(options.privateTenantTokens ?? {}).length > 0) return false;
  const tenantTokens = Object.values(options.privateTenantTokens ?? {}).map((token) => token.trim()).filter(Boolean);
  if (tenantTokens.length > 0) return tenantTokens.some((token) => authorization === `Bearer ${token}`);
  return true;
}

function packSummary(manifest: KnowledgePackManifest): KnowledgePackSummary {
  return {
    id: manifest.id,
    version: manifest.version,
    license: manifest.license,
    source_kind: manifest.source_kind,
    quality_score: manifest.quality_score,
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.byteLength;
    if (bytes > MAX_JSON_BODY_BYTES) {
      throw new PayloadTooLargeError("request body too large");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new BadRequestError("invalid JSON body");
  }
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function auditActionField(value: unknown): KnowledgeCloudAuditAction | undefined {
  const action = stringField(value, "action");
  if (action === "publish" || action === "private_packs" || action === "search" || action === "feedback") return action;
  return undefined;
}

function auditStatusField(value: unknown): KnowledgeCloudAuditStatus | undefined {
  const status = stringField(value, "status");
  if (status === "ok" || status === "rejected" || status === "unauthorized") return status;
  return undefined;
}

function auditLimitField(value: unknown): number | undefined {
  const limit = numberField(value, "limit");
  if (limit === undefined) return undefined;
  return Math.max(1, Math.min(100, Math.trunc(limit)));
}

function reviewQueueStatusField(value: unknown): KnowledgeCloudReviewQueueStatus {
  const status = stringField(value, "status");
  return reviewQueueStatusParam(status);
}

function reviewQueueStatusParam(status: string | null | undefined): KnowledgeCloudReviewQueueStatus {
  if (
    status === "all"
    || status === "approved"
    || status === "changes_requested"
    || status === "missing"
    || status === "needs_review"
  ) return status;
  return "needs_review";
}

function searchLimitField(value: unknown): number {
  const limit = numberField(value, "limit");
  if (limit === undefined) return 5;
  return Math.max(1, Math.min(50, Math.trunc(limit)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(`${JSON.stringify(payload)}\n`);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

class BadRequestError extends Error {}

class PayloadTooLargeError extends Error {}

import { officialPacks as officialPackManifests } from "./official-packs.js";

const officialPacks = officialPackManifests.map((manifest) => ({ manifest }));
const publishedOfficialPacks = [];
const publishedPrivatePacks = [];
const KNOWLEDGE_KV_BINDING = "osstack_knowledge_kv";
const OFFICIAL_KV_PREFIX = "osstack_official_pack_";
const PRIVATE_KV_PREFIX = "osstack_private_pack_";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function readJson(request) {
  const raw = await request.text();
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw);
}

function packSummary(manifest) {
  return {
    id: manifest.id,
    version: manifest.version,
    license: manifest.license,
    source_kind: manifest.source_kind,
    quality_score: manifest.quality_score,
  };
}

function envValue(key, env = {}) {
  const edgeValue = env?.[key];
  if (typeof edgeValue === "string" && edgeValue.trim().length > 0) return edgeValue.trim();
  const value = globalThis.process?.env?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function privateTenantTokens(env = {}) {
  const raw = envValue("OSSTACK_KNOWLEDGE_PRIVATE_TENANT_TOKENS_JSON", env);
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, token]) => typeof token === "string" && token.trim().length > 0));
  } catch {
    return {};
  }
}

function authorizationToken(request) {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : undefined;
}

function isSafeTenantId(tenantId) {
  return typeof tenantId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tenantId);
}

function isAuthorizedPrivateRequest(request, tenantId, env = {}) {
  const token = authorizationToken(request);
  if (token === undefined) return false;
  const tenantToken = tenantId === undefined ? undefined : privateTenantTokens(env)[tenantId];
  if (typeof tenantToken === "string" && tenantToken.trim().length > 0) return token === tenantToken.trim();
  const publishToken = envValue("OSSTACK_KNOWLEDGE_PUBLISH_TOKEN", env);
  if (publishToken !== undefined && token === publishToken) return true;
  const globalPrivateToken = envValue("OSSTACK_KNOWLEDGE_PRIVATE_TOKEN", env);
  if (globalPrivateToken !== undefined && token === globalPrivateToken) return true;
  return false;
}

function isPublishConfigured(env = {}) {
  return envValue("OSSTACK_KNOWLEDGE_PUBLISH_TOKEN", env) !== undefined
    || envValue("OSSTACK_KNOWLEDGE_PRIVATE_TOKEN", env) !== undefined
    || Object.keys(privateTenantTokens(env)).length > 0;
}

function validatePublishManifest(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "knowledge pack manifest must be an object" };
  }
  const requiredStrings = ["id", "version", "name", "license", "source_kind"];
  for (const key of requiredStrings) {
    if (typeof value[key] !== "string" || value[key].trim().length === 0) {
      return { ok: false, error: `knowledge pack ${key} is required` };
    }
  }
  if (!["osstack_native", "processed_mit", "curated_external", "internal"].includes(value.source_kind)) {
    return { ok: false, error: "knowledge pack source_kind is invalid" };
  }
  if (typeof value.quality_score !== "number" || value.quality_score < 0 || value.quality_score > 100) {
    return { ok: false, error: "knowledge pack quality_score must be between 0 and 100" };
  }
  if (!Array.isArray(value.chunks)) return { ok: false, error: "knowledge pack chunks must be an array" };
  for (const [index, chunk] of value.chunks.entries()) {
    if (typeof chunk !== "object" || chunk === null || Array.isArray(chunk)) {
      return { ok: false, error: `knowledge chunk at index ${index} must be an object` };
    }
    for (const key of ["chunk_id", "title", "body"]) {
      if (typeof chunk[key] !== "string" || chunk[key].trim().length === 0) {
        return { ok: false, error: `knowledge chunk ${index} ${key} is required` };
      }
    }
  }
  if (value.scope !== undefined && !["official", "team", "project"].includes(value.scope)) {
    return { ok: false, error: "knowledge pack scope is invalid" };
  }
  if (value.tenant_id !== undefined && !isSafeTenantId(value.tenant_id)) {
    return { ok: false, error: "tenant_id is invalid" };
  }
  return { ok: true, manifest: value };
}

function validatePublishGate(manifest) {
  const issues = [];
  const official = manifest.scope === "official";
  const external = manifest.source_kind === "processed_mit" || manifest.source_kind === "curated_external";
  if (official && manifest.source_kind === "internal") issues.push({ code: "official_internal_source_kind" });
  if (official && manifest.quality_score < 80) issues.push({ code: "official_low_quality_score" });
  if (official && (manifest.taxonomy ?? []).length === 0) issues.push({ code: "official_missing_taxonomy" });
  if (official && typeof manifest.last_reviewed_at !== "string") issues.push({ code: "official_missing_review" });
  if (official && manifest.review?.status !== "approved") issues.push({ code: "official_review_not_approved" });
  if ((official || external) && (manifest.source_attribution ?? []).length === 0) issues.push({ code: "missing_source_attribution" });
  if ((official || external) && (manifest.source_provenance ?? []).length === 0) issues.push({ code: "missing_source_provenance" });
  if (official && manifest.chunks.length === 0) issues.push({ code: "official_empty_chunks" });
  return { ok: issues.length === 0, issues };
}

function packField(body) {
  const candidate = typeof body === "object" && body !== null && "pack" in body ? body.pack : body;
  return typeof candidate === "object" && candidate !== null && "manifest" in candidate ? candidate.manifest : candidate;
}

function isPrivateKnowledgePack(manifest) {
  return manifest.scope === "team" || manifest.scope === "project" || manifest.tenant_id !== undefined;
}

function upsertPack(packs, pack) {
  const index = packs.findIndex((candidate) => candidate.manifest.id === pack.manifest.id);
  if (index >= 0) packs[index] = pack;
  else packs.push(pack);
}

function dedupePacks(packs) {
  const byId = new Map();
  for (const pack of packs) byId.set(pack.manifest.id, pack);
  return Array.from(byId.values());
}

function knowledgeKv(env = {}) {
  const candidates = [
    env?.[KNOWLEDGE_KV_BINDING],
    env?.OSSTACK_KNOWLEDGE_KV,
    globalThis[KNOWLEDGE_KV_BINDING],
    globalThis.OSSTACK_KNOWLEDGE_KV,
  ];
  return candidates.find((candidate) => (
    typeof candidate === "object"
    && candidate !== null
    && typeof candidate.put === "function"
    && typeof candidate.get === "function"
    && typeof candidate.list === "function"
  ));
}

function hexSegment(value) {
  return Array.from(new TextEncoder().encode(String(value)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function officialPackKey(manifest) {
  return `${OFFICIAL_KV_PREFIX}${hexSegment(manifest.id)}`;
}

function privatePackKey(manifest) {
  return `${PRIVATE_KV_PREFIX}${hexSegment(manifest.tenant_id)}_${hexSegment(manifest.id)}`;
}

async function kvPutJson(kv, key, value) {
  await kv.put(key, JSON.stringify(value));
}

async function kvGetJson(kv, key) {
  const parsed = await kv.get(key, { type: "json" });
  if (typeof parsed === "object" && parsed !== null) return parsed;
  if (typeof parsed === "string" && parsed.trim().length > 0) return JSON.parse(parsed);
  return undefined;
}

async function kvListKeys(kv, prefix) {
  const keys = [];
  let cursor;
  do {
    const listed = await kv.list({ prefix, limit: 256, ...(cursor === undefined || cursor === "" ? {} : { cursor }) });
    const pageKeys = Array.isArray(listed?.keys) ? listed.keys : [];
    for (const key of pageKeys) {
      if (typeof key === "string") keys.push(key);
      else if (typeof key?.name === "string") keys.push(key.name);
      else if (typeof key?.key === "string") keys.push(key.key);
    }
    cursor = typeof listed?.cursor === "string" && listed.cursor.length > 0 ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return keys;
}

async function kvPacksByPrefix(kv, prefix) {
  if (kv === undefined) return [];
  try {
    const packs = [];
    for (const key of await kvListKeys(kv, prefix)) {
      const manifest = await kvGetJson(kv, key);
      const validation = validatePublishManifest(manifest);
      if (validation.ok) packs.push({ manifest: validation.manifest });
    }
    return packs;
  } catch {
    return [];
  }
}

async function publicPacks(kv) {
  return dedupePacks([
    ...officialPacks,
    ...publishedOfficialPacks,
    ...await kvPacksByPrefix(kv, OFFICIAL_KV_PREFIX),
  ]);
}

async function allPrivatePacks(kv) {
  return dedupePacks([
    ...publishedPrivatePacks,
    ...await kvPacksByPrefix(kv, PRIVATE_KV_PREFIX),
  ]);
}

async function tenantPrivatePacks(tenantId, kv) {
  const privatePacks = await allPrivatePacks(kv);
  return privatePacks.filter((pack) => pack.manifest.tenant_id === tenantId);
}

async function persistPublishedPack(kv, manifest, privatePack) {
  if (kv === undefined) return "edgeone-function-memory";
  await kvPutJson(kv, privatePack ? privatePackKey(manifest) : officialPackKey(manifest), manifest);
  return "edgeone-kv";
}

function reviewStatus(manifest) {
  return manifest.review?.status ?? "missing";
}

function reviewQueueStatusParam(status) {
  if (
    status === "all"
    || status === "approved"
    || status === "changes_requested"
    || status === "missing"
    || status === "needs_review"
  ) return status;
  return "needs_review";
}

function reviewQueueItems(packs, status) {
  return packs
    .map((pack) => {
      const manifest = pack.manifest;
      const status = reviewStatus(manifest);
      return {
        pack_id: manifest.id,
        version: manifest.version,
        name: manifest.name,
        quality_score: manifest.quality_score,
        review_status: status,
        reviewer_id: manifest.review?.reviewer_id,
        reviewed_at: manifest.review?.reviewed_at,
        review_summary: manifest.review?.summary,
        chunk_count: manifest.chunks?.length ?? 0,
        source_count: manifest.source_provenance?.length ?? 0,
      };
    })
    .filter((item) => {
      if (status === "all") return true;
      if (status === "needs_review") return item.review_status !== "approved";
      return item.review_status === status;
    })
    .sort((a, b) => (
      reviewPriority(a.review_status) - reviewPriority(b.review_status)
      || a.pack_id.localeCompare(b.pack_id)
      || a.version.localeCompare(b.version)
    ));
}

function reviewPriority(status) {
  if (status === "missing") return 0;
  if (status === "changes_requested") return 1;
  return 2;
}

function renderReviewQueueHtml(queue) {
  const filters = ["needs_review", "missing", "changes_requested", "approved", "all"];
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
    `<p>Scope: official · Filter: ${escapeHtml(queue.status)} · Total: ${queue.items.length}</p>`,
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function searchPacks(packs, query, limit) {
  const terms = query.toLowerCase().split(/[^a-z0-9_/-]+/).filter(Boolean);
  const results = [];
  for (const pack of packs) {
    for (const chunk of pack.manifest.chunks ?? []) {
      const haystack = `${chunk.title} ${chunk.body} ${(chunk.tags ?? []).join(" ")}`.toLowerCase();
      const matchedTerms = terms.filter((term) => haystack.includes(term));
      if (matchedTerms.length === 0) continue;
      results.push({
        pack_id: pack.manifest.id,
        pack_version: pack.manifest.version,
        chunk_id: chunk.chunk_id,
        title: chunk.title,
        snippet: chunk.body.slice(0, 260),
        score: Number((matchedTerms.length / Math.max(1, terms.length)).toFixed(4)),
        matched_terms: matchedTerms,
      });
    }
  }
  return results
    .sort((a, b) => b.score - a.score || a.pack_id.localeCompare(b.pack_id) || a.chunk_id.localeCompare(b.chunk_id))
    .slice(0, limit);
}

export default async function onRequest({ request, env = {} }) {
  const url = new URL(request.url);
  const kv = knowledgeKv(env);
  const packs = await publicPacks(kv);

  if (request.method === "GET" && url.pathname === "/healthz") {
    const privatePacks = await allPrivatePacks(kv);
    return json({
      ok: true,
      service: "osstack-knowledge-cloud",
      runtime: "edgeone-cloud-functions",
      packs: packs.length,
      private_packs: privatePacks.length,
      publish_storage: kv === undefined ? "edgeone-function-memory" : "edgeone-kv",
      kv_binding: kv === undefined ? "missing" : KNOWLEDGE_KV_BINDING,
    });
  }

  if (request.method === "GET" && url.pathname === "/v1/packs") {
    return json({ packs: packs.map((pack) => packSummary(pack.manifest)) });
  }

  if (request.method === "GET" && (url.pathname === "/review" || url.pathname === "/review/queue")) {
    const status = reviewQueueStatusParam(url.searchParams.get("status"));
    return html(renderReviewQueueHtml({
      status,
      items: reviewQueueItems(packs, status),
    }));
  }

  if (request.method === "POST" && url.pathname === "/v1/sync") {
    await readJson(request);
    return json({ packs: packs.map((pack) => pack.manifest) });
  }

  if (request.method === "POST" && url.pathname === "/v1/search") {
    const body = await readJson(request);
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (query.length === 0) return json({ error: "query is required" }, 400);
    const limit = Number.isFinite(body.limit) ? Math.max(1, Math.min(50, Math.trunc(body.limit))) : 5;
    const tenantId = typeof body.tenant_id === "string" ? body.tenant_id : undefined;
    if (tenantId !== undefined && !isSafeTenantId(tenantId)) return json({ error: "tenant_id is invalid" }, 400);
    const visiblePacks = tenantId !== undefined && isAuthorizedPrivateRequest(request, tenantId, env)
      ? dedupePacks([...packs, ...await tenantPrivatePacks(tenantId, kv)])
      : packs;
    return json({
      packs: visiblePacks.map((pack) => packSummary(pack.manifest)),
      results: searchPacks(visiblePacks, query, limit),
    });
  }

  if (request.method === "POST" && url.pathname === "/v1/private-packs") {
    const body = await readJson(request);
    const tenantId = typeof body.tenant_id === "string" ? body.tenant_id : undefined;
    if (!isSafeTenantId(tenantId)) return json({ error: "private knowledge packs require tenant_id" }, 400);
    if (!isAuthorizedPrivateRequest(request, tenantId, env)) return json({ error: "private knowledge packs require authorization" }, 401);
    return json({ packs: (await tenantPrivatePacks(tenantId, kv)).map((pack) => pack.manifest) });
  }

  if (request.method === "POST" && url.pathname === "/v1/publish") {
    if (!isPublishConfigured(env)) return json({ error: "knowledge publish is not configured" }, 503);
    const body = await readJson(request);
    const validation = validatePublishManifest(packField(body));
    if (!validation.ok) return json({ error: validation.error }, 400);
    const manifest = validation.manifest;
    const gate = validatePublishGate(manifest);
    if (!gate.ok) return json({ ok: false, issues: gate.issues }, 400);
    const privatePack = isPrivateKnowledgePack(manifest);
    if (privatePack) {
      if (!isSafeTenantId(manifest.tenant_id)) return json({ error: "private knowledge publish requires tenant_id" }, 400);
      if (!isAuthorizedPrivateRequest(request, manifest.tenant_id, env)) return json({ error: "private knowledge publish requires authorization" }, 401);
      const persistence = await persistPublishedPack(kv, manifest, true);
      upsertPack(publishedPrivatePacks, { manifest });
      return json({
        ok: true,
        private: true,
        tenant_id: manifest.tenant_id,
        pack: packSummary(manifest),
        persistence,
      });
    }
    if (!isAuthorizedPrivateRequest(request, undefined, env)) return json({ error: "official knowledge publish requires authorization" }, 401);
    const persistence = await persistPublishedPack(kv, manifest, false);
    upsertPack(publishedOfficialPacks, { manifest });
    return json({
      ok: true,
      private: false,
      pack: packSummary(manifest),
      persistence,
    });
  }

  if (request.method === "POST" && url.pathname === "/v1/audit") {
    await readJson(request);
    return json({ filters: {}, events: [] });
  }

  if (request.method === "POST" && url.pathname === "/v1/feedback") {
    const body = await readJson(request);
    const chunkId = typeof body.chunk_id === "string" ? body.chunk_id : undefined;
    const rating = body.rating === "useful" || body.rating === "bad" ? body.rating : undefined;
    if (chunkId === undefined || rating === undefined) {
      return json({ error: "chunk_id and rating are required" }, 400);
    }
    return json({
      ok: true,
      feedback: {
        chunk_id: chunkId,
        rating,
        status: "sent",
        created_at: new Date().toISOString(),
      },
    });
  }

  if (request.method === "POST" && url.pathname === "/v1/feedback/summary") {
    await readJson(request);
    return json({ total: 0, useful: 0, bad: 0, chunks: [] });
  }

  return json({ error: "not found" }, 404);
}

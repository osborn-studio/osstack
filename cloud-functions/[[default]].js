import { officialPacks as officialPackManifests } from "./official-packs.js";

const officialPacks = officialPackManifests.map((manifest) => ({ manifest }));

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

export default async function onRequest({ request }) {
  const url = new URL(request.url);
  const packs = officialPacks;

  if (request.method === "GET" && url.pathname === "/healthz") {
    return json({
      ok: true,
      service: "osstack-knowledge-cloud",
      runtime: "edgeone-cloud-functions",
      packs: packs.length,
      private_packs: 0,
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
    return json({
      packs: packs.map((pack) => packSummary(pack.manifest)),
      results: searchPacks(packs, query, limit),
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

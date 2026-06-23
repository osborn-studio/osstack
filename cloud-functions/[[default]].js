import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadKnowledgePack,
  loadKnowledgePackIndex,
  searchKnowledgePacks,
} from "../packages/knowledge/dist/index.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const officialIndexPath = join(rootDir, "knowledge-packs", "official", "index.json");

let officialPacksPromise;

async function officialPacks() {
  officialPacksPromise ??= loadOfficialPacks();
  return officialPacksPromise;
}

async function loadOfficialPacks() {
  const index = await loadKnowledgePackIndex(officialIndexPath);
  const indexDir = dirname(officialIndexPath);
  return Promise.all(index.packs.map((pack) => loadKnowledgePack(join(indexDir, pack.path))));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
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

export default async function onRequest({ request }) {
  const url = new URL(request.url);
  const packs = await officialPacks();

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
      results: searchKnowledgePacks(packs, query, { limit }),
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

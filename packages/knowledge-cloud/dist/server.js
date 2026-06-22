import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { loadKnowledgePack, loadKnowledgePackIndex, searchKnowledgePacks, } from "@osstack/knowledge";
export function createKnowledgeCloudHandler(options) {
    return async (req, res) => {
        try {
            await routeKnowledgeCloudRequest(options, req, res);
        }
        catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
    };
}
export async function startKnowledgeCloudServer(options) {
    const server = createServer(createKnowledgeCloudHandler(options));
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 0;
    await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(port, host, () => {
            server.off("error", rejectListen);
            resolveListen();
        });
    });
    const address = server.address();
    const resolvedHost = address?.address === "::" ? "127.0.0.1" : (address?.address ?? host);
    const resolvedPort = address?.port ?? port;
    return {
        url: `http://${resolvedHost}:${resolvedPort}`,
        server,
        close: () => new Promise((resolveClose, rejectClose) => {
            server.close((error) => {
                if (error !== undefined)
                    rejectClose(error);
                else
                    resolveClose();
            });
        }),
    };
}
export async function loadKnowledgeCloudPacksFromIndex(indexPath) {
    const index = await loadKnowledgePackIndex(indexPath);
    const indexDir = dirname(indexPath);
    return Promise.all(index.packs.map((pack) => loadKnowledgePack(join(indexDir, pack.path))));
}
async function routeKnowledgeCloudRequest(options, req, res) {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://knowledge.osstack.local");
    if (method === "GET" && url.pathname === "/v1/packs") {
        sendJson(res, 200, {
            packs: options.packs.map((pack) => packSummary(pack.manifest)),
        });
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
        await readJsonBody(req);
        sendJson(res, 200, {
            packs: (options.privatePacks ?? []).map((pack) => pack.manifest),
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
        const limit = numberField(body, "limit") ?? 5;
        const packs = [...options.packs, ...(options.privatePacks ?? [])];
        sendJson(res, 200, {
            packs: packs.map((pack) => packSummary(pack.manifest)),
            results: searchKnowledgePacks(packs, query, { limit }),
        });
        return;
    }
    if (method === "POST" && url.pathname === "/v1/feedback") {
        const body = await readJsonBody(req);
        const chunkId = stringField(body, "chunk_id");
        const rating = stringField(body, "rating");
        if (chunkId === undefined || (rating !== "useful" && rating !== "bad")) {
            sendJson(res, 400, { error: "chunk_id and rating are required" });
            return;
        }
        const entry = {
            chunk_id: chunkId,
            rating,
            status: "sent",
            created_at: options.now?.() ?? new Date().toISOString(),
        };
        await options.feedbackSink?.(entry);
        sendJson(res, 200, { ok: true, feedback: entry });
        return;
    }
    sendJson(res, 404, { error: "not found" });
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
async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    if (raw.length === 0)
        return {};
    return JSON.parse(raw);
}
function stringField(value, key) {
    if (!isRecord(value))
        return undefined;
    const field = value[key];
    return typeof field === "string" ? field : undefined;
}
function numberField(value, key) {
    if (!isRecord(value))
        return undefined;
    const field = value[key];
    return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function sendJson(res, status, payload) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(`${JSON.stringify(payload)}\n`);
}
//# sourceMappingURL=server.js.map
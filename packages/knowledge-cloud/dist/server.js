import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { loadKnowledgePack, loadKnowledgePackIndex, searchKnowledgePacks, validateKnowledgePackManifest, validateKnowledgePublishGate, } from "@osstack/knowledge";
export function createKnowledgeCloudHandler(options) {
    const feedbackLog = [...(options.feedbackLog ?? [])];
    const packs = [...options.packs];
    const privatePacks = [...(options.privatePacks ?? [])];
    return async (req, res) => {
        try {
            await routeKnowledgeCloudRequest({ ...options, packs, privatePacks, feedbackLog }, req, res);
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
            sendJson(res, 401, { error: "private knowledge packs require authorization" });
            return;
        }
        sendJson(res, 200, {
            packs: tenantPrivatePacks(options, tenantId).map((pack) => pack.manifest),
        });
        return;
    }
    if (method === "POST" && url.pathname === "/v1/publish") {
        const body = await readJsonBody(req);
        let manifest;
        try {
            manifest = validateKnowledgePackManifest(packField(body));
        }
        catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
            return;
        }
        const gate = validateKnowledgePublishGate(manifest);
        if (!gate.ok) {
            sendJson(res, 400, { ok: false, issues: gate.issues });
            return;
        }
        const pack = {
            manifest,
            path: `cloud://${manifest.id}@${manifest.version}`,
        };
        const privatePack = manifest.scope === "team" || manifest.scope === "project" || manifest.tenant_id !== undefined;
        if (privatePack) {
            const tenantId = manifest.tenant_id;
            if (tenantId === undefined || tenantId.trim().length === 0) {
                sendJson(res, 400, { error: "private knowledge publish requires tenant_id" });
                return;
            }
            if (!isAuthorizedPrivateRequest(options, req, tenantId)) {
                sendJson(res, 401, { error: "private knowledge publish requires authorization" });
                return;
            }
            upsertPack(options.privatePacks, pack);
            sendJson(res, 200, {
                ok: true,
                private: true,
                tenant_id: tenantId,
                pack: packSummary(manifest),
            });
            return;
        }
        upsertPack(options.packs, pack);
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
        const limit = numberField(body, "limit") ?? 5;
        const tenantId = tenantIdField(body);
        const packs = [
            ...options.packs,
            ...(tenantId !== undefined && isAuthorizedPrivateRequest(options, req, tenantId)
                ? tenantPrivatePacks(options, tenantId)
                : []),
        ];
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
        const tenantId = tenantIdField(body);
        if (chunkId === undefined || (rating !== "useful" && rating !== "bad")) {
            sendJson(res, 400, { error: "chunk_id and rating are required" });
            return;
        }
        const entry = {
            chunk_id: chunkId,
            rating,
            status: "sent",
            created_at: options.now?.() ?? new Date().toISOString(),
            ...(tenantId === undefined ? {} : { tenant_id: tenantId }),
            authorized: tenantId === undefined
                ? isAuthorizedPrivateRequest(options, req)
                : isAuthorizedPrivateRequest(options, req, tenantId),
        };
        options.feedbackLog.push(entry);
        await options.feedbackSink?.(entry);
        sendJson(res, 200, { ok: true, feedback: entry });
        return;
    }
    if (method === "POST" && url.pathname === "/v1/feedback/summary") {
        const body = await readJsonBody(req);
        sendJson(res, 200, summarizeFeedback(options.feedbackLog, tenantIdField(body)));
        return;
    }
    sendJson(res, 404, { error: "not found" });
}
function summarizeFeedback(entries, tenantId) {
    const filtered = tenantId === undefined
        ? entries
        : entries.filter((entry) => entry.tenant_id === tenantId);
    const chunks = new Map();
    let useful = 0;
    let bad = 0;
    for (const entry of filtered) {
        if (entry.rating === "useful")
            useful += 1;
        else
            bad += 1;
        const current = chunks.get(entry.chunk_id) ?? { chunk_id: entry.chunk_id, total: 0, useful: 0, bad: 0 };
        current.total += 1;
        if (entry.rating === "useful")
            current.useful += 1;
        else
            current.bad += 1;
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
function tenantPrivatePacks(options, tenantId) {
    return (options.privatePacks ?? []).filter((pack) => {
        const packTenantId = pack.manifest.tenant_id;
        return tenantId === packTenantId;
    });
}
function upsertPack(packs, pack) {
    const index = packs.findIndex((candidate) => candidate.manifest.id === pack.manifest.id);
    if (index >= 0)
        packs[index] = pack;
    else
        packs.push(pack);
}
function packField(body) {
    const candidate = isRecord(body) && "pack" in body ? body["pack"] : body;
    return isRecord(candidate) && "manifest" in candidate ? candidate["manifest"] : candidate;
}
function tenantIdField(body) {
    const tenantId = stringField(body, "tenant_id");
    if (tenantId === undefined || tenantId.trim().length === 0)
        return undefined;
    return tenantId;
}
function isAuthorizedPrivateRequest(options, req, tenantId) {
    const authorization = req.headers.authorization;
    const tenantToken = tenantId === undefined ? undefined : options.privateTenantTokens?.[tenantId]?.trim();
    if (tenantToken !== undefined && tenantToken.length > 0)
        return authorization === `Bearer ${tenantToken}`;
    const globalToken = options.privateAuthToken?.trim();
    if (globalToken !== undefined && globalToken.length > 0)
        return authorization === `Bearer ${globalToken}`;
    if (tenantId !== undefined && Object.keys(options.privateTenantTokens ?? {}).length > 0)
        return false;
    const tenantTokens = Object.values(options.privateTenantTokens ?? {}).map((token) => token.trim()).filter(Boolean);
    if (tenantTokens.length > 0)
        return tenantTokens.some((token) => authorization === `Bearer ${token}`);
    return true;
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
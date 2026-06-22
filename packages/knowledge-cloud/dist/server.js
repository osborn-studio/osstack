import { createServer } from "node:http";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadKnowledgePack, loadKnowledgePackIndex, searchKnowledgePacks, validateKnowledgePackManifest, validateKnowledgePublishGate, } from "@osstack/knowledge";
const MAX_JSON_BODY_BYTES = 1024 * 1024;
export function createKnowledgeCloudHandler(options) {
    const feedbackLog = [...(options.feedbackLog ?? [])];
    const auditLog = [...(options.auditLog ?? [])];
    const packs = [...options.packs];
    const privatePacks = [...(options.privatePacks ?? [])];
    return async (req, res) => {
        try {
            await routeKnowledgeCloudRequest({ ...options, packs, privatePacks, feedbackLog, auditLog }, req, res);
        }
        catch (error) {
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
export async function loadPublishedKnowledgeCloudPacksFromDir(root) {
    const packs = await loadPublishedPacksFromDir(join(root, "official"));
    const privatePacks = [];
    for (const tenantId of await tenantDirs(join(root, "private"))) {
        if (!isSafeTenantId(tenantId))
            throw new Error("persisted private tenant directory is invalid");
        privatePacks.push(...await loadPublishedPacksFromDir(join(root, "private", tenantId), tenantId));
    }
    return { packs, privatePacks };
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
        const pack = {
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
        const entry = {
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
async function recordAudit(options, entry) {
    const auditEntry = {
        event_id: `audit-${options.auditLog.length + 1}`,
        created_at: options.now?.() ?? new Date().toISOString(),
        ...entry,
    };
    options.auditLog.push(auditEntry);
    await options.auditSink?.(auditEntry);
}
function summarizeFeedback(entries, tenantId) {
    const filtered = tenantId === undefined
        ? entries.filter((entry) => entry.tenant_id === undefined)
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
async function persistPublishedPack(root, pack, tenantId) {
    if (root === undefined || root.trim().length === 0)
        return;
    const dir = tenantId === undefined ? join(root, "official") : join(root, "private", tenantId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, publishedPackFileName(pack.manifest)), `${JSON.stringify(pack.manifest, null, 2)}\n`, "utf-8");
}
async function loadPublishedPacksFromDir(dir, tenantId) {
    const files = await jsonFiles(dir);
    const packs = [];
    for (const file of files) {
        const path = join(dir, file);
        const manifest = validateKnowledgePackManifest(JSON.parse(await readFile(path, "utf-8")));
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
async function tenantDirs(dir) {
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b));
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
            return [];
        throw error;
    }
}
async function jsonFiles(dir) {
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b));
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
            return [];
        throw error;
    }
}
function publishedPackFileName(manifest) {
    return `${encodeURIComponent(manifest.id)}.json`;
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
    if (!isSafeTenantId(tenantId))
        throw new BadRequestError("tenant_id is invalid");
    return tenantId;
}
function manifestTenantId(manifest) {
    const tenantId = manifest.tenant_id;
    if (tenantId === undefined || tenantId.trim().length === 0)
        return undefined;
    if (!isSafeTenantId(tenantId))
        throw new BadRequestError("tenant_id is invalid");
    return tenantId;
}
function isPrivateKnowledgePack(manifest) {
    return manifest.scope === "team" || manifest.scope === "project" || manifest.tenant_id !== undefined;
}
function isSafeTenantId(tenantId) {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tenantId);
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
    if (raw.length === 0)
        return {};
    try {
        return JSON.parse(raw);
    }
    catch {
        throw new BadRequestError("invalid JSON body");
    }
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
function auditActionField(value) {
    const action = stringField(value, "action");
    if (action === "publish" || action === "private_packs" || action === "search" || action === "feedback")
        return action;
    return undefined;
}
function auditStatusField(value) {
    const status = stringField(value, "status");
    if (status === "ok" || status === "rejected" || status === "unauthorized")
        return status;
    return undefined;
}
function auditLimitField(value) {
    const limit = numberField(value, "limit");
    if (limit === undefined)
        return undefined;
    return Math.max(1, Math.min(100, Math.trunc(limit)));
}
function searchLimitField(value) {
    const limit = numberField(value, "limit");
    if (limit === undefined)
        return 5;
    return Math.max(1, Math.min(50, Math.trunc(limit)));
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
function sendJson(res, status, payload) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(`${JSON.stringify(payload)}\n`);
}
class BadRequestError extends Error {
}
class PayloadTooLargeError extends Error {
}
//# sourceMappingURL=server.js.map
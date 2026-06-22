#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadKnowledgePack } from "@osstack/knowledge";
import { loadKnowledgeCloudPacksFromIndex, loadPublishedKnowledgeCloudPacksFromDir, startKnowledgeCloudServer, } from "./index.js";
export async function main(argv = process.argv.slice(2)) {
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log(`osstack-knowledge-cloud

Usage:
  osstack-knowledge-cloud [--host H] [--port N] [--official-index P] [--private-pack P] [--private-token T] [--private-tenant-token tenant=token] [--published-pack-dir P] [--feedback-log P] [--audit-log P] [--json]

Options:
  --host H              Host to bind. Default: 127.0.0.1
  --port N              Port to bind. Default: 8787
  --official-index P    Official Knowledge Cloud index.json path.
  --private-pack P      Team/private pack manifest path. Repeatable.
  --private-token T     Bearer token required for /v1/private-packs and private search.
  --private-tenant-token tenant=token
                         Tenant-bound bearer token for private packs. Repeatable.
  --published-pack-dir P Persist /v1/publish packs and preload them on startup.
  --feedback-log P      Append feedback entries as JSONL for audit/quality review.
  --audit-log P         Append tenant-scoped publish/search/access audit events as JSONL.
  --json                Print startup metadata as JSON.

Env:
  OSSTACK_KNOWLEDGE_CLOUD_HOST
  OSSTACK_KNOWLEDGE_CLOUD_PORT
  OSSTACK_OFFICIAL_KNOWLEDGE_INDEX
  OSSTACK_KNOWLEDGE_PRIVATE_TOKEN
  OSSTACK_KNOWLEDGE_PRIVATE_TENANT_TOKENS_JSON
  OSSTACK_KNOWLEDGE_PUBLISHED_PACK_DIR
  OSSTACK_KNOWLEDGE_FEEDBACK_LOG
  OSSTACK_KNOWLEDGE_AUDIT_LOG
`);
        return 0;
    }
    const host = flagValue(argv, "--host") ?? process.env["OSSTACK_KNOWLEDGE_CLOUD_HOST"] ?? "127.0.0.1";
    const portRaw = flagValue(argv, "--port") ?? process.env["OSSTACK_KNOWLEDGE_CLOUD_PORT"] ?? "8787";
    const port = Number.parseInt(portRaw, 10);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error("osstack-knowledge-cloud: --port must be an integer from 0 to 65535");
        return 1;
    }
    const officialIndex = flagValue(argv, "--official-index")
        ?? process.env["OSSTACK_OFFICIAL_KNOWLEDGE_INDEX"]
        ?? defaultOfficialIndexPath();
    const packs = await loadKnowledgeCloudPacksFromIndex(officialIndex);
    const privatePacks = await Promise.all(flagValues(argv, "--private-pack").map((path) => loadKnowledgePack(path)));
    const publishedPackDir = flagValue(argv, "--published-pack-dir") ?? process.env["OSSTACK_KNOWLEDGE_PUBLISHED_PACK_DIR"];
    const publishedPacks = publishedPackDir === undefined || publishedPackDir.trim().length === 0
        ? { packs: [], privatePacks: [] }
        : await loadPublishedKnowledgeCloudPacksFromDir(publishedPackDir);
    const privateAuthToken = flagValue(argv, "--private-token") ?? process.env["OSSTACK_KNOWLEDGE_PRIVATE_TOKEN"];
    const privateTenantTokens = parsePrivateTenantTokens(flagValues(argv, "--private-tenant-token"), process.env["OSSTACK_KNOWLEDGE_PRIVATE_TENANT_TOKENS_JSON"]);
    const feedbackLog = flagValue(argv, "--feedback-log") ?? process.env["OSSTACK_KNOWLEDGE_FEEDBACK_LOG"];
    const feedbackEntries = feedbackLog === undefined || feedbackLog.trim().length === 0
        ? []
        : await readFeedbackLog(feedbackLog);
    if (feedbackLog !== undefined && feedbackLog.trim().length > 0) {
        await mkdir(dirname(feedbackLog), { recursive: true });
        await writeFile(feedbackLog, "", { flag: "a" });
    }
    const auditLog = flagValue(argv, "--audit-log") ?? process.env["OSSTACK_KNOWLEDGE_AUDIT_LOG"];
    const auditEntries = auditLog === undefined || auditLog.trim().length === 0
        ? []
        : await readAuditLog(auditLog);
    if (auditLog !== undefined && auditLog.trim().length > 0) {
        await mkdir(dirname(auditLog), { recursive: true });
        await writeFile(auditLog, "", { flag: "a" });
    }
    const handle = await startKnowledgeCloudServer({
        host,
        port,
        packs: [...packs, ...publishedPacks.packs],
        ...([...privatePacks, ...publishedPacks.privatePacks].length === 0
            ? {}
            : { privatePacks: [...privatePacks, ...publishedPacks.privatePacks] }),
        ...(privateAuthToken === undefined || privateAuthToken.trim().length === 0 ? {} : { privateAuthToken: privateAuthToken.trim() }),
        ...(Object.keys(privateTenantTokens).length === 0 ? {} : { privateTenantTokens }),
        ...(publishedPackDir === undefined || publishedPackDir.trim().length === 0 ? {} : { publishedPackDir }),
        ...(feedbackEntries.length === 0 ? {} : { feedbackLog: feedbackEntries }),
        ...(auditEntries.length === 0 ? {} : { auditLog: auditEntries }),
        ...(feedbackLog === undefined || feedbackLog.trim().length === 0
            ? {}
            : {
                feedbackSink: async (entry) => {
                    await appendFile(feedbackLog, `${JSON.stringify(entry)}\n`, "utf-8");
                },
            }),
        ...(auditLog === undefined || auditLog.trim().length === 0
            ? {}
            : {
                auditSink: async (entry) => {
                    await appendFile(auditLog, `${JSON.stringify(entry)}\n`, "utf-8");
                },
            }),
    });
    const startup = {
        url: handle.url,
        official_index: officialIndex,
        packs: packs.length + publishedPacks.packs.length,
        private_packs: privatePacks.length + publishedPacks.privatePacks.length,
        published_packs_loaded: publishedPacks.packs.length,
        published_private_packs_loaded: publishedPacks.privatePacks.length,
        private_auth_required: privateAuthToken !== undefined && privateAuthToken.trim().length > 0
            || Object.keys(privateTenantTokens).length > 0,
        private_tenant_tokens: Object.keys(privateTenantTokens).length,
        ...(publishedPackDir === undefined || publishedPackDir.trim().length === 0
            ? {}
            : { published_pack_dir: publishedPackDir }),
        ...(feedbackLog === undefined || feedbackLog.trim().length === 0
            ? {}
            : { feedback_log: feedbackLog, feedback_log_loaded: feedbackEntries.length }),
        ...(auditLog === undefined || auditLog.trim().length === 0
            ? {}
            : { audit_log: auditLog, audit_log_loaded: auditEntries.length }),
    };
    if (argv.includes("--json")) {
        console.log(JSON.stringify(startup, null, 2));
    }
    else {
        console.log(`knowledge_cloud=${startup.url}`);
        console.log(`packs=${startup.packs} private_packs=${startup.private_packs}`);
    }
    await waitForShutdown();
    await handle.close();
    return 0;
}
async function readFeedbackLog(path) {
    let raw = "";
    try {
        raw = await readFile(path, "utf-8");
    }
    catch {
        return [];
    }
    const entries = [];
    for (const line of raw.split(/\r?\n/)) {
        if (line.trim().length === 0)
            continue;
        try {
            const parsed = JSON.parse(line);
            if (isFeedbackEntry(parsed))
                entries.push(parsed);
        }
        catch {
        }
    }
    return entries;
}
async function readAuditLog(path) {
    let raw = "";
    try {
        raw = await readFile(path, "utf-8");
    }
    catch {
        return [];
    }
    const entries = [];
    for (const line of raw.split(/\r?\n/)) {
        if (line.trim().length === 0)
            continue;
        try {
            const parsed = JSON.parse(line);
            if (isAuditEntry(parsed))
                entries.push(parsed);
        }
        catch {
        }
    }
    return entries;
}
function isFeedbackEntry(value) {
    if (!isRecord(value))
        return false;
    return typeof value["chunk_id"] === "string"
        && (value["rating"] === "useful" || value["rating"] === "bad")
        && (value["status"] === "recorded" || value["status"] === "sent")
        && typeof value["created_at"] === "string";
}
function isAuditEntry(value) {
    if (!isRecord(value))
        return false;
    return typeof value["event_id"] === "string"
        && (value["action"] === "publish" || value["action"] === "private_packs" || value["action"] === "search" || value["action"] === "feedback")
        && (value["status"] === "ok" || value["status"] === "rejected" || value["status"] === "unauthorized")
        && typeof value["created_at"] === "string";
}
function parsePrivateTenantTokens(values, json) {
    const tokens = {};
    if (json !== undefined && json.trim().length > 0) {
        const parsed = JSON.parse(json);
        if (!isRecord(parsed))
            throw new Error("OSSTACK_KNOWLEDGE_PRIVATE_TENANT_TOKENS_JSON must be a JSON object");
        for (const [tenantId, token] of Object.entries(parsed)) {
            if (typeof token === "string" && tenantId.trim().length > 0 && token.trim().length > 0) {
                const normalizedTenantId = tenantId.trim();
                if (!isSafeTenantId(normalizedTenantId))
                    throw new Error("tenant id is invalid");
                tokens[normalizedTenantId] = token.trim();
            }
        }
    }
    for (const value of values) {
        const separatorIndex = value.indexOf("=");
        if (separatorIndex <= 0)
            throw new Error("--private-tenant-token must use tenant=token");
        const tenantId = value.slice(0, separatorIndex).trim();
        const token = value.slice(separatorIndex + 1).trim();
        if (tenantId.length === 0 || token.length === 0)
            throw new Error("--private-tenant-token must use tenant=token");
        if (!isSafeTenantId(tenantId))
            throw new Error("tenant id is invalid");
        tokens[tenantId] = token;
    }
    return tokens;
}
function isSafeTenantId(tenantId) {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tenantId);
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function defaultOfficialIndexPath() {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(process.cwd(), "knowledge-packs", "official", "index.json"),
        join(here, "..", "..", "..", "knowledge-packs", "official", "index.json"),
    ];
    for (const candidate of candidates) {
        try {
            return realpathSync(candidate);
        }
        catch {
        }
    }
    return candidates[0];
}
function waitForShutdown() {
    if (process.env["OSSTACK_KNOWLEDGE_CLOUD_ONCE"] === "1")
        return Promise.resolve();
    return new Promise((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
    });
}
function flagValue(args, name) {
    const index = args.indexOf(name);
    if (index < 0 || index + 1 >= args.length)
        return undefined;
    return args[index + 1];
}
function flagValues(args, name) {
    const values = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === name && i + 1 < args.length) {
            values.push(args[i + 1]);
            i++;
        }
    }
    return values;
}
if (isMain()) {
    main().then((code) => {
        process.exitCode = code;
    }).catch((error) => {
        console.error(`osstack-knowledge-cloud: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
function isMain() {
    if (process.argv[1] === undefined)
        return false;
    try {
        return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=bin.js.map
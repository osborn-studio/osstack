#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadKnowledgePack } from "@osstack/knowledge";
import { loadKnowledgeCloudPacksFromIndex, startKnowledgeCloudServer } from "./index.js";
export async function main(argv = process.argv.slice(2)) {
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log(`osstack-knowledge-cloud

Usage:
  osstack-knowledge-cloud [--host H] [--port N] [--official-index P] [--private-pack P] [--private-token T] [--feedback-log P] [--json]

Options:
  --host H              Host to bind. Default: 127.0.0.1
  --port N              Port to bind. Default: 8787
  --official-index P    Official Knowledge Cloud index.json path.
  --private-pack P      Team/private pack manifest path. Repeatable.
  --private-token T     Bearer token required for /v1/private-packs and private search.
  --feedback-log P      Append feedback entries as JSONL for audit/quality review.
  --json                Print startup metadata as JSON.

Env:
  OSSTACK_KNOWLEDGE_CLOUD_HOST
  OSSTACK_KNOWLEDGE_CLOUD_PORT
  OSSTACK_OFFICIAL_KNOWLEDGE_INDEX
  OSSTACK_KNOWLEDGE_PRIVATE_TOKEN
  OSSTACK_KNOWLEDGE_FEEDBACK_LOG
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
    const privateAuthToken = flagValue(argv, "--private-token") ?? process.env["OSSTACK_KNOWLEDGE_PRIVATE_TOKEN"];
    const feedbackLog = flagValue(argv, "--feedback-log") ?? process.env["OSSTACK_KNOWLEDGE_FEEDBACK_LOG"];
    const feedbackEntries = feedbackLog === undefined || feedbackLog.trim().length === 0
        ? []
        : await readFeedbackLog(feedbackLog);
    if (feedbackLog !== undefined && feedbackLog.trim().length > 0) {
        await mkdir(dirname(feedbackLog), { recursive: true });
        await writeFile(feedbackLog, "", { flag: "a" });
    }
    const handle = await startKnowledgeCloudServer({
        host,
        port,
        packs,
        ...(privatePacks.length === 0 ? {} : { privatePacks }),
        ...(privateAuthToken === undefined || privateAuthToken.trim().length === 0 ? {} : { privateAuthToken: privateAuthToken.trim() }),
        ...(feedbackEntries.length === 0 ? {} : { feedbackLog: feedbackEntries }),
        ...(feedbackLog === undefined || feedbackLog.trim().length === 0
            ? {}
            : {
                feedbackSink: async (entry) => {
                    await appendFile(feedbackLog, `${JSON.stringify(entry)}\n`, "utf-8");
                },
            }),
    });
    const startup = {
        url: handle.url,
        official_index: officialIndex,
        packs: packs.length,
        private_packs: privatePacks.length,
        private_auth_required: privateAuthToken !== undefined && privateAuthToken.trim().length > 0,
        ...(feedbackLog === undefined || feedbackLog.trim().length === 0
            ? {}
            : { feedback_log: feedbackLog, feedback_log_loaded: feedbackEntries.length }),
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
function isFeedbackEntry(value) {
    if (!isRecord(value))
        return false;
    return typeof value["chunk_id"] === "string"
        && (value["rating"] === "useful" || value["rating"] === "bad")
        && (value["status"] === "recorded" || value["status"] === "sent")
        && typeof value["created_at"] === "string";
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
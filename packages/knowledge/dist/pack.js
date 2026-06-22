import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
export async function loadKnowledgePack(path) {
    const pathStat = await stat(path);
    const manifestPath = pathStat.isDirectory() ? join(path, "manifest.json") : path;
    const raw = await readFile(manifestPath, "utf-8");
    const parsed = JSON.parse(raw);
    const manifest = validateKnowledgePackManifest(parsed);
    return { manifest, path: manifestPath };
}
export function validateKnowledgePackManifest(value) {
    if (!isRecord(value))
        throw new Error("knowledge pack manifest must be an object");
    const id = requiredString(value, "id");
    const version = requiredString(value, "version");
    const name = requiredString(value, "name");
    const license = requiredString(value, "license");
    const sourceKind = requiredString(value, "source_kind");
    if (!["osstack_native", "processed_mit", "curated_external", "internal"].includes(sourceKind)) {
        throw new Error("knowledge pack source_kind is invalid");
    }
    const qualityScore = requiredNumber(value, "quality_score");
    if (qualityScore < 0 || qualityScore > 100) {
        throw new Error("knowledge pack quality_score must be between 0 and 100");
    }
    const scope = optionalString(value, "scope");
    if (scope !== undefined && !["official", "team", "project"].includes(scope)) {
        throw new Error("knowledge pack scope is invalid");
    }
    const taxonomy = optionalStringArray(value, "taxonomy");
    const chunksRaw = value["chunks"];
    if (!Array.isArray(chunksRaw))
        throw new Error("knowledge pack chunks must be an array");
    const chunks = chunksRaw.map((chunk, index) => {
        if (!isRecord(chunk))
            throw new Error(`knowledge chunk at index ${index} must be an object`);
        const normalized = {
            chunk_id: requiredString(chunk, "chunk_id"),
            title: requiredString(chunk, "title"),
            body: requiredString(chunk, "body"),
        };
        const tags = optionalStringArray(chunk, "tags");
        const sourceRefs = optionalStringArray(chunk, "source_refs");
        return {
            ...normalized,
            ...(tags === undefined ? {} : { tags }),
            ...(sourceRefs === undefined ? {} : { source_refs: sourceRefs }),
        };
    });
    const generatedAt = optionalString(value, "generated_at");
    const lastReviewedAt = optionalString(value, "last_reviewed_at");
    const sourceAttribution = optionalStringArray(value, "source_attribution");
    const sourceProvenanceRaw = value["source_provenance"];
    const sourceProvenance = sourceProvenanceRaw === undefined
        ? undefined
        : validateSourceProvenanceArray(sourceProvenanceRaw);
    return {
        id,
        version,
        name,
        license,
        source_kind: sourceKind,
        quality_score: qualityScore,
        ...(scope === undefined ? {} : { scope: scope }),
        ...(taxonomy === undefined ? {} : { taxonomy }),
        ...(generatedAt === undefined ? {} : { generated_at: generatedAt }),
        ...(lastReviewedAt === undefined ? {} : { last_reviewed_at: lastReviewedAt }),
        ...(sourceAttribution === undefined ? {} : { source_attribution: sourceAttribution }),
        ...(sourceProvenance === undefined ? {} : { source_provenance: sourceProvenance }),
        chunks,
    };
}
export async function importKnowledgeSource(options) {
    const generatedAt = options.generatedAt ?? new Date().toISOString();
    const sourceFiles = await collectKnowledgeSourceFiles(options.path);
    const sourceProvenance = [];
    const chunks = [];
    let index = 1;
    for (const filePath of sourceFiles) {
        const raw = await readFile(filePath, "utf-8");
        const body = normalizeKnowledgeBody(raw);
        if (body.length === 0)
            continue;
        const sourceId = `src_${index}`;
        const relPath = relative(options.path, filePath) || basename(filePath);
        sourceProvenance.push({
            source_id: sourceId,
            path: relPath,
            sha256: sha256(raw),
            license: options.license,
            scope: options.scope,
            imported_at: generatedAt,
        });
        chunks.push({
            chunk_id: `chk_${index}`,
            title: titleFromBody(body, filePath),
            body,
            tags: [...new Set([options.scope, ...(options.taxonomy ?? [])])],
            source_refs: [sourceId],
        });
        index++;
    }
    return validateKnowledgePackManifest({
        id: options.id,
        version: options.version ?? generatedAt.slice(0, 10).replaceAll("-", "."),
        name: options.name,
        license: options.license,
        source_kind: options.scope === "official" ? "osstack_native" : "internal",
        quality_score: options.qualityScore ?? 50,
        scope: options.scope,
        taxonomy: options.taxonomy ?? [],
        generated_at: generatedAt,
        last_reviewed_at: generatedAt,
        source_attribution: [`imported from ${options.scope} source ${basename(options.path)}`],
        source_provenance: sourceProvenance,
        chunks,
    });
}
async function collectKnowledgeSourceFiles(path) {
    const pathStat = await stat(path);
    if (pathStat.isFile())
        return isKnowledgeSourceFile(path) ? [path] : [];
    const entries = await readdir(path, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
        const entryPath = join(path, entry.name);
        if (entry.isDirectory())
            return collectKnowledgeSourceFiles(entryPath);
        if (entry.isFile() && isKnowledgeSourceFile(entryPath))
            return [entryPath];
        return [];
    }));
    return nested.flat().sort((a, b) => a.localeCompare(b));
}
function isKnowledgeSourceFile(path) {
    return [".md", ".txt"].includes(extname(path).toLowerCase());
}
function normalizeKnowledgeBody(raw) {
    return raw.replace(/\r\n/g, "\n").trim();
}
function titleFromBody(body, path) {
    const heading = body.split("\n").find((line) => line.trim().startsWith("# "));
    if (heading !== undefined)
        return heading.replace(/^#\s+/, "").trim();
    return basename(path, extname(path)).replace(/[-_]+/g, " ");
}
export function searchKnowledgePacks(packs, query, options = {}) {
    const terms = tokenize(query);
    if (terms.length === 0)
        return [];
    const results = [];
    for (const pack of packs) {
        for (const chunk of pack.manifest.chunks) {
            const haystack = `${chunk.title} ${chunk.body} ${(chunk.tags ?? []).join(" ")}`.toLowerCase();
            const score = terms.reduce((sum, term) => sum + countOccurrences(haystack, term), 0);
            if (score === 0)
                continue;
            results.push({
                pack_id: pack.manifest.id,
                pack_version: pack.manifest.version,
                chunk_id: chunk.chunk_id,
                title: chunk.title,
                score,
                snippet: snippetFor(chunk.body, terms),
                tags: chunk.tags ?? [],
                source_refs: chunk.source_refs ?? [],
            });
        }
    }
    return results
        .sort((a, b) => b.score - a.score || a.pack_id.localeCompare(b.pack_id) || a.chunk_id.localeCompare(b.chunk_id))
        .slice(0, options.limit ?? 5);
}
export function assembleKnowledgeSnippet(results) {
    return results.map((result) => [
        `# ${result.title}`,
        `pack=${result.pack_id}@${result.pack_version} chunk=${result.chunk_id} score=${result.score}`,
        result.snippet,
    ].join("\n")).join("\n\n");
}
export async function resolveKnowledgeSearch(options) {
    const mode = options.mode ?? inferKnowledgeMode(options);
    if (mode === "off")
        return offKnowledgeEvidence(options.query);
    const query = options.query?.trim();
    if (query === undefined || query.length === 0) {
        return {
            mode,
            status: "error",
            reason: "knowledge search requires a non-empty query",
            packs: packSummaries(options.packs ?? []),
            results: [],
        };
    }
    if (mode === "local") {
        return localKnowledgeEvidence(query, options.packs ?? [], options.limit);
    }
    return cloudKnowledgeEvidence({
        query,
        packs: options.packs ?? [],
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.cloudUrl === undefined ? {} : { cloudUrl: options.cloudUrl }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
}
function inferKnowledgeMode(options) {
    if (options.cloudUrl !== undefined && options.cloudUrl.length > 0)
        return "cloud";
    if ((options.packs ?? []).length > 0)
        return "local";
    return "off";
}
function offKnowledgeEvidence(query, reason) {
    return {
        mode: "off",
        status: "not_used",
        packs: [],
        results: [],
        ...(query === undefined ? {} : { query }),
        ...(reason === undefined ? {} : { reason }),
    };
}
function localKnowledgeEvidence(query, packs, limit = 5) {
    if (packs.length === 0) {
        return offKnowledgeEvidence(query, "no local knowledge packs configured");
    }
    return {
        mode: "local",
        status: "recorded",
        query,
        packs: packSummaries(packs),
        results: searchKnowledgePacks(packs, query, { limit }),
    };
}
async function cloudKnowledgeEvidence(options) {
    if (options.cloudUrl === undefined || options.cloudUrl.length === 0) {
        return fallbackFromCloud(options, "cloudUrl is required for cloud knowledge search");
    }
    try {
        const response = await (options.fetchImpl ?? fetch)(new URL("/v1/search", withTrailingSlash(options.cloudUrl)), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: options.query, limit: options.limit ?? 5 }),
        });
        if (!response.ok)
            throw new Error(`cloud search failed with HTTP ${response.status}`);
        const payload = await response.json();
        return validateCloudKnowledgeResponse(options.query, payload);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fallbackFromCloud(options, message);
    }
}
function fallbackFromCloud(options, reason) {
    if (options.packs.length > 0) {
        return {
            mode: "local",
            status: "recorded",
            query: options.query,
            packs: packSummaries(options.packs),
            results: searchKnowledgePacks(options.packs, options.query, options.limit === undefined ? {} : { limit: options.limit }),
            fallback_mode: "local",
            reason,
        };
    }
    return {
        mode: "off",
        status: "not_used",
        packs: [],
        results: [],
        query: options.query,
        reason,
        fallback_mode: "off",
    };
}
function validateCloudKnowledgeResponse(query, value) {
    if (!isRecord(value))
        throw new Error("cloud knowledge response must be an object");
    const packsRaw = value["packs"];
    const resultsRaw = value["results"];
    if (!Array.isArray(packsRaw))
        throw new Error("cloud knowledge response packs must be an array");
    if (!Array.isArray(resultsRaw))
        throw new Error("cloud knowledge response results must be an array");
    return {
        mode: "cloud",
        status: "recorded",
        query,
        packs: packsRaw.map(validatePackSummary),
        results: resultsRaw.map(validateSearchResult),
    };
}
function validatePackSummary(value) {
    if (!isRecord(value))
        throw new Error("cloud knowledge pack summary must be an object");
    const sourceKind = requiredString(value, "source_kind");
    if (!["osstack_native", "processed_mit", "curated_external", "internal"].includes(sourceKind)) {
        throw new Error("cloud knowledge pack source_kind is invalid");
    }
    const qualityScore = requiredNumber(value, "quality_score");
    if (qualityScore < 0 || qualityScore > 100) {
        throw new Error("cloud knowledge pack quality_score must be between 0 and 100");
    }
    return {
        id: requiredString(value, "id"),
        version: requiredString(value, "version"),
        license: requiredString(value, "license"),
        source_kind: sourceKind,
        quality_score: qualityScore,
    };
}
function validateSearchResult(value) {
    if (!isRecord(value))
        throw new Error("cloud knowledge result must be an object");
    return {
        pack_id: requiredString(value, "pack_id"),
        pack_version: requiredString(value, "pack_version"),
        chunk_id: requiredString(value, "chunk_id"),
        title: requiredString(value, "title"),
        score: requiredNumber(value, "score"),
        snippet: requiredString(value, "snippet"),
        tags: optionalStringArray(value, "tags") ?? [],
        source_refs: optionalStringArray(value, "source_refs") ?? [],
    };
}
function packSummaries(packs) {
    return packs.map((pack) => ({
        id: pack.manifest.id,
        version: pack.manifest.version,
        license: pack.manifest.license,
        source_kind: pack.manifest.source_kind,
        quality_score: pack.manifest.quality_score,
    }));
}
function withTrailingSlash(url) {
    return url.endsWith("/") ? url : `${url}/`;
}
function validateSourceProvenanceArray(value) {
    if (!Array.isArray(value))
        throw new Error("knowledge pack source_provenance must be an array");
    return value.map((item) => {
        if (!isRecord(item))
            throw new Error("knowledge pack source_provenance entries must be objects");
        const scope = requiredString(item, "scope");
        if (!["official", "team", "project"].includes(scope)) {
            throw new Error("knowledge pack source_provenance scope is invalid");
        }
        return {
            source_id: requiredString(item, "source_id"),
            path: requiredString(item, "path"),
            sha256: requiredString(item, "sha256"),
            license: requiredString(item, "license"),
            scope: scope,
            imported_at: requiredString(item, "imported_at"),
        };
    });
}
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
function tokenize(query) {
    return query
        .toLowerCase()
        .split(/[^a-z0-9_\u4e00-\u9fa5]+/u)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2);
}
function countOccurrences(text, term) {
    let count = 0;
    let index = text.indexOf(term);
    while (index >= 0) {
        count++;
        index = text.indexOf(term, index + term.length);
    }
    return count;
}
function snippetFor(body, terms) {
    const termList = Array.isArray(terms) ? terms : [terms];
    const lower = body.toLowerCase();
    const firstMatch = termList
        .map((term) => lower.indexOf(term))
        .filter((index) => index >= 0)
        .sort((a, b) => a - b)[0] ?? 0;
    const start = Math.max(0, firstMatch - 80);
    const end = Math.min(body.length, firstMatch + 220);
    return body.slice(start, end).replace(/\s+/g, " ").trim();
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function requiredString(value, key) {
    const field = value[key];
    if (typeof field !== "string" || field.length === 0) {
        throw new Error(`knowledge pack ${key} must be a non-empty string`);
    }
    return field;
}
function optionalString(value, key) {
    const field = value[key];
    if (field === undefined)
        return undefined;
    if (typeof field !== "string" || field.length === 0) {
        throw new Error(`knowledge pack ${key} must be a non-empty string`);
    }
    return field;
}
function requiredNumber(value, key) {
    const field = value[key];
    if (typeof field !== "number" || !Number.isFinite(field)) {
        throw new Error(`knowledge pack ${key} must be a finite number`);
    }
    return field;
}
function optionalStringArray(value, key) {
    const field = value[key];
    if (field === undefined)
        return undefined;
    if (!Array.isArray(field) || !field.every((item) => typeof item === "string")) {
        throw new Error(`knowledge pack ${key} must be an array of strings`);
    }
    return field;
}
//# sourceMappingURL=pack.js.map
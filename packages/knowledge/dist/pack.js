import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    const tenantId = optionalString(value, "tenant_id");
    if (tenantId !== undefined && tenantId.trim().length === 0) {
        throw new Error("knowledge pack tenant_id must be non-empty");
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
    const review = value["review"] === undefined ? undefined : validateKnowledgeReview(value["review"]);
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
        ...(tenantId === undefined ? {} : { tenant_id: tenantId }),
        ...(taxonomy === undefined ? {} : { taxonomy }),
        ...(generatedAt === undefined ? {} : { generated_at: generatedAt }),
        ...(lastReviewedAt === undefined ? {} : { last_reviewed_at: lastReviewedAt }),
        ...(review === undefined ? {} : { review }),
        ...(sourceAttribution === undefined ? {} : { source_attribution: sourceAttribution }),
        ...(sourceProvenance === undefined ? {} : { source_provenance: sourceProvenance }),
        chunks,
    };
}
export function validateKnowledgePublishGate(manifest, options = {}) {
    const issues = [];
    const official = options.requireOfficial === true || manifest.scope === "official";
    const external = manifest.source_kind === "processed_mit" || manifest.source_kind === "curated_external";
    if (official && manifest.source_kind === "internal") {
        issues.push({
            code: "official_internal_source_kind",
            message: "official knowledge packs cannot use source_kind=internal",
        });
    }
    if (official && manifest.quality_score < 80) {
        issues.push({
            code: "official_low_quality_score",
            message: "official knowledge packs require quality_score >= 80",
        });
    }
    if (official && (manifest.taxonomy ?? []).length === 0) {
        issues.push({
            code: "official_missing_taxonomy",
            message: "official knowledge packs require at least one Osstack taxonomy entry",
        });
    }
    if (official && (manifest.last_reviewed_at ?? "").trim().length === 0) {
        issues.push({
            code: "official_missing_review",
            message: "official knowledge packs require last_reviewed_at",
        });
    }
    if (official && manifest.review?.status !== "approved") {
        issues.push({
            code: "official_review_not_approved",
            message: "official knowledge packs require review.status=approved",
        });
    }
    if ((official || external) && (manifest.source_attribution ?? []).length === 0) {
        issues.push({
            code: "missing_source_attribution",
            message: "official or externally processed knowledge requires source_attribution",
        });
    }
    if ((official || external) && (manifest.source_provenance ?? []).length === 0) {
        issues.push({
            code: "missing_source_provenance",
            message: "official or externally processed knowledge requires source_provenance",
        });
    }
    if ((official || external) && manifest.source_kind === "processed_mit" && !isProcessedLicenseLabel(manifest.license)) {
        issues.push({
            code: "processed_license_not_osstack_derived",
            message: "processed_mit knowledge packs must use an Osstack processed or derived license label, not the raw upstream license",
        });
    }
    if (official && manifest.chunks.length === 0) {
        issues.push({
            code: "official_empty_chunks",
            message: "official knowledge packs require at least one chunk",
        });
    }
    for (const [index, chunk] of manifest.chunks.entries()) {
        if (official && !/\bosstack\b/i.test(chunk.body)) {
            issues.push({
                code: "chunk_missing_osstack_voice",
                message: `chunk ${index} must be rewritten in Osstack-native voice`,
            });
        }
        if ((official || external) && (chunk.source_refs ?? []).length === 0) {
            issues.push({
                code: "chunk_missing_source_refs",
                message: `chunk ${index} requires source_refs for provenance tracing`,
            });
        }
    }
    return { ok: issues.length === 0, issues };
}
function isProcessedLicenseLabel(license) {
    return /\b(processed|derived|osstack)\b/i.test(license);
}
function isUnsafeKnowledgeSourcePath(path) {
    return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.split(/[\\/]+/).includes("..");
}
export async function loadKnowledgePackIndex(path) {
    const raw = await readFile(path, "utf-8");
    return validateKnowledgePackIndex(JSON.parse(raw));
}
export function validateKnowledgePackIndex(value) {
    if (!isRecord(value))
        throw new Error("knowledge pack index must be an object");
    const generatedAt = requiredString(value, "generated_at");
    const channel = requiredString(value, "channel");
    if (channel !== "official")
        throw new Error("knowledge pack index channel must be official");
    const packsRaw = value["packs"];
    if (!Array.isArray(packsRaw))
        throw new Error("knowledge pack index packs must be an array");
    const ids = new Set();
    const packs = packsRaw.map((entry, index) => {
        if (!isRecord(entry))
            throw new Error(`knowledge pack index entry ${index} must be an object`);
        const id = requiredString(entry, "id");
        if (ids.has(id))
            throw new Error(`knowledge pack index duplicate id: ${id}`);
        ids.add(id);
        const sourceKind = requiredString(entry, "source_kind");
        if (!["osstack_native", "processed_mit", "curated_external", "internal"].includes(sourceKind)) {
            throw new Error("knowledge pack index source_kind is invalid");
        }
        const scope = requiredString(entry, "scope");
        if (!["official", "team", "project"].includes(scope)) {
            throw new Error("knowledge pack index scope is invalid");
        }
        const qualityScore = requiredNumber(entry, "quality_score");
        if (qualityScore < 0 || qualityScore > 100) {
            throw new Error("knowledge pack index quality_score must be between 0 and 100");
        }
        const path = requiredString(entry, "path");
        if (isUnsafeKnowledgeSourcePath(path)) {
            throw new Error("knowledge pack index path is unsafe");
        }
        const taxonomy = optionalStringArray(entry, "taxonomy");
        return {
            id,
            version: requiredString(entry, "version"),
            path,
            scope: scope,
            source_kind: sourceKind,
            quality_score: qualityScore,
            ...(taxonomy === undefined ? {} : { taxonomy }),
        };
    });
    return { generated_at: generatedAt, channel: "official", packs };
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
    const manifest = validateKnowledgePackManifest({
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
    const gate = validateKnowledgePublishGate(manifest);
    if (!gate.ok) {
        throw new Error(`knowledge publish gate failed: ${gate.issues.map((issue) => issue.code).join(", ")}`);
    }
    return manifest;
}
export async function ingestKnowledgeSource(options) {
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
            chunk_id: `ing_${index}`,
            title: osstackTitleFromBody(body, filePath),
            body: renderOsstackNativeGuidance(body, options.taxonomy ?? []),
            tags: [...new Set([options.scope, "osstack-native", ...(options.taxonomy ?? [])])],
            source_refs: [sourceId],
        });
        index++;
    }
    const sourceKind = options.sourceKind
        ?? (options.scope === "official" ? "osstack_native" : "internal");
    const manifest = validateKnowledgePackManifest({
        id: options.id,
        version: options.version ?? generatedAt.slice(0, 10).replaceAll("-", "."),
        name: options.name,
        license: options.license,
        source_kind: sourceKind,
        quality_score: options.qualityScore ?? (options.scope === "official" ? 80 : 60),
        scope: options.scope,
        taxonomy: options.taxonomy ?? [],
        generated_at: generatedAt,
        last_reviewed_at: generatedAt,
        ...(options.review === undefined ? {} : { review: options.review }),
        source_attribution: options.sourceAttribution ?? [`osstack-ingested from ${options.scope} source ${basename(options.path)}`],
        source_provenance: sourceProvenance,
        chunks,
    });
    const gate = validateKnowledgePublishGate(manifest);
    if (!gate.ok) {
        throw new Error(`knowledge publish gate failed: ${gate.issues.map((issue) => issue.code).join(", ")}`);
    }
    return manifest;
}
export async function syncKnowledgeCache(options) {
    try {
        assertSafeOptionalTenantId(options.tenantId);
        const endpoint = options.privatePacks === true ? "/v1/private-packs" : "/v1/sync";
        const response = await (options.fetchImpl ?? fetch)(new URL(endpoint, withTrailingSlash(options.cloudUrl)), {
            method: "POST",
            headers: cloudHeaders(options.authToken),
            body: JSON.stringify({
                client: "osstack-cli",
                ...(options.tenantId === undefined ? {} : { tenant_id: options.tenantId }),
            }),
        });
        if (!response.ok)
            throw new Error(`cloud sync failed with HTTP ${response.status}`);
        const payload = await response.json();
        if (!isRecord(payload) || !Array.isArray(payload["packs"])) {
            throw new Error("cloud sync response packs must be an array");
        }
        const pins = await readPins(join(options.cacheDir, "pins.json"));
        const incomingPacks = payload["packs"].map(validateKnowledgePackManifest);
        const skippedPinnedPacks = incomingPacks.filter((pack) => isBlockedByPin(pack, pins));
        const packs = incomingPacks.filter((pack) => !isBlockedByPin(pack, pins));
        await mkdir(join(options.cacheDir, "packs"), { recursive: true });
        for (const pack of packs) {
            await writeCachedPack(options.cacheDir, pack);
        }
        return {
            status: "synced",
            cache_dir: options.cacheDir,
            packs: packs.map(packSummaryFromManifest),
            ...(skippedPinnedPacks.length === 0 ? {} : { skipped_pins: skippedPinnedPacks.map(packSummaryFromManifest) }),
        };
    }
    catch (error) {
        return {
            status: "error",
            cache_dir: options.cacheDir,
            packs: [],
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}
export async function listCachedKnowledgePacks(cacheDir) {
    const packsDir = join(cacheDir, "packs");
    const pins = await readPins(join(cacheDir, "pins.json"));
    let packDirs;
    try {
        packDirs = await readdir(packsDir);
    }
    catch {
        return [];
    }
    const packs = [];
    for (const packDir of packDirs.sort((a, b) => a.localeCompare(b))) {
        const versionDir = join(packsDir, packDir);
        let versions;
        try {
            versions = await readdir(versionDir);
        }
        catch {
            continue;
        }
        for (const versionFile of versions.filter((name) => name.endsWith(".json")).sort((a, b) => a.localeCompare(b))) {
            const path = join(versionDir, versionFile);
            const pack = await loadKnowledgePack(path);
            if (!isBlockedByPin(pack.manifest, pins))
                packs.push(pack);
        }
    }
    return packs;
}
export async function pinKnowledgePack(cacheDir, spec) {
    const at = spec.lastIndexOf("@");
    if (at <= 0 || at === spec.length - 1)
        throw new Error("knowledge pin must use <pack_id>@<version>");
    const pin = { pack_id: spec.slice(0, at), version: spec.slice(at + 1) };
    await mkdir(cacheDir, { recursive: true });
    const pinsPath = join(cacheDir, "pins.json");
    const existing = await readPins(pinsPath);
    const pins = [...existing.filter((item) => item.pack_id !== pin.pack_id), pin]
        .sort((a, b) => a.pack_id.localeCompare(b.pack_id));
    await writeFile(pinsPath, `${JSON.stringify({ pins }, null, 2)}\n`, "utf-8");
    return pin;
}
export async function pruneKnowledgeCache(options) {
    const keepVersions = options.keepVersions ?? 1;
    if (!Number.isInteger(keepVersions) || keepVersions < 1) {
        throw new Error("knowledge cache prune keepVersions must be a positive integer");
    }
    const packsDir = join(options.cacheDir, "packs");
    const pins = await readPins(join(options.cacheDir, "pins.json"));
    const cached = await collectCachedKnowledgePackVersions(packsDir);
    const byId = new Map();
    for (const pack of cached) {
        const group = byId.get(pack.manifest.id) ?? [];
        group.push(pack);
        byId.set(pack.manifest.id, group);
    }
    const kept = [];
    const removed = [];
    for (const group of byId.values()) {
        const sorted = group.sort((a, b) => b.manifest.version.localeCompare(a.manifest.version));
        const versionsToKeep = new Set(sorted.slice(0, keepVersions).map((pack) => pack.manifest.version));
        const pin = pins.find((item) => item.pack_id === sorted[0]?.manifest.id);
        if (pin !== undefined)
            versionsToKeep.add(pin.version);
        for (const pack of sorted) {
            const summary = packSummaryFromManifest(pack.manifest);
            if (versionsToKeep.has(pack.manifest.version)) {
                kept.push(summary);
                continue;
            }
            removed.push(summary);
            if (options.apply === true)
                await rm(pack.cache_path, { force: true });
        }
    }
    return {
        cache_dir: options.cacheDir,
        mode: options.apply === true ? "applied" : "dry-run",
        keep_versions: keepVersions,
        removed: removed.sort(comparePackSummaries),
        kept: kept.sort(comparePackSummaries),
    };
}
export async function cacheKnowledgeFeedback(options) {
    assertSafeOptionalTenantId(options.tenantId);
    await mkdir(options.cacheDir, { recursive: true });
    const baseEntry = {
        chunk_id: options.chunkId,
        rating: options.rating,
        created_at: options.createdAt ?? new Date().toISOString(),
        ...(options.tenantId === undefined ? {} : { tenant_id: options.tenantId }),
    };
    let entry = { ...baseEntry, status: "recorded" };
    if (options.cloudUrl !== undefined && options.cloudUrl.length > 0) {
        try {
            const response = await (options.fetchImpl ?? fetch)(new URL("/v1/feedback", withTrailingSlash(options.cloudUrl)), {
                method: "POST",
                headers: cloudHeaders(options.authToken),
                body: JSON.stringify(baseEntry),
            });
            if (!response.ok)
                throw new Error(`cloud feedback failed with HTTP ${response.status}`);
            entry = { ...baseEntry, status: "sent" };
        }
        catch (error) {
            entry = {
                ...baseEntry,
                status: "recorded",
                reason: error instanceof Error ? error.message : String(error),
            };
        }
    }
    const feedbackPath = join(options.cacheDir, "feedback.jsonl");
    const existing = await readTextIfExists(feedbackPath);
    await writeFile(feedbackPath, `${existing}${JSON.stringify(entry)}\n`, "utf-8");
    return entry;
}
async function writeCachedPack(cacheDir, pack) {
    const dir = join(cacheDir, "packs", safeCacheSegment(pack.id));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${safeCacheSegment(pack.version)}.json`), `${JSON.stringify(pack, null, 2)}\n`, "utf-8");
}
async function collectCachedKnowledgePackVersions(packsDir) {
    let packDirs;
    try {
        packDirs = await readdir(packsDir);
    }
    catch {
        return [];
    }
    const packs = [];
    for (const packDir of packDirs.sort((a, b) => a.localeCompare(b))) {
        const versionDir = join(packsDir, packDir);
        let versions;
        try {
            versions = await readdir(versionDir);
        }
        catch {
            continue;
        }
        for (const versionFile of versions.filter((name) => name.endsWith(".json")).sort((a, b) => a.localeCompare(b))) {
            const cachePath = join(versionDir, versionFile);
            const pack = await loadKnowledgePack(cachePath);
            packs.push({ ...pack, cache_path: cachePath });
        }
    }
    return packs;
}
function comparePackSummaries(a, b) {
    return a.id.localeCompare(b.id) || a.version.localeCompare(b.version);
}
function isBlockedByPin(pack, pins) {
    const pin = pins.find((item) => item.pack_id === pack.id);
    return pin !== undefined && pin.version !== pack.version;
}
async function readPins(path) {
    try {
        const parsed = JSON.parse(await readFile(path, "utf-8"));
        if (!isRecord(parsed) || !Array.isArray(parsed["pins"]))
            return [];
        return parsed["pins"].filter((item) => isRecord(item) && typeof item["pack_id"] === "string" && typeof item["version"] === "string");
    }
    catch {
        return [];
    }
}
async function readTextIfExists(path) {
    try {
        return await readFile(path, "utf-8");
    }
    catch {
        return "";
    }
}
function packSummaryFromManifest(manifest) {
    return {
        id: manifest.id,
        version: manifest.version,
        license: manifest.license,
        source_kind: manifest.source_kind,
        quality_score: manifest.quality_score,
    };
}
function safeCacheSegment(value) {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "__");
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
function osstackTitleFromBody(body, path) {
    const title = titleFromBody(body, path);
    return title.toLowerCase().startsWith("osstack ") ? title : `Osstack ${title}`;
}
function renderOsstackNativeGuidance(body, taxonomy) {
    const normalized = body
        .replace(/^# .+$/m, "")
        .replace(/\s+/g, " ")
        .trim();
    const excerpt = normalized.length > 520 ? `${normalized.slice(0, 520).trimEnd()}...` : normalized;
    const taxonomyText = taxonomy.length === 0 ? "general" : taxonomy.join(", ");
    return [
        `Osstack taxonomy: ${taxonomyText}.`,
        "Use this source as processed guidance for osstack runs, loops, agents, verifiers, proof packs, and Knowledge Cloud retrieval.",
        `Operational guidance: ${excerpt}`,
        "When this chunk is injected into a run, cite the pack id and chunk id in report/proof evidence and keep cloud failures fail-open.",
    ].join("\n\n");
}
export function searchKnowledgePacks(packs, query, options = {}) {
    const terms = tokenize(query);
    if (terms.length === 0)
        return [];
    const documents = packs.flatMap((pack) => pack.manifest.chunks.map((chunk) => {
        const haystack = `${chunk.title} ${chunk.body} ${(chunk.tags ?? []).join(" ")}`.toLowerCase();
        return {
            pack,
            chunk,
            haystack,
            length: Math.max(1, tokenize(haystack).length),
        };
    }));
    const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / Math.max(1, documents.length);
    const documentFrequencies = new Map(terms.map((term) => [
        term,
        documents.filter((document) => countOccurrences(document.haystack, term) > 0).length,
    ]));
    const results = [];
    for (const document of documents) {
        const termCounts = terms.map((term) => ({ term, count: countOccurrences(document.haystack, term) }));
        const rawScore = termCounts.reduce((sum, termCount) => sum + bm25TermScore({
            frequency: termCount.count,
            documentFrequency: documentFrequencies.get(termCount.term) ?? 0,
            documentCount: documents.length,
            documentLength: document.length,
            averageDocumentLength: averageLength,
        }), 0);
        if (rawScore === 0)
            continue;
        const qualityMultiplier = 0.9 + (document.pack.manifest.quality_score / 500);
        const score = Number((rawScore * qualityMultiplier).toFixed(4));
        results.push({
            pack_id: document.pack.manifest.id,
            pack_version: document.pack.manifest.version,
            chunk_id: document.chunk.chunk_id,
            title: document.chunk.title,
            score,
            snippet: snippetFor(document.chunk.body, terms),
            matched_terms: termCounts.filter((termCount) => termCount.count > 0).map((termCount) => termCount.term),
            tags: document.chunk.tags ?? [],
            source_refs: document.chunk.source_refs ?? [],
        });
    }
    return results
        .sort((a, b) => b.score - a.score || a.pack_id.localeCompare(b.pack_id) || a.chunk_id.localeCompare(b.chunk_id))
        .slice(0, options.limit ?? 5);
}
export function evaluateKnowledgeRetrieval(packs, cases, options = {}) {
    const topK = options.topK ?? 3;
    const results = cases.map((testCase) => {
        const top = searchKnowledgePacks(packs, testCase.query, { limit: topK });
        const rankIndex = top.findIndex((result) => result.chunk_id === testCase.expected_chunk_id);
        return {
            id: testCase.id,
            query: testCase.query,
            expected_chunk_id: testCase.expected_chunk_id,
            matched: rankIndex >= 0,
            rank: rankIndex >= 0 ? rankIndex + 1 : null,
            top_chunk_ids: top.map((result) => result.chunk_id),
        };
    });
    return {
        total: results.length,
        passed: results.filter((result) => result.matched).length,
        failed: results.filter((result) => !result.matched).length,
        top_k: topK,
        results,
    };
}
export function assembleKnowledgeSnippet(results) {
    return results.map((result) => [
        `# ${result.title}`,
        [
            `pack=${result.pack_id}@${result.pack_version}`,
            `chunk=${result.chunk_id}`,
            `score=${result.score}`,
            result.matched_terms.length === 0 ? undefined : `matched_terms=${result.matched_terms.join(",")}`,
        ].filter(Boolean).join(" "),
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
        ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
        ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
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
        assertSafeOptionalTenantId(options.tenantId);
        const response = await (options.fetchImpl ?? fetch)(new URL("/v1/search", withTrailingSlash(options.cloudUrl)), {
            method: "POST",
            headers: cloudHeaders(options.authToken),
            body: JSON.stringify({
                query: options.query,
                limit: options.limit ?? 5,
                ...(options.tenantId === undefined ? {} : { tenant_id: options.tenantId }),
            }),
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
function cloudHeaders(authToken) {
    return {
        "content-type": "application/json",
        ...(authToken === undefined || authToken.trim().length === 0 ? {} : { authorization: `Bearer ${authToken.trim()}` }),
    };
}
function assertSafeOptionalTenantId(tenantId) {
    if (tenantId === undefined)
        return;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tenantId))
        throw new Error("tenant_id is invalid");
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
        matched_terms: optionalStringArray(value, "matched_terms") ?? [],
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
        const path = requiredString(item, "path");
        if (isUnsafeKnowledgeSourcePath(path)) {
            throw new Error("knowledge pack source_provenance path is unsafe");
        }
        return {
            source_id: requiredString(item, "source_id"),
            path,
            sha256: requiredString(item, "sha256"),
            license: requiredString(item, "license"),
            scope: scope,
            imported_at: requiredString(item, "imported_at"),
        };
    });
}
function validateKnowledgeReview(value) {
    if (!isRecord(value))
        throw new Error("knowledge pack review must be an object");
    const status = requiredString(value, "status");
    if (status !== "approved" && status !== "changes_requested") {
        throw new Error("knowledge pack review.status is invalid");
    }
    return {
        status,
        reviewer_id: requiredString(value, "reviewer_id"),
        reviewed_at: requiredString(value, "reviewed_at"),
        summary: requiredString(value, "summary"),
    };
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
function bm25TermScore(options) {
    if (options.frequency <= 0 || options.documentFrequency <= 0)
        return 0;
    const k1 = 1.2;
    const b = 0.75;
    const idf = Math.log(1 + (options.documentCount - options.documentFrequency + 0.5) / (options.documentFrequency + 0.5));
    const lengthRatio = options.documentLength / Math.max(1, options.averageDocumentLength);
    const denominator = options.frequency + k1 * (1 - b + b * lengthRatio);
    return idf * ((options.frequency * (k1 + 1)) / denominator);
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